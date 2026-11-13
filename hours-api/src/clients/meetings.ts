/**
 * meetings-api, two ways (specs/029 T11; plan § Sequences, § API contracts "meetings-api", ADR-0089,
 * AC-2.5, AC-2.6, AC-2.10, AC-4.5, AC-4.7, AC-4.11, risk R7; meetings-api T8 and T9):
 *
 * AS THE CALLER — `listMeetingsByIds`   GET /meetings?ids=a,b,c   (≤ 25 ids)
 *   meetings-api's own list: the caller's OWN meetings (creator or Operai participant) among those ids.
 *   One call is both the booking check (AC-2.5) and the label (a title only for someone who took part,
 *   AC-4.10): a host-only reader, someone else's meeting and an unknown id are absent alike (AC-2.10).
 *   The caller's `Authorization` is forwarded unchanged. No `page`: 25 ids fit page 1.
 *
 * AS ITSELF — `readMeetingHosts`, `readMeetingsLinkedToDeal`   GET /system/meetings/hosts
 *   `?ids=a,b,c` (≤ 100): the deal each meeting is linked to now. `?dealId=<id>`: the meetings linked
 *   to that deal now. A meeting's CURRENT deal is not stored on an entry (a relink must move its hours,
 *   AC-2.6), and no viewer is entitled to it through a meeting they may not read, so hours-api asks
 *   meetings-api's first `/system/*` route with its OWN credential: the 5-minute service JWT of
 *   `auth POST /system/service-token` (scope `meetings.hosts.read`, `sub` `system:hours-api`,
 *   `aud` = SERVICE_AUDIENCE), cached by `serviceTokens`, dropped after a 401 and fetched fresh ONCE.
 *   NEVER the caller's token, and nothing here takes one. What it learns reaches a viewer only with the
 *   right to read the deal it names (labels, T13). It answers `{id, host}` and nothing else.
 *
 * An unknown id is simply absent from the system answer (the meeting no longer exists). Absence means
 * so only when the answer carries nothing nobody asked for (`keepAsked`).
 *
 * See `owner.ts` for what counts as an answer and what is `unavailable`.
 */

import { z } from "zod";
import { env } from "../lib/env";
import { serviceTokens } from "../lib/serviceToken";
import { callOwner, inBatches, keepAsked, unavailable, UNAVAILABLE, type CallOptions, type OwnerAnswer, type Unavailable } from "./owner";

/** meetings-api's cap on `ids` of the list. */
export const MEETINGS_IDS_BATCH_SIZE = 25;
/** meetings-api's cap on `ids` of the system route. */
export const MEETING_HOSTS_BATCH_SIZE = 100;

const nonEmpty = z.string().min(1);

// ─── As the caller ───────────────────────────────────────────────────────────

/** A meeting the caller took part in: only these are ever answered. */
export interface MeetingFact {
  readonly id: string;
  readonly title: string;
  readonly role: "creator" | "participant";
}

export type MeetingsByIds = Unavailable | { readonly state: "ok"; readonly items: ReadonlyMap<string, MeetingFact> };

const wireRow = z.object({ id: nonEmpty, title: z.string(), role: z.string() });
const listBody = z.object({ items: z.array(wireRow) });

