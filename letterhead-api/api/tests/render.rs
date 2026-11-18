//! Integration tests of the service routes (task T12; AC-1.1, 1.2, 3.1 to 3.3, 3.6, 3.8, 4.4, 9.1, 9.3).
//!
//! These are black-box tests of the real binary (`CARGO_BIN_EXE_letterhead-api`): each test starts its own
//! supervisor, with its own workers, on a free port, and talks to it over HTTP. Around it:
//!
//! - **Postgres**: `LETTERHEAD_TEST_DATABASE_URL`. Each test makes a schema of its own in it (so tests do not see
//!   each other) and the supervisor connects with that schema as its `search_path`. Schemas are never dropped:
//!   rows of these tables cannot be deleted, by design; the cleanup is dropping the test database.
//!   Versions and assets are made through the repository of T10 (`src/db/repo.rs`, compiled into this test).
//! - **The bucket**: MinIO at `LETTERHEAD_TEST_S3_ENDPOINT` (default `http://localhost:9000`, keys
//!   `LETTERHEAD_TEST_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`, default `minioadmin`), in the bucket
//!   `LETTERHEAD_TEST_S3_BUCKET`, which these tests create. Default: the name of the test database with `_` as
//!   `-` (database `letterhead_lh_t12` -> bucket `letterhead-lh-t12`), so two databases never share a bucket.
//! - **`auth`**: a fake one, in this process: a JWKS of a key generated here, and a client-credentials endpoint
//!   with a list of clients, as the real one has. The supervisor is told only its address (AC-9.3).
//!
//! Without the database variable the tests are skipped with a notice; `LETTERHEAD_REQUIRE_DB_TESTS=1` (set in CI)
//! turns anything missing, the database or the bucket, into a failure.

#[path = "render_db.rs"]
mod db;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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

/// A string that must never come back from the service: it is put in every place a request can hold text.
const MARKER: &str = "ZQX-marker-4711";

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
            "{URL_VAR} is not set and {REQUIRE_VAR}=1: the render tests may not be skipped"
        );
        eprintln!("SKIPPED: set {URL_VAR} to run the render tests");
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
                    "the bucket {} is not reachable at {} and {REQUIRE_VAR}=1: the render tests may not be skipped",
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
    let schema = format!("lh_r_{}", Uuid::new_v4().simple());
    let admin = sqlx::PgPool::connect(database_url)
        .await
        .expect("connect to the test database");
    // `lh_r_` and 32 hex digits, made here: nothing a person typed reaches the statement.
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

    /// The next version of an entity, through the repository (AC-4.1).
    async fn save(&self, entity: Entity, config: Value, assets: &[Uuid]) -> i32 {
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
                actor_sub: "test".into(),
                actor_name: "Test Person".into(),
                changed_settings: vec!["margins".into()],
            })
            .await
            .expect("save a version")
    }
}

/// The starting configuration, with a footer text of its own that shows in the page text, and a logo if given.
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

struct Client {
    id: &'static str,
    secret: &'static str,
    scopes: &'static [&'static str],
}

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
            pair: KeyPair::generate(KeySize::Rsa2048).expect("a test RSA key"),
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

/// The claims of a service token as `auth` mints them (`serviceToken.routes.ts`).
fn service_claims(sub: &str, scope: &str) -> Value {
    json!({ "iss": ISSUER, "sub": sub, "aud": SERVICE_AUDIENCE, "scope": scope,
            "iat": now(), "exp": now() + 300, "jti": Uuid::new_v4().to_string() })
}

/// The secret of this service's own client at the fake `auth` (the registry is read with it).
const SERVICE_CLIENT_SECRET: &str = "test-client-secret-0123456789abcdefgh";

/// The registry of the legal entities, as the fake `auth` serves it: `GET /system/legal-entities` for a service
/// token that holds `legal-entities:read`. What it holds can be changed, and it can be made to fail.
struct RegistryStub {
    items: Mutex<Vec<Value>>,
    down: AtomicBool,
    /// How many times the registry was read (the token exchange is not counted).
    reads: AtomicUsize,
    /// How many tokens were minted for this service's own client.
    exchanges: AtomicUsize,
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

fn registry_items() -> Vec<Value> {
    vec![
        registry_item("welld_it", 3, "Registry Italia S.r.l."),
        registry_item("welld_ch", 5, "Registry Svizzera SA"),
    ]
}

impl RegistryStub {
    fn new() -> RegistryStub {
        RegistryStub {
            items: Mutex::new(registry_items()),
            down: AtomicBool::new(false),
            reads: AtomicUsize::new(0),
            exchanges: AtomicUsize::new(0),
        }
    }

    /// Changes one member of one entity (`legalName`, `vatNumber`, `version`, ...).
    fn set(&self, entity: &str, member: &str, value: Value) {
        let mut items = self.items.lock().expect("lock");
        let item = items
            .iter_mut()
            .find(|i| i["entity"] == entity)
            .expect("an entity");
        item[member] = value;
    }

