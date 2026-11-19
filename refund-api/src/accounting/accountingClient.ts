/**
 * The `AccountingPort`: how refund-api reads Accounting (specs/20261119-accounting T17; plan § "How Refund
 * reads Accounting", D2, D3, D11, D28; AC-6.8, AC-4.8, AC-3.9; ADR 20261119-accounting-reference-data-belongs-to-
 * accounting-api-...).
 *
 * WHO. refund-api as itself: the 5-minute service JWT of `serviceTokens` (`system:refund-api`, whose scopes include
 * `accounting.reference.read`). The user's token is never forwarded: a Refund reviewer holds no Accounting capability.
 *
 * WHAT. Two read-only routes of accounting-api, parsed with the shared `accountingWire` schemas:
 * `GET /system/v1/entities/{entity}/reference-data` and `GET /system/v1/entities/{entity}/rates?pairs=…`.
 *
 * NO CACHE (D2). Every Refund operation reads live: one view, one options list, one approval, one settings write, one
 * export, one release run. Within ONE operation the answer is memoised, so the operation agrees with itself; nothing
 * outlives it. AC-4.8 (a change saved in Accounting is used by anything Refund starts later) holds with no margin to
 * spend, and nothing can be served stale after a failure.
 *
 * ONE DEADLINE PER OPERATION (D3, AC-6.8). {@link ACCOUNTING_DEADLINE_MS} counts from the operation's first read and
 * covers the token mint and every call of the operation (they run in parallel). One 401 drops the token and re-mints
 * it once, inside the same deadline; there is no other retry.
 *
 * ONE FAILURE: every way of not getting a clean, complete answer is `AccountingUnavailableError(kind)`, so no caller
 * can mistake "could not find out" for "nothing there" (ADR 20261103, narrow-channel rule). The kinds: the deadline,
 * a network error, a non-2xx (after the one 401 re-mint), a redirect, a non-JSON body, a body over 256 KiB, a schema
 * mismatch, a wrong entity echo, a rates answer that does not answer each asked pair exactly once, and a failed
 * token mint. The kind and the operation are logged at warn; never a body, a URL, a token or a status text.
 */

import { env } from "../lib/env";
import { serviceTokens, type ServiceTokenProvider } from "../lib/serviceToken";
import {
  ratesWire,
  referenceDataWire,
  WIRE_RATE_PAIRS_MAX,
  type RatePairWire,
  type ReferenceDataWire,
  type WireEntity,
  type WireRateCurrency,
} from "./accountingWire";

/** AC-6.8: Accounting that does not answer within 10 seconds is unreachable. Injectable in tests only. */
export const ACCOUNTING_DEADLINE_MS = 10_000;
/** A body larger than this is not read (a misbehaving or hostile peer cannot exhaust memory). */
export const ACCOUNTING_MAX_BODY_BYTES = 256 * 1024;
/** `Retry-After` of every 503 `accounting_unavailable` (plan § API contracts). */
export const ACCOUNTING_RETRY_AFTER_SECONDS = 30;

export const ACCOUNTING_FAILURE_KINDS = [
  "timeout",
  "network",
  "http_status",
  "unauthorized",
  "redirect",
  "not_json",
  "too_large",
  "schema",
  "entity_mismatch",
  "pair_mismatch",
  "token",
] as const;
export type AccountingFailureKind = (typeof ACCOUNTING_FAILURE_KINDS)[number];

/**
 * Accounting could not be read, completely and cleanly. `kind` is for logs and tests; the message is fixed and says
 * nothing about the peer (AC-6.10).
 */
export class AccountingUnavailableError extends Error {
  readonly kind: AccountingFailureKind;
  constructor(kind: AccountingFailureKind) {
    super("Accounting cannot be read");
    this.name = "AccountingUnavailableError";
    this.kind = kind;
  }
}

/** The Refund operations that read Accounting: the name goes to the log with the failure kind, nothing else. */
export type AccountingOperationName =
  | "approve"
  | "classify"
  | "view"
  | "options"
  | "defaults_read"
  | "defaults_write"
  | "export"
  | "release";

export interface RatePair {
  readonly currency: WireRateCurrency;
  /** `YYYY-MM` */
  readonly month: string;
}

export const ratePairKey = (pair: RatePair): string => `${pair.currency}:${pair.month}`;

/** One Refund operation's reads: one deadline, memoised answers (a snapshot consistent with itself). */
export interface AccountingOperation {
  readonly name: AccountingOperationName;
  /** The entity's accounts and VAT codes, with their `active` state. Memoised. */
  referenceData(entity?: WireEntity): Promise<ReferenceDataWire>;
  /**
   * The rate in effect (or why there is none) of each distinct pair, in the order asked. Pairs already read in this
   * operation are not read again; more than 36 pairs are read as several calls, in parallel.
   */
  rates(pairs: readonly RatePair[], entity?: WireEntity): Promise<RatePairWire[]>;
}

