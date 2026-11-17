//! The consumer cache rule (plan decision 7; see the module above): one entry, stamped with the time its request was
//! SENT, fresh for 30 s, usable for 60 s when a refresh fails, then nothing. The twin of `createLegalEntityRegistry`
//! in `crm-api/src/lib/legalEntities.ts`.
//!
//! The rule knows nothing of HTTP: a [`Source`] makes one read and says when its request went out, and a [`Clock`]
//! (monotonic, injected) gives the ages. So the same code is tested with a fake source and a fake clock at the
//! boundaries (29 / 31 / 59 / 61 s) and over random schedules, and runs for real with [`super::http::HttpSource`].
//!
//! Single flight: the refresh runs as a task of its own, and every caller that needs it waits for that one result,
//! failure included. A caller that goes away (a client that hung up) does not stop it, and does not leave the others
//! waiting for a flight nobody drives. The task is bounded by the 5 s of the rule, and a task that panics clears its
//! flight (so the next caller starts a new one) and fails the callers that waited for it.
//!
//! `invalidate()` forgets the entry (the pin retry of decision 8): the next read goes to `auth`, and a refresh that
//! was already in flight, sent before the invalidation, is neither joined nor cached (its own callers still get its
//! answer; it is not newer than the one they asked for).
//!
//! `refresh_for_pin()` is the pin retry as the routes ask for it, and it is coalesced (security review F6): a
//! caller that names a version other than the one held could otherwise make every request a call to `auth`. A forced
//! refresh happens at most once per [`FORCED_REFRESH_EVERY`] per process, and not at all when the entry was sent
//! less than that ago (it is as new as a forced refresh would make it); the others re-read what is held and answer
//! with it.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use letterhead_engine::content::Entity;
use tokio::sync::watch;

use super::{FRESH_FOR, LegalEntityDetails, REFRESH_TIMEOUT, USABLE_FOR};

/// The pin retry reads `auth` at most once in this time, per process (security review F6).
pub const FORCED_REFRESH_EVERY: Duration = Duration::from_secs(1);

/// A monotonic clock: the time since some fixed origin. Ages and send times are differences of it. Never the wall
/// clock, which can be set back.
pub type Clock = Arc<dyn Fn() -> Duration + Send + Sync>;

/// The clock of the running service: `Instant`, from the moment this is called.
pub fn monotonic_clock() -> Clock {
    let origin = Instant::now();
    Arc::new(move || origin.elapsed())
}

/// Why a read of the registry did not produce an answer: a closed list, so that a log line can name it and no
/// value, token or message of the other side can ride along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The refresh ran past its bound (the token, the call and the retry together).
    Timeout,
    /// No service token could be had (the exchange failed, was refused or answered something else).
    Token,
    /// `auth` could not be reached, or the connection broke.
    Network,
    /// Any answer that is not 2xx (a 3xx is not followed), the 401 that came twice included.
    Status(u16),
    /// The body is over 64 KiB.
    TooLarge,
    /// The body is not the contract's.
    Unexpected,
    /// The refresh ended without an answer (its task was lost).
    Aborted,
}

impl Failure {
    pub fn cause(self) -> &'static str {
        match self {
            Failure::Timeout => "timeout",
            Failure::Token => "token",
            Failure::Network => "network",
            Failure::Status(_) => "status",
            Failure::TooLarge => "too_large",
            Failure::Unexpected => "unexpected_body",
            Failure::Aborted => "aborted",
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::Status(code) => write!(f, "status {code}"),
            other => f.write_str(other.cause()),
        }
    }
}

/// The registry cannot be read within the bounds of the rule: the routes answer 503 `legal_entities_unavailable`
/// with `Retry-After: 5`, and no document is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unavailable;

impl fmt::Display for Unavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(super::LEGAL_ENTITIES_UNAVAILABLE)
    }
}

impl std::error::Error for Unavailable {}

/// Both entities of ONE answer, and when its request was sent (on the registry's clock).
#[derive(Debug)]
pub struct Snapshot {
    /// In [`Entity::ALL`] order.
    entities: Vec<Arc<LegalEntityDetails>>,
    pub sent_at: Duration,
}

