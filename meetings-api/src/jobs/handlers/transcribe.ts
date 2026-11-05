/**
 * The `transcribe` job (specs/021-meetings T32; plan.md § Processing, § AI providers; ADR-0061,
 * ADR-0062; AC-6.1, AC-6.7, AC-6.9, AC-6.10, AC-12.2, AC-13.2).
 *
 * Takes `audio.ogg` (put there by `prepare_audio`), sends it to the transcriber with the
 * meeting's OWN locale (chosen by its creator, never detected) and writes the outcome:
 *
 *   segments  -> `ready`, the segments stored in ONE transaction with the status change
 *   noSpeech  -> `ready` + `noSpeech`, no segments (AC-6.7)
 *   an error  -> `failed` + a closed code, no segments ever (AC-6.9)
 *
 * The stage moves `preparing` -> `transcribing` first (AC-6.10).
 *
 * GUARDS. Every write goes through `ctx.commit`, which re-checks that this claim still holds
 * the job, and is `WHERE status = 'processing'`: a handler that stalled past its lease, a
 * meeting deleted meanwhile, or a result arriving after a retry took over all write nothing and
 * notify nobody. A lost lease (`ctx.signal` aborted) is never the meeting's failure.
 *
 * RETRIES. A transient provider error (429/5xx/timeout) or an unforeseen one is the runner's to
 * retry with backoff; the meeting stays `processing` until the LAST attempt, which fails it. A
 * permanent one (refusal, audio the provider cannot read) fails at once. Idempotent: segments
 * are replaced, never appended to.
 *
 * ONE PUSH, after the commit, to whoever asked (`processingRequestedBy`): title and outcome only.
 * Logs name codes, never content.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCALE_OF, TranscriptionError, maxSpeakersFor, transcriber as defaultTranscriber, type Transcriber } from "../../ai/transcriber";
import { db as defaultDb } from "../../lib/db";
import type { PrismaClient } from "../../lib/generated/prisma/client";
import { MAX_AUDIO_PUT_BYTES, ObjectTooLargeError, requireStorage, type Storage } from "../../lib/storage";
import { announce as defaultAnnounce, type NotifyEvent } from "../../lib/notify";
import { PermanentJobError, TransientJobError, type JobHandler } from "../runner";
import { announceProcessing } from "./processingNotice";

export interface TranscribeDeps {
  readonly db: PrismaClient;
  readonly transcriber: () => Promise<Transcriber>;
  readonly storage: () => Storage;
  readonly announce: (event: NotifyEvent) => void;
  readonly now: () => Date;
  /** Where the per-job temp dir is made; default the OS temp dir. */
  readonly tmpRoot?: string;
}

export function createTranscribeHandler(overrides: Partial<TranscribeDeps> = {}): JobHandler {
  const deps: TranscribeDeps = { db: defaultDb, transcriber: defaultTranscriber, storage: requireStorage, announce: defaultAnnounce, now: () => new Date(), ...overrides };

  return async (ctx) => {
    const meetingId = ctx.job.meetingId;
    if (!meetingId) throw new PermanentJobError("no_meeting");

    const meeting = await deps.db.meeting.findUnique({
      where: { id: meetingId },
      select: { id: true, title: true, language: true, status: true, audioKey: true, processingRequestedBy: true, creatorUserId: true },
    });
    // Deleted, finished already (the job ran twice), or its audio is gone: nothing to do.
    if (!meeting || meeting.status !== "processing" || meeting.audioKey === null) return;
    const audioKey = meeting.audioKey;

    const staged = await ctx.commit((tx) => tx.meeting.updateMany({ where: { id: meetingId, status: "processing" }, data: { stage: "transcribing" } }));
    if (!staged.committed || staged.value.count === 0) return;

    /** The terminal failure under both guards, then the one push. A stale write is dropped silently. */
    async function fail(code: string): Promise<void> {
      const result = await ctx.commit((tx) =>
        tx.meeting.updateMany({
          where: { id: meetingId!, status: "processing" },
          data: { status: "failed", stage: null, failureCode: code, processedAt: deps.now() },
        }),
      );
      if (result.committed && result.value.count > 0) announceProcessing(deps.announce, meeting!, "transcription_failed");
    }

    const workDir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "meetings-transcribe-"));
    try {
      const file = join(workDir, "audio.ogg");
      await deps.storage().getObjectToFile(audioKey, file, MAX_AUDIO_PUT_BYTES);
      // ~45 MB for 3 h: held in memory for the one request, so no lazy file outlives the temp dir.
      const audio = new Blob([await Bun.file(file).arrayBuffer()], { type: "audio/ogg" });
      const participants = await deps.db.meetingParticipant.count({ where: { meetingId } });

      const outcome = await (await deps.transcriber()).transcribe(audio, LOCALE_OF[meeting.language], maxSpeakersFor(participants), ctx.signal);
      const segments = outcome.kind === "segments" ? outcome.segments : [];

      const result = await ctx.commit(async (tx) => {
        const written = await tx.meeting.updateMany({
          where: { id: meetingId, status: "processing" },
          data: {
            status: "ready",
            stage: null,
            noSpeech: segments.length === 0,
            failureCode: null,
            processedAt: deps.now(),
            transcriptVersion: { increment: 1 },
          },
        });
        if (written.count === 0) return false;
        // Replace, never append: a retried run must not stack on a half-written earlier one.
        await tx.transcriptSegment.deleteMany({ where: { meetingId } });
        if (segments.length > 0) {
          await tx.transcriptSegment.createMany({
            data: segments.map((s) => ({ meetingId, ordinal: s.ordinal, startMs: s.startMs, endMs: s.endMs, speakerKey: s.speakerKey, text: s.text })),
          });
        }
        return true;
      });
      if (result.committed && result.value) announceProcessing(deps.announce, meeting, "transcription_done");
    } catch (error) {
      // A lost lease is not the meeting's failure: whoever re-claims the job decides.
      if (ctx.signal.aborted) throw error;

      const last = ctx.attempt >= ctx.job.maxAttempts;
      if (error instanceof TranscriptionError) {
        if (error.transient && !last) throw new TransientJobError(error.code);
        await fail(error.code);
        throw new PermanentJobError(error.code);
      }
      if (error instanceof ObjectTooLargeError) {
        await fail("audio_unreadable");
        throw new PermanentJobError("audio_unreadable");
      }
      // A storage outage, a database fault, anything unforeseen: worth retrying, then final.
      if (last) {
        console.error("[transcribe] unexpected failure on the last attempt:", error instanceof Error ? error.name : "unknown error");
        await fail("provider_unavailable");
        throw new PermanentJobError("provider_unavailable");
      }
      console.error("[transcribe] transient failure:", error instanceof Error ? error.name : "unknown error");
      throw new TransientJobError("storage_or_unexpected");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}

/** The handler the runner is wired with (`jobs/handlers/index.ts`): the real transcriber, storage and notifier. */
export const transcribe: JobHandler = createTranscribeHandler();
