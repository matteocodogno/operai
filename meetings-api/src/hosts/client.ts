/**
 * The single HTTP adapter to a host (specs/021-meetings plan.md § Host integration
 * contract, ADR-0059; AC-11.4, AC-11.10). The CRM and the test hosts go through
 * THIS code, with no host-specific branch anywhere in meetings-api.
 *
 * meetings-api calls a host for exactly two things, and this module exports
 * exactly two functions:
 *
 *   resolve(host, authorization, ids)   "may THIS CALLER open these entities?"
 *       POST {baseUrl}/meeting-host/v1/resolve, the caller's own JWT forwarded
 *       verbatim (ADR-0035 model: no new secret, the host applies its own live
 *       authorization). Batches of at most 25. 2 s timeout.
 *   sendNotice(host, notice, tokens)    the host notice
 *       POST {baseUrl}/system/meeting-host/v1/notices, a scoped service JWT
 *       (`host-notices.send`). One attempt, 5 s timeout; WHEN and how often it is
 *       retried is the outbox's business (T20), not this client's.
 *
 * Both fail the same way: ANY defect is "unavailable" (resolve) or a typed failure
 * (sendNotice), never a throw and never a guess. A 5xx, a timeout, a transport
 * error, a body that breaks the contract, an `href` that is not a path inside the
 * suite: every one is unavailable, and every caller treats unavailable as "do not
 * grant" (create with a host, relink, host-visible read) and as "fail soft" only for
 * a display label.
 *
 * Logging: the host (`app/entityType`) and a reason code, never an id, a title, a
 * token or a body (AC-4.10).
 */

import { z } from "zod";
import type { ServiceTokenProvider } from "../lib/serviceToken";
import type {
  HostDefinition,
  HostEntity,
  HostNotice,
  NoticeFailureCode,
  NoticeResult,
  ResolveResult,
} from "./registry";

const RESOLVE_TIMEOUT_MS = 2_000;
const NOTICE_TIMEOUT_MS = 5_000;
/** The contract's cap on ids per resolve call. */
const RESOLVE_BATCH = 25;
const MAX_TITLE = 200;

export interface ClientOptions {
  /** Overrides the default timeout (tests). */
  readonly timeoutMs?: number;
}

const hostLabel = (host: HostDefinition) => `${host.app}/${host.entityType}`;

// ─── resolve ────────────────────────────────────────────────────────────────

const resolveItem = z.object({
  id: z.string().min(1),
  state: z.enum(["open", "closed", "missing"]),
  title: z.string().optional(),
  href: z.string().optional(),
  hostVisible: z.boolean().optional(),
});
const resolveBody = z.object({ items: z.array(resolveItem) });

/** A path inside the suite: starts with one `/`, not `//`, no scheme, no control characters. */
// eslint-disable-next-line no-control-regex
const isSuitePath = (href: string): boolean => /^\/(?!\/)[^\u0000-\u001f\s\\]*$/.test(href);

