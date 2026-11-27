/**
 * projects-api's client of auth's team read, `GET /system/teams` (specs/20261126-teams T11; decisions D1, D2, D13;
 * AC-4.4 to AC-4.7, AC-5.4).
 *
 * A team's name, archived state and members live in auth (AC-1.3, O6); projects-api keeps only which team ids are
 * attached. It reads them as ITSELF, never as the caller: a 5-minute service JWT with scope `teams:read`
 * (`serviceToken.ts`), because the readers that matter (hours, task assignment, meetings) are ordinary users whose own
 * per-caller budgets at auth could not carry a read of every team (D1). The app whose access is reported (`appAccess`)
 * is derived by auth from the verified `sub`, never sent from here.
 *
 * THE CACHE RULE (D2), crm-api's `legalEntities.ts` rule, per team:
 *   - an entry is stamped with the monotonic time its request was SENT, not when the answer came back;
 *   - younger than 30 s: used, no call;
 *   - otherwise refreshed: single flight per id, 5 s in all, no redirects, a body of at most 1 MiB, ids in chunks of
 *     50. A refresh also carries every other entry older than 15 s (but still usable), so entries expire together and
 *     the steady state is about one call every 30 s;
 *   - the refresh fails and the entry is at most 60 s old: the entry is used and `teams_stale_used` is logged;
 *   - the refresh fails and the entry is older, or there is none: the team is UNAVAILABLE. Never "nobody" and never
 *     "the members known without it" (D3);
 *   - a 401 drops the cached service token and retries once.
 * The proof of AC-4.6: a decision at t uses an entry sent at s >= t - 60 s; auth reads its tables after it receives the
 * request, so a membership change committed before t - 60 s is in that answer.
 *
 * THREE READS, by path (a read degrades, a write that must confirm refuses; ADR 20261103-...):
 *   - `cached(ids)`: the rule above. The activity-host and meeting-host resolves and `GET /attached-teams`.
 *   - `fresh(ids, { fallback })`: always asks, never joins a flight sent earlier (a rename must show on the NEXT load,
 *     AC-1.3), and refreshes the cache with the answer. The project view passes `fallback: true` (a failed read uses an
 *     entry of at most 60 s); `PUT /projects/{id}/teams` passes `false` (it confirms what it adds and never trusts a
 *     copy). The caller admits it through `admitTeamRead` (`rateLimiter.ts`, D15): this module does not limit.
 *   - `options(q)`: the attach picker's search, always asked, never cached; it fails with the 503 `teams_unavailable`.
 *
 * Nothing here logs a token, a team name, a member, a query text or a body: statuses and error kinds only.
 *
 * `teamReader` (bottom) is the one wired from the environment; tests build their own with a stubbed `fetch` and clock.
 */

import { z } from "zod";
import { env } from "./env";
import { ProblemError } from "./problem";
import { serviceTokens, type ServiceTokenProvider } from "./serviceToken";

/** An entry younger than this is used without a call. */
export const TEAMS_FRESH_MS = 30_000;
/** The oldest entry that may be used when a refresh fails. */
export const TEAMS_USABLE_MS = 60_000;
/** A refresh carries every other entry older than this (and not yet past `TEAMS_USABLE_MS`). */
export const TEAMS_PIGGYBACK_MS = 15_000;
/** The whole refresh: the token, the call and the one retry. */
export const TEAMS_TIMEOUT_MS = 5_000;
/**
 * The longest one `cached()` call waits, in all, for the refreshes it needs (D16). Counted once from the start of the
 * call, not per chunk. Past it the call counts the refresh as failed (`wait_exceeded`); the refresh itself is NOT
 * aborted: it keeps its `TEAMS_TIMEOUT_MS` and its answer fills the cache.
 */
