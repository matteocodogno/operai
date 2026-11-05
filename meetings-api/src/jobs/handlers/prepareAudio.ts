/**
 * `prepare_audio` (specs/021-meetings T30; AC-3.1, AC-2.6, AC-4.4; ADR-0064; ADR-0062).
 *
 * Turns what the creator recorded or uploaded into `meetings/<id>/audio.ogg` and hands
 * over to `transcribe`:
 *
 *   1. streams the stored chunks, or the uploaded original, to a per-job temp dir
 *      (never into memory; byte ceilings are checked from the database BEFORE any read);
 *   2. cuts the chunks into containers and runs the hardened ffmpeg (src/media/normalize.ts);
 *   3. puts `audio.ogg`, then in ONE job-guarded transaction sets `audioKey`,
 *      `audioBytes`, `audioCreatedAt` (the 29-day clock starts here) and enqueues
 *      `transcribe`;
 *   4. deletes the chunk / original OBJECTS (the chunk rows stay: they are the metadata
 *      `recording.lostMs` is computed from) and removes the temp dir in `finally`.
 *
 * Every step is idempotent: audio that is already stored is not rebuilt. A failure that
 * retrying cannot fix marks the meeting `failed` with a closed code and KEEPS the sources
 * so the creator may retry while they last (AC-6.9); a transient one is retried by the
 * runner and fails the meeting only on the last attempt. Logs name codes, never content.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../lib/db";
import { MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES, ObjectTooLargeError, objectKeys, requireStorage, type Storage } from "../../lib/storage";
import { NormalizeError, groupIntoRuns, normalizeAudio, ToolMissingError } from "../../media/normalize";
import { announce as defaultAnnounce, type NotifyEvent } from "../../lib/notify";
import { PermanentJobError, TransientJobError, enqueueJob, type JobContext, type JobHandler } from "../runner";
import { announceProcessing } from "./processingNotice";

/** 3 h at 32 kbit/s is ~43 MB; this is a generous ceiling on the sum of a recording's chunks. */
export const MAX_RECORDING_BYTES = 128 * 1024 * 1024;

type FailureCode = "audio_unreadable" | "too_long" | "provider_unavailable";

export interface PrepareDeps {
  readonly storage?: () => Storage;
  readonly normalize?: typeof normalizeAudio;
  /** Where per-job temp dirs are made; default the OS temp dir. */
  readonly tmpRoot?: string;
  readonly now?: () => Date;
  /** The requester's failure notice (best effort, after the commit). */
  readonly announce?: (event: NotifyEvent) => void;
}

interface Source {
  /** Object keys, in playing order. */
  readonly keys: readonly string[];
  readonly maxBytesEach: number;
  /** Deletes the announcement rows once the objects are gone. */
  readonly cleanupRows: () => Promise<void>;
}

