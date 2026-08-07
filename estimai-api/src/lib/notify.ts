/**
 * estimai-api → notify-api internal cross-user in-app push client (T5/T10,
 * specs/013-estimate-sharing, plan.md "Notifications (US-7) — the third
 * internal caller", ADR-0017, ADR-0040).
 *
 * A VERBATIM-CONTRACT reuse of `refund-api/src/lib/notify.ts`: isolated in
 * its own single-function-per-concern module (so `collaborators.routes.ts`
 * and its tests can `mock.module()` this file rather than mocking global
 * `fetch`), and this module NEVER THROWS. Calls the internal, NON-user-JWT
 * `POST /system/notifications` (ADR-0017), authenticated by the shared
 * `NOTIFY_INTERNAL_TOKEN` (`X-Internal-Token`) — deliberately NOT the
 * granting/revoking owner's own Bearer JWT, because the recipient is a
 * DIFFERENT user (the collaborator), not the caller.
 *
 * estimai-api is the THIRD holder of `NOTIFY_INTERNAL_TOKEN` (plan.md —
 * ADR-0011's "second internal caller" escalation trigger fires again and is
 * again deferred, with a recorded hard stop: a fourth caller or any
 * suspected leak builds ADR-0011's Option C rather than deferring again).
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

async function postSystemNotification(
  payload: NotificationPayload,
  logContext: string,
): Promise<void> {
  try {
    const response = await fetch(
      `${env.NOTIFY_INTERNAL_URL}/system/notifications`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": env.NOTIFY_INTERNAL_TOKEN,
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      console.error(
        `[notify] POST /system/notifications responded with HTTP ${response.status} ` +
          `for ${logContext} — the estimai-api change was NOT rolled back`,
      );
    }
  } catch (error) {
    console.error(
      `[notify] failed to reach notify-api for ${logContext} — the estimai-api ` +
        "change was NOT rolled back:",
      error instanceof Error ? error.message : error,
    );
  }
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

/**
 * Fired once, AFTER the collaborator grant transaction commits
 * (`POST /estimates/{id}/collaborators`). Never fired for `PATCH` level
 * changes (AC-7.3).
 *
 * Never throws — see file header.
 */
export async function notifyCollaboratorGranted(
  input: NotifyCollaboratorGrantedInput,
): Promise<void> {
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
}

// ─── Owner-initiated removal (AC-7.2) ──────────────────────────────────────

export interface NotifyCollaboratorRemovedInput {
  readonly recipientId: string;
  readonly estimateId: string;
  readonly estimateName: string;
}

/**
 * Fired once, AFTER the removal commits, ONLY when the OWNER removed the
 * collaborator (`DELETE /estimates/{id}/collaborators/{collaboratorId}`).
 * Deliberately carries NO link — the target would 404 on the estimate the
 * moment they open it (plan.md: "the target would 404"). Self-leave
 * (`DELETE /estimates/{id}/collaborators/me`) sends nothing at all — the
 * caller (collaborators.routes.ts) must not invoke this for that path.
 *
 * Never throws — see file header.
 */
export async function notifyCollaboratorRemoved(
  input: NotifyCollaboratorRemovedInput,
): Promise<void> {
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
}
