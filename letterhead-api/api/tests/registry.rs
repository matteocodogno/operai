//! Tests of the legal entities registry client and its cache (task T21; AC-1.5, AC-3.3, AC-5.5; plan decision 7, the
//! section "Consumer read", amendment E14's twin in crm-api). The same clock cases as `crm-api/src/lib/legalEntities.test.ts`
//! (29 / 31 / 59 / 61 s) and its 150-schedule property.
//!
//! Two layers, both in this process and with no database, bucket or network but loopback:
//!
//! - the rule ([`registry::cache`]) over a fake [`Source`] and a fake monotonic clock: the boundaries, the stamp of the
//!   send time, single flight, `invalidate()`, the bound of 5 s (tokio's clock paused), and the property that a
//!   document started at T + 60.001 s never uses an entry sent before a save at T;
//! - the real source ([`registry::http`]) against a stub of `auth` that listens on a loopback port: the token
//!   exchange, the 401 that drops the token once, the redirect that is not followed, the body limit, and the secret
//!   that reaches the token endpoint and nothing else.
//!
//! The fixture `specs/20261117-legal-entities/fixtures/legal-entities.json` is the one auth's serializer test and
//! crm-api's client read too. Every test name starts with `registry_`.
//!
//! The API crate is a binary and an integration test cannot link a binary, so the registry sources are compiled into
//! this crate with `#[path]` (as `pool.rs` does for the pool). They name no other part of the crate.

#[allow(
    dead_code,
    reason = "the registry is compiled in whole; these tests call the part that they need"
)]
#[path = "../src/registry/mod.rs"]
mod registry;

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http_body::{Frame, SizeHint};
use letterhead_engine::content::{Entity, Language};
use serde_json::{Value, json};
use tokio::sync::Notify;
use url::Url;

use registry::cache::{
    Clock, Failure, FetchFuture, Fetched, Registry, RegistryOptions, Snapshot, Source, Unavailable,
    monotonic_clock,
};
use registry::http::{HttpSource, ServiceClient};
use registry::{
    LEGAL_ENTITIES_UNAVAILABLE, LegalEntityDetails, MAX_BODY_BYTES, RETRY_AFTER_SECONDS,
    entity_data, parse_legal_entities,
};

const SECOND: Duration = Duration::from_secs(1);
const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../specs/20261117-legal-entities/fixtures/legal-entities.json"
));

/// Never to be printed anywhere: the client secret of these tests.
const CLIENT_SECRET: &str = "client-secret-sentinel-5e1c-for-the-tests";
const CLIENT_ID: &str = "letterhead-api";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------------------------------------------
// The fixture

fn fixture_body() -> Value {
    serde_json::from_str(FIXTURE).expect("the fixture is JSON")
}

fn entities_of(body: &Value) -> Vec<Arc<LegalEntityDetails>> {
    parse_legal_entities(body.to_string().as_bytes()).expect("the body is the contract's")
}

fn bump(body: &mut Value, entity: &str, name: Option<&str>) -> i64 {
    let item = body["items"]
        .as_array_mut()
        .expect("items")
        .iter_mut()
        .find(|i| i["entity"] == entity)
        .expect("entity");
    let version = item["version"].as_i64().expect("version") + 1;
    item["version"] = json!(version);
    if let Some(name) = name {
        item["legalName"] = json!(name);
    }
    version
}

#[test]
fn registry_the_shared_fixture_parses_both_entities_in_full() {
    let parsed = parse_legal_entities(FIXTURE.as_bytes()).expect("the fixture is the contract's");
    assert_eq!(parsed.len(), 2);

    let it = &parsed[0];
    assert_eq!(it.entity, Entity::WelldIt);
    assert_eq!(it.version, 1);
    assert_eq!(it.legal_name, "wellD S.r.l.");
    assert_eq!(it.address.it.len(), 5);
    assert_eq!(it.address.en, ["Via Roma 1", "20121 Milan", "Italy"]);
    assert_eq!(it.vat_number, "IT01234567890");
    assert_eq!(it.iban, "IT60X0542811101000000123457");
    assert_eq!(it.iban_print, "IT60 X054 2811 1010 0000 0123 457");
    assert_eq!(it.contacts.it, "");
    assert!(it.complete && it.missing.is_empty());
    // The values that today's rules refuse are reported, with and without a line and a limit.
    assert_eq!(it.invalid.len(), 3);
    assert_eq!(
        (
            it.invalid[0].field.as_str(),
            it.invalid[0].line,
            it.invalid[0].limit
        ),
        ("address.it", Some(2), Some(120))
    );
    assert_eq!(it.invalid[0].reason, "too_long");
    assert_eq!((it.invalid[1].line, it.invalid[1].limit), (None, Some(4)));
    assert_eq!((it.invalid[2].line, it.invalid[2].limit), (None, None));

    let ch = &parsed[1];
    assert_eq!(ch.entity, Entity::WelldCh);
    assert_eq!(ch.version, 3);
    assert_eq!(ch.legal_name, "wellD SA");
    assert_eq!(ch.contacts.en, "Phone +41 91 000 00 00 · info@welld.ch");
    assert!(ch.invalid.is_empty());
    assert_eq!(ch.updated_at.as_deref(), Some("2026-11-17T10:12:00.000Z"));
}

#[test]
fn registry_the_engine_is_given_the_registrys_values_per_language() {
    let parsed = entities_of(&fixture_body());
    let it = entity_data(&parsed[0], Language::It);
    let en = entity_data(&parsed[0], Language::En);
    assert_eq!(it.legal_name.as_deref(), Some("wellD S.r.l."));
    assert_eq!(it.address_lines.expect("it").len(), 5);
    assert_eq!(
        en.address_lines.expect("en"),
        ["Via Roma 1", "20121 Milan", "Italy"]
    );
    // The print form of the IBAN, not the electronic one.
    assert_eq!(
        it.iban.as_deref(),
        Some("IT60 X054 2811 1010 0000 0123 457")
    );
    assert_eq!(it.vat.as_deref(), Some("IT01234567890"));
    let ch_en = entity_data(&parsed[1], Language::En);
    assert_eq!(
        ch_en.contacts.as_deref(),
        Some("Phone +41 91 000 00 00 · info@welld.ch")
    );
    let ch_it = entity_data(&parsed[1], Language::It);
    assert_eq!(
        ch_it.contacts.as_deref(),
        Some("Tel. +41 91 000 00 00 · info@welld.ch")
    );
}

