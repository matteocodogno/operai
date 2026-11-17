//! The residue test (task T17; AC-3.7, AC-2.2, plan § Test strategy RES, § Security "No residue").
//!
//! After a render, whether it succeeded or not, the service holds nothing of the document: no content, entity
//! data, PDF or image in its database, its object storage, its disk (temporary files included), its logs, its
//! metrics or its traces. This file renders documents that carry unique marker strings, through every route that
//! takes a document or a configuration, and then looks in each of those places for the markers.
//!
//! **What is rendered** (every marker is unique to its request and to this run):
//! - the service routes `/v1/render/pdf` and `/v1/render/preview`: a document that succeeds, with a marker in
//!   every place of the content that can hold text (heading, paragraph run, list item, table cell, each member of
//!   the entity data, the bytes of an image), and a document that is refused at each stage that has a refusal
//!   (credential, size, JSON, content rules, entity, version, image, and the layout of the worker);
//! - the configurator's preview `/v1/letterheads/{entity}/preview`, drawn and refused;
//! - the configurator's save `/v1/letterheads/{entity}/versions`.
//!
//! **A letterhead is not a document.** A save stores a letterhead configuration, and the header text of one is
//! part of it: that marker (`stored`) is expected in the database, in the version row and nowhere else, and the
//! test says so with a positive assertion. Content, entity data, a preview's form and a refused save are not
//! stored, and their markers must be found nowhere.
//!
//! **Where it looks** (a hit anywhere fails the test, and the failure names the place and the marker):
//! - the Postgres database in full: `pg_dump` (a command named by `LETTERHEAD_RESIDUE_PG_DUMP`, e.g.
//!   `docker exec <postgres container> pg_dump -U postgres`, else a local `pg_dump`), and a logical dump made by
//!   the test itself (every row of every table of every schema, as text, large objects counted) that always runs.
//!   `LETTERHEAD_RESIDUE_REQUIRE_PG_DUMP=1` turns a missing `pg_dump` into a failure;
//! - the bucket: every object's key, metadata and bytes;
//! - the disk the service and its workers can write: a sandbox of its own (`HOME`, `TMPDIR`, the working
//!   directory, the XDG directories) that must stay empty, and the system's temporary directories (`/tmp`, `/var/tmp`,
//!   `/dev/shm`, the test's own temp dir), where a worker, which has an empty environment, would write, scanned
//!   for what was changed during the run;
//! - everything the service printed, on stdout and stderr, whose every line must also be of a closed form;
//! - optionally, the logs of the database and bucket containers (`LETTERHEAD_RESIDUE_DOCKER_LOGS`).
//!
//! **AC-2.2.** Beside the documents above, one document carries the injection set of AC-2.1 and what would read a
//! file, fetch an address or run something (`#read` of a file the service can read, of an address that a
//! listener watches, `#include`, `#image`, `#plugin`, `#eval`, a package import), in every place that holds text.
//! It is drawn as typed; the secret file's content (and the bucket's secret key) is in no output, and nothing
//! connects to the listener. Which files the render *opens* is not traced (no `strace` on every host): that the
//! service reads only its fonts and templates is the engine's own test (a virtual world), and here, the write-denied
//! run and the secret that never comes out.
//!
//! **Three things that make a zero meaningful.**
//! - A marker is looked for in the forms a store could keep it in: as typed, as hex (a `bytea`), as base64 in
//!   each of the three alignments, and as UTF-16.
//! - On Linux (the container's system) the same run is a *write-denied* run: the supervisor, and so every worker,
//!   starts under `ulimit -f 0`, so that a single byte written to a file kills the process (SIGXFSZ) and fails the
//!   request that did it. A file that was written and unlinked in the middle of a render leaves nothing to find;
//!   this is what catches it. `LETTERHEAD_RESIDUE_WRITE_DENIED=0|1` overrides; elsewhere it is off, because
//!   macOS's Security framework writes trust caches when a TLS client is built (the host's file, not the
//!   service's), and the sandbox listing and the `/tmp` scan stand alone there.
//! - Positive controls: the search finds a marker that was stored on purpose (the saved header text in the
//!   dump, a marker put in the bucket, a file written to a scanned directory, a caller identity in the log).
//!   A search that cannot see is not a proof.
//!
//! Beside the markers, the strong form: what the render and preview routes write is nothing, so the rows of the
//! test's schema, the keys of the bucket and the entries of the sandbox are the same before and after them.
//!
//! **No exporter.** `residue_no_exporter_is_configured_and_none_is_contacted`: the dependency lock and the source
//! name no metrics or tracing exporter, the service reads no variable that configures one, and a service given
//! the variables that would configure every common exporter, pointing at a listening sink, never contacts it,
//! serves no `/metrics`, and has no socket but its own port.
//!
//! Without the database variable the tests are skipped with a notice; `LETTERHEAD_REQUIRE_DB_TESTS=1` (set in
//! CI) turns anything missing, the database or the bucket, into a failure. Every test name starts with `residue_`.
//!
//! `scripts/residue-check.sh` is the same check for a human, against a running compose service.
//!
//! `residue_stack_for_the_script` (ignored) serves a fake `auth` and seeds a database for that script's own
//! test; it is not part of the suite.

#[path = "render_db.rs"]
mod db;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::rsa::{KeyPair, KeySize, PublicKeyComponents};
use aws_lc_rs::signature::{KeyPair as _, RSA_PKCS1_SHA256};
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sqlx::Executor;
use uuid::Uuid;

use db::repo::Repo;
use db::types::NewVersion;
use letterhead_engine::config::default_config;
use letterhead_engine::content::Entity;

const URL_VAR: &str = "LETTERHEAD_TEST_DATABASE_URL";
const REQUIRE_VAR: &str = "LETTERHEAD_REQUIRE_DB_TESTS";
/// A command that runs `pg_dump` against the test database, e.g. `docker exec <container> pg_dump -U postgres`.
/// The name of the database is appended.
const PG_DUMP_VAR: &str = "LETTERHEAD_RESIDUE_PG_DUMP";
const REQUIRE_PG_DUMP_VAR: &str = "LETTERHEAD_RESIDUE_REQUIRE_PG_DUMP";
/// `1` or `0`: whether the service starts under `ulimit -f 0`. Default: on Linux (the container's system), where the
/// service writes no file at all; off elsewhere (macOS's Security framework writes its trust caches when a TLS
/// client is built, which is the host's, not the service's).
const WRITE_DENIED_VAR: &str = "LETTERHEAD_RESIDUE_WRITE_DENIED";
/// Comma-separated names of containers (database, bucket) whose `docker logs` are searched too.
const DOCKER_LOGS_VAR: &str = "LETTERHEAD_RESIDUE_DOCKER_LOGS";

const ISSUER: &str = "http://auth.test";
const PERSON_AUDIENCE: &str = "operai-suite";
const SERVICE_AUDIENCE: &str = "operai-service";
const KID: &str = "test-key-1";
const ORIGIN: &str = "http://localhost:5173";

/// The twenty megabytes of the render routes' body limit, and one byte.
const RENDER_BODY_LIMIT: usize = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// The markers, and the forms a store could keep one in

/// A marker: what it was put in, and its text.
#[derive(Clone, Debug)]
struct Mark {
    name: String,
    text: String,
}

/// The markers of one run. Each carries the run's id, so that a file left by an earlier run (or by another
/// session that shares `/tmp`) can never be taken for this run's residue, or hide it.
struct Marks {
    run: String,
    all: Vec<Mark>,
}

impl Marks {
    fn new() -> Marks {
        Marks {
            run: Uuid::new_v4().simple().to_string()[..12].to_owned(),
            all: Vec::new(),
        }
    }

