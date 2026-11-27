/**
 * In-process sliding-window rate limiter and the team windows of projects-api (specs/20261126-teams T11, D13, D15).
 *
 * The limiter is copied from `auth/src/lib/rateLimiter.ts` (no shared package exists; the suite copies it, as
 * estimai-api does) with three additions:
 *   - `peek(key)`: what `consume` would answer, recording nothing. `admitTeamRead` needs it to look at two windows
 *     and spend neither unless both have room;
 *   - `reset()`: forgets every key (tests: `resetWorld()`);
 *   - `clock`: the time used when a call passes none, so a test can move every window at once.
 *
 * Semantics that D15 relies on, unchanged from auth: only an ADMITTED attempt is recorded, so a refused attempt never
 * delays the caller's recovery, and trying again never extends a wait. Counters are per process, like every limiter in
 * the suite: projects-api runs one replica (R12); `scripts/check-single-replica.ts` refuses another figure in
 * `.railway/railway.ts`.
 *
 * Three module-scope windows, 10 minutes each:
 *   - `attachableTeamsLimiter`: `GET /attachable-teams`, 120 per caller (D13). Its own budget, never the page reads'.
 *   - `teamReadPersonLimiter` + `teamReadServiceLimiter`: the project page's fresh team read, 120 per verified `sub`
 *     and 2 400 for the whole service (D15). `admitTeamRead(sub)` consults both. The activity-host and meeting-host
 *     resolves, and `GET /attached-teams`, use the cached read and never come here (AC-5.6).
 */

export interface RateLimitResult {
  /** Whether this attempt is admitted under the configured window. */
  allowed: boolean;
  /**
   * Milliseconds until the key's oldest counted attempt ages out of the window, i.e. the earliest time another
   * attempt could be admitted. Always 0 when `allowed` is true.
   */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Records one attempt for `key` when the window has room (and says so), else records nothing. */
  consume(key: string, now?: number): RateLimitResult;
  /** The answer `consume` would give for `key` right now, recording nothing. */
  peek(key: string, now?: number): RateLimitResult;
  /** Forgets every key. */
  reset(): void;
}

export interface RateLimiterOptions {
  /** Maximum admitted attempts per key within `windowMs`. */
  limit: number;
  /** Sliding window size, in milliseconds. */
  windowMs: number;
  /** How often to sweep the whole map for keys with nothing left inside the window. Defaults to `windowMs`. */
  pruneIntervalMs?: number;
  /**
   * Upper bound on distinct keys held (default: unbounded). At the cap a NEW key is counted under one shared overflow
   * key instead of getting its own entry; keys already present keep their own counts.
   */
  maxKeys?: number;
  /** The time used when `consume`/`peek` is called without one (default `Date.now`). */
  clock?: () => number;
}

/** Counted in place of any new key past `maxKeys`. Not a value a caller can choose (NUL-prefixed). */
const OVERFLOW_KEY = "\u0000overflow";

/** Creates an in-process sliding-window `RateLimiter`. Two calls make two INDEPENDENT limiters (own `Map`). */
export function createSlidingWindowRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs, maxKeys } = options;
  const clock = options.clock ?? Date.now;
  const pruneIntervalMs = options.pruneIntervalMs ?? windowMs;
  // At the cap a prune is attempted per new key, so throttle it: a flood of distinct keys must not turn every request
  // into a full sweep.
  const capPruneMinMs = Math.min(1000, pruneIntervalMs);

  const hits = new Map<string, number[]>();
  // Set by the first consume, so an injected clock (tests) and the real one both measure from their own start.
  let lastPruneAt: number | undefined;

  const freshTimestamps = (timestamps: number[], now: number): number[] => timestamps.filter((t) => now - t < windowMs);

  function pruneAll(now: number): void {
    for (const [key, timestamps] of hits) {
      const fresh = freshTimestamps(timestamps, now);
      if (fresh.length === 0) hits.delete(key);
      else if (fresh.length !== timestamps.length) hits.set(key, fresh);
    }
    lastPruneAt = now;
  }

  const answer = (existing: number[], now: number): RateLimitResult =>
    existing.length >= limit
      ? { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - existing[0]!)) }
      : { allowed: true, retryAfterMs: 0 };

  return {
    consume(key, now = clock()) {
      lastPruneAt ??= now;
      if (now - lastPruneAt >= pruneIntervalMs) pruneAll(now);

      if (maxKeys !== undefined && !hits.has(key) && hits.size >= maxKeys) {
        if (now - lastPruneAt >= capPruneMinMs) pruneAll(now);
        if (!hits.has(key) && hits.size >= maxKeys) key = OVERFLOW_KEY;
      }

      const existing = freshTimestamps(hits.get(key) ?? [], now);
      const result = answer(existing, now);
      // Reject without recording: a refused attempt must not further delay the caller's recovery.
      if (result.allowed) existing.push(now);
      hits.set(key, existing);
      return result;
    },

    peek(key, now = clock()) {
      // Mirrors `consume`'s key choice (a new key at the cap reads the overflow key) but changes nothing, not even a prune.
      if (maxKeys !== undefined && !hits.has(key) && hits.size >= maxKeys) key = OVERFLOW_KEY;
      return answer(freshTimestamps(hits.get(key) ?? [], now), now);
    },

    reset() {
      hits.clear();
      lastPruneAt = undefined;
    },
  };
}