    fn down(&self, down: bool) {
        self.down.store(down, Ordering::SeqCst);
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }
}

/// The scope claim of a bearer, read without checking it (the stub trusts what it is sent).
fn scope_of(bearer: &str) -> String {
    bearer
        .strip_prefix("Bearer ")
        .and_then(|token| token.split('.').nth(1))
        .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|claims| claims["scope"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

struct FakeAuth {
    jwks_url: String,
    base: String,
    key: Arc<TestKey>,
    registry: Arc<RegistryStub>,
}

impl FakeAuth {
    /// `GET /auth/jwks` and `POST /system/service-token` for the given clients, on a free port.
    async fn start(clients: Vec<Client>) -> FakeAuth {
        use axum::{Router, routing::get, routing::post};
        let key = Arc::new(TestKey::generate());
        let clients = Arc::new(clients);
        let (for_jwks, for_token, for_clients) = (Arc::clone(&key), Arc::clone(&key), clients);
        let registry = Arc::new(RegistryStub::new());
        let (for_registry, for_exchange) = (Arc::clone(&registry), Arc::clone(&registry));
        let app = Router::new()
            .route(
                "/system/legal-entities",
                get(move |headers: axum::http::HeaderMap| {
                    let registry = Arc::clone(&for_registry);
                    async move {
                        let bearer = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default();
                        if !scope_of(bearer)
                            .split(' ')
                            .any(|scope| scope == "legal-entities:read")
                        {
                            return (axum::http::StatusCode::FORBIDDEN, String::new());
                        }
                        registry.reads.fetch_add(1, Ordering::SeqCst);
                        if registry.down.load(Ordering::SeqCst) {
                            return (axum::http::StatusCode::SERVICE_UNAVAILABLE, String::new());
                        }
                        let items = registry.items.lock().expect("lock").clone();
                        (
                            axum::http::StatusCode::OK,
                            json!({ "items": items }).to_string(),
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
                "/system/service-token",
                post(move |body: axum::body::Bytes| {
                    let (key, clients) = (Arc::clone(&for_token), Arc::clone(&for_clients));
                    let registry = Arc::clone(&for_exchange);
                    async move {
                        let asked: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let found = clients.iter().find(|c| {
                            asked["clientId"] == c.id && asked["clientSecret"] == c.secret
                        });
                        match found {
                            None => (axum::http::StatusCode::UNAUTHORIZED, String::new()),
                            Some(client) => {
                                if client.id == "letterhead-api" {
                                    registry.exchanges.fetch_add(1, Ordering::SeqCst);
                                }
                                let claims = service_claims(
                                    &format!("system:{}", client.id),
                                    &client.scopes.join(" "),
                                );
                                (
                                    axum::http::StatusCode::OK,
                                    json!({ "token": key.token(&claims), "expiresInSeconds": 300 })
                                        .to_string(),
                                )
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
            registry,
        }
    }

    /// What a caller does: client credentials in, a service token out.
    async fn mint(&self, id: &str, secret: &str) -> String {
        let reply = http()
            .post(format!("{}/system/service-token", self.base))
            .header("content-type", "application/json")
            .body(json!({ "clientId": id, "clientSecret": secret }).to_string())
            .send()
            .await
            .expect("auth answers");
        assert_eq!(reply.status().as_u16(), 200, "the fake auth knows {id}");
        let body: Value =
            serde_json::from_slice(&reply.bytes().await.expect("body")).expect("json");
        body["token"].as_str().expect("a token").to_owned()
    }
}

/// The clients of the fake `auth`. `letterhead-test-caller` exists only here (AC-9.3).
fn clients() -> Vec<Client> {
    vec![
        Client {
            id: "letterhead-test-caller",
            secret: "caller-secret",
            scopes: &["letterhead:render"],
        },
        Client {
            id: "crm-api",
            secret: "crm-secret",
            scopes: &["letterhead:render"],
        },
        // This service's own client: the registry of the legal entities is read with it.
        Client {
            id: "letterhead-api",
            secret: SERVICE_CLIENT_SECRET,
            scopes: &["legal-entities:read"],
        },
        Client {
            id: "no-scope",
            secret: "s1",
            scopes: &[],
        },
        Client {
            id: "other-scope",
            secret: "s2",
            scopes: &["notifications.push"],
        },
    ]
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("client")
}

// ---------------------------------------------------------------------------------------------------------------
// The supervisor

struct Settings {
    workers: usize,
    queue: usize,
    /// `LH_WORKER_RSS_MB`; `None` leaves the variable out, so the service's default applies.
    worker_rss_mb: Option<u64>,
    schema_url: String,
    jwks_url: String,
    /// `AUTH_BASE_URL`: where the token and the registry are read.
    auth_base: String,
    s3_endpoint: String,
}

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
fn server_env(env: &TestEnv, settings: &Settings, port: u16) -> Vec<(&'static str, String)> {
    let host = url::Url::parse(&settings.s3_endpoint)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    let mut vars = vec![
        ("PORT", port.to_string()),
        ("DATABASE_URL", settings.schema_url.clone()),
        ("AUTH_ISSUER", ISSUER.to_owned()),
        // The fake `auth`: the service token of this service's own client and the registry (a loopback address, because
        // a public `http` URL stops the start, T48 F4).
        ("AUTH_BASE_URL", settings.auth_base.clone()),
        ("AUTH_JWKS_URL", settings.jwks_url.clone()),
        ("AUTH_AUDIENCE", PERSON_AUDIENCE.to_owned()),
        ("SERVICE_AUDIENCE", SERVICE_AUDIENCE.to_owned()),
        ("SERVICE_CLIENT_ID", "letterhead-api".to_owned()),
        ("SERVICE_CLIENT_SECRET", SERVICE_CLIENT_SECRET.to_owned()),
        ("ALLOWED_ORIGINS", "http://localhost:5173".to_owned()),
        ("LETTERHEAD_S3_ENDPOINT", settings.s3_endpoint.clone()),
        ("LETTERHEAD_S3_REGION", "us-east-1".to_owned()),
        ("LETTERHEAD_S3_BUCKET", env.bucket.clone()),
        ("LETTERHEAD_S3_ACCESS_KEY_ID", env.s3_access_key_id.clone()),
        (
            "LETTERHEAD_S3_SECRET_ACCESS_KEY",
            env.s3_secret_access_key.clone(),
        ),
        ("LETTERHEAD_S3_EU_ENDPOINT_HOSTS", host),
        ("LH_WORKERS", settings.workers.to_string()),
        ("LH_QUEUE", settings.queue.to_string()),
    ];
    if let Some(mb) = settings.worker_rss_mb {
        vars.push(("LH_WORKER_RSS_MB", mb.to_string()));
    }
    vars
}

impl Server {
    /// Starts the binary and waits until it answers `/health`.
    async fn start(env: &TestEnv, settings: &Settings) -> Server {
        let port = free_port();
        let mut command = Command::new(env!("CARGO_BIN_EXE_letterhead-api"));
        command
            .env_clear()
            .envs(server_env(env, settings, port))
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

    /// The lines that the supervisor has written to stdout so far.
    fn lines(&self) -> Vec<String> {
        self.out.lock().expect("lock").clone()
    }

    /// The lines of the log that are about requests, waiting a moment for the pipe to deliver `at_least` of them.
    async fn request_lines(&self, at_least: usize) -> Vec<String> {
        let started = Instant::now();
        loop {
            let lines: Vec<String> = self
                .lines()
                .into_iter()
                .filter(|l| l.starts_with("render "))
                .collect();
            if lines.len() >= at_least || started.elapsed() > Duration::from_secs(5) {
                return lines;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Stops the supervisor and returns everything it wrote, stdout then stderr.
    fn stop(mut self) -> (Vec<String>, Vec<String>) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // The readers end when the pipes close; give them a moment to hand over the last lines.
        std::thread::sleep(Duration::from_millis(100));
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

/// A supervisor on the default pool, a fake `auth`, a schema and a bucket; `None` when there is nothing to test on.
struct World {
    fixture: Fixture,
    auth: FakeAuth,
    server: Server,
}

impl World {
    async fn start() -> Option<World> {
        World::with_pool(2, 4).await
    }

    async fn with_pool(workers: usize, queue: usize) -> Option<World> {
        World::with_pool_and_rss(workers, queue, None).await
    }

    async fn with_pool_and_rss(
        workers: usize,
        queue: usize,
        worker_rss_mb: Option<u64>,
    ) -> Option<World> {
        let fixture = Fixture::new().await?;
        let auth = FakeAuth::start(clients()).await;
        let server = Server::start(
            &fixture.env,
            &Settings {
                workers,
                queue,
                worker_rss_mb,
                schema_url: fixture.schema_url.clone(),
                jwks_url: auth.jwks_url.clone(),
                auth_base: auth.base.clone(),
                s3_endpoint: fixture.env.s3_endpoint.clone(),
            },
        )
        .await;
        Some(World {
            fixture,
            auth,
            server,
        })
    }

    /// A token of the test caller: the one the plan's AC-9.1 names.
    async fn caller(&self) -> String {
        self.auth
            .mint("letterhead-test-caller", "caller-secret")
            .await
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

async fn post_bytes(server: &Server, path: &str, token: Option<&str>, body: Vec<u8>) -> Reply {
    let mut request = http().post(server.url(path)).body(body);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    send(request).await
}

async fn post(server: &Server, path: &str, token: &str, body: &Value) -> Reply {
    post_bytes(server, path, Some(token), body.to_string().into_bytes()).await
}

/// Every answer of the render routes, whatever it says, carries `Cache-Control: no-store` (AC-3.8).
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

/// The answers of the router itself (an unknown route, a wrong method): a problem, and nothing of the request.
fn assert_problem_of_the_router(reply: &Reply, status: u16, code: &str) {
    assert_eq!(reply.status, status, "{}", reply.text());
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("application/problem+json")
    );
    assert_eq!(reply.code(), code, "{}", reply.text());
}

/// Sends the head of a request that declares a body, and no body, and returns the first line of the answer.
/// The answer must come while the body is still missing: that is what is tested.
fn answer_to_head_alone(port: u16, token: &str, length: usize) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("timeout");
    let head = format!(
        "POST /v1/render/pdf HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {length}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).expect("head");
    let mut seen = Vec::new();
    let mut buffer = [0u8; 512];
    while !seen.windows(2).any(|w| w == b"\r\n") {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => seen.extend_from_slice(&buffer[..n]),
        }
    }
    String::from_utf8_lossy(&seen)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let word = |at: usize| u32::from_be_bytes(png[at..at + 4].try_into().expect("4 bytes"));
    (word(16), word(20))
}

fn page_texts(reply: &Reply) -> Vec<String> {
    reply.json()["pages"]
        .as_array()
        .expect("pages")
        .iter()
        .map(|p| p["text"].as_str().expect("text").to_owned())
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Documents

/// The worst request the limits accept (AC-3.3), as `perf/worst-case.ts` sends it: a table of 1 660 rows x 3 cells,
/// 4 984 blocks of the 5 000 allowed, whose middle cell is `detail` characters long. How many pages it comes to is
/// set by `detail`: see `WORST_FITS_DETAIL` and `WORST_OVER_DETAIL`.
fn worst_table(detail: usize) -> Value {
    let cell = |text: String| json!([{ "type": "paragraph", "runs": [{ "text": text }] }]);
    let rows: Vec<Value> = (0..1660)
        .map(|i| {
            let long = format!(
                "Dettaglio della voce {}: {}",
                i + 1,
                "descrizione dell'attivita svolta ".repeat(8)
            );
            json!([
                cell(format!("Voce {}", i + 1)),
                cell(long.chars().take(detail).collect()),
                cell(format!("{}.00", i + 1)),
            ])
        })
        .collect();
    request(
        "welld_it",
        json!([{
            "type": "table",
            "columns": [5, 3, 2],
            "header": [cell("Voce".into()), cell("Dettaglio".into()), cell("Importo".into())],
            "rows": rows,
        }]),
    )
}

/// On this file's letterhead (`config("F", None)`): 163 characters lay out to exactly 300 pages, the most that is
/// accepted; 164 to 301 or more, the first size that is refused. They sit on a step of the layout (one more line
/// in every row), so a font or layout change moves them: the test says so when it does.
const WORST_FITS_DETAIL: usize = 163;
const WORST_OVER_DETAIL: usize = 164;

fn paragraph(text: &str) -> Value {
    json!({ "type": "paragraph", "runs": [{ "text": text }] })
}

fn cell(text: &str) -> Value {
    json!([paragraph(text)])
}

fn request(entity: &str, blocks: Value) -> Value {
    json!({ "contentVersion": 1, "entity": entity, "language": "en", "blocks": blocks })
}

/// A small valid request on `welld_it`.
fn small() -> Value {
    request("welld_it", json!([paragraph("Hello")]))
}

/// A document of a tool that is not the CRM (AC-9.1): a title, a table of expense lines with its totals, and a
/// paragraph, for `welld_ch`.
fn expense_document() -> Value {
    json!({
        "contentVersion": 1,
        "entity": "welld_ch",
        "language": "en",
        "entityData": { "legalName": "WellD Switzerland SA", "addressLines": ["Via Esempio 1", "6900 Lugano"] },
        "blocks": [
            { "type": "heading", "level": 1, "text": "Expense report 2026-11" },
            { "type": "table", "columns": [4, 2, 2], "align": ["left", "right", "right"],
              "header": [cell("Description"), cell("Amount"), cell("VAT")],
              "rows": [
                [cell("Train Milan - Zurich"), cell("84.00"), cell("6.30")],
                [cell("Hotel, 2 nights"), cell("310.00"), cell("23.25")],
                [cell("Client dinner"), cell("126.50"), cell("9.50")],
                [cell("Total"), cell("520.50"), cell("39.05")]
              ] },
            paragraph("Approved by the head of the department."),
        ]
    })
}

// ===============================================================================================================
// AC-3.1: who may call

mod auth {
    use super::*;

    /// Six ways of being refused, and more, and the answer is the same bytes (AC-3.1).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_refusals_of_every_credential_are_byte_identical() {
        let Some(world) = World::start().await else {
            return;
        };
        let key = &world.auth.key;
        let other_key = TestKey::generate();
        let good = service_claims("system:letterhead-test-caller", "letterhead:render");
        let with = |name: &str, value: Value| {
            let mut claims = good.clone();
            claims[name] = value;
            key.token(&claims)
        };
        let person = key.token(&json!({
            "iss": ISSUER, "sub": "0b8e5f0c-1c3a-4a8e-9a43-e2d9d3b8f8a1", "aud": PERSON_AUDIENCE,
            "iat": now(), "exp": now() + 900, "name": "A Person"
        }));
        let hs256 = key.sign(&json!({ "alg": "HS256", "typ": "JWT", "kid": KID }), &good);
        let none = format!(
            "{}.{}.",
            b64url(json!({ "alg": "none", "kid": KID }).to_string().as_bytes()),
            b64url(good.to_string().as_bytes())
        );
        let no_scope = world.auth.mint("no-scope", "s1").await;
        let other_scope = world.auth.mint("other-scope", "s2").await;

        // (what is wrong, the Authorization header, or none)
        let cases: Vec<(&str, Option<String>)> = vec![
            ("no credential", None),
            ("an invalid one", Some("Bearer not-a-token".into())),
            (
                "an expired one",
                Some(format!("Bearer {}", with("exp", json!(now() - 5)))),
            ),
            (
                "another audience",
                Some(format!("Bearer {}", with("aud", json!("somebody-else")))),
            ),
            (
                "no scope (a client without it)",
                Some(format!("Bearer {no_scope}")),
            ),
            ("another scope", Some(format!("Bearer {other_scope}"))),
            ("a person's token", Some(format!("Bearer {person}"))),
            (
                "a person's audience on a service claim set",
                Some(format!("Bearer {}", with("aud", json!(PERSON_AUDIENCE)))),
            ),
            (
                "both audiences",
                Some(format!(
                    "Bearer {}",
                    with("aud", json!([SERVICE_AUDIENCE, PERSON_AUDIENCE]))
                )),
            ),
            (
                "another issuer",
                Some(format!(
                    "Bearer {}",
                    with("iss", json!("http://evil.example"))
                )),
            ),
            (
                "a sub that is not a service",
                Some(format!("Bearer {}", with("sub", json!("alice")))),
            ),
            (
                "signed by another key",
                Some(format!("Bearer {}", other_key.token(&good))),
            ),
            ("alg none", Some(format!("Bearer {none}"))),
            ("alg HS256", Some(format!("Bearer {hs256}"))),
            (
                "the wrong scheme",
                Some(format!("Basic {}", world.caller().await)),
            ),
            ("no scheme", Some(world.caller().await)),
            ("an empty bearer", Some("Bearer ".into())),
        ];
        let mut first: Option<Vec<u8>> = None;
        for route in ["/v1/render/pdf", "/v1/render/preview"] {
            for (what, header) in &cases {
                let mut request = http()
                    .post(world.server.url(route))
                    .body(small().to_string());
                if let Some(header) = header {
                    request = request.header("authorization", header);
                }
                let reply = send(request).await;
                assert_eq!(reply.status, 401, "{what} on {route}: {}", reply.text());
                assert_no_store(&reply);
                assert_eq!(
                    reply.header("content-type").as_deref(),
                    Some("application/problem+json"),
                    "{what}"
                );
                let reference = first.get_or_insert_with(|| reply.body.clone());
                assert_eq!(
                    &reply.body,
                    reference,
                    "{what} on {route}: the 401 body must be the same bytes, got {}",
                    reply.text()
                );
            }
        }
        // The same on the status route.
        let reply = send(http().get(world.server.url("/v1/letterheads/status"))).await;
        assert_eq!(reply.status, 401);
        assert_eq!(Some(&reply.body), first.as_ref());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_service_token_is_accepted_and_the_route_never_takes_a_person_token() {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("FOOTER-ONE", None), &[])
            .await;
        let token = world.caller().await;
        let reply = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_eq!(reply.status, 200, "{}", reply.text());

        let person = world.auth.key.token(&json!({
            "iss": ISSUER, "sub": "user-1", "aud": PERSON_AUDIENCE, "scope": "letterhead:render",
            "iat": now(), "exp": now() + 900
        }));
        let reply = post(&world.server, "/v1/render/pdf", &person, &small()).await;
        assert_eq!(
            reply.status, 401,
            "a person's token with the scope in it is still a person's token"
        );
    }

    /// AC-9.3: the service has no list of callers. The test caller is known to the fake `auth` and to nothing else.
    #[test]
    fn render_the_service_names_no_caller_in_its_code() {
        fn sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("read dir") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    sources(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&root, &mut files);
        assert!(files.len() > 10);
        for file in files {
            let text = std::fs::read_to_string(&file).expect("read");
            // Everything above the unit tests: tests may name callers; the code may not.
            let code = text.split("#[cfg(test)]").next().unwrap_or(&text);
            for name in [
                "letterhead-test-caller",
                "crm-api",
                "allowed_subs",
                "allowedSubs",
            ] {
                let lines: Vec<&str> = code
                    .lines()
                    .filter(|l| l.contains(name) && !l.trim_start().starts_with("//"))
                    .collect();
                assert!(
                    lines.is_empty(),
                    "{} names `{name}` in code: {lines:?}",
                    file.display()
                );
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_token_for_a_caller_that_auth_adds_later_needs_no_change_here() {
        // AC-9.3: a new client at `auth` is a new principal here, with the same running service.
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldCh, config("FOOTER-CH", None), &[])
            .await;
        for (client, secret) in [
            ("letterhead-test-caller", "caller-secret"),
            ("crm-api", "crm-secret"),
        ] {
            let token = world.auth.mint(client, secret).await;
            let reply = post(&world.server, "/v1/render/pdf", &token, &expense_document()).await;
            assert_eq!(reply.status, 200, "{client}: {}", reply.text());
        }
        let lines = world.server.request_lines(2).await;
        assert!(
            lines
                .iter()
                .any(|l| l.contains("caller=system:letterhead-test-caller")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.contains("caller=system:crm-api")),
            "{lines:?}"
        );
    }
}

// ===============================================================================================================
// AC-1.1, 1.2, 9.1: what a caller gets

mod answers {
    use super::*;

    /// AC-9.1: a caller that is not the CRM renders an expense table for `welld_ch`: the PDF and the preview.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_the_test_caller_gets_the_pdf_and_the_preview_of_an_expense_table_for_welld_ch()
    {
        let Some(world) = World::start().await else {
            return;
        };
        let version = world
            .fixture
            .save(Entity::WelldCh, config("WELLD-CH-FOOTER", None), &[])
            .await;
        let token = world.caller().await;
        let document = expense_document();

        let pdf = post(&world.server, "/v1/render/pdf", &token, &document).await;
        assert_eq!(pdf.status, 200, "{}", pdf.text());
        assert_no_store(&pdf);
        assert_eq!(
            pdf.header("content-type").as_deref(),
            Some("application/pdf")
        );
        assert!(pdf.body.starts_with(b"%PDF-"), "a PDF");
        assert_eq!(pdf.header("letterhead-version"), Some(version.to_string()));
        assert_eq!(pdf.header("page-count").as_deref(), Some("1"));
        assert_eq!(pdf.header("unprintable-characters").as_deref(), Some("0"));
        // The footer of the default variant names {legal_name} and {address}; both were sent. The footer of the
        // configuration says WELLD-CH-FOOTER where the legal name goes by default.
        assert_eq!(pdf.header("missing-placeholders").as_deref(), Some(""));

        let preview = post(&world.server, "/v1/render/preview", &token, &document).await;
        assert_eq!(preview.status, 200, "{}", preview.text());
        assert_no_store(&preview);
        assert_eq!(
            preview.header("content-type").as_deref(),
            Some("application/json")
        );
        let body = preview.json();
        assert_eq!(body["letterheadVersion"], version);
        assert_eq!(body["pageCount"], 1);
        assert_eq!(body["unprintableCharacters"], 0);
        assert_eq!(body["missingPlaceholders"], json!([]));
        let pages = body["pages"].as_array().expect("pages");
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0]["n"], 1);
        let png = STANDARD
            .decode(pages[0]["image"].as_str().expect("image"))
            .expect("base64");
        assert_eq!(png_size(&png), (893, 1263), "A4 at 1.5 px per point");
        let text = pages[0]["text"].as_str().expect("text");
        for wanted in [
            "Expense report 2026-11",
            "Hotel, 2 nights",
            "520.50",
            "Approved by the head",
            "WELLD-CH-FOOTER",
        ] {
            assert!(text.contains(wanted), "{wanted:?} not in {text:?}");
        }
        assert!(
            text.find("Expense report").expect("title")
                < text.find("Approved by").expect("paragraph"),
            "blocks in the order sent"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_the_pages_parameter_selects_pages_and_the_count_is_still_the_documents() {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        let blocks: Vec<Value> = (1..=3)
            .flat_map(|n| {
                [
                    paragraph(&format!("page number {n}")),
                    json!({ "type": "pageBreak" }),
                ]
            })
            .collect();
        let document = request("welld_it", Value::Array(blocks));

        let all = post(&world.server, "/v1/render/preview", &token, &document).await;
        assert_eq!(all.status, 200, "{}", all.text());
        assert_eq!(all.json()["pageCount"], 3);
        assert_eq!(page_texts(&all).len(), 3);

        let two = post(
            &world.server,
            "/v1/render/preview?pages=2",
            &token,
            &document,
        )
        .await;
        assert_eq!(two.status, 200);
        assert_eq!(two.json()["pageCount"], 3, "the count is of the document");
        let pages = two.json()["pages"].as_array().expect("pages").clone();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0]["n"], 2);
        assert!(
            pages[0]["text"]
                .as_str()
                .expect("text")
                .contains("page number 2")
        );

        // A comma as a browser writes it.
        let some = post(
            &world.server,
            "/v1/render/preview?pages=1%2C3",
            &token,
            &document,
        )
        .await;
        let numbers: Vec<u64> = some.json()["pages"]
            .as_array()
            .expect("pages")
            .iter()
            .map(|p| p["n"].as_u64().expect("n"))
            .collect();
        assert_eq!(numbers, [1, 3]);

        for bad in [
            "?pages=0",
            "?pages=x",
            "?pages=1,,2",
            "?pages=4",
            "?pages=99",
            "?pages=1&pages=2",
        ] {
            let reply = post(
                &world.server,
                &format!("/v1/render/preview{bad}"),
                &token,
                &document,
            )
            .await;
            assert_problem(&reply, 422, "invalid_pages");
        }
        // The PDF has no pages parameter: it is the whole document.
        let pdf = post(&world.server, "/v1/render/pdf?pages=2", &token, &document).await;
        assert_eq!(pdf.status, 200);
        assert_eq!(pdf.header("page-count").as_deref(), Some("3"));
    }

    /// A placeholder that the registry holds nothing for is listed as missing, whatever the request's `entityData`
    /// says (AC-5.3, AC-5.2): the caller cannot fill what the registry left empty.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_missing_placeholders_are_the_registrys_empty_values_whatever_entity_data_says()
    {
        let Some(world) = World::start().await else {
            return;
        };
        // The default footer uses {legal_name} and {address}; this one also uses {vat}.
        let mut footer = serde_json::to_value(default_config()).expect("json");
        footer["variants"]["default"]["footer"]["left"][0]["text"] =
            json!({ "it": "{legal_name} - {vat}", "en": "{legal_name} - {vat}" });
        world.fixture.save(Entity::WelldIt, footer, &[]).await;
        let token = world.caller().await;

        // Not moved yet (version 0, empty values; set before the service first reads the registry): both are
        // missing, and a caller's values do not fill them.
        for (member, value) in [
            ("version", json!(0)),
            ("legalName", json!("")),
            ("vatNumber", json!("")),
        ] {
            world.auth.registry.set("welld_it", member, value);
        }
        let mut given = small();
        given["entityData"] =
            json!({ "legalName": "WellD S.r.l.", "vat": "IT123", "addressLines": ["Via X 1"] });
        let reply = post(&world.server, "/v1/render/pdf", &token, &given).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert_eq!(
            reply.header("missing-placeholders").as_deref(),
            Some("legal_name,vat")
        );
        assert_eq!(reply.header("legal-entity-version").as_deref(), Some("0"));
        let bare = post(&world.server, "/v1/render/preview", &token, &small()).await;
        assert_eq!(
            bare.json()["missingPlaceholders"],
            json!(["legal_name", "vat"])
        );
    }
}

// ===============================================================================================================
// AC-4.4: which letterhead version

mod versions {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_the_active_version_is_the_default_and_a_named_one_is_exactly_that_one() {
        let Some(world) = World::start().await else {
            return;
        };
        let v1 = world
            .fixture
            .save(Entity::WelldIt, config("FOOTER-ONE", None), &[])
            .await;
        let v2 = world
            .fixture
            .save(Entity::WelldIt, config("FOOTER-TWO", None), &[])
            .await;
        let v3 = world
            .fixture
            .save(Entity::WelldIt, config("FOOTER-THREE", None), &[])
            .await;
        assert_eq!((v1, v2, v3), (1, 2, 3));
        let token = world.caller().await;

        let default = post(&world.server, "/v1/render/preview", &token, &small()).await;
        assert_eq!(
            default.json()["letterheadVersion"],
            3,
            "the highest is active"
        );
        assert!(page_texts(&default)[0].contains("FOOTER-THREE"));

        for (named, marker) in [(1, "FOOTER-ONE"), (2, "FOOTER-TWO"), (3, "FOOTER-THREE")] {
            let mut document = small();
            document["letterheadVersion"] = json!(named);
            let reply = post(&world.server, "/v1/render/preview", &token, &document).await;
            assert_eq!(reply.status, 200, "{}", reply.text());
            assert_eq!(
                reply.json()["letterheadVersion"],
                named,
                "the answer states the version used"
            );
            let text = &page_texts(&reply)[0];
            assert!(text.contains(marker), "{marker} not in {text:?}");
            for other in ["FOOTER-ONE", "FOOTER-TWO", "FOOTER-THREE"] {
                assert_eq!(
                    text.contains(other),
                    other == marker,
                    "{other} in the page of version {named}"
                );
            }
            let pdf = post(&world.server, "/v1/render/pdf", &token, &document).await;
            assert_eq!(pdf.header("letterhead-version"), Some(named.to_string()));
        }

        // `null` is as good as absent.
        let mut document = small();
        document["letterheadVersion"] = Value::Null;
        let reply = post(&world.server, "/v1/render/preview", &token, &document).await;
        assert_eq!(reply.json()["letterheadVersion"], 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_an_unknown_version_is_404_and_an_entity_without_one_is_409_and_nothing_falls_back()
     {
        let Some(world) = World::start().await else {
            return;
        };
        // Only welld_it is configured.
        world
            .fixture
            .save(Entity::WelldIt, config("IT-FOOTER", None), &[])
            .await;
        let token = world.caller().await;

        let mut missing = small();
        missing["letterheadVersion"] = json!(2);
        let reply = post(&world.server, "/v1/render/preview", &token, &missing).await;
        assert_problem(&reply, 404, "letterhead_version_not_found");
        let reply = post(&world.server, "/v1/render/pdf", &token, &missing).await;
        assert_problem(&reply, 404, "letterhead_version_not_found");
        assert!(reply.body.starts_with(b"{"), "no partial document");

        for version in [0, -1, 1_000_000] {
            let mut document = small();
            document["letterheadVersion"] = json!(version);
            let reply = post(&world.server, "/v1/render/pdf", &token, &document).await;
            assert!(
                reply.status == 404 || reply.status == 422,
                "version {version} gave {}: {}",
                reply.status,
                reply.text()
            );
            assert!(!reply.body.starts_with(b"%PDF"), "never a fallback");
        }

        // welld_ch has no version at all: 409, though welld_it has one and the same number exists there.
        let ch = request("welld_ch", json!([paragraph("Hello")]));
        let reply = post(&world.server, "/v1/render/preview", &token, &ch).await;
        assert_problem(&reply, 409, "letterhead_not_configured");
        let reply = post(&world.server, "/v1/render/pdf", &token, &ch).await;
        assert_problem(&reply, 409, "letterhead_not_configured");
        // Naming welld_it's version 1 for welld_ch does not borrow it.
        let mut named = ch.clone();
        named["letterheadVersion"] = json!(1);
        let reply = post(&world.server, "/v1/render/pdf", &token, &named).await;
        assert_problem(&reply, 404, "letterhead_version_not_found");
    }
}

// ===============================================================================================================
// AC-3.3, 3.6: limits and refusals

mod refusals {
    use super::*;

    /// A valid request, padded with white space after the closing brace to `size` bytes.
    fn padded(size: usize) -> Vec<u8> {
        let mut body = small().to_string().into_bytes();
        assert!(body.len() < size);
        body.resize(size, b' ');
        body
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_body_over_20_mib_is_413_and_one_of_exactly_20_mib_is_read() {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        let limit = 20 * 1024 * 1024;

        let over = post_bytes(
            &world.server,
            "/v1/render/pdf",
            Some(&token),
            padded(limit + 1),
        )
        .await;
        assert_problem(&over, 413, "request_too_large");
        let over = post_bytes(
            &world.server,
            "/v1/render/preview",
            Some(&token),
            padded(limit + 1024 * 1024),
        )
        .await;
        assert_problem(&over, 413, "request_too_large");
        // Far over: what the supervisor reads of it is bounded, and then it closes the connection. The caller
        // sees the 413 or a reset, and never a render.
        let request = http()
            .post(world.server.url("/v1/render/preview"))
            .header("authorization", format!("Bearer {token}"))
            .body(padded(limit * 2));
        match request.send().await {
            Ok(reply) => assert_eq!(reply.status().as_u16(), 413),
            Err(error) => assert!(error.is_request() || error.is_connect(), "{error}"),
        }

        let exact = post_bytes(&world.server, "/v1/render/pdf", Some(&token), padded(limit)).await;
        assert_eq!(exact.status, 200, "{}", exact.text());
        assert!(exact.body.starts_with(b"%PDF"));
    }

    /// A body that is declared too big is refused on its head: the answer does not wait for the 21 MiB.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_declared_size_over_20_mib_is_413_before_any_of_the_body_is_sent() {
        let Some(world) = World::start().await else {
            return;
        };
        let token = world.caller().await;
        let port = world.server.port;
        let line = tokio::task::spawn_blocking(move || {
            answer_to_head_alone(port, &token, 21 * 1024 * 1024)
        })
        .await
        .expect("join");
        assert!(line.contains("413"), "{line:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_chunked_body_over_20_mib_is_413_too() {
        let Some(world) = World::start().await else {
            return;
        };
        let token = world.caller().await;
        let port = world.server.port;
        let status_line = tokio::task::spawn_blocking(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            stream.set_read_timeout(Some(Duration::from_secs(60))).expect("timeout");
            let head = format!(
                "POST /v1/render/pdf HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\
                 Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(head.as_bytes()).expect("head");
            let piece = vec![b' '; 64 * 1024];
            let mut sent = 0usize;
            // 20 MiB in 64 KiB chunks, then one more byte: the limit is crossed by the last chunk only.
            while sent < 20 * 1024 * 1024 {
                let chunk = [format!("{:x}\r\n", piece.len()).as_bytes(), &piece, b"\r\n"].concat();
                if stream.write_all(&chunk).is_err() {
                    break;
                }
                sent += piece.len();
            }
            let _ = stream.write_all(b"1\r\n \r\n0\r\n\r\n");
            let mut reply = Vec::new();
            let _ = stream.read_to_end(&mut reply);
            String::from_utf8_lossy(&reply).lines().next().unwrap_or_default().to_owned()
        })
        .await
        .expect("join");
        assert!(status_line.contains("413"), "{status_line:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_more_than_5000_blocks_or_200000_characters_is_422_naming_the_limit() {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;

        let blocks: Vec<Value> = (0..5001).map(|_| json!({ "type": "pageBreak" })).collect();
        let reply = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &request("welld_it", Value::Array(blocks)),
        )
        .await;
        assert_problem(&reply, 422, "content_too_large");
        assert_eq!(
            reply.json()["limit"],
            json!({ "name": "blocks", "max": 5000 })
        );
        assert!(!reply.body.starts_with(b"%PDF"), "nothing partial");

        let long = "a".repeat(200_001);
        let reply = post(
            &world.server,
            "/v1/render/preview",
            &token,
            &request("welld_it", json!([paragraph(&long)])),
        )
        .await;
        assert_problem(&reply, 422, "content_too_large");
        assert_eq!(
            reply.json()["limit"],
            json!({ "name": "text_chars", "max": 200_000 })
        );
        assert!(!reply.text().contains("aaaa"), "no text of the request");
    }

    /// 301 pages: refused, with no part of a document.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_document_of_301_pages_is_too_many_pages_and_nothing_partial_comes_back() {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        let blocks: Vec<Value> = (0..301)
            .flat_map(|n| [paragraph(&format!("p{n}")), json!({ "type": "pageBreak" })])
            .collect();
        let document = request("welld_it", Value::Array(blocks));
        let reply = post(&world.server, "/v1/render/pdf", &token, &document).await;
        assert_problem(&reply, 422, "too_many_pages");
        assert_eq!(
            reply.json()["limit"],
            json!({ "name": "pages", "max": 300 })
        );
        assert!(!reply.body.starts_with(b"%PDF"));
        // The next request is served: the worker was not left in a state.
        let ok = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_eq!(ok.status, 200);
    }

    /// T46, AC-3.5: `LH_WORKER_RSS_MB` reaches the pool. At the minimum the variable allows (64 MiB) a worker that
    /// lays out a table of a few hundred rows is past its cap while it works and is killed: 503 `render_unavailable`
    /// with `Retry-After: 2`, the outcome `render_memory_exceeded` in the request line and nothing of the table in
    /// the answer. The same document on a service that is left to its default cap is served, so the 503 is the cap
    /// and not the document. (Before T46 `main` never read the variable and the first half of this test got 200.)
    ///
    /// It needs no worst-case document, so it runs in a debug build too.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_with_a_low_worker_rss_cap_is_render_unavailable_and_the_service_goes_on() {
        let rows: Vec<Value> = (0..400)
            .map(|i| json!([cell(&format!("Voce {i}")), cell(&"descrizione ".repeat(12))]))
            .collect();
        let table = request(
            "welld_it",
            json!([{
                "type": "table",
                "columns": [3, 7],
                "header": [cell("Voce"), cell("Dettaglio")],
                "rows": rows,
            }]),
        );

        let Some(world) = World::with_pool_and_rss(1, 1, Some(64)).await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        let reply = post(&world.server, "/v1/render/pdf", &token, &table).await;
        assert_problem(&reply, 503, "render_unavailable");
        assert_eq!(reply.header("retry-after").as_deref(), Some("2"));
        assert!(!reply.body.starts_with(b"%PDF"), "nothing partial");
        let lines = world.server.request_lines(1).await;
        assert!(
            lines
                .iter()
                .any(|l| l.contains("outcome=render_memory_exceeded")),
            "{lines:?}"
        );
        // A new worker took the place of the one that was killed.
        let again = post(&world.server, "/v1/render/pdf", &token, &table).await;
        assert_problem(&again, 503, "render_unavailable");

        // The default cap (2 GiB) serves the same document.
        let Some(world) = World::with_pool(1, 1).await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        let served = post(&world.server, "/v1/render/pdf", &token, &table).await;
        assert_eq!(served.status, 200, "{}", served.text());
        assert!(served.body.starts_with(b"%PDF"));
    }

    /// T41, AC-3.3: a table a little over 300 pages is refused as `too_many_pages` (422), not killed for memory and
    /// answered 503. The page limit is checked after the whole document is laid out, so the worker's memory cap
    /// has to leave room for the layout of such a table (it did not at 1 GiB).
    ///
    /// Off unless `LETTERHEAD_WORST_CASE_TESTS=1`, and only in an optimised build: the service's own 30 s deadline
    /// is for those, and a debug engine needs minutes for this document. (`tests/pool.rs` runs the same two
    /// documents against the pool with a longer deadline, in either build.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_table_just_over_300_pages_is_too_many_pages_and_not_render_unavailable() {
        if std::env::var("LETTERHEAD_WORST_CASE_TESTS").as_deref() != Ok("1")
            || cfg!(debug_assertions)
        {
            eprintln!("SKIPPED: set LETTERHEAD_WORST_CASE_TESTS=1 and run with --release");
            return;
        }
        // A service of its own for each document: a worker keeps the memory it has used (its resident set does not
        // shrink after a job), so a second document would be measured on top of the first.
        let started = |world: World| async move {
            world
                .fixture
                .save(Entity::WelldIt, config("F", None), &[])
                .await;
            let token = world.caller().await;
            (world, token)
        };

        let Some(world) = World::with_pool(1, 1).await else {
            return;
        };
        let (world, token) = started(world).await;
        let over = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &worst_table(WORST_OVER_DETAIL),
        )
        .await;
        assert_problem(&over, 422, "too_many_pages");
        assert_eq!(over.json()["limit"], json!({ "name": "pages", "max": 300 }));
        assert!(!over.body.starts_with(b"%PDF"), "nothing partial");
        // The worker was not killed, and the service goes on.
        let ok = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_eq!(ok.status, 200);
        let lines = world.server.request_lines(2).await;
        assert!(
            lines.iter().any(|l| l.contains("outcome=too_many_pages")),
            "{lines:?}"
        );
        assert!(
            !lines.iter().any(|l| l.contains("render_memory_exceeded")),
            "{lines:?}"
        );

        // The last size that is accepted: exactly 300 pages.
        let Some(world) = World::with_pool(1, 1).await else {
            return;
        };
        let (world, token) = started(world).await;
        let fits = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &worst_table(WORST_FITS_DETAIL),
        )
        .await;
        assert_eq!(fits.status, 200, "{}", fits.text());
        let pages: usize = fits
            .header("page-count")
            .expect("page-count")
            .parse()
            .expect("a number");
        assert!(
            (299..=300).contains(&pages),
            "the layout moved: {pages} pages"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_content_that_cannot_be_rendered_is_422_with_paths_and_reasons_and_no_text_of_the_request()
     {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        let mut document = request(
            "welld_it",
            json!([
                paragraph(MARKER),
                { "type": "paragraph", "runs": [{ "text": MARKER, "style": format!("{MARKER}-style") }] },
                { "type": format!("{MARKER}-block") },
                { "type": "image", "data": MARKER, "url": format!("https://{MARKER}.example/logo.png") },
                { "type": "paragraph", "runs": [{ "text": MARKER }], format!("{MARKER}-member"): 1 },
            ]),
        );
        document["entityData"] = json!({ "legalName": MARKER, format!("{MARKER}-extra"): 1 });
        let reply = post(&world.server, "/v1/render/preview", &token, &document).await;
        assert_problem(&reply, 422, "invalid_content");
        let problems = reply.json()["problems"].clone();
        let listed: Vec<(String, String)> = problems
            .as_array()
            .expect("problems")
            .iter()
            .map(|p| {
                (
                    p["path"].as_str().unwrap_or("?").to_owned(),
                    p["reason"].as_str().unwrap_or("?").to_owned(),
                )
            })
            .collect();
        assert!(
            listed.contains(&("/blocks/1/runs/0/style".into(), "unknown_style".into())),
            "{listed:?}"
        );
        assert!(
            listed.contains(&("/blocks/2/type".into(), "unknown_block_type".into()))
                || listed.iter().any(|(p, _)| p == "/blocks/2"),
            "{listed:?}"
        );
        assert!(
            listed
                .iter()
                .any(|(p, r)| p == "/blocks/3/url" && r == "external_reference"),
            "{listed:?}"
        );
        assert!(
            listed
                .iter()
                .any(|(p, r)| p == "/blocks/3/data" && r == "invalid_base64"),
            "{listed:?}"
        );
        assert!(
            !reply.text().contains(MARKER),
            "an answer never repeats the request: {}",
            reply.text()
        );
        assert!(!reply.text().contains("ZQX"), "{}", reply.text());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_at_most_20_problems_are_listed_of_25() {
        let Some(world) = World::start().await else {
            return;
        };
        let token = world.caller().await;
        let blocks: Vec<Value> = (0..25)
            .map(|_| json!({ "type": "paragraph", "runs": [{ "text": MARKER, "style": "nope" }] }))
            .collect();
        let reply = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &request("welld_it", Value::Array(blocks)),
        )
        .await;
        assert_problem(&reply, 422, "invalid_content");
        assert_eq!(
            reply.json()["problems"].as_array().expect("problems").len(),
            20
        );
        assert!(!reply.text().contains(MARKER));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_the_envelope_has_a_code_for_each_fault_and_a_body_that_is_not_json_is_one_too()
    {
        let Some(world) = World::start().await else {
            return;
        };
        let token = world.caller().await;
        let cases = [
            (
                json!({ "contentVersion": 3, "entity": "welld_it", "language": "en", "blocks": [] }),
                "unsupported_content_version",
            ),
            (
                json!({ "contentVersion": 0, "entity": "welld_it", "language": "en", "blocks": [] }),
                "unsupported_content_version",
            ),
            (
                json!({ "contentVersion": 1, "entity": "welld_it", "language": "fr", "blocks": [] }),
                "unsupported_language",
            ),
            (
                json!({ "contentVersion": 1, "entity": "welld_de", "language": "en", "blocks": [] }),
                "unknown_entity",
            ),
        ];
        for (document, code) in cases {
            for route in ["/v1/render/pdf", "/v1/render/preview"] {
                let reply = post(&world.server, route, &token, &document).await;
                assert_problem(&reply, 422, code);
            }
        }
        for body in [
            b"not json {".to_vec(),
            Vec::new(),
            format!("{{\"entity\":\"{MARKER}").into_bytes(),
        ] {
            let reply = post_bytes(&world.server, "/v1/render/pdf", Some(&token), body).await;
            assert_problem(&reply, 422, "invalid_content");
            assert_eq!(reply.json()["problems"][0]["reason"], "malformed_json");
            assert!(!reply.text().contains(MARKER));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_known_path_with_the_wrong_method_is_not_a_render() {
        let Some(world) = World::start().await else {
            return;
        };
        let token = world.caller().await;
        let reply = send(
            http()
                .get(world.server.url("/v1/render/pdf"))
                .header("authorization", format!("Bearer {token}")),
        )
        .await;
        // No credential is asked for, and nothing is rendered; the answer is a problem like the others.
        assert_problem(&reply, 405, "method_not_allowed");
        let reply = send(http().post(world.server.url("/v1/nothing-here"))).await;
        assert_problem_of_the_router(&reply, 404, "not_found");
        // There is no PUT, PATCH or DELETE of anything (AC-4.3, AC-4.6).
        for method in [
            reqwest::Method::PUT,
            reqwest::Method::PATCH,
            reqwest::Method::DELETE,
        ] {
            for path in [
                "/v1/render/pdf",
                "/v1/letterheads/status",
                "/v1/letterheads/welld_it/versions/1",
            ] {
                let reply = send(
                    http()
                        .request(method.clone(), world.server.url(path))
                        .header("authorization", format!("Bearer {token}")),
                )
                .await;
                assert!(
                    reply.status == 404 || reply.status == 405,
                    "{method} {path}: {}",
                    reply.status
                );
            }
        }
    }
}

// ===============================================================================================================
// The status route

mod status {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_status_names_the_active_version_of_each_entity() {
        let Some(world) = World::start().await else {
            return;
        };
        let token = world.caller().await;
        let reply = send(
            http()
                .get(world.server.url("/v1/letterheads/status"))
                .header("authorization", format!("Bearer {token}")),
        )
        .await;
        assert_eq!(reply.status, 200);
        assert_no_store(&reply);
        assert_eq!(reply.json(), json!({ "welld_it": null, "welld_ch": null }));

        world
            .fixture
            .save(Entity::WelldIt, config("A", None), &[])
            .await;
        world
            .fixture
            .save(Entity::WelldIt, config("B", None), &[])
            .await;
        let reply = send(
            http()
                .get(world.server.url("/v1/letterheads/status"))
                .header("authorization", format!("Bearer {token}")),
        )
        .await;
        assert_eq!(
            reply.json(),
            json!({ "welld_it": { "activeVersion": 2 }, "welld_ch": null })
        );
    }
}

// ===============================================================================================================
// AC-2.3: images of blocks

mod images {
    use super::*;

    const SVG: &str = "<?xml version=\"1.0\"?>\n<!-- made by an editor -->\n\
        <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"20\" viewBox=\"0 0 40 20\">\
        <rect width=\"40\" height=\"20\" fill=\"#e50339\"/></svg>";

    fn image_block(bytes: &[u8]) -> Value {
        json!({ "type": "image", "data": STANDARD.encode(bytes), "widthRatio": 0.25 })
    }

    fn has_image(pdf: &[u8]) -> bool {
        let text = String::from_utf8_lossy(pdf);
        text.contains("/Subtype/Image") || text.contains("/Subtype /Image")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_png_and_an_svg_block_render_and_an_svg_is_drawn_from_the_rebuilt_file() {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        for (name, bytes) in [("png", PNG.to_vec()), ("svg", SVG.as_bytes().to_vec())] {
            let document = request(
                "welld_it",
                json!([paragraph("before"), image_block(&bytes), paragraph("after")]),
            );
            let pdf = post(&world.server, "/v1/render/pdf", &token, &document).await;
            assert_eq!(pdf.status, 200, "{name}: {}", pdf.text());
            assert!(pdf.body.starts_with(b"%PDF"), "{name}");
            let preview = post(&world.server, "/v1/render/preview", &token, &document).await;
            assert_eq!(preview.status, 200, "{name}: {}", preview.text());
            let text = &page_texts(&preview)[0];
            assert!(
                text.contains("before") && text.contains("after"),
                "{name}: {text:?}"
            );
        }
        // A request without the image has none in its PDF; with it, the PDF has one.
        let without = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &request("welld_it", json!([paragraph("x")])),
        )
        .await;
        assert!(!has_image(&without.body));
        let with = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &request("welld_it", json!([image_block(&PNG)])),
        )
        .await;
        assert!(has_image(&with.body), "the image block is in the PDF");
    }

    /// A refused image is `invalid_content` at the member that held its bytes (amendment 2026-11-17, 3g).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_refused_image_block_is_422_at_its_data_path_with_the_asset_reason() {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        let script = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><script>{MARKER}</script></svg>"
        );
        let external = "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" \
            width=\"10\" height=\"10\"><image xlink:href=\"/etc/hostname\"/></svg>";
        let styled = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\">\
            <style>.a{fill:red}</style><rect class=\"a\" width=\"10\" height=\"10\"/></svg>";
        let cases: Vec<(Vec<u8>, &str)> = vec![
            (script.into_bytes(), "svg_script"),
            (external.as_bytes().to_vec(), "svg_external_reference"),
            (styled.as_bytes().to_vec(), "svg_not_allowed"),
            (b"%PDF-1.7 renamed .png".to_vec(), "unsupported_format"),
            (vec![0u8; 2 * 1024 * 1024 + 1], "too_many_bytes"),
        ];
        for (bytes, reason) in cases {
            let document = request("welld_it", json!([paragraph("a"), image_block(&bytes)]));
            for route in ["/v1/render/pdf", "/v1/render/preview"] {
                let reply = post(&world.server, route, &token, &document).await;
                assert_problem(&reply, 422, "invalid_content");
                assert_eq!(
                    reply.json()["problems"],
                    json!([{ "path": "/blocks/1/data", "reason": reason }]),
                    "{reason} on {route}"
                );
                assert!(!reply.text().contains(MARKER));
            }
        }
        // A request whose letterhead does not exist is still judged on its images first: the content is refused
        // before anything is loaded or rendered.
        let mut unknown = request("welld_ch", json!([image_block(b"not an image")]));
        unknown["language"] = json!("it");
        let reply = post(&world.server, "/v1/render/pdf", &token, &unknown).await;
        assert_problem(&reply, 422, "invalid_content");
    }
}

// ===============================================================================================================
// AC-7.4, 7.7: the assets of a version, from the bucket

mod assets {
    use super::*;

    fn has_image(pdf: &[u8]) -> bool {
        let text = String::from_utf8_lossy(pdf);
        text.contains("/Subtype/Image") || text.contains("/Subtype /Image")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_logo_comes_from_the_bucket_and_is_kept_by_asset_id() {
        let Some(world) = World::start().await else {
            return;
        };
        let logo = world
            .fixture
            .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
            .await;
        world
            .fixture
            .save(Entity::WelldIt, config("PLAIN", None), &[])
            .await;
        world
            .fixture
            .save(Entity::WelldIt, config("WITH-LOGO", Some(logo)), &[logo])
            .await;
        let token = world.caller().await;

        let mut plain = small();
        plain["letterheadVersion"] = json!(1);
        let reply = post(&world.server, "/v1/render/pdf", &token, &plain).await;
        assert_eq!(reply.status, 200);
        assert!(!has_image(&reply.body), "version 1 has no logo");

        let reply = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert!(
            has_image(&reply.body),
            "version 2 draws the logo that is in the bucket"
        );

        // Cached by id: the object is gone from the bucket, and the next render does not need it.
        world.fixture.bucket.delete(logo).await;
        let again = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_eq!(again.status, 200, "{}", again.text());
        assert!(has_image(&again.body));
        assert_eq!(again.body, reply.body, "the same bytes, by the same asset");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_an_object_that_is_missing_or_is_not_what_the_database_says_is_a_500_and_never_drawn()
     {
        let Some(world) = World::start().await else {
            return;
        };
        let token = world.caller().await;

        // The bucket has other bytes than the row's SHA-256.
        let tampered = Uuid::new_v4();
        world.fixture.bucket.put(tampered, b"not the logo").await;
        world
            .fixture
            .repo
            .insert_asset(NewAsset {
                id: tampered,
                entity: Entity::WelldIt,
                kind: AssetKind::Logo,
                format: Format::Png,
                sha256: Sha256::digest(PNG).into(),
                bytes: i32::try_from(PNG.len()).expect("small"),
                size_px: Some((2, 1)),
                created_by: "test".into(),
            })
            .await
            .expect("insert");
        world
            .fixture
            .save(Entity::WelldIt, config("T", Some(tampered)), &[tampered])
            .await;
        let reply = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_problem(&reply, 500, "render_failed");
        assert!(!reply.text().contains("not the logo"));

        // The row exists and the object does not.
        let gone = world
            .fixture
            .asset(Entity::WelldCh, AssetKind::Logo, Format::Png, &PNG)
            .await;
        world.fixture.bucket.delete(gone).await;
        world
            .fixture
            .save(Entity::WelldCh, config("G", Some(gone)), &[gone])
            .await;
        let reply = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &request("welld_ch", json!([paragraph("x")])),
        )
        .await;
        assert_problem(&reply, 500, "render_failed");

        let lines = world.server.request_lines(2).await;
        assert!(
            lines.iter().any(|l| l.contains("outcome=asset_corrupt")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.contains("outcome=asset_missing")),
            "{lines:?}"
        );
    }

    /// A bucket that does not answer is a 503 with `Retry-After`, not a hang and not a document without a logo.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_bucket_that_is_down_is_503_with_retry_after_for_a_version_that_needs_it_only()
    {
        let Some(fixture) = Fixture::new().await else {
            return;
        };
        let logo = fixture
            .asset(Entity::WelldIt, AssetKind::Logo, Format::Png, &PNG)
            .await;
        fixture
            .save(Entity::WelldIt, config("NO-LOGO", None), &[])
            .await;
        fixture
            .save(Entity::WelldIt, config("LOGO", Some(logo)), &[logo])
            .await;
        let auth = FakeAuth::start(clients()).await;
        // Nothing listens on this port.
        let dead = format!("http://localhost:{}", free_port());
        let server = Server::start(
            &fixture.env,
            &Settings {
                workers: 1,
                queue: 1,
                worker_rss_mb: None,
                schema_url: fixture.schema_url.clone(),
                jwks_url: auth.jwks_url.clone(),
                auth_base: auth.base.clone(),
                s3_endpoint: dead,
            },
        )
        .await;
        let token = auth.mint("letterhead-test-caller", "caller-secret").await;

        let started = Instant::now();
        let reply = post(&server, "/v1/render/pdf", &token, &small()).await;
        assert_problem(&reply, 503, "render_unavailable");
        assert_eq!(reply.header("retry-after").as_deref(), Some("2"));
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "bounded: {:?}",
            started.elapsed()
        );

        // Version 1 needs no bucket: it still renders.
        let mut plain = small();
        plain["letterheadVersion"] = json!(1);
        let reply = post(&server, "/v1/render/pdf", &token, &plain).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
    }
}

// ===============================================================================================================
// AC-3.5: busy

mod busy {
    use super::*;

    /// A document that keeps one worker busy for a good while: a table of many rows.
    fn heavy() -> Value {
        let rows: Vec<Value> = (0..500)
            .map(|n| {
                json!([
                    cell(&format!("row {n}")),
                    cell("a longer description of the row"),
                    cell("12.00")
                ])
            })
            .collect();
        request(
            "welld_it",
            json!([{ "type": "table", "columns": [1, 4, 1], "rows": rows }]),
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_pool_that_is_full_answers_429_busy_with_retry_after_and_serves_again_after() {
        let Some(world) = World::with_pool(1, 0).await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        // Warm: the first render of a worker loads its fonts.
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &small())
                .await
                .status,
            200
        );

        let first = {
            let (url, token, body) = (
                world.server.url("/v1/render/pdf"),
                token.clone(),
                heavy().to_string(),
            );
            tokio::spawn(async move {
                send(
                    http()
                        .post(url)
                        .header("authorization", format!("Bearer {token}"))
                        .body(body),
                )
                .await
            })
        };
        // Wait until the worker is taken: the second request must find the pool full.
        let mut busy = None;
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(20) {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let reply = post(&world.server, "/v1/render/pdf", &token, &small()).await;
            if reply.status == 429 {
                busy = Some(reply);
                break;
            }
        }
        let busy = busy.expect("a 429 while the only worker is busy");
        assert_problem(&busy, 429, "busy");
        assert_eq!(busy.header("retry-after").as_deref(), Some("2"));
        assert!(!busy.text().contains(MARKER));

        let first = first.await.expect("join");
        assert!(
            first.status == 200 || first.status == 504,
            "the first one finished: {}",
            first.status
        );
        // And the pool serves again.
        let after = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_eq!(after.status, 200, "{}", after.text());
    }
    /// The place in the pool is taken before the body is read: a request that will be turned away is turned away
    /// on its head, with no body sent and none read (amendment 2026-11-17: request admission is bounded before
    /// parsing large bodies).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_request_that_finds_the_pool_full_is_turned_away_before_its_body_is_read() {
        let Some(world) = World::with_pool(1, 0).await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &small())
                .await
                .status,
            200
        );
        let holder = {
            let (url, token, body) = (
                world.server.url("/v1/render/pdf"),
                token.clone(),
                heavy().to_string(),
            );
            tokio::spawn(async move {
                send(
                    http()
                        .post(url)
                        .header("authorization", format!("Bearer {token}"))
                        .body(body),
                )
                .await
            })
        };
        let port = world.server.port;
        let started = Instant::now();
        let line = loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let token = token.clone();
            let line = tokio::task::spawn_blocking(move || {
                answer_to_head_alone(port, &token, 15 * 1024 * 1024)
            })
            .await
            .expect("join");
            // While the worker is free this waits for a body that never comes (5 s), and says nothing.
            if line.contains("429") {
                break line;
            }
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "no 429: {line:?}"
            );
        };
        assert!(line.contains("429"), "{line:?}");
        let _ = holder.await;
    }

    /// A caller that goes away in the middle of a render: the line is written, and the worker is not left running.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_caller_that_goes_away_leaves_its_line_and_frees_the_worker() {
        let Some(world) = World::with_pool(1, 0).await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &small())
                .await
                .status,
            200
        );

        // Give up after half a second: the connection is closed with the render still running.
        let gave_up = tokio::time::timeout(
            Duration::from_millis(500),
            post(&world.server, "/v1/render/pdf", &token, &heavy()),
        )
        .await;
        assert!(gave_up.is_err(), "the heavy render takes longer than that");

        // The line says so, and the only worker is free again well before the heavy render would have ended.
        let started = Instant::now();
        loop {
            let lines = world.server.request_lines(2).await;
            if lines
                .iter()
                .any(|l| l.contains("outcome=client_closed") && l.contains("status=499"))
            {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "no line for the caller that left: {lines:#?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let after = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_eq!(after.status, 200, "the worker was freed: {}", after.text());
    }

    /// A worker that is killed in the middle of a render (the OOM killer, a crash): the caller gets the 503 that
    /// the orchestrator's note names, with `Retry-After`, and the pool has a new worker for the next request.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_worker_that_dies_mid_render_is_503_with_retry_after_and_the_next_request_is_served()
     {
        let Some(world) = World::with_pool(1, 0).await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config("F", None), &[])
            .await;
        let token = world.caller().await;
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &small())
                .await
                .status,
            200
        );

        let victim = {
            let (url, token, body) = (
                world.server.url("/v1/render/pdf"),
                token.clone(),
                heavy().to_string(),
            );
            tokio::spawn(async move {
                send(
                    http()
                        .post(url)
                        .header("authorization", format!("Bearer {token}"))
                        .body(body),
                )
                .await
            })
        };
        // The only worker is taken when a second request is turned away.
        let started = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let probe = post(&world.server, "/v1/render/pdf", &token, &small()).await;
            if probe.status == 429 {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "the worker never looked busy"
            );
        }
        // The workers are the children of the supervisor.
        let killed = Command::new("pkill")
            .args(["-KILL", "-P", &world.server.child.id().to_string()])
            .status()
            .expect("pkill");
        assert!(killed.success(), "a worker to kill");

        let reply = victim.await.expect("join");
        assert_problem(&reply, 503, "render_unavailable");
        assert_eq!(reply.header("retry-after").as_deref(), Some("2"));
        assert!(!reply.body.starts_with(b"%PDF"));

        let after = post(&world.server, "/v1/render/pdf", &token, &small()).await;
        assert_eq!(
            after.status,
            200,
            "a new worker took its place: {}",
            after.text()
        );
        let lines = world.server.request_lines(3).await;
        assert!(
            lines
                .iter()
                .any(|l| l.contains("outcome=worker_failed") && l.contains("status=503")),
            "{lines:#?}"
        );
    }
}

// ===============================================================================================================
// AC-3.2, 3.7: the log

mod log {
    use super::*;

    /// Every place of a request that can hold text, holding the marker.
    fn marked() -> Value {
        json!({
            "contentVersion": 1, "entity": "welld_it", "language": "en",
            "entityData": { "legalName": MARKER, "addressLines": [MARKER], "vat": MARKER, "iban": MARKER, "contacts": MARKER },
            "blocks": [
                { "type": "heading", "level": 1, "text": MARKER },
                paragraph(MARKER),
                { "type": "list", "items": [{ "runs": [{ "text": MARKER, "bold": true }] }] },
                { "type": "table", "columns": [1, 1], "header": [cell(MARKER), cell(MARKER)], "rows": [[cell(MARKER), cell(MARKER)]] },
            ]
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_each_request_leaves_one_line_with_the_caller_entity_outcome_pages_and_time_and_no_content()
     {
        let Some(world) = World::start().await else {
            return;
        };
        world
            .fixture
            .save(Entity::WelldIt, config(MARKER, None), &[])
            .await;
        let token = world.caller().await;

        // Success: preview and PDF.
        assert_eq!(
            post(&world.server, "/v1/render/preview", &token, &marked())
                .await
                .status,
            200
        );
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &marked())
                .await
                .status,
            200
        );
        // Content refused.
        let mut bad = marked();
        bad["blocks"][1]["runs"][0]["style"] = json!(MARKER);
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &bad)
                .await
                .status,
            422
        );
        let mut other_entity = marked();
        other_entity["entity"] = json!(MARKER);
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &other_entity)
                .await
                .status,
            422
        );
        // Version problems.
        let mut named = marked();
        named["letterheadVersion"] = json!(9);
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &named)
                .await
                .status,
            404
        );
        let mut ch = marked();
        ch["entity"] = json!("welld_ch");
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &ch)
                .await
                .status,
            409
        );
        // No credential, and a bad one that holds the marker.
        assert_eq!(
            post_bytes(
                &world.server,
                "/v1/render/pdf",
                None,
                marked().to_string().into_bytes()
            )
            .await
            .status,
            401
        );
        assert_eq!(
            post_bytes(
                &world.server,
                "/v1/render/pdf",
                Some(MARKER),
                marked().to_string().into_bytes()
            )
            .await
            .status,
            401
        );
        // Too large and not JSON.
        assert_eq!(
            post_bytes(
                &world.server,
                "/v1/render/pdf",
                Some(&token),
                vec![b' '; 20 * 1024 * 1024 + 1]
            )
            .await
            .status,
            413
        );
        assert_eq!(
            post_bytes(
                &world.server,
                "/v1/render/pdf",
                Some(&token),
                MARKER.as_bytes().to_vec()
            )
            .await
            .status,
            422
        );
        let requests = 10;

        let lines = world.server.request_lines(requests).await;
        assert_eq!(
            lines.len(),
            requests,
            "one line for each request: {lines:#?}"
        );
        let find = |needle: &str| -> &String {
            lines
                .iter()
                .find(|l| l.contains(needle))
                .unwrap_or_else(|| panic!("{needle} not in {lines:#?}"))
        };
        // The fields of the first (a success): caller, entity, outcome, pages, ms.
        let ok = find("route=preview");
        assert!(ok.contains("caller=system:letterhead-test-caller"), "{ok}");
        assert!(ok.contains("entity=welld_it"), "{ok}");
        assert!(
            ok.contains("outcome=ok") && ok.contains("status=200"),
            "{ok}"
        );
        assert!(ok.contains("pages=1"), "{ok}");
        let milliseconds = ok
            .rsplit("ms=")
            .next()
            .and_then(|m| m.split(' ').next())
            .expect("ms");
        assert!(milliseconds.parse::<u64>().is_ok(), "{ok}");
        let unauthorized: Vec<&String> = lines
            .iter()
            .filter(|l| l.contains("outcome=unauthorized"))
            .collect();
        assert_eq!(unauthorized.len(), 2, "{lines:#?}");
        assert!(
            unauthorized
                .iter()
                .all(|l| l.contains("caller=- ") && l.contains("status=401")),
            "{unauthorized:?}"
        );
        assert!(find("outcome=request_too_large").contains("status=413"));
        assert!(find("outcome=letterhead_version_not_found").contains("entity=welld_it"));
        assert!(find("outcome=letterhead_not_configured").contains("entity=welld_ch"));
        assert!(
            find("outcome=unknown_entity").contains("entity=-"),
            "an entity that was not understood is not logged"
        );

        // Stop, and read everything the process ever wrote: the marker is nowhere in it.
        let (out, err) = world.server.stop();
        for line in out.iter().chain(err.iter()) {
            assert!(!line.contains(MARKER), "content in the log: {line}");
            assert!(!line.contains("ZQX"), "content in the log: {line}");
        }
        for line in out.iter().filter(|l| l.starts_with("render ")) {
            assert!(!line.contains('{') && !line.contains('"'), "{line}");
        }
    }
}