impl Snapshot {
    pub fn new(entities: Vec<Arc<LegalEntityDetails>>, sent_at: Duration) -> Snapshot {
        Snapshot { entities, sent_at }
    }

    #[allow(
        dead_code,
        reason = "read by tests/registry.rs, which compiles this file on its own; the routes ask for one entity"
    )]
    pub fn entities(&self) -> &[Arc<LegalEntityDetails>] {
        &self.entities
    }

    /// One entity's details. Every snapshot holds all of the group's entities (a source that cannot say that does
    /// not produce one), so this finds it.
    pub fn get(&self, entity: Entity) -> Option<&Arc<LegalEntityDetails>> {
        self.entities.iter().find(|d| d.entity == entity)
    }
}

/// What a read brings: the entities and the instant its request was SENT (taken after the token was had, as the
/// call goes out: `auth` reads the table after this instant, which is the proof of AC-3.3).
pub struct Fetched {
    pub entities: Vec<Arc<LegalEntityDetails>>,
    pub sent_at: Duration,
}

pub type FetchFuture<'a> = Pin<Box<dyn Future<Output = Result<Fetched, Failure>> + Send + 'a>>;

/// One read of the registry. [`Registry`] drives it under the rule; it does not time, retry or cache.
pub trait Source: Send + Sync {
    fn fetch(&self) -> FetchFuture<'_>;
}

type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// How a [`Registry`] is built. The defaults are the rule's: the monotonic clock, the 5 s bound, a line on stdout.
pub struct RegistryOptions {
    pub clock: Clock,
    pub timeout: Duration,
    /// One line, no newline. Closed words and numbers only.
    pub log: LogSink,
}

impl Default for RegistryOptions {
    fn default() -> Self {
        RegistryOptions {
            clock: monotonic_clock(),
            timeout: REFRESH_TIMEOUT,
            log: Arc::new(|line| println!("{line}")),
        }
    }
}

type FlightResult = Result<Arc<Snapshot>, Failure>;

struct Flight {
    id: u64,
    result: watch::Receiver<Option<FlightResult>>,
}

#[derive(Default)]
struct State {
    entry: Option<Arc<Snapshot>>,
    flight: Option<Flight>,
    next_flight: u64,
    /// Bumped by `invalidate()`: a refresh begun in an earlier epoch is not cached.
    epoch: u64,
    /// When the last forced refresh (`refresh_for_pin`) was started, on the registry's clock.
    last_forced: Option<Duration>,
}

struct Inner {
    source: Arc<dyn Source>,
    clock: Clock,
    timeout: Duration,
    log: LogSink,
    state: Mutex<State>,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Clears the flight when its task ends, however it ends (a panic included).
struct ClearsFlight {
    inner: Arc<Inner>,
    id: u64,
}

impl Drop for ClearsFlight {
    fn drop(&mut self) {
        let mut state = self.inner.state();
        if state.flight.as_ref().is_some_and(|f| f.id == self.id) {
            state.flight = None;
        }
    }
}

/// The registry as the routes use it. Cheap to clone: the clones share the one entry.
#[derive(Clone)]
pub struct Registry {
    inner: Arc<Inner>,
}

impl fmt::Debug for Registry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Registry")
    }
}