export const TEAMS_HOST_WAIT_MS = 800;
/**
 * What a host resolve keeps under its callers' deadline (activities-api, meetings-api and hours-api: 2 s) for everything
 * but the team read: JWT, permission check (cached 30 s, or at most `HOST_AUTHZ_WAIT_MS` when not), project query,
 * building the answer, two hops, event-loop delay (D16). Itemized since R13 a: `HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS`
 * (`hostBudget.ts`) fit in it.
 * `TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS` must stay under each of those deadlines: `teams.budgets.cross-package.test.ts`.
 */
export const TEAMS_HOST_MARGIN_MS = 1_000;
/** auth's cap on `ids`. */
export const TEAMS_MAX_IDS_PER_REQUEST = 50;
/** The largest answer that is read. */
export const TEAMS_MAX_BODY_BYTES = 1024 * 1024;
/** auth's cap on an options answer (`OPTIONS_LIMIT`). */
const OPTIONS_LIMIT = 50;
/** An entry nobody asked for in this long is forgotten (memory only: it is never USED past `TEAMS_USABLE_MS`). */
const RETAIN_MS = 10 * 60_000;
/** What an auth team id looks like (the ids mode's own pattern); anything else would fail a whole chunk. */
const TEAM_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ─── The answer (plan § API contracts, `GET /system/teams`) ──────────────────────────────────────────────────────────

export interface TeamMemberFact {
  readonly id: string;
  /** `null` for a deactivated member (auth never reveals it). */
  readonly name: string | null;
  readonly active: boolean;
  /** Holds `(projects, access)`; false for a deactivated member. */
  readonly appAccess: boolean;
}

/** One team as auth reports it: its name, whether it is archived, and its members (name order, deactivated last). */
export interface TeamFact {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly members: readonly TeamMemberFact[];
}

const MemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  active: z.boolean(),
  appAccess: z.boolean(),
});
const TeamSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  archived: z.boolean(),
  members: z.array(MemberSchema),
});
const IdsAnswer = z.object({ items: z.array(TeamSchema) });
const OptionsAnswer = z.object({
  items: z.array(z.object({ id: z.string().min(1), name: z.string() })).max(OPTIONS_LIMIT),
  truncated: z.boolean(),
});

/** The teams of an ids answer by id, or `null` when it is not the contract's: an item nobody asked for, or one twice. */
function parseTeams(body: unknown, requested: readonly string[]): Map<string, TeamFact> | null {
  const parsed = IdsAnswer.safeParse(body);
  if (!parsed.success) return null;
  const asked = new Set(requested);
  const found = new Map<string, TeamFact>();
  for (const item of parsed.data.items) {
    if (!asked.has(item.id) || found.has(item.id)) return null;
    found.set(item.id, item);
  }
  return found;
}

/** The attach picker's answer: active teams by name, at most 50, `truncated` when a 51st matched. */
export interface TeamOptions {
  readonly items: readonly { readonly id: string; readonly name: string }[];
  readonly truncated: boolean;
}

/** What is still known of a team whose members could not be read (an entry that is held, however old), or `null`. */
export interface TeamLabel {
  readonly name: string;
  readonly archived: boolean;
}

/**
 * What a read of some ids found. An id is in `teams` (its facts, fresh or from an entry within the rule), in
 * `unavailable` (it could not be read and there is no entry the rule allows; the value is what an old entry still says
 * of its name, else `null`), or in neither: auth does not know it. An id shaped unlike an auth id is never sent and is
 * in neither either.
 */
export interface TeamsRead {
  readonly teams: Map<string, TeamFact>;
  readonly unavailable: Map<string, TeamLabel | null>;
}

/** The facts `onProject` reads: all of `ids` as a map, or `"unavailable"` when any of them is not known. */
export function factsOrUnavailable(read: TeamsRead, ids: readonly string[]): Map<string, TeamFact> | "unavailable" {
  return ids.every((id) => read.teams.has(id)) ? read.teams : "unavailable";
}

/** The 503 a route answers when a team read it cannot do without fails. */
export const teamsUnavailable = (): ProblemError =>
  new ProblemError({
    status: 503,
    code: "teams_unavailable",
    detail: "Teams are unavailable; try again shortly",
  });