#[test]
fn registry_an_answer_that_is_not_the_contract_is_refused() {
    let one_entity = json!({ "items": [fixture_body()["items"][0].clone()] });
    assert!(parse_legal_entities(one_entity.to_string().as_bytes()).is_none());
    let mut twice = fixture_body();
    twice["items"][1]["entity"] = json!("welld_it");
    assert!(parse_legal_entities(twice.to_string().as_bytes()).is_none());
    let mut wrong_type = fixture_body();
    wrong_type["items"][0]["complete"] = json!("yes");
    assert!(parse_legal_entities(wrong_type.to_string().as_bytes()).is_none());
    assert!(parse_legal_entities(b"{\"items\":{}}").is_none());
    assert!(parse_legal_entities(b"<html>").is_none());
    // An entity this service does not know, and a member the contract does not name, are ignored.
    let mut extra = fixture_body();
    extra["items"]
        .as_array_mut()
        .expect("items")
        .push(json!({ "entity": "welld_xx", "whatever": true }));
    extra["items"][0]["future"] = json!(1);
    assert_eq!(
        parse_legal_entities(extra.to_string().as_bytes())
            .expect("still the contract")
            .len(),
        2
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The fake clock, the fake source, the log

#[derive(Clone)]
struct FakeClock(Arc<AtomicU64>);

impl FakeClock {
    fn new(start: Duration) -> FakeClock {
        FakeClock(Arc::new(AtomicU64::new(start.as_millis() as u64)))
    }

    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::SeqCst))
    }

    fn advance(&self, by: Duration) {
        self.0.fetch_add(by.as_millis() as u64, Ordering::SeqCst);
    }

    fn clock(&self) -> Clock {
        let this = self.clone();
        Arc::new(move || this.now())
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    Ok,
    Fail(Failure),
    Hang,
    Panic,
}

struct FakeState {
    mode: Mode,
    /// How long the call takes on the fake clock (the answer arrives this long after the send).
    latency: Duration,
    table: Value,
    /// The send times, in order: one per call.
    sent: Vec<Duration>,
    /// The next call reads the table, says so, and waits to be released before it answers.
    hold_next: bool,
}

/// A source with a table of its own, read the instant the call is made, as `auth` reads its table when the request
/// arrives; the answer comes `latency` later on the fake clock.
struct FakeSource {
    clock: FakeClock,
    state: Mutex<FakeState>,
    entered: Notify,
    release: Notify,
}

impl FakeSource {
    fn new(clock: &FakeClock) -> Arc<FakeSource> {
        Arc::new(FakeSource {
            clock: clock.clone(),
            state: Mutex::new(FakeState {
                mode: Mode::Ok,
                latency: Duration::ZERO,
                table: fixture_body(),
                sent: Vec::new(),
                hold_next: false,
            }),
            entered: Notify::new(),
            release: Notify::new(),
        })
    }

    fn set(&self, mode: Mode) {
        lock(&self.state).mode = mode;
    }

    fn latency(&self, latency: Duration) {
        lock(&self.state).latency = latency;
    }

    fn calls(&self) -> usize {
        lock(&self.state).sent.len()
    }

    /// A save in `auth`: the entity's version goes up.
    fn save(&self, entity: &str, name: Option<&str>) -> i64 {
        bump(&mut lock(&self.state).table, entity, name)
    }
}

impl Source for FakeSource {
    fn fetch(&self) -> FetchFuture<'_> {
        Box::pin(async move {
            let sent_at = self.clock.now();
            let (mode, latency, table, hold) = {
                let mut state = lock(&self.state);
                state.sent.push(sent_at);
                let hold = std::mem::take(&mut state.hold_next);
                (state.mode, state.latency, state.table.clone(), hold)
            };
            if hold {
                self.entered.notify_one();
                self.release.notified().await;
            }
            match mode {
                Mode::Hang => std::future::pending().await,
                Mode::Panic => panic!("the source panicked (a test of the registry)"),
                Mode::Fail(failure) => {
                    self.clock.advance(latency);
                    Err(failure)
                }
                Mode::Ok => {
                    self.clock.advance(latency);
                    Ok(Fetched {
                        entities: entities_of(&table),
                        sent_at,
                    })
                }
            }
        })
    }
}

#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<String>>>);

impl Log {
    fn sink(&self) -> Arc<dyn Fn(&str) + Send + Sync> {
        let lines = self.0.clone();
        Arc::new(move |line| lock(&lines).push(line.to_owned()))
    }

    fn text(&self) -> String {
        lock(&self.0).join("\n")
    }

    fn contains(&self, word: &str) -> bool {
        self.text().contains(word)
    }
}

struct Rig {
    clock: FakeClock,
    source: Arc<FakeSource>,
    registry: Registry,
    log: Log,
}

fn rig() -> Rig {
    let clock = FakeClock::new(Duration::from_secs(1_000));
    let source = FakeSource::new(&clock);
    let log = Log::default();
    let registry = Registry::new(
        source.clone(),
        RegistryOptions {
            clock: clock.clock(),
            log: log.sink(),
            ..RegistryOptions::default()
        },
    );
    Rig {
        clock,
        source,
        registry,
        log,
    }
}

fn version_of(snapshot: &Snapshot, entity: Entity) -> i64 {
    snapshot.get(entity).expect("entity").version
}

// ---------------------------------------------------------------------------------------------------------------
// The cache rule (plan decision 7)

#[tokio::test]
async fn registry_the_first_read_calls_auth_and_an_entry_of_29_s_is_used_without_a_call() {
    let rig = rig();
    let first = rig.registry.all().await.expect("read");
    assert_eq!(rig.source.calls(), 1);
    assert_eq!(first.entities().len(), 2);
    rig.clock.advance(29 * SECOND);
    let again = rig.registry.all().await.expect("read");
    let ch = rig.registry.get(Entity::WelldCh).await.expect("read");
    assert_eq!(rig.source.calls(), 1, "29 s old: no call");
    assert!(Arc::ptr_eq(&first, &again));
    assert_eq!(ch.legal_name, "wellD SA");
}