/** One batch → the host's answer for exactly the ids asked, or `null` when anything is off. */
async function resolveBatch(
  host: HostDefinition,
  authorization: string,
  ids: readonly string[],
  timeoutMs: number,
): Promise<Map<string, HostEntity> | null> {
  const fail = (reason: string) => {
    console.warn(`[hosts] resolve unavailable host=${hostLabel(host)} reason=${reason}`);
    return null;
  };

  let res: Response;
  try {
    res = await globalThis.fetch(`${host.baseUrl}/meeting-host/v1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ entityType: host.entityType, ids }),
      signal: AbortSignal.timeout(timeoutMs),
      // The caller's token travels with this request: never let a redirect carry it elsewhere.
      redirect: "error",
    });
  } catch (error) {
    return fail(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return fail(`http_${res.status}`);
  }

  let parsed: z.infer<typeof resolveBody>;
  try {
    const result = resolveBody.safeParse(await res.json());
    if (!result.success) return fail("malformed");
    parsed = result.data;
  } catch (error) {
    return fail(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "malformed");
  }

  const asked = new Set(ids);
  const entities = new Map<string, HostEntity>();
  for (const item of parsed.items) {
    // An answer about an id we did not ask is ignored: a host cannot inject entries.
    if (!asked.has(item.id) || entities.has(item.id)) continue;
    if (item.state !== "open") {
      // title / href / hostVisible exist only for an open entity; anything else is dropped.
      entities.set(item.id, { state: item.state });
      continue;
    }
    if (typeof item.title !== "string" || typeof item.href !== "string" || !isSuitePath(item.href)) return fail("malformed");
    entities.set(item.id, {
      state: "open",
      title: item.title.length > MAX_TITLE ? `${item.title.slice(0, MAX_TITLE - 1)}…` : item.title,
      href: item.href,
      // Absent means "not granted": a grant must be stated, never assumed.
      hostVisible: item.hostVisible === true,
    });
  }
  // A host that leaves an asked id unanswered has not answered the question.
  for (const id of ids) if (!entities.has(id)) return fail("incomplete");
  return entities;
}

export async function resolve(
  host: HostDefinition,
  authorization: string,
  ids: readonly string[],
  options: ClientOptions = {},
): Promise<ResolveResult> {
  const unique = [...new Set(ids)];
  const entities = new Map<string, HostEntity>();
  // Sequential, not parallel: a page of 25 is one call, and a larger list is rare.
  for (let i = 0; i < unique.length; i += RESOLVE_BATCH) {
    const batch = await resolveBatch(host, authorization, unique.slice(i, i + RESOLVE_BATCH), options.timeoutMs ?? RESOLVE_TIMEOUT_MS);
    if (!batch) return { state: "unavailable" };
    for (const [id, entity] of batch) entities.set(id, entity);
  }
  return { state: "ok", entities };
}

// ─── sendNotice ─────────────────────────────────────────────────────────────

const noticeAnswer = z.object({ applied: z.boolean() });
const failed = (code: NoticeFailureCode, permanent: boolean): NoticeResult => ({ state: "failed", permanent, code });

export async function sendNotice(
  host: HostDefinition,
  notice: HostNotice,
  tokens: ServiceTokenProvider | null,
  options: ClientOptions = {},
): Promise<NoticeResult> {
  const label = hostLabel(host);
  if (!host.notices) return failed("notices_not_supported", true);
  if (!tokens) {
    console.warn(`[hosts] notice not sent host=${label} reason=no_service_credential`);
    return failed("unavailable", false);
  }

  // Exactly the contract's keys: the host answers 422 to any other.
  const body = JSON.stringify({
    noticeId: notice.noticeId,
    seq: notice.seq,
    event: notice.event,
    meeting: {
      id: notice.meeting.id,
      title: notice.meeting.title,
      startsAt: notice.meeting.startsAt,
      creatorId: notice.meeting.creatorId,
    },
    entity: { type: notice.entity.type, id: notice.entity.id },
  });
  const timeoutMs = options.timeoutMs ?? NOTICE_TIMEOUT_MS;

  try {
    for (let attempt = 0; ; attempt++) {
      const token = await tokens.getToken();
      const res = await globalThis.fetch(`${host.baseUrl}/system/meeting-host/v1/notices`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });

      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        if (attempt === 0) {
          tokens.invalidate(token);
          continue;
        }
        console.warn(`[hosts] notice refused host=${label} reason=unauthorized`);
        return failed("unauthorized", false);
      }

      if (res.ok) {
        const answer = noticeAnswer.safeParse(await res.json().catch(() => null));
        if (!answer.success) {
          console.warn(`[hosts] notice answer unreadable host=${label}`);
          return failed("malformed", false);
        }
        return { state: "delivered", applied: answer.data.applied };
      }

      if (res.status === 422) {
        // `entity_not_found` is permanent by contract; any other 422 means the body itself is refused.
        const code = ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code;
        return failed(code === "entity_not_found" ? "entity_not_found" : "rejected", true);
      }
      await res.body?.cancel().catch(() => {});
      console.warn(`[hosts] notice failed host=${label} reason=http_${res.status}`);
      // 5xx is an outage; any other refusal (403 scope, 404, 429) can be fixed by an operator, so it stays retryable.
      return failed(res.status >= 500 ? "unavailable" : "rejected", false);
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    // Our own ServiceTokenError (status only) or the runtime's fetch error: neither holds a secret or a token.
    console.warn(`[hosts] notice not delivered host=${label} reason=${timedOut ? "timeout" : "transport"}`);
    return failed(timedOut ? "timeout" : "unavailable", false);
  }
}