export interface AccountingPort {
  /** Starts one Refund operation. Nothing is read until the operation is asked. */
  begin(name: AccountingOperationName): AccountingOperation;
}

/** The raw, un-memoised reads of one operation: what the real client and the fake each supply. */
export interface AccountingReads {
  referenceData(entity: WireEntity): Promise<ReferenceDataWire>;
  /** One call: at most {@link WIRE_RATE_PAIRS_MAX} distinct pairs; the answer holds each pair once. */
  ratePairs(entity: WireEntity, pairs: readonly RatePair[]): Promise<readonly RatePairWire[]>;
}

/** Wraps raw reads into an operation: memoisation, de-duplication and chunking (shared by the client and the fake). */
export function newOperation(name: AccountingOperationName, reads: AccountingReads): AccountingOperation {
  const referenceMemo = new Map<WireEntity, Promise<ReferenceDataWire>>();
  const rateMemo = new Map<string, Promise<RatePairWire>>();

  return {
    name,
    referenceData(entity: WireEntity = "welld_ch") {
      let pending = referenceMemo.get(entity);
      if (!pending) {
        pending = reads.referenceData(entity);
        referenceMemo.set(entity, pending);
      }
      return pending;
    },
    async rates(pairs: readonly RatePair[], entity: WireEntity = "welld_ch") {
      const asked = new Map<string, RatePair>();
      for (const pair of pairs) asked.set(ratePairKey(pair), pair);
      const missing = [...asked.values()].filter((pair) => !rateMemo.has(`${entity}|${ratePairKey(pair)}`));
      for (let start = 0; start < missing.length; start += WIRE_RATE_PAIRS_MAX) {
        const chunk = missing.slice(start, start + WIRE_RATE_PAIRS_MAX);
        const call = reads.ratePairs(entity, chunk);
        // One call answers its chunk; each pair's memo entry settles with it. A failed call is remembered as failed:
        // nothing is retried inside the operation.
        const settled = call.then((answers) => new Map(answers.map((a) => [ratePairKey(a), a] as const)));
        settled.catch(() => undefined);
        for (const pair of chunk) {
          const entry = settled.then((byKey) => {
            const answer = byKey.get(ratePairKey(pair));
            if (!answer) throw new AccountingUnavailableError("pair_mismatch");
            return answer;
          });
          entry.catch(() => undefined);
          rateMemo.set(`${entity}|${ratePairKey(pair)}`, entry);
        }
      }
      return Promise.all([...asked.values()].map((pair) => rateMemo.get(`${entity}|${ratePairKey(pair)}`)!));
    },
  };
}

// ─── The real client ─────────────────────────────────────────────────────────

export interface AccountingClientOptions {
  /** `ACCOUNTING_INTERNAL_URL`, no trailing slash. */
  readonly baseUrl: string;
  readonly tokens: ServiceTokenProvider;
  /** Looked up per call (default: the global `fetch`) so a spied global is honoured. */
  readonly fetchImpl?: typeof fetch;
  /** Tests only. */
  readonly deadlineMs?: number;
}

function logUnavailable(operation: AccountingOperationName, kind: AccountingFailureKind): void {
  // The kind and the operation only: no URL, no body, no token, no status text.
  console.warn(JSON.stringify({ event: "refund.accounting_unavailable", operation, kind }));
}