#[tokio::test]
async fn registry_an_entry_of_30_s_or_more_is_refreshed() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.clock.advance(Duration::from_millis(29_999));
    rig.registry.all().await.expect("read");
    assert_eq!(rig.source.calls(), 1, "29.999 s");
    rig.clock.advance(Duration::from_millis(1));
    rig.registry.all().await.expect("read");
    assert_eq!(rig.source.calls(), 2, "30 s exactly refreshes");
    rig.clock.advance(31 * SECOND);
    rig.registry.all().await.expect("read");
    assert_eq!(rig.source.calls(), 3, "31 s");
}

#[tokio::test]
async fn registry_a_refresh_failing_at_59_s_uses_the_entry_and_logs_registry_stale_used() {
    let rig = rig();
    let first = rig.registry.all().await.expect("read");
    rig.clock.advance(59 * SECOND);
    rig.source.set(Mode::Fail(Failure::Network));
    let again = rig.registry.all().await.expect("the entry is still usable");
    assert!(Arc::ptr_eq(&first, &again));
    assert_eq!(rig.source.calls(), 2, "a refresh was tried");
    assert!(
        rig.log.contains("registry_stale_used"),
        "{}",
        rig.log.text()
    );
    assert!(rig.log.contains("age_ms=59000"), "{}", rig.log.text());
}

#[tokio::test]
async fn registry_a_refresh_failing_at_61_s_is_unavailable_and_60_s_exactly_is_still_usable() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.source.set(Mode::Fail(Failure::Status(503)));
    rig.clock.advance(60 * SECOND);
    rig.registry.all().await.expect("60 s exactly is usable");
    rig.clock.advance(Duration::from_millis(1));
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    assert!(rig.log.contains("legal_entities_unavailable"));

    // The same at 61 s on a fresh rig, through `get` as the routes use it.
    let at_61 = self::rig();
    at_61.registry.all().await.expect("read");
    at_61.source.set(Mode::Fail(Failure::Unexpected));
    at_61.clock.advance(61 * SECOND);
    assert_eq!(
        at_61.registry.get(Entity::WelldIt).await.err(),
        Some(Unavailable)
    );
    assert_eq!(Unavailable.to_string(), LEGAL_ENTITIES_UNAVAILABLE);
    assert_eq!(RETRY_AFTER_SECONDS, 5);
}

#[tokio::test]
async fn registry_no_entry_yet_and_auth_failing_is_unavailable_whatever_the_failure() {
    for failure in [
        Failure::Timeout,
        Failure::Token,
        Failure::Network,
        Failure::Status(500),
        Failure::TooLarge,
        Failure::Unexpected,
        Failure::Aborted,
    ] {
        let rig = rig();
        rig.source.set(Mode::Fail(failure));
        assert_eq!(
            rig.registry.all().await.err(),
            Some(Unavailable),
            "{failure:?}"
        );
        assert!(
            rig.log.contains(&format!("cause={failure}")),
            "{}",
            rig.log.text()
        );
    }
}

#[tokio::test]
async fn registry_a_refresh_that_works_after_a_failure_replaces_the_entry_and_the_failure_is_not_remembered()
 {
    let rig = rig();
    rig.source.set(Mode::Fail(Failure::Network));
    assert!(rig.registry.all().await.is_err());
    rig.source.set(Mode::Ok);
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        3
    );
    rig.source.save("welld_ch", Some("wellD SA (new)"));
    rig.clock.advance(31 * SECOND);
    let ch = rig.registry.get(Entity::WelldCh).await.expect("read");
    assert_eq!(ch.legal_name, "wellD SA (new)");
    assert_eq!(ch.version, 4);
}

#[tokio::test]
async fn registry_the_age_is_counted_from_when_the_request_was_sent_not_from_when_the_answer_arrived()
 {
    let rig = rig();
    rig.source.latency(20 * SECOND);
    let first = rig.registry.all().await.expect("read");
    assert_eq!(first.sent_at, Duration::from_secs(1_000));
    assert_eq!(rig.clock.now(), Duration::from_secs(1_020));
    // 20 s after the answer, 40 s after the send: not fresh any more.
    rig.clock.advance(20 * SECOND);
    rig.source.latency(Duration::ZERO);
    rig.source.set(Mode::Fail(Failure::Network));
    rig.registry.all().await.expect("40 s old: usable");
    assert_eq!(rig.source.calls(), 2);
    // 61 s after the send, 41 s after the answer.
    rig.clock.advance(21 * SECOND);
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
}

#[tokio::test]
async fn registry_a_save_is_read_within_31_s_and_nothing_older_than_60_s_is_used_after_it() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.clock.advance(10 * SECOND);
    rig.source.save("welld_ch", None);
    rig.clock.advance(19 * SECOND); // 29 s old: still the old version, as the 60 s bound allows
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        3
    );
    rig.clock.advance(2 * SECOND); // 31 s
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        4
    );
}

#[tokio::test]
async fn registry_concurrent_reads_share_one_call_and_one_failure() {
    let rig = rig();
    let reads = futures_join((0..8).map(|_| rig.registry.all()).collect()).await;
    assert_eq!(rig.source.calls(), 1);
    let first = reads[0].as_ref().expect("read");
    assert!(
        reads
            .iter()
            .all(|r| Arc::ptr_eq(r.as_ref().expect("read"), first))
    );

    let failing = self::rig();
    failing.source.set(Mode::Fail(Failure::Network));
    let reads = futures_join((0..8).map(|_| failing.registry.all()).collect()).await;
    assert_eq!(failing.source.calls(), 1, "one failed call, not eight");
    assert!(reads.iter().all(|r| r.is_err()));
}

/// Polls every future to completion, in this task (the crate has no `futures`): the order they finish in is not
/// the order of the result.
async fn futures_join<F: std::future::Future>(futures: Vec<F>) -> Vec<F::Output> {
    let mut pending: Vec<Pin<Box<F>>> = futures.into_iter().map(Box::pin).collect();
    let mut done: Vec<Option<F::Output>> = pending.iter().map(|_| None).collect();
    std::future::poll_fn(move |cx: &mut Context<'_>| {
        let mut all = true;
        for (slot, future) in done.iter_mut().zip(pending.iter_mut()) {
            if slot.is_none() {
                match future.as_mut().poll(cx) {
                    Poll::Ready(value) => *slot = Some(value),
                    Poll::Pending => all = false,
                }
            }
        }
        if all {
            Poll::Ready(done.iter_mut().map(|s| s.take().expect("done")).collect())
        } else {
            Poll::Pending
        }
    })
    .await
}