impl Registry {
    pub fn new(source: Arc<dyn Source>, options: RegistryOptions) -> Registry {
        Registry {
            inner: Arc::new(Inner {
                source,
                clock: options.clock,
                timeout: options.timeout,
                log: options.log,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Both entities, under the cache rule. [`Unavailable`] when the entry is older than 60 s (or there is none) and
    /// `auth` cannot be read.
    pub async fn all(&self) -> Result<Arc<Snapshot>, Unavailable> {
        let inner = &self.inner;
        let (held, held_epoch, mut flight) = {
            let mut state = inner.state();
            let held = state.entry.clone();
            if let Some(entry) = &held
                && self.age(entry) < FRESH_FOR
            {
                return Ok(entry.clone());
            }
            let flight = match &state.flight {
                Some(flight) => flight.result.clone(),
                None => self.start_flight(&mut state),
            };
            (held, state.epoch, flight)
        };

        let failure = match flight.wait_for(Option::is_some).await {
            Ok(done) => match done.clone() {
                Some(Ok(snapshot)) => return Ok(snapshot),
                Some(Err(failure)) => failure,
                None => Failure::Aborted,
            },
            Err(_) => Failure::Aborted,
        };

        // The held entry is used when it is usable, was not invalidated while the refresh ran (the caller asked
        // for a newer one), and the refresh did not bring one.
        let current_epoch = inner.state().epoch;
        if let Some(entry) = held
            && current_epoch == held_epoch
        {
            let age = self.age(&entry);
            if age <= USABLE_FOR {
                (inner.log)(&format!(
                    "registry event=registry_stale_used age_ms={} cause={failure}",
                    age.as_millis()
                ));
                return Ok(entry);
            }
        }
        (inner.log)(&format!(
            "registry event=legal_entities_unavailable cause={failure}"
        ));
        Err(Unavailable)
    }

    /// One entity's details (the same read, the same rule).
    pub async fn get(&self, entity: Entity) -> Result<Arc<LegalEntityDetails>, Unavailable> {
        let snapshot = self.all().await?;
        // A snapshot always holds the whole group; a source that broke that is a failed read.
        snapshot.get(entity).cloned().ok_or(Unavailable)
    }

    /// Forget the entry: the next read asks `auth` (the pin retry of decision 8). A refresh already in flight is
    /// neither joined by later reads nor cached.
    #[allow(
        dead_code,
        reason = "the routes use refresh_for_pin(); tests/registry.rs compiles this file on its own and uses this"
    )]
    pub fn invalidate(&self) {
        let mut state = self.inner.state();
        state.entry = None;
        state.flight = None;
        state.epoch += 1;
    }

    /// The pin retry, coalesced: forgets the entry (as [`Registry::invalidate`]) so that the next read asks `auth`,
    /// unless a forced refresh was started less than [`FORCED_REFRESH_EVERY`] ago or the entry was sent less than
    /// that ago. Returns whether it did. When it did not, the caller's next read is the held entry (no call) or the
    /// refresh in flight (joined), and a pin that still differs is the caller's 409 at once.
    pub fn refresh_for_pin(&self) -> bool {
        let mut state = self.inner.state();
        let now = (self.inner.clock)();
        let recent = |at: Duration| now.saturating_sub(at) < FORCED_REFRESH_EVERY;
        if state.last_forced.is_some_and(recent)
            || state
                .entry
                .as_ref()
                .is_some_and(|entry| recent(entry.sent_at))
        {
            return false;
        }
        state.last_forced = Some(now);
        state.entry = None;
        state.flight = None;
        state.epoch += 1;
        true
    }

    fn age(&self, entry: &Snapshot) -> Duration {
        (self.inner.clock)().saturating_sub(entry.sent_at)
    }

    /// Starts the one refresh, as a task. Called with the state locked and no flight in it.
    fn start_flight(&self, state: &mut State) -> watch::Receiver<Option<FlightResult>> {
        let (sender, receiver) = watch::channel(None);
        let id = state.next_flight;
        state.next_flight += 1;
        let started_in = state.epoch;
        state.flight = Some(Flight {
            id,
            result: receiver.clone(),
        });

        let inner = self.inner.clone();
        tokio::spawn(async move {
            let clears = ClearsFlight {
                inner: inner.clone(),
                id,
            };
            let read = match tokio::time::timeout(inner.timeout, inner.source.fetch()).await {
                Ok(read) => read,
                Err(_) => Err(Failure::Timeout),
            };
            let result = read.and_then(|fetched| {
                // A snapshot holds the whole group, in order: the rule's callers rely on it.
                let whole = Entity::ALL.iter().all(|entity| {
                    fetched
                        .entities
                        .iter()
                        .filter(|d| d.entity == *entity)
                        .count()
                        == 1
                });
                if whole && fetched.entities.len() == Entity::ALL.len() {
                    Ok(Arc::new(Snapshot::new(fetched.entities, fetched.sent_at)))
                } else {
                    Err(Failure::Unexpected)
                }
            });
            if let Ok(snapshot) = &result {
                let mut state = inner.state();
                if state.epoch == started_in {
                    state.entry = Some(snapshot.clone());
                }
            }
            // Before the result is announced, so that a caller who wakes finds the flight gone and the entry in.
            drop(clears);
            let _ = sender.send(Some(result));
        });
        receiver
    }
}
