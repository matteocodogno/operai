/**
 * `prepare_audio` (specs/021-meetings T30; AC-3.1, AC-2.6, AC-4.4; ADR-0064; ADR-0062).
 *
 * Turns what the creator recorded or uploaded into `meetings/<id>/audio.ogg` and hands
 * over to `transcribe`:
 *
 *   1. streams the stored chunks, or the uploaded original, to a per-job temp dir
 *      (never into memory). Ceilings are checked from the database BEFORE any read AND on
 *      the bytes actually written, summed across the run: an S3 POST policy stays open
 *      after confirm, so an object can be replaced with a larger one the database never saw;
 *   2. cuts the chunks into containers, PROBES THE LOCAL FILES that will be decoded
 *      (allowlisted demuxer, an audio stream, a duration; `-protocol_whitelist file`),
 *      and runs the hardened ffmpeg (src/media/normalize.ts) with each input's demuxer
 *      pinned to the one that probe named. The probe at upload confirm is only an early
 *      reject: it guarded one object, this one guards the bytes decoded;
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
import { MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES, ObjectTooLargeError, isUploadKeyOf, objectKeys, requireStorage, type Storage } from "../../lib/storage";
import { MAX_NORMALIZED_MS, NormalizeError, groupIntoRuns, normalizeAudio, ToolMissingError } from "../../media/normalize";
import { MAX_AUDIO_MS, pinnedDemuxer, probeMedia, type ProbeVerdict } from "../../media/probe";
import { announce as defaultAnnounce, type NotifyEvent } from "../../lib/notify";
import { PermanentJobError, TransientJobError, enqueueJob, type JobContext, type JobHandler } from "../runner";
import { announceProcessing } from "./processingNotice";

/** 3 h at 32 kbit/s is ~43 MB; this is a generous ceiling on the sum of a recording's chunks. */
export const MAX_RECORDING_BYTES = 128 * 1024 * 1024;

type FailureCode = "audio_unreadable" | "too_long" | "provider_unavailable";

export interface PrepareDeps {
  readonly storage?: () => Storage;
  readonly normalize?: typeof normalizeAudio;
  /** The local-file probe that is the trust decision; default `ffprobe` on the file, `file` protocol only. */
  readonly probe?: (file: string, options: { maxDurationMs: number }) => Promise<ProbeVerdict>;
  /** Ceiling on the bytes of all a recording's chunks together (tests lower it). */
  readonly maxRecordingBytes?: number;
  /** Ceiling on an uploaded original (tests lower it). */
  readonly maxUploadBytes?: number;
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
  /** The ceiling on the bytes written for ALL the keys together. */
  readonly maxBytesTotal: number;
  /** Also remove anything else under the meeting's upload prefix (a retired mint, a stray write). */
  readonly purgeUploads: boolean;
  /** The longest the decoded media may be. */
  readonly maxDurationMs: number;
  /** Deletes the announcement rows once the objects are gone. */
  readonly cleanupRows: () => Promise<void>;
}

async function loadSource(meetingId: string, source: string, limits: { recording: number; upload: number }): Promise<Source | null> {
  if (source === "uploaded") {
    const upload = await db.meetingUpload.findUnique({ where: { meetingId } });
    // Only the key the server stored at mint is ever read; anything else under the prefix is ignored.
    if (!upload || upload.sizeBytes > limits.upload || !isUploadKeyOf(meetingId, upload.objectKey)) return null;
    return {
      keys: [upload.objectKey],
      maxBytesEach: limits.upload,
      maxBytesTotal: limits.upload,
      purgeUploads: true,
      maxDurationMs: MAX_AUDIO_MS,
      cleanupRows: async () => void (await db.meetingUpload.deleteMany({ where: { meetingId } })),
    };
  }
  const chunks = await db.recordingChunk.findMany({
    where: { meetingId, storedAt: { not: null } },
    orderBy: { seq: "asc" },
    select: { objectKey: true, sizeBytes: true },
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
  if (chunks.length === 0 || total > limits.recording) return null;
  // Chunk rows are kept after processing (see the header): nothing to clean.
  return {
    keys: chunks.map((c) => c.objectKey),
    maxBytesEach: MAX_CHUNK_BYTES,
    maxBytesTotal: limits.recording,
    purgeUploads: false,
    maxDurationMs: MAX_NORMALIZED_MS,
    cleanupRows: async () => {},
  };
}

export function createPrepareAudio(deps: PrepareDeps = {}): JobHandler {
  const storageOf = deps.storage ?? requireStorage;
  const normalize = deps.normalize ?? normalizeAudio;
  const probe = deps.probe ?? ((file, options) => probeMedia(file, options));
  const limits = { recording: deps.maxRecordingBytes ?? MAX_RECORDING_BYTES, upload: deps.maxUploadBytes ?? MAX_UPLOAD_BYTES };
  const now = deps.now ?? (() => new Date());
  const announce = deps.announce ?? defaultAnnounce;

  /** Best effort: the bucket's 29-day lifecycle rule is the backstop for what fails here. */
  async function deleteSources(storage: Storage, meetingId: string, source: Source): Promise<boolean> {
    let all = true;
    for (const key of source.keys) {
      try {
        await storage.deleteObject(key);
      } catch (error) {
        all = false;
        console.error("[prepare_audio] could not delete a source object:", error instanceof Error ? error.name : "unknown error");
      }
    }
    if (source.purgeUploads) {
      try {
        await storage.deleteUploadsExcept(meetingId);
      } catch (error) {
        all = false;
        console.error("[prepare_audio] could not delete stray uploads:", error instanceof Error ? error.name : "unknown error");
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
    const source = await loadSource(meetingId, meeting.source, limits);

    if (meeting.audioKey !== null) {
      // Committed before a crash cut the cleanup short: finish the cleanup, queue nothing.
      if (source && (await deleteSources(storage, meetingId, source))) await source.cleanupRows();
      return;
    }
    if (meeting.status !== "processing") return;

    if (!source) {
      await markFailed(ctx, meetingId, "audio_unreadable");
      throw new PermanentJobError("audio_unreadable");
    }

    const workDir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "meetings-prep-"));
    try {
      // 1. Bytes to disk, one object at a time. The ceiling is on what is actually WRITTEN, summed:
      //    each read is handed only what is left of the budget, so a replaced object cannot exceed it.
      const files: string[] = [];
      let remaining = source.maxBytesTotal;
      for (const [index, key] of source.keys.entries()) {
        const file = join(workDir, `in-${String(index).padStart(6, "0")}`);
        remaining -= await storage.getObjectToFile(key, file, Math.min(source.maxBytesEach, remaining));
        files.push(file);
      }

      // 2. One valid container per run. The LOCAL files are probed: what is decoded is exactly
      //    what was probed, through the demuxer the probe named.
      const inputs = meeting.source === "uploaded" ? files : await groupIntoRuns(workDir, files);
      const inputFormats: string[] = [];
      for (const input of inputs) {
        const verdict = await probe(input, { maxDurationMs: source.maxDurationMs });
        if (!verdict.ok) throw new NormalizeError(verdict.reason === "too_long" ? "too_long" : "audio_unreadable");
        const demuxer = pinnedDemuxer(verdict.format);
        if (demuxer === undefined) throw new NormalizeError("audio_unreadable");
        inputFormats.push(demuxer);
      }
      const output = join(workDir, "audio.ogg");
      const { durationMs } = await normalize({ inputs, inputFormats, output, signal: ctx.signal });

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
      if (await deleteSources(storage, meetingId, source)) await source.cleanupRows();
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
