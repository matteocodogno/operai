//! letterhead-api — the supervisor: HTTP, authentication, the worker pool, the database and the bucket.
//!
//! Modes, by first argument:
//! - none: validate the environment, then serve. An invalid environment exits 1 before any socket is opened, and
//!   so does a database that is not reachable or not migrated. `serve` never migrates.
//! - `migrate`: apply the embedded migrations and exit (Railway's `preDeploy`, compose's one-shot service,
//!   `mise run db:migrate`). It reads `DATABASE_URL` and nothing else, and never prints it. Exits 0 when there
//!   is nothing left to apply.
//! - `healthcheck`: GET /health on this container's own port, exit 0 on 200 (the image has no curl or wget).
//! - `worker`: a render worker, started by the supervisor's pool with an empty environment. It reads jobs on stdin
//!   and writes results on stdout and reads no variable, so it never validates or prints the environment.
//!
//! Layout rule (ADR 20261116-letterhead-api-is-a-rust-service-with-typst-embedded-for-document-layout-only):
//! this crate is the only one that does I/O; `letterhead-engine` stays pure.

mod auth;
mod authz;
mod db;
mod env;
mod health;
mod log;
// What the render routes do not use: the pool's own inspection (`idle_pids`, `waiting`), its one-call `render`
// and the test layouts' hooks. The worker mode and the tests use those.
#[expect(
    dead_code,
    reason = "parts of the pool are for the worker mode and the tests; the routes use admit, run and shutdown"
)]
mod pool;
// The registry's reads (`entity_data`, `get`, `invalidate`) are for the render and preview routes (T22, T23): until
// they take them, only the wiring below is used.
#[expect(
    dead_code,
    reason = "T21 builds the client of the legal entities registry; the routes that read it come with T22 and T23"
)]
mod registry;
mod routes;
mod storage;
mod worker;

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use axum::{Router, http::StatusCode, response::IntoResponse, response::Response};

use auth::person::PersonAuth;
use auth::service::ServiceAuth;
use authz::resolve::AuthzClient;

use db::Repo;
use env::{Config, DEFAULT_PORT};
use pool::{Pool, PoolConfig, WorkerCommand};
use routes::{ApiError, AppState};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => serve(),
        [mode] if mode == "healthcheck" => healthcheck(),
        [mode] if mode == "migrate" => migrate(),
        [mode, rest @ ..] if mode == "worker" => worker::run(rest),
        _ => {
            eprintln!("usage: letterhead-api [migrate | healthcheck | worker]");
            ExitCode::from(2)
        }
    }
}

/// The environment, validated; or the text to print before exiting 1.
fn startup(config: Result<Config, env::ConfigError>) -> Result<Config, String> {
    config
        .map_err(|e| format!("letterhead-api: refusing to start, the environment is invalid:\n{e}"))
}

fn serve() -> ExitCode {
    let config = match startup(Config::from_env()) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("letterhead-api: cannot start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("letterhead-api: {message}");
            ExitCode::FAILURE
        }
    }
}

/// What can be said about a failure of the database: a category, or what the server itself answered. Never the
/// URL, and never a driver message that might quote it.
fn describe(error: &sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(e) => format!("the database answered: {}", e.message()),
        sqlx::Error::Configuration(_) => "DATABASE_URL is not usable".to_owned(),
        sqlx::Error::Io(_) | sqlx::Error::Tls(_) => "the database cannot be reached".to_owned(),
        sqlx::Error::PoolTimedOut => "the database did not answer in time".to_owned(),
        _ => "the database could not be used".to_owned(),
    }
}

/// How many connections the supervisor holds: a request uses one at a time, and at most the pool and its queue
/// are in a request together.
const DB_CONNECTIONS: u32 = 10;

/// The pool's settings from the environment: the workers, the queue and the cap on one worker's resident memory
/// (`LH_WORKER_RSS_MB`, in MiB). Without the last line the variable would be validated and then ignored, and the
/// pool would always cap at `DEFAULT_RSS_CAP_MB`.
fn pool_config(config: &Config, command: WorkerCommand) -> PoolConfig {
    let mut pool_config = PoolConfig::new(config.workers, config.queue, command);
    pool_config.rss_cap_bytes = config.worker_rss_mb * 1024 * 1024;
    pool_config
}