// ─── The team windows (D13, D15) ──────────────────────────────────────────────────────────────────────────────────

/** The one window length of the three limits below, 10 minutes, auth's. */
export const TEAM_READ_WINDOW_MS = 600_000;
/** `GET /attachable-teams`: requests per caller per window (D13). */
export const ATTACHABLE_TEAMS_CALLER_LIMIT = 120;
/** The project page's fresh team read: admitted reads per verified `sub` per window (D15). */
export const TEAM_READ_PERSON_LIMIT = 120;
/** The same read, all people together: leaves 600 of auth's 3 000 for the cached path (D15). */
export const TEAM_READ_SERVICE_LIMIT = 2400;

/** Added to the clock of every team window, by tests only (`advanceTeamLimitersForTests`). */
let testOffsetMs = 0;
const teamClock = (): number => Date.now() + testOffsetMs;

export const attachableTeamsLimiter: RateLimiter = createSlidingWindowRateLimiter({
  limit: ATTACHABLE_TEAMS_CALLER_LIMIT,
  windowMs: TEAM_READ_WINDOW_MS,
  clock: teamClock,
});
export const teamReadPersonLimiter: RateLimiter = createSlidingWindowRateLimiter({
  limit: TEAM_READ_PERSON_LIMIT,
  windowMs: TEAM_READ_WINDOW_MS,
  clock: teamClock,
});
export const teamReadServiceLimiter: RateLimiter = createSlidingWindowRateLimiter({
  limit: TEAM_READ_SERVICE_LIMIT,
  windowMs: TEAM_READ_WINDOW_MS,
  clock: teamClock,
});

/** The service window has one key. */
const SERVICE_KEY = "service";

export type TeamReadAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      /** Whose window refused: the person's own (`"person"`) or the service's (`"service"`). */
      readonly window: "person" | "service";
      /** Whole seconds until the person's oldest admitted read leaves the window, 1..600; `null` for the service's. */
      readonly retryAfterSeconds: number | null;
    };

/** Last time a refusal of `<window>:<sub>` was logged: one line per person and window per 10 minutes. */
const loggedAt = new Map<string, number>();

function logFirstRefusal(sub: string, window: "person" | "service", now: number): void {
  const key = `${window}:${sub}`;
  const last = loggedAt.get(key);
  if (last !== undefined && now - last < TEAM_READ_WINDOW_MS) return;
  for (const [k, at] of loggedAt) if (now - at >= TEAM_READ_WINDOW_MS) loggedAt.delete(k);
  loggedAt.set(key, now);
  // The actor id only: no project, team or name (D15).
  console.warn(`[teams] page-read limited actor=${sub} window=${window}`);
}

/**
 * Whether the project page may make a fresh team read for `sub` (D15). Both windows are looked at first and BOTH are
 * spent only when both have room, with no `await` in between, so the check is atomic in the one event loop. A refused
 * read records nothing, in either window. When both would refuse, the person's is the answer: it is the one they can
 * act on; a service refusal alone says nothing about a limit of theirs.
 */
export function admitTeamRead(sub: string, now: number = teamClock()): TeamReadAdmission {
  const person = teamReadPersonLimiter.peek(sub, now);
  if (!person.allowed) {
    logFirstRefusal(sub, "person", now);
    return {
      admitted: false,
      window: "person",
      retryAfterSeconds: Math.min(600, Math.max(1, Math.ceil(person.retryAfterMs / 1000))),
    };
  }
  if (!teamReadServiceLimiter.peek(SERVICE_KEY, now).allowed) {
    logFirstRefusal(sub, "service", now);
    return { admitted: false, window: "service", retryAfterSeconds: null };
  }
  teamReadPersonLimiter.consume(sub, now);
  teamReadServiceLimiter.consume(SERVICE_KEY, now);
  return { admitted: true };
}

/** Tests: forgets every team window (the attach search's and both page-read windows), the log memory and the clock offset. */
export function resetTeamLimiters(): void {
  attachableTeamsLimiter.reset();
  teamReadPersonLimiter.reset();
  teamReadServiceLimiter.reset();
  loggedAt.clear();
  testOffsetMs = 0;
}

/** Tests: moves the clock of every team window forward, as time passing would. */
export function advanceTeamLimitersForTests(ms: number): void {
  testOffsetMs += ms;
}