async function readCapped(res: Response, race: <T>(p: Promise<T>) => Promise<T>): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > ACCOUNTING_MAX_BODY_BYTES) {
    void res.body?.cancel().catch(() => undefined);
    throw new AccountingUnavailableError("too_large");
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await race(reader.read());
    if (done) break;
    total += value.byteLength;
    if (total > ACCOUNTING_MAX_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new AccountingUnavailableError("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createAccountingClient(options: AccountingClientOptions): AccountingPort {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const deadlineMs = options.deadlineMs ?? ACCOUNTING_DEADLINE_MS;

  return {
    begin(name: AccountingOperationName): AccountingOperation {
      // The deadline starts at the operation's first read, so work done before it (a database read, a lock) does not
      // eat into it, and an operation that never reads never starts a clock.
      let signal: AbortSignal | null = null;
      let timedOut: Promise<never> | null = null;
      const clock = (): { signal: AbortSignal; timedOut: Promise<never> } => {
        if (!signal || !timedOut) {
          signal = AbortSignal.timeout(deadlineMs);
          const s = signal;
          timedOut = new Promise<never>((_, reject) => {
            const fire = () => reject(new AccountingUnavailableError("timeout"));
            if (s.aborted) fire();
            else s.addEventListener("abort", fire, { once: true });
          });
          timedOut.catch(() => undefined);
        }
        return { signal, timedOut };
      };
      /** Settles with `p`, or fails with `timeout` when the deadline passes first, whatever `p` does. */
      const race = <T>(p: Promise<T>): Promise<T> => {
        p.catch(() => undefined);
        return Promise.race([p, clock().timedOut]);
      };

      const fail = (kind: AccountingFailureKind): never => {
        logUnavailable(name, kind);
        throw new AccountingUnavailableError(kind);
      };

      async function mint(): Promise<string> {
        try {
          return await race(options.tokens.getToken());
        } catch (error) {
          if (error instanceof AccountingUnavailableError) return fail(error.kind);
          return fail("token");
        }
      }

      /** One GET, with the one 401 re-mint. Returns the parsed JSON. */
      async function getJson(path: string): Promise<unknown> {
        const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
        for (let attempt = 0; ; attempt++) {
          const token = await mint();
          let res: Response;
          try {
            res = await race(
              doFetch(`${baseUrl}${path}`, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                // Never follow: a redirect would replay the Bearer token to another host.
                redirect: "manual",
                signal: clock().signal,
              }),
            );
          } catch (error) {
            if (error instanceof AccountingUnavailableError) return fail(error.kind);
            return fail(clock().signal.aborted ? "timeout" : "network");
          }
          if (res.status === 401) {
            void res.body?.cancel().catch(() => undefined);
            if (attempt === 0) {
              options.tokens.invalidate(token);
              continue;
            }
            return fail("unauthorized");
          }
          if (res.status >= 300 && res.status < 400) {
            void res.body?.cancel().catch(() => undefined);
            return fail("redirect");
          }
          if (!res.ok) {
            void res.body?.cancel().catch(() => undefined);
            return fail("http_status");
          }
          let text: string;
          try {
            text = await readCapped(res, race);
          } catch (error) {
            if (error instanceof AccountingUnavailableError) return fail(error.kind);
            return fail(clock().signal.aborted ? "timeout" : "network");
          }
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return fail("not_json");
          }
        }
      }

      const reads: AccountingReads = {
        async referenceData(entity) {
          const body = await getJson(`/system/v1/entities/${entity}/reference-data`);
          const parsed = referenceDataWire.safeParse(body);
          if (!parsed.success) return fail("schema");
          if (parsed.data.entity !== entity) return fail("entity_mismatch");
          return parsed.data;
        },
        async ratePairs(entity, pairs) {
          const query = pairs.map(ratePairKey).join(",");
          const body = await getJson(`/system/v1/entities/${entity}/rates?pairs=${query}`);
          const parsed = ratesWire.safeParse(body);
          if (!parsed.success) return fail("schema");
          if (parsed.data.entity !== entity) return fail("entity_mismatch");
          // Each asked pair exactly once, and nothing else (the wire schema already forbids a pair twice).
          const asked = new Set(pairs.map(ratePairKey));
          if (parsed.data.rates.length !== asked.size || !parsed.data.rates.every((r) => asked.has(ratePairKey(r)))) {
            return fail("pair_mismatch");
          }
          return parsed.data.rates;
        },
      };

      return newOperation(name, reads);
    },
  };
}

// ─── The port the routes use ─────────────────────────────────────────────────

let current: AccountingPort | null = null;

/**
 * The port every Refund route and script reads through: the real client of `ACCOUNTING_INTERNAL_URL`, built once.
 * It holds no data (no cache), only the base URL and the shared token provider.
 */
export function accountingPort(): AccountingPort {
  current ??= createAccountingClient({ baseUrl: env.ACCOUNTING_INTERNAL_URL, tokens: serviceTokens });
  return current;
}

/**
 * Test seam (D28): replaces the port with a fake, or restores the real one with `null`. Refused outside
 * `NODE_ENV=test`, so no deployment can swap what Refund trusts.
 */
export function setAccountingPortForTests(port: AccountingPort | null): void {
  if (env.NODE_ENV !== "test") throw new Error("setAccountingPortForTests is available under NODE_ENV=test only");
  current = port;
}

/** The body of every 503 `accounting_unavailable` (AC-6.1, AC-6.5, AC-6.9; D15). Generic: no URL, host or id (AC-6.10). */
export function accountingUnavailableProblem(path: string) {
  return {
    type: "https://httpstatuses.com/503",
    title: "Service Unavailable",
    status: 503 as const,
    detail: "Accounting's reference data cannot be read right now. Nothing was saved. Try again in a few minutes.",
    instance: path,
    code: "accounting_unavailable" as const,
  };
}
