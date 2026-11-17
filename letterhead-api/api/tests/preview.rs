//! Integration tests of the configurator's preview (task T16; AC-8.4, AC-8.5, AC-5.8, AC-5.2, AC-7.4, AC-8.2,
//! AC-3.6, plan § Person routes, § Sequences "Configurator preview", amendment G6).
//!
//! Black-box tests of the real binary (`CARGO_BIN_EXE_letterhead-api`), as `write.rs` is: each test starts its own
//! supervisor on a free port against a schema of its own in `LETTERHEAD_TEST_DATABASE_URL` and the MinIO bucket of
//! `LETTERHEAD_TEST_S3_*` (see `render.rs` for the names and the defaults), with a fake `auth` in this process:
//! a JWKS, `GET /authz/resolve` from a table of people, and (T23, AC-5.4) the registry of the legal entities, whose
//! details the preview shows (`GET /system/legal-entities`, read once and kept for 30 s).
//!
//! **The fake transport.** The supervisor reaches four places, and only four: `auth` (its JWKS and
//! `/authz/resolve`), the database and the bucket, each named by an environment variable. The test gives it a
//! counting tap in front of the database and one in front of the bucket (a TCP relay that counts the bytes sent
//! towards them), and a fake `auth` that notes the path of every request. A preview of a configuration with no
//! assets must then move no byte towards the database or the bucket, and reach `auth` for `/authz/resolve` only
//! (AC-8.5). The same taps, on a preview of a configuration with an asset, are the positive control: they do count.
//!
//! Without the database variable the tests are skipped with a notice; `LETTERHEAD_REQUIRE_DB_TESTS=1` (set in CI)
//! turns anything missing, the database or the bucket, into a failure. Every test name starts with `preview_`.

#[path = "render_db.rs"]
mod db;

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::rsa::{KeyPair, KeySize, PublicKeyComponents};
use aws_lc_rs::signature::{KeyPair as _, RSA_PKCS1_SHA256};
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Executor;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use db::repo::Repo;
use db::types::{AssetKind, NewAsset};
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

/// The registry of the legal entities, as the fake `auth` serves it (`GET /system/legal-entities`): what it holds
/// can be changed, and it can be made to fail. The supervisor's cache reads it once and keeps it for 30 s, so a
/// test changes it before its first request.
struct RegistryStub {
    items: Vec<Value>,
    down: bool,
}

/// One entity as the registry answers it (the shape of `fixtures/legal-entities.json`).
fn registry_item(entity: &str, version: i64, name: &str) -> Value {
    let (it, en, vat, iban, contacts) = if entity == "welld_it" {
        (
            json!(["Via Roma 1", "20121 Milano"]),
            json!(["Via Roma 1", "20121 Milan"]),
            "IT01234567890",
            "IT60 X054 2811 1010 0000 0123 457",
            ("Tel. 02 000 0000", "Phone 02 000 0000"),
        )
    } else {
        (
            json!(["Via Cantonale 1", "6900 Lugano", "Svizzera"]),
            json!(["Via Cantonale 1", "6900 Lugano", "Switzerland"]),
            "CHE-123.456.789 IVA",
            "CH93 0076 2011 6238 5295 7",
            ("Tel. +41 91 000 00 00", "Phone +41 91 000 00 00"),
        )
    };
    json!({
        "entity": entity, "version": version, "updatedAt": "2026-11-17T09:00:00.000Z",
        "legalName": name,
        "address": { "it": it, "en": en },
        "vatNumber": vat, "iban": iban.replace(' ', ""), "ibanPrint": iban,
        "contacts": { "it": contacts.0, "en": contacts.1 },
        "complete": true, "missing": [], "invalid": [],
    })
}

impl RegistryStub {
    fn new() -> RegistryStub {
        RegistryStub {
            items: vec![
                registry_item("welld_it", 3, "Registry Italia S.r.l."),
                registry_item("welld_ch", 5, "Registry Svizzera SA"),
            ],
            down: false,
        }
    }
}

struct AuthState {
    people: Vec<Persona>,
    registry: Mutex<RegistryStub>,
    mode: Mutex<Resolve>,
    /// The `Authorization` header of every resolve call, in order.
    asked: Mutex<Vec<String>>,
    /// The path of every request that reached the fake `auth`, whatever it was for.
    seen: Mutex<Vec<String>>,
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
            registry: Mutex::new(RegistryStub::new()),
            mode: Mutex::new(Resolve::Normal),
            asked: Mutex::new(Vec::new()),
            seen: Mutex::new(Vec::new()),
        });
        let for_seen = Arc::clone(&state);
        let for_jwks = Arc::clone(&key);
        let for_resolve = Arc::clone(&state);
        let for_registry = Arc::clone(&state);
        let for_mint = Arc::clone(&key);
        let app = Router::new()
            // The one service render of these tests reads the registry as the service's own client (T22).
            .route(
                "/system/service-token",
                axum::routing::post(move || {
                    let key = Arc::clone(&for_mint);
                    async move {
                        let token = key.token(&json!({
                            "iss": ISSUER, "sub": "system:letterhead-api", "aud": SERVICE_AUDIENCE,
                            "scope": "legal-entities:read", "iat": now(), "exp": now() + 300,
                            "jti": Uuid::new_v4().to_string() }));
                        axum::Json(json!({ "token": token, "expiresInSeconds": 300 }))
                    }
                }),
            )
            .route(
                "/system/legal-entities",
                get(move || {
                    let state = Arc::clone(&for_registry);
                    async move {
                        let registry = state.registry.lock().expect("lock");
                        if registry.down {
                            return (StatusCode::SERVICE_UNAVAILABLE, String::new());
                        }
                        (
                            StatusCode::OK,
                            json!({ "items": registry.items }).to_string(),
                        )
                    }
                }),
            )
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
        let app = app.layer(axum::middleware::from_fn(
            move |request: axum::extract::Request, next: axum::middleware::Next| {
                let state = Arc::clone(&for_seen);
                async move {
                    state
                        .seen
                        .lock()
                        .expect("lock")
                        .push(request.uri().path().to_owned());
                    next.run(request).await
                }
            },
        ));
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

    /// Changes one member of one entity of the registry (`legalName`, `vatNumber`, `version`, ...).
    fn registry_set(&self, entity: &str, member: &str, value: Value) {
        let mut registry = self.state.registry.lock().expect("lock");
        let item = registry
            .items
            .iter_mut()
            .find(|i| i["entity"] == entity)
            .expect("an entity");
        item[member] = value;
    }

    /// The registry cannot be read, or can again.
    fn registry_down(&self, down: bool) {
        self.state.registry.lock().expect("lock").down = down;
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
// The taps

/// A TCP relay in front of one of the supervisor's destinations that counts the bytes sent towards it.
struct Tap {
    port: u16,
    sent: Arc<AtomicU64>,
}

impl Tap {
    async fn start(host: String, port: u16) -> Tap {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a tap");
        let local = listener.local_addr().expect("addr").port();
        let sent = Arc::new(AtomicU64::new(0));
        let counted = Arc::clone(&sent);
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let counted = Arc::clone(&counted);
                let host = host.clone();
                tokio::spawn(async move {
                    let Ok(upstream) = tokio::net::TcpStream::connect((host.as_str(), port)).await
                    else {
                        return;
                    };
                    let (mut from_client, mut to_client) = client.into_split();
                    let (mut from_upstream, mut to_upstream) = upstream.into_split();
                    let up = async {
                        let mut buffer = vec![0u8; 16 * 1024];
                        loop {
                            let n = from_client.read(&mut buffer).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            counted.fetch_add(n as u64, Ordering::SeqCst);
                            if to_upstream.write_all(&buffer[..n]).await.is_err() {
                                break;
                            }
                        }
                    };
                    let down = async {
                        let _ = tokio::io::copy(&mut from_upstream, &mut to_client).await;
                    };
                    tokio::select! { () = up => {}, () = down => {} }
                });
            }
        });
        Tap { port: local, sent }
    }

    /// Bytes sent towards the destination so far.
    fn sent(&self) -> u64 {
        self.sent.load(Ordering::SeqCst)
    }
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