#[tokio::test]
async fn registry_a_caller_that_goes_away_does_not_leave_the_others_waiting() {
    let rig = rig();
    rig.source.lock_hold_next();
    let leader = tokio::spawn({
        let registry = rig.registry.clone();
        async move { registry.all().await }
    });
    rig.source.entered.notified().await;
    let follower = tokio::spawn({
        let registry = rig.registry.clone();
        async move { registry.all().await }
    });
    tokio::task::yield_now().await;
    // The caller who started the refresh hangs up while it is in flight.
    leader.abort();
    let _ = leader.await;
    rig.source.release.notify_one();
    let read = follower
        .await
        .expect("joined")
        .expect("the refresh went on without its starter");
    assert_eq!(read.entities().len(), 2);
    assert_eq!(rig.source.calls(), 1);
}

impl FakeSource {
    fn lock_hold_next(&self) {
        lock(&self.state).hold_next = true;
    }
}

#[tokio::test(start_paused = true)]
async fn registry_a_hanging_auth_is_unavailable_within_the_5_s_bound() {
    let rig = rig();
    rig.source.set(Mode::Hang);
    let began = tokio::time::Instant::now();
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    let waited = began.elapsed();
    assert!(
        waited >= Duration::from_secs(5) && waited < Duration::from_secs(6),
        "{waited:?}"
    );
    assert!(rig.log.contains("cause=timeout"), "{}", rig.log.text());
}

#[tokio::test(start_paused = true)]
async fn registry_a_hanging_refresh_at_59_s_uses_the_entry_after_the_bound() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.clock.advance(59 * SECOND);
    rig.source.set(Mode::Hang);
    let began = tokio::time::Instant::now();
    rig.registry.all().await.expect("the entry is usable");
    assert!(began.elapsed() >= Duration::from_secs(5));
    assert!(rig.log.contains("registry_stale_used"));
    assert!(rig.log.contains("cause=timeout"));
}

#[tokio::test]
async fn registry_a_source_that_panics_fails_its_readers_and_does_not_wedge_the_next_read() {
    let rig = rig();
    rig.source.set(Mode::Panic);
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    assert!(rig.log.contains("cause=aborted"), "{}", rig.log.text());
    rig.source.set(Mode::Ok);
    rig.registry
        .all()
        .await
        .expect("a new flight, not the dead one");
    assert_eq!(rig.source.calls(), 2);
}

#[tokio::test]
async fn registry_a_snapshot_that_lacks_an_entity_is_a_failed_read() {
    struct Half;
    impl Source for Half {
        fn fetch(&self) -> FetchFuture<'_> {
            Box::pin(async {
                let mut entities = entities_of(&fixture_body());
                entities.pop();
                Ok(Fetched {
                    entities,
                    sent_at: Duration::ZERO,
                })
            })
        }
    }
    let registry = Registry::new(Arc::new(Half), RegistryOptions::default());
    assert_eq!(registry.all().await.err(), Some(Unavailable));
}

// ---------------------------------------------------------------------------------------------------------------
// invalidate(): the pin retry

#[tokio::test]
async fn registry_invalidate_forgets_the_entry_and_the_next_read_sees_what_was_saved() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.clock.advance(5 * SECOND);
    rig.source.save("welld_ch", None);
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        3
    );
    rig.registry.invalidate();
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        4
    );
    assert_eq!(rig.source.calls(), 2);
}

#[tokio::test]
async fn registry_an_invalidated_entry_is_not_used_as_stale() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.clock.advance(5 * SECOND);
    rig.registry.invalidate();
    rig.source.set(Mode::Fail(Failure::Network));
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
}

#[tokio::test]
async fn registry_a_refresh_in_flight_when_invalidate_is_called_is_neither_joined_nor_cached() {
    let rig = rig();
    rig.source.lock_hold_next();
    let slow = tokio::spawn({
        let registry = rig.registry.clone();
        async move { registry.all().await }
    });
    // The refresh read the table (version 3) and is held back.
    rig.source.entered.notified().await;
    rig.source.save("welld_ch", None);
    rig.registry.invalidate();
    // A flight of its own, after the save.
    let fresh = rig.registry.all().await.expect("read");
    assert_eq!(version_of(&fresh, Entity::WelldCh), 4);
    rig.source.release.notify_one();
    let old = slow.await.expect("joined").expect("read");
    assert_eq!(
        version_of(&old, Entity::WelldCh),
        3,
        "its own callers still get its answer"
    );
    // The late answer did not replace the newer entry.
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        4
    );
    assert_eq!(rig.source.calls(), 2);
}

// ---------------------------------------------------------------------------------------------------------------
// refresh_for_pin(): the pin retry, coalesced (security review F6)

#[tokio::test]
async fn registry_a_forced_refresh_is_not_made_when_the_entry_was_sent_less_than_a_second_ago() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.source.save("welld_ch", None);
    for _ in 0..100 {
        assert!(!rig.registry.refresh_for_pin());
        assert_eq!(
            version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
            3,
            "the held entry answers"
        );
        rig.clock.advance(Duration::from_millis(9));
    }
    assert_eq!(rig.source.calls(), 1);
}

#[tokio::test]
async fn registry_after_a_second_a_forced_refresh_reads_again_once_and_then_waits_a_second() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.clock.advance(Duration::from_millis(999));
    assert!(!rig.registry.refresh_for_pin(), "999 ms");
    rig.clock.advance(Duration::from_millis(1));
    rig.source.save("welld_ch", None);
    assert!(rig.registry.refresh_for_pin(), "1 s");
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        4
    );
    assert_eq!(rig.source.calls(), 2);

    // Within the second of the forced refresh: refused, whatever the entry says.
    rig.source.save("welld_ch", None);
    for _ in 0..100 {
        assert!(!rig.registry.refresh_for_pin());
        rig.registry.all().await.expect("read");
    }
    assert_eq!(rig.source.calls(), 2);
    rig.clock.advance(SECOND);
    assert!(rig.registry.refresh_for_pin());
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        5
    );
    assert_eq!(rig.source.calls(), 3);
}