/** The caller's own meetings among `ids`; every other id is absent from the map. */
export async function listMeetingsByIds(authorization: string, ids: readonly string[], options: CallOptions = {}): Promise<MeetingsByIds> {
  const outcome = await inBatches<ReadonlyMap<string, MeetingFact>, Unavailable>(ids, MEETINGS_IDS_BATCH_SIZE, async (batch) => {
    const answer = await callOwner({
      owner: "meetings",
      op: "list-by-ids",
      method: "GET",
      baseUrl: env.MEETINGS_API_URL,
      path: "/meetings",
      authorization,
      // One comma-separated member, and no `page`.
      query: new URLSearchParams({ ids: batch.join(",") }),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (answer.kind === "unavailable") return { stop: UNAVAILABLE };
    const parsed = listBody.safeParse(answer.json);
    if (!parsed.success) return { stop: unavailable("meetings", "list-by-ids", "malformed") };

    const { kept, filterIgnored } = keepAsked(batch, parsed.data.items);
    if (filterIgnored) return { stop: unavailable("meetings", "list-by-ids", "filter_ignored") };
    const items = new Map<string, MeetingFact>();
    for (const [id, row] of kept) {
      // This list is the caller's own meetings, so no other role belongs in it: someone who did not take part neither books nor sees a title.
      if (row.role === "creator" || row.role === "participant") items.set(id, { id, title: row.title, role: row.role });
    }
    return { done: items };
  });

  if ("stop" in outcome) return outcome.stop;
  return { state: "ok", items: new Map(outcome.done.flatMap((items) => [...items])) };
}

// ─── As itself ───────────────────────────────────────────────────────────────

export interface MeetingHost {
  /** The CRM deal the meeting is linked to now, or null (no host, or a host that is not a deal). */
  readonly dealId: string | null;
}

export type MeetingHosts = Unavailable | { readonly state: "ok"; /** An id that is absent: the meeting no longer exists. */ readonly items: ReadonlyMap<string, MeetingHost> };
export type LinkedMeetings = Unavailable | { readonly state: "ok"; readonly meetingIds: readonly string[] };

const wireSystemItem = z.object({
  id: nonEmpty,
  host: z.object({ app: z.string(), entityType: z.string(), entityId: nonEmpty }).nullable(),
});
const systemBody = z.object({ items: z.array(wireSystemItem) });

const dealOf = (host: z.infer<typeof wireSystemItem>["host"]): string | null =>
  host !== null && host.app === "crm" && host.entityType === "deal" ? host.entityId : null;

/** One call to the system route under hours-api's own credential; a 401 is retried once with a fresh token. */
async function callAsService(op: string, query: URLSearchParams, options: CallOptions): Promise<OwnerAnswer> {
  for (let attempt = 0; ; attempt++) {
    let token: string;
    try {
      token = await serviceTokens.getToken();
    } catch {
      // `auth` would not mint one (a ServiceTokenError names a status at most). Nothing was asked of meetings-api.
      unavailable("meetings", op, "token");
      return { kind: "unavailable", reason: "token" };
    }
    const answer = await callOwner({
      owner: "meetings",
      op,
      method: "GET",
      baseUrl: env.MEETINGS_API_URL,
      path: "/system/meetings/hosts",
      authorization: `Bearer ${token}`,
      query,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (answer.kind === "unavailable" && answer.status === 401 && attempt === 0) {
      // A rotated signing key, or a token revoked early: this one is no good. Fresh credential, once.
      serviceTokens.invalidate(token);
      continue;
    }
    return answer;
  }
}

/** The deal each of `ids` is linked to now; an id the owner does not know is absent from the map. */
export async function readMeetingHosts(ids: readonly string[], options: CallOptions = {}): Promise<MeetingHosts> {
  const outcome = await inBatches<ReadonlyMap<string, MeetingHost>, Unavailable>(ids, MEETING_HOSTS_BATCH_SIZE, async (batch) => {
    const answer = await callAsService("hosts-by-ids", new URLSearchParams({ ids: batch.join(",") }), options);
    if (answer.kind === "unavailable") return { stop: UNAVAILABLE };
    const parsed = systemBody.safeParse(answer.json);
    if (!parsed.success) return { stop: unavailable("meetings", "hosts-by-ids", "malformed") };

    const { kept, filterIgnored } = keepAsked(batch, parsed.data.items);
    if (filterIgnored) return { stop: unavailable("meetings", "hosts-by-ids", "filter_ignored") };
    return { done: new Map([...kept].map(([id, item]) => [id, { dealId: dealOf(item.host) }])) };
  });

  if ("stop" in outcome) return outcome.stop;
  return { state: "ok", items: new Map(outcome.done.flatMap((items) => [...items])) };
}

/**
 * The meetings linked to `dealId` now. A deal's figures are never shown low (AC-4.11): an answer that
 * holds a meeting not linked to this deal is an owner that did not apply the filter, so nothing it left
 * out can be known: `unavailable`.
 */
export async function readMeetingsLinkedToDeal(dealId: string, options: CallOptions = {}): Promise<LinkedMeetings> {
  const answer = await callAsService("meetings-of-deal", new URLSearchParams({ dealId }), options);
  if (answer.kind === "unavailable") return UNAVAILABLE;
  const parsed = systemBody.safeParse(answer.json);
  if (!parsed.success) return unavailable("meetings", "meetings-of-deal", "malformed");

  const meetingIds = new Set<string>();
  for (const item of parsed.data.items) {
    if (dealOf(item.host) !== dealId) return unavailable("meetings", "meetings-of-deal", "filter_ignored");
    meetingIds.add(item.id);
  }
  return { state: "ok", meetingIds: [...meetingIds] };
}