// ─── The client ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TeamReader {
  /** The cache rule (D2): the decisions' path and `GET /attached-teams`. */
  cached(ids: readonly string[]): Promise<TeamsRead>;
  /** Always asks (D2); with `fallback`, a failed read uses an entry of at most 60 s. Does not limit: see `admitTeamRead`. */
  fresh(ids: readonly string[], options: { readonly fallback: boolean }): Promise<TeamsRead>;
  /** The attach picker's search over active teams (D13), always asked. Rejects with the 503 `teams_unavailable`. */
  options(q?: string): Promise<TeamOptions>;
  /** Tests: forgets every entry and flight. */
  reset(): void;
}

export interface TeamReaderOptions {
  readonly baseUrl: string;
  /** `null`: no service client, every read fails closed. */
  readonly tokens: ServiceTokenProvider | null;
  /** Looked up per call (default: the global `fetch`) so a spied global is honoured. */
  readonly fetchImpl?: typeof fetch;
  /** A MONOTONIC clock in ms (default `performance.now`): ages and send times are differences of it. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** How long `cached()` waits for its refreshes (default `TEAMS_HOST_WAIT_MS`); tests size it down. */
  readonly hostWaitMs?: number;
}

/** A read that did not produce an answer. The message names a status or an error kind, never a value. */
class ReadError extends Error {}

type ChunkOutcome =
  | { readonly ok: true; readonly facts: Map<string, TeamFact> }
  | { readonly ok: false; readonly reason: string };

interface Entry {
  readonly fact: TeamFact;
  /** The monotonic time the request that produced it was sent. */
  readonly sentAt: number;
}

