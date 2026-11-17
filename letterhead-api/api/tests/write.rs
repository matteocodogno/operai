//! Integration tests of the person routes that write (task T15; AC-4.1, AC-4.2, AC-4.3, AC-4.6, AC-4.7, AC-4.8,
//! AC-5.2, AC-7.1 to AC-7.4, AC-8.2, AC-3.6).
//!
//! Black-box tests of the real binary (`CARGO_BIN_EXE_letterhead-api`), as `read.rs` is: each test starts its own
//! supervisor on a free port against a schema of its own in `LETTERHEAD_TEST_DATABASE_URL` and the MinIO bucket of
//! `LETTERHEAD_TEST_S3_*` (see `render.rs` for the names and the defaults), with a fake `auth` in this process:
//! a JWKS, and `GET /authz/resolve` from a table of people (a holder of access only, a manager of one entity, an
//! administrator, ...). Multipart bodies are built here by hand, so that the hostile ones can be too.
//!
//! Without the database variable the tests are skipped with a notice; `LETTERHEAD_REQUIRE_DB_TESTS=1` (set in CI)
//! turns anything missing, the database or the bucket, into a failure. Every test name starts with `write_`.

#[path = "render_db.rs"]
mod db;

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::rsa::{KeyPair, KeySize, PublicKeyComponents};
use aws_lc_rs::signature::{KeyPair as _, RSA_PKCS1_SHA256};
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Executor;
use uuid::Uuid;

use db::repo::Repo;
use db::types::{AssetKind, NewAsset, NewVersion};
use letterhead_engine::assets::Format;
use letterhead_engine::config::default_config;
use letterhead_engine::content::Entity;

const URL_VAR: &str = "LETTERHEAD_TEST_DATABASE_URL";
const REQUIRE_VAR: &str = "LETTERHEAD_REQUIRE_DB_TESTS";

const ISSUER: &str = "http://auth.test";
const PERSON_AUDIENCE: &str = "operai-suite";
const SERVICE_AUDIENCE: &str = "operai-service";
const KID: &str = "test-key-1";
const ORIGIN: &str = "http://localhost:5173";

/// A string that must never reach a log: it is the display name of the person who saves.
const NAME_MARKER: &str = "ZQX-name-4711";

/// The 2 x 1 RGB PNG of the asset tests: a real file, not only a sound container.
const PNG: [u8; 70] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x7b, 0x40, 0xe8,
    0xdd, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0x00, 0x04,
    0xff, 0x01, 0x07, 0x00, 0x01, 0xff, 0xe2, 0x23, 0x9e, 0x59, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];
const SVG: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#e50339"/></svg>"##;

// ---------------------------------------------------------------------------------------------------------------
// The environment: a database, a bucket

struct TestEnv {
    database_url: String,
    s3_endpoint: String,
    s3_access_key_id: String,
    s3_secret_access_key: String,
    bucket: String,
}

fn required() -> bool {
    std::env::var(REQUIRE_VAR).as_deref() == Ok("1")
}

/// What the tests run against; `None` (skip) when there is no test database.
fn test_env() -> Option<TestEnv> {
    let Ok(database_url) = std::env::var(URL_VAR) else {
        assert!(
            !required(),
            "{URL_VAR} is not set and {REQUIRE_VAR}=1: the write tests may not be skipped"
        );
        eprintln!("SKIPPED: set {URL_VAR} to run the write tests");
        return None;
    };
    let var =
        |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_owned());
    let database = database_url
        .split('?')
        .next()
        .and_then(|url| url.rsplit('/').next())
        .unwrap_or("letterhead-test")
        .to_ascii_lowercase()
        .replace('_', "-");
    Some(TestEnv {
        database_url,
        s3_endpoint: var("LETTERHEAD_TEST_S3_ENDPOINT", "http://localhost:9000"),
        s3_access_key_id: var("LETTERHEAD_TEST_S3_ACCESS_KEY_ID", "minioadmin"),
        s3_secret_access_key: var("LETTERHEAD_TEST_S3_SECRET_ACCESS_KEY", "minioadmin"),
        bucket: var("LETTERHEAD_TEST_S3_BUCKET", &database),
    })
}

struct Bucket {
    client: aws_sdk_s3::Client,
    name: String,
}

impl Bucket {
    /// The bucket, created if it is not there; `None` (skip) when there is no object store to ask.
    async fn open(env: &TestEnv) -> Option<Bucket> {
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .endpoint_url(env.s3_endpoint.clone())
            .credentials_provider(Credentials::new(
                env.s3_access_key_id.clone(),
                env.s3_secret_access_key.clone(),
                None,
                None,
                "test",
            ))
            .force_path_style(true)
            .build();
        let client = aws_sdk_s3::Client::from_conf(config);
        let _ = client.create_bucket().bucket(&env.bucket).send().await;
        match client.head_bucket().bucket(&env.bucket).send().await {
            Ok(_) => Some(Bucket {
                client,
                name: env.bucket.clone(),
            }),
            Err(_) => {
                assert!(
                    !required(),
                    "the bucket {} is not reachable at {} and {REQUIRE_VAR}=1: the write tests may not be skipped",
                    env.bucket,
                    env.s3_endpoint
                );
                eprintln!("SKIPPED: no object store at {}", env.s3_endpoint);
                None
            }
        }
    }

    async fn put(&self, id: Uuid, bytes: &[u8]) {
        self.client
            .put_object()
            .bucket(&self.name)
            .set_key(Some(format!("assets/{id}")))
            .body(ByteStream::from(bytes.to_vec()))
            .send()
            .await
            .expect("put an object");
    }

    async fn delete(&self, id: Uuid) {
        self.client
            .delete_object()
            .bucket(&self.name)
            .set_key(Some(format!("assets/{id}")))
            .send()
            .await
            .expect("delete an object");
    }
}

/// A schema of its own, migrated, and the repository on it.
struct Fixture {
    repo: Repo,
    /// The `DATABASE_URL` of a supervisor that is to see this schema.
    schema_url: String,
    bucket: Bucket,
    env: TestEnv,
}

fn schema_url(base: &str, schema: &str) -> String {
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}options=-c%20search_path%3D{schema}")
}

async fn create_schema(database_url: &str) -> String {
    let schema = format!("lh_p_{}", Uuid::new_v4().simple());
    let admin = sqlx::PgPool::connect(database_url)
        .await
        .expect("connect to the test database");
    // `lh_p_` and 32 hex digits, made here: nothing a person typed reaches the statement.
    admin
        .execute(sqlx::AssertSqlSafe(format!("create schema {schema}")))
        .await
        .expect("create the test schema");
    admin.close().await;
    schema_url(database_url, &schema)
}

impl Fixture {
    async fn new() -> Option<Fixture> {
        let env = test_env()?;
        let bucket = Bucket::open(&env).await?;
        let schema_url = create_schema(&env.database_url).await;
        let repo = Repo::connect(&schema_url, 4).await.expect("connect");
        repo.migrate().await.expect("migrate");
        Some(Fixture {
            repo,
            schema_url,
            bucket,
            env,
        })
    }

    /// An asset: its bytes in the bucket, its row in the database.
    async fn asset(&self, entity: Entity, kind: AssetKind, format: Format, bytes: &[u8]) -> Uuid {
        let id = Uuid::new_v4();
        self.bucket.put(id, bytes).await;
        self.repo
            .insert_asset(NewAsset {
                id,
                entity,
                kind,
                format,
                sha256: Sha256::digest(bytes).into(),
                bytes: i32::try_from(bytes.len()).expect("small"),
                size_px: (format != Format::Svg).then_some((2, 1)),
                created_by: "test".into(),
            })
            .await
            .expect("insert an asset");
        id
    }
}

/// The starting configuration, with a footer text of its own and a logo if given.
fn config(footer: &str, logo: Option<Uuid>) -> Value {
    let mut config = serde_json::to_value(default_config()).expect("json");
    config["variants"]["default"]["footer"]["left"][0]["text"] =
        json!({ "it": footer, "en": footer });
    if let Some(asset) = logo {
        config["variants"]["default"]["logo"] =
            json!({ "asset": asset.to_string(), "position": "left", "heightMm": 10 });
    }
    config
}

// ---------------------------------------------------------------------------------------------------------------
// The fake `auth`

struct TestKey {
    pair: KeyPair,
}

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}

impl TestKey {
    fn generate() -> TestKey {
        TestKey {
            pair: KeyPair::generate(KeySize::Rsa2048).expect("a test RSA pair"),
        }
    }

