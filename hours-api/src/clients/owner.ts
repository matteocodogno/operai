/**
 * The one HTTP adapter every owner client goes through (specs/029 T11; plan § API contracts,
 * ADR-0089, risk R7). projects-api, crm-api, activities-api and meetings-api each answer a question
 * hours-api cannot answer itself — may this person book on this, what is it called, who else is on
 * it — and hours-api asks them AS THE CALLER, with the caller's own `Authorization` forwarded unchanged
 * (no new credential, the owner applies its own live authorization), except meetings-api's system
 * route, which gets hours-api's own service JWT (`meetings.ts`).
 *
 * WHAT COUNTS AS AN ANSWER: a clean 200 whose body is JSON, and nothing else. Every other outcome —
 * a timeout, a network error, a 5xx, a 404 from a route the owner has not deployed yet, a 422 from an
 * owner that predates T6-T8 (R7), any other 4xx, a redirect, a body that is not JSON or breaks the
 * contract — is `unavailable`, never "not found" and never "nobody": a malformed request is a
 * hours-api bug, never the person's, and the entry writes answer 503 `host_unavailable` on it
 * (AC-2.11) while the views degrade (AC-4.7). That reading is right only because hours-api never
 * sends an id outside the id rule (1..64 characters, no NUL, no comma, no whitespace at either end;
 * plan § Entries): the entry layer refuses such an id with its own 400 BEFORE any client is called, so
 * an owner's 4xx is always a version gap, never the caller's malformed input. The clients rely on it
 * and do not re-check.
 *
 * - 2 s timeout (plan R2), `redirect: "error"`: the caller's token must never follow a redirect to
 *   another host.
 * - Query values are built with `URLSearchParams`, so an id holding `&`, `#`, `+`, `%` or a space
 *   reaches the owner exactly as given.
 * - Batches of the owner's cap (25 / 50 / 100), at most `MAX_PARALLEL_BATCHES` in flight; one batch
 *   that does not answer makes the whole answer `unavailable`.
 * - Logs a reason code and the owner, never an id, a token, a header or a body.
 */

import { z } from "zod";

export const OWNER_TIMEOUT_MS = 2_000;
/** A page asks up to 500 ids: more than this at once would only queue on the owner. */
const MAX_PARALLEL_BATCHES = 4;

export interface CallOptions {
  /** Overrides the 2 s timeout. For tests. */
  readonly timeoutMs?: number;
}

export type OwnerName = "projects" | "crm" | "activities" | "meetings";

export interface OwnerRequest {
  readonly owner: OwnerName;
  /** What is asked, for the log: `resolve`, `list`, `system-hosts`. */
  readonly op: string;
  readonly method: "GET" | "POST";
  readonly baseUrl: string;
  readonly path: string;
  /** The whole header value: the caller's, forwarded unchanged, or `Bearer <service token>`. */
  readonly authorization: string;
  readonly query?: URLSearchParams;
  /** Sent as JSON. */
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export type OwnerAnswer =
  | { readonly kind: "ok"; readonly json: unknown }
  | { readonly kind: "unavailable"; readonly reason: string; readonly status?: number };

export const UNAVAILABLE = { state: "unavailable" } as const;
export const NOT_READER = { state: "not_reader" } as const;

export type Unavailable = typeof UNAVAILABLE;

/** One line, no id, token or body. Returns `UNAVAILABLE` so a client can `return unavailable(...)`. */
export function unavailable(owner: OwnerName, op: string, reason: string): Unavailable {
  console.warn(`[owners] ${owner} ${op} unavailable reason=${reason}`);
  return UNAVAILABLE;
}

/**
 * The owner's answer to one request. Never throws.
 */
export async function callOwner(request: OwnerRequest): Promise<OwnerAnswer> {
  const fail = (reason: string, status?: number): OwnerAnswer => {
    unavailable(request.owner, request.op, reason);
    return status === undefined ? { kind: "unavailable", reason } : { kind: "unavailable", reason, status };
  };

  const query = request.query?.toString() ?? "";
  const url = `${request.baseUrl.replace(/\/+$/, "")}${request.path}${query === "" ? "" : `?${query}`}`;
  const headers: Record<string, string> = { Authorization: request.authorization };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(request.timeoutMs ?? OWNER_TIMEOUT_MS),
      // The caller's token travels with this request: never let a redirect carry it elsewhere.
      redirect: "error",
    });
  } catch (error) {
    return fail(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport");
  }
  // Only a 200 is an answer: a 203, a 404 and a 422 all say "the owner did not answer THIS".
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return fail(`http_${res.status}`, res.status);
  }
  try {
    return { kind: "ok", json: await res.json() };
  } catch (error) {
    return fail(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "malformed");
  }
}

// ─── Batches ─────────────────────────────────────────────────────────────────

export const distinct = (ids: readonly string[]): string[] => [...new Set(ids)];

const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Runs `run` over `ids` in batches of `size`, a few at a time. The first batch (by position) that
 * answers with a `stop` ends the whole answer, and no further batch is started once any has: a
 * shorter list must never pass for a complete one. `run` must not throw.
 */
