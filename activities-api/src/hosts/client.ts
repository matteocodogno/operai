/**
 * The single HTTP adapter to an activity host (specs/20261110-activities plan.md § Access and
 * § Host contract, ADR 20261110-activities-service-access-delegated-to-host; AC-8.1, AC-8.2, AC-8.3). crm-api and projects-api go through THIS
 * code, with no host-specific branch anywhere in activities-api (meetings-api `hosts/client.ts`
 * is the model).
 *
 *   resolve(host, authorization, {ids, related?})   "what may THIS CALLER do with these entities?"
 *       POST {baseUrl}/activity-host/v1/resolve, the caller's own Authorization forwarded
 *       verbatim (ADR 20261104-meeting-host-contract-resolve-and-notices model: no new secret, the host applies its own live authorization).
 *       At most 25 ids per call, a 2 s timeout, `redirect:"error"`, never cached.
 *
 * What counts as an answer (plan amendments 2026-11-11):
 *   - ONLY a 200. Every other status (401, 403, 404, 400/422, 5xx) is `unavailable`: a host's
 *     validation error means activities-api sent a bad request, which is never the user's.
 *   - `reader:false` alone decides: `not_reader`, and the response's items and related are not
 *     looked at (crm-api sends `items:[]`, projects-api sends every id `missing`).
 *   - Only for a reader is the answer checked for completeness: one item for every asked id.
 *   - `related` is optional (absent = none) and read only from a host that has related types;
 *     `assignees` only from a host that lists them.
 *
 * Every defect (timeout, transport error, status, body that breaks the contract, an `href` that
 * is not a path inside the suite, an unanswered id) is `unavailable`: never a throw, never a
 * guess. The callers fail CLOSED on it (503 `host_unavailable`).
 *
 * Logging: the host (`app/entityType`) and a reason code, never an id, a label, a token or a body.
 */

import { z } from "zod";
import type { ActivityHost, HostEntity, HostRelated, RelatedType, ResolveResult } from "./registry";

export const RESOLVE_TIMEOUT_MS = 2_000;
/** The contract's cap on ids per resolve call. */
export const RESOLVE_BATCH_SIZE = 25;
/** The contract's cap on related ids of one type per resolve call. */
export const RESOLVE_RELATED_BATCH_SIZE = 100;
const MAX_LABEL = 200;

export interface ClientOptions {
  /** Overrides the default timeout (tests). */
  readonly timeoutMs?: number;
}

export interface ResolveRequest {
  /** The host entities asked about; `[]` asks only "may I read at all?". */
  readonly ids: readonly string[];
  /** CRM contacts and deals to confirm under the asked companies; ignored by a host with no related types. */
  readonly related?: Readonly<Partial<Record<RelatedType, readonly string[]>>>;
}

const hostLabel = (host: ActivityHost) => `${host.app}/${host.entityType}`;

// ─── The wire shapes ────────────────────────────────────────────────────────

const nonEmpty = z.string().min(1);
const mayFlags = z.object({ write: z.boolean(), manage: z.boolean() });
const wireItem = z.discriminatedUnion("state", [
  z.object({ id: nonEmpty, state: z.literal("missing") }),
  z.object({
    id: nonEmpty,
    state: z.literal("open"),
    writable: z.boolean(),
    label: nonEmpty,
    href: z.string(),
    may: mayFlags,
    /** `null`: the host could not find out who is on the project (specs/20261126-teams AC-5.4); absent stays malformed. */
    assignees: z.array(nonEmpty).nullable().optional(),
  }),
]);
const wireRelated = z.object({
  type: z.enum(["contact", "deal"]),
  id: nonEmpty,
  parentId: nonEmpty,
  label: z.string(),
  href: z.string(),
});
/** Looked at first and alone: `reader:false` decides without the rest being valid. */
const readerOnly = z.object({ reader: z.boolean() });
const readerBody = z.object({
  reader: z.literal(true),
  /** US-9: optional; anything but `true` (absent included) is "not in the sales team". */
  salesTeam: z.boolean().optional(),
  items: z.array(wireItem),
  related: z.array(wireRelated).optional(),
});

/** A path inside the suite: starts with one `/`, not `//`, no scheme, no backslash, no control characters. */
// eslint-disable-next-line no-control-regex
const isSuitePath = (href: string): boolean => /^\/(?!\/)[^\u0000-\u001f\s\\]*$/.test(href);

const shorten = (label: string) => (label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label);

// ─── One call ───────────────────────────────────────────────────────────────

type CallResult =
  | { readonly kind: "unavailable" }
  | { readonly kind: "not_reader" }
  | { readonly kind: "ok"; readonly entities: Map<string, HostEntity>; readonly related: HostRelated[]; readonly salesTeam: boolean };

interface Call {
  readonly ids: readonly string[];
  readonly related: Partial<Record<RelatedType, readonly string[]>>;
}