    /// A new marker of the given purpose, noted for the search.
    fn make(&mut self, name: &str) -> String {
        let text = format!("ZQX-RES-{name}-{}", self.run);
        self.all.push(Mark {
            name: name.to_owned(),
            text: text.clone(),
        });
        text
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    let Some((&first, rest)) = needle.split_first() else {
        return true;
    };
    let mut from = 0;
    while let Some(at) = haystack[from..].iter().position(|b| *b == first) {
        let start = from + at;
        let end = start + 1 + rest.len();
        if end > haystack.len() {
            return false;
        }
        if &haystack[start + 1..end] == rest {
            return true;
        }
        from = start + 1;
    }
    false
}

/// The forms of a marker that a store might keep: as typed, hex (lower and upper: a `bytea` is printed as lower
/// hex), base64 in each of the three alignments (the core that does not depend on the bytes around it), UTF-16.
fn needles(marker: &str) -> Vec<(&'static str, Vec<u8>)> {
    let mut out: Vec<(&'static str, Vec<u8>)> = vec![("text", marker.as_bytes().to_vec())];
    let hex: String = marker.bytes().map(|b| format!("{b:02x}")).collect();
    out.push(("hex", hex.to_ascii_lowercase().into_bytes()));
    out.push(("HEX", hex.to_ascii_uppercase().into_bytes()));
    for (pad, skip) in [(0usize, 0usize), (1, 2), (2, 3)] {
        let mut bytes = vec![b'#'; pad];
        bytes.extend_from_slice(marker.as_bytes());
        bytes.extend_from_slice(b"###");
        let encoded = STANDARD.encode(&bytes);
        // The characters that are fixed by the marker's bytes alone: from after the pad's, to the last whole
        // character before the bytes that follow.
        let end = (pad + marker.len()) * 8 / 6;
        let core = &encoded[skip..end];
        assert!(core.len() >= 8, "a base64 core that is not too short");
        out.push(("base64", core.as_bytes().to_vec()));
    }
    let utf16: Vec<u8> = marker.encode_utf16().flat_map(u16::to_le_bytes).collect();
    out.push(("utf16", utf16));
    out
}

/// What every marker begins with.
fn common_prefix(marks: &[&Mark]) -> String {
    let Some(first) = marks.first() else {
        return String::new();
    };
    let mut length = first.text.len();
    for mark in marks.iter() {
        length = length.min(
            first
                .text
                .bytes()
                .zip(mark.text.bytes())
                .take_while(|(a, b)| a == b)
                .count(),
        );
    }
    first.text[..length].to_owned()
}

/// Hits of any marker, in any of its forms, in `data` (`place` says where it was read).
fn search(place: &str, data: &[u8], marks: &[Mark], hits: &mut Vec<String>) {
    // Most of what is searched holds none of them: look first, for each family of markers (those that begin
    // alike), for what they all begin with, in every form.
    let mut families: Vec<(String, Vec<&Mark>)> = Vec::new();
    for mark in marks {
        let head: String = mark.text.chars().take(8).collect();
        match families.iter_mut().find(|(h, _)| *h == head) {
            Some((_, members)) => members.push(mark),
            None => families.push((head, vec![mark])),
        }
    }
    for (_, members) in families {
        let prefix = common_prefix(&members);
        if prefix.len() >= 6
            && !needles(&prefix)
                .iter()
                .any(|(_, needle)| contains(data, needle))
        {
            continue;
        }
        for mark in members {
            for (form, needle) in needles(&mark.text) {
                if contains(data, &needle) {
                    hits.push(format!("{place}: marker `{}` ({form})", mark.name));
                }
            }
        }
    }
}

#[test]
fn residue_the_search_finds_a_marker_in_each_form_a_store_could_keep_it() {
    let marker = "ZQX-RES-control-0123456789ab";
    let marks = [Mark {
        name: "c".into(),
        text: marker.into(),
    }];
    let hex: String = marker.bytes().map(|b| format!("{b:02x}")).collect();
    let utf16: Vec<u8> = marker.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut cases: Vec<(String, Vec<u8>)> = vec![
        ("text".into(), format!("a {marker} b").into_bytes()),
        // What `COPY` and `row::text` print for a `bytea`.
        ("bytea".into(), format!("(1,\"\\\\x{hex}\")").into_bytes()),
        ("utf16".into(), [b"xx".to_vec(), utf16].concat()),
    ];
    for pad in 0..3 {
        let mut bytes = vec![0u8; pad];
        bytes.extend_from_slice(b"before ");
        bytes.extend_from_slice(marker.as_bytes());
        bytes.extend_from_slice(b" after");
        let text = STANDARD.encode(&bytes);
        cases.push((format!("base64 at {pad}"), text.into_bytes()));
    }
    for (name, data) in cases {
        let mut hits = Vec::new();
        search("control", &data, &marks, &mut hits);
        assert!(!hits.is_empty(), "the search is blind to the form `{name}`");
    }
    let mut hits = Vec::new();
    search(
        "control",
        b"ZQX-RES-control-0123456789ac and nothing else",
        &marks,
        &mut hits,
    );
    assert!(hits.is_empty(), "another marker is no hit: {hits:?}");
}

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

fn test_env() -> Option<TestEnv> {
    let Ok(database_url) = std::env::var(URL_VAR) else {
        assert!(
            !required(),
            "{URL_VAR} is not set and {REQUIRE_VAR}=1: the residue tests may not be skipped"
        );
        eprintln!("SKIPPED: set {URL_VAR} to run the residue tests");
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

/// The name of the database in a URL, for `pg_dump`.
fn database_name(url: &str) -> String {
    url.split('?')
        .next()
        .and_then(|u| u.rsplit('/').next())
        .expect("a database name in the URL")
        .to_owned()
}

struct Bucket {
    client: aws_sdk_s3::Client,
    name: String,
}

/// What the bucket holds: key to (size, etag).
type Listing = BTreeMap<String, (i64, String)>;

impl Bucket {
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
                    "the bucket {} is not reachable at {} and {REQUIRE_VAR}=1: the residue tests may not be skipped",
                    env.bucket,
                    env.s3_endpoint
                );
                eprintln!("SKIPPED: no object store at {}", env.s3_endpoint);
                None
            }
        }
    }

    async fn list(&self) -> Listing {
        let mut out = Listing::new();
        let mut token: Option<String> = None;
        loop {
            let page = self
                .client
                .list_objects_v2()
                .bucket(&self.name)
                .set_continuation_token(token.clone())
                .send()
                .await
                .expect("list the bucket");
            for object in page.contents() {
                out.insert(
                    object.key().unwrap_or_default().to_owned(),
                    (
                        object.size().unwrap_or_default(),
                        object.e_tag().unwrap_or_default().to_owned(),
                    ),
                );
            }
            match page.next_continuation_token() {
                Some(next) => token = Some(next.to_owned()),
                None => return out,
            }
        }
    }

    /// Every object: its key, its metadata and its bytes, searched. Returns what the bucket holds.
    async fn scan(&self, marks: &[Mark], hits: &mut Vec<String>) -> Listing {
        let listing = self.list().await;
        for key in listing.keys() {
            search(&format!("bucket key `{key}`"), key.as_bytes(), marks, hits);
            let object = self
                .client
                .get_object()
                .bucket(&self.name)
                .key(key)
                .send()
                .await
                .expect("get an object");
            let metadata = format!(
                "{:?} {:?} {:?}",
                object.metadata(),
                object.content_type(),
                object.content_disposition()
            );
            search(
                &format!("bucket object `{key}` metadata"),
                metadata.as_bytes(),
                marks,
                hits,
            );
            let body = object.body.collect().await.expect("object body").to_vec();
            search(&format!("bucket object `{key}`"), &body, marks, hits);
        }
        listing
    }

    async fn put(&self, key: &str, bytes: &[u8]) {
        self.client
            .put_object()
            .bucket(&self.name)
            .key(key)
            .body(ByteStream::from(bytes.to_vec()))
            .send()
            .await
            .expect("put an object");
    }

    async fn delete(&self, key: &str) {
        self.client
            .delete_object()
            .bucket(&self.name)
            .key(key)
            .send()
            .await
            .expect("delete an object");
    }
}

fn schema_url(base: &str, schema: &str) -> String {
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}options=-c%20search_path%3D{schema}")
}

async fn create_schema(database_url: &str) -> (String, String) {
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
    (schema_url(database_url, &schema), schema)
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Every row of every table of the database (or of one schema), as text, one line each, in a stable order, and
/// the count of large objects. `row::text` prints a `bytea` as hex, a `jsonb` as its text: nothing is hidden.
async fn logical_dump(database_url: &str, only_schema: Option<&str>) -> Vec<u8> {
    let pool = sqlx::PgPool::connect(database_url)
        .await
        .expect("connect to dump");
    let tables: Vec<(String, String)> = sqlx::query_as(
        "select schemaname::text, tablename::text from pg_tables \
         where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2",
    )
    .fetch_all(&pool)
    .await
    .expect("list the tables");
    let mut out = String::new();
    for (schema, table) in tables {
        if only_schema.is_some_and(|only| only != schema) {
            continue;
        }
        let statement = format!(
            "select t::text from {}.{} t order by 1",
            quoted(&schema),
            quoted(&table)
        );
        let rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(statement))
            .fetch_all(&pool)
            .await
            .expect("read a table");
        out.push_str(&format!("-- {schema}.{table}: {} rows\n", rows.len()));
        for row in rows {
            out.push_str(&row);
            out.push('\n');
        }
    }
    if only_schema.is_none() {
        let large_objects: i64 = sqlx::query_scalar("select count(*) from pg_largeobject_metadata")
            .fetch_one(&pool)
            .await
            .expect("count large objects");
        out.push_str(&format!("-- large objects: {large_objects}\n"));
    }
    pool.close().await;
    out.into_bytes()
}

/// `pg_dump` of the whole database: the command of `LETTERHEAD_RESIDUE_PG_DUMP`, else a local `pg_dump`. `None`
/// when there is none that works (then `LETTERHEAD_RESIDUE_REQUIRE_PG_DUMP=1` fails the test).
fn pg_dump(database_url: &str) -> Option<Vec<u8>> {
    let database = database_name(database_url);
    let attempts: Vec<(String, Vec<String>)> = match std::env::var(PG_DUMP_VAR) {
        Ok(command) if !command.trim().is_empty() => {
            let mut words: Vec<String> = command.split_whitespace().map(str::to_owned).collect();
            let program = words.remove(0);
            words.push(database);
            vec![(program, words)]
        }
        _ => vec![(
            "pg_dump".to_owned(),
            vec![database_url.split('?').next().unwrap().to_owned()],
        )],
    };
    for (program, args) in attempts {
        match Command::new(&program).args(&args).output() {
            Ok(output) if output.status.success() && !output.stdout.is_empty() => {
                return Some(output.stdout);
            }
            Ok(output) => eprintln!(
                "NOTICE: `{program}` failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
                    .lines()
                    .next()
                    .unwrap_or_default()
            ),
            Err(e) => eprintln!("NOTICE: cannot run `{program}`: {e}"),
        }
    }
    assert!(
        std::env::var(REQUIRE_PG_DUMP_VAR).as_deref() != Ok("1"),
        "{REQUIRE_PG_DUMP_VAR}=1 and no pg_dump worked (set {PG_DUMP_VAR})"
    );
    eprintln!(
        "NOTICE: no pg_dump: the database was searched by the test's own logical dump only (set {PG_DUMP_VAR})"
    );
    None
}

// ---------------------------------------------------------------------------------------------------------------
// The disk

/// A directory of the run's own: the home, temp, cache and working directories of the service.
struct Sandbox {
    root: PathBuf,
    home: PathBuf,
    tmp: PathBuf,
    cwd: PathBuf,
    xdg: PathBuf,
}

impl Sandbox {
    fn new(run: &str) -> Sandbox {
        // `CARGO_TARGET_TMPDIR`: Cargo's directory for the scratch files of integration tests.
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("residue-{run}"));
        let make = |name: &str| {
            let path = root.join(name);
            std::fs::create_dir_all(&path).expect("make the sandbox");
            path
        };
        Sandbox {
            home: make("home"),
            tmp: make("tmp"),
            cwd: make("cwd"),
            xdg: make("xdg"),
            root,
        }
    }

    /// Every entry under the sandbox with its size: what the service left. Sorted.
    fn listing(&self) -> Vec<String> {
        let mut out = Vec::new();
        list_tree(&self.root, &self.root, &mut out);
        out.sort();
        out
    }
}