/// The URL with its host and port replaced: the same destination, reached through a tap.
fn through(url: &str, tap: &Tap) -> String {
    let mut parsed = url::Url::parse(url).expect("a URL");
    parsed.set_host(Some("127.0.0.1")).expect("host");
    parsed.set_port(Some(tap.port)).expect("port");
    parsed.to_string()
}

/// Everything the supervisor needs to start, as environment variables, and nothing else. The database and the
/// bucket are reached through their taps.
fn server_env(
    fixture: &Fixture,
    auth: &FakeAuth,
    port: u16,
    taps: &Taps,
    extra: &[(&'static str, &str)],
) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("PORT", port.to_string()),
        ("DATABASE_URL", through(&fixture.schema_url, &taps.database)),
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
        (
            "LETTERHEAD_S3_ENDPOINT",
            through(&fixture.env.s3_endpoint, &taps.bucket),
        ),
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
        ("LETTERHEAD_S3_EU_ENDPOINT_HOSTS", "127.0.0.1".to_owned()),
        ("LH_WORKERS", "1".to_owned()),
        ("LH_QUEUE", "1".to_owned()),
    ];
    for (name, value) in extra {
        env.retain(|(n, _)| n != name);
        env.push((name, (*value).to_owned()));
    }
    env
}

impl Server {
    /// Starts the binary and waits until it answers `/health`.
    async fn start(
        fixture: &Fixture,
        auth: &FakeAuth,
        taps: &Taps,
        extra: &[(&'static str, &str)],
    ) -> Server {
        let port = free_port();
        let mut command = Command::new(env!("CARGO_BIN_EXE_letterhead-api"));
        command
            .env_clear()
            .envs(server_env(fixture, auth, port, taps, extra))
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

struct Taps {
    database: Tap,
    bucket: Tap,
}

/// A supervisor, a fake `auth`, a schema and a bucket; `None` when there is nothing to test on.
struct World {
    fixture: Fixture,
    auth: FakeAuth,
    taps: Taps,
    server: Server,
}

impl World {
    async fn start() -> Option<World> {
        World::start_with(&[]).await
    }

    async fn start_with(extra: &[(&'static str, &str)]) -> Option<World> {
        World::start_registry(extra, |_| {}).await
    }

    /// `setup` shapes the registry of the fake `auth` before the supervisor reads it for the first time.
    async fn start_registry(
        extra: &[(&'static str, &str)],
        setup: impl FnOnce(&FakeAuth),
    ) -> Option<World> {
        let fixture = Fixture::new().await?;
        let auth = FakeAuth::start().await;
        setup(&auth);
        let destination = |url: &str| {
            let parsed = url::Url::parse(url).expect("a URL");
            (
                parsed.host_str().expect("host").to_owned(),
                parsed.port_or_known_default().expect("port"),
            )
        };
        let (host, port) = destination(&fixture.schema_url);
        let database = Tap::start(host, port).await;
        let (host, port) = destination(&fixture.env.s3_endpoint);
        let bucket = Tap::start(host, port).await;
        let taps = Taps { database, bucket };
        let server = Server::start(&fixture, &auth, &taps, extra).await;
        Some(World {
            fixture,
            auth,
            taps,
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

    /// The pages of a preview answer.
    fn pages(&self) -> Vec<Value> {
        self.json()["pages"].as_array().expect("pages").clone()
    }

    /// The text of each page of a preview answer.
    fn texts(&self) -> Vec<String> {
        self.pages()
            .iter()
            .map(|p| p["text"].as_str().expect("text").to_owned())
            .collect()
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

fn preview_path(entity: &str) -> String {
    format!("/v1/letterheads/{entity}/preview")
}

/// A preview of `config` in `language`, as person `sub`.
async fn preview_as(
    world: &World,
    entity: &str,
    sub: &str,
    config: &Value,
    language: &str,
) -> Reply {
    post_json(
        world,
        &preview_path(entity),
        sub,
        &json!({ "config": config, "language": language }),
    )
    .await
}

/// The same with the other members of the body (`layoutVersion`, `pages`) and the query.
async fn preview_with(world: &World, path: &str, sub: &str, body: &Value) -> Reply {
    post_json(world, path, sub, body).await
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

/// The size of a base64 PNG, read from its header.
fn png_size(image: &str) -> (u32, u32) {
    let bytes = STANDARD.decode(image).expect("base64");
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "a PNG");
    let be = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().expect("4 bytes"));
    (be(16), be(20))
}

/// The count of the rows of the version table: a preview saves nothing.
async fn versions_stored(world: &World) -> i64 {
    let pool = sqlx::PgPool::connect(&world.fixture.schema_url)
        .await
        .expect("connect");
    let count = sqlx::query_scalar::<_, i64>("select count(*) from letterhead_version")
        .fetch_one(&pool)
        .await
        .expect("count");
    pool.close().await;
    count
}

async fn world() -> Option<World> {
    World::start().await
}

// ---------------------------------------------------------------------------------------------------------------
// The sample

/// What the sample says in each language: a word of each block type.
fn words(language: &str) -> [&'static str; 9] {
    match language {
        "it" => [
            "Documento di esempio",    // a heading of level 1
            "Titoli e paragrafi",      // a heading of level 2
            "Stili del testo",         // a heading of level 3
            "grassetto,",              // a paragraph's bold run
            "Primo punto dell'elenco", // a bulleted list
            "Primo passo numerato",    // a numbered list
            "Descrizione",             // a table's header row
            "Voce di esempio 01",      // a table's row
            "Figura: un'immagine",     // the caption under the image
        ],
        _ => [
            "Sample document",
            "Headings and paragraphs",
            "Text styles",
            "bold,",
            "First point of the list",
            "First numbered step",
            "Description",
            "Sample item 01",
            "Figure: a sample image",
        ],
    }
}

#[tokio::test]
async fn preview_the_sample_has_at_least_three_pages_and_every_block_type_in_the_page_texts() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    for language in ["it", "en"] {
        let reply = preview_as(&world, "welld_it", "u-access", &form, language).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        let count = reply.json()["pageCount"].as_u64().expect("a count");
        assert!(count >= 3, "{language}: {count} pages");
        let pages = reply.pages();
        assert_eq!(pages.len() as u64, count, "no `pages=`: every page");
        let texts = reply.texts();
        let all = texts.join("\n");
        let words = words(language);
        for word in words {
            assert!(all.contains(word), "{language}: `{word}` is on no page");
        }
        // A heading, a paragraph and the lists are on the first page; the table starts the second (a page
        // break before it) and the image is on the last (a page break before it).
        assert!(
            texts[0].contains(words[0])
                && texts[0].contains(words[3])
                && texts[0].contains(words[4])
        );
        assert!(texts[1].contains(words[6]) && texts[1].contains(words[7]));
        assert!(texts[count as usize - 1].contains(words[8]));
        // The table runs on to the next page with its header row repeated (AC-1.6).
        assert!(texts[2].contains(words[6]), "the header row is on page 3");
        for (i, page) in pages.iter().enumerate() {
            assert_eq!(page["n"], i + 1);
            assert_eq!(
                png_size(page["image"].as_str().expect("image")),
                (893, 1263)
            );
        }
    }
}

/// A form whose footer is `text`, in a margin that holds several lines (real details are longer than the sample's).
fn footer_form(text: &str) -> Value {
    let mut form = config(text, None);
    form["margins"]["bottom"] = json!(90);
    form
}

/// A form whose footer prints all five placeholders, so that a page's text shows what each was given.
fn issuer_form() -> Value {
    footer_form("{legal_name} | {address} | VAT {vat} | IBAN {iban} | {contacts}")
}

/// A page's text with every run of white space (a line break among them) as one space.
fn flat(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[tokio::test]
async fn preview_the_pages_hold_the_registrys_details_in_the_preview_language_and_the_samples_body()
{
    let Some(world) = world().await else { return };
    let form = issuer_form();
    for (entity, version, name, vat, iban) in [
        (
            "welld_it",
            3,
            "Registry Italia S.r.l.",
            "IT01234567890",
            "IT60 X054 2811 1010 0000 0123 457",
        ),
        (
            "welld_ch",
            5,
            "Registry Svizzera SA",
            "CHE-123.456.789 IVA",
            "CH93 0076 2011 6238 5295 7",
        ),
    ] {
        for language in ["it", "en"] {
            let reply = preview_as(&world, entity, "u-access", &form, language).await;
            assert_eq!(reply.status, 200, "{}", reply.text());
            let body = reply.json();
            assert_eq!(body["issuerDetails"], "current");
            assert_eq!(body["legalEntityVersion"], version, "{entity}");
            assert_eq!(
                body["missingPlaceholders"],
                json!([]),
                "{entity} {language}"
            );
            // A long line wraps where it likes, inside a value too: the text is read as running text.
            let texts: Vec<String> = reply.texts().iter().map(|t| flat(t)).collect();
            let (here, other, contacts) = match (entity, language) {
                ("welld_it", "it") => ("20121 Milano", "20121 Milan |", "Tel. 02 000 0000"),
                ("welld_it", _) => ("20121 Milan |", "20121 Milano", "Phone 02 000 0000"),
                (_, "it") => ("Svizzera", "Switzerland", "Tel. +41 91 000 00 00"),
                _ => ("Switzerland", "Lugano, Svizzera", "Phone +41 91 000 00 00"),
            };
            for (n, text) in texts.iter().enumerate() {
                for value in [name, vat, iban, here, contacts] {
                    assert!(
                        text.contains(value),
                        "{entity} {language}: page {} lacks `{value}`: {text}",
                        n + 1
                    );
                }
                // The address of the other language is not printed, and nothing of the old sample's company is, and the
                // intro no longer says the company's data are marked `(SAMPLE)` (FU-9).
                assert!(!text.contains(other), "{entity} {language}: `{other}`");
                assert!(
                    !text.contains("(SAMPLE)"),
                    "{entity} {language}: the old intro or marker"
                );
                for stale in [
                    "Esempio Italia",
                    "Via Esempio",
                    "Beispiel",
                    "example.invalid",
                    "\u{27E6}",
                ] {
                    assert!(!text.contains(stale), "{entity} {language}: `{stale}`");
                }
            }
            // The body of the sample is the sample's own text, as before.
            let all = texts.join("\n");
            for word in words(language) {
                assert!(all.contains(word), "{language}: `{word}` is on no page");
            }
        }
    }
}

#[tokio::test]
async fn preview_an_empty_value_is_its_label_between_marks_in_the_text_and_its_segment_is_kept() {
    let Some(world) = World::start_registry(&[], |auth| {
        for member in ["iban", "ibanPrint", "vatNumber"] {
            auth.registry_set("welld_it", member, json!(""));
        }
        auth.registry_set("welld_it", "contacts", json!({ "it": "", "en": "" }));
    })
    .await
    else {
        return;
    };
    // The segment in square brackets is dropped by a document when its value is empty, and kept here.
    let form = footer_form("{legal_name} [VAT {vat}] [IBAN {iban}] [{contacts}]");
    for (language, labels) in [
        ("it", ["Partita IVA", "IBAN", "Riga contatti"]),
        ("en", ["VAT number", "IBAN", "Contacts line"]),
    ] {
        let reply = preview_as(&world, "welld_it", "u-access", &form, language).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        let body = reply.json();
        // The details are the registry's: that they were read is current, and the empty ones are listed.
        assert_eq!(body["issuerDetails"], "current");
        assert_eq!(body["legalEntityVersion"], 3);
        assert_eq!(
            body["missingPlaceholders"],
            json!(["contacts", "iban", "vat"])
        );
        let [vat, iban, contacts] = labels;
        for (n, text) in reply.texts().iter().map(|t| flat(t)).enumerate() {
            assert!(text.contains("Registry Italia S.r.l."), "page {n}: {text}");
            assert!(
                text.contains(&format!("VAT \u{27E6}{vat}\u{27E7}"))
                    || text.contains(&format!("\u{27E6}{vat}\u{27E7}")),
                "{language} page {}: no mark for {vat}: {text}",
                n + 1
            );
            assert!(
                text.contains(&format!("IBAN \u{27E6}{iban}\u{27E7}")),
                "{language} page {}: {text}",
                n + 1
            );
            assert!(
                text.contains(&format!("\u{27E6}{contacts}\u{27E7}")),
                "{language} page {}: {text}",
                n + 1
            );
        }
    }
}

#[tokio::test]
async fn preview_a_registry_that_cannot_be_read_still_renders_with_every_placeholder_marked() {
    let Some(world) = World::start_registry(&[], |auth| auth.registry_down(true)).await else {
        return;
    };
    let form = issuer_form();
    let reply = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    // A preview is not a document (AC-5.5 is about documents): no 503, a page with every value missing.
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert!(reply.header("retry-after").is_none());
    assert_no_store(&reply);
    let body = reply.json();
    assert_eq!(body["issuerDetails"], "unavailable");
    assert_eq!(body["legalEntityVersion"], Value::Null);
    assert_eq!(body["letterheadVersion"], Value::Null);
    assert_eq!(
        body["missingPlaceholders"],
        json!(["address", "contacts", "iban", "legal_name", "vat"])
    );
    let texts = reply.texts();
    for (n, text) in texts.iter().enumerate() {
        for label in [
            "Legal name",
            "Address",
            "VAT number",
            "IBAN",
            "Contacts line",
        ] {
            assert!(
                text.contains(&format!("\u{27E6}{label}\u{27E7}")),
                "page {}: no mark for {label}: {text}",
                n + 1
            );
        }
        for stale in [
            "Registry",
            "Esempio Italia",
            "Via Esempio",
            "example.invalid",
        ] {
            assert!(!text.contains(stale), "`{stale}` on page {}", n + 1);
        }
    }
    // The body is the sample's, and the same in Italian.
    assert!(texts.join("\n").contains(words("en")[0]));
    let it = preview_as(&world, "welld_ch", "u-access", &form, "it").await;
    assert_eq!(it.status, 200, "{}", it.text());
    assert_eq!(it.json()["issuerDetails"], "unavailable");
    assert!(it.texts()[0].contains("\u{27E6}Ragione sociale\u{27E7}"));
    assert!(it.texts()[0].contains("\u{27E6}Riga contatti\u{27E7}"));
}

/// The mark is the configurator preview's alone: the same registry, the same form, saved, and a render of the
/// service never has `⟦` in its text, and the missing placeholder is listed as it always was (E3, AC-5.3).
#[tokio::test]
async fn preview_the_render_routes_never_mark_what_the_configurator_marks() {
    let Some(world) = World::start_registry(&[], |auth| {
        auth.registry_set("welld_it", "ibanPrint", json!(""));
        auth.registry_set("welld_it", "iban", json!(""));
    })
    .await
    else {
        return;
    };
    let form = footer_form("{legal_name} [IBAN {iban}]");
    let configurator = preview_as(&world, "welld_it", "u-access", &form, "it").await;
    assert_eq!(configurator.status, 200, "{}", configurator.text());
    assert!(configurator.texts()[0].contains("IBAN \u{27E6}IBAN\u{27E7}"));

    assert_eq!(
        save_as(&world, "welld_it", "u-admin", 0, &form)
            .await
            .status,
        201
    );
    let service = send(
        http()
            .post(world.server.url("/v1/render/preview"))
            .header(
                "authorization",
                format!("Bearer {}", world.auth.service_token()),
            )
            .header("content-type", "application/json")
            .body(
                json!({ "contentVersion": 2, "entity": "welld_it", "language": "it",
                        "blocks": [{ "type": "paragraph", "runs": [{ "text": "x" }] }] })
                .to_string(),
            ),
    )
    .await;
    assert_eq!(service.status, 200, "{}", service.text());
    assert_eq!(service.json()["missingPlaceholders"], json!(["iban"]));
    assert_eq!(service.json()["legalEntityVersion"], 3);
    for text in service.texts() {
        assert!(text.contains("Registry Italia S.r.l."), "{text}");
        assert!(
            !text.contains('\u{27E6}') && !text.contains('\u{27E7}'),
            "{text}"
        );
        assert!(!text.contains("IBAN"), "the segment is dropped: {text}");
    }
}

/// R9: real details are longer than the fit check's 40 characters; the preview shows it as a render would.
#[tokio::test]
async fn preview_a_legal_name_that_does_not_fit_its_frame_is_refused_at_the_frame() {
    let Some(world) = World::start_registry(&[], |auth| {
        auth.registry_set("welld_it", "legalName", json!("N".repeat(200)));
    })
    .await
    else {
        return;
    };
    let form = config("{legal_name}", None);
    let reply = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    assert_problem(&reply, 422, "invalid_letterhead");
    assert_eq!(
        problems(&reply),
        [(
            "/variants/default/footer".to_owned(),
            "footer_overflow".to_owned()
        )]
    );
    // The other entity's name is its own and fits.
    let other = preview_as(&world, "welld_ch", "u-access", &form, "en").await;
    assert_eq!(other.status, 200, "{}", other.text());
}

#[tokio::test]
async fn preview_the_answer_has_the_render_previews_shape_with_a_null_letterhead_version() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    let reply = preview_as(&world, "welld_it", "u-access", &form, "it").await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("application/json")
    );
    assert_no_store(&reply);
    let body = reply.json();
    // The member is always there, and `null`: the configuration has no version, it may not be saved.
    assert_eq!(body["letterheadVersion"], Value::Null);
    let mut keys: Vec<&str> = body
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();

    // The service's render preview, on a saved version of the same configuration, has the same members, with
    // the number of the version.
    assert_eq!(
        save_as(&world, "welld_it", "u-admin", 0, &form)
            .await
            .status,
        201
    );
    let service = send(
        http()
            .post(world.server.url("/v1/render/preview"))
            .header(
                "authorization",
                format!("Bearer {}", world.auth.service_token()),
            )
            .header("content-type", "application/json")
            .body(
                json!({ "contentVersion": 1, "entity": "welld_it", "language": "it",
                        "blocks": [{ "type": "paragraph", "runs": [{ "text": "x" }] }] })
                .to_string(),
            ),
    )
    .await;
    assert_eq!(service.status, 200, "{}", service.text());
    let service = service.json();
    let mut service_keys: Vec<&str> = service
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    service_keys.sort_unstable();
    // The configurator's preview has the render preview's members, `legalEntityVersion` among them (the version of
    // the issuer's details it shows: the service's render printed the same ones), and one of its own: whether
    // those details are the registry's current ones (T23).
    assert_eq!(body["issuerDetails"], "current");
    assert_eq!(body["legalEntityVersion"], 3);
    assert_eq!(service["legalEntityVersion"], body["legalEntityVersion"]);
    assert!(keys.contains(&"issuerDetails"));
    keys.retain(|key| *key != "issuerDetails");
    assert_eq!(keys, service_keys);
    assert_eq!(service["letterheadVersion"], 1);
    let mut page_keys: Vec<&str> = body["pages"][0]
        .as_object()
        .expect("a page")
        .keys()
        .map(String::as_str)
        .collect();
    page_keys.sort_unstable();
    assert_eq!(page_keys, ["image", "n", "text"]);
}

#[tokio::test]
async fn preview_the_same_form_gives_the_same_pages_and_saves_nothing() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    let first = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    let second = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    assert_eq!(first.status, 200, "{}", first.text());
    assert_eq!(
        first.body, second.body,
        "AC-1.4: the same form, the same pages"
    );
    // The form was never saved: no version, nothing active.
    assert_eq!(versions_stored(&world).await, 0);
    assert!(
        world
            .fixture
            .repo
            .active_version(Entity::WelldIt)
            .await
            .expect("read")
            .is_none()
    );
    let list = world.get("/v1/letterheads", "u-access").await.json();
    assert_eq!(list["welld_it"]["activeVersion"], Value::Null);
}

// ---------------------------------------------------------------------------------------------------------------
// The language (AC-5.8)

#[tokio::test]
async fn preview_the_language_picks_the_texts_of_the_header_and_footer_and_of_the_sample() {
    let Some(world) = world().await else { return };
    let mut form = config("x", None);
    form["variants"]["default"]["footer"]["left"][0]["text"] =
        json!({ "it": "Piede italiano ZED", "en": "English foot ZED" });
    let it = preview_as(&world, "welld_it", "u-access", &form, "it").await;
    let en = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    assert_eq!(
        (it.status, en.status),
        (200, 200),
        "{} {}",
        it.text(),
        en.text()
    );
    for text in it.texts() {
        assert!(text.contains("Piede italiano ZED") && !text.contains("English foot ZED"));
    }
    for text in en.texts() {
        assert!(text.contains("English foot ZED") && !text.contains("Piede italiano ZED"));
    }
    assert!(it.texts().join(" ").contains("Documento di esempio"));
    assert!(en.texts().join(" ").contains("Sample document"));
    // Both languages are drawn from the same configuration: nothing else differs in the count of pages.
    assert_eq!(it.json()["pageCount"], en.json()["pageCount"]);

    let other = preview_as(&world, "welld_it", "u-access", &form, "fr").await;
    assert_problem(&other, 422, "unsupported_language");
}

// ---------------------------------------------------------------------------------------------------------------
// Pages

#[tokio::test]
async fn preview_pages_in_the_query_or_in_the_body_pick_the_pages() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    let path = preview_path("welld_it");

    let all = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    let count = all.json()["pageCount"].as_u64().expect("count");

    // `?pages=`: the page count is the document's, the pages are the ones asked for.
    let body = json!({ "config": form, "language": "en" });
    let by_query = preview_with(&world, &format!("{path}?pages=2"), "u-access", &body).await;
    assert_eq!(by_query.status, 200, "{}", by_query.text());
    assert_eq!(by_query.json()["pageCount"].as_u64(), Some(count));
    assert_eq!(by_query.pages().len(), 1);
    assert_eq!(by_query.pages()[0], all.pages()[1], "page 2 is page 2");

    // `"pages": [..]` in the body: the same rules, ascending and each once.
    let body = json!({ "config": form, "language": "en", "pages": [3, 1, 3] });
    let by_body = preview_with(&world, &path, "u-access", &body).await;
    assert_eq!(by_body.status, 200, "{}", by_body.text());
    let numbers: Vec<u64> = by_body
        .pages()
        .iter()
        .map(|p| p["n"].as_u64().expect("n"))
        .collect();
    assert_eq!(numbers, [1, 3]);
    assert_eq!(by_body.pages()[0], all.pages()[0]);

    // Refused: both at once, page 0, a page past the end, a page past the limit, not a list.
    let both = preview_with(&world, &format!("{path}?pages=1"), "u-access", &body).await;
    assert_problem(&both, 422, "invalid_pages");
    for query in [
        "pages=0",
        "pages=x",
        "pages=301",
        "pages=1&pages=2",
        "pages=",
    ] {
        let plain = json!({ "config": form, "language": "en" });
        let reply = preview_with(&world, &format!("{path}?{query}"), "u-access", &plain).await;
        assert_problem(&reply, 422, "invalid_pages");
    }
    let past = preview_with(
        &world,
        &format!("{path}?pages={}", count + 1),
        "u-access",
        &json!({ "config": form, "language": "en" }),
    )
    .await;
    assert_problem(&past, 422, "invalid_pages");
    for bad in [json!([]), json!([0]), json!("1"), json!([1.5]), json!(null)] {
        let reply = preview_with(
            &world,
            &path,
            "u-access",
            &json!({ "config": form, "language": "en", "pages": bad }),
        )
        .await;
        assert_problem(&reply, 422, "invalid_pages");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The layout (G6)

#[tokio::test]
async fn preview_honours_the_layout_version_and_never_draws_with_another() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    let path = preview_path("welld_it");
    let current = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    assert_eq!(current.status, 200, "{}", current.text());

    // Layout 1 is the layout of this binary: named or not, the same pages.
    let named = preview_with(
        &world,
        &path,
        "u-access",
        &json!({ "config": form, "language": "en", "layoutVersion": 1 }),
    )
    .await;
    assert_eq!(named.status, 200, "{}", named.text());
    assert_eq!(named.body, current.body);

    // Opening version n sends n's `layoutVersion`: a saved version, read back, previews as sent.
    assert_eq!(
        save_as(&world, "welld_it", "u-admin", 0, &form)
            .await
            .status,
        201
    );
    let stored = world
        .get("/v1/letterheads/welld_it/versions/1", "u-access")
        .await
        .json();
    let reopened = preview_with(
        &world,
        &path,
        "u-access",
        &json!({ "config": stored["config"], "language": "en", "layoutVersion": stored["layoutVersion"] }),
    )
    .await;
    assert_eq!(reopened.status, 200, "{}", reopened.text());
    assert_eq!(reopened.body, current.body);

    // A layout this binary lacks (a version saved by a newer one) is refused, not drawn with the current one.
    for lacking in [900, 999_999] {
        let reply = preview_with(
            &world,
            &path,
            "u-access",
            &json!({ "config": form, "language": "en", "layoutVersion": lacking }),
        )
        .await;
        assert_problem(&reply, 422, "unknown_layout");
    }
    // Not a layout number at all.
    for not_a_number in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!("1"),
        json!(null),
        json!(true),
    ] {
        let reply = preview_with(
            &world,
            &path,
            "u-access",
            &json!({ "config": form, "language": "en", "layoutVersion": not_a_number }),
        )
        .await;
        assert_problem(&reply, 422, "invalid_request");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The save rules

#[tokio::test]
async fn preview_refuses_what_a_save_refuses_with_the_same_problems() {
    let Some(world) = world().await else { return };
    let ok = config("Footer", None);

    let mut margin = ok.clone();
    margin["margins"]["left"] = json!(2);
    let mut brace = ok.clone();
    brace["variants"]["default"]["footer"]["left"][0]["text"] =
        json!({ "it": "{legal_name", "en": "x" });
    let mut unknown = ok.clone();
    unknown["variants"]["default"]["footer"]["left"][0]["text"] =
        json!({ "it": "{nothing}", "en": "x" });
    let mut font = ok.clone();
    font["fonts"]["body"] = json!("Comic Sans");
    // The fit of the frames (AC-5.2): a footer taller than a 10 mm margin leaves.
    let mut tight = ok.clone();
    tight["margins"]["bottom"] = json!(10);
    // Several at once.
    let mut several = margin.clone();
    several["margins"]["top"] = json!(500);
    several["variants"]["default"]["footer"]["left"][0]["text"] =
        json!({ "it": "{legal_name", "en": "x" });

    for (name, bad) in [
        ("margin", margin),
        ("brace", brace),
        ("unknown placeholder", unknown),
        ("font", font),
        ("fit", tight),
        ("several", several),
        ("not an object", json!([1, 2])),
        ("null", Value::Null),
        ("empty", json!({})),
    ] {
        let saved = save_as(&world, "welld_it", "u-admin", 0, &bad).await;
        assert_problem(&saved, 422, "invalid_letterhead");
        let previewed = preview_as(&world, "welld_it", "u-access", &bad, "en").await;
        assert_problem(&previewed, 422, "invalid_letterhead");
        assert!(!problems(&previewed).is_empty(), "{name}");
        assert_eq!(
            previewed.json()["problems"],
            saved.json()["problems"],
            "{name}: the problems of a preview are the problems of a save"
        );
    }
    assert_eq!(
        versions_stored(&world).await,
        0,
        "a refused save kept nothing"
    );

    // And what a save takes, a preview draws.
    assert_eq!(
        save_as(&world, "welld_it", "u-admin", 0, &ok).await.status,
        201
    );
    assert_eq!(
        preview_as(&world, "welld_it", "u-access", &ok, "en")
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn preview_a_footer_that_does_not_fit_is_refused_at_the_frame_in_the_form_not_drawn_over_the_body()
 {
    let Some(world) = world().await else { return };
    let mut tight = config("Footer", None);
    tight["margins"]["bottom"] = json!(10);
    let reply = preview_as(&world, "welld_it", "u-access", &tight, "en").await;
    assert_problem(&reply, 422, "invalid_letterhead");
    assert_eq!(
        problems(&reply),
        [(
            "/variants/default/footer".to_owned(),
            "footer_overflow".to_owned()
        )]
    );
    // The same frame in a margin that holds it.
    let mut roomy = tight.clone();
    roomy["margins"]["bottom"] = json!(34);
    assert_eq!(
        preview_as(&world, "welld_it", "u-access", &roomy, "en")
            .await
            .status,
        200
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The assets (AC-7.4)

#[tokio::test]
async fn preview_draws_an_uploaded_asset_that_is_not_saved_yet_and_refuses_another_entitys_or_kinds()
 {
    let Some(world) = world().await else { return };
    let f = &world.fixture;
    let logo = f
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    let band = f
        .asset(Entity::WelldIt, AssetKind::Background, Format::Png, &PNG)
        .await;
    let foreign = f
        .asset(Entity::WelldCh, AssetKind::Logo, Format::Png, &PNG)
        .await;

    // Uploaded, in no version: it is the entity's asset all the same.
    let plain = preview_as(
        &world,
        "welld_it",
        "u-access",
        &config("Footer", None),
        "en",
    )
    .await;
    let with_logo = preview_as(
        &world,
        "welld_it",
        "u-access",
        &config("Footer", Some(logo)),
        "en",
    )
    .await;
    assert_eq!(with_logo.status, 200, "{}", with_logo.text());
    assert_ne!(
        with_logo.pages()[0]["image"],
        plain.pages()[0]["image"],
        "the logo is drawn on the first page"
    );
    assert_eq!(versions_stored(&world).await, 0);

    // The same asset as a background.
    let mut with_band = config("Footer", None);
    with_band["variants"]["default"]["background"] = json!(band.to_string());
    let reply = preview_as(&world, "welld_it", "u-access", &with_band, "en").await;
    assert_eq!(reply.status, 200, "{}", reply.text());

    let slot = "/variants/default/logo/asset";
    let unknown = |reply: &Reply, path: &str| {
        assert_problem(reply, 422, "invalid_letterhead");
        assert_eq!(
            problems(reply),
            [(path.to_owned(), "asset_unknown".to_owned())]
        );
        // The path names the slot, never the id.
        assert!(!reply.text().contains(&logo.to_string()));
    };
    // An id that is no asset at all.
    let nobody = Uuid::new_v4();
    let reply = preview_as(
        &world,
        "welld_it",
        "u-access",
        &config("Footer", Some(nobody)),
        "en",
    )
    .await;
    unknown(&reply, slot);
    // The other entity's asset.
    let reply = preview_as(
        &world,
        "welld_it",
        "u-access",
        &config("Footer", Some(foreign)),
        "en",
    )
    .await;
    unknown(&reply, slot);
    // A background in a logo's slot, and a logo in the background's.
    let reply = preview_as(
        &world,
        "welld_it",
        "u-access",
        &config("Footer", Some(band)),
        "en",
    )
    .await;
    unknown(&reply, slot);
    let mut swapped = config("Footer", None);
    swapped["variants"]["default"]["background"] = json!(logo.to_string());
    let reply = preview_as(&world, "welld_it", "u-access", &swapped, "en").await;
    unknown(&reply, "/variants/default/background");
    // The same ones, as a save sees them.
    let saved = save_as(
        &world,
        "welld_it",
        "u-admin",
        0,
        &config("Footer", Some(foreign)),
    )
    .await;
    assert_eq!(
        problems(&saved),
        [(slot.to_owned(), "asset_unknown".to_owned())]
    );
}

#[tokio::test]
async fn preview_an_asset_whose_object_is_gone_is_a_fault_of_the_service_not_a_refusal_of_the_form()
{
    let Some(world) = world().await else { return };
    let f = &world.fixture;
    let logo = f
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    f.bucket.delete(logo).await;
    let reply = preview_as(
        &world,
        "welld_it",
        "u-access",
        &config("Footer", Some(logo)),
        "en",
    )
    .await;
    assert_problem(&reply, 500, "asset_unavailable");
}

// ---------------------------------------------------------------------------------------------------------------
// No outbound call but auth (AC-8.5)

#[tokio::test]
async fn preview_makes_no_outbound_call_but_the_one_to_auth() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    // Warm up: the JWKS is fetched, the person's permissions are cached by the first request, and the registry's
    // details are read once (they are kept for 30 s, for both entities).
    let warm = world.get("/v1/catalog", "u-access").await;
    assert_eq!(warm.status, 200, "{}", warm.text());
    let warm = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    assert_eq!(warm.status, 200, "{}", warm.text());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (database, bucket) = (world.taps.database.sent(), world.taps.bucket.sent());
    world.auth.state.seen.lock().expect("lock").clear();

    // A cached person: the preview reaches no one.
    let reply = preview_as(&world, "welld_it", "u-access", &form, "en").await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert!(reply.json()["pageCount"].as_u64().expect("count") >= 3);
    assert_eq!(
        world.auth.state.seen.lock().expect("lock").clone(),
        Vec::<String>::new(),
        "the permissions were cached: not even `auth` is asked"
    );

    // A person whose permissions are not cached (a new epoch): `auth` is asked, once, for `/authz/resolve`,
    // and for nothing else.
    let fresh = world.auth.token_at("u-access", 7);
    let reply = post_raw(
        &world,
        &preview_path("welld_ch"),
        Some(&fresh),
        Some("application/json"),
        json!({ "config": form, "language": "it" })
            .to_string()
            .into_bytes(),
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(
        world.auth.state.seen.lock().expect("lock").clone(),
        ["/authz/resolve"],
        "the one call is the one to auth"
    );

    // Nothing went to the service's own database or bucket either: a form with no asset needs neither.
    assert_eq!(
        world.taps.database.sent(),
        database,
        "no byte to the database"
    );
    assert_eq!(world.taps.bucket.sent(), bucket, "no byte to the bucket");

    // The control: the taps do count. A form with an asset reads the database and the bucket.
    let logo = world
        .fixture
        .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
        .await;
    let (database, bucket) = (world.taps.database.sent(), world.taps.bucket.sent());
    let reply = preview_as(
        &world,
        "welld_it",
        "u-access",
        &config("Footer", Some(logo)),
        "en",
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert!(
        world.taps.database.sent() > database,
        "the tap on the database counts"
    );
    assert!(
        world.taps.bucket.sent() > bucket,
        "the tap on the bucket counts"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Who

#[tokio::test]
async fn preview_needs_access_and_nothing_more_and_both_entities_are_open_to_it() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    let body = json!({ "config": form, "language": "en" });
    let pages = |entity: &str| format!("{}?pages=1", preview_path(entity));

    // A holder of access only (no manage), a manager of one entity, an administrator: every one previews both.
    for sub in ["u-access", "u-it", "u-ch", "u-admin"] {
        for entity in ["welld_it", "welld_ch"] {
            let reply = preview_with(&world, &pages(entity), sub, &body).await;
            assert_eq!(reply.status, 200, "{sub} {entity}: {}", reply.text());
            assert_no_store(&reply);
        }
    }
    // Without the tool's permission, 403 `forbidden` before anything of the request is read: not the entity,
    // not the body.
    for sub in ["u-none", "u-manage-only"] {
        let reply = preview_with(&world, &pages("welld_it"), sub, &body).await;
        assert_problem(&reply, 403, "forbidden");
        let reply = preview_with(&world, &pages("nowhere"), sub, &body).await;
        assert_problem(&reply, 403, "forbidden");
        let reply = post_raw(
            &world,
            &preview_path("welld_it"),
            Some(&world.auth.token(sub)),
            Some("application/json"),
            b"not json".to_vec(),
        )
        .await;
        assert_problem(&reply, 403, "forbidden");
    }
    // Then the entity, as every route has it.
    let reply = preview_with(&world, &pages("nowhere"), "u-access", &body).await;
    assert_problem(&reply, 422, "unknown_entity");
    let reply = preview_with(&world, "/v1/letterheads/%FF/preview", "u-access", &body).await;
    assert_problem(&reply, 422, "unknown_entity");

    // No credential, a service credential, a person's token for another audience: the one 401.
    let anonymous = post_raw(
        &world,
        &preview_path("welld_it"),
        None,
        Some("application/json"),
        body.to_string().into_bytes(),
    )
    .await;
    assert_eq!(anonymous.status, 401);
    assert_no_store(&anonymous);
    let service = post_raw(
        &world,
        &preview_path("welld_it"),
        Some(&world.auth.service_token()),
        Some("application/json"),
        body.to_string().into_bytes(),
    )
    .await;
    assert_eq!(service.status, 401, "{}", service.text());
    let wrong_audience = world
        .auth
        .token_with("u-access", |c| c["aud"] = json!("someone-else"));
    let reply = post_raw(
        &world,
        &preview_path("welld_it"),
        Some(&wrong_audience),
        Some("application/json"),
        body.to_string().into_bytes(),
    )
    .await;
    assert_eq!(reply.status, 401);

    // The route answers POST only.
    for method in [
        reqwest::Method::GET,
        reqwest::Method::PUT,
        reqwest::Method::PATCH,
        reqwest::Method::DELETE,
    ] {
        let reply = send(
            http()
                .request(method.clone(), world.server.url(&preview_path("welld_it")))
                .header(
                    "authorization",
                    format!("Bearer {}", world.auth.token("u-access")),
                ),
        )
        .await;
        assert_eq!(reply.status, 405, "{method}");
        assert_no_store(&reply);
    }
}

#[tokio::test]
async fn preview_an_auth_that_cannot_answer_is_a_refusal_and_renders_nothing() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    for mode in [Resolve::Status(503), Resolve::Status(500), Resolve::Garbage] {
        world.auth.resolve(mode);
        // A person whose permissions are not cached (a new epoch): `auth` is asked, and cannot answer.
        let token = world.auth.token_at("u-access", 99);
        let reply = post_raw(
            &world,
            &preview_path("welld_it"),
            Some(&token),
            Some("application/json"),
            json!({ "config": form, "language": "en" })
                .to_string()
                .into_bytes(),
        )
        .await;
        assert_problem(&reply, 503, "authz_unavailable");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The request

#[tokio::test]
async fn preview_a_request_that_is_not_the_shape_is_invalid_request_and_a_big_body_is_413() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    let path = preview_path("welld_it");
    let invalid = |reply: &Reply| assert_problem(reply, 422, "invalid_request");
    for body in [
        json!({ "language": "en" }),
        json!({ "config": form }),
        json!({ "config": form, "language": 1 }),
        json!({ "config": form, "language": null }),
        json!({ "config": form, "language": "en", "baseVersion": 1 }),
        json!([form]),
        json!("text"),
        Value::Null,
    ] {
        invalid(&preview_with(&world, &path, "u-access", &body).await);
    }
    let token = world.auth.token("u-access");
    for raw in [&b"not json"[..], b"", b"{"] {
        let reply = post_raw(
            &world,
            &path,
            Some(&token),
            Some("application/json"),
            raw.to_vec(),
        )
        .await;
        invalid(&reply);
    }
    let big = vec![b' '; 1024 * 1024 + 1];
    let reply = post_raw(&world, &path, Some(&token), Some("application/json"), big).await;
    assert_problem(&reply, 413, "request_too_large");
}

#[tokio::test]
async fn preview_nothing_of_a_configuration_or_a_person_is_echoed_or_logged() {
    let Some(world) = world().await else { return };
    let marker = "ZQX-footer-text-4b7";
    let token = world
        .auth
        .token_with("u-access", |c| c["name"] = json!(NAME_MARKER));
    let post = |form: Value| {
        let token = token.clone();
        let world = &world;
        async move {
            post_raw(
                world,
                &preview_path("welld_it"),
                Some(&token),
                Some("application/json"),
                json!({ "config": form, "language": "en" })
                    .to_string()
                    .into_bytes(),
            )
            .await
        }
    };
    // A refused form that holds the marker in the text that is refused, and in a member that is not allowed.
    let mut bad = config(&format!("{marker}{{"), None);
    bad["margins"][marker] = json!(1);
    let refused = post(bad).await;
    assert_problem(&refused, 422, "invalid_letterhead");
    assert!(!refused.text().contains(marker), "{}", refused.text());
    // A form that is drawn: the marker is in the page, and only there.
    let drawn = post(config(marker, None)).await;
    assert_eq!(drawn.status, 200, "{}", drawn.text());
    assert!(drawn.texts()[0].contains(marker));
    let World { server, .. } = world;
    let (out, err) = server.stop();
    let logs = [out, err].concat().join("\n");
    for text in [marker, NAME_MARKER, "u-access@welld.example"] {
        assert!(!logs.contains(text), "`{text}` is in the log: {logs}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The pool

#[tokio::test]
async fn preview_goes_through_the_pool_and_a_full_pool_is_429_busy_with_retry_after() {
    let Some(world) = world().await else { return };
    let form = config("Footer", None);
    // One worker, one place in the queue: of several previews at once, some are turned away.
    let path = format!("{}?pages=1", preview_path("welld_it"));
    let token = world.auth.token("u-access");
    let body = json!({ "config": form, "language": "en" }).to_string();
    let mut calls = Vec::new();
    for _ in 0..8 {
        let request = http()
            .post(world.server.url(&path))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(body.clone());
        calls.push(tokio::spawn(send(request)));
    }
    let mut ok = 0;
    let mut busy = 0;
    for call in calls {
        let reply = call.await.expect("joined");
        match reply.status {
            200 => ok += 1,
            429 => {
                assert_problem(&reply, 429, "busy");
                assert!(
                    reply.header("retry-after").is_some(),
                    "Retry-After says when"
                );
                busy += 1;
            }
            other => panic!("{other}: {}", reply.text()),
        }
    }
    assert!(ok >= 1, "at least one preview was drawn");
    assert_eq!(ok + busy, 8);
}