    fn jwk(&self) -> Value {
        let parts = PublicKeyComponents::<Vec<u8>>::from(self.pair.public_key());
        json!({ "kty": "RSA", "alg": "RS256", "use": "sig", "kid": KID,
                "n": b64url(&parts.n), "e": b64url(&parts.e) })
    }

    fn sign(&self, header: &Value, claims: &Value) -> String {
        let input = format!(
            "{}.{}",
            b64url(header.to_string().as_bytes()),
            b64url(claims.to_string().as_bytes())
        );
        let mut signature = vec![0; self.pair.public_modulus_len()];
        self.pair
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                input.as_bytes(),
                &mut signature,
            )
            .expect("sign");
        format!("{input}.{}", b64url(&signature))
    }

    fn token(&self, claims: &Value) -> String {
        self.sign(&json!({ "alg": "RS256", "typ": "JWT", "kid": KID }), claims)
    }
}

/// What a person holds.
#[derive(Clone, Copy, PartialEq)]
enum Manage {
    No,
    /// Unconditioned: both entities (an administrator).
    Both,
    /// Conditioned on the caller's entity.
    OwnEntity,
}

/// One person of the fake `auth`'s table.
#[derive(Clone)]
struct Persona {
    sub: &'static str,
    name: &'static str,
    entity: Option<&'static str>,
    access: bool,
    manage: Manage,
}

impl Persona {
    fn resolve_answer(&self, epoch: i64) -> Value {
        let mut permissions =
            vec![json!({ "resource": "projects", "action": "access", "conditions": null })];
        if self.access {
            permissions
                .push(json!({ "resource": "letterheads", "action": "access", "conditions": null }));
        }
        match self.manage {
            Manage::No => {}
            Manage::Both => permissions
                .push(json!({ "resource": "letterhead", "action": "manage", "conditions": null })),
            Manage::OwnEntity => permissions.push(json!({
                "resource": "letterhead", "action": "manage",
                "conditions": { "attributes": [{ "key": "entity", "match": "user" }] }
            })),
        }
        json!({ "sub": self.sub, "epoch": epoch, "permissions": permissions,
                "entity": self.entity, "jobTitle": null })
    }
}

/// The people of the tests.
fn people() -> Vec<Persona> {
    let person = |sub, entity, access, manage| Persona {
        sub,
        name: NAME_MARKER,
        entity,
        access,
        manage,
    };
    vec![
        person("u-access", Some("welld_it"), true, Manage::No),
        person("u-it", Some("welld_it"), true, Manage::OwnEntity),
        person("u-ch", Some("welld_ch"), true, Manage::OwnEntity),
        person("u-admin", Some("welld_it"), true, Manage::Both),
        // Holds the scoped permission but has no entity: fails closed, manages nothing.
        person("u-noentity", None, true, Manage::OwnEntity),
        // Another tool's permissions only.
        person("u-none", Some("welld_it"), false, Manage::No),
        // Manage without access: the tool is not theirs.
        person("u-manage-only", Some("welld_it"), false, Manage::Both),
    ]
}

/// How the fake `auth` answers `GET /authz/resolve` at the moment.
#[derive(Clone, Copy, PartialEq)]
enum Resolve {
    Normal,
    /// This status, and no body.
    Status(u16),
    /// 200 with a body that is not a permission set.
    Garbage,
}

struct AuthState {
    people: Vec<Persona>,
    mode: Mutex<Resolve>,
    /// The `Authorization` header of every resolve call, in order.
    asked: Mutex<Vec<String>>,
}

struct FakeAuth {
    jwks_url: String,
    base: String,
    key: Arc<TestKey>,
    state: Arc<AuthState>,
}

/// The `sub` of a token, read without checking it: the fake `auth` trusts what it is sent.
fn sub_of(bearer: &str) -> Option<String> {
    let token = bearer.strip_prefix("Bearer ")?;
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    claims["sub"].as_str().map(str::to_owned)
}

fn epoch_of(bearer: &str) -> i64 {
    bearer
        .strip_prefix("Bearer ")
        .and_then(|token| token.split('.').nth(1))
        .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|claims| claims["perm_epoch"].as_i64())
        .unwrap_or(0)
}