// ===============================================================================================================
// T22: the issuer's details are the registry's (AC-1.5, AC-5.1, AC-5.2, AC-5.3, AC-5.5; plan decisions 7 and 8, E12)

mod issuer {
    use super::*;

    /// A footer that prints every detail of the issuer, one line each (all placeholders, both languages).
    fn issuer_config() -> Value {
        let line = |text: &str| json!({ "text": { "it": text, "en": text }, "size": 8.0, "bold": false, "color": "595c69" });
        let mut config = serde_json::to_value(default_config()).expect("json");
        config["variants"]["default"]["footer"]["left"] = json!([
            line("NAME={legal_name}"),
            line("ADDR={address}"),
            line("VAT={vat}"),
            line("IBAN={iban}"),
            line("CONTACTS={contacts}"),
        ]);
        // Five lines do not fit the default margin of 25 mm.
        config["margins"]["bottom"] = json!(45.0);
        config
    }

    async fn world_with_letterheads() -> Option<World> {
        let world = World::start().await?;
        for entity in [Entity::WelldIt, Entity::WelldCh] {
            world.fixture.save(entity, issuer_config(), &[]).await;
        }
        Some(world)
    }

    fn v2(entity: &str, language: &str) -> Value {
        json!({ "contentVersion": 2, "entity": entity, "language": language,
                "blocks": [paragraph("Body")] })
    }