fn list_tree(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .display()
            .to_string();
        if meta.is_dir() {
            // The four directories of the sandbox themselves are made by the test.
            if dir != root {
                out.push(format!("{relative}/"));
            }
            list_tree(root, &path, out);
        } else {
            out.push(format!("{relative} ({} bytes)", meta.len()));
        }
    }
}

/// Searches the names and the contents of the files under `dir` that were changed at or after `since` (`None`:
/// all). Symbolic links are not followed, a file that cannot be read is skipped (and counted), and a file of
/// more than 512 MiB is not read. Returns (files read, files that could not be).
fn scan_tree(
    dir: &Path,
    since: Option<SystemTime>,
    marks: &[Mark],
    hits: &mut Vec<String>,
) -> (usize, usize) {
    let (mut read, mut skipped) = (0, 0);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        search(
            &format!("file name `{}`", path.display()),
            path.to_string_lossy().as_bytes(),
            marks,
            hits,
        );
        if meta.is_dir() {
            let (r, s) = scan_tree(&path, since, marks, hits);
            read += r;
            skipped += s;
        } else if meta.is_file() {
            if since.is_some_and(|since| meta.modified().is_ok_and(|m| m < since)) {
                continue;
            }
            if meta.len() > 512 * 1024 * 1024 {
                skipped += 1;
                continue;
            }
            match std::fs::read(&path) {
                Ok(bytes) => {
                    read += 1;
                    search(&format!("file `{}`", path.display()), &bytes, marks, hits);
                }
                Err(_) => skipped += 1,
            }
        }
    }
    (read, skipped)
}

/// Where a worker (which has an empty environment) or any child would write: the system's temporary directories.
fn system_temp_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["/tmp", "/var/tmp", "/dev/shm"]
        .iter()
        .map(PathBuf::from)
        .collect();
    dirs.push(std::env::temp_dir());
    let mut seen = Vec::new();
    dirs.retain(|d| {
        d.is_dir()
            && std::fs::canonicalize(d).is_ok_and(|c| {
                if seen.contains(&c) {
                    false
                } else {
                    seen.push(c);
                    true
                }
            })
    });
    dirs
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
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
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

    fn token(&self, claims: &Value) -> String {
        let input = format!(
            "{}.{}",
            b64url(
                json!({ "alg": "RS256", "typ": "JWT", "kid": KID })
                    .to_string()
                    .as_bytes()
            ),
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
}

/// What a person of the fake `auth` holds.
#[derive(Clone, Copy)]
struct Persona {
    sub: &'static str,
    access: bool,
    manage: bool,
}

/// A name that is not a marker: the actor of a save is stored on purpose (AC-4.7).
const PEOPLE: [Persona; 3] = [
    Persona {
        sub: "u-access",
        access: true,
        manage: false,
    },
    Persona {
        sub: "u-admin",
        access: true,
        manage: true,
    },
    Persona {
        sub: "u-none",
        access: false,
        manage: false,
    },
];

fn sub_of(bearer: &str) -> Option<String> {
    let token = bearer.strip_prefix("Bearer ")?;
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    claims["sub"].as_str().map(str::to_owned)
}

struct FakeAuth {
    jwks_url: String,
    base: String,
    key: Arc<TestKey>,
}

impl FakeAuth {
    /// `GET /auth/jwks`, `GET /authz/resolve` and `POST /system/service-token`, on `bind` (a free port when 0).
    async fn start(bind: &str) -> FakeAuth {
        use axum::{Router, http::HeaderMap, http::StatusCode, response::IntoResponse, routing};
        let key = Arc::new(TestKey::generate());
        let (for_jwks, for_mint, for_person) =
            (Arc::clone(&key), Arc::clone(&key), Arc::clone(&key));
        let app = Router::new()
            .route(
                "/auth/jwks",
                routing::get(move || {
                    let key = Arc::clone(&for_jwks);
                    async move { axum::Json(json!({ "keys": [key.jwk()] })) }
                }),
            )
            .route(
                "/authz/resolve",
                routing::get(|headers: HeaderMap| async move {
                    let bearer = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    let sub = sub_of(&bearer);
                    match PEOPLE.iter().find(|p| Some(p.sub) == sub.as_deref()) {
                        None => StatusCode::UNAUTHORIZED.into_response(),
                        Some(person) => {
                            let mut permissions = vec![
                                json!({ "resource": "projects", "action": "access", "conditions": null }),
                            ];
                            if person.access {
                                permissions.push(json!({ "resource": "letterheads", "action": "access", "conditions": null }));
                            }
                            if person.manage {
                                permissions.push(json!({ "resource": "letterhead", "action": "manage", "conditions": null }));
                            }
                            axum::Json(json!({ "sub": person.sub, "epoch": 1,
                                "permissions": permissions, "entity": "welld_it", "jobTitle": null }))
                            .into_response()
                        }
                    }
                }),
            )
            // A person's token, for the manual test of `scripts/residue-check.sh` (`/test/person-token/u-access`).
            .route(
                "/test/person-token/{sub}",
                routing::get(move |axum::extract::Path(sub): axum::extract::Path<String>| {
                    let key = Arc::clone(&for_person);
                    async move {
                        key.token(&json!({ "iss": ISSUER, "sub": sub, "aud": PERSON_AUDIENCE,
                            "email": format!("{sub}@welld.example"), "name": "Test Person", "perm_epoch": 1,
                            "iat": now(), "exp": now() + 3600 }))
                    }
                }),
            )
            // What a caller does with its client credentials (used by `scripts/residue-check.sh`), and what the
            // service itself does to read the registry (T22).
            .route(
                "/system/service-token",
                routing::post(move |body: axum::body::Bytes| {
                    let key = Arc::clone(&for_mint);
                    async move {
                        let asked: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let claims = if asked["clientId"] == "residue-check" && asked["clientSecret"] == "residue-secret" {
                            service_claims("system:residue-check", 3600)
                        } else if asked["clientId"] == "letterhead-api"
                            && asked["clientSecret"] == "test-client-secret-0123456789abcdefgh"
                        {
                            let mut claims = service_claims("system:letterhead-api", 3600);
                            claims["scope"] = json!("legal-entities:read");
                            claims
                        } else {
                            return StatusCode::UNAUTHORIZED.into_response();
                        };
                        axum::Json(json!({ "token": key.token(&claims), "expiresInSeconds": 3600 }))
                            .into_response()
                    }
                }),
            )
            // The registry of the legal entities (T22). `welld_ch` has a legal name that no frame holds, so that a
            // document of it is refused by the worker (`header_overflow`) whatever its `entityData` says.
            .route(
                "/system/legal-entities",
                routing::get(|| async {
                    let item = |entity: &str, name: String| {
                        json!({ "entity": entity, "version": 1, "updatedAt": null, "legalName": name,
                            "address": { "it": ["Via Roma 1"], "en": ["Via Roma 1"] },
                            "vatNumber": "IT01234567890", "iban": "IT60X0542811101000000123457",
                            "ibanPrint": "IT60 X054 2811 1010 0000 0123 457",
                            "contacts": { "it": "", "en": "" },
                            "complete": true, "missing": [], "invalid": [] })
                    };
                    axum::Json(json!({ "items": [
                        item("welld_it", "Registry Italia S.r.l.".to_owned()),
                        item("welld_ch", "Aaaa bbbb ".repeat(400)),
                    ] }))
                }),
            );
        let listener = tokio::net::TcpListener::bind(bind).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move { axum::serve(listener, app).await });
        FakeAuth {
            jwks_url: format!("http://127.0.0.1:{port}/auth/jwks"),
            base: format!("http://127.0.0.1:{port}"),
            key,
        }
    }

    fn person(&self, sub: &str) -> String {
        self.key
            .token(&json!({ "iss": ISSUER, "sub": sub, "aud": PERSON_AUDIENCE,
            "email": format!("{sub}@welld.example"), "name": "Test Person", "perm_epoch": 1,
            "iat": now(), "exp": now() + 300 }))
    }

    /// A service token whose `sub` is `system:{name}`.
    fn service(&self, name: &str) -> String {
        self.key
            .token(&service_claims(&format!("system:{name}"), 300))
    }
}