async fn run(config: Config) -> Result<(), String> {
    let repo = Repo::connect(config.database_url.expose(), DB_CONNECTIONS)
        .await
        .map_err(|e| describe(&e))?;
    match repo.pending_migrations().await {
        Ok(0) => {}
        Ok(n) => {
            return Err(format!(
                "{n} migration(s) are not applied: run `letterhead-api migrate` first (serve never migrates)"
            ));
        }
        Err(e) => return Err(describe(&e)),
    }
    let command = WorkerCommand::this_binary()
        .map_err(|e| format!("cannot find the worker executable: {}", e.kind()))?;
    let pool = Pool::start(pool_config(&config, command))
        .map_err(|e| format!("cannot start the render workers: {}", e.kind()))?;
    let service_auth = ServiceAuth::new(&config.auth, &config.service_audience)
        .map_err(|_| "cannot build the HTTP client of the key set".to_owned())?;
    let person_auth = PersonAuth::new(&config.auth, &config.service_audience)
        .map_err(|_| "cannot build the HTTP client of the key set".to_owned())?;
    let authorization = AuthzClient::new(&config.auth.base_url)
        .map_err(|_| "cannot build the HTTP client of the permission service".to_owned())?;
    // The registry of the legal entities (T21): the service token and the cache live here, in the supervisor, which
    // is the only process that has the secret. T22 and T23 hand it to the routes.
    let _registry = build_registry(&config)
        .map_err(|_| "cannot build the HTTP client of the legal entities registry".to_owned())?;
    let state = AppState {
        repo,
        pool: pool.clone(),
        storage: Arc::new(storage::Storage::new(&config.s3)),
    };

    let addr = SocketAddr::new(config.bind_ip, config.port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("cannot listen on {addr}: {}", e.kind()))?;
    // Identifiers and numbers only: nothing from the environment's values is printed.
    println!(
        "letterhead-api listening on {addr} (workers {}, queue {})",
        config.workers, config.queue
    );
    let routes = app(
        state,
        Arc::new(service_auth),
        Arc::new(person_auth),
        Arc::new(authorization),
        config.allowed_origins.clone(),
    );
    let served = axum::serve(listener, routes)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    // Workers are killed with the supervisor; this ends the idle ones now and turns away the waiting.
    pool.shutdown();
    served.map_err(|e| format!("the server stopped: {}", e.kind()))
}

/// The client of the legal entities registry: `auth`'s `/system/legal-entities`, read as this service's own client.
fn build_registry(config: &Config) -> Result<registry::Registry, reqwest::Error> {
    let options = registry::RegistryOptions::default();
    let source = registry::HttpSource::new(
        &config.auth.base_url,
        registry::ServiceClient::new(
            config.service_client.id.clone(),
            config.service_client.secret.expose(),
        ),
        options.clock.clone(),
    )?;
    Ok(registry::Registry::new(Arc::new(source), options))
}

/// `letterhead-api migrate`: the embedded migrations, applied. It reads `DATABASE_URL` and nothing else (no
/// bucket, no auth, no pool), so the step that runs it needs none of them. The URL is never printed.
fn migrate() -> ExitCode {
    let url = match std::env::var("DATABASE_URL") {
        Ok(url) if is_postgres_url(url.trim()) => url.trim().to_owned(),
        _ => {
            eprintln!(
                "letterhead-api migrate: DATABASE_URL must be a postgres:// or postgresql:// URL"
            );
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("letterhead-api migrate: cannot start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    let outcome = runtime.block_on(async {
        let repo = Repo::connect(&url, 1).await.map_err(|e| describe(&e))?;
        repo.migrate().await.map_err(|e| match e {
            sqlx::migrate::MigrateError::Execute(e)
            | sqlx::migrate::MigrateError::ExecuteMigration(e, _) => describe(&e),
            // The other variants name a migration number or say what is wrong with the set: no connection text.
            other => other.to_string(),
        })
    });
    match outcome {
        Ok(0) => {
            println!("letterhead-api migrate: the database is up to date");
            ExitCode::SUCCESS
        }
        Ok(n) => {
            println!("letterhead-api migrate: applied {n} migration(s)");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("letterhead-api migrate: {message}");
            ExitCode::FAILURE
        }
    }
}

fn is_postgres_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| matches!(u.scheme(), "postgres" | "postgresql"))
}

/// Everything the supervisor answers: the service routes (a service token), the person routes (a person's token
/// and `letterheads:access`), `/health`, and a problem for the rest. The browser's other origins in
/// `allowed_origins` are answered on the person routes only (`routes::cors`).
fn app(
    state: AppState,
    service_auth: Arc<ServiceAuth>,
    person_auth: Arc<PersonAuth>,
    authorization: Arc<AuthzClient>,
    allowed_origins: Vec<String>,
) -> Router {
    routes::service_router(state.clone(), service_auth)
        .merge(routes::person_router(state, person_auth, authorization))
        .merge(base())
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(allowed_origins),
            routes::cors,
        ))
}