impl FakeAuth {
    /// `GET /auth/jwks` and `GET /authz/resolve`, on a free port.
    async fn start() -> FakeAuth {
        use axum::{
            Router, http::HeaderMap, http::StatusCode, response::IntoResponse, routing::get,
        };
        let key = Arc::new(TestKey::generate());
        let state = Arc::new(AuthState {
            people: people(),
            mode: Mutex::new(Resolve::Normal),
            asked: Mutex::new(Vec::new()),
        });
        let for_jwks = Arc::clone(&key);
        let for_resolve = Arc::clone(&state);
        let app = Router::new()
            .route(
                "/auth/jwks",
                get(move || {
                    let key = Arc::clone(&for_jwks);
                    async move { axum::Json(json!({ "keys": [key.jwk()] })) }
                }),
            )
            .route(
                "/authz/resolve",
                get(move |headers: HeaderMap| {
                    let state = Arc::clone(&for_resolve);
                    async move {
                        let bearer = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        state.asked.lock().expect("lock").push(bearer.clone());
                        let mode = *state.mode.lock().expect("lock");
                        match mode {
                            Resolve::Status(code) => {
                                StatusCode::from_u16(code).expect("status").into_response()
                            }
                            Resolve::Garbage => {
                                (StatusCode::OK, "<html>maintenance</html>").into_response()
                            }
                            Resolve::Normal => {
                                let person = sub_of(&bearer)
                                    .and_then(|sub| state.people.iter().find(|p| p.sub == sub));
                                match person {
                                    Some(person) => {
                                        axum::Json(person.resolve_answer(epoch_of(&bearer)))
                                            .into_response()
                                    }
                                    None => StatusCode::UNAUTHORIZED.into_response(),
                                }
                            }
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move { axum::serve(listener, app).await });
        FakeAuth {
            jwks_url: format!("http://127.0.0.1:{port}/auth/jwks"),
            base: format!("http://127.0.0.1:{port}"),
            key,
            state,
        }
    }

    fn claims(&self, sub: &str, epoch: i64) -> Value {
        let name = self
            .state
            .people
            .iter()
            .find(|p| p.sub == sub)
            .map_or("Someone", |p| p.name);
        json!({ "iss": ISSUER, "sub": sub, "aud": PERSON_AUDIENCE, "email": format!("{sub}@welld.example"),
                "name": name, "perm_epoch": epoch, "iat": now(), "exp": now() + 300 })
    }

    /// A person's token, as `auth` mints it.
    fn token(&self, sub: &str) -> String {
        self.token_at(sub, 1)
    }

    fn token_at(&self, sub: &str, epoch: i64) -> String {
        self.key.token(&self.claims(sub, epoch))
    }

    fn token_with(&self, sub: &str, change: impl FnOnce(&mut Value)) -> String {
        let mut claims = self.claims(sub, 1);
        change(&mut claims);
        self.key.token(&claims)
    }

    /// A service token as `auth` mints it (`serviceToken.routes.ts`).
    fn service_token(&self) -> String {
        self.key.token(&json!({
            "iss": ISSUER, "sub": "system:letterhead-test-caller", "aud": SERVICE_AUDIENCE,
            "scope": "letterhead:render", "iat": now(), "exp": now() + 300,
            "jti": Uuid::new_v4().to_string() }))
    }

    fn resolve(&self, mode: Resolve) {
        *self.state.mode.lock().expect("lock") = mode;
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .expect("client")
}

// ---------------------------------------------------------------------------------------------------------------
// The supervisor

struct Server {
    child: Child,
    port: u16,
    out: Arc<Mutex<Vec<String>>>,
    err: Arc<Mutex<Vec<String>>>,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port()
}

fn pump(reader: impl Read + Send + 'static, into: Arc<Mutex<Vec<String>>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            into.lock().expect("lock").push(line);
        }
    });
}

/// Everything the supervisor needs to start, as environment variables, and nothing else.
fn server_env(fixture: &Fixture, auth: &FakeAuth, port: u16) -> Vec<(&'static str, String)> {
    let host = url::Url::parse(&fixture.env.s3_endpoint)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    vec![
        ("PORT", port.to_string()),
        ("DATABASE_URL", fixture.schema_url.clone()),
        ("AUTH_ISSUER", ISSUER.to_owned()),
        // The fake `auth` answers `/authz/resolve` here; `iss` stays the name `auth` signs with.
        ("AUTH_BASE_URL", auth.base.clone()),
        ("AUTH_JWKS_URL", auth.jwks_url.clone()),
        ("AUTH_AUDIENCE", PERSON_AUDIENCE.to_owned()),
        ("SERVICE_AUDIENCE", SERVICE_AUDIENCE.to_owned()),
        ("SERVICE_CLIENT_ID", "letterhead-api".to_owned()),
        (
            "SERVICE_CLIENT_SECRET",
            "test-client-secret-0123456789abcdefgh".to_owned(),
        ),
        ("ALLOWED_ORIGINS", ORIGIN.to_owned()),
        ("LETTERHEAD_S3_ENDPOINT", fixture.env.s3_endpoint.clone()),
        ("LETTERHEAD_S3_REGION", "us-east-1".to_owned()),
        ("LETTERHEAD_S3_BUCKET", fixture.env.bucket.clone()),
        (
            "LETTERHEAD_S3_ACCESS_KEY_ID",
            fixture.env.s3_access_key_id.clone(),
        ),
        (
            "LETTERHEAD_S3_SECRET_ACCESS_KEY",
            fixture.env.s3_secret_access_key.clone(),
        ),
        ("LETTERHEAD_S3_EU_ENDPOINT_HOSTS", host),
        ("LH_WORKERS", "1".to_owned()),
        // A save's fit check is a pool job (T48): the test of three saves at once needs places for them to wait.
        ("LH_QUEUE", "4".to_owned()),
    ]
}

impl Server {
    /// Starts the binary and waits until it answers `/health`.
    async fn start(fixture: &Fixture, auth: &FakeAuth) -> Server {
        let port = free_port();
        let mut command = Command::new(env!("CARGO_BIN_EXE_letterhead-api"));
        command
            .env_clear()
            .envs(server_env(fixture, auth, port))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect("start letterhead-api");
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        pump(child.stdout.take().expect("stdout"), Arc::clone(&out));
        pump(child.stderr.take().expect("stderr"), Arc::clone(&err));
        let mut server = Server {
            child,
            port,
            out,
            err,
        };
        let client = http();
        let started = Instant::now();
        loop {
            if let Ok(Some(status)) = server.child.try_wait() {
                panic!(
                    "letterhead-api exited at start ({status}): {:?}",
                    server.err.lock().expect("lock")
                );
            }
            let answered = client
                .get(format!("{}/health", server.base()))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success());
            if answered {
                return server;
            }
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "letterhead-api did not answer /health"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base())
    }

    /// Stops the supervisor and returns everything it wrote, stdout then stderr.
    fn stop(mut self) -> (Vec<String>, Vec<String>) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // The readers end when the pipes close; give them a moment to hand over the last lines.
        std::thread::sleep(Duration::from_millis(150));
        let out = self.out.lock().expect("lock").clone();
        let err = self.err.lock().expect("lock").clone();
        (out, err)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A supervisor, a fake `auth`, a schema and a bucket; `None` when there is nothing to test on.
struct World {
    fixture: Fixture,
    auth: FakeAuth,
    server: Server,
}

impl World {
    async fn start() -> Option<World> {
        let fixture = Fixture::new().await?;
        let auth = FakeAuth::start().await;
        let server = Server::start(&fixture, &auth).await;
        Some(World {
            fixture,
            auth,
            server,
        })
    }

    async fn get(&self, path: &str, sub: &str) -> Reply {
        get_with(&self.server, path, Some(&self.auth.token(sub))).await
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Requests and answers

struct Reply {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .map(|v| v.to_str().expect("ascii").to_owned())
    }

    fn code(&self) -> String {
        self.json()["code"].as_str().unwrap_or_default().to_owned()
    }
}

async fn send(request: reqwest::RequestBuilder) -> Reply {
    let reply = request.send().await.expect("the supervisor answers");
    Reply {
        status: reply.status().as_u16(),
        headers: reply.headers().clone(),
        body: reply.bytes().await.expect("body").to_vec(),
    }
}

async fn get_with(server: &Server, path: &str, token: Option<&str>) -> Reply {
    let mut request = http().get(server.url(path));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    send(request).await
}

/// Every answer of the person routes, whatever it says, carries `Cache-Control: no-store`.
fn assert_no_store(reply: &Reply) {
    assert_eq!(reply.header("cache-control").as_deref(), Some("no-store"));
}

fn assert_problem(reply: &Reply, status: u16, code: &str) {
    assert_eq!(reply.status, status, "{}", reply.text());
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("application/problem+json")
    );
    assert_eq!(reply.code(), code, "{}", reply.text());
    assert_no_store(reply);
}

// ---------------------------------------------------------------------------------------------------------------
// Requests

async fn post_raw(
    world: &World,
    path: &str,
    token: Option<&str>,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> Reply {
    let mut request = http().post(world.server.url(path)).body(body);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(content_type) = content_type {
        request = request.header("content-type", content_type);
    }
    send(request).await
}

async fn post_json(world: &World, path: &str, sub: &str, body: &Value) -> Reply {
    post_raw(
        world,
        path,
        Some(&world.auth.token(sub)),
        Some("application/json"),
        body.to_string().into_bytes(),
    )
    .await
}

const BOUNDARY: &str = "----lh-test-boundary-7d3";

/// A multipart body: `(field name, file name, bytes)` for each part, in order.
fn multipart(parts: &[(&str, Option<&str>, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, file_name, data) in parts {
        out.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        match file_name {
            Some(file_name) => out.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                )
                .as_bytes(),
            ),
            None => out.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
            ),
        }
        out.extend_from_slice(data);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    out
}

fn form_type() -> String {
    format!("multipart/form-data; boundary={BOUNDARY}")
}

async fn upload_as(
    world: &World,
    entity: &str,
    sub: &str,
    kind: &str,
    file: &[u8],
    file_name: &str,
) -> Reply {
    post_raw(
        world,
        &format!("/v1/letterheads/{entity}/assets"),
        Some(&world.auth.token(sub)),
        Some(&form_type()),
        multipart(&[
            ("kind", None, kind.as_bytes()),
            ("file", Some(file_name), file),
        ]),
    )
    .await
}

async fn save_as(world: &World, entity: &str, sub: &str, base: i64, config: &Value) -> Reply {
    post_json(
        world,
        &format!("/v1/letterheads/{entity}/versions"),
        sub,
        &json!({ "baseVersion": base, "config": config }),
    )
    .await
}

async fn restore_as(world: &World, entity: &str, sub: &str, n: &str, base: i64) -> Reply {
    post_json(
        world,
        &format!("/v1/letterheads/{entity}/versions/{n}/restore"),
        sub,
        &json!({ "baseVersion": base }),
    )
    .await
}

/// The rows of the four tables, to show that a refusal changed nothing.
#[derive(Debug, PartialEq, Eq)]
struct Rows {
    versions: i64,
    links: i64,
    changes: i64,
    assets: i64,
}

async fn rows(world: &World) -> Rows {
    let pool = sqlx::PgPool::connect(&world.fixture.schema_url)
        .await
        .expect("connect");
    let count = |table: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "select count(*) from {table}"
            )))
            .fetch_one(&pool)
            .await
            .expect("count")
        }
    };
    let out = Rows {
        versions: count("letterhead_version").await,
        links: count("letterhead_version_asset").await,
        changes: count("letterhead_change").await,
        assets: count("letterhead_asset").await,
    };
    pool.close().await;
    out
}

async fn history(world: &World, entity: &str) -> Vec<Value> {
    let reply = world
        .get(&format!("/v1/letterheads/{entity}/versions"), "u-access")
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    reply.json().as_array().expect("a list").clone()
}

fn names(entry: &Value) -> Vec<String> {
    entry["changedSettings"]
        .as_array()
        .expect("a list")
        .iter()
        .map(|v| v.as_str().expect("text").to_owned())
        .collect()
}

fn problems(reply: &Reply) -> Vec<(String, String)> {
    reply.json()["problems"]
        .as_array()
        .expect("problems")
        .iter()
        .map(|p| {
            (
                p["path"].as_str().expect("path").to_owned(),
                p["reason"].as_str().expect("reason").to_owned(),
            )
        })
        .collect()
}

async fn world() -> Option<World> {
    World::start().await
}

// ---------------------------------------------------------------------------------------------------------------
// Save

