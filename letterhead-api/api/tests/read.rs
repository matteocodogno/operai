//! Integration tests of the person routes that read (task T14; AC-6.1, AC-8.1, AC-8.2, AC-8.7, AC-4.9, and the
//! person side of AC-3.1).
//!
//! Black-box tests of the real binary (`CARGO_BIN_EXE_letterhead-api`), as `render.rs` is: each test starts its
//! own supervisor on a free port against a schema of its own in `LETTERHEAD_TEST_DATABASE_URL` and the MinIO
//! bucket of `LETTERHEAD_TEST_S3_*` (see `render.rs` for the names and the defaults). Around it, in this process:
//!
//! - a fake `auth`: a JWKS of a key generated here, and `GET /authz/resolve`, which answers from a table of people
//!   (what each holds), counts what it is asked, and can be made to fail. The supervisor is told only its address.
//! - the people: a holder of access only, a manager of one entity, an administrator, one with no access.
//!
//! Without the database variable the tests are skipped with a notice; `LETTERHEAD_REQUIRE_DB_TESTS=1` (set in CI)
//! turns anything missing, the database or the bucket, into a failure. Every test name starts with `read_`.

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
use db::types::{AssetKind, NewAsset, NewVersion, RestoreVersion};
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
            "{URL_VAR} is not set and {REQUIRE_VAR}=1: the read tests may not be skipped"
        );
        eprintln!("SKIPPED: set {URL_VAR} to run the read tests");
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
                    "the bucket {} is not reachable at {} and {REQUIRE_VAR}=1: the read tests may not be skipped",
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

    /// The next version of an entity, through the repository (AC-4.1), made by a named person.
    async fn save(
        &self,
        entity: Entity,
        config: Value,
        assets: &[Uuid],
        actor: (&str, &str),
        changed: &[&str],
    ) -> i32 {
        let base = self
            .repo
            .active_version(entity)
            .await
            .expect("read")
            .map_or(0, |v| v.version);
        self.repo
            .save(NewVersion {
                entity,
                base_version: base,
                layout_version: 1,
                config,
                asset_ids: assets.to_vec(),
                actor_sub: actor.0.into(),
                actor_name: actor.1.into(),
                changed_settings: changed.iter().map(|s| (*s).to_owned()).collect(),
            })
            .await
            .expect("save a version")
    }

    async fn restore(&self, entity: Entity, from: i32, actor: (&str, &str)) -> i32 {
        let base = self
            .repo
            .active_version(entity)
            .await
            .expect("read")
            .map_or(0, |v| v.version);
        self.repo
            .restore(RestoreVersion {
                entity,
                from_version: from,
                base_version: base,
                actor_sub: actor.0.into(),
                actor_name: actor.1.into(),
                changed_settings: vec!["margins".into()],
            })
            .await
            .expect("restore a version")
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

    fn resolve_calls(&self) -> Vec<String> {
        self.state.asked.lock().expect("lock").clone()
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
        ("LH_QUEUE", "1".to_owned()),
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

/// The routes that read, with a path that exists for the `welld_it` entity whose version 1 exists.
fn person_paths(asset: Uuid) -> Vec<String> {
    vec![
        "/v1/catalog".to_owned(),
        "/v1/letterheads".to_owned(),
        "/v1/letterheads/welld_it/versions".to_owned(),
        "/v1/letterheads/welld_it/versions/1".to_owned(),
        format!("/v1/assets/{asset}"),
    ]
}

/// A world with something to read: `welld_it` has two versions (the second restores the first), `welld_ch`
/// none, and the first version uses a logo.
async fn with_content() -> Option<(World, Uuid)> {
    let world = World::start().await?;
    let logo = world
        .fixture
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    world
        .fixture
        .save(
            Entity::WelldIt,
            config("Footer one", Some(logo)),
            &[logo],
            ("u-admin", "Ada Admin"),
            &["margins", "variants.default.logo"],
        )
        .await;
    Some((world, logo))
}

// ---------------------------------------------------------------------------------------------------------------
// Who: the person's token

#[tokio::test]
async fn read_every_bad_credential_is_the_same_401_on_every_person_route() {
    let Some((world, asset)) = with_content().await else {
        return;
    };
    let a = &world.auth;
    let other_key = TestKey::generate();
    let wrong_key = other_key.token(&a.claims("u-admin", 1));
    let bad: Vec<(&str, Option<String>)> = vec![
        ("no credential", None),
        ("not a token", Some("not-a-jwt".into())),
        (
            "expired",
            Some(a.token_with("u-admin", |c| c["exp"] = json!(now() - 10))),
        ),
        (
            "another issuer",
            Some(a.token_with("u-admin", |c| c["iss"] = json!("http://evil.example"))),
        ),
        (
            "another audience",
            Some(a.token_with("u-admin", |c| c["aud"] = json!("somebody-else"))),
        ),
        // AC-3.1, symmetric: a service token on a person route.
        ("a service token", Some(a.service_token())),
        (
            "a service principal under the person audience",
            Some(a.token_with("u-admin", |c| c["sub"] = json!("system:crm-api"))),
        ),
        (
            "both audiences",
            Some(a.token_with("u-admin", |c| {
                c["aud"] = json!([PERSON_AUDIENCE, SERVICE_AUDIENCE]);
            })),
        ),
        ("another key", Some(wrong_key)),
        (
            "no email",
            Some(a.token_with("u-admin", |c| {
                c.as_object_mut().expect("object").remove("email");
            })),
        ),
    ];
    let mut bodies = Vec::new();
    for path in person_paths(asset) {
        for (what, token) in &bad {
            let reply = get_with(&world.server, &path, token.as_deref()).await;
            assert_eq!(reply.status, 401, "{what} on {path}: {}", reply.text());
            assert_eq!(
                reply.header("content-type").as_deref(),
                Some("application/problem+json"),
                "{what} on {path}"
            );
            assert_eq!(
                reply.header("www-authenticate").as_deref(),
                Some("Bearer"),
                "{what} on {path}"
            );
            assert_no_store(&reply);
            bodies.push(reply.body);
        }
    }
    assert!(
        bodies.windows(2).all(|pair| pair[0] == pair[1]),
        "one body for every cause and every route"
    );
    assert!(String::from_utf8_lossy(&bodies[0]).contains("\"code\":\"unauthorized\""));
    // Nothing of a refused request needed `auth`'s permissions: no credential that failed was forwarded.
    assert!(
        world.auth.resolve_calls().is_empty(),
        "a token that is not a person's is never sent on to /authz/resolve"
    );
}

#[tokio::test]
async fn read_a_person_token_is_still_refused_on_the_service_routes() {
    let Some(world) = World::start().await else {
        return;
    };
    let token = world.auth.token("u-admin");
    for path in ["/v1/letterheads/status"] {
        let reply = get_with(&world.server, path, Some(&token)).await;
        assert_eq!(reply.status, 401, "{path}");
    }
    let reply = send(
        http()
            .post(world.server.url("/v1/render/preview"))
            .header("authorization", format!("Bearer {token}"))
            .body("{}"),
    )
    .await;
    assert_eq!(reply.status, 401);
}

// ---------------------------------------------------------------------------------------------------------------
// What: letterheads:access and the outage of auth

#[tokio::test]
async fn read_without_letterheads_access_every_person_route_is_403_forbidden() {
    let Some((world, asset)) = with_content().await else {
        return;
    };
    for sub in ["u-none", "u-manage-only"] {
        for path in person_paths(asset) {
            let reply = world.get(&path, sub).await;
            assert_problem(&reply, 403, "forbidden");
            // The refusal names nothing of the person or of what they asked for.
            let text = reply.text();
            assert!(
                !text.contains(sub) && !text.contains(&asset.to_string()),
                "{text}"
            );
        }
    }
    // With access, every one of them answers.
    for path in person_paths(asset) {
        let reply = world.get(&path, "u-access").await;
        assert_eq!(reply.status, 200, "{path}: {}", reply.text());
        assert_no_store(&reply);
    }
}

#[tokio::test]
async fn read_an_auth_that_is_down_is_503_and_never_an_allow() {
    let Some((world, asset)) = with_content().await else {
        return;
    };
    for (round, (what, mode)) in [
        ("500", Resolve::Status(500)),
        ("503", Resolve::Status(503)),
        ("401", Resolve::Status(401)),
        ("a redirect", Resolve::Status(302)),
        ("a body that is not a permission set", Resolve::Garbage),
    ]
    .into_iter()
    .enumerate()
    {
        world.auth.resolve(mode);
        // A person who has not been resolved yet (a fresh epoch each time: the cache is by sub and epoch).
        let token = world.auth.token_at("u-admin", 100 + round as i64);
        for path in person_paths(asset) {
            let reply = get_with(&world.server, &path, Some(&token)).await;
            assert_problem(&reply, 503, "authz_unavailable");
            assert_eq!(reply.header("retry-after").as_deref(), Some("2"), "{what}");
        }
    }
    // It recovers at once: nothing of the outage was cached.
    world.auth.resolve(Resolve::Normal);
    let reply = world.get("/v1/letterheads", "u-admin").await;
    assert_eq!(reply.status, 200, "{}", reply.text());
}

#[tokio::test]
async fn read_an_answer_is_cached_for_a_sub_and_epoch_and_asked_with_the_persons_own_token() {
    let Some(world) = World::start().await else {
        return;
    };
    let token = world.auth.token_at("u-admin", 5);
    for _ in 0..3 {
        let reply = get_with(&world.server, "/v1/letterheads", Some(&token)).await;
        assert_eq!(reply.status, 200);
    }
    assert_eq!(
        world.auth.resolve_calls().len(),
        1,
        "three requests, one question"
    );
    assert_eq!(
        world.auth.resolve_calls()[0],
        format!("Bearer {token}"),
        "the caller's own token is what is forwarded"
    );

    // A new epoch is a new question; so is another person.
    let again = world.auth.token_at("u-admin", 6);
    assert_eq!(
        get_with(&world.server, "/v1/letterheads", Some(&again))
            .await
            .status,
        200
    );
    assert_eq!(world.auth.resolve_calls().len(), 2);
    assert_eq!(world.get("/v1/letterheads", "u-it").await.status, 200);
    assert_eq!(world.auth.resolve_calls().len(), 3);

    // Within the TTL an outage of auth does not touch a person who was resolved: their answer is the one held.
    world.auth.resolve(Resolve::Status(500));
    assert_eq!(
        get_with(&world.server, "/v1/letterheads", Some(&token))
            .await
            .status,
        200
    );
    // And a person who was not is refused, not allowed.
    let fresh = world.auth.token_at("u-ch", 1);
    let refused = get_with(&world.server, "/v1/letterheads", Some(&fresh)).await;
    assert_problem(&refused, 503, "authz_unavailable");
}

// ---------------------------------------------------------------------------------------------------------------
// The routes

#[tokio::test]
async fn read_the_catalog_lists_the_closed_sets_and_a_default_that_is_the_engines() {
    let Some(world) = World::start().await else {
        return;
    };
    // Access is all it takes, and no letterhead needs to exist.
    let reply = world.get("/v1/catalog", "u-access").await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_no_store(&reply);
    assert!(
        reply
            .header("content-type")
            .is_some_and(|t| t.starts_with("application/json")),
        "{:?}",
        reply.header("content-type")
    );
    let catalog = reply.json();

    // AC-6.1: the closed set of placeholders.
    let names: Vec<&str> = catalog["placeholders"]
        .as_array()
        .expect("placeholders")
        .iter()
        .map(|p| p["name"].as_str().expect("name"))
        .collect();
    assert_eq!(
        names,
        [
            "legal_name",
            "address",
            "vat",
            "iban",
            "contacts",
            "page",
            "pages"
        ]
    );
    assert_eq!(catalog["fonts"].as_array().map(Vec::len), Some(5));
    assert_eq!(catalog["styles"].as_array().map(Vec::len), Some(7));
    assert_eq!(catalog["escapes"].as_array().map(Vec::len), Some(4));
    assert_eq!(
        catalog["bounds"]["marginMm"],
        json!({ "min": 5.0, "max": 100.0 })
    );

    // G2: the starting values are the engine's own default, which the save rules accept.
    let default = serde_json::to_value(default_config()).expect("json");
    assert_eq!(catalog["defaultConfig"], default);
    assert_eq!(catalog["defaultConfig"]["margins"]["top"], 25.0);
}

/// `GET /v1/letterheads` as `sub`, with the `canManage` that each entity is to have.
async fn assert_list(world: &World, sub: &str, versions: (Value, Value), can: (bool, bool)) {
    let reply = world.get("/v1/letterheads", sub).await;
    assert_eq!(reply.status, 200, "{sub}: {}", reply.text());
    assert_no_store(&reply);
    assert_eq!(
        reply.json(),
        json!({
            "welld_it": { "activeVersion": versions.0, "canManage": can.0 },
            "welld_ch": { "activeVersion": versions.1, "canManage": can.1 },
        }),
        "{sub}"
    );
}

#[tokio::test]
async fn read_the_list_says_what_each_person_may_change() {
    let Some((world, _)) = with_content().await else {
        return;
    };
    // The active version is the highest; an entity with none says null. Both entities are always there.
    let first = (json!(1), Value::Null);
    // Access only: sees both, changes neither (AC-8.2).
    assert_list(&world, "u-access", first.clone(), (false, false)).await;
    // A scoped manager changes their own entity only.
    assert_list(&world, "u-it", first.clone(), (true, false)).await;
    assert_list(&world, "u-ch", first.clone(), (false, true)).await;
    // An administrator (unconditioned grant) changes both.
    assert_list(&world, "u-admin", first.clone(), (true, true)).await;
    // A scoped grant with no entity on the person fails closed: never "everything".
    assert_list(&world, "u-noentity", first, (false, false)).await;

    // A second save moves the active version, and only for its entity.
    world
        .fixture
        .save(
            Entity::WelldCh,
            config("Ch", None),
            &[],
            ("u-ch", "Chiara"),
            &["margins"],
        )
        .await;
    world
        .fixture
        .save(
            Entity::WelldIt,
            config("Footer two", None),
            &[],
            ("u-it", "Ivo"),
            &["variants.default.footer"],
        )
        .await;
    assert_list(&world, "u-admin", (json!(2), json!(1)), (true, true)).await;
}

#[tokio::test]
async fn read_the_history_lists_who_when_and_what_changed_newest_first() {
    let Some((world, _)) = with_content().await else {
        return;
    };
    world
        .fixture
        .save(
            Entity::WelldIt,
            config("Footer two", None),
            &[],
            ("u-it", "Ivo Italiano"),
            &["variants.default.footer", "variants.default.logo"],
        )
        .await;
    let restored = world
        .fixture
        .restore(Entity::WelldIt, 1, ("u-admin", "Ada Admin"))
        .await;
    assert_eq!(restored, 3);
    // Another entity's history is its own.
    // Another entity's history is its own, and does not show here.
    world
        .fixture
        .save(
            Entity::WelldCh,
            config("Ch", None),
            &[],
            ("u-ch", "Chiara"),
            &["fonts"],
        )
        .await;

    let reply = world
        .get("/v1/letterheads/welld_it/versions", "u-access")
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_no_store(&reply);
    let history = reply.json();
    let rows = history.as_array().expect("a list");
    assert_eq!(rows.len(), 3, "{history}");
    let numbers: Vec<i64> = rows
        .iter()
        .map(|r| r["version"].as_i64().expect("n"))
        .collect();
    assert_eq!(numbers, [3, 2, 1], "newest first");

    // G9: who is {sub, name}; what changed is the vocabulary; a restore says which version it copied.
    assert_eq!(
        rows[0]["createdBy"],
        json!({ "sub": "u-admin", "name": "Ada Admin" })
    );
    assert_eq!(rows[0]["restoredFrom"], 1);
    assert_eq!(
        rows[1]["createdBy"],
        json!({ "sub": "u-it", "name": "Ivo Italiano" })
    );
    assert_eq!(
        rows[1]["changedSettings"],
        json!(["variants.default.footer", "variants.default.logo"])
    );
    assert_eq!(rows[1]["restoredFrom"], Value::Null);
    assert_eq!(
        rows[2]["changedSettings"],
        json!(["margins", "variants.default.logo"])
    );
    for row in rows {
        // An RFC 3339 instant in UTC, to the millisecond.
        let at = row["createdAt"].as_str().expect("a time");
        assert!(
            at.len() == 24 && at.ends_with('Z') && at.as_bytes()[10] == b'T',
            "{at}"
        );
        let mut members: Vec<&String> = row.as_object().expect("object").keys().collect();
        members.sort();
        assert_eq!(
            members,
            [
                "changedSettings",
                "createdAt",
                "createdBy",
                "restoredFrom",
                "version"
            ]
        );
    }

    // The other entity's history is its own one version.
    let ch = world
        .get("/v1/letterheads/welld_ch/versions", "u-access")
        .await
        .json();
    assert_eq!(ch.as_array().map(Vec::len), Some(1), "{ch}");
    assert_eq!(ch[0]["createdBy"]["sub"], "u-ch");

    // An entity with no version has an empty history, not an error.
    let empty_world = World::start().await.expect("a second world");
    let reply = empty_world
        .get("/v1/letterheads/welld_ch/versions", "u-access")
        .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json(), json!([]));
}

#[tokio::test]
async fn read_a_version_is_the_stored_configuration_and_its_layout() {
    let Some((world, logo)) = with_content().await else {
        return;
    };
    let reply = world
        .get("/v1/letterheads/welld_it/versions/1", "u-access")
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_no_store(&reply);
    let body = reply.json();
    assert_eq!(body["version"], 1);
    assert_eq!(body["layoutVersion"], 1);
    assert_eq!(body["config"], config("Footer one", Some(logo)));
    let mut members: Vec<&String> = body.as_object().expect("object").keys().collect();
    members.sort();
    assert_eq!(members, ["config", "layoutVersion", "version"]);

    // A version that does not exist, or cannot, is 404 `letterhead_version_not_found`; nothing of the number is
    // repeated; another entity's version is never answered for this one (AC-4.4).
    for number in [
        "2",
        "0",
        "01",
        "-1",
        "+1",
        "abc",
        "1.0",
        "99999999999999999999",
        "1e1",
    ] {
        let reply = world
            .get(
                &format!("/v1/letterheads/welld_it/versions/{number}"),
                "u-access",
            )
            .await;
        assert_problem(&reply, 404, "letterhead_version_not_found");
        if number.len() > 3 {
            assert!(!reply.text().contains(number), "{}", reply.text());
        }
    }
    let other = world
        .get("/v1/letterheads/welld_ch/versions/1", "u-access")
        .await;
    assert_problem(&other, 404, "letterhead_version_not_found");
}

#[tokio::test]
async fn read_an_unknown_entity_is_422_unknown_entity_and_is_not_repeated() {
    let Some((world, _)) = with_content().await else {
        return;
    };
    for path in [
        "/v1/letterheads/welld_de/versions",
        "/v1/letterheads/welld_de/versions/1",
        "/v1/letterheads/WELLD_IT/versions",
        "/v1/letterheads/%77elld_de/versions",
        "/v1/letterheads/%FF/versions",
        "/v1/letterheads/%FF/versions/1",
    ] {
        let reply = world.get(path, "u-access").await;
        assert_problem(&reply, 422, "unknown_entity");
        assert!(!reply.text().contains("welld_de"), "{}", reply.text());
    }
    // An encoded name that decodes to an entity is that entity.
    let reply = world
        .get("/v1/letterheads/%77elld_it/versions", "u-access")
        .await;
    assert_eq!(reply.status, 200);
}

#[tokio::test]
async fn read_an_asset_is_served_as_its_format_with_what_keeps_a_browser_from_running_it() {
    let Some((world, png)) = with_content().await else {
        return;
    };
    let reply = world.get(&format!("/v1/assets/{png}"), "u-access").await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.body, PNG);
    assert_eq!(reply.header("content-type").as_deref(), Some("image/png"));
    assert_eq!(
        reply.header("x-content-type-options").as_deref(),
        Some("nosniff")
    );
    assert!(
        reply
            .header("content-security-policy")
            .is_some_and(|p| p.contains("default-src 'none'") && p.contains("sandbox")),
        "{:?}",
        reply.header("content-security-policy")
    );
    assert_no_store(&reply);

    let svg = world
        .fixture
        .asset(Entity::WelldCh, AssetKind::Background, Format::Svg, SVG)
        .await;
    let reply = world.get(&format!("/v1/assets/{svg}"), "u-access").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, SVG);
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("image/svg+xml")
    );

    // An asset that was uploaded and never saved is readable by a holder of access, too (the form's thumbnail).
    let jpeg_bytes: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
    let jpeg = world
        .fixture
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Jpeg, jpeg_bytes)
        .await;
    let reply = world.get(&format!("/v1/assets/{jpeg}"), "u-access").await;
    assert_eq!(reply.header("content-type").as_deref(), Some("image/jpeg"));
    assert_eq!(reply.body, jpeg_bytes);

    // Not an asset: 404, and the id is not repeated.
    let missing = Uuid::new_v4();
    let reply = world
        .get(&format!("/v1/assets/{missing}"), "u-access")
        .await;
    assert_problem(&reply, 404, "asset_not_found");
    assert!(!reply.text().contains(&missing.to_string()));
    for bad in ["not-a-uuid", "1", "%FF", "../../etc/passwd"] {
        let reply = world.get(&format!("/v1/assets/{bad}"), "u-access").await;
        assert!(reply.status == 404, "{bad}: {}", reply.status);
    }
}