fn service_claims(sub: &str, lifetime: u64) -> Value {
    json!({ "iss": ISSUER, "sub": sub, "aud": SERVICE_AUDIENCE, "scope": "letterhead:render",
            "iat": now(), "exp": now() + lifetime, "jti": Uuid::new_v4().to_string() })
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

struct Server {
    child: Child,
    port: u16,
    out: Arc<Mutex<Vec<String>>>,
    err: Arc<Mutex<Vec<String>>>,
    /// The requests to the service routes, each of which is to leave one line.
    service_requests: AtomicUsize,
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

impl Server {
    /// Starts the binary, write-denied (`ulimit -f 0`: the first byte written to a file ends the process, and
    /// so the worker that wrote it), with the home, temp and working directories of the sandbox, and waits
    /// until it answers `/health`.
    async fn start(
        env: &TestEnv,
        database_url: &str,
        auth: &FakeAuth,
        sandbox: &Sandbox,
        extra: &[(&'static str, String)],
    ) -> Server {
        let port = free_port();
        let mut vars: Vec<(&'static str, String)> = vec![
            ("PORT", port.to_string()),
            ("DATABASE_URL", database_url.to_owned()),
            ("AUTH_ISSUER", ISSUER.to_owned()),
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
            ("LETTERHEAD_S3_ENDPOINT", env.s3_endpoint.clone()),
            ("LETTERHEAD_S3_REGION", "us-east-1".to_owned()),
            ("LETTERHEAD_S3_BUCKET", env.bucket.clone()),
            ("LETTERHEAD_S3_ACCESS_KEY_ID", env.s3_access_key_id.clone()),
            (
                "LETTERHEAD_S3_SECRET_ACCESS_KEY",
                env.s3_secret_access_key.clone(),
            ),
            (
                "LETTERHEAD_S3_EU_ENDPOINT_HOSTS",
                "127.0.0.1,localhost".to_owned(),
            ),
            ("LH_WORKERS", "2".to_owned()),
            ("LH_QUEUE", "2".to_owned()),
            // Where a process that is given a home would put a file.
            ("HOME", sandbox.home.display().to_string()),
            ("TMPDIR", sandbox.tmp.display().to_string()),
            ("TMP", sandbox.tmp.display().to_string()),
            ("TEMP", sandbox.tmp.display().to_string()),
            ("XDG_CACHE_HOME", sandbox.xdg.display().to_string()),
            ("XDG_DATA_HOME", sandbox.xdg.display().to_string()),
            ("XDG_STATE_HOME", sandbox.xdg.display().to_string()),
            ("XDG_RUNTIME_DIR", sandbox.xdg.display().to_string()),
        ];
        for (name, value) in extra {
            vars.retain(|(n, _)| n != name);
            vars.push((name, value.clone()));
        }
        let mut command = Command::new("sh");
        let denied = match std::env::var(WRITE_DENIED_VAR).as_deref() {
            Ok("1") => true,
            Ok("0") => false,
            _ => cfg!(target_os = "linux"),
        };
        if !denied {
            eprintln!(
                "NOTICE: the service is not started write-denied ({WRITE_DENIED_VAR}=0 or not Linux)"
            );
        }
        command
            .arg("-c")
            .arg(if denied {
                "ulimit -f 0 && exec \"$0\""
            } else {
                "exec \"$0\""
            })
            .arg(env!("CARGO_BIN_EXE_letterhead-api"))
            .env_clear()
            .envs(vars)
            .current_dir(&sandbox.cwd)
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
            service_requests: AtomicUsize::new(0),
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
        std::thread::sleep(Duration::from_millis(300));
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

struct Reply {
    status: u16,
    body: Vec<u8>,
}

impl Reply {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    fn code(&self) -> String {
        self.json()["code"].as_str().unwrap_or_default().to_owned()
    }
}

impl Server {
    async fn post(
        &self,
        path: &str,
        bearer: Option<&str>,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> Reply {
        if path.starts_with("/v1/render/") {
            self.service_requests.fetch_add(1, Ordering::SeqCst);
        }
        let mut request = http().post(self.url(path)).body(body);
        if let Some(bearer) = bearer {
            request = request.header("authorization", format!("Bearer {bearer}"));
        }
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let reply = request.send().await.expect("the supervisor answers");
        Reply {
            status: reply.status().as_u16(),
            body: reply.bytes().await.expect("body").to_vec(),
        }
    }

    async fn post_json(&self, path: &str, bearer: &str, body: &Value) -> Reply {
        self.post(
            path,
            Some(bearer),
            Some("application/json"),
            body.to_string().into_bytes(),
        )
        .await
    }

    async fn get(&self, path: &str, bearer: Option<&str>) -> Reply {
        let mut request = http().get(self.url(path));
        if let Some(bearer) = bearer {
            request = request.header("authorization", format!("Bearer {bearer}"));
        }
        let reply = request.send().await.expect("the supervisor answers");
        Reply {
            status: reply.status().as_u16(),
            body: reply.bytes().await.expect("body").to_vec(),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The letterheads and the documents

/// A starting configuration whose header holds `header` (a placeholder text for the entity data, or a marker)
/// and whose top margin is `top` mm.
fn config(header: &str, top: f64) -> Value {
    let mut config = serde_json::to_value(default_config()).expect("json");
    let mut line = config["variants"]["default"]["footer"]["left"][0].clone();
    line["text"] = json!({ "it": header, "en": header });
    config["variants"]["default"]["header"]["left"] = json!([line]);
    config["margins"]["top"] = json!(top);
    config
}

fn paragraph(text: &str) -> Value {
    json!({ "type": "paragraph", "runs": [{ "text": text }] })
}

fn cell(text: &str) -> Value {
    json!([paragraph(text)])
}

/// A 2 x 1 RGB PNG whose `tEXt` chunk holds `note`, so that the file's bytes carry a marker that stays readable
/// (a store that kept the image would keep it).
fn png_with(note: &str) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        let mut out = u32::try_from(data.len())
            .expect("small")
            .to_be_bytes()
            .to_vec();
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
        out
    }
    // The file of the asset tests of `preview.rs`: its header, its data and its end, with a `tEXt` between.
    let base: [u8; 70] = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x7b,
        0x40, 0xe8, 0xdd, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0x00, 0x04, 0xff, 0x01, 0x07, 0x00, 0x01, 0xff, 0xe2, 0x23, 0x9e, 0x59, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    let mut text = b"Comment\0".to_vec();
    text.extend_from_slice(note.as_bytes());
    let mut out = base[..33].to_vec();
    out.extend(chunk(b"tEXt", &text));
    out.extend_from_slice(&base[33..]);
    out
}

/// A document with a marker in every place of the content that can hold text, and an image that carries one.
fn document(entity: &str, marks: &mut Marks, tag: &str) -> Value {
    let mut m = |part: &str| marks.make(&format!("{tag}-{part}"));
    let image = png_with(&m("image"));
    json!({
        "contentVersion": 1, "entity": entity, "language": "en",
        "entityData": {
            "legalName": m("legalName"), "addressLines": [m("address1"), m("address2")],
            "vat": m("vat"), "iban": m("iban"), "contacts": m("contacts") },
        "blocks": [
            { "type": "heading", "level": 1, "text": m("heading") },
            paragraph(&m("paragraph")),
            { "type": "paragraph", "runs": [{ "text": m("run"), "bold": true }, { "text": m("run2"), "italic": true }] },
            { "type": "list", "items": [{ "runs": [{ "text": m("item") }] }] },
            { "type": "table", "columns": [1, 1], "header": [cell(&m("th1")), cell(&m("th2"))],
              "rows": [[cell(&m("td1")), cell(&m("td2"))]] },
            { "type": "image", "data": STANDARD.encode(image) },
        ]
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The world

struct World {
    env: TestEnv,
    /// The URL of a supervisor: the test's schema.
    schema_url: String,
    schema: String,
    bucket: Bucket,
    auth: FakeAuth,
    sandbox: Sandbox,
}

impl World {
    /// A schema of its own, migrated, with a letterhead for each entity: `welld_it` prints the entity data in its
    /// header, `welld_ch` has a header that a long legal name cannot fit. `None` when there is nothing to test on.
    async fn new(marks: &Marks) -> Option<World> {
        let env = test_env()?;
        let bucket = Bucket::open(&env).await?;
        let (schema_url, schema) = create_schema(&env.database_url).await;
        let repo = Repo::connect(&schema_url, 4).await.expect("connect");
        repo.migrate().await.expect("migrate");
        for (entity, form) in [
            (Entity::WelldIt, config("{legal_name} {vat}", 25.0)),
            (Entity::WelldCh, config("{legal_name}", 14.0)),
        ] {
            repo.save(NewVersion {
                entity,
                base_version: 0,
                layout_version: 1,
                config: form,
                asset_ids: Vec::new(),
                actor_sub: "test".into(),
                actor_name: "Test Person".into(),
                changed_settings: vec!["margins".into()],
            })
            .await
            .expect("save a version");
        }
        let auth = FakeAuth::start("127.0.0.1:0").await;
        Some(World {
            sandbox: Sandbox::new(&marks.run),
            env,
            schema_url,
            schema,
            bucket,
            auth,
        })
    }

    async fn server(&self, extra: &[(&'static str, String)]) -> Server {
        Server::start(
            &self.env,
            &self.schema_url,
            &self.auth,
            &self.sandbox,
            extra,
        )
        .await
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The test

/// A refusal's body repeats nothing that was sent (AC-3.6).
fn assert_refusal(reply: &Reply, status: u16, code: &str, marks: &[Mark]) {
    assert_eq!(reply.status, status, "{}", reply.text());
    assert_eq!(reply.code(), code, "{}", reply.text());
    let mut hits = Vec::new();
    search("the refusal", &reply.body, marks, &mut hits);
    assert!(hits.is_empty(), "a refusal repeats the request: {hits:?}");
}

/// The line of a render: `render route=pdf caller=... entity=... outcome=... status=200 pages=1 ms=12`.
fn is_render_line(line: &str) -> bool {
    let words: Vec<&str> = line.split(' ').collect();
    if words.len() < 8 || words[0] != "render" {
        return false;
    }
    let names = [
        "route", "caller", "entity", "outcome", "status", "pages", "ms",
    ];
    for (word, name) in words[1..8].iter().zip(names) {
        let Some(value) = word.strip_prefix(&format!("{name}=")) else {
            return false;
        };
        let alphabet =
            |c: char| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '.' | '@' | '-');
        if value.is_empty() || !value.chars().all(alphabet) {
            return false;
        }
    }
    let numeric = |word: &str, name: &str| {
        word.strip_prefix(&format!("{name}="))
            .is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
    };
    // After `ms`: an optional `cause=`, then (T22) the optional `legal_entity_version=<n>` and
    // `entity_data_ignored=true|false`, in that order, numbers and two words of ours.
    let mut rest = words[8..].iter().peekable();
    if rest.peek().is_some_and(|word| word.starts_with("cause=")) {
        rest.next();
    }
    if rest
        .peek()
        .is_some_and(|word| numeric(word, "legal_entity_version"))
    {
        rest.next();
    }
    if rest.peek().is_some_and(|word| {
        matches!(
            **word,
            "entity_data_ignored=true" | "entity_data_ignored=false"
        )
    }) {
        rest.next();
    }
    numeric(words[5], "status")
        && (words[6] == "pages=-" || numeric(words[6], "pages"))
        && numeric(words[7], "ms")
        && rest.next().is_none()
}

/// A line the service may print: a render line, the one at start, and the two fixed messages of the
/// authorisation.
fn is_known_line(line: &str) -> bool {
    is_render_line(line)
        || (line.starts_with("letterhead-api listening on ")
            && line.chars().all(|c| c.is_ascii_graphic() || c == ' '))
        || line.starts_with("authz: ")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn residue_nothing_of_a_document_is_kept_anywhere() {
    let mut marks = Marks::new();
    let Some(world) = World::new(&marks).await else {
        return;
    };
    let started = SystemTime::now() - Duration::from_secs(2);

    // The positive controls that need the world: a marker in the bucket, and one in a scanned directory.
    let control_object = marks.make("control-object");
    let control_file = marks.make("control-file");
    let control_log = marks.make("control-log");

    // The markers of the documents and forms. `forbidden` is everything that is not a letterhead configuration
    // that was saved, and the controls.
    let service_ok = document("welld_it", &mut marks, "service-ok");
    let service_ok_pdf = document("welld_it", &mut marks, "service-ok-pdf");
    let refused_style = {
        let mut doc = document("welld_it", &mut marks, "refused-style");
        doc["blocks"][1]["runs"][0]["style"] = json!(marks.make("refused-style-name"));
        doc
    };
    let refused_block = {
        let mut doc = document("welld_it", &mut marks, "refused-block");
        doc["blocks"][2] = json!({ "type": marks.make("refused-block-type") });
        doc["blocks"][3][marks.make("refused-member")] = json!(1);
        doc
    };
    let refused_entity = document(
        &marks.make("refused-entity"),
        &mut marks,
        "refused-entity-doc",
    );
    let refused_version = {
        let mut doc = document("welld_it", &mut marks, "refused-version");
        doc["letterheadVersion"] = json!(99);
        doc
    };
    let refused_contentversion = {
        let mut doc = document("welld_it", &mut marks, "refused-contentversion");
        doc["contentVersion"] = json!(3);
        doc
    };
    let refused_image = {
        let mut doc = document("welld_it", &mut marks, "refused-image");
        doc["blocks"][5] =
            json!({ "type": "image", "data": STANDARD.encode(marks.make("refused-image-bytes")) });
        doc
    };
    let refused_address = {
        let mut doc = document("welld_it", &mut marks, "refused-address");
        doc["blocks"][5] = json!({ "type": "image", "url": format!("https://{}.example/x.png", marks.make("refused-url")) });
        doc
    };
    let refused_json = marks.make("refused-notjson");
    let refused_big = marks.make("refused-toobig");
    let refused_bearer = marks.make("refused-bearer");
    let refused_unauthenticated = document("welld_it", &mut marks, "refused-unauthenticated");
    // Refused by the worker (the layout does not fit): the document got as far as a render.
    let refused_overflow = {
        let mut doc = document("welld_ch", &mut marks, "refused-overflow");
        doc["entityData"]["legalName"] = json!(format!(
            "{} {}",
            marks.make("refused-overflow-name"),
            "Aaaa bbbb ".repeat(400)
        ));
        doc
    };
    let preview_ok_header = marks.make("preview-ok-header");
    let preview_ok_footer = marks.make("preview-ok-footer");
    let preview_refused_text = marks.make("preview-refused-text");
    let preview_refused_member = marks.make("preview-refused-member");
    let preview_forbidden = marks.make("preview-forbidden");
    let preview_entity = marks.make("preview-entity");
    let preview_language = marks.make("preview-language");
    let preview_big = marks.make("preview-toobig");
    let save_refused_text = marks.make("save-refused-text");
    let save_stale = marks.make("save-stale");
    let save_forbidden = marks.make("save-forbidden");
    // What is stored on purpose: the header text of a saved letterhead.
    let stored = marks.make("stored-header-text");
    let after_save = document("welld_it", &mut marks, "after-save");

    // AC-2.2: the test set of AC-2.1, and what would read a file, fetch an address or run something, in every
    // place that holds text. The secret is in a file that the service can read (its working directory), and a
    // listener counts the connections that anything makes to the address the payloads name.
    let secret = format!("SECRET-{}", marks.run);
    let secret_path = world.sandbox.cwd.join("secret.txt");
    std::fs::write(&secret_path, &secret).expect("plant a secret file");
    let sink = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a sink");
    let sink_port = sink.local_addr().expect("addr").port();
    let connections = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&connections);
    tokio::spawn(async move {
        while sink.accept().await.is_ok() {
            counted.fetch_add(1, Ordering::SeqCst);
        }
    });
    let injected = {
        let path = secret_path.display().to_string();
        let payloads = [
            "#set page(width: 1cm)".to_owned(),
            "#read(\"/etc/hostname\")".to_owned(),
            "$x^2$ *a* _a_ `raw` @label <label> \\ {page}".to_owned(),
            format!("#read(\"{path}\")"),
            "#read(\"secret.txt\")".to_owned(),
            "#read(\"../cwd/secret.txt\")".to_owned(),
            format!("#include \"{path}\""),
            format!("#image(\"{path}\")"),
            format!("#csv(\"{path}\")"),
            format!("#eval(read(\"{path}\"))"),
            format!("#plugin(\"{path}\")"),
            format!("#bibliography(\"{path}\")"),
            format!("#read(\"http://127.0.0.1:{sink_port}/x\")"),
            format!("#image(\"http://127.0.0.1:{sink_port}/x.png\")"),
            format!("#plugin(\"http://127.0.0.1:{sink_port}/x.wasm\")"),
            "#import \"@preview/example:0.1.0\": *".to_owned(),
            "#sys.inputs #datetime.today().display() #str(read(\"/proc/self/environ\"))".to_owned(),
        ];
        let texts: Vec<String> = payloads
            .iter()
            .enumerate()
            .map(|(n, payload)| format!("{} {payload}", marks.make(&format!("injection-{n}"))))
            .collect();
        let items: Vec<Value> = texts
            .iter()
            .map(|t| json!({ "runs": [{ "text": t }] }))
            .collect();
        let cells: Vec<Value> = texts.iter().take(2).map(|t| cell(t)).collect();
        json!({
            "contentVersion": 1, "entity": "welld_it", "language": "en",
            "entityData": { "legalName": texts[0], "addressLines": [texts[1]], "vat": texts[2], "iban": texts[3], "contacts": texts[4] },
            "blocks": [
                { "type": "heading", "level": 1, "text": texts[0] },
                paragraph(&texts[1]),
                { "type": "paragraph", "runs": texts.iter().map(|t| json!({ "text": t })).collect::<Vec<_>>() },
                { "type": "list", "items": items },
                { "type": "table", "columns": [1, 1], "header": cells.clone(), "rows": [cells] },
            ]
        })
    };

    let forbidden: Vec<Mark> = marks
        .all
        .iter()
        .filter(|m| {
            m.text != stored
                && m.text != control_object
                && m.text != control_file
                && m.text != control_log
        })
        .cloned()
        .collect();
    let forbidden_text: Vec<&str> = forbidden.iter().map(|m| m.text.as_str()).collect();
    // What is looked for outside the sandbox (where the secret file is): the markers, and the secret's content.
    let secret_mark = Mark {
        name: "secret-file-content".into(),
        text: secret.clone(),
    };
    let hunted: Vec<Mark> = forbidden
        .iter()
        .cloned()
        .chain([secret_mark.clone()])
        .collect();
    assert!(forbidden.len() > 40, "{} markers", forbidden.len());

    // ---- what the run starts from
    let rows_before = logical_dump(&world.schema_url, Some(&world.schema)).await;
    // A failed run may have left its control object; it is the test's, not the service's.
    for key in world
        .bucket
        .list()
        .await
        .keys()
        .filter(|k| k.starts_with("residue-control/"))
    {
        world.bucket.delete(key).await;
    }
    let bucket_before = world.bucket.list().await;
    let sandbox_before = world.sandbox.listing();
    // The secret file is the test's; everything else that appears in the sandbox is the service's.
    assert_eq!(sandbox_before.len(), 1, "{sandbox_before:?}");
    // A control, to be removed after the run: the object is searched with the rest, and must be found.
    let control_key = format!("residue-control/{}", marks.run);
    world
        .bucket
        .put(&control_key, format!("x {control_object} y").as_bytes())
        .await;

    let server = world.server(&[]).await;
    let service = world.auth.service("letterhead-test-caller");
    let service_marked = world.auth.service(&control_log);
    let admin = world.auth.person("u-admin");
    let reader = world.auth.person("u-access");
    let outsider = world.auth.person("u-none");

    // ---- the service routes: documents that are drawn
    let pdf = server
        .post_json("/v1/render/pdf", &service, &service_ok_pdf)
        .await;
    assert_eq!(pdf.status, 200, "{}", pdf.text());
    assert_eq!(&pdf.body[..5], b"%PDF-");
    let preview = server
        .post_json("/v1/render/preview", &service, &service_ok)
        .await;
    assert_eq!(preview.status, 200, "{}", preview.text());
    // The caller is a log field: this is the positive control of the log search.
    let controlled = server
        .post_json("/v1/render/preview", &service_marked, &json!({
            "contentVersion": 1, "entity": "welld_it", "language": "en", "blocks": [paragraph("Hello")] }))
        .await;
    assert_eq!(controlled.status, 200, "{}", controlled.text());

    // ---- AC-2.2: the injection set is printed as typed, reads nothing and reaches nothing
    let pdf = server
        .post_json("/v1/render/pdf", &service, &injected)
        .await;
    assert_eq!(pdf.status, 200, "{}", pdf.text());
    let preview = server
        .post_json("/v1/render/preview", &service, &injected)
        .await;
    assert_eq!(preview.status, 200, "{}", preview.text());
    let printed = preview.text();
    assert!(
        printed.contains("#set page(width: 1cm)") && printed.contains("#read("),
        "the engine's own syntax is printed as typed"
    );
    for (what, output) in [("the PDF", &pdf.body), ("the preview", &preview.body)] {
        for secret_text in [secret.as_str(), "minioadmin"] {
            assert!(
                !contains(output, secret_text.as_bytes()),
                "{what} holds `{secret_text}`: a file or the environment was read"
            );
        }
    }

    // ---- the service routes: documents that are refused, at each stage that refuses
    for (name, document, status, code) in [
        ("style", &refused_style, 422, "invalid_content"),
        ("block", &refused_block, 422, "invalid_content"),
        ("entity", &refused_entity, 422, "unknown_entity"),
        (
            "version",
            &refused_version,
            404,
            "letterhead_version_not_found",
        ),
        (
            "content version",
            &refused_contentversion,
            422,
            "unsupported_content_version",
        ),
        ("image", &refused_image, 422, "invalid_content"),
        ("address", &refused_address, 422, "invalid_content"),
    ] {
        for route in ["/v1/render/pdf", "/v1/render/preview"] {
            let reply = server.post_json(route, &service, document).await;
            assert_refusal(&reply, status, code, &forbidden);
            let _ = name;
        }
    }
    let overflow = server
        .post_json("/v1/render/pdf", &service, &refused_overflow)
        .await;
    assert_refusal(&overflow, 422, "header_overflow", &forbidden);
    let overflow = server
        .post_json("/v1/render/preview", &service, &refused_overflow)
        .await;
    assert_refusal(&overflow, 422, "header_overflow", &forbidden);
    // Not JSON, too large, and no good credential.
    let reply = server
        .post(
            "/v1/render/pdf",
            Some(&service),
            Some("application/json"),
            refused_json.clone().into_bytes(),
        )
        .await;
    assert_refusal(&reply, 422, "invalid_content", &forbidden);
    let mut big = format!("{{\"entity\":\"{refused_big}\",\"pad\":\"").into_bytes();
    big.resize(RENDER_BODY_LIMIT + 1, b' ');
    let reply = server
        .post(
            "/v1/render/pdf",
            Some(&service),
            Some("application/json"),
            big,
        )
        .await;
    assert_refusal(&reply, 413, "request_too_large", &forbidden);
    for bearer in [None, Some(refused_bearer.as_str())] {
        let reply = server
            .post(
                "/v1/render/pdf",
                bearer,
                Some("application/json"),
                refused_unauthenticated.to_string().into_bytes(),
            )
            .await;
        assert_refusal(&reply, 401, "unauthorized", &forbidden);
    }

    // ---- the configurator's preview: drawn, and refused
    let mut drawn = config(&preview_ok_header, 25.0);
    drawn["variants"]["default"]["footer"]["left"][0]["text"] =
        json!({ "it": preview_ok_footer, "en": preview_ok_footer });
    for language in ["en", "it"] {
        let reply = server
            .post_json(
                "/v1/letterheads/welld_it/preview",
                &reader,
                &json!({ "config": drawn, "language": language }),
            )
            .await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert!(
            reply.text().contains("pageCount"),
            "a preview of a form is the pages"
        );
    }
    let mut bad = config(&format!("{preview_refused_text}{{"), 25.0);
    bad["margins"][&preview_refused_member] = json!(1);
    let reply = server
        .post_json(
            "/v1/letterheads/welld_it/preview",
            &reader,
            &json!({ "config": bad, "language": "en" }),
        )
        .await;
    assert_refusal(&reply, 422, "invalid_letterhead", &forbidden);
    let reply = server
        .post_json(
            "/v1/letterheads/welld_it/preview",
            &outsider,
            &json!({ "config": config(&preview_forbidden, 25.0), "language": "en" }),
        )
        .await;
    assert_refusal(&reply, 403, "forbidden", &forbidden);
    let reply = server
        .post_json(
            &format!("/v1/letterheads/{preview_entity}/preview"),
            &reader,
            &json!({ "config": config("{legal_name}", 25.0), "language": "en" }),
        )
        .await;
    assert_refusal(&reply, 422, "unknown_entity", &forbidden);
    let reply = server
        .post_json(
            "/v1/letterheads/welld_it/preview",
            &reader,
            &json!({ "config": config("{legal_name}", 25.0), "language": preview_language }),
        )
        .await;
    assert_refusal(&reply, 422, "unsupported_language", &forbidden);
    let mut big = format!("{{\"language\":\"{preview_big}\",\"pad\":\"").into_bytes();
    big.resize(1024 * 1024 + 1, b' ');
    let reply = server
        .post(
            "/v1/letterheads/welld_it/preview",
            Some(&reader),
            Some("application/json"),
            big,
        )
        .await;
    assert_refusal(&reply, 413, "request_too_large", &forbidden);

    // ---- what the render and the preview wrote: nothing
    let rows_after_render = logical_dump(&world.schema_url, Some(&world.schema)).await;
    assert_eq!(
        String::from_utf8_lossy(&rows_before),
        String::from_utf8_lossy(&rows_after_render),
        "a render or a preview wrote a row"
    );
    let mut sink = Vec::new();
    let bucket_after_render = world.bucket.scan(&hunted, &mut sink).await;
    let mut expected = bucket_before.clone();
    expected.insert(
        control_key.clone(),
        bucket_after_render
            .get(&control_key)
            .cloned()
            .expect("the control object"),
    );
    assert_eq!(
        bucket_after_render, expected,
        "a render or a preview wrote an object"
    );
    assert_eq!(
        world.sandbox.listing(),
        sandbox_before,
        "a render or a preview wrote a file in the home, temp or working directory"
    );

    // ---- the configurator's save: a letterhead is stored, a document is not
    let mut saved = config(&format!("{stored} {{legal_name}}"), 25.0);
    saved["variants"]["default"]["footer"]["left"][0]["text"] =
        json!({ "it": "Footer", "en": "Footer" });
    let reply = server
        .post_json(
            "/v1/letterheads/welld_it/versions",
            &admin,
            &json!({ "baseVersion": 1, "config": saved }),
        )
        .await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    // Refused saves: the form is wrong, the base is stale, the person may not.
    let mut bad = config(&format!("{save_refused_text}{{"), 25.0);
    bad["margins"][format!("{save_refused_text}-member")] = json!(1);
    let reply = server
        .post_json(
            "/v1/letterheads/welld_it/versions",
            &admin,
            &json!({ "baseVersion": 2, "config": bad }),
        )
        .await;
    assert_refusal(&reply, 422, "invalid_letterhead", &forbidden);
    let reply = server
        .post_json(
            "/v1/letterheads/welld_it/versions",
            &admin,
            &json!({ "baseVersion": 1, "config": config(&save_stale, 25.0) }),
        )
        .await;
    assert_refusal(&reply, 409, "version_conflict", &forbidden);
    let reply = server
        .post_json(
            "/v1/letterheads/welld_it/versions",
            &reader,
            &json!({ "baseVersion": 2, "config": config(&save_forbidden, 25.0) }),
        )
        .await;
    assert_refusal(&reply, 403, "forbidden", &forbidden);
    // The saved letterhead is used by the next render, and the render still keeps nothing.
    let reply = server
        .post_json("/v1/render/pdf", &service, &after_save)
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    // The stored header text is read back by the configurator: it is the configuration, kept on purpose.
    let versions = server
        .get("/v1/letterheads/welld_it/versions/2", Some(&reader))
        .await;
    assert_eq!(versions.status, 200, "{}", versions.text());
    assert!(
        versions.text().contains(&stored),
        "the saved text is in the version"
    );

    assert_eq!(
        connections.load(Ordering::SeqCst),
        0,
        "a payload made the service connect to an address it named (AC-2.2)"
    );

    // ---- stop the service, and read everything it wrote
    let requests = server.service_requests.load(Ordering::SeqCst);
    let (out, err) = server.stop();
    let rows_after_save = logical_dump(&world.schema_url, Some(&world.schema)).await;

    // ---- the search
    let mut hits: Vec<String> = Vec::new();

    // The logs: closed forms, and no marker.
    let lines: Vec<&String> = out.iter().chain(err.iter()).collect();
    for line in &lines {
        assert!(
            is_known_line(line),
            "a line of a form that is not the service's: {line}"
        );
    }
    let render_lines: Vec<&&String> = lines.iter().filter(|l| l.starts_with("render ")).collect();
    assert_eq!(
        render_lines.len(),
        requests,
        "one line for each request to a service route: {render_lines:#?}"
    );
    let log_text = lines
        .iter()
        .map(|l| l.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    search("the log", log_text.as_bytes(), &hunted, &mut hits);
    let mut log_control = Vec::new();
    search(
        "the log",
        log_text.as_bytes(),
        &marks
            .all
            .iter()
            .filter(|m| m.text == control_log)
            .cloned()
            .collect::<Vec<_>>(),
        &mut log_control,
    );
    assert!(
        !log_control.is_empty(),
        "positive control: the caller of a request is in the log, and the search does not see it"
    );

    // The bucket: every object. The control is found, the rest is as before.
    let mut object_hits = Vec::new();
    let everything: Vec<Mark> = marks.all.iter().cloned().chain([secret_mark]).collect();
    let listing = world.bucket.scan(&everything, &mut object_hits).await;
    assert!(
        object_hits.iter().any(|h| h.contains("control-object")),
        "positive control: the marker put in the bucket is not found: {object_hits:?}"
    );
    world.bucket.delete(&control_key).await;
    for hit in object_hits.iter().filter(|h| !h.contains("control-object")) {
        hits.push(hit.clone());
    }
    assert_eq!(
        listing
            .keys()
            .filter(|k| !k.starts_with("residue-control/"))
            .collect::<Vec<_>>(),
        bucket_before.keys().collect::<Vec<_>>(),
        "a save wrote an object"
    );

    // The database: the whole of it, by `pg_dump` and by the logical dump.
    let full = logical_dump(&world.env.database_url, None).await;
    search("the database (logical dump)", &full, &hunted, &mut hits);
    let dump = pg_dump(&world.env.database_url);
    if let Some(dump) = &dump {
        search("the database (pg_dump)", dump, &hunted, &mut hits);
        assert!(
            contains(dump, b"letterhead_version"),
            "pg_dump of the test database holds the letterhead tables"
        );
    }
    // What is stored on purpose is there, in the version row and in no other table; its refused companions are not.
    let stored_mark = marks
        .all
        .iter()
        .filter(|m| m.text == stored)
        .cloned()
        .collect::<Vec<_>>();
    let mut stored_hits = Vec::new();
    search(
        "the database (logical dump)",
        &full,
        &stored_mark,
        &mut stored_hits,
    );
    assert!(
        !stored_hits.is_empty(),
        "positive control: the header text of a saved letterhead is stored, and the search does not see it"
    );
    if let Some(dump) = &dump {
        let mut dump_hits = Vec::new();
        search("the database (pg_dump)", dump, &stored_mark, &mut dump_hits);
        assert!(
            !dump_hits.is_empty(),
            "positive control: pg_dump does not hold the saved header text"
        );
    }
    let stored_lines: Vec<&str> = std::str::from_utf8(&full)
        .expect("text")
        .lines()
        .filter(|l| l.contains(&stored))
        .collect();
    assert_eq!(
        stored_lines.len(),
        1,
        "the saved text is in one row: {stored_lines:?}"
    );
    let table_of_stored = std::str::from_utf8(&full)
        .expect("text")
        .lines()
        .take_while(|l| !l.contains(&stored))
        .filter(|l| l.starts_with("-- "))
        .last()
        .map(str::to_owned)
        .unwrap_or_default();
    assert!(
        table_of_stored.contains(&format!("{}.letterhead_version", world.schema)),
        "the saved text is in `letterhead_version`: {table_of_stored}"
    );
    // The save changed `letterhead_version` and `letterhead_change` (AC-4.1, AC-4.7), and nothing else.
    let before = String::from_utf8_lossy(&rows_after_render).into_owned();
    let after = String::from_utf8_lossy(&rows_after_save).into_owned();
    let tables = |dump: &str| -> BTreeMap<String, Vec<String>> {
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut current = String::new();
        for line in dump.lines() {
            if let Some(name) = line.strip_prefix("-- ") {
                current = name.split(':').next().unwrap_or_default().to_owned();
                out.entry(current.clone()).or_default();
            } else {
                out.entry(current.clone())
                    .or_default()
                    .push(line.to_owned());
            }
        }
        out
    };
    let (before, after) = (tables(&before), tables(&after));
    let changed: Vec<&String> = after
        .iter()
        .filter(|(table, rows)| before.get(*table) != Some(rows))
        .map(|(table, _)| table)
        .collect();
    let expected_tables = [
        format!("{}.letterhead_change", world.schema),
        format!("{}.letterhead_version", world.schema),
    ];
    assert_eq!(
        changed.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
        expected_tables
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        "a save changes the version and its change row, and nothing else"
    );
    // The stored text is not in the change log: it names the settings that changed, not their values.
    let change_rows = after
        .get(&expected_tables[0])
        .expect("the change table")
        .join("\n");
    assert!(
        !change_rows.contains(&stored),
        "the change log holds the header text"
    );

    // The disk. The sandbox is empty; the system's temporary directories hold nothing of the run.
    assert_eq!(
        world.sandbox.listing(),
        sandbox_before,
        "the service left something in its home, temp or working directory"
    );
    let mut scanned = (0, 0);
    let (r, s) = scan_tree(&world.sandbox.root, None, &forbidden, &mut hits);
    scanned = (scanned.0 + r, scanned.1 + s);
    // The control: a file with a marker in a scanned directory is found, and removed.
    let planted = world.sandbox.tmp.join("planted.txt");
    std::fs::write(&planted, format!("x {control_file} y")).expect("plant a file");
    let mut planted_hits = Vec::new();
    scan_tree(
        &world.sandbox.root,
        None,
        &marks
            .all
            .iter()
            .filter(|m| m.text == control_file)
            .cloned()
            .collect::<Vec<_>>(),
        &mut planted_hits,
    );
    std::fs::remove_file(&planted).expect("remove the planted file");
    assert!(
        !planted_hits.is_empty(),
        "positive control: a marker in a scanned directory is not found"
    );
    let scan_started = Instant::now();
    for dir in system_temp_dirs() {
        let (r, s) = scan_tree(&dir, Some(started), &hunted, &mut hits);
        scanned = (scanned.0 + r, scanned.1 + s);
    }
    eprintln!(
        "NOTICE: scanned {} files of the temporary directories ({} unreadable) in {:?}",
        scanned.0,
        scanned.1,
        scan_started.elapsed()
    );
    assert!(scanned.0 > 0, "the scan read no file at all");

    // The logs of the containers of the database and of the bucket, if named.
    if let Ok(names) = std::env::var(DOCKER_LOGS_VAR) {
        for name in names.split(',').map(str::trim).filter(|n| !n.is_empty()) {
            let output = Command::new("docker")
                .args(["logs", name])
                .output()
                .unwrap_or_else(|e| panic!("docker logs {name}: {e}"));
            assert!(output.status.success(), "docker logs {name} failed");
            search(
                &format!("the logs of `{name}`"),
                &[output.stdout, output.stderr].concat(),
                &hunted,
                &mut hits,
            );
        }
    }

    hits.sort();
    hits.dedup();
    assert!(
        hits.is_empty(),
        "RESIDUE: {} marker hit(s) of {} markers ({:?}) in:\n{}",
        hits.len(),
        forbidden_text.len(),
        scanned,
        hits.join("\n")
    );
}

// ---------------------------------------------------------------------------------------------------------------
// No metrics, no traces

/// The names (as the lock file spells them) of crates that export metrics, traces or logs to somewhere.
const EXPORTER_CRATES: [&str; 28] = [
    "opentelemetry",
    "opentelemetry-otlp",
    "opentelemetry_sdk",
    "opentelemetry-http",
    "opentelemetry-proto",
    "tracing-opentelemetry",
    "tracing-subscriber",
    "tracing-appender",
    "tracing-log",
    "tracing-journald",
    "tracing-bunyan-formatter",
    "metrics",
    "metrics-exporter-prometheus",
    "prometheus",
    "prometheus-client",
    "axum-prometheus",
    "sentry",
    "sentry-core",
    "sentry-tracing",
    "statsd",
    "cadence",
    "dogstatsd",
    "datadog-tracing",
    "tonic",
    "env_logger",
    "log4rs",
    "fern",
    "syslog",
];

/// What in the source would configure or write an exporter, a log file or a temporary file. Split in pieces, so
/// that this file does not hold them whole.
fn forbidden_in_source() -> Vec<String> {
    [
        ("open", "telemetry"),
        ("OT", "EL_"),
        ("prome", "theus"),
        ("sen", "try"),
        ("stats", "d"),
        ("data", "dog"),
        ("tracing_", "subscriber"),
        ("\"/", "metrics"),
        ("\"/v1/", "traces"),
        ("File::", "create"),
        ("Open", "Options"),
        ("fs::", "write"),
        ("fs::", "create_dir"),
        ("fs::", "File"),
        ("temp", "_dir"),
        ("temp", "file"),
        ("\"/", "tmp"),
        ("\"/var/", "tmp"),
        ("mk", "temp"),
        ("tmp", "file"),
        ("set_", "var"),
        ("set_", "current_dir"),
    ]
    .iter()
    .map(|(a, b)| format!("{a}{b}"))
    .collect()
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read a source dir").flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The code of a source file: without its comments and without its test module.
fn code_of(source: &str) -> String {
    // The test module is the last item of the files of this crate (`#[cfg(test)] mod tests {`); a file that is
    // only tests is skipped by name.
    let code = source
        .split("#[cfg(test)]\nmod tests")
        .next()
        .unwrap_or(source);
    code.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn residue_the_service_names_no_exporter_and_writes_no_file() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    // 1. The dependency lock: no crate that exports.
    let lock = std::fs::read_to_string(root.join("../Cargo.lock")).expect("read Cargo.lock");
    let packages: Vec<&str> = lock
        .lines()
        .filter_map(|l| l.strip_prefix("name = \""))
        .map(|l| l.trim_end_matches('"'))
        .collect();
    assert!(
        packages.contains(&"letterhead-api"),
        "the lock names the service"
    );
    for name in EXPORTER_CRATES {
        assert!(
            !packages.contains(&name),
            "Cargo.lock holds `{name}`, an exporter or a logger that writes elsewhere (AC-3.7: no metrics, no traces)"
        );
    }
    // `tracing` itself is the facade of the libraries the service links (the S3 client, hyper); with no
    // subscriber crate in the lock there is nothing to print or export, and the test above says so.
    assert!(
        !packages.contains(&"tracing-subscriber"),
        "a subscriber would print or export what the libraries emit"
    );

    // 2. The source: the service writes no file, names no exporter, and reads the environment in `env.rs` only.
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    assert!(files.len() > 15, "the service's sources were found");
    let pieces = forbidden_in_source();
    let mut reads_env: Vec<(String, Option<String>)> = Vec::new();
    for file in &files {
        let name = file
            .strip_prefix(root)
            .expect("relative")
            .display()
            .to_string();
        if name.ends_with("tests.rs") || name.ends_with("testing.rs") {
            continue;
        }
        let source = std::fs::read_to_string(file).expect("read source");
        let code = code_of(&source);
        for piece in &pieces {
            assert!(
                !code.contains(piece.as_str()),
                "{name} contains `{piece}`: the service keeps nothing and exports nothing (AC-3.7)"
            );
        }
        // The environment is read by name, in `env.rs`, and by `migrate` and `healthcheck` of `main.rs` (the
        // database and the port).
        for needle in ["env::var(", "var_os("] {
            for (at, _) in code.match_indices(needle) {
                let rest = &code[at + needle.len()..];
                let literal = rest
                    .trim_start()
                    .strip_prefix('"')
                    .and_then(|r| r.split('"').next())
                    .map(str::to_owned);
                reads_env.push((name.clone(), literal));
            }
        }
        // Reading a file is allowed where it is named: `/proc/<pid>/status` for the memory cap.
        for (at, _) in code.match_indices("fs::read") {
            let rest = &code[at..code.len().min(at + 120)];
            assert!(
                name.ends_with("pool/rss.rs") && rest.contains("/proc/"),
                "{name} reads a file: {rest}"
            );
        }
    }
    for (name, literal) in &reads_env {
        let allowed = name == "src/env.rs"
            || (name == "src/main.rs"
                && matches!(literal.as_deref(), Some("DATABASE_URL" | "PORT")));
        assert!(
            allowed,
            "{name} reads the environment ({literal:?}): a variable that configures an exporter would be seen in env.rs only"
        );
    }
    assert!(
        reads_env.iter().any(|(name, _)| name == "src/env.rs"),
        "env.rs reads the environment"
    );
    // The variables env.rs reads: none of an exporter's.
    let env_source = code_of(&std::fs::read_to_string(root.join("src/env.rs")).expect("env.rs"));
    let names: Vec<String> = env_source
        .split('"')
        .skip(1)
        .step_by(2)
        .filter(|s| {
            s.len() > 2
                && s.chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        })
        .map(str::to_owned)
        .collect();
    assert!(names.iter().any(|n| n == "DATABASE_URL"), "{names:?}");
    for name in &names {
        for prefix in [
            "OTEL",
            "SENTRY",
            "DD_",
            "STATSD",
            "PROMETHEUS",
            "NEW_RELIC",
            "HONEYCOMB",
            "RUST_LOG",
            "JAEGER",
            "ZIPKIN",
            "LOG_",
        ] {
            assert!(!name.starts_with(prefix), "env.rs reads `{name}`");
        }
    }

    // 3. The `Dockerfile` ships no agent and runs the binary alone.
    let dockerfile = std::fs::read_to_string(root.join("../Dockerfile")).expect("Dockerfile");
    for word in [
        "otel",
        "datadog",
        "newrelic",
        "prometheus",
        "statsd",
        "jaeger",
        "sentry",
        "VOLUME",
    ] {
        assert!(
            !dockerfile
                .to_ascii_lowercase()
                .contains(&word.to_ascii_lowercase()),
            "the Dockerfile mentions `{word}`"
        );
    }
}

/// The processes under `pid` (its workers); `None` when there is no `pgrep`.
fn children_of(pid: u32) -> Option<Vec<u32>> {
    let output = Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .ok()?;
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect(),
    )
}

/// `lsof -i` of a process: its network sockets. `None` when there is no `lsof`.
fn sockets_of(pid: u32) -> Option<Vec<String>> {
    let output = Command::new("lsof")
        .args(["-nP", "-a", "-p", &pid.to_string(), "-i"])
        .output()
        .ok()?;
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .skip(1)
            .map(str::to_owned)
            .collect(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn residue_no_exporter_is_configured_and_none_is_contacted() {
    let mut marks = Marks::new();
    let Some(world) = World::new(&marks).await else {
        return;
    };
    // A sink for every way an exporter could be told to reach out: a TCP listener (OTLP, a Sentry DSN, a push
    // gateway, a tracing collector) and a UDP socket (statsd, dogstatsd). Neither may ever be touched.
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let tcp_port = tcp.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&accepted);
    tokio::spawn(async move {
        while tcp.accept().await.is_ok() {
            counted.fetch_add(1, Ordering::SeqCst);
        }
    });
    let udp = tokio::net::UdpSocket::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let udp_port = udp.local_addr().expect("addr").port();
    let datagrams = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&datagrams);
    tokio::spawn(async move {
        let mut buffer = [0u8; 2048];
        while udp.recv_from(&mut buffer).await.is_ok() {
            counted.fetch_add(1, Ordering::SeqCst);
        }
    });
    let sink = format!("http://127.0.0.1:{tcp_port}");
    let extra: Vec<(&'static str, String)> = vec![
        ("OTEL_EXPORTER_OTLP_ENDPOINT", sink.clone()),
        (
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            format!("{sink}/v1/traces"),
        ),
        (
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            format!("{sink}/v1/metrics"),
        ),
        (
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            format!("{sink}/v1/logs"),
        ),
        ("OTEL_TRACES_EXPORTER", "otlp".to_owned()),
        ("OTEL_METRICS_EXPORTER", "otlp".to_owned()),
        ("OTEL_LOGS_EXPORTER", "otlp".to_owned()),
        ("OTEL_SERVICE_NAME", "letterhead-api".to_owned()),
        ("SENTRY_DSN", format!("http://key@127.0.0.1:{tcp_port}/1")),
        ("PROMETHEUS_PUSHGATEWAY", sink.clone()),
        ("STATSD_HOST", "127.0.0.1".to_owned()),
        ("STATSD_PORT", udp_port.to_string()),
        ("DD_AGENT_HOST", "127.0.0.1".to_owned()),
        ("DD_DOGSTATSD_PORT", udp_port.to_string()),
        ("DD_TRACE_AGENT_PORT", tcp_port.to_string()),
        ("JAEGER_ENDPOINT", sink.clone()),
        ("ZIPKIN_ENDPOINT", sink.clone()),
        ("RUST_LOG", "trace".to_owned()),
        ("RUST_BACKTRACE", "full".to_owned()),
    ];
    let server = world.server(&extra).await;
    let service = world.auth.service("letterhead-test-caller");
    let reader = world.auth.person("u-access");
    let admin = world.auth.person("u-admin");

    // Work for the service to do and to report on: a success and a refusal of each route, a save.
    let document_ok = document("welld_it", &mut marks, "exporter-ok");
    let mut document_bad = document("welld_it", &mut marks, "exporter-bad");
    document_bad["blocks"][1]["runs"][0]["style"] = json!("nope");
    for route in ["/v1/render/pdf", "/v1/render/preview"] {
        assert_eq!(
            server.post_json(route, &service, &document_ok).await.status,
            200
        );
        assert_eq!(
            server
                .post_json(route, &service, &document_bad)
                .await
                .status,
            422
        );
    }
    let form = config("{legal_name}", 25.0);
    assert_eq!(
        server
            .post_json(
                "/v1/letterheads/welld_it/preview",
                &reader,
                &json!({ "config": form, "language": "en" })
            )
            .await
            .status,
        200
    );
    assert_eq!(
        server
            .post_json(
                "/v1/letterheads/welld_it/versions",
                &admin,
                &json!({ "baseVersion": 1, "config": form })
            )
            .await
            .status,
        201
    );

    // The places where a metrics or a trace endpoint would be: none answers. (A 404 or a 401: no route of that name.)
    for path in [
        "/metrics",
        "/v1/metrics",
        "/v1/traces",
        "/debug/pprof",
        "/debug/vars",
        "/actuator/prometheus",
        "/prometheus",
        "/stats",
        "/status",
    ] {
        for bearer in [None, Some(service.as_str())] {
            let reply = server.get(path, bearer).await;
            assert!(
                matches!(reply.status, 404 | 401 | 405),
                "`{path}` answers {}: {}",
                reply.status,
                reply.text()
            );
            assert!(
                !reply.text().contains("# TYPE") && !reply.text().contains("# HELP"),
                "`{path}` serves metrics"
            );
        }
    }

    // Sockets: one listener, on the port of the service; no UDP socket; none in a worker but the pipes.
    let pid = server.child.id();
    match sockets_of(pid) {
        None => eprintln!("NOTICE: no `lsof`: the sockets of the service were not listed"),
        Some(sockets) => {
            let listening: Vec<&String> =
                sockets.iter().filter(|l| l.contains("(LISTEN)")).collect();
            assert_eq!(
                listening.len(),
                1,
                "the service listens on one port only: {sockets:#?}"
            );
            assert!(
                listening[0].contains(&format!(":{}", server.port)),
                "{listening:?}"
            );
            assert!(
                !sockets.iter().any(|l| l.contains("UDP")),
                "the service holds a UDP socket: {sockets:#?}"
            );
            let outbound: Vec<&String> = sockets
                .iter()
                .filter(|l| l.contains("->") && !l.contains("(LISTEN)"))
                .collect();
            for line in &outbound {
                let to_sink = line.contains(&format!("->127.0.0.1:{tcp_port}"));
                assert!(!to_sink, "the service is connected to the sink: {line}");
            }
            match children_of(pid) {
                None => eprintln!("NOTICE: no `pgrep`: the sockets of the workers were not listed"),
                Some(workers) => {
                    assert!(
                        !workers.is_empty(),
                        "the pool's workers are children of the service"
                    );
                    for worker in workers {
                        if let Some(sockets) = sockets_of(worker) {
                            assert!(sockets.is_empty(), "a worker holds a socket: {sockets:#?}");
                        }
                    }
                }
            }
        }
    }

    // Nothing reached out.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        0,
        "the service connected to an exporter's address"
    );
    assert_eq!(
        datagrams.load(Ordering::SeqCst),
        0,
        "the service sent a datagram to a metrics address"
    );
    let (out, err) = server.stop();
    // And what it printed is still only its own lines, though it was asked for the trace level.
    for line in out.iter().chain(err.iter()) {
        assert!(
            is_known_line(line),
            "a line that is not the service's: {line}"
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The stack of `scripts/residue-check.sh`'s own test

/// Not part of the suite (`cargo test -- --ignored residue_stack_for_the_script`): serves a fake `auth` on
/// `RESIDUE_FAKE_AUTH_PORT` for `RESIDUE_FAKE_AUTH_SECONDS` (it mints the service token of client `residue-check`,
/// secret `residue-secret`) and migrates and seeds the test database (public schema) with a letterhead for
/// `welld_it`, so that a containerised service can be pointed at both and the script run against it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "serves a fake auth for the manual test of scripts/residue-check.sh"]
async fn residue_stack_for_the_script() {
    let Some(env) = test_env() else { return };
    let port = std::env::var("RESIDUE_FAKE_AUTH_PORT").unwrap_or_else(|_| "18099".to_owned());
    let seconds: u64 = std::env::var("RESIDUE_FAKE_AUTH_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let repo = Repo::connect(&env.database_url, 2).await.expect("connect");
    repo.migrate().await.expect("migrate");
    if repo
        .active_version(Entity::WelldIt)
        .await
        .expect("read")
        .is_none()
    {
        repo.save(NewVersion {
            entity: Entity::WelldIt,
            base_version: 0,
            layout_version: 1,
            config: config("{legal_name}", 25.0),
            asset_ids: Vec::new(),
            actor_sub: "test".into(),
            actor_name: "Test Person".into(),
            changed_settings: vec!["margins".into()],
        })
        .await
        .expect("seed a letterhead");
    }
    let auth = FakeAuth::start(&format!("0.0.0.0:{port}")).await;
    println!("fake auth on {} for {seconds} s", auth.base);
    tokio::time::sleep(Duration::from_secs(seconds)).await;
}
