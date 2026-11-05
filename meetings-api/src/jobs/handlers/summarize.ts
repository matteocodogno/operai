/**
 * The `summarize` job (specs/021-meetings T94; plan.md § Summaries; ADR-0062, ADR-0067;
 * AC-7.5, AC-7.6, AC-7.9, AC-7.10).
 *
 * Builds the prompt from the summary's own TEMPLATE SNAPSHOT (not the live template: edits and
 * deletions never reach a summary, AC-7.5) and the CURRENT transcript of its meeting, asks the
 * model, validates the reply (`prompts/summary.ts`) and writes `ready` sections or `failed` + a
 * closed code. The request holds the transcript and the template and nothing else (AC-7.10).
 *
 * TWO GUARDS, kept apart:
 *   - the enqueue-time `attemptId` is THIS handler's guard on its target row: every write is
 *     `WHERE attemptId = <the job's> AND status = 'generating'`, so a Retry (new attemptId) or a
 *     summary deleted meanwhile makes a late result touch nothing;
 *   - the runner's own claim (job id + attempts) is re-checked inside `ctx.commit`, so a handler
 *     that stalled past its lease and was re-claimed elsewhere has its result discarded, not applied.
 * A discarded result notifies nobody.
 *
 * RETRIES. Invalid output (a validator rejection, or a reply that was not the forced tool call) is
 * retried ONCE inside the run and then fails the summary (`invalid_output`): an immediate second
 * sample, not a wait. A provider outage is the runner's to retry with backoff: the handler throws a
 * `TransientJobError` and the summary stays `generating` until the LAST attempt, which fails it
 * (`provider_unavailable`). A refusal (`provider_rejected`) can never succeed and fails at once. No
 * path stores partial text: a summary is `ready` with all its sections, or `failed` with none.
 *
 * ONE PUSH. Exactly one notification, to the author, after the terminal write: the meeting title and
 * the outcome, never the summary (AC-7.6, ADR-0065). It is best-effort and sent AFTER the commit.
 *
 * SPEAKER NAMES. A job has no caller token, so it cannot look an Operai participant's name up
 * (`auth` identities are fetched with the caller's own JWT, ADR-0039). A speaker label is therefore
 * the creator's free text, an external participant's name, or "Speaker n".
 */

import { z } from "zod";
import { LanguageModelError, languageModel, type LanguageModel } from "../../ai/languageModel";
import { buildSummaryRequest, validateSummaryOutput, type RenderedSection, type SummaryInput } from "../../ai/prompts/summary";
import type { PromptSegment } from "../../ai/prompts/transcript";
import { speakerIndexOf } from "../../ai/segments";
import { db as defaultDb } from "../../lib/db";
import type { Prisma, PrismaClient } from "../../lib/generated/prisma/client";
import { announce as defaultAnnounce, type NotifyEvent } from "../../lib/notify";
import { PermanentJobError, TransientJobError, type JobHandler } from "../runner";

/** The closed set of `summary.failureCode` values this job writes. */
export type SummaryFailureCode =
  | "provider_unavailable"
  | "provider_rejected"
  | "invalid_output"
  | "no_transcript"
  | "template_invalid"
  | "internal_error";

/** Not a user: the actor of a job, so the author (who asked) is still notified. */
export const SUMMARY_ACTOR = "system:meetings-api";

/** Invalid output gets this many samples in one run (the original and one retry). */
const OUTPUT_TRIES = 2;

const SnapshotSchema = z.object({
  source: z.enum(["builtin", "shared", "personal"]),
  templateId: z.string(),
  name: z.string(),
  sections: z.array(z.object({ heading: z.string(), instruction: z.string() })).min(1).max(15),
  generalInstructions: z.string().nullable(),
});

export interface SummarizeDeps {
  readonly db: PrismaClient;
  readonly model: () => Promise<LanguageModel>;
  readonly announce: (event: NotifyEvent) => void;
  readonly now: () => Date;
}