#[tokio::test]
async fn read_an_asset_whose_object_is_gone_is_a_server_fault_not_a_blank_image() {
    let Some((world, _)) = with_content().await else {
        return;
    };
    let id = world
        .fixture
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    world.fixture.bucket.delete(id).await;
    let reply = world.get(&format!("/v1/assets/{id}"), "u-access").await;
    assert_problem(&reply, 500, "asset_unavailable");

    // An object that is not what the row says (damaged, or replaced) is refused the same way.
    let other = world
        .fixture
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    world.fixture.bucket.put(other, b"replaced").await;
    let reply = world.get(&format!("/v1/assets/{other}"), "u-access").await;
    assert_problem(&reply, 500, "asset_unavailable");
}

// ---------------------------------------------------------------------------------------------------------------
// What does not exist

#[tokio::test]
async fn read_there_is_no_put_patch_or_delete_on_any_person_route() {
    let Some((world, asset)) = with_content().await else {
        return;
    };
    let token = world.auth.token("u-admin");
    for path in person_paths(asset) {
        for method in ["PUT", "PATCH", "DELETE"] {
            // With a person's token, with a service token and with none: there is no such route for anyone.
            for credential in [Some(token.clone()), Some(world.auth.service_token()), None] {
                let mut request = http()
                    .request(method.parse().expect("method"), world.server.url(&path))
                    .body("{}");
                if let Some(credential) = &credential {
                    request = request.header("authorization", format!("Bearer {credential}"));
                }
                let reply = send(request).await;
                assert_eq!(reply.status, 405, "{method} {path}: {}", reply.text());
                assert_eq!(reply.code(), "method_not_allowed", "{method} {path}");
                assert_no_store(&reply);
            }
        }
    }
    // Nothing changed.
    let history = world
        .get("/v1/letterheads/welld_it/versions", "u-admin")
        .await
        .json();
    assert_eq!(history.as_array().map(Vec::len), Some(1));
}