async function loadSource(meetingId: string, source: string): Promise<Source | null> {
  if (source === "uploaded") {
    const upload = await db.meetingUpload.findUnique({ where: { meetingId } });
    if (!upload || upload.sizeBytes > MAX_UPLOAD_BYTES) return null;
    return {
      keys: [upload.objectKey],
      maxBytesEach: MAX_UPLOAD_BYTES,
      cleanupRows: async () => void (await db.meetingUpload.deleteMany({ where: { meetingId } })),
    };
  }
  const chunks = await db.recordingChunk.findMany({
    where: { meetingId, storedAt: { not: null } },
    orderBy: { seq: "asc" },
    select: { objectKey: true, sizeBytes: true },
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
  if (chunks.length === 0 || total > MAX_RECORDING_BYTES) return null;
  // Chunk rows are kept after processing (see the header): nothing to clean.
  return { keys: chunks.map((c) => c.objectKey), maxBytesEach: MAX_CHUNK_BYTES, cleanupRows: async () => {} };
}

export function createPrepareAudio(deps: PrepareDeps = {}): JobHandler {
  const storageOf = deps.storage ?? requireStorage;
  const normalize = deps.normalize ?? normalizeAudio;
  const now = deps.now ?? (() => new Date());
  const announce = deps.announce ?? defaultAnnounce;

  /** Best effort: the bucket's 29-day lifecycle rule is the backstop for what fails here. */
  async function deleteSources(storage: Storage, keys: readonly string[]): Promise<boolean> {
    let all = true;
    for (const key of keys) {
      try {
        await storage.deleteObject(key);
      } catch (error) {
        all = false;
        console.error("[prepare_audio] could not delete a source object:", error instanceof Error ? error.name : "unknown error");
      }
    }
    return all;
  }

  async function markFailed(ctx: JobContext, meetingId: string, code: FailureCode): Promise<void> {
    const result = await ctx.commit((tx) =>
      tx.meeting.updateMany({
        where: { id: meetingId, status: "processing", audioKey: null },
        data: { status: "failed", stage: null, failureCode: code, processedAt: now() },
      }),
    );
    // Tell whoever asked (T32, AC-12.2), once, after the commit; a stale or lost write tells nobody.
    if (!result.committed || result.value.count === 0) return;
    const meeting = await db.meeting.findUnique({ where: { id: meetingId }, select: { id: true, title: true, processingRequestedBy: true, creatorUserId: true } });
    if (meeting) announceProcessing(announce, meeting, "transcription_failed");
  }

  return async (ctx) => {
    const meetingId = ctx.job.meetingId;
    if (!meetingId) throw new PermanentJobError("no_meeting");

    const meeting = await db.meeting.findUnique({ where: { id: meetingId }, select: { source: true, status: true, audioKey: true, durationMs: true } });
    // Deleted, discarded or already finished: nothing to do.
    if (!meeting) return;

    const storage = storageOf();
    const source = await loadSource(meetingId, meeting.source);

    if (meeting.audioKey !== null) {
      // Committed before a crash cut the cleanup short: finish the cleanup, queue nothing.
      if (source && (await deleteSources(storage, source.keys))) await source.cleanupRows();
      return;
    }
    if (meeting.status !== "processing") return;

    if (!source) {
      await markFailed(ctx, meetingId, "audio_unreadable");
      throw new PermanentJobError("audio_unreadable");
    }

    const workDir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "meetings-prep-"));
    try {
      // 1. Bytes to disk, one object at a time.
      const files: string[] = [];
      for (const [index, key] of source.keys.entries()) {
        const file = join(workDir, `in-${String(index).padStart(6, "0")}`);
        await storage.getObjectToFile(key, file, source.maxBytesEach);
        files.push(file);
      }

      // 2. One valid container per run, then ffmpeg.
      const inputs = meeting.source === "uploaded" ? files : await groupIntoRuns(workDir, files);
      const output = join(workDir, "audio.ogg");
      const { durationMs } = await normalize({ inputs, output, signal: ctx.signal });

      // 3. audio.ogg first (idempotent key), then the state change and the next job together.
      const { sizeBytes } = await storage.putAudioFile(meetingId, output);
      const stamp = now();
      const committed = await ctx.commit(async (tx) => {
        const updated = await tx.meeting.updateMany({
          where: { id: meetingId, status: "processing", audioKey: null },
          data: {
            audioKey: objectKeys.audio(meetingId),
            audioBytes: sizeBytes,
            audioCreatedAt: stamp,
            ...(meeting.durationMs === null ? { durationMs } : {}),
          },
        });
        if (updated.count === 0) return false;
        await enqueueJob(tx, { kind: "transcribe", meetingId });
        return true;
      });
      if (!committed.committed || !committed.value) {
        // The meeting vanished (deleted) or moved on while ffmpeg ran: do not leave its audio behind.
        await storage.deleteObject(objectKeys.audio(meetingId)).catch(() => {});
        return;
      }

      // 4. The sources are no longer needed; video bytes never outlive this step.
      if (await deleteSources(storage, source.keys)) await source.cleanupRows();
    } catch (error) {
      // A lost lease is not the meeting's failure: whoever re-claims the job decides.
      if (ctx.signal.aborted) throw error;

      if (error instanceof PermanentJobError) throw error;
      if (error instanceof NormalizeError || error instanceof ObjectTooLargeError) {
        const code: FailureCode = error instanceof NormalizeError ? error.code : "audio_unreadable";
        await markFailed(ctx, meetingId, code);
        throw new PermanentJobError(code);
      }
      // A missing binary, a storage outage, anything unforeseen: worth retrying, then final.
      if (ctx.attempt >= ctx.job.maxAttempts) await markFailed(ctx, meetingId, "provider_unavailable");
      if (error instanceof TransientJobError) throw error;
      const code = error instanceof ToolMissingError ? "media_unavailable" : "storage_or_unexpected";
      console.error("[prepare_audio] transient failure:", code, error instanceof Error ? error.name : "unknown error");
      throw new TransientJobError(code);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}

export const prepareAudio: JobHandler = createPrepareAudio();