#[tokio::test]
async fn write_the_first_save_takes_base_version_0_and_makes_version_1_active() {
    let Some(world) = world().await else { return };
    let start = serde_json::to_value(default_config()).expect("json");
    let reply = save_as(&world, "welld_it", "u-admin", 0, &start).await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    assert_eq!(reply.json(), json!({ "version": 1 }));
    assert_no_store(&reply);
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("application/json")
    );

    // AC-4.1: active at once, with the layout of today and the configuration as it was sent.
    let active = world
        .fixture
        .repo
        .active_version(Entity::WelldIt)
        .await
        .expect("read")
        .expect("a version");
    assert_eq!(active.version, 1);
    assert_eq!(active.layout_version, 1);
    assert_eq!(active.created_by, "u-admin", "the account, never a name");
    assert_eq!(active.restored_from, None);
    assert_eq!(active.config, start);
    let read = world
        .get("/v1/letterheads/welld_it/versions/1", "u-access")
        .await;
    assert_eq!(read.json()["config"], start);
    assert_eq!(read.json()["layoutVersion"], 1);
    let list = world.get("/v1/letterheads", "u-access").await.json();
    assert_eq!(list["welld_it"]["activeVersion"], 1);
    assert_eq!(list["welld_ch"]["activeVersion"], Value::Null);

    // AC-4.7: who, when, what. The first save sets everything: the ten settings of the starting
    // configuration, and no variant that is not there.
    let record = history(&world, "welld_it").await;
    assert_eq!(record.len(), 1);
    assert_eq!(record[0]["version"], 1);
    assert_eq!(
        record[0]["createdBy"],
        json!({ "sub": "u-admin", "name": NAME_MARKER })
    );
    assert_eq!(record[0]["restoredFrom"], Value::Null);
    assert!(
        record[0]["createdAt"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z'))
    );
    assert_eq!(
        names(&record[0]),
        [
            "margins",
            "fonts",
            "look.headings",
            "look.body",
            "look.table",
            "look.bulletMarker",
            "variants.default.header",
            "variants.default.footer",
            "variants.default.logo",
            "variants.default.background",
        ]
    );
    // The versions of an entity are numbered apart.
    let other = save_as(&world, "welld_ch", "u-admin", 0, &start).await;
    assert_eq!(other.json(), json!({ "version": 1 }));
}

#[tokio::test]
async fn write_a_second_save_is_n_plus_1_names_what_changed_and_leaves_the_first_alone() {
    let Some(world) = world().await else { return };
    let first = config("Footer one", None);
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &first).await.status,
        201
    );

    // The colour is sent in capitals and kept in lower case (the canonical form the validator builds).
    let mut second = config("Footer two", None);
    second["margins"]["left"] = json!(30);
    second["look"]["table"]["headerFill"] = json!("ABCDEF");
    let reply = save_as(&world, "welld_it", "u-it", 1, &second).await;
    assert_eq!(reply.json(), json!({ "version": 2 }), "{}", reply.text());

    let record = history(&world, "welld_it").await;
    assert_eq!(
        record
            .iter()
            .map(|e| e["version"].clone())
            .collect::<Vec<_>>(),
        [json!(2), json!(1)]
    );
    assert_eq!(
        names(&record[0]),
        ["margins", "look.table", "variants.default.footer"]
    );
    // AC-4.3: the first is what it was.
    let one = world
        .get("/v1/letterheads/welld_it/versions/1", "u-access")
        .await
        .json();
    assert_eq!(one["config"], first);
    let two = world
        .get("/v1/letterheads/welld_it/versions/2", "u-access")
        .await
        .json();
    assert_eq!(two["config"]["look"]["table"]["headerFill"], "abcdef");
    assert_eq!(two["config"]["margins"]["left"], 30.0);

    // The same configuration again is a version too, and says that it changed nothing.
    let same = save_as(&world, "welld_it", "u-it", 2, &two["config"]).await;
    assert_eq!(same.json(), json!({ "version": 3 }));
    assert_eq!(
        names(&history(&world, "welld_it").await[0]),
        Vec::<String>::new()
    );
}

#[tokio::test]
async fn write_a_stale_base_version_is_409_and_what_the_other_person_saved_is_kept() {
    let Some(world) = world().await else { return };
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &config("A", None))
            .await
            .status,
        201
    );
    assert_eq!(
        save_as(&world, "welld_it", "u-admin", 1, &config("B", None))
            .await
            .status,
        201
    );
    let before = rows(&world).await;

    // The first person was still looking at version 1.
    for base in [1, 0, 5] {
        let late = save_as(&world, "welld_it", "u-it", base, &config("C", None)).await;
        assert_problem(&late, 409, "version_conflict");
        assert_eq!(late.json()["currentVersion"], 2, "base {base}");
        assert!(
            !late.text().contains("\"C\""),
            "nothing of the request is repeated"
        );
    }
    assert_eq!(rows(&world).await, before, "nothing was written");
    let kept = world
        .get("/v1/letterheads/welld_it/versions/2", "u-access")
        .await
        .json();
    assert_eq!(
        kept["config"]["variants"]["default"]["footer"]["left"][0]["text"]["it"],
        "B"
    );
}

/// T48 (security review F2): the fit check of a save is a job of the worker pool, so a save that finds the pool
/// full is turned away at once with 429 `busy` and `Retry-After`, as a preview is: it does not wait on a thread
/// of the supervisor. One worker, four places, two per person. A fit check is quick, so whether any of the sixteen
/// finds the pool full depends on the timing and is not asserted (the pool's own tests, `tests/pool.rs`, fill it on
/// purpose); what is asserted is that every answer is one of the three and that a 429 is the pool's.
#[tokio::test]
async fn write_a_save_takes_a_place_in_the_worker_pool_and_a_full_pool_is_429_busy() {
    let Some(world) = world().await else { return };
    let bodies: Vec<(&str, Value)> = (0..16)
        .map(|round| {
            let sub = if round % 2 == 0 { "u-it" } else { "u-admin" };
            (
                sub,
                json!({ "baseVersion": 0, "config": config(&format!("Save {round}"), None) }),
            )
        })
        .collect();
    let calls: Vec<_> = bodies
        .iter()
        .map(|(sub, body)| post_json(&world, "/v1/letterheads/welld_it/versions", sub, body))
        .collect();
    let replies = futures_join_all(calls).await;
    let mut saved = 0;
    for reply in &replies {
        match reply.status {
            201 => saved += 1,
            409 => {} // lost the race for version 1, after its fit check had a place
            429 => {
                assert_problem(reply, 429, "busy");
                assert!(
                    reply.header("retry-after").is_some(),
                    "Retry-After says when"
                );
            }
            other => panic!("{other}: {}", reply.text()),
        }
    }
    assert_eq!(saved, 1, "exactly one save wins version 1");
    assert_eq!(history(&world, "welld_it").await.len(), 1);
}

