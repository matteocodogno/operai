/**
 * Shared "resolve the live setting, send the compilation email, record the
 * outcome" helper (T5, specs/008-refund-monthly-processing, plan.md §
 * Email, ADR-0021; LIVE-resolution + blocked-send widened by T4,
 * specs/011-refund-settings, plan.md D5/D6, ADR-0029).
 *
 * ONE function backs BOTH triggers that must send this email: the
 * auto-send hook at the end of `POST /batches`' compile handler
 * (batches.routes.ts) and the manual resend route, `POST
 * /batches/:id/email` (batches.routes.ts) — so "how the email is sent" and
 * "how its outcome is persisted" can never drift between the two call
 * sites (AC-3.1/3.3 both go through the exact same path).
 *
 * ADR-0021's per-batch compile-time `recipientEmailSnapshot` FREEZE is
 * SUPERSEDED (ADR-0029, D6): this function resolves the LIVE
 * `accounting-distribution-email` refund_setting (src/settings/) at EVERY
 * attempt, never a value baked in at a previous deploy or a previous send
 * (AC-2.3). Unconfigured (the setting has no value) → the email is NOT
 * attempted at all — `notifyBatchCompiled` is never called — and the
 * outcome is `"blocked_unconfigured"` (AC-2.2). The caller (batches.routes.ts)
 * decides how to surface that: compile never fails on it (AC-2.1), a resend
 * turns it into a 422 (D5).
 *
 * NEVER throws (best-effort, ADR-0011 posture) — a compile or resend
 * request must always complete regardless of notify-api's (or the settings
 * repo's) availability. `notifyBatchCompiled` (lib/notifyEmail.ts) already
 * never throws; the outer try/catch here is deliberate defense-in-depth,
 * mirroring `review/decide.routes.ts`'s `notifyDecisionBestEffort` wrapper
 * around the already-non-throwing `notifyDecision`.
 */

import { Effect } from "effect";
import { notifyBatchCompiled } from "../lib/notifyEmail";
import { recordEmailAttempt, type EmailAttemptOutcome } from "./batches.repo";
import { fetchCurrentSettingValue } from "../settings/repo";
import { ACCOUNTING_DISTRIBUTION_EMAIL_KEY } from "../settings/registry";

export interface CompilationEmailBatch {
  readonly id: string;
  readonly cutoff: Date;
  readonly createdAt: Date;
}

export type CompilationEmailOutcome = EmailAttemptOutcome;

export async function sendCompilationEmailBestEffort(
  batch: CompilationEmailBatch,
  requestCount: number,
): Promise<CompilationEmailOutcome> {
  try {
    // Resolve the LIVE setting value at THIS attempt (D6) — never a value
    // baked in at a previous deploy/send. A database failure here is
    // treated the same as "unconfigured" (fail toward the distinguishable,
    // safe-refusal outcome rather than risking a silent misdirection).
    const settingExit = await Effect.runPromiseExit(
      fetchCurrentSettingValue(ACCOUNTING_DISTRIBUTION_EMAIL_KEY),
    );
    const recipientEmail = settingExit._tag === "Success" ? settingExit.value : null;

    if (recipientEmail === null) {
      const outcome: CompilationEmailOutcome = {
        status: "blocked_unconfigured",
        deliveryId: null,
        recipientEmail: null,
      };
      try {
        await Effect.runPromise(recordEmailAttempt(batch.id, outcome));
      } catch (error) {
        console.error(
          `[batches] failed to record blocked_unconfigured email status for batch ${batch.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
      return outcome;
    }

    const sendOutcome = await notifyBatchCompiled({
      batchId: batch.id,
      batchReference: batch.id,
      cutoff: batch.cutoff,
      generatedAt: batch.createdAt,
      requestCount,
      recipientEmail,
    });

    const outcome: CompilationEmailOutcome = {
      status: sendOutcome.status,
      deliveryId: sendOutcome.deliveryId,
      recipientEmail,
    };

    try {
      await Effect.runPromise(recordEmailAttempt(batch.id, outcome));
    } catch (error) {
      console.error(
        `[batches] failed to record email delivery status for batch ${batch.id} ` +
          "— the email was still attempted:",
        error instanceof Error ? error.message : error,
      );
    }

    return outcome;
  } catch (error) {
    console.error(
      `[batches] sendCompilationEmailBestEffort failed unexpectedly for batch ${batch.id}:`,
      error instanceof Error ? error.message : error,
    );
    return { status: "failed", deliveryId: null, recipientEmail: null };
  }
}