/** The segments of a meeting as a prompt sees them. */
async function loadTranscript(
  db: PrismaClient,
  meetingId: string,
  isText: boolean,
): Promise<{ segments: PromptSegment[]; transcriptVersion: number }> {
  // Segment edits and the version bump are separate writes: read until the version holds still.
  for (let attempt = 0; ; attempt++) {
    const before = await db.meeting.findUnique({ where: { id: meetingId }, select: { transcriptVersion: true } });
    const rows = await db.transcriptSegment.findMany({ where: { meetingId }, orderBy: { ordinal: "asc" } });
    const after = await db.meeting.findUnique({ where: { id: meetingId }, select: { transcriptVersion: true } });
    if (!before || !after) return { segments: [], transcriptVersion: 0 };
    if (before.transcriptVersion !== after.transcriptVersion && attempt < 2) continue;

    const labels = new Map<string, string>();
    if (!isText) {
      const named = await db.speakerLabel.findMany({ where: { meetingId }, include: { participant: { select: { externalName: true } } } });
      for (const row of named) {
        const label = row.customLabel?.trim() || row.participant?.externalName?.trim();
        if (label) labels.set(row.speakerKey, label);
      }
    }
    const segments = rows.map(
      (row): PromptSegment => ({
        id: row.id,
        ordinal: row.ordinal,
        startMs: isText ? null : row.startMs,
        speakerLabel: isText || row.speakerKey === null ? null : (labels.get(row.speakerKey) ?? `Speaker ${speakerIndexOf(row.speakerKey) ?? row.speakerKey}`),
        text: row.text,
      }),
    );
    return { segments, transcriptVersion: after.transcriptVersion };
  }
}

export function createSummarizeHandler(overrides: Partial<SummarizeDeps> = {}): JobHandler {
  const deps: SummarizeDeps = { db: defaultDb, model: languageModel, announce: defaultAnnounce, now: () => new Date(), ...overrides };

  return async (ctx) => {
    const summaryId = ctx.job.summaryId;
    const attemptId = ctx.attemptId;
    // A summarize job always names its summary and carries the token of the attempt that enqueued it.
    if (summaryId === null || attemptId === null) throw new PermanentJobError("malformed_job");
    const token: string = attemptId;

    const summary = await deps.db.summary.findUnique({
      where: { id: summaryId },
      include: { meeting: { select: { title: true, source: true } } },
    });
    // Gone, finished already (the job ran twice), or superseded by a Retry: nothing to do.
    if (!summary || summary.status !== "generating" || summary.attemptId !== attemptId) return;

    /** The terminal write under both guards, then the one push. A stale write is dropped silently. */
    async function finish(
      outcome: { status: "ready"; sections: RenderedSection[]; transcriptVersion: number } | { status: "failed"; code: SummaryFailureCode },
    ): Promise<void> {
      const result = await ctx.commit(async (tx) => {
        const written = await tx.summary.updateMany({
          where: { id: summary!.id, attemptId: token, status: "generating" },
          data:
            outcome.status === "ready"
              ? {
                  status: "ready",
                  sections: outcome.sections as unknown as Prisma.InputJsonValue,
                  failureCode: null,
                  transcriptVersion: outcome.transcriptVersion,
                  readyAt: deps.now(),
                }
              : // A generating summary never holds sections, so there is nothing partial to clear.
                { status: "failed", failureCode: outcome.code },
        });
        return written.count;
      });
      if (!result.committed || result.value === 0) return;
      deps.announce({
        kind: outcome.status === "ready" ? "summary_done" : "summary_failed",
        meetingId: summary!.meetingId,
        meetingTitle: summary!.meeting.title,
        actorId: SUMMARY_ACTOR,
        recipientIds: [summary!.authorUserId],
      });
    }

    const template = SnapshotSchema.safeParse(summary.template);
    if (!template.success) return finish({ status: "failed", code: "template_invalid" });

    const { segments, transcriptVersion } = await loadTranscript(deps.db, summary.meetingId, summary.meeting.source === "text");
    if (segments.length === 0) return finish({ status: "failed", code: "no_transcript" });

    const input: SummaryInput = { template: template.data, language: summary.language, segments };
    const { request, schema } = buildSummaryRequest(input);
    const model = await deps.model();
    const lastAttempt = ctx.attempt >= ctx.job.maxAttempts;

    for (let sample = 1; sample <= OUTPUT_TRIES; sample++) {
      try {
        const reply = await model.complete(request, schema, ctx.signal);
        const checked = validateSummaryOutput(reply, input);
        if (checked.ok) return finish({ status: "ready", sections: checked.value, transcriptVersion });
        // A rejected reply is sampled again, once; its reason is not kept (it is never the model's words, but nor is it needed).
      } catch (error) {
        if (error instanceof LanguageModelError) {
          if (error.code === "invalid_output") continue;
          // An outage is the runner's to retry with backoff, until the last attempt.
          if (error.transient && !lastAttempt) throw new TransientJobError(error.code);
          return finish({ status: "failed", code: error.code });
        }
        // Anything else is a bug or a database fault: let the runner retry, and fail the summary only when it stops retrying.
        if (!lastAttempt) throw error;
        return finish({ status: "failed", code: "internal_error" });
      }
    }
    return finish({ status: "failed", code: "invalid_output" });
  };
}

/** The handler the runner is wired with (`jobs/handlers/index.ts`): the real model, database and notifier. */
export const summarize: JobHandler = createSummarizeHandler();