async fn futures_join_all<F: std::future::Future>(calls: Vec<F>) -> Vec<F::Output> {
    let mut set = Vec::new();
    for call in calls {
        set.push(Box::pin(call));
    }
    let mut out = Vec::new();
    // Polled together so the requests are in flight at once.
    let mut pending: Vec<_> = set.into_iter().map(Some).collect();
    out.resize_with(pending.len(), || None);
    std::future::poll_fn(|cx| {
        let mut all_done = true;
        for (at, slot) in pending.iter_mut().enumerate() {
            if let Some(future) = slot {
                match future.as_mut().poll(cx) {
                    std::task::Poll::Ready(value) => {
                        out[at] = Some(value);
                        *slot = None;
                    }
                    std::task::Poll::Pending => all_done = false,
                }
            }
        }
        if all_done {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    out.into_iter().map(|v| v.expect("done")).collect()
}

#[tokio::test]
async fn write_two_saves_on_the_same_base_cannot_both_win() {
    let Some(world) = world().await else { return };
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &config("Base", None))
            .await
            .status,
        201
    );
    let (alpha, beta, gamma) = (
        config("Alpha", None),
        config("Beta", None),
        config("Gamma", None),
    );
    let a = save_as(&world, "welld_it", "u-it", 1, &alpha);
    let b = save_as(&world, "welld_it", "u-admin", 1, &beta);
    let c = save_as(&world, "welld_it", "u-it", 1, &gamma);
    let (a, b, c) = tokio::join!(a, b, c);
    let mut statuses = [a.status, b.status, c.status];
    statuses.sort_unstable();
    assert_eq!(
        statuses,
        [201, 409, 409],
        "{} {} {}",
        a.text(),
        b.text(),
        c.text()
    );
    let record = history(&world, "welld_it").await;
    assert_eq!(
        record.len(),
        2,
        "exactly one version was added: no gap, no duplicate"
    );
    assert_eq!(record[0]["version"], 2);
}

#[tokio::test]
async fn write_a_refused_configuration_names_each_problem_by_path_and_reason_and_saves_nothing() {
    let Some(world) = world().await else { return };
    let mut bad = config("Footer {nope} and {open", None);
    bad["margins"]["top"] = json!(3);
    bad["fonts"]["body"] = json!("Comic Sans");
    bad["look"]["table"]["headerFill"] = json!("red");
    let reply = save_as(&world, "welld_it", "u-it", 0, &bad).await;
    assert_problem(&reply, 422, "invalid_letterhead");
    let found = problems(&reply);
    for expected in [
        ("/margins/top", "out_of_range"),
        ("/fonts/body", "unknown_font"),
        ("/look/table/headerFill", "bad_colour"),
    ] {
        assert!(
            found.contains(&(expected.0.to_owned(), expected.1.to_owned())),
            "{expected:?} in {found:?}"
        );
    }
    assert!(
        found
            .iter()
            .any(|(path, _)| path.starts_with("/variants/default/footer/left/0/text/")),
        "a text problem is at its language: {found:?}"
    );
    assert!(
        reply.text().find("Comic Sans").is_none(),
        "a font name that was typed is not a thing the answer needs to echo"
    );
    assert_eq!(
        rows(&world).await,
        Rows {
            versions: 0,
            links: 0,
            changes: 0,
            assets: 0
        }
    );

    // The envelope: what is not the shape of the form is `invalid_request`, and nothing of it is repeated.
    let token = world.auth.token("u-it");
    for (what, body) in [
        ("not json", "this is not json ZQX-body".to_owned()),
        ("a list", "[1]".to_owned()),
        (
            "no base",
            json!({ "config": config("A", None) }).to_string(),
        ),
        (
            "a text base",
            json!({ "baseVersion": "0", "config": config("A", None) }).to_string(),
        ),
        (
            "a fraction",
            json!({ "baseVersion": 0.5, "config": config("A", None) }).to_string(),
        ),
        (
            "a negative",
            json!({ "baseVersion": -1, "config": config("A", None) }).to_string(),
        ),
        ("no config", json!({ "baseVersion": 0 }).to_string()),
        (
            "an extra member",
            json!({ "baseVersion": 0, "config": config("A", None), "x": 1 }).to_string(),
        ),
    ] {
        let reply = post_raw(
            &world,
            "/v1/letterheads/welld_it/versions",
            Some(&token),
            Some("application/json"),
            body.into_bytes(),
        )
        .await;
        assert_problem(&reply, 422, "invalid_request");
        assert!(!reply.text().contains("ZQX-body"), "{what}");
    }
    // A config that is not an object at all is a shape problem of the configuration, at its root.
    let reply = save_as(&world, "welld_it", "u-it", 0, &json!("text")).await;
    assert_problem(&reply, 422, "invalid_letterhead");
    assert_eq!(problems(&reply), [(String::new(), "wrong_type".to_owned())]);
    assert_eq!(rows(&world).await.versions, 0);
}

#[tokio::test]
async fn write_a_body_over_a_megabyte_is_413_before_it_is_read() {
    let Some(world) = world().await else { return };
    let token = world.auth.token("u-it");
    let big = vec![b' '; 1024 * 1024 + 1];
    let reply = post_raw(
        &world,
        "/v1/letterheads/welld_it/versions",
        Some(&token),
        Some("application/json"),
        big,
    )
    .await;
    assert_problem(&reply, 413, "request_too_large");
    assert_eq!(rows(&world).await.versions, 0);
}

#[tokio::test]
async fn write_a_header_or_footer_that_does_not_fit_its_margin_is_refused_with_the_frame_as_path() {
    let Some(world) = world().await else { return };
    // A footer line is taller than a bottom margin of 10 mm leaves (AC-5.2: the margin less 5 mm from the
    // edge and 3 mm from the body).
    let mut tight = config("Footer", None);
    tight["margins"]["bottom"] = json!(10);
    let reply = save_as(&world, "welld_it", "u-it", 0, &tight).await;
    assert_problem(&reply, 422, "invalid_letterhead");
    assert_eq!(
        problems(&reply),
        [(
            "/variants/default/footer".to_owned(),
            "footer_overflow".to_owned()
        )],
        "{}",
        reply.text()
    );
    // The same frame in a margin that holds it is saved.
    let mut roomy = tight.clone();
    roomy["margins"]["bottom"] = json!(34);
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &roomy).await.status,
        201
    );

    // Four lines of the largest size, in each of the three zones, are a header that no margin of 32 mm holds,
    // and the first-page variant is named by its own path.
    let line = |text: &str| json!({ "text": { "it": text, "en": text }, "size": 14, "bold": true, "color": "e50339" });
    let mut tall = roomy.clone();
    tall["variants"]["first"] = tall["variants"]["default"].clone();
    tall["variants"]["first"]["header"]["left"] = json!([
        line("{legal_name}"),
        line("{address}"),
        line("{vat}"),
        line("{iban}")
    ]);
    let reply = save_as(&world, "welld_it", "u-it", 1, &tall).await;
    assert_problem(&reply, 422, "invalid_letterhead");
    assert_eq!(
        problems(&reply),
        [(
            "/variants/first/header".to_owned(),
            "header_overflow".to_owned()
        )],
        "{}",
        reply.text()
    );
    assert_eq!(
        rows(&world).await.versions,
        1,
        "only the roomy one was saved"
    );
}

#[tokio::test]
async fn write_an_asset_that_is_not_the_entitys_or_not_of_the_slots_kind_is_asset_unknown() {
    let Some(world) = world().await else { return };
    let f = &world.fixture;
    let own_logo = f
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    let own_background = f
        .asset(Entity::WelldIt, AssetKind::Background, Format::Png, &PNG)
        .await;
    let foreign_logo = f
        .asset(Entity::WelldCh, AssetKind::Logo, Format::Png, &PNG)
        .await;
    let ghost = Uuid::new_v4();
    let with_logo = |id: Uuid| config("Footer", Some(id));
    let with_background = |id: Uuid| {
        let mut c = config("Footer", None);
        c["variants"]["default"]["background"] = json!(id.to_string());
        c
    };

    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "an id nobody uploaded",
            with_logo(ghost),
            "/variants/default/logo/asset",
        ),
        (
            "another entity's logo",
            with_logo(foreign_logo),
            "/variants/default/logo/asset",
        ),
        (
            "a background in a logo slot",
            with_logo(own_background),
            "/variants/default/logo/asset",
        ),
        (
            "a logo in a background slot",
            with_background(own_logo),
            "/variants/default/background",
        ),
    ];
    for (what, config, path) in cases {
        let reply = save_as(&world, "welld_it", "u-it", 0, &config).await;
        assert_problem(&reply, 422, "invalid_letterhead");
        assert_eq!(
            problems(&reply),
            [(path.to_owned(), "asset_unknown".to_owned())],
            "{what}"
        );
        for id in [ghost, foreign_logo, own_logo, own_background] {
            assert!(
                !reply.text().contains(&id.to_string()),
                "{what}: an id is not repeated"
            );
        }
    }
    let after = rows(&world).await;
    assert_eq!((after.versions, after.links, after.changes), (0, 0, 0));

    // The right assets in the right slots, in two variants, one asset used twice: one link each (AC-4.6).
    let mut both = with_logo(own_logo);
    both["variants"]["default"]["background"] = json!(own_background.to_string());
    both["variants"]["first"] = both["variants"]["default"].clone();
    let reply = save_as(&world, "welld_it", "u-it", 0, &both).await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    let linked: Vec<Uuid> = f
        .repo
        .version_assets(Entity::WelldIt, 1)
        .await
        .expect("links")
        .into_iter()
        .map(|a| a.id)
        .collect();
    assert_eq!(linked.len(), 2);
    assert!(linked.contains(&own_logo) && linked.contains(&own_background));
    assert_eq!(
        names(&history(&world, "welld_it").await[0]).len(),
        10 + 1,
        "the first variant is named too"
    );
}

#[tokio::test]
async fn write_a_version_may_use_six_assets_one_logo_and_one_background_in_each_variant() {
    let Some(world) = world().await else { return };
    let f = &world.fixture;
    let mut config = config("Footer", None);
    config["variants"]["first"] = config["variants"]["default"].clone();
    config["variants"]["last"] = config["variants"]["default"].clone();
    let mut all = Vec::new();
    for variant in ["default", "first", "last"] {
        let logo = f
            .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
            .await;
        let background = f
            .asset(Entity::WelldIt, AssetKind::Background, Format::Svg, SVG)
            .await;
        config["variants"][variant]["logo"] =
            json!({ "asset": logo.to_string(), "position": "right", "heightMm": 8 });
        config["variants"][variant]["background"] = json!(background.to_string());
        all.extend([logo, background]);
    }
    let reply = save_as(&world, "welld_it", "u-it", 0, &config).await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    let mut linked: Vec<Uuid> = f
        .repo
        .version_assets(Entity::WelldIt, 1)
        .await
        .expect("links")
        .into_iter()
        .map(|a| a.id)
        .collect();
    linked.sort_unstable();
    all.sort_unstable();
    assert_eq!(linked, all);
}

