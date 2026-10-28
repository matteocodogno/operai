/**
 * estimai-api → notify-api internal cross-user in-app push client (T5/T10,
 * specs/013-estimate-sharing, plan.md "Notifications (US-7) — the third
 * internal caller", ADR-0017, ADR-0040).
 *
 * A VERBATIM-CONTRACT reuse of `refund-api/src/lib/notify.ts`: isolated in
 * its own single-function-per-concern module (so `collaborators.routes.ts`
 * and its tests can `mock.module()` this file rather than mocking global
 * `fetch`), and this module NEVER THROWS. Calls the internal, NON-user-JWT
 * `POST /system/notifications` (ADR-0017), authenticated as estimai-api
 * itself with the scoped 5-minute service JWT from `serviceToken.ts`
 * (`Authorization: Bearer`, scope `notifications.push`; specs/016, ADR-0044/
 * ADR-0049, which retired the shared internal token) — deliberately NOT the
 * granting/revoking owner's own Bearer JWT, because the recipient is a
 * DIFFERENT user (the collaborator), not the caller. notify-api binds
 * `system:estimai-api` to `originApp: "estimai"`.
 *
 * One 401 from notify-api drops the cached token and retries ONCE with a fresh
 * one; a second 401 is a configuration fault, logged and not looped on. Any
 * token failure (auth down, refused, rate-limited) is logged — status only,
 * never a token or the secret — and swallowed like any other failed push.
 *
 * BEST-EFFORT: every failure path (non-2xx response or network error) is
 * caught and logged — no PII beyond ids in the log line — and resolves
 * normally. Callers (collaborators.routes.ts) MUST await this AFTER their
 * own grant/removal transaction has already committed, and must never let a
 * notify failure roll back or fail the HTTP response (AC-7.1's push is
 * additive — the collaborator sees the estimate on their next list load
 * regardless of delivery, plan.md R6).
 *
 * Copy is English-only (mirrors specs/007's i18n-for-v1 decision — see
 * `estimai-ui/src/strings.ts`'s doc comment, T14, for the same call made on
 * the frontend side).
 */

import { env } from "./env";
import { serviceTokens, type ServiceTokenProvider } from "./serviceToken";

const REQUEST_TIMEOUT_MS = 5_000;

export type EstimateAccessLevel = "viewer" | "editor";

// Estimate names can carry a client's name (plan.md R9 — "a deliberate,
// recorded widening of what leaves estimai-api"); truncated before it ever
// reaches notify-api's database.
const MAX_ESTIMATE_NAME_CHARS = 120;

const truncateEstimateName = (name: string): string =>
  name.length > MAX_ESTIMATE_NAME_CHARS
    ? `${name.slice(0, MAX_ESTIMATE_NAME_CHARS)}…`
    : name;

interface NotificationPayload {
  readonly recipientId: string;
  readonly originApp: "estimai";
  readonly severity: "info";
  readonly title: string;
  readonly body: string;
  readonly link?: { readonly href: string };
}

export interface CollaboratorNotifierOptions {
  readonly baseUrl: string;
  readonly tokens: ServiceTokenProvider;
  /** Looked up per call (default: the global `fetch`) so a spied global is honoured. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

// ─── Granted (AC-7.1) ───────────────────────────────────────────────────────

export interface NotifyCollaboratorGrantedInput {
  readonly recipientId: string;
  readonly estimateId: string;
  readonly estimateName: string;
  readonly accessLevel: EstimateAccessLevel;
}

const LEVEL_LABEL: Record<EstimateAccessLevel, string> = {
  viewer: "view",
  editor: "edit",
};

// ─── Owner-initiated removal (AC-7.2) ──────────────────────────────────────

export interface NotifyCollaboratorRemovedInput {
  readonly recipientId: string;
  readonly estimateId: string;
  readonly estimateName: string;
}

export interface CollaboratorNotifier {
  /**
   * Fired once, AFTER the collaborator grant transaction commits
   * (`POST /estimates/{id}/collaborators`). Never fired for `PATCH` level
   * changes (AC-7.3). Never throws — see file header.
   */
  notifyCollaboratorGranted(input: NotifyCollaboratorGrantedInput): Promise<void>;
  /**
   * Fired once, AFTER the removal commits, ONLY when the OWNER removed the
   * collaborator (`DELETE /estimates/{id}/collaborators/{collaboratorId}`).
   * Deliberately carries NO link — the target would 404 on the estimate the
   * moment they open it (plan.md: "the target would 404"). Self-leave
   * (`DELETE /estimates/{id}/collaborators/me`) sends nothing at all — the
   * caller (collaborators.routes.ts) must not invoke this for that path.
   * Never throws — see file header.
   */
  notifyCollaboratorRemoved(input: NotifyCollaboratorRemovedInput): Promise<void>;
}

export function createCollaboratorNotifier(options: CollaboratorNotifierOptions): CollaboratorNotifier {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  function post(token: string, payload: NotificationPayload): Promise<Response> {
    const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    return doFetch(`${options.baseUrl}/system/notifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      // The request carries a credential; a redirect would replay it elsewhere.
      redirect: "error",
    });
  }

  async function postSystemNotification(payload: NotificationPayload, logContext: string): Promise<void> {
    try {
      for (let attempt = 0; ; attempt++) {
        const token = await options.tokens.getToken();
        const response = await post(token, payload);
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 && attempt === 0) {
          options.tokens.invalidate(token);
          continue;
        }
        if (!response.ok) {
          console.error(
            `[notify] POST /system/notifications responded with HTTP ${response.status} ` +
              `for ${logContext} — the estimai-api change was NOT rolled back`,
          );
        }
        return;
      }
    } catch (error) {
      // Messages here come from our own ServiceTokenError (status only) or the
      // runtime's fetch error; neither can contain the secret or a token.
      console.error(
        `[notify] failed to push ${logContext} — the estimai-api change was NOT rolled back:`,
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }

  return {
    async notifyCollaboratorGranted(input) {
      const name = truncateEstimateName(input.estimateName);

      await postSystemNotification(
        {
          recipientId: input.recipientId,
          originApp: "estimai",
          severity: "info",
          title: "You've been added to an estimate",
          body: `You now have ${LEVEL_LABEL[input.accessLevel]} access to "${name}".`,
          link: { href: `/estimai/estimates/${input.estimateId}` },
        },
        `estimate ${input.estimateId} (collaborator granted)`,
      );
    },

    async notifyCollaboratorRemoved(input) {
      const name = truncateEstimateName(input.estimateName);

      await postSystemNotification(
        {
          recipientId: input.recipientId,
          originApp: "estimai",
          severity: "info",
          title: "You've been removed from an estimate",
          body: `You no longer have access to "${name}".`,
        },
        `estimate ${input.estimateId} (collaborator removed)`,
      );
    },
  };
}

/**
 * The instance wired from the environment. Under `NODE_ENV=test` its token
 * provider is the disabled one (serviceToken.ts), so a route test can never
 * push to a real notify-api; it fails the token step, which is logged and
 * swallowed like any other failed push. Tests of the push build their own
 * notifier with stubs (notify.test.ts).
 */
const defaultNotifier = createCollaboratorNotifier({
  baseUrl: env.NOTIFY_INTERNAL_URL,
  tokens: serviceTokens,
});

export const notifyCollaboratorGranted: CollaboratorNotifier["notifyCollaboratorGranted"] = (input) =>
  defaultNotifier.notifyCollaboratorGranted(input);

export const notifyCollaboratorRemoved: CollaboratorNotifier["notifyCollaboratorRemoved"] = (input) =>
  defaultNotifier.notifyCollaboratorRemoved(input);