/// The routes that need nothing: `/health`, and the problems for an unknown route or method.
fn base() -> Router {
    health::router()
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
}

async fn not_found() -> Response {
    ApiError::new(StatusCode::NOT_FOUND, "not_found").into_response()
}

async fn method_not_allowed() -> Response {
    ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed").into_response()
}

/// Ctrl-C locally, SIGTERM from Docker and Railway: stop accepting and let requests in flight finish.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sigterm) => {
                sigterm.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

/// The container's HEALTHCHECK: one plain HTTP request to ourselves. Not a client library: std only.
fn healthcheck() -> ExitCode {
    let port = match std::env::var("PORT") {
        Ok(v) => v.trim().parse::<u16>().unwrap_or(0),
        Err(std::env::VarError::NotPresent) => DEFAULT_PORT,
        Err(_) => 0,
    };
    if port == 0 {
        eprintln!("healthcheck: PORT is not a valid port");
        return ExitCode::FAILURE;
    }
    match probe(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => {
            eprintln!("healthcheck: /health did not answer 200");
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("healthcheck: {e}");
            ExitCode::FAILURE
        }
    }
}

fn probe(addr: SocketAddr) -> std::io::Result<bool> {
    let timeout = Duration::from_secs(3);
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut head = [0u8; 12];
    stream.read_exact(&mut head)?;
    Ok(&head == b"HTTP/1.1 200")
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{HeaderValue, Request, header},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    /// AC-3.8: a startup with a non-EU endpoint ends in the failure path that `serve` turns into exit 1.
    /// (`main` is checked end to end on the built binary; see the task report.)
    #[test]
    fn a_non_eu_s3_endpoint_makes_startup_fail() {
        let env = |name: &str| -> Option<String> {
            Some(
                match name {
                    "DATABASE_URL" => "postgresql://u:p@postgres:5432/letterhead",
                    "AUTH_ISSUER" | "AUTH_BASE_URL" => "http://localhost:3001",
                    "AUTH_JWKS_URL" => "http://localhost:3001/auth/jwks",
                    "AUTH_AUDIENCE" => "operai-suite",
                    "SERVICE_AUDIENCE" => "operai-service",
                    "SERVICE_CLIENT_ID" => "letterhead-api",
                    "SERVICE_CLIENT_SECRET" => "main-test-client-secret-0123456789abcdef",
                    "ALLOWED_ORIGINS" => "http://localhost:5173",
                    "LETTERHEAD_S3_ENDPOINT" => "https://s3.us-east-1.amazonaws.com",
                    "LETTERHEAD_S3_REGION" => "us-east-1",
                    "LETTERHEAD_S3_BUCKET" => "letterhead",
                    "LETTERHEAD_S3_ACCESS_KEY_ID" | "LETTERHEAD_S3_SECRET_ACCESS_KEY" => "k",
                    _ => return None,
                }
                .to_owned(),
            )
        };
        let message =
            startup(Config::from_lookup(env)).expect_err("a non-EU region must stop the start");
        assert!(message.contains("refusing to start"), "{message}");
        assert!(message.contains("not an EU AWS region"), "{message}");
    }

    async fn get(path: &str, method: &str) -> (StatusCode, Option<HeaderValue>, Value) {
        let response = base()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let status = response.status();
        let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
        let bytes = to_bytes(response.into_body(), 4096).await.expect("body");
        (
            status,
            content_type,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn health_is_served() {
        let (status, _, body) = get("/health", "GET").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
    }

    #[tokio::test]
    async fn an_unknown_route_is_a_problem_that_does_not_repeat_the_path() {
        let (status, content_type, body) = get("/v1/secret-marker-4711", "GET").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            content_type.expect("content type"),
            "application/problem+json"
        );
        assert_eq!(body["code"], "not_found");
        assert!(!body.to_string().contains("secret-marker-4711"));
    }

    #[tokio::test]
    async fn a_wrong_method_is_a_problem() {
        let (status, content_type, body) = get("/health", "POST").await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            content_type.expect("content type"),
            "application/problem+json"
        );
        assert_eq!(body["code"], "method_not_allowed");
    }

    #[tokio::test]
    async fn the_probe_sees_a_healthy_server_and_a_closed_port() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move { axum::serve(listener, base()).await });
        let healthy = tokio::task::spawn_blocking(move || probe(addr))
            .await
            .expect("join");
        assert!(healthy.expect("probe"), "/health should answer 200");

        let closed = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let closed_addr = closed.local_addr().expect("addr");
        drop(closed);
        assert!(probe(closed_addr).is_err(), "nothing listens there");
    }
}
