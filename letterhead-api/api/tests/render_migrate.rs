//! Integration tests of `letterhead-api migrate` and of what `serve` does with a database that is not migrated
//! (task T12; amendment 2026-11-17, items 4 and 5; AC-4.6, AC-4.7).
//!
//! The binary is the real one (`CARGO_BIN_EXE_letterhead-api`), run against a schema of its own in
//! `LETTERHEAD_TEST_DATABASE_URL` (see `render.rs`; schemas are never dropped, the cleanup is dropping the
//! database). Without the variable the tests are skipped with a notice; `LETTERHEAD_REQUIRE_DB_TESTS=1` turns a
//! missing database into a failure.

#[path = "render_db.rs"]
mod db;

use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::json;
use sqlx::Executor;
use uuid::Uuid;

use db::repo::Repo;
use db::types::NewVersion;
use letterhead_engine::content::Entity;

const URL_VAR: &str = "LETTERHEAD_TEST_DATABASE_URL";
const REQUIRE_VAR: &str = "LETTERHEAD_REQUIRE_DB_TESTS";
/// A password that no message of ours may repeat.
const PASSWORD_MARKER: &str = "ZQXpassword4711";

/// The URL of a database to test on; `None` (skip) when there is none.
fn test_database() -> Option<String> {
    match std::env::var(URL_VAR) {
        Ok(url) => Some(url),
        Err(_) => {
            assert!(
                std::env::var(REQUIRE_VAR).as_deref() != Ok("1"),
                "{URL_VAR} is not set and {REQUIRE_VAR}=1: the render tests may not be skipped"
            );
            eprintln!("SKIPPED: set {URL_VAR} to run the render tests");
            None
        }
    }
}

/// A new, empty schema, and the URL that makes it the `search_path` of whoever connects with it.
async fn empty_schema(database_url: &str) -> String {
    let schema = format!("lh_m_{}", Uuid::new_v4().simple());
    let admin = sqlx::PgPool::connect(database_url).await.expect("connect");
    // `lh_m_` and 32 hex digits, made here.
    admin
        .execute(sqlx::AssertSqlSafe(format!("create schema {schema}")))
        .await
        .expect("create schema");
    admin.close().await;
    let separator = if database_url.contains('?') { '&' } else { '?' };
    format!("{database_url}{separator}options=-c%20search_path%3D{schema}")
}