export function createTeamReader(options: TeamReaderOptions): TeamReader {
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? TEAMS_TIMEOUT_MS;
  const hostWaitMs = options.hostWaitMs ?? TEAMS_HOST_WAIT_MS;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const tokens = options.tokens;

  const entries = new Map<string, Entry>();
  /** One in-flight chunk per id the chunk carries (single flight). */
  const flights = new Map<string, Promise<ChunkOutcome>>();

  /** `promise`, or a failure when `signal` aborts first. */
  function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new ReadError("timeout"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /** The body as text, refusing more than the limit (by the announced length first, then by what is actually read). */
  async function readBody(res: Response): Promise<string> {
    const announced = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(announced) && announced > TEAMS_MAX_BODY_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new ReadError("body too large");
    }
    if (res.body === null) throw new ReadError("empty body");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TEAMS_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ReadError("body too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  /**
   * One GET of `/system/teams` as the service, with the one 401 retry. `sentAt` is the clock as the call that was
   * ANSWERED went out: auth read its tables after that instant (the proof of AC-4.6).
   */
  async function request(params: URLSearchParams, signal: AbortSignal): Promise<{ body: unknown; sentAt: number }> {
    if (tokens === null) throw new ReadError("no service client");
    const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    let retried = false;
    for (;;) {
      let token: string;
      try {
        token = await within(tokens.getToken(), signal);
      } catch (error) {
        throw new ReadError(error instanceof ReadError ? error.message : "no service token");
      }
      const sentAt = now();
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/system/teams?${params}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal,
          redirect: "error",
        });
      } catch (error) {
        throw new ReadError(`request failed (${error instanceof Error ? error.name : "unknown error"})`);
      }
      if (res.status === 401 && !retried) {
        await res.body?.cancel().catch(() => {});
        tokens.invalidate(token);
        retried = true;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new ReadError(`HTTP ${res.status}`);
      }
      try {
        return { body: JSON.parse(await within(readBody(res), signal)), sentAt };
      } catch (error) {
        throw new ReadError(error instanceof ReadError ? error.message : "unreadable body");
      }
    }
  }

  /** Remembers `fact` unless an entry sent LATER is held (answers can arrive out of order; equal stamps: the newer answer). */
  function store(fact: TeamFact, sentAt: number): void {
    const held = entries.get(fact.id);
    if (held === undefined || held.sentAt <= sentAt) entries.set(fact.id, { fact, sentAt });
  }

  /** One ids request of at most 50 ids. Never rejects. On an answer, the entries of the ids in it are refreshed. */
  async function readIds(ids: readonly string[]): Promise<ChunkOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { body, sentAt } = await request(new URLSearchParams({ ids: ids.join(",") }), controller.signal);
      const facts = parseTeams(body, ids);
      if (facts === null) return { ok: false, reason: "unexpected body" };
      for (const id of ids) {
        const fact = facts.get(id);
        if (fact !== undefined) store(fact, sentAt);
        // auth no longer says it knows the team: an older entry must not outlive that answer
        else if ((entries.get(id)?.sentAt ?? Infinity) < sentAt) entries.delete(id);
      }
      return { ok: true, facts };
    } catch (error) {
      return { ok: false, reason: error instanceof ReadError ? error.message : "unexpected error" };
    } finally {
      clearTimeout(timer);
    }
  }

  const distinctValid = (ids: readonly string[]): string[] => [...new Set(ids)].filter((id) => TEAM_ID.test(id));

  function chunksOf<T>(items: readonly T[]): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += TEAMS_MAX_IDS_PER_REQUEST) chunks.push(items.slice(i, i + TEAMS_MAX_IDS_PER_REQUEST));
    return chunks;
  }

  function prune(at: number): void {
    for (const [id, entry] of entries) if (at - entry.sentAt > RETAIN_MS) entries.delete(id);
  }

  const labelOf = (id: string): TeamLabel | null => {
    const held = entries.get(id)?.fact;
    return held === undefined ? null : { name: held.name, archived: held.archived };
  };

  /**
   * Puts one id's outcome into `read`: its facts, or - when the read failed - an entry the rule still allows
   * (`fallback`), else unavailable. Returns a note for the log.
   */
  function settle(
    id: string,
    outcome: ChunkOutcome,
    read: { teams: Map<string, TeamFact>; unavailable: Map<string, TeamLabel | null> },
    fallback: boolean,
    stale: number[],
  ): string | null {
    if (outcome.ok) {
      const fact = outcome.facts.get(id);
      if (fact !== undefined) read.teams.set(id, fact);
      return null;
    }
    const held = entries.get(id);
    const age = held === undefined ? Infinity : now() - held.sentAt;
    if (fallback && held !== undefined && age <= TEAMS_USABLE_MS) {
      read.teams.set(id, held.fact);
      stale.push(age);
      return outcome.reason;
    }
    read.unavailable.set(id, labelOf(id));
    return outcome.reason;
  }

  function logOutcome(read: TeamsRead, stale: readonly number[], reason: string | null): void {
    if (reason === null) return;
    if (stale.length > 0) {
      console.warn(`[teams] teams_stale_used count=${stale.length} max_age_ms=${Math.round(Math.max(...stale))} (refresh failed: ${reason})`);
    }
    if (read.unavailable.size > 0) {
      console.error(`[teams] teams_unavailable count=${read.unavailable.size} (refresh failed: ${reason})`);
    }
  }

  return {
    async cached(ids) {
      const wanted = distinctValid(ids);
      const read: TeamsRead = { teams: new Map(), unavailable: new Map() };
      const at = now();
      prune(at);

      const need = wanted.filter((id) => {
        const entry = entries.get(id);
        if (entry !== undefined && at - entry.sentAt < TEAMS_FRESH_MS) {
          read.teams.set(id, entry.fact);
          return false;
        }
        return true;
      });
      if (need.length === 0) return read;

      const waiting = new Map<string, Promise<ChunkOutcome>>();
      const toStart = need.filter((id) => {
        const flight = flights.get(id);
        if (flight !== undefined) waiting.set(id, flight);
        return flight === undefined;
      });
      if (toStart.length > 0) {
        const asked = new Set(need);
        const carried = [...entries]
          .filter(([id, entry]) => {
            const age = at - entry.sentAt;
            return !asked.has(id) && !flights.has(id) && age > TEAMS_PIGGYBACK_MS && age <= TEAMS_USABLE_MS;
          })
          .map(([id]) => id);
        for (const chunk of chunksOf([...toStart, ...carried])) {
          const started: Promise<ChunkOutcome> = readIds(chunk).finally(() => {
            for (const id of chunk) if (flights.get(id) === started) flights.delete(id);
          });
          for (const id of chunk) {
            flights.set(id, started);
            if (asked.has(id)) waiting.set(id, started);
          }
        }
      }

      // ONE wait for all the flights this call needs (D16). A flight still running when it ends is a failed refresh for
      // THIS call only: it is not aborted, keeps its own timeout and stores its answer with its own send stamp.
      const flightsNeeded = [...new Set(waiting.values())];
      const answered = new Map<Promise<ChunkOutcome>, ChunkOutcome>();
      for (const flight of flightsNeeded) void flight.then((outcome) => answered.set(flight, outcome));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(flightsNeeded),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, hostWaitMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }

      const stale: number[] = [];
      let reason: string | null = null;
      for (const id of need) {
        const flight = waiting.get(id)!;
        const outcome = answered.get(flight) ?? { ok: false, reason: "wait_exceeded" };
        const note = settle(id, outcome, read, true, stale);
        reason ??= note;
      }
      logOutcome(read, stale, reason);
      return read;
    },

    async fresh(ids, { fallback }) {
      const wanted = distinctValid(ids);
      const read: TeamsRead = { teams: new Map(), unavailable: new Map() };
      prune(now());
      if (wanted.length === 0) return read;

      const chunks = chunksOf(wanted);
      const outcomes = await Promise.all(chunks.map((chunk) => readIds(chunk)));
      const stale: number[] = [];
      let reason: string | null = null;
      chunks.forEach((chunk, i) => {
        for (const id of chunk) {
          const note = settle(id, outcomes[i]!, read, fallback, stale);
          reason ??= note;
        }
      });
      logOutcome(read, stale, reason);
      return read;
    },

    async options(q) {
      const params = new URLSearchParams({ state: "active" });
      if (q !== undefined && q !== "") params.set("q", q);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const { body } = await request(params, controller.signal);
        const parsed = OptionsAnswer.safeParse(body);
        if (!parsed.success) throw new ReadError("unexpected body");
        return parsed.data;
      } catch (error) {
        console.error(`[teams] teams_unavailable (options read failed: ${error instanceof ReadError ? error.message : "unexpected error"})`);
        throw teamsUnavailable();
      } finally {
        clearTimeout(timer);
      }
    },

    reset() {
      entries.clear();
      flights.clear();
    },
  };
}

// ─── The reader wired from the environment ──────────────────────────────────────────────────────────────────────────

/** Added to the production clock by tests only (`advanceTeamsClockForTests`). */
let testOffsetMs = 0;

if (serviceTokens === null && env.NODE_ENV !== "test") {
  console.warn(
    "[teams] the service client is not configured (CRM_INTERNAL_URL, SERVICE_CLIENT_ID, SERVICE_CLIENT_SECRET): every team read fails closed (teams_unavailable)",
  );
}

/** The client wired from the environment: what the routes and hosts call. */
export const teamReader: TeamReader = createTeamReader({
  baseUrl: env.AUTH_BASE_URL,
  tokens: serviceTokens,
  now: () => performance.now() + testOffsetMs,
});

/** Tests: forgets the wired reader's entries and puts its clock back. */
export function resetTeamReaderForTests(): void {
  teamReader.reset();
  testOffsetMs = 0;
}

/** Tests: moves the wired reader's clock forward, as time passing would. */
export function advanceTeamsClockForTests(ms: number): void {
  testOffsetMs += ms;
}