    fn text_of(reply: &Reply) -> String {
        page_texts(reply).join("\n")
    }

    /// AC-5.1: v2, each entity and each language: the registry's legal name, `address[language]` joined with ", ",
    /// the VAT number, `ibanPrint` and `contacts[language]`; the Italian and the English address differ in print.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_v2_prints_the_registrys_details_for_each_entity_and_language() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        let token = world.caller().await;
        let expected = [
            (
                "welld_it",
                "it",
                3,
                [
                    "NAME=Registry Italia S.r.l.",
                    "ADDR=Via Roma 1, 20121 Milano",
                    "VAT=IT01234567890",
                    "IBAN=IT60 X054 2811 1010 0000 0123 457",
                    "CONTACTS=Tel. 02 000 0000",
                ],
            ),
            (
                "welld_it",
                "en",
                3,
                [
                    "NAME=Registry Italia S.r.l.",
                    "ADDR=Via Roma 1, 20121 Milan",
                    "VAT=IT01234567890",
                    "IBAN=IT60 X054 2811 1010 0000 0123 457",
                    "CONTACTS=Phone 02 000 0000",
                ],
            ),
            (
                "welld_ch",
                "it",
                5,
                [
                    "NAME=Registry Svizzera SA",
                    "ADDR=Via Cantonale 1, 6900 Lugano, Svizzera",
                    "VAT=CHE-123.456.789 IVA",
                    "IBAN=CH93 0076 2011 6238 5295 7",
                    "CONTACTS=Tel. +41 91 000 00 00",
                ],
            ),
            (
                "welld_ch",
                "en",
                5,
                [
                    "NAME=Registry Svizzera SA",
                    "ADDR=Via Cantonale 1, 6900 Lugano, Switzerland",
                    "VAT=CHE-123.456.789 IVA",
                    "IBAN=CH93 0076 2011 6238 5295 7",
                    "CONTACTS=Phone +41 91 000 00 00",
                ],
            ),
        ];
        for (entity, language, version, lines) in expected {
            let document = v2(entity, language);
            let preview = post(&world.server, "/v1/render/preview", &token, &document).await;
            assert_eq!(
                preview.status,
                200,
                "{entity} {language}: {}",
                preview.text()
            );
            let text = text_of(&preview);
            for line in lines {
                assert!(
                    text.contains(line),
                    "{entity} {language}: {line:?} not in {text:?}"
                );
            }
            assert_eq!(preview.json()["missingPlaceholders"], json!([]));
            assert_eq!(preview.json()["legalEntityVersion"], version);

            let pdf = post(&world.server, "/v1/render/pdf", &token, &document).await;
            assert_eq!(pdf.status, 200, "{entity} {language}: {}", pdf.text());
            assert_eq!(
                pdf.header("legal-entity-version"),
                Some(version.to_string()),
                "the PDF says which version of the details it printed"
            );
            assert_eq!(pdf.header("missing-placeholders").as_deref(), Some(""));
        }
        // Eight documents, two entities: the registry was read once (a fresh entry is used without a call) with
        // one token of the service's own client.
        assert_eq!(world.auth.registry.reads(), 1);
        assert_eq!(world.auth.registry.exchanges.load(Ordering::SeqCst), 1);
    }

    /// AC-5.2 (E12): `entityData` is parsed and thrown away, in both content versions. The log says so.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_entity_data_of_the_request_is_ignored_in_v1_and_v2_and_the_log_says_so() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        let token = world.caller().await;
        let evil = json!({ "legalName": "EVIL SA", "addressLines": ["EVIL street 1"], "vat": "EVIL-VAT",
                           "iban": "EVIL-IBAN", "contacts": "EVIL contacts" });
        let mut v1 = request("welld_it", json!([paragraph("Body")]));
        v1["entityData"] = evil.clone();
        let mut second = v2("welld_it", "en");
        second["entityData"] = evil;
        let plain = v2("welld_it", "en");
        for (name, document) in [("v1", v1), ("v2", second)] {
            for route in ["/v1/render/preview", "/v1/render/pdf"] {
                let reply = post(&world.server, route, &token, &document).await;
                assert_eq!(reply.status, 200, "{name} {route}: {}", reply.text());
                if route.ends_with("preview") {
                    let text = text_of(&reply);
                    assert!(
                        text.contains("NAME=Registry Italia S.r.l."),
                        "{name}: {text}"
                    );
                    assert!(!text.contains("EVIL"), "{name}: {text}");
                } else {
                    assert_eq!(reply.header("missing-placeholders").as_deref(), Some(""));
                    assert!(
                        !String::from_utf8_lossy(&reply.body).contains("EVIL"),
                        "{name}"
                    );
                }
            }
        }
        assert_eq!(
            post(&world.server, "/v1/render/pdf", &token, &plain)
                .await
                .status,
            200
        );
        let lines = world.server.request_lines(5).await;
        let ignored = lines
            .iter()
            .filter(|l| l.ends_with("legal_entity_version=3 entity_data_ignored=true"))
            .count();
        let kept = lines
            .iter()
            .filter(|l| l.ends_with("legal_entity_version=3 entity_data_ignored=false"))
            .count();
        assert_eq!((ignored, kept), (4, 1), "{lines:#?}");
    }

    /// AC-5.3: an empty value is a missing one (the registry's `""` and `[]`), for the IBAN and the contacts and for
    /// the rest: nothing else is put in its place, and the answer lists it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_an_empty_iban_or_contacts_is_missing_and_prints_nothing() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        world.auth.registry.set("welld_it", "ibanPrint", json!(""));
        world.auth.registry.set("welld_it", "iban", json!(""));
        world
            .auth
            .registry
            .set("welld_it", "contacts", json!({ "it": "", "en": "" }));
        world
            .auth
            .registry
            .set("welld_it", "address", json!({ "it": [], "en": [] }));
        let token = world.caller().await;
        let document = v2("welld_it", "it");
        let preview = post(&world.server, "/v1/render/preview", &token, &document).await;
        assert_eq!(preview.status, 200, "{}", preview.text());
        assert_eq!(
            preview.json()["missingPlaceholders"],
            json!(["address", "contacts", "iban"])
        );
        let text = text_of(&preview);
        assert!(text.contains("NAME=Registry Italia S.r.l."), "{text}");
        assert!(text.contains("VAT=IT01234567890"), "{text}");
        assert!(!text.contains('⟦'), "no mark on a render: {text}");
        let pdf = post(&world.server, "/v1/render/pdf", &token, &document).await;
        assert_eq!(pdf.status, 200, "{}", pdf.text());
        assert_eq!(
            pdf.header("missing-placeholders").as_deref(),
            Some("address,contacts,iban")
        );
        // The other entity is untouched.
        let other = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &v2("welld_ch", "it"),
        )
        .await;
        assert_eq!(other.header("missing-placeholders").as_deref(), Some(""));
    }

    /// Plan decision 8: a pin that is not the version held makes the service read again, once. A pin the new read
    /// agrees with renders; one it does not is a 409 with the version in use, and nothing is rendered. The read is
    /// forced at most once per second per process (security review F6): a mismatch inside that second is the 409
    /// at once, without a call.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_pin_that_differs_refreshes_once_and_a_pin_that_still_differs_is_409() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        let token = world.caller().await;
        // Version 3 is read and held.
        let first = post(
            &world.server,
            "/v1/render/preview",
            &token,
            &v2("welld_it", "it"),
        )
        .await;
        assert_eq!(first.json()["legalEntityVersion"], 3);
        assert_eq!(world.auth.registry.reads(), 1);

        // The pin that is held costs no call.
        let mut pinned = v2("welld_it", "it");
        pinned["legalEntityVersion"] = json!(3);
        let reply = post(&world.server, "/v1/render/preview", &token, &pinned).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert_eq!(world.auth.registry.reads(), 1);

        // Somebody saved version 4 and the caller saw it: the pin is ahead of the held entry, one call brings it
        // (the entry is older than the second in which a mismatch is answered without a call).
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        world.auth.registry.set("welld_it", "version", json!(4));
        world.auth.registry.set(
            "welld_it",
            "legalName",
            json!("Registry Italia Nuova S.r.l."),
        );
        pinned["legalEntityVersion"] = json!(4);
        let reply = post(&world.server, "/v1/render/pdf", &token, &pinned).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert_eq!(reply.header("legal-entity-version").as_deref(), Some("4"));
        assert_eq!(world.auth.registry.reads(), 2);
        // ... and it is held now: no pin, no call, the new version.
        let reply = post(
            &world.server,
            "/v1/render/preview",
            &token,
            &v2("welld_it", "it"),
        )
        .await;
        assert!(text_of(&reply).contains("NAME=Registry Italia Nuova S.r.l."));
        assert_eq!(world.auth.registry.reads(), 2);

        // An older pin (the caller's own cache is behind): the 409 at once
        // with the version in use, no call.
        for route in ["/v1/render/pdf", "/v1/render/preview"] {
            pinned["legalEntityVersion"] = json!(3);
            let reply = post(&world.server, route, &token, &pinned).await;
            assert_problem(&reply, 409, "legal_entity_version_mismatch");
            assert_eq!(reply.json()["currentVersion"], 4);
            assert!(!reply.body.starts_with(b"%PDF"));
            let text = reply.text();
            assert!(
                !text.contains("Nuova") && !text.contains("IT0123"),
                "{text}"
            );
        }
        assert_eq!(world.auth.registry.reads(), 2);

        // A second later the same older pin still makes no call: no read can make it current (N2).
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        let reply = post(&world.server, "/v1/render/pdf", &token, &pinned).await;
        assert_problem(&reply, 409, "legal_entity_version_mismatch");
        assert_eq!(reply.json()["currentVersion"], 4);
        assert_eq!(world.auth.registry.reads(), 2);

        // The refusal is in the log with the version, and it made no document (no pages).
        let lines = world.server.request_lines(7).await;
        let refused: Vec<&String> = lines
            .iter()
            .filter(|l| l.contains("outcome=legal_entity_version_mismatch"))
            .collect();
        assert_eq!(refused.len(), 3, "{lines:#?}");
        assert!(
            refused.iter().all(|l| l.contains("status=409")
                && l.contains("pages=-")
                && l.contains("legal_entity_version=4")),
            "{refused:?}"
        );

        // `legalEntityVersion` is a member of content version 2 only.
        let mut v1 = request("welld_it", json!([paragraph("Body")]));
        v1["legalEntityVersion"] = json!(4);
        let reply = post(&world.server, "/v1/render/pdf", &token, &v1).await;
        assert_problem(&reply, 422, "invalid_content");
    }

    /// AC-5.5: the registry cannot be read and there is no entry: 503 `legal_entities_unavailable` with
    /// `Retry-After: 5`, no document, no body of one, and the worker is never asked (the letterhead's own refusals
    /// come after).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_registry_down_and_no_entry_is_503_with_retry_after_and_no_document() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        world.auth.registry.down(true);
        let token = world.caller().await;
        for route in ["/v1/render/pdf", "/v1/render/preview"] {
            let reply = post(&world.server, route, &token, &v2("welld_it", "it")).await;
            assert_problem(&reply, 503, "legal_entities_unavailable");
            assert_eq!(reply.header("retry-after").as_deref(), Some("5"));
            assert!(!reply.body.starts_with(b"%PDF"));
            assert!(reply.json().get("pages").is_none());
        }
        // It is checked before the letterhead: an entity with none configured is the same 503, not a 409.
        world
            .fixture
            .save(Entity::WelldIt, issuer_config(), &[])
            .await;
        let lines = world.server.request_lines(2).await;
        assert!(
            lines
                .iter()
                .all(|l| l.contains("outcome=legal_entities_unavailable")
                    && l.contains("status=503")
                    && l.contains("pages=-")),
            "{lines:#?}"
        );

        // `auth` comes back: the next request is served (nothing is remembered of the failure).
        world.auth.registry.down(false);
        let reply = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &v2("welld_it", "it"),
        )
        .await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        // The service did not log a detail of the registry: only closed words and numbers.
        let (out, err) = world.server.stop();
        for line in out.iter().chain(err.iter()) {
            assert!(!line.contains("Registry"), "{line}");
            assert!(!line.contains(SERVICE_CLIENT_SECRET), "{line}");
        }
        assert!(
            out.iter()
                .any(|l| l.starts_with("registry event=legal_entities_unavailable")),
            "{out:#?}"
        );
    }

    /// AC-5.5 on the real clock: an entry that was read is used while `auth` is down until it is 60 s old, and not
    /// after. (The boundaries 29, 31, 59 and 61 s are `tests/registry.rs`; this is the route's answer to them.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_an_entry_older_than_60_seconds_is_not_used_when_auth_is_down() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        let token = world.caller().await;
        let document = v2("welld_it", "it");
        let first = post(&world.server, "/v1/render/pdf", &token, &document).await;
        assert_eq!(first.status, 200, "{}", first.text());
        let read = Instant::now();
        world.auth.registry.down(true);

        // Past the 30 s that a fresh entry is used for: a refresh is tried, fails, and the entry (31 s) is used.
        tokio::time::sleep(Duration::from_secs(32)).await;
        let stale = post(&world.server, "/v1/render/pdf", &token, &document).await;
        assert_eq!(stale.status, 200, "an entry of 32 s: {}", stale.text());
        assert_eq!(stale.header("legal-entity-version").as_deref(), Some("3"));
        assert!(world.auth.registry.reads() >= 2, "a refresh was tried");

        // Past 60 s: no document from details that old.
        tokio::time::sleep(Duration::from_secs(62).saturating_sub(read.elapsed())).await;
        for route in ["/v1/render/pdf", "/v1/render/preview"] {
            let reply = post(&world.server, route, &token, &document).await;
            assert_problem(&reply, 503, "legal_entities_unavailable");
            assert_eq!(reply.header("retry-after").as_deref(), Some("5"));
            assert!(!reply.body.starts_with(b"%PDF"));
        }
        let (out, _) = world.server.stop();
        assert!(
            out.iter()
                .any(|l| l.starts_with("registry event=registry_stale_used")),
            "{out:#?}"
        );
    }

    /// R9: real details are longer than the sample's: a 200-character legal name that does not fit the footer is
    /// 422 `footer_overflow` on both routes (the CRM maps it to `letterhead_overflow`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_legal_name_that_overflows_the_footer_is_422_footer_overflow() {
        let Some(world) = World::start().await else {
            return;
        };
        let mut config = issuer_config();
        // A large name: 200 characters wrap over several lines of it, and the margin is the 45 mm of the others.
        config["variants"]["default"]["footer"]["left"][0]["size"] = json!(12.0);
        world.fixture.save(Entity::WelldIt, config, &[]).await;
        let token = world.caller().await;

        // The sample-sized name fits.
        let fits = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &v2("welld_it", "it"),
        )
        .await;
        assert_eq!(fits.status, 200, "{}", fits.text());
        // The entry is older than the second in which a mismatching pin is answered without a call.
        tokio::time::sleep(Duration::from_millis(1_100)).await;

        let long = "Societa di Prova per la Verifica del Margine ".repeat(5);
        assert!(long.chars().count() >= 200);
        world
            .auth
            .registry
            .set("welld_it", "legalName", json!(long));
        world.auth.registry.set("welld_it", "version", json!(4));
        let mut document = v2("welld_it", "it");
        // The pin makes the service read the new name now rather than in 30 s.
        document["legalEntityVersion"] = json!(4);
        for route in ["/v1/render/pdf", "/v1/render/preview"] {
            let reply = post(&world.server, route, &token, &document).await;
            assert_problem(&reply, 422, "footer_overflow");
            assert!(!reply.body.starts_with(b"%PDF"));
            assert!(!reply.text().contains("Societa"), "{}", reply.text());
        }
    }

    /// Security review F6: a caller that sends a pin that is never the version in use cannot make every request a
    /// call to `auth`. 100 renders with a mismatching pin inside one second are at most one registry call, each is
    /// the 409 with `currentVersion`; after a second a mismatch reads again; a matching pin makes no call.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_mismatching_pin_is_one_registry_call_per_second_at_most() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        let token = world.caller().await;
        let mut pinned = v2("welld_it", "it");
        pinned["legalEntityVersion"] = json!(99);

        let started = Instant::now();
        for _ in 0..100 {
            let reply = post(&world.server, "/v1/render/pdf", &token, &pinned).await;
            assert_problem(&reply, 409, "legal_entity_version_mismatch");
            assert_eq!(reply.json()["currentVersion"], 3);
        }
        let within = started.elapsed() < Duration::from_millis(900);
        // The first request read the registry (no entry yet); nothing else did inside the second.
        let reads = world.auth.registry.reads();
        if within {
            assert_eq!(reads, 1);
        } else {
            // A slow machine: the second passed, so one forced read per second is the bound.
            let seconds = started.elapsed().as_secs() + 1;
            assert!(reads as u64 <= 1 + seconds, "{reads} reads in {seconds} s");
        }

        // A matching pin makes no call.
        pinned["legalEntityVersion"] = json!(3);
        let before = world.auth.registry.reads();
        let reply = post(&world.server, "/v1/render/pdf", &token, &pinned).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert_eq!(world.auth.registry.reads(), before);

        // After a second a mismatch refreshes again: a save of version 4 is seen by the pin 4.
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        world.auth.registry.set("welld_it", "version", json!(4));
        let before = world.auth.registry.reads();
        pinned["legalEntityVersion"] = json!(4);
        let reply = post(&world.server, "/v1/render/pdf", &token, &pinned).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert_eq!(reply.header("legal-entity-version").as_deref(), Some("4"));
        assert_eq!(world.auth.registry.reads(), before + 1);
    }

    /// Delta review T76-1: a newer pin makes a forced read, and `auth` is failing. The entry held is the fallback of
    /// that read (it was not thrown away first): unpinned and matching-pin renders still answer from it, and the pin
    /// that is newer gets the 409 with the version in use, not a 503 for everybody.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_a_failed_pin_refresh_keeps_the_held_entry_for_everybody_else() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        let token = world.caller().await;
        let first = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &v2("welld_it", "it"),
        )
        .await;
        assert_eq!(first.status, 200, "{}", first.text());
        tokio::time::sleep(Duration::from_millis(1_100)).await;

        world.auth.registry.down(true);
        let mut pinned = v2("welld_it", "it");
        pinned["legalEntityVersion"] = json!(4);
        let reply = post(&world.server, "/v1/render/pdf", &token, &pinned).await;
        assert_problem(&reply, 409, "legal_entity_version_mismatch");
        assert_eq!(reply.json()["currentVersion"], 3);

        let unpinned = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &v2("welld_it", "it"),
        )
        .await;
        assert_eq!(unpinned.status, 200, "{}", unpinned.text());
        pinned["legalEntityVersion"] = json!(3);
        let matching = post(&world.server, "/v1/render/pdf", &token, &pinned).await;
        assert_eq!(matching.status, 200, "{}", matching.text());
        assert_eq!(
            matching.header("legal-entity-version").as_deref(),
            Some("3")
        );
    }

    /// The service reads the registry as its own client: with the scope `legal-entities:read` (the stub refuses a
    /// token without it) and never with the caller's token.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn render_the_registry_is_read_with_the_services_own_token() {
        let Some(world) = world_with_letterheads().await else {
            return;
        };
        let token = world.caller().await;
        let reply = post(
            &world.server,
            "/v1/render/pdf",
            &token,
            &v2("welld_ch", "en"),
        )
        .await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert_eq!(world.auth.registry.exchanges.load(Ordering::SeqCst), 1);
        assert_eq!(world.auth.registry.reads(), 1);
    }
}