#[tokio::test]
async fn write_a_logo_taller_than_the_header_is_refused_and_a_bucket_object_gone_is_a_fault() {
    let Some(world) = world().await else { return };
    let f = &world.fixture;
    let logo = f
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    // 40 mm of logo in a header whose margin is 32 mm less 8 mm.
    let mut tall = config("Footer", Some(logo));
    tall["variants"]["default"]["logo"]["heightMm"] = json!(40);
    let reply = save_as(&world, "welld_it", "u-it", 0, &tall).await;
    assert_problem(&reply, 422, "invalid_letterhead");
    assert_eq!(
        problems(&reply),
        [(
            "/variants/default/header".to_owned(),
            "header_overflow".to_owned()
        )],
        "{}",
        reply.text()
    );
    // A logo of 10 mm fits.
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &config("Footer", Some(logo)))
            .await
            .status,
        201
    );

    // The database knows an asset whose object is gone: the save cannot measure it, and says it is a fault.
    let lost = f
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    f.bucket.delete(lost).await;
    let reply = save_as(&world, "welld_it", "u-it", 1, &config("Footer", Some(lost))).await;
    assert_problem(&reply, 500, "asset_unavailable");
    assert_eq!(rows(&world).await.versions, 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Restore

/// A version stored through the repository: for the cases that the routes would refuse today.
async fn stored(world: &World, entity: Entity, layout: i32, config: Value, base: i32) {
    world
        .fixture
        .repo
        .save(NewVersion {
            entity,
            base_version: base,
            layout_version: layout,
            config,
            asset_ids: vec![],
            actor_sub: "u-old".into(),
            actor_name: "Old Hand".into(),
            changed_settings: vec![],
        })
        .await
        .expect("save");
}

#[tokio::test]
async fn write_a_restore_copies_configuration_layout_and_assets_and_names_the_difference_to_the_base()
 {
    let Some(world) = world().await else { return };
    let f = &world.fixture;
    let logo = f
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    let one = config("Footer one", Some(logo));
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &one).await.status,
        201
    );
    // Version 2: no logo, another footer and a wider margin.
    let mut two = config("Footer two", None);
    two["margins"]["left"] = json!(30);
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 1, &two).await.status,
        201
    );

    let reply = restore_as(&world, "welld_it", "u-admin", "1", 2).await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    assert_eq!(reply.json(), json!({ "version": 3 }));
    assert_no_store(&reply);

    let three = f
        .repo
        .version(Entity::WelldIt, 3)
        .await
        .expect("read")
        .expect("version 3");
    let old = f
        .repo
        .version(Entity::WelldIt, 1)
        .await
        .expect("read")
        .expect("version 1");
    assert_eq!(three.config, old.config, "the same configuration");
    assert_eq!(three.layout_version, old.layout_version, "the same layout");
    assert_eq!(three.restored_from, Some(1));
    assert_eq!(three.created_by, "u-admin");
    let links: Vec<Uuid> = f
        .repo
        .version_assets(Entity::WelldIt, 3)
        .await
        .expect("links")
        .into_iter()
        .map(|a| a.id)
        .collect();
    assert_eq!(links, [logo], "the same logos");

    // The record: what differs between the version that was active (2) and the one restored (1).
    let record = history(&world, "welld_it").await;
    assert_eq!(
        record.len(),
        3,
        "the older ones and the history are unchanged"
    );
    assert_eq!(record[0]["restoredFrom"], 1);
    assert_eq!(
        names(&record[0]),
        [
            "margins",
            "variants.default.footer",
            "variants.default.logo"
        ]
    );
    assert_eq!(record[0]["createdBy"]["sub"], "u-admin");
    assert_eq!(record[1]["restoredFrom"], Value::Null);
    assert_eq!(
        f.repo.version(Entity::WelldIt, 1).await.expect("read"),
        Some(old)
    );
}

#[tokio::test]
async fn write_a_restore_is_not_validated_again_and_a_layout_this_binary_lacks_is_refused() {
    let Some(world) = world().await else { return };
    // Version 1 holds a margin that today's rules refuse (3 mm): it was valid when it was saved.
    let mut old = config("Old footer", None);
    old["margins"]["top"] = json!(3);
    stored(&world, Entity::WelldIt, 1, old.clone(), 0).await;
    stored(&world, Entity::WelldIt, 1, config("Newer", None), 1).await;
    let reply = restore_as(&world, "welld_it", "u-it", "1", 2).await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    let three = world
        .fixture
        .repo
        .version(Entity::WelldIt, 3)
        .await
        .expect("read")
        .expect("v3");
    assert_eq!(three.config, old, "copied as it was");

    // A version of a layout from a newer binary could not be rendered by this one.
    stored(
        &world,
        Entity::WelldCh,
        99,
        config("From the future", None),
        0,
    )
    .await;
    stored(&world, Entity::WelldCh, 1, config("Today", None), 1).await;
    let before = rows(&world).await;
    let reply = restore_as(&world, "welld_ch", "u-ch", "1", 2).await;
    assert_problem(&reply, 422, "unknown_layout");
    assert_eq!(rows(&world).await, before);
}

#[tokio::test]
async fn write_a_restore_of_a_stale_base_or_of_no_such_version_changes_nothing() {
    let Some(world) = world().await else { return };
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &config("A", None))
            .await
            .status,
        201
    );
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 1, &config("B", None))
            .await
            .status,
        201
    );
    assert_eq!(
        save_as(&world, "welld_ch", "u-ch", 0, &config("CH", None))
            .await
            .status,
        201
    );
    assert_eq!(
        save_as(&world, "welld_ch", "u-ch", 1, &config("CH2", None))
            .await
            .status,
        201
    );
    assert_eq!(
        save_as(&world, "welld_ch", "u-ch", 2, &config("CH3", None))
            .await
            .status,
        201
    );
    let before = rows(&world).await;

    let stale = restore_as(&world, "welld_it", "u-it", "1", 1).await;
    assert_problem(&stale, 409, "version_conflict");
    assert_eq!(stale.json()["currentVersion"], 2);
    for base in [0, 3] {
        assert_problem(
            &restore_as(&world, "welld_it", "u-it", "1", base).await,
            409,
            "version_conflict",
        );
    }
    // 404: a number that is not a version, written any way, and another entity's version number 3.
    for n in [
        "3",
        "99",
        "0",
        "01",
        "-1",
        "+1",
        "abc",
        "1.0",
        "2147483648",
        "%20",
    ] {
        let reply = restore_as(&world, "welld_it", "u-it", n, 2).await;
        assert_problem(&reply, 404, "letterhead_version_not_found");
        assert!(!reply.text().contains("abc"), "{n}");
    }
    // The envelope.
    let token = world.auth.token("u-it");
    for body in [
        "{}",
        "[]",
        "nope",
        r#"{"baseVersion":2,"config":{}}"#,
        r#"{"baseVersion":"2"}"#,
    ] {
        let reply = post_raw(
            &world,
            "/v1/letterheads/welld_it/versions/1/restore",
            Some(&token),
            Some("application/json"),
            body.as_bytes().to_vec(),
        )
        .await;
        assert_problem(&reply, 422, "invalid_request");
    }
    assert_eq!(rows(&world).await, before);
}

// ---------------------------------------------------------------------------------------------------------------
// Who may change what

