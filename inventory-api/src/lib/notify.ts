/**
 * Assignment notifications (T17, specs/015-hardware-inventory; AC-2.8, AC-2.9;
 * ADR-0044). The after-commit fill for `assignmentHooks.afterCommit`:
 *
 *   created    -> the ASSIGNEE: "A device is waiting for your confirmation",
 *                 linking to `/devices`;
 *   confirmed  -> the MANAGER who created it: "Assignment confirmed";
 *   declined   -> the MANAGER: "Assignment declined ... back in stock",
 *                 both linking to `/inventory/assets/{id}`.
 *
 * Calls notify-api's `POST /system/notifications` authenticated with the scoped
 * service JWT from `serviceToken.ts` (`Authorization: Bearer`, scope
 * `notifications.push`; ADR-0044/0049). notify-api binds `system:inventory-api` to
 * `originApp: "inventory"`.
 *
 * STRICTLY BEST-EFFORT (same posture as refund-api's `notifyDecision`, ADR-0017
 * §4): `notifyAssignment` never throws. Whatever goes wrong — no token, a
 * timeout, a 5xx, a refused request — is logged (status/outcome and ids only:
 * never a token, the secret, a response body, or the description) and
 * swallowed. The assignment in this service's own database is authoritative.
 * The caller does not await it (`runAfterCommit`), so it can delay nothing.
 *
 * One 401 from notify-api drops the cached token and retries ONCE with a fresh
 * one (a token revoked, rotated or clock-skewed out from under the cache);
 * a second 401 is a configuration fault and is logged, not looped on.
 *
 * Copy is English only (spec non-goal "Italian copy at launch") and carries no
 * money figure. The description is user-entered, so it is clipped to keep the
 * title/body inside notify-api's 200/2000-character limits.
 */

import type { AssignmentEvent } from "../assignments/assignments.schemas";
import { env } from "./env";
import { serviceTokens, type ServiceTokenProvider } from "./serviceToken";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_DESCRIPTION = 200;
const MAX_NAME = 100;

/** What the seam hands over, plus the confirming employee's display name when the route knows it. */
export type NotifiableAssignmentEvent = AssignmentEvent;

interface Copy {
  readonly recipientId: string;
  readonly severity: "info" | "success" | "warning";
  readonly title: string;
  readonly body: string;
  readonly href: string;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function compose(event: NotifiableAssignmentEvent): Copy {
  const description = clip(event.assetDescription, MAX_DESCRIPTION);
  const who = clip(event.assigneeName?.trim() || "The employee", MAX_NAME);
  const assetHref = `/inventory/assets/${encodeURIComponent(event.assetId)}`;
  switch (event.kind) {
    case "created":
      return {
        recipientId: event.assigneeUserId,
        severity: "info",
        title: "A device is waiting for your confirmation",
        body: `${description} has been assigned to you. Confirm that you received it.`,
        href: "/devices",
      };
    case "confirmed":
      return {
        recipientId: event.createdByUserId,
        severity: "success",
        title: "Assignment confirmed",
        body: `${who} confirmed receipt of ${description}.`,
        href: assetHref,
      };
    case "declined":
      return {
        recipientId: event.createdByUserId,
        severity: "warning",
        title: "Assignment declined",
        body: `${who} declined ${description}. It is back in stock.`,
        href: assetHref,
      };
  }
}

export interface NotifierOptions {
  readonly baseUrl: string;
  readonly tokens: ServiceTokenProvider;
  /** Looked up per call (default: the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** `false` makes every call a silent no-op (the default instance in the test process). */
  readonly enabled?: boolean;
}

export interface Notifier {
  /** Never throws, never rejects. */
  notifyAssignment(event: NotifiableAssignmentEvent): Promise<void>;
}

export function createNotifier(options: NotifierOptions): Notifier {
  const enabled = options.enabled ?? true;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function post(token: string, copy: Copy): Promise<Response> {
    const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    return doFetch(`${options.baseUrl}/system/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        recipientId: copy.recipientId,
        originApp: "inventory",
        severity: copy.severity,
        title: copy.title,
        body: copy.body,
        link: { href: copy.href },
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  }

  return {
    async notifyAssignment(event) {
      if (!enabled) return;
      const ref = `${event.kind} assignment ${event.assignmentId}`;
      try {
        const copy = compose(event);
        for (let attempt = 0; ; attempt++) {
          const token = await options.tokens.getToken();
          const res = await post(token, copy);
          await res.body?.cancel().catch(() => {});
          if (res.status === 401 && attempt === 0) {
            options.tokens.invalidate(token);
            continue;
          }
          if (!res.ok) {
            console.error(`[notify] notify-api answered HTTP ${res.status} for ${ref} — assignment NOT rolled back`);
          }
          return;
        }
      } catch (error) {
        // Messages here come from our own ServiceTokenError (status only) or the
        // runtime's fetch error; neither can contain the secret or a token.
        console.error(
          `[notify] could not push ${ref} — assignment NOT rolled back:`,
          error instanceof Error ? error.message : "unknown error",
        );
      }
    },
  };
}

/**
 * The instance wired from the environment. Disabled under `NODE_ENV=test`:
 * `bun test` shares one process and its env often holds a developer's real
 * `SERVICE_CLIENT_*`, so an enabled default would push real notifications to a
 * real notify-api for every assignment any route test creates. Tests of the
 * push build their own notifier with a stubbed network (notify.test.ts).
 */
export const notifier: Notifier = createNotifier({
  baseUrl: env.NOTIFY_INTERNAL_URL,
  tokens: serviceTokens,
  enabled: env.NODE_ENV !== "test",
});