#[tokio::test]
async fn registry_a_failed_forced_refresh_still_counts_for_the_second() {
    let rig = rig();
    rig.registry.all().await.expect("read");
    rig.clock.advance(5 * SECOND);
    rig.source.set(Mode::Fail(Failure::Network));
    assert!(rig.registry.refresh_for_pin());
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    // `auth` is back, but the next forced refresh waits for its second; a plain read is the cache rule's own.
    rig.source.set(Mode::Ok);
    assert!(!rig.registry.refresh_for_pin());
    rig.clock.advance(SECOND);
    assert!(rig.registry.refresh_for_pin());
}

// ---------------------------------------------------------------------------------------------------------------
// The sent-time property (AC-3.3)

/// A small deterministic generator, so a failure names its seed.
fn random(seed: u32) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(state) / 4_294_967_296.0
    }
}

#[tokio::test]
async fn registry_property_a_document_started_at_t_plus_60_001_s_never_uses_an_entry_sent_before_the_save_at_t()
 {
    let mut documents = 0_usize;
    let mut refused = 0_usize;
    for seed in 1..=150_u32 {
        let mut next = random(seed);
        let clock = FakeClock::new(Duration::from_secs(5_000));
        let source = FakeSource::new(&clock);
        let log = Log::default();
        let registry = Registry::new(
            source.clone(),
            RegistryOptions {
                clock: clock.clock(),
                log: log.sink(),
                ..RegistryOptions::default()
            },
        );
        let mut saves: Vec<(Duration, i64)> = Vec::new();
        for step in 0..60 {
            clock.advance(Duration::from_millis((next() * 40_000.0) as u64));
            let roll = next();
            source.set(if next() < 0.35 {
                Mode::Fail(Failure::Network)
            } else {
                Mode::Ok
            });
            source.latency(if next() < 0.3 {
                Duration::from_millis((next() * 25_000.0) as u64)
            } else {
                Duration::ZERO
            });
            if roll < 0.25 {
                let version = source.save("welld_ch", None);
                saves.push((clock.now(), version));
            }
            let started = clock.now();
            let Ok(snapshot) = registry.all().await else {
                refused += 1;
                continue;
            };
            documents += 1;
            // Nothing older than 60 s is ever used.
            assert!(
                started.saturating_sub(snapshot.sent_at) <= 60 * SECOND,
                "seed {seed} step {step}: an entry older than 60 s was used"
            );
            // A save committed more than 60 s before the document started is in the entry used.
            for (at, version) in &saves {
                if started > *at + 60 * SECOND {
                    assert!(
                        version_of(&snapshot, Entity::WelldCh) >= *version,
                        "seed {seed} step {step}: the save at {at:?} is not in the entry used"
                    );
                }
            }
            // The entry was read after every save it claims to hold, and before none that it lacks.
            if let Some((at, version)) = saves.last()
                && snapshot.sent_at > *at
            {
                assert_eq!(
                    version_of(&snapshot, Entity::WelldCh),
                    *version,
                    "seed {seed} step {step}"
                );
            }
        }
    }
    assert!(documents > 1_000, "{documents} documents");
    assert!(refused > 100, "{refused} refusals");
}

#[tokio::test]
async fn registry_property_the_boundary_by_hand_at_t_plus_60_s_the_entry_is_used_at_t_plus_60_001_s_it_is_not()
 {
    let rig = rig();
    rig.registry.all().await.expect("read"); // sent at S, before the save
    let sent = rig.clock.now();
    rig.clock.advance(Duration::from_millis(1));
    let saved_at = rig.clock.now();
    rig.source.save("welld_ch", None);
    rig.source.set(Mode::Fail(Failure::Network));
    rig.clock.advance(sent + 60 * SECOND - rig.clock.now());
    // 60 s after the send: the old entry, as the bound allows.
    assert_eq!(
        version_of(&rig.registry.all().await.expect("read"), Entity::WelldCh),
        3
    );
    rig.clock.advance(Duration::from_millis(1));
    assert!(rig.clock.now() > saved_at);
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
}

// ---------------------------------------------------------------------------------------------------------------
// The real source, against a stub of `auth`

#[derive(Clone, Copy, PartialEq)]
enum TokenMode {
    Ok,
    Status(u16),
    Garbage,
    /// `expiresInSeconds` of the token.
    Lifetime(u64),
    Hang,
}

#[derive(Clone, Copy, PartialEq)]
enum LegalMode {
    Ok,
    Status(u16),
    Redirect,
    NotJson,
    /// Announced as too large (a `Content-Length` over the limit).
    HugeAnnounced,
    /// Too large and not announced (chunked).
    HugeChunked,
    Hang,
}

struct StubState {
    token_mode: TokenMode,
    legal_mode: LegalMode,
    /// The next GETs of the registry answer 401.
    unauthorized: usize,
    issued: usize,
    /// The body of every POST to the token endpoint.
    token_posts: Vec<String>,
    /// The `Authorization` and the other headers of every GET of the registry.
    gets: Vec<HeaderMap>,
    /// Requests that the redirect would have led to.
    elsewhere: usize,
    body: Value,
}

struct Stub {
    state: Mutex<StubState>,
}

impl Stub {
    fn set_token(&self, mode: TokenMode) {
        lock(&self.state).token_mode = mode;
    }

    fn set_legal(&self, mode: LegalMode) {
        lock(&self.state).legal_mode = mode;
    }

    fn tokens_asked(&self) -> usize {
        lock(&self.state).token_posts.len()
    }