#[tokio::test]
async fn write_without_the_dedicated_permission_or_outside_its_scope_nothing_changes() {
    let Some(world) = world().await else { return };
    let f = &world.fixture;
    let logo = f
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    assert_eq!(
        save_as(
            &world,
            "welld_it",
            "u-admin",
            0,
            &config("Footer", Some(logo))
        )
        .await
        .status,
        201
    );
    assert_eq!(
        save_as(&world, "welld_it", "u-admin", 1, &config("Two", None))
            .await
            .status,
        201
    );
    let before = rows(&world).await;

    // (who, entity, the answer): a body that would be refused (422) if it were read shows the order.
    let who: Vec<(&str, &str, u16, &str)> = vec![
        ("u-access", "welld_it", 403, "forbidden"),
        ("u-access", "welld_ch", 403, "forbidden"),
        ("u-access", "nowhere", 403, "forbidden"),
        ("u-ch", "welld_it", 403, "out_of_scope"),
        ("u-it", "welld_ch", 403, "out_of_scope"),
        ("u-noentity", "welld_it", 403, "out_of_scope"),
        ("u-noentity", "welld_ch", 403, "out_of_scope"),
        // Manage without access: the tool is not theirs, whatever else they hold.
        ("u-manage-only", "welld_it", 403, "forbidden"),
        ("u-none", "welld_it", 403, "forbidden"),
        // A holder of the permission, an entity that does not exist.
        ("u-it", "welld_xx", 422, "unknown_entity"),
        ("u-admin", "WELLD_IT", 422, "unknown_entity"),
        ("u-admin", "welld_it%2F..", 422, "unknown_entity"),
    ];
    for (sub, entity, status, code) in who {
        let hostile = json!({ "baseVersion": "not a number", "config": 1 });
        let token = world.auth.token(sub);
        let routes = [
            (
                format!("/v1/letterheads/{entity}/versions"),
                "application/json".to_owned(),
                hostile.to_string().into_bytes(),
            ),
            (
                format!("/v1/letterheads/{entity}/versions/1/restore"),
                "application/json".to_owned(),
                hostile.to_string().into_bytes(),
            ),
            (
                format!("/v1/letterheads/{entity}/assets"),
                form_type(),
                b"not a form".to_vec(),
            ),
        ];
        for (path, content_type, body) in routes {
            let reply = post_raw(&world, &path, Some(&token), Some(&content_type), body).await;
            assert_problem(&reply, status, code);
            assert!(
                !reply.text().contains(entity),
                "{sub} {path}: the entity text is not repeated"
            );
        }
    }
    assert_eq!(rows(&world).await, before, "no refusal wrote anything");

    // And a body that is fine is refused all the same: the permission is not about the body.
    let ok = save_as(&world, "welld_it", "u-ch", 2, &config("Three", None)).await;
    assert_problem(&ok, 403, "out_of_scope");
    let ok = restore_as(&world, "welld_it", "u-access", "1", 2).await;
    assert_problem(&ok, 403, "forbidden");
    let ok = upload_as(&world, "welld_it", "u-ch", "logo", &PNG, "l.png").await;
    assert_problem(&ok, 403, "out_of_scope");
    assert_eq!(rows(&world).await, before);

    // The holders do: an entity manager their own, an administrator both.
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 2, &config("It", None))
            .await
            .status,
        201
    );
    assert_eq!(
        save_as(&world, "welld_ch", "u-ch", 0, &config("Ch", None))
            .await
            .status,
        201
    );
    assert_eq!(
        save_as(&world, "welld_ch", "u-admin", 1, &config("Ch2", None))
            .await
            .status,
        201
    );
    assert_eq!(
        restore_as(&world, "welld_ch", "u-ch", "1", 2).await.status,
        201
    );
    assert_eq!(
        upload_as(&world, "welld_ch", "u-ch", "logo", &PNG, "l.png")
            .await
            .status,
        201
    );
}

#[tokio::test]
async fn write_every_write_route_needs_the_persons_token() {
    let Some(world) = world().await else { return };
    let paths = [
        (
            "/v1/letterheads/welld_it/versions",
            "application/json".to_owned(),
        ),
        (
            "/v1/letterheads/welld_it/versions/1/restore",
            "application/json".to_owned(),
        ),
        ("/v1/letterheads/welld_it/assets", form_type()),
    ];
    let service = world.auth.service_token();
    for (path, content_type) in paths {
        for token in [None, Some("garbage"), Some(service.as_str())] {
            let reply = post_raw(&world, path, token, Some(&content_type), b"{}".to_vec()).await;
            assert_eq!(reply.status, 401, "{path}: {}", reply.text());
            assert_eq!(reply.code(), "unauthorized");
        }
    }
    assert_eq!(rows(&world).await.versions, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// The change record

#[tokio::test]
async fn write_the_record_names_the_person_from_the_token_and_falls_back_to_the_email() {
    let Some(world) = world().await else { return };
    let named = world
        .auth
        .token_with("u-it", |c| c["name"] = json!("Zoë Ångström-Łukasiewicz"));
    let nameless = world.auth.token_with("u-it", |c| {
        c.as_object_mut().expect("object").remove("name");
    });
    for (token, base, footer) in [(named, 0, "A"), (nameless, 1, "B")] {
        let reply = post_raw(
            &world,
            "/v1/letterheads/welld_it/versions",
            Some(&token),
            Some("application/json"),
            json!({ "baseVersion": base, "config": config(footer, None) })
                .to_string()
                .into_bytes(),
        )
        .await;
        assert_eq!(reply.status, 201, "{}", reply.text());
    }
    let record = history(&world, "welld_it").await;
    assert_eq!(
        record[1]["createdBy"],
        json!({ "sub": "u-it", "name": "Zoë Ångström-Łukasiewicz" })
    );
    assert_eq!(
        record[0]["createdBy"],
        json!({ "sub": "u-it", "name": "u-it@welld.example" })
    );
}

#[tokio::test]
async fn write_there_is_no_put_patch_or_delete_on_any_person_route() {
    let Some(world) = world().await else { return };
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &config("A", None))
            .await
            .status,
        201
    );
    // No verb but POST, on any of the routes that exist, for any holder or for nobody: 405, nothing changed.
    let before = rows(&world).await;
    let paths = [
        "/v1/letterheads/welld_it/versions",
        "/v1/letterheads/welld_it/versions/1",
        "/v1/letterheads/welld_it/versions/1/restore",
        "/v1/letterheads/welld_it/assets",
        "/v1/letterheads",
        "/v1/catalog",
    ];
    let token = world.auth.token("u-admin");
    for path in paths {
        for method in ["PUT", "PATCH", "DELETE"] {
            for credential in [Some(token.as_str()), None] {
                let method = reqwest::Method::from_bytes(method.as_bytes()).expect("method");
                let mut request = http()
                    .request(method.clone(), world.server.url(path))
                    .body("{}");
                if let Some(credential) = credential {
                    request = request.header("authorization", format!("Bearer {credential}"));
                }
                let reply = send(request).await;
                assert_eq!(reply.status, 405, "{method} {path}: {}", reply.text());
                assert_eq!(reply.code(), "method_not_allowed");
            }
        }
    }
    // A GET of a write-only route is not a read of anything either.
    for path in [
        "/v1/letterheads/welld_it/versions/1/restore",
        "/v1/letterheads/welld_it/assets",
    ] {
        assert_eq!(world.get(path, "u-admin").await.status, 405, "{path}");
    }
    assert_eq!(rows(&world).await, before);
}

// ---------------------------------------------------------------------------------------------------------------
// Upload

#[tokio::test]
async fn write_an_upload_stores_the_asset_and_says_what_it_is() {
    let Some(world) = world().await else { return };
    let reply = upload_as(&world, "welld_it", "u-it", "logo", &PNG, "company.png").await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    assert_no_store(&reply);
    let body = reply.json();
    assert_eq!(body["kind"], "logo");
    assert_eq!(body["format"], "png");
    assert_eq!(
        (body["width"].clone(), body["height"].clone()),
        (json!(2), json!(1))
    );
    let id = Uuid::parse_str(body["id"].as_str().expect("an id")).expect("a uuid");
    assert_eq!(body.as_object().expect("object").len(), 5);

    // What the form gets back for the thumbnail is what was stored.
    let thumb = world.get(&format!("/v1/assets/{id}"), "u-access").await;
    assert_eq!(thumb.status, 200);
    assert_eq!(thumb.header("content-type").as_deref(), Some("image/png"));
    assert_eq!(thumb.body, PNG);
    let row = world
        .fixture
        .repo
        .asset(id)
        .await
        .expect("read")
        .expect("a row");
    assert_eq!(row.entity, Entity::WelldIt);
    assert_eq!(row.kind, AssetKind::Logo);
    assert_eq!(row.created_by, "u-it");
    assert_eq!(row.sha256, Sha256::digest(PNG).to_vec());
    assert_eq!(row.size_px, Some((2, 1)));

    // The format is read from the bytes, never from the name or the declared type (AC-7.1); an SVG is rebuilt.
    let reply = upload_as(
        &world,
        "welld_it",
        "u-admin",
        "background",
        SVG,
        "photo.png",
    )
    .await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    assert_eq!(reply.json()["format"], "svg");
    assert_eq!(reply.json()["kind"], "background");
    assert_eq!(reply.json()["width"], Value::Null);
    let svg_id = reply.json()["id"].as_str().expect("id").to_owned();
    let served = world.get(&format!("/v1/assets/{svg_id}"), "u-access").await;
    assert_eq!(
        served.header("content-type").as_deref(),
        Some("image/svg+xml")
    );
    let reply = upload_as(
        &world,
        "welld_it",
        "u-it",
        "logo",
        &PNG,
        "../../etc/passwd.svg",
    )
    .await;
    assert_eq!(reply.json()["format"], "png");
    // Two uploads of the same file are two assets: ids are the server's.
    assert_ne!(reply.json()["id"], body["id"]);
    assert_eq!(rows(&world).await.assets, 3);
}