/// Runs a command to its end, or kills it after `limit` and fails: a server that was not supposed to start must
/// not be able to hang a test, or outlive it.
fn output_within(mut command: Command, limit: Duration) -> Output {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start letterhead-api");
    let started = Instant::now();
    loop {
        if child.try_wait().expect("wait").is_some() {
            return child.wait_with_output().expect("output");
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let output = child.wait_with_output().expect("output");
            panic!(
                "letterhead-api did not stop within {limit:?}: {}",
                text(&output)
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `letterhead-api migrate` with exactly the environment given: nothing else is passed on.
fn migrate_with(environment: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_letterhead-api"));
    command
        .arg("migrate")
        .env_clear()
        .envs(environment.iter().copied())
        .stdin(Stdio::null());
    output_within(command, Duration::from_secs(60))
}

/// The server, with exactly the environment given, which must end by itself within a minute.
fn serve_within(environment: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_letterhead-api"));
    command
        .env_clear()
        .envs(environment.iter().copied())
        .stdin(Stdio::null());
    output_within(command, Duration::from_secs(60))
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn embedded_migrations() -> usize {
    std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
        .expect("migrations")
        .filter(|e| {
            e.as_ref()
                .is_ok_and(|e| e.path().extension().is_some_and(|x| x == "sql"))
        })
        .count()
}

async fn table_exists(url: &str, table: &str) -> bool {
    let pool = sqlx::PgPool::connect(url).await.expect("connect");
    let found: Option<String> = sqlx::query_scalar("select to_regclass($1)::text")
        .bind(table)
        .fetch_one(&pool)
        .await
        .expect("query");
    pool.close().await;
    found.is_some()
}

#[tokio::test]
async fn render_migrate_applies_everything_then_is_a_no_op_and_reads_only_database_url() {
    let Some(database) = test_database() else {
        return;
    };
    let url = empty_schema(&database).await;
    assert!(!table_exists(&url, "letterhead_version").await);

    // The environment holds DATABASE_URL and nothing else: no bucket, no auth, no pool settings.
    let first = migrate_with(&[("DATABASE_URL", &url)]);
    assert!(first.status.success(), "{}", text(&first));
    let said = text(&first);
    assert!(
        said.contains(&format!("applied {} migration(s)", embedded_migrations())),
        "every migration file of the directory is in the binary: {said}"
    );
    assert!(
        embedded_migrations() >= 2,
        "the init migration and the guard against TRUNCATE"
    );
    for table in [
        "letterhead_asset",
        "letterhead_version",
        "letterhead_version_asset",
        "letterhead_change",
    ] {
        assert!(table_exists(&url, table).await, "{table}");
    }

    let second = migrate_with(&[("DATABASE_URL", &url)]);
    assert!(second.status.success(), "{}", text(&second));
    assert!(text(&second).contains("up to date"), "{}", text(&second));
    let third = migrate_with(&[("DATABASE_URL", &url)]);
    assert!(third.status.success() && text(&third).contains("up to date"));

    // The URL is not in what it says.
    for output in [&first, &second] {
        let said = text(output);
        assert!(
            !said.contains("postgres://") && !said.contains("search_path"),
            "{said}"
        );
    }
}

#[tokio::test]
async fn render_migrate_that_cannot_connect_or_has_no_url_fails_and_never_prints_the_url() {
    let Some(database) = test_database() else {
        return;
    };
    // The same server, with a password that nobody has and a database that is not there.
    let mut elsewhere = url::Url::parse(&database).expect("a URL");
    elsewhere
        .set_password(Some(PASSWORD_MARKER))
        .expect("password");
    elsewhere.set_path("/zqx_no_such_database");
    elsewhere.set_query(None);
    let cases: Vec<(String, Vec<(&str, String)>)> = vec![
        ("DATABASE_URL unset".into(), vec![]),
        ("empty".into(), vec![("DATABASE_URL", String::new())]),
        (
            "not a URL".into(),
            vec![("DATABASE_URL", format!("not a url {PASSWORD_MARKER}"))],
        ),
        (
            "another scheme".into(),
            vec![(
                "DATABASE_URL",
                format!("mysql://u:{PASSWORD_MARKER}@localhost/db"),
            )],
        ),
        (
            "nothing listens there".into(),
            vec![(
                "DATABASE_URL",
                format!("postgres://u:{PASSWORD_MARKER}@127.0.0.1:1/db"),
            )],
        ),
        (
            "a database that is not there".into(),
            vec![("DATABASE_URL", elsewhere.to_string())],
        ),
    ];
    for (what, environment) in cases {
        let environment: Vec<(&str, &str)> =
            environment.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let output = migrate_with(&environment);
        let said = text(&output);
        assert!(!output.status.success(), "{what}: {said}");
        assert!(
            !said.contains(PASSWORD_MARKER),
            "{what}: the password is in the output: {said}"
        );
        for (_, value) in &environment {
            assert!(
                value.is_empty() || !said.contains(value),
                "{what}: the URL is in the output: {said}"
            );
        }
        assert!(
            said.contains("letterhead-api migrate"),
            "{what}: it says what failed: {said}"
        );
    }
}

/// `serve` never migrates: on a database that was not, it stops with a message, and the database is as it was.
#[tokio::test]
async fn render_migrate_is_not_what_serve_does_it_refuses_to_start_on_an_unmigrated_database() {
    let Some(database) = test_database() else {
        return;
    };
    let url = empty_schema(&database).await;
    // A port that is taken, so that a start that gets past the checks cannot serve and cannot hang the test.
    // On the wildcard address, as the server binds: a more specific address would not stop it from binding.
    let taken = std::net::TcpListener::bind("0.0.0.0:0").expect("bind");
    let port = taken.local_addr().expect("addr").port().to_string();
    let environment = [
        ("PORT", port.as_str()),
        ("DATABASE_URL", url.as_str()),
        ("AUTH_ISSUER", "http://auth.test"),
        ("AUTH_BASE_URL", "http://127.0.0.1:1"),
        ("AUTH_JWKS_URL", "http://127.0.0.1:1/auth/jwks"),
        ("AUTH_AUDIENCE", "operai-suite"),
        ("SERVICE_AUDIENCE", "operai-service"),
        ("SERVICE_CLIENT_ID", "letterhead-api"),
        (
            "SERVICE_CLIENT_SECRET",
            "test-client-secret-0123456789abcdefgh",
        ),
        ("ALLOWED_ORIGINS", "http://localhost:5173"),
        ("LETTERHEAD_S3_ENDPOINT", "http://localhost:9000"),
        ("LETTERHEAD_S3_REGION", "us-east-1"),
        ("LETTERHEAD_S3_BUCKET", "unused"),
        ("LETTERHEAD_S3_ACCESS_KEY_ID", "x"),
        ("LETTERHEAD_S3_SECRET_ACCESS_KEY", "y"),
        ("LETTERHEAD_S3_EU_ENDPOINT_HOSTS", "localhost"),
    ];
    let started = Instant::now();
    let output = serve_within(&environment);
    let said = text(&output);
    assert!(!output.status.success(), "{said}");
    assert!(started.elapsed() < Duration::from_secs(30));
    assert!(
        said.contains("not applied") && said.contains("letterhead-api migrate"),
        "{said}"
    );
    assert!(
        !said.contains("postgres://") && !said.contains("search_path"),
        "{said}"
    );
    assert!(
        !table_exists(&url, "letterhead_version").await,
        "serve did not migrate the database it refused"
    );

    // After `migrate`, the same environment gets past that check (and then fails on the port that is taken).
    let migrated = migrate_with(&[("DATABASE_URL", &url)]);
    assert!(migrated.status.success(), "{}", text(&migrated));
    let output = serve_within(&environment);
    assert!(!text(&output).contains("not applied"), "{}", text(&output));
}

/// TRUNCATE on each table, and `CASCADE` from each, on the database that the binary migrated (AC-4.6, AC-4.7).
#[tokio::test]
async fn render_migrate_leaves_a_database_on_which_truncate_is_refused_and_every_row_stays() {
    let Some(database) = test_database() else {
        return;
    };
    let url = empty_schema(&database).await;
    let migrated = migrate_with(&[("DATABASE_URL", &url)]);
    assert!(migrated.status.success(), "{}", text(&migrated));

    let repo = Repo::connect(&url, 2).await.expect("connect");
    repo.save(NewVersion {
        entity: Entity::WelldIt,
        base_version: 0,
        layout_version: 1,
        config: json!({ "marker": "kept" }),
        asset_ids: vec![],
        actor_sub: "test".into(),
        actor_name: "Test Person".into(),
        changed_settings: vec!["margins".into()],
    })
    .await
    .expect("save");

    let pool = sqlx::PgPool::connect(&url).await.expect("connect");
    let tables = [
        "letterhead_change",
        "letterhead_version_asset",
        "letterhead_version",
        "letterhead_asset",
    ];
    let mut statements: Vec<String> = Vec::new();
    for table in tables {
        statements.push(format!("truncate {table} cascade"));
        statements.push(format!("truncate table only {table} cascade"));
    }
    statements.push(format!("truncate {} restart identity", tables.join(", ")));
    for statement in &statements {
        let refused = sqlx::query(sqlx::AssertSqlSafe(statement.clone()))
            .execute(&pool)
            .await;
        match refused {
            Err(sqlx::Error::Database(e)) => assert!(
                e.message().starts_with("letterhead_immutable"),
                "{statement}: refused by something else: {}",
                e.message()
            ),
            other => panic!("{statement}: expected a refusal, got {other:?}"),
        }
    }
    let versions: i64 = sqlx::query_scalar("select count(*) from letterhead_version")
        .fetch_one(&pool)
        .await
        .expect("count");
    let changes: i64 = sqlx::query_scalar("select count(*) from letterhead_change")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!((versions, changes), (1, 1), "every row is still there");
}

/// A new migration file is embedded: `build.rs` makes Cargo rebuild when the directory changes.
#[test]
fn render_migrate_the_build_watches_the_migrations_directory() {
    let build = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs"))
        .expect("build.rs");
    assert!(
        build.contains("cargo:rerun-if-changed=migrations"),
        "{build}"
    );
}