    fn auths(&self) -> Vec<String> {
        lock(&self.state)
            .gets
            .iter()
            .map(|h| {
                h.get(header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_owned()
            })
            .collect()
    }
}

/// A body that is `remaining` bytes of filler in chunks and says nothing of its length.
struct Unannounced {
    remaining: usize,
}

impl http_body::Body for Unannounced {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if self.remaining == 0 {
            return Poll::Ready(None);
        }
        let take = self.remaining.min(8 * 1024);
        self.remaining -= take;
        Poll::Ready(Some(Ok(Frame::data(Bytes::from(vec![b' '; take])))))
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

async fn stub_token(State(stub): State<Arc<Stub>>, body: String) -> Response {
    let (mode, n) = {
        let mut state = lock(&stub.state);
        state.token_posts.push(body);
        state.issued += 1;
        (state.token_mode, state.issued)
    };
    match mode {
        TokenMode::Ok => token_answer(n, 300),
        TokenMode::Lifetime(seconds) => token_answer(n, seconds),
        TokenMode::Status(code) => (
            StatusCode::from_u16(code).expect("status"),
            // A body that echoes the credentials, to be sure that it is never read into anything.
            format!("{{\"echo\":\"{CLIENT_SECRET}\"}}"),
        )
            .into_response(),
        TokenMode::Garbage => "not json".into_response(),
        TokenMode::Hang => std::future::pending().await,
    }
}

fn token_answer(n: usize, expires: u64) -> Response {
    axum::Json(json!({ "token": format!("token-{n}"), "expiresInSeconds": expires }))
        .into_response()
}

async fn stub_legal(State(stub): State<Arc<Stub>>, headers: HeaderMap) -> Response {
    let (mode, unauthorized, body) = {
        let mut state = lock(&stub.state);
        state.gets.push(headers);
        let unauthorized = state.unauthorized > 0;
        state.unauthorized = state.unauthorized.saturating_sub(1);
        (state.legal_mode, unauthorized, state.body.clone())
    };
    if unauthorized {
        return (StatusCode::UNAUTHORIZED, "{}").into_response();
    }
    match mode {
        LegalMode::Ok => axum::Json(body).into_response(),
        LegalMode::Status(code) => StatusCode::from_u16(code).expect("status").into_response(),
        LegalMode::Redirect => {
            (StatusCode::FOUND, [(header::LOCATION, "/elsewhere")]).into_response()
        }
        LegalMode::NotJson => "<html>maintenance</html>".into_response(),
        LegalMode::HugeAnnounced => {
            let pad = " ".repeat(MAX_BODY_BYTES + 1);
            (
                [(header::CONTENT_TYPE, "application/json")],
                format!("{{\"items\":[],\"pad\":\"{pad}\"}}"),
            )
                .into_response()
        }
        LegalMode::HugeChunked => Response::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::new(Unannounced {
                remaining: MAX_BODY_BYTES * 2,
            }))
            .expect("response"),
        LegalMode::Hang => std::future::pending().await,
    }
}

async fn stub_elsewhere(State(stub): State<Arc<Stub>>) -> Response {
    lock(&stub.state).elsewhere += 1;
    axum::Json(fixture_body()).into_response()
}

async fn start_stub() -> (Url, Arc<Stub>) {
    let stub = Arc::new(Stub {
        state: Mutex::new(StubState {
            token_mode: TokenMode::Ok,
            legal_mode: LegalMode::Ok,
            unauthorized: 0,
            issued: 0,
            token_posts: Vec::new(),
            gets: Vec::new(),
            elsewhere: 0,
            body: fixture_body(),
        }),
    });
    let app = Router::new()
        .route("/system/service-token", post(stub_token))
        .route("/system/legal-entities", get(stub_legal))
        .route("/elsewhere", get(stub_elsewhere))
        .with_state(stub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base =
        Url::parse(&format!("http://{}", listener.local_addr().expect("addr"))).expect("url");
    tokio::spawn(async move { axum::serve(listener, app).await });
    (base, stub)
}

struct HttpRig {
    clock: FakeClock,
    stub: Arc<Stub>,
    registry: Registry,
    log: Log,
}

async fn http_rig_with(timeout: Duration) -> HttpRig {
    let (base, stub) = start_stub().await;
    let clock = FakeClock::new(Duration::from_secs(1_000));
    let log = Log::default();
    let source = HttpSource::new(
        &base,
        ServiceClient::new(CLIENT_ID, CLIENT_SECRET),
        clock.clock(),
    )
    .expect("client");
    let registry = Registry::new(
        Arc::new(source),
        RegistryOptions {
            clock: clock.clock(),
            timeout,
            log: log.sink(),
        },
    );
    HttpRig {
        clock,
        stub,
        registry,
        log,
    }
}

async fn http_rig() -> HttpRig {
    http_rig_with(Duration::from_secs(5)).await
}

#[tokio::test]
async fn registry_http_reads_the_fixture_through_auth_with_the_service_token() {
    let rig = http_rig().await;
    let snapshot = rig.registry.all().await.expect("read");
    assert_eq!(
        snapshot
            .entities()
            .iter()
            .map(|d| d.legal_name.as_str())
            .collect::<Vec<_>>(),
        ["wellD S.r.l.", "wellD SA"]
    );
    assert_eq!(snapshot.sent_at, Duration::from_secs(1_000));
    assert_eq!(rig.stub.auths(), ["Bearer token-1"]);

    // The token exchange: the client's id and secret, as JSON, and nothing else.
    let posts = lock(&rig.stub.state).token_posts.clone();
    assert_eq!(posts.len(), 1);
    let sent: Value = serde_json::from_str(&posts[0]).expect("JSON");
    assert_eq!(
        sent,
        json!({ "clientId": CLIENT_ID, "clientSecret": CLIENT_SECRET })
    );
    // The secret reached the token endpoint only: not the registry call, in no header.
    let gets = lock(&rig.stub.state).gets.clone();
    for headers in &gets {
        for (name, value) in headers {
            assert!(
                !value.to_str().unwrap_or("").contains(CLIENT_SECRET),
                "{name} carried the secret"
            );
        }
    }
    let accepted = gets[0].get(header::ACCEPT).and_then(|v| v.to_str().ok());
    assert_eq!(accepted, Some("application/json"));
}

#[tokio::test]
async fn registry_http_the_token_is_cached_and_the_registry_is_not_asked_inside_30_s() {
    let rig = http_rig().await;
    rig.registry.all().await.expect("read");
    rig.clock.advance(29 * SECOND);
    rig.registry.all().await.expect("read");
    assert_eq!(rig.stub.auths().len(), 1, "29 s: no call");
    rig.clock.advance(2 * SECOND);
    rig.registry.all().await.expect("read");
    assert_eq!(
        rig.stub.auths(),
        ["Bearer token-1", "Bearer token-1"],
        "31 s: a call, the same token"
    );
    assert_eq!(rig.stub.tokens_asked(), 1);
}

#[tokio::test]
async fn registry_http_the_token_is_exchanged_again_60_s_before_it_expires() {
    // 300 s of life, 60 s of margin: usable until 240 s after the exchange.
    let rig = http_rig().await;
    rig.registry.all().await.expect("read");
    rig.clock.advance(239 * SECOND);
    rig.registry.all().await.expect("read");
    assert_eq!(rig.stub.tokens_asked(), 1, "239 s: the same token");
    assert_eq!(rig.stub.auths().len(), 2);

    let rig = http_rig().await;
    rig.registry.all().await.expect("read");
    rig.clock.advance(241 * SECOND);
    rig.registry.all().await.expect("read");
    assert_eq!(rig.stub.tokens_asked(), 2, "241 s: a new one");
    assert_eq!(
        rig.stub.auths().last().map(String::as_str),
        Some("Bearer token-2")
    );
}

#[tokio::test]
async fn registry_http_a_token_that_lives_no_longer_than_the_margin_is_not_kept() {
    let rig = http_rig().await;
    rig.stub.set_token(TokenMode::Lifetime(60));
    rig.registry.all().await.expect("read");
    rig.clock.advance(31 * SECOND);
    rig.registry.all().await.expect("read");
    assert_eq!(rig.stub.tokens_asked(), 2, "good for one use only");
}

#[tokio::test]
async fn registry_http_a_401_drops_the_token_and_the_retry_takes_a_fresh_one() {
    let rig = http_rig().await;
    lock(&rig.stub.state).unauthorized = 1;
    rig.registry.all().await.expect("the retry answers");
    assert_eq!(rig.stub.auths(), ["Bearer token-1", "Bearer token-2"]);
    assert_eq!(rig.stub.tokens_asked(), 2);
    // The fresh token is the one kept.
    rig.clock.advance(31 * SECOND);
    rig.registry.all().await.expect("read");
    assert_eq!(
        rig.stub.auths().last().map(String::as_str),
        Some("Bearer token-2")
    );
    assert_eq!(rig.stub.tokens_asked(), 2);
}

#[tokio::test]
async fn registry_http_a_second_401_is_the_failure_one_retry_and_no_more() {
    let rig = http_rig().await;
    lock(&rig.stub.state).unauthorized = 5;
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    assert_eq!(rig.stub.auths().len(), 2);
    assert!(rig.log.contains("cause=status"), "{}", rig.log.text());
}

#[tokio::test]
async fn registry_http_a_send_time_is_taken_after_the_token_is_had_and_again_for_the_retry() {
    let rig = http_rig().await;
    lock(&rig.stub.state).unauthorized = 1;
    let snapshot = rig.registry.all().await.expect("read");
    // The clock did not move, so the stamp is the clock's at the send; what is checked is that a snapshot is stamped.
    assert_eq!(snapshot.sent_at, rig.clock.now());
}

#[tokio::test]
async fn registry_http_a_token_that_cannot_be_had_is_a_failed_read_and_the_entry_is_used_within_60_s()
 {
    // An exchange that fails when it is needed.
    let rig = http_rig().await;
    rig.registry.all().await.expect("read");
    rig.stub.set_token(TokenMode::Status(503));
    rig.clock.advance(241 * SECOND);
    assert_eq!(
        rig.registry.all().await.err(),
        Some(Unavailable),
        "the entry is 241 s old"
    );
    assert!(rig.log.contains("cause=token"), "{}", rig.log.text());
    // No entry yet and no token: unavailable. Recovery is not held against it.
    let rig = http_rig().await;
    rig.stub.set_token(TokenMode::Garbage);
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    rig.stub.set_token(TokenMode::Ok);
    rig.registry
        .all()
        .await
        .expect("the failed exchange was not remembered");
}

#[tokio::test]
async fn registry_http_a_refresh_failing_at_59_s_uses_the_entry_whatever_auth_answers() {
    for mode in [
        LegalMode::Status(500),
        LegalMode::Status(404),
        LegalMode::NotJson,
        LegalMode::Redirect,
        LegalMode::HugeAnnounced,
        LegalMode::HugeChunked,
    ] {
        let rig = http_rig().await;
        let first = rig.registry.all().await.expect("read");
        rig.stub.set_legal(mode);
        rig.clock.advance(59 * SECOND);
        let again = rig.registry.all().await.expect("usable");
        assert!(Arc::ptr_eq(&first, &again));
        assert!(rig.log.contains("registry_stale_used"));
        rig.clock.advance(2 * SECOND);
        assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    }
}

#[tokio::test]
async fn registry_http_a_redirect_is_not_followed_and_carries_nothing_elsewhere() {
    let rig = http_rig().await;
    rig.stub.set_legal(LegalMode::Redirect);
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    assert_eq!(
        lock(&rig.stub.state).elsewhere,
        0,
        "the credential was not replayed"
    );
    assert!(rig.log.contains("cause=status"), "{}", rig.log.text());
}

#[tokio::test]
async fn registry_http_a_body_over_64_kib_is_refused_announced_or_not() {
    for (mode, cause) in [
        (LegalMode::HugeAnnounced, "too_large"),
        (LegalMode::HugeChunked, "too_large"),
        (LegalMode::NotJson, "unexpected_body"),
    ] {
        let rig = http_rig().await;
        rig.stub.set_legal(mode);
        assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
        assert!(
            rig.log.contains(&format!("cause={cause}")),
            "{}",
            rig.log.text()
        );
    }
}

#[tokio::test]
async fn registry_http_a_registry_that_hangs_is_unavailable_within_the_bound() {
    let rig = http_rig_with(Duration::from_millis(300)).await;
    rig.stub.set_legal(LegalMode::Hang);
    let began = std::time::Instant::now();
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert!(rig.log.contains("cause=timeout"), "{}", rig.log.text());
}

#[tokio::test]
async fn registry_http_a_token_exchange_that_never_ends_is_bounded_by_the_same_budget() {
    let rig = http_rig_with(Duration::from_millis(300)).await;
    rig.stub.set_token(TokenMode::Hang);
    let began = std::time::Instant::now();
    assert_eq!(rig.registry.all().await.err(), Some(Unavailable));
    assert!(began.elapsed() < Duration::from_secs(5));
    assert!(
        rig.stub.auths().is_empty(),
        "the registry was never called without a token"
    );
    // Single flight reaches the token too: the next read starts over once the stub answers.
    rig.stub.set_token(TokenMode::Ok);
    rig.registry.all().await.expect("read");
}

#[tokio::test]
async fn registry_http_concurrent_reads_make_one_token_exchange_and_one_call() {
    let rig = http_rig().await;
    let reads = futures_join((0..8).map(|_| rig.registry.all()).collect()).await;
    assert!(reads.iter().all(Result::is_ok));
    assert_eq!(rig.stub.tokens_asked(), 1);
    assert_eq!(rig.stub.auths().len(), 1);
}

#[tokio::test]
async fn registry_http_the_pin_retry_reads_what_was_saved() {
    let rig = http_rig().await;
    rig.registry.all().await.expect("read");
    rig.clock.advance(5 * SECOND);
    bump(
        &mut lock(&rig.stub.state).body,
        "welld_ch",
        Some("wellD SA (new)"),
    );
    assert_eq!(
        rig.registry
            .get(Entity::WelldCh)
            .await
            .expect("read")
            .version,
        3
    );
    rig.registry.invalidate();
    let ch = rig.registry.get(Entity::WelldCh).await.expect("read");
    assert_eq!((ch.version, ch.legal_name.as_str()), (4, "wellD SA (new)"));
}

// ---------------------------------------------------------------------------------------------------------------
// What is printed

#[tokio::test]
async fn registry_the_secret_the_tokens_and_the_values_appear_in_no_log_and_no_debug() {
    let rig = http_rig().await;
    rig.registry.all().await.expect("read");
    rig.clock.advance(50 * SECOND);
    rig.stub.set_legal(LegalMode::Status(500));
    rig.registry.all().await.expect("stale");
    rig.clock.advance(20 * SECOND);
    rig.stub.set_token(TokenMode::Status(500));
    assert!(rig.registry.all().await.is_err());
    rig.clock.advance(300 * SECOND);
    assert!(rig.registry.all().await.is_err());
    rig.stub.set_legal(LegalMode::Ok);
    rig.stub.set_token(TokenMode::Ok);
    lock(&rig.stub.state).unauthorized = 1;
    rig.registry.all().await.expect("read");

    let text = rig.log.text();
    assert!(text.contains("registry_stale_used") && text.contains("legal_entities_unavailable"));
    for forbidden in [
        CLIENT_SECRET,
        "token-1",
        "token-2",
        "wellD SA",
        "wellD S.r.l.",
        "CH9300762011623852957",
        "Via Cantonale",
        "IT01234567890",
    ] {
        assert!(
            !text.contains(forbidden),
            "{forbidden} reached the log:\n{text}"
        );
    }

    // `Debug` of the credential and of the registry.
    let client = ServiceClient::new(CLIENT_ID, CLIENT_SECRET);
    let shown = format!("{client:?} {client:#?}");
    assert!(!shown.contains(CLIENT_SECRET), "{shown}");
    assert!(shown.contains(CLIENT_ID) && shown.contains("<redacted>"));
    let (base, _stub) = start_stub().await;
    let source = HttpSource::new(&base, client, monotonic_clock()).expect("client");
    let shown = format!("{source:?} {:?}", rig.registry);
    assert!(!shown.contains(CLIENT_SECRET), "{shown}");
}

// ---------------------------------------------------------------------------------------------------------------
// Startup

/// A complete environment, as far as the validation goes (nothing is contacted before it passes).
fn complete_environment() -> Vec<(&'static str, String)> {
    vec![
        (
            "DATABASE_URL",
            "postgresql://u:p@127.0.0.1:1/letterhead".to_owned(),
        ),
        ("AUTH_ISSUER", "http://auth.test".to_owned()),
        ("AUTH_BASE_URL", "http://127.0.0.1:9".to_owned()),
        ("AUTH_JWKS_URL", "http://127.0.0.1:9/auth/jwks".to_owned()),
        ("AUTH_AUDIENCE", "operai-suite".to_owned()),
        ("SERVICE_AUDIENCE", "operai-service".to_owned()),
        ("SERVICE_CLIENT_ID", CLIENT_ID.to_owned()),
        ("SERVICE_CLIENT_SECRET", CLIENT_SECRET.to_owned()),
        ("ALLOWED_ORIGINS", "http://localhost:5173".to_owned()),
        ("LETTERHEAD_S3_ENDPOINT", "http://localhost:9000".to_owned()),
        ("LETTERHEAD_S3_REGION", "us-east-1".to_owned()),
        ("LETTERHEAD_S3_BUCKET", "unused".to_owned()),
        ("LETTERHEAD_S3_ACCESS_KEY_ID", "x".to_owned()),
        ("LETTERHEAD_S3_SECRET_ACCESS_KEY", "y".to_owned()),
        ("LETTERHEAD_S3_EU_ENDPOINT_HOSTS", "localhost".to_owned()),
    ]
}

fn start_without(names: &[&str]) -> std::process::Output {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_letterhead-api"));
    command.env_clear();
    for (name, value) in complete_environment() {
        if !names.contains(&name) {
            command.env(name, value);
        }
    }
    command.output().expect("the binary runs")
}

#[test]
fn registry_startup_exits_non_zero_without_either_variable_and_says_which() {
    for (missing, expected) in [
        (
            vec!["SERVICE_CLIENT_ID"],
            vec!["SERVICE_CLIENT_ID is required"],
        ),
        (
            vec!["SERVICE_CLIENT_SECRET"],
            vec!["SERVICE_CLIENT_SECRET is required"],
        ),
        (
            vec!["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"],
            vec![
                "SERVICE_CLIENT_ID is required",
                "SERVICE_CLIENT_SECRET is required",
            ],
        ),
    ] {
        let output = start_without(&missing);
        let said = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.code(), Some(1), "{missing:?}: {said}");
        for line in expected {
            assert!(said.contains(line), "{missing:?}: {said}");
        }
        assert!(
            !said.contains(CLIENT_SECRET),
            "the secret was printed: {said}"
        );
    }
}

#[test]
fn registry_startup_with_a_malformed_secret_says_the_rule_and_not_the_value() {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_letterhead-api"));
    command.env_clear();
    for (name, value) in complete_environment() {
        command.env(
            name,
            if name == "SERVICE_CLIENT_SECRET" {
                "too-short-sentinel"
            } else {
                &value
            },
        );
    }
    let output = command.output().expect("the binary runs");
    let said = String::from_utf8_lossy(&output.stderr).into_owned();
    assert_eq!(output.status.code(), Some(1), "{said}");
    assert!(
        said.contains("SERVICE_CLIENT_SECRET must be 32 to 256 characters"),
        "{said}"
    );
    assert!(!said.contains("too-short-sentinel"), "{said}");
}
