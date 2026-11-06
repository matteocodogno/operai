/**
 * Meetings notifications (specs/021-meetings AC-12.1 to AC-12.5; ADR-0049,
 * ADR-0065). The after-commit, best-effort push to notify-api's
 * `POST /system/notifications`, authenticated with the scoped service JWT from
 * `serviceToken.ts` (`notifications.push`). notify-api binds
 * `system:meetings-api` to `originApp: "meetings"`.
 *
 * - IN-APP ONLY (AC-12.4): the payload is built here from an allowlist of keys and
 *   there is no `email` field to set, so no code path can ask for an email.
 * - BILINGUAL (AC-12.5): English `title`/`body` plus the `it` variant, from
 *   `notificationCopy.ts`.
 * - CONTENT-FREE: the event carries the meeting TITLE and an id; the copy catalog
 *   takes nothing else, so transcript, summary and answer text cannot get in.
 * - STRICTLY BEST-EFFORT (AC-12.3, crm-api's pattern): nothing here throws, and a
 *   route never awaits delivery; the meeting action stands whatever notify-api does.
 *   Failures are logged as the event kind, the meeting id and an HTTP status or error
 *   name only: never a token, the secret or a title.
 * - One request per distinct recipient; the actor is never notified. One 401 drops
 *   the cached token and retries ONCE with a fresh one.
 * - A no-op when the env group is absent (logged once at startup), and under
 *   `NODE_ENV=test` unless a test injects a notifier (`setNotifierForTests`).
 */

import { env } from "./env";
import { renderNotification, type NotificationKind } from "./notificationCopy";
import { serviceTokens, type ServiceTokenProvider } from "./serviceToken";

const REQUEST_TIMEOUT_MS = 5_000;

/** What a route hands over: which event, about which meeting, who did it, who to tell. */
export interface NotifyEvent {
  readonly kind: NotificationKind;
  readonly meetingId: string;
  /** Clipped by the copy catalog; shown to the recipient, never logged. */
  readonly meetingTitle: string;
  /** The person who caused the event; never notified of their own action. */
  readonly actorId: string;
  readonly recipientIds: readonly (string | null | undefined)[];
}

export interface Notifier {
  /** Never throws, never rejects. */
  notify(event: NotifyEvent): Promise<void>;
}

/** Every notification links to the route that works for every visibility class (plan.md § Shape). */
export const notificationLink = (meetingId: string): string => `/my-meetings/m/${meetingId}`;

/** The distinct recipients, without the actor and without empty ids. */
export function recipientsOf(event: Pick<NotifyEvent, "actorId" | "recipientIds">): string[] {
  const out = new Set<string>();
  for (const id of event.recipientIds) if (id && id !== event.actorId) out.add(id);
  return [...out];
}

export interface NotifierOptions {
  readonly baseUrl: string;
  readonly tokens: ServiceTokenProvider;
  /** Looked up per call (default: the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createNotifier(options: NotifierOptions): Notifier {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function post(token: string, recipientId: string, event: NotifyEvent): Promise<Response> {
    const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    const text = renderNotification(event.kind, event.meetingTitle);
    // The allowlist: these keys and no others (AC-12.4). There is no `email`.
    const payload = {
      recipientId,
      originApp: "meetings",
      severity: text.severity,
      title: text.title,
      body: text.body,
      link: { href: notificationLink(event.meetingId) },
      it: { title: text.it.title, body: text.it.body },
    };
    return doFetch(`${options.baseUrl}/system/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  }

  async function pushOne(recipientId: string, event: NotifyEvent): Promise<void> {
    const ref = `${event.kind} meeting=${event.meetingId}`;
    try {
      for (let attempt = 0; ; attempt++) {
        const token = await options.tokens.getToken();
        const res = await post(token, recipientId, event);
        await res.body?.cancel().catch(() => {});
        if (res.status === 401 && attempt === 0) {
          options.tokens.invalidate(token);
          continue;
        }
        if (!res.ok) console.error(`[notify] notify-api answered HTTP ${res.status} for ${ref}: action NOT rolled back`);
        return;
      }
    } catch (error) {
      // Messages come from our own ServiceTokenError (status only) or the runtime's
      // fetch error; neither can contain the secret or a token.
      console.error(
        `[notify] could not push ${ref}: action NOT rolled back:`,
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }

  return {
    async notify(event) {
      try {
        await Promise.all(recipientsOf(event).map((id) => pushOne(id, event)));
      } catch {
        // pushOne already catches; this is the belt to its braces.
      }
    },
  };
}

// ─── The wired instance ──────────────────────────────────────────────────────

const noop: Notifier = { async notify() {} };

/**
 * From the environment; a no-op when the group is absent. Disabled under
 * `NODE_ENV=test` too: `bun test` shares one process and a developer's env may hold
 * real `SERVICE_CLIENT_*`, so route tests must never push for real. Tests of the push
 * build their own notifier over a stubbed network.
 */
let current: Notifier =
  env.NODE_ENV !== "test" && env.NOTIFY_INTERNAL_URL && serviceTokens
    ? createNotifier({ baseUrl: env.NOTIFY_INTERNAL_URL, tokens: serviceTokens })
    : noop;

if (env.NODE_ENV !== "test" && current === noop) {
  console.log("[notify] NOTIFY_INTERNAL_URL / SERVICE_CLIENT_* not set: notifications are disabled");
}

/** Tests only: swap in a recording notifier (or `null` for the no-op). */
export function setNotifierForTests(notifier: Notifier | null): void {
  current = notifier ?? noop;
}

/**
 * Fire-and-forget, called AFTER the commit: hands the event to the notifier
 * without awaiting delivery. Never throws, never rejects.
 */
export function announce(event: NotifyEvent): void {
  try {
    void current.notify(event).catch(() => {});
  } catch (error) {
    console.error(`[notify] could not prepare ${event.kind}: action NOT rolled back:`, error instanceof Error ? error.message : "unknown error");
  }
}