export async function inBatches<V, S>(
  ids: readonly string[],
  size: number,
  run: (batch: string[]) => Promise<{ readonly done: V } | { readonly stop: S }>,
): Promise<{ readonly done: V[] } | { readonly stop: S }> {
  const batches = chunks(distinct(ids), size);
  const results: Array<{ readonly done: V } | { readonly stop: S } | undefined> = new Array(batches.length).fill(undefined);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      const index = next++;
      const batch = batches[index];
      if (batch === undefined) return;
      const result = await run(batch);
      results[index] = result;
      if ("stop" in result) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_BATCHES, batches.length) }, worker));

  const done: V[] = [];
  for (const result of results) {
    if (result !== undefined && "stop" in result) return result;
    if (result !== undefined) done.push(result.done);
  }
  return { done };
}

/**
 * What a list-by-ids owner answered about `asked`: the first item for each asked id, the rest never
 * believed (an owner cannot inject entries). `filterIgnored` is true when it handed back items nobody
 * asked for AND an asked id is not among what it answered: a filter that was not applied proves nothing
 * about what is absent, so such an id is not "does not exist" — it is unanswered (R7: a meetings-api
 * before T8 ignores `ids` and answers the caller's latest page).
 */
export function keepAsked<W extends { readonly id: string }>(
  asked: readonly string[],
  answered: readonly W[],
): { readonly kept: Map<string, W>; readonly filterIgnored: boolean } {
  const wanted = new Set(asked);
  const kept = new Map<string, W>();
  let foreign = false;
  for (const item of answered) {
    if (!wanted.has(item.id)) {
      foreign = true;
      continue;
    }
    if (!kept.has(item.id)) kept.set(item.id, item);
  }
  return { kept, filterIgnored: foreign && asked.some((id) => !kept.has(id)) };
}

// ─── Host resolve: projects-api and crm-api ──────────────────────────────────

export type ResolveOutcome<T> = Unavailable | typeof NOT_READER | { readonly state: "ok"; readonly items: ReadonlyMap<string, T> };

/** A path inside the suite: starts with one `/`, not `//`, no scheme, no backslash, no whitespace or control character. */
// eslint-disable-next-line no-control-regex
export const isSuitePath = (href: string): boolean => /^\/(?!\/)[^\u0000-\u001f\s\\]*$/.test(href);

/** The cap on ids of one `POST /activity-host/v1/resolve` call, at both owners. */
export const RESOLVE_BATCH_SIZE = 25;

/** Looked at first and alone: `reader: false` decides without the rest being valid. */
const readerOnly = z.object({ reader: z.boolean() });

export interface HostResolve<Wire extends { readonly id: string }, T> {
  readonly owner: "projects" | "crm";
  readonly entityType: "project" | "deal";
  readonly baseUrl: string;
  /** One entry of the answer's `items`, as the owner sends it. */
  readonly item: z.ZodType<Wire>;
  /** `undefined`: the item breaks the contract (an href outside the suite). */
  readonly toResolved: (item: Wire) => T | undefined;
}

/**
 * `POST {owner}/activity-host/v1/resolve` as the caller: what may THIS caller read of these entities.
 * `not_reader` (the caller may not read at all) decides alone; otherwise every asked id is answered, or
 * the answer is `unavailable`. An item about an id nobody asked about is ignored.
 */
export async function resolveAtHost<Wire extends { readonly id: string }, T>(
  config: HostResolve<Wire, T>,
  authorization: string,
  ids: readonly string[],
  options: CallOptions = {},
): Promise<ResolveOutcome<T>> {
  const { owner } = config;
  const body = z.object({ reader: z.literal(true), items: z.array(config.item) });

  const outcome = await inBatches<ReadonlyMap<string, T>, Unavailable | typeof NOT_READER>(ids, RESOLVE_BATCH_SIZE, async (batch) => {
    const answer = await callOwner({
      owner,
      op: "resolve",
      method: "POST",
      baseUrl: config.baseUrl,
      path: "/activity-host/v1/resolve",
      authorization,
      body: { entityType: config.entityType, ids: batch },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (answer.kind === "unavailable") return { stop: UNAVAILABLE };

    const decision = readerOnly.safeParse(answer.json);
    if (!decision.success) return { stop: unavailable(owner, "resolve", "malformed") };
    // `reader: false` alone decides: nothing else in the body is read.
    if (!decision.data.reader) return { stop: NOT_READER };
    const parsed = body.safeParse(answer.json);
    if (!parsed.success) return { stop: unavailable(owner, "resolve", "malformed") };

    const asked = new Set(batch);
    const items = new Map<string, T>();
    for (const item of parsed.data.items) {
      // An answer about an id we did not ask for is ignored (an owner cannot inject entries); the first answer for an id stands.
      if (!asked.has(item.id) || items.has(item.id)) continue;
      const resolved = config.toResolved(item);
      if (resolved === undefined) return { stop: unavailable(owner, "resolve", "malformed") };
      items.set(item.id, resolved);
    }
    // An owner that leaves an asked id unanswered has not answered the question.
    for (const id of batch) if (!items.has(id)) return { stop: unavailable(owner, "resolve", "incomplete") };
    return { done: items };
  });

  if ("stop" in outcome) return outcome.stop;
  return { state: "ok", items: new Map(outcome.done.flatMap((items) => [...items])) };
}