async function resolveCall(host: ActivityHost, authorization: string, call: Call, timeoutMs: number): Promise<CallResult> {
  const fail = (reason: string): CallResult => {
    console.warn(`[hosts] resolve unavailable host=${hostLabel(host)} reason=${reason}`);
    return { kind: "unavailable" };
  };

  const hasRelated = Object.values(call.related).some((list) => list.length > 0);
  let res: Response;
  try {
    res = await globalThis.fetch(`${host.baseUrl}/activity-host/v1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ entityType: host.entityType, ids: call.ids, ...(hasRelated ? { related: call.related } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
      // The caller's token travels with this request: never let a redirect carry it elsewhere.
      redirect: "error",
    });
  } catch (error) {
    return fail(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport");
  }
  // Only a 200 is an answer: a 203, a 404 and a 422 are all "the host did not answer this".
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return fail(`http_${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (error) {
    return fail(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "malformed");
  }

  const decision = readerOnly.safeParse(json);
  if (!decision.success) return fail("malformed");
  // `reader:false` alone decides: nothing else in the body is read.
  if (!decision.data.reader) return { kind: "not_reader" };

  const body = readerBody.safeParse(json);
  if (!body.success) return fail("malformed");

  const asked = new Set(call.ids);
  const entities = new Map<string, HostEntity>();
  for (const item of body.data.items) {
    // An answer about an id we did not ask is ignored (a host cannot inject entries); the first answer for an id stands.
    if (!asked.has(item.id) || entities.has(item.id)) continue;
    if (item.state === "missing") {
      entities.set(item.id, { state: "missing" });
      continue;
    }
    if (!isSuitePath(item.href)) return fail("malformed");
    let assignees: readonly string[] | "unavailable" | null = null;
    if (host.assignees === "host_list") {
      // The host that lists the people a task may go to must state them: absent is not "nobody".
      if (item.assignees === undefined) return fail("malformed");
      // `null` is the host saying "could not find out" (teams unreadable): only an assignment needs
      // the list, so it is kept per item and neither fails this answer nor becomes an empty list.
      assignees = item.assignees === null ? "unavailable" : [...new Set(item.assignees)];
    }
    entities.set(item.id, {
      state: "open",
      writable: item.writable,
      label: shorten(item.label),
      href: item.href,
      may: { write: item.may.write, manage: item.may.manage },
      assignees,
    });
  }
  // A host that leaves an asked id unanswered has not answered the question.
  for (const id of call.ids) if (!entities.has(id)) return fail("incomplete");

  const related: HostRelated[] = [];
  if (host.relatedTypes.length > 0) {
    for (const item of body.data.related ?? []) {
      if (!isSuitePath(item.href)) return fail("malformed");
      // Only what was asked for, of a type this host has, under a company that was asked about.
      if (!host.relatedTypes.includes(item.type)) continue;
      if (!(call.related[item.type] ?? []).includes(item.id)) continue;
      if (!asked.has(item.parentId)) continue;
      related.push({ type: item.type, id: item.id, parentId: item.parentId, label: shorten(item.label), href: item.href });
    }
  }
  return { kind: "ok", entities, related, salesTeam: body.data.salesTeam === true };
}

// ─── resolve ────────────────────────────────────────────────────────────────

const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** The calls one resolve takes: the ids in batches of 25, each paired with every slice of 100 related ids. */
function planCalls(host: ActivityHost, request: ResolveRequest): Call[] {
  const ids = [...new Set(request.ids)];
  const relatedByType: Partial<Record<RelatedType, string[][]>> = {};
  let slices = 1;
  for (const type of host.relatedTypes) {
    const list = [...new Set(request.related?.[type] ?? [])];
    if (list.length === 0) continue;
    relatedByType[type] = chunks(list, RESOLVE_RELATED_BATCH_SIZE);
    slices = Math.max(slices, relatedByType[type]!.length);
  }
  const idBatches = ids.length === 0 ? [[]] : chunks(ids, RESOLVE_BATCH_SIZE);
  const calls: Call[] = [];
  for (const batch of idBatches) {
    for (let slice = 0; slice < slices; slice++) {
      const related: Partial<Record<RelatedType, readonly string[]>> = {};
      for (const [type, lists] of Object.entries(relatedByType) as Array<[RelatedType, string[][]]>) {
        const part = lists[slice];
        if (part) related[type] = part;
      }
      calls.push({ ids: batch, related });
    }
  }
  return calls;
}

export async function resolve(
  host: ActivityHost,
  authorization: string,
  request: ResolveRequest,
  options: ClientOptions = {},
): Promise<ResolveResult> {
  const entities = new Map<string, HostEntity>();
  const related = new Map<string, HostRelated>();
  // Every call must say so: one that does not makes the whole answer "not in the sales team".
  let salesTeam = true;
  // Sequential, not parallel: a page of 25 is one call, and a larger list is rare. A defect in
  // any call ends the whole answer.
  for (const call of planCalls(host, request)) {
    const result = await resolveCall(host, authorization, call, options.timeoutMs ?? RESOLVE_TIMEOUT_MS);
    if (result.kind === "unavailable") return { state: "unavailable" };
    if (result.kind === "not_reader") return { state: "not_reader" };
    for (const [id, entity] of result.entities) if (!entities.has(id)) entities.set(id, entity);
    for (const item of result.related) related.set(`${item.type}/${item.id}`, item);
    salesTeam &&= result.salesTeam;
  }
  return { state: "ok", entities, related: [...related.values()], salesTeam };
}