#[tokio::test]
async fn write_an_upload_is_refused_with_the_reason_in_the_vocabulary_and_stores_nothing() {
    let Some(world) = world().await else { return };
    let svg = |inner: &str| {
        format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">{inner}</svg>"#)
    };
    let mut cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "text",
            b"just some words ZQX-bytes".to_vec(),
            "unsupported_format",
        ),
        ("nothing", Vec::new(), "unsupported_format"),
        ("a cut PNG", PNG[..40].to_vec(), "unsupported_format"),
        (
            "a script",
            svg("<script>alert(1)</script>").into_bytes(),
            "svg_script",
        ),
        (
            "a handler",
            svg(r#"<rect width="1" height="1" onload="x()"/>"#).into_bytes(),
            "svg_event_handler",
        ),
        (
            "a foreignObject",
            svg("<foreignObject/>").into_bytes(),
            "svg_foreign_object",
        ),
        (
            "a link out",
            svg(r#"<image href="http://evil.example/x.png"/>"#).into_bytes(),
            "svg_external_reference",
        ),
        (
            "an element that is not on the list",
            svg("<style>rect{fill:red}</style>").into_bytes(),
            "svg_not_allowed",
        ),
        // T48/F3: these made the sanitiser panic (500) before; they are refused like any other `<style>`.
        (
            "an element inside a style",
            svg("<style><rect/></style>").into_bytes(),
            "svg_not_allowed",
        ),
        (
            "a style inside an element inside a style",
            svg("<style><g><style/></g></style>").into_bytes(),
            "svg_not_allowed",
        ),
    ];
    let mut too_big = PNG.to_vec();
    too_big.resize(assets_max() + 1, 0);
    cases.push(("a file one byte over 2 MiB", too_big, "too_many_bytes"));
    cases.push((
        "a 5 MiB file",
        vec![0x89; 5 * 1024 * 1024],
        "too_many_bytes",
    ));
    for (what, file, reason) in cases {
        let reply = upload_as(&world, "welld_it", "u-it", "logo", &file, "ZQX-name.png").await;
        assert_problem(&reply, 422, "invalid_asset");
        assert_eq!(reply.json()["reason"], reason, "{what}");
        assert!(
            !reply.text().contains("ZQX"),
            "{what}: nothing of the upload is repeated"
        );
        assert!(!reply.text().contains("evil.example"), "{what}");
    }
    assert_eq!(rows(&world).await.assets, 0);
}

fn assets_max() -> usize {
    letterhead_engine::assets::MAX_BYTES
}

#[tokio::test]
async fn write_an_upload_that_is_not_the_form_is_a_400_and_a_2_mib_file_is_still_a_file() {
    let Some(world) = world().await else { return };
    let token = world.auth.token("u-it");
    let path = "/v1/letterheads/welld_it/assets";
    let form = |parts: &[(&str, Option<&str>, &[u8])]| multipart(parts);
    let cases: Vec<(&str, Option<String>, Vec<u8>)> = vec![
        (
            "a JSON body",
            Some("application/json".into()),
            b"{}".to_vec(),
        ),
        (
            "no type",
            None,
            form(&[("kind", None, b"logo"), ("file", Some("a"), &PNG)]),
        ),
        (
            "no boundary",
            Some("multipart/form-data".into()),
            form(&[("kind", None, b"logo")]),
        ),
        (
            "no kind",
            Some(form_type()),
            form(&[("file", Some("a"), &PNG)]),
        ),
        (
            "no file",
            Some(form_type()),
            form(&[("kind", None, b"logo")]),
        ),
        (
            "an unknown kind",
            Some(form_type()),
            form(&[("kind", None, b"banner"), ("file", Some("a"), &PNG)]),
        ),
        (
            "a repeated file",
            Some(form_type()),
            form(&[
                ("kind", None, b"logo"),
                ("file", Some("a"), &PNG),
                ("file", Some("b"), &PNG),
            ]),
        ),
        (
            "another field",
            Some(form_type()),
            form(&[
                ("kind", None, b"logo"),
                ("file", Some("a"), &PNG),
                ("note", None, b"x"),
            ]),
        ),
        (
            "a cut body",
            Some(form_type()),
            form(&[("kind", None, b"logo"), ("file", Some("a"), &PNG)])[..60].to_vec(),
        ),
    ];
    for (what, content_type, body) in cases {
        let reply = post_raw(&world, path, Some(&token), content_type.as_deref(), body).await;
        assert_problem(&reply, 400, "bad_request");
        assert!(!reply.text().contains("banner"), "{what}");
    }
    assert_eq!(rows(&world).await.assets, 0);

    // A PNG padded to exactly 2 MiB is within the limit of AC-7.3 (it is a PNG: the padding is past its end,
    // which a decoder ignores, and the container check reads only the chunks).
    let mut exact = PNG.to_vec();
    exact.resize(assets_max(), 0);
    let reply = upload_as(&world, "welld_it", "u-it", "logo", &exact, "exact.png").await;
    assert!(
        reply.status == 201
            || (reply.status == 422 && reply.json()["reason"] == "unsupported_format"),
        "the size is not what refuses it: {}",
        reply.text()
    );
    assert_ne!(reply.json()["reason"], "too_many_bytes");
}

// ---------------------------------------------------------------------------------------------------------------
// What the service says about itself

#[tokio::test]
async fn write_nothing_of_a_save_an_upload_or_a_person_reaches_the_log() {
    let Some(world) = world().await else { return };
    let marker = "ZQX-footer-text-9c1";
    let token = world
        .auth
        .token_with("u-it", |c| c["name"] = json!(NAME_MARKER));
    let reply = post_raw(
        &world,
        "/v1/letterheads/welld_it/versions",
        Some(&token),
        Some("application/json"),
        json!({ "baseVersion": 0, "config": config(marker, None) })
            .to_string()
            .into_bytes(),
    )
    .await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    let _ = save_as(&world, "welld_it", "u-it", 7, &config(marker, None)).await;
    let _ = upload_as(
        &world,
        "welld_it",
        "u-it",
        "logo",
        &PNG,
        "ZQX-file-name-77.png",
    )
    .await;
    let _ = upload_as(
        &world,
        "welld_it",
        "u-it",
        "logo",
        b"ZQX-not-an-image",
        "ZQX-file-name-78.png",
    )
    .await;
    let _ = restore_as(&world, "welld_it", "u-it", "1", 1).await;
    let World { server, .. } = world;
    let (out, err) = server.stop();
    let logs = [out, err].concat().join("\n");
    for text in [
        marker,
        NAME_MARKER,
        "ZQX-file-name",
        "ZQX-not-an-image",
        "u-it@welld.example",
    ] {
        assert!(!logs.contains(text), "`{text}` is in the log: {logs}");
    }
}

#[tokio::test]
async fn write_an_auth_that_cannot_answer_refuses_a_write_and_changes_nothing() {
    let Some(world) = world().await else { return };
    assert_eq!(
        save_as(&world, "welld_it", "u-it", 0, &config("A", None))
            .await
            .status,
        201
    );
    let before = rows(&world).await;
    // A person whose permissions are not cached yet (a new epoch): `auth` is asked, and cannot answer.
    for mode in [Resolve::Status(503), Resolve::Status(500), Resolve::Garbage] {
        world.auth.resolve(mode);
        let token = world.auth.token_at("u-it", 99);
        let reply = post_raw(
            &world,
            "/v1/letterheads/welld_it/versions",
            Some(&token),
            Some("application/json"),
            json!({ "baseVersion": 1, "config": config("B", None) })
                .to_string()
                .into_bytes(),
        )
        .await;
        assert_problem(&reply, 503, "authz_unavailable");
    }
    assert_eq!(rows(&world).await, before);
}
