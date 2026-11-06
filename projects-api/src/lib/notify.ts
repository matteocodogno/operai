/**
 * The after-take notification (specs/022 T25; AC-4.3, AC-4.4): one in-app push to the purchase order's
 * ops-manager through notify-api's `POST /system/notifications`, authenticated with the scoped service
 * JWT from `serviceToken.ts` (`notifications.push`). notify-api binds `system:projects-api` to
 * `originApp: "projects"`. The pattern is crm-api's `src/lib/notify.ts`, cut down to one event and one
 * recipient.
 *
 * STRICTLY BEST-EFFORT: nothing here throws, and the route never awaits the delivery — the project and
 * its purchase order in this service's own database are authoritative, and a notification that cannot be
 * delivered leaves the project awaiting its project manager all the same (AC-4.4). Whatever goes wrong
 * is logged as the event kind, the project id and an HTTP status or an error name only: never a token,
 * a title, a project or company name, the recipient, or any contact data (T18).
 *
 * - One 401 drops the cached token and retries ONCE with a fresh one.
 * - A no-op when `NOTIFY_INTERNAL_URL` or the service credential is absent (logged once at startup), and
 *   under `NODE_ENV=test` unless a test injects a notifier (`setNotifierForTests`).
 *
 * Copy is English only (D51). The project and company names are user-entered or CRM data, so they are
 * clipped to keep title and body inside notify-api's 200 / 2000-character limits.
 */

import { env } from "./env";
import { ServiceTokenError, serviceTokens, type ServiceTokenProvider } from "./serviceToken";

const REQUEST_TIMEOUT_MS = 5_000;

export type NotifySeverity = "info" | "success" | "warning";

export interface NotifyEvent {
  /** Event kind, for the log. */
  readonly kind: string;
  /** The project the event is about, for the log. */
  readonly projectId: string;
  readonly recipientId: string;
  readonly severity: NotifySeverity;
  readonly title: string;
  readonly body: string;
  /** A relative in-suite path: notify-api refuses anything else. */
  readonly href: string;
}

export interface Notifier {
  /** Never throws, never rejects. */
  notify(event: NotifyEvent): Promise<void>;
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

  const post = (token: string, event: NotifyEvent): Promise<Response> => {
    const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    return doFetch(`${options.baseUrl}/system/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        recipientId: event.recipientId,
        originApp: "projects",
        severity: event.severity,
        title: event.title,
        body: event.body,
        link: { href: event.href },
      }),
      signal: AbortSignal.timeout(timeoutMs),
      // The request carries the service credential: a redirect would replay it to another host.
      redirect: "error",
    });
  };

  return {
    async notify(event) {
      const ref = `${event.kind} project=${event.projectId}`;
      try {
        for (let attempt = 0; ; attempt++) {
          const token = await options.tokens.getToken();
          const res = await post(token, event);
          await res.body?.cancel().catch(() => {});
          if (res.status === 401 && attempt === 0) {
            options.tokens.invalidate(token);
            continue;
          }
          if (!res.ok) console.error(`[notify] notify-api answered HTTP ${res.status} for ${ref} — take NOT rolled back`);
          return;
        }
      } catch (error) {
        // A ServiceTokenError names an HTTP status only; any other error is logged by name, since a
        // runtime's message may carry the URL or a header.
        const reason = error instanceof ServiceTokenError ? error.message : error instanceof Error ? error.name : "unknown error";
        console.error(`[notify] could not push ${ref} — take NOT rolled back: ${reason}`);
      }
    },
  };
}

// ─── The wired instance ──────────────────────────────────────────────────────

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The notifier the environment asks for, or `null` (a no-op): outside the test environment, with
 * `NOTIFY_INTERNAL_URL` set and the service credential configured. Under `NODE_ENV=test` it is always
 * `null`: `bun test` shares one process and a developer's env may hold real values, so a route test must
 * never push for real. A test of the push injects its own notifier (`setNotifierForTests`).
 */
export function notifierFromEnv(
  settings: { readonly NODE_ENV: string; readonly NOTIFY_INTERNAL_URL?: string | undefined },
  tokens: ServiceTokenProvider | null,
): Notifier | null {
  if (settings.NODE_ENV === "test" || !settings.NOTIFY_INTERNAL_URL || !tokens) return null;
  return createNotifier({ baseUrl: settings.NOTIFY_INTERNAL_URL, tokens });
}

/** `undefined`: ask the environment; otherwise what a test injected (`null` = nobody to push). */
let injected: Notifier | null | undefined;

/** Tests only: swap in a notifier (or `null` for the no-op). */
export function setNotifierForTests(notifier: Notifier | null): void {
  injected = notifier;
}

/** Tests only: back to asking the environment (which is nobody under `NODE_ENV=test`). */
export function resetNotifierForTests(): void {
  injected = undefined;
}

const current = (): Notifier | null => (injected !== undefined ? injected : notifierFromEnv(env, serviceTokens));

if (env.NODE_ENV !== "test" && current() === null) {
  console.log("[notify] NOTIFY_INTERNAL_URL / SERVICE_CLIENT_* not set — notifications are disabled");
}

// ─── The one event ───────────────────────────────────────────────────────────

const TITLE_PREFIX = "Purchase order assigned: ";
const BODY_SUFFIX = " — pick the project manager of this project.";
// notify-api's limits (`SystemNotificationRequestSchema`): title 200, body 2000 characters.
const MAX_TITLE = 200;
const MAX_BODY = 2000;

export interface PurchaseOrderAssigned {
  readonly projectId: string;
  /** User-entered: clipped. */
  readonly projectName: string;
  /** From the CRM: clipped. */
  readonly companyName: string;
  /** The `auth` user the purchase order is assigned to: the only person told (AC-4.3). */
  readonly opsManagerId: string;
}

/**
 * Tells the purchase order's ops-manager that a project is waiting for its project manager (AC-4.3).
 * Called AFTER the take has committed, fire-and-forget: it returns at once, never throws, and a delivery
 * that fails, times out or never happens changes nothing about the take (AC-4.4). English only (D51).
 */
export function announcePurchaseOrderAssigned(order: PurchaseOrderAssigned): void {
  try {
    const notifier = current();
    if (!notifier) return;
    const event: NotifyEvent = {
      kind: "purchase_order_assigned",
      projectId: order.projectId,
      recipientId: order.opsManagerId,
      severity: "info",
      title: `${TITLE_PREFIX}${clip(order.projectName, MAX_TITLE - TITLE_PREFIX.length)}`,
      body: `${clip(order.companyName, MAX_BODY - BODY_SUFFIX.length)}${BODY_SUFFIX}`,
      href: `/projects/${order.projectId}`,
    };
    void notifier.notify(event).catch(() => {});
  } catch {
    // Best-effort: the notifier logs its own failures, by kind and project id only.
  }
}