// ---------------------------------------------------------------------------------------------------------------
// The browser's other origin

#[tokio::test]
async fn read_cors_answers_the_shells_origin_on_the_person_routes_and_nobody_else() {
    let Some((world, _)) = with_content().await else {
        return;
    };
    let preflight = |origin: &str, path: &str| {
        send(
            http()
                .request(reqwest::Method::OPTIONS, world.server.url(path))
                .header("origin", origin)
                .header("access-control-request-method", "GET")
                .header("access-control-request-headers", "authorization"),
        )
    };

    let ok = preflight(ORIGIN, "/v1/letterheads").await;
    assert_eq!(ok.status, 204);
    assert_eq!(
        ok.header("access-control-allow-origin").as_deref(),
        Some(ORIGIN)
    );
    assert_eq!(
        ok.header("access-control-allow-methods").as_deref(),
        Some("GET, POST, OPTIONS"),
        "never PUT, PATCH or DELETE"
    );
    assert!(
        ok.header("access-control-allow-headers")
            .is_some_and(|h| h.contains("authorization"))
    );
    assert_eq!(ok.header("vary").as_deref(), Some("Origin"));
    // T48: the shell's `apiFetch` uses `credentials: 'include'`; a browser blocks the answer without this.
    assert_eq!(
        ok.header("access-control-allow-credentials").as_deref(),
        Some("true")
    );

    // Another origin gets no permission, and is told that the answer depends on the origin.
    let denied = preflight("http://evil.example", "/v1/letterheads").await;
    assert_eq!(denied.header("access-control-allow-origin"), None);
    assert_eq!(denied.header("access-control-allow-credentials"), None);
    assert_ne!(denied.status, 204);

    // A request from the allowed origin: the header is on the answer, the refusals included.
    let token = world.auth.token("u-access");
    let answered = send(
        http()
            .get(world.server.url("/v1/letterheads"))
            .header("origin", ORIGIN)
            .header("authorization", format!("Bearer {token}")),
    )
    .await;
    assert_eq!(answered.status, 200);
    assert_eq!(
        answered.header("access-control-allow-origin").as_deref(),
        Some(ORIGIN)
    );
    assert_eq!(
        answered
            .header("access-control-allow-credentials")
            .as_deref(),
        Some("true"),
        "on the actual response too, never with `*`"
    );
    assert_eq!(
        answered.header("access-control-expose-headers").as_deref(),
        Some("Retry-After")
    );
    let refused = send(
        http()
            .get(world.server.url("/v1/letterheads"))
            .header("origin", ORIGIN),
    )
    .await;
    assert_eq!(refused.status, 401);
    assert_eq!(
        refused.header("access-control-allow-origin").as_deref(),
        Some(ORIGIN)
    );
    let elsewhere = send(
        http()
            .get(world.server.url("/v1/letterheads"))
            .header("origin", "http://evil.example")
            .header("authorization", format!("Bearer {token}")),
    )
    .await;
    assert_eq!(elsewhere.header("access-control-allow-origin"), None);
    assert_eq!(elsewhere.header("access-control-allow-credentials"), None);
    assert_eq!(elsewhere.header("vary").as_deref(), Some("Origin"));

    // The service routes are for servers: no preflight is answered there.
    for path in [
        "/v1/render/pdf",
        "/v1/render/preview",
        "/v1/letterheads/status",
    ] {
        let reply = preflight(ORIGIN, path).await;
        assert_eq!(reply.header("access-control-allow-origin"), None, "{path}");
        assert_ne!(reply.status, 204, "{path}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Residue

#[tokio::test]
async fn read_nothing_of_a_person_or_a_token_reaches_the_log() {
    let Some((world, asset)) = with_content().await else {
        return;
    };
    let token = world.auth.token("u-admin");
    for path in person_paths(asset) {
        assert_eq!(
            get_with(&world.server, &path, Some(&token)).await.status,
            200
        );
    }
    // And the refusals and the outage, which are what an operator reads.
    let _ = get_with(&world.server, "/v1/letterheads", Some("not-a-jwt")).await;
    let _ = world.get("/v1/letterheads", "u-none").await;
    world.auth.resolve(Resolve::Status(500));
    let _ = get_with(
        &world.server,
        "/v1/letterheads",
        Some(&world.auth.token_at("u-ch", 77)),
    )
    .await;

    let (out, err) = world.server.stop();
    let everything: Vec<String> = out.into_iter().chain(err).collect();
    let text = everything.join("\n");
    for secret in [
        token.as_str(),
        NAME_MARKER,
        "u-admin@welld.example",
        "u-admin",
        "Footer one",
    ] {
        assert!(!text.contains(secret), "the log holds {secret:?}:\n{text}");
    }
    assert!(
        text.contains("authz: GET /authz/resolve failed (status 500)"),
        "the operator is told, in a closed word:\n{text}"
    );
}
