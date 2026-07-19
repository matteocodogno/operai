/**
 * Shared "send the compilation email, record the outcome" helper (T5,
 * specs/008-refund-monthly-processing, plan.md § Email, ADR-0021).
 *
 * ONE function backs BOTH triggers that must send this email: the
 * auto-send hook at the end of `POST /batches`' compile handler
 * (batches.routes.ts) and the manual resend route, `POST
 * /batches/:id/email` (batches.routes.ts) — so "how the email is sent" and
 * "how its outcome is persisted" can never drift between the two call
 * sites (AC-3.1/3.3 both go through the exact same path).
 *
 * NEVER throws (best-effort, ADR-0011 posture) — a compile or resend
 * request must always complete regardless of notify-api's availability
 * (AC-3.1/4.2). `notifyBatchCompiled` (lib/notifyEmail.ts) already never
 * throws; the outer try/catch here is deliberate defense-in-depth,
 * mirroring `review/decide.routes.ts`'s `notifyDecisionBestEffort` wrapper
 * around the already-non-throwing `notifyDecision`.
 */

import { Effect } from "effect";
import { notifyBatchCompiled } from "../lib/notifyEmail";
import { recordEmailAttempt } from "./batches.repo";

export interface CompilationEmailBatch {
  readonly id: string;
  readonly cutoff: Date;
  readonly createdAt: Date;
  /** The address snapshotted at compile time (AC-3.4) — resend reuses this SAME value, never the live env var. */
  readonly recipientEmailSnapshot: string;
}

export interface CompilationEmailOutcome {
  readonly status: "sent" | "failed";
  readonly deliveryId: string | null;
}

export async function sendCompilationEmailBestEffort(
  batch: CompilationEmailBatch,
  requestCount: number,
): Promise<CompilationEmailOutcome> {
  try {
    const outcome = await notifyBatchCompiled({
      batchId: batch.id,
      batchReference: batch.id,
      cutoff: batch.cutoff,
      generatedAt: batch.createdAt,
      requestCount,
      recipientEmail: batch.recipientEmailSnapshot,
    });

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
    return { status: "failed", deliveryId: null };
  }
}
