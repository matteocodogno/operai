/**
 * Browser recording: start, chunk confirm, chunk re-mint, heartbeat, stop,
 * process and discard (specs/021-meetings plan.md § Browser capture, § API
 * contracts "Capture"; AC-2.1, AC-2.6..AC-2.11; amendments A1, A2, G3).
 *
 * The chunk protocol in one paragraph. `start` creates the ONE live session and
 * returns the presigned POST for seq 0; the browser POSTs the chunk straight to the
 * bucket (ADR-0016, never through here) and then calls `confirm`, which HEADs the
 * object and answers with the policy for seq + 1. While paused, or while chunks are
 * queued offline, a heartbeat every 30 s keeps the meeting from reading
 * `interrupted` (which is DERIVED from `lastChunkAt` / `lastBeatAt`, never written
 * by a sweep). Heartbeats and confirms carry `capturedMs`, kept as a maximum (G3).
 *
 * Every write that changes a session takes its row `FOR UPDATE`, so a confirm, a
 * heartbeat, a stop and a process serialise per session.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import { IdParams, commonErrors } from "../lib/http";
import { ProblemError, conflict, validationHook } from "../lib/problem";
import { MAX_CHUNK_BYTES, objectKeys, requireStorage } from "../lib/storage";
import type { AuthzVariables } from "../auth/authz.middleware";
import { AUDIO_RETENTION_DAYS, derivedStatus } from "../meetings/derived";
import { loadMeetingView } from "../meetings/view";
import { enqueueJob } from "../jobs/runner";
import { callerOf, creatorControl, openForCapture, openForControl, storageCall } from "./caller";

/** AC-2.11: a recording stops itself at 3 h; the server tolerates 60 s more. */
export const MAX_RECORDING_MS = 3 * 60 * 60 * 1000 + 60_000;
/** The browser cuts a chunk every 10 s; one confirm may report up to 15 s. */
export const MAX_CHUNK_MS = 15_000;
export const CHUNK_SECONDS = 10;
/**
 * Highest chunk number accepted. 3 h of 10 s chunks is 1,080; this leaves room for
 * short chunks (a pause/resume flush) while bounding the rows one meeting can hold.
 */
export const MAX_CHUNK_SEQ = 19_999;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const PresignedPostSchema = z.object({ url: z.string(), fields: z.record(z.string()), expiresAt: z.string() });
const SessionId = z.string().min(1).max(64);
const CapturedMs = z.number().int().min(0).max(MAX_RECORDING_MS);
const ChunkParams = IdParams.extend({ seq: z.coerce.number().int().min(0).max(MAX_CHUNK_SEQ) });

// ─── Session helpers ─────────────────────────────────────────────────────────

const sessionInactive = (): ProblemError =>
  conflict("session_inactive", "This recording session is no longer active. Reload the meeting.");

interface LockedSession {
  readonly id: string;
  readonly capturedMs: number | null;
}

/**
 * Locks the session row and returns it, or `null` when it does not exist for this
 * meeting or has ended. Must run inside a transaction.
 */
export async function lockLiveSession(
  tx: Prisma.TransactionClient,
  meetingId: string,
  sessionId: string,
): Promise<LockedSession | null> {
  const rows = await tx.$queryRaw<{ id: string; capturedMs: number | null }[]>`
    SELECT "id", "capturedMs" FROM "recording_session"
    WHERE "id" = ${sessionId} AND "meetingId" = ${meetingId} AND "endedAt" IS NULL
    FOR UPDATE`;
  return rows[0] ?? null;
}

const maxOf = (current: number | null, reported: number | undefined): number | null =>
  reported === undefined ? current : Math.max(current ?? 0, reported);

// ─── Routes ──────────────────────────────────────────────────────────────────

const startRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/recording/start",
  tags: ["Capture"],
  summary: "Start recording: one live session per meeting",
  middleware: creatorControl,
  request: { params: IdParams },
  responses: {
    201: {
      description: "The session and the policy for chunk 0",
      content: {
        "application/json": {
          schema: z.object({
            sessionId: z.string(),
            chunkSeconds: z.literal(CHUNK_SECONDS),
            maxChunkBytes: z.number().int(),
            next: PresignedPostSchema,
          }),
        },
      },
    },
    409: { description: "consent_required, not_draft, recording_elsewhere, interrupted or wrong_source" },
    ...commonErrors,
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/recording/chunks/{seq}/confirm",
  tags: ["Capture"],
  summary: "Confirm a chunk reached the bucket; returns the policy for seq + 1",
  middleware: creatorControl,
  request: {
    params: ChunkParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({ sessionId: SessionId, durationMs: z.number().int().min(0).max(MAX_CHUNK_MS), capturedMs: CapturedMs.optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Stored",
      content: {
        "application/json": {
          schema: z.object({ storedChunks: z.number().int(), durationMs: z.number().int(), next: PresignedPostSchema }),
        },
      },
    },
    409: { description: "session_inactive or duration_limit" },
    ...commonErrors, // 422: validation, or `chunk_missing` (the object is not in the bucket)
  },
});

const uploadUrlRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/recording/chunks/{seq}/upload-url",
  tags: ["Capture"],
  summary: "Re-mint the upload policy for a chunk (after the 5 minutes expired)",
  middleware: creatorControl,
  request: { params: ChunkParams, body: { content: { "application/json": { schema: z.object({ sessionId: SessionId }) } } } },
  responses: {
    200: { description: "A fresh policy", content: { "application/json": { schema: PresignedPostSchema } } },
    409: { description: "session_inactive" },
    ...commonErrors,
  },
});

const heartbeatRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/recording/heartbeat",
  tags: ["Capture"],
  summary: "Keep-alive while paused or offline; reports how much audio the tab holds",
  middleware: creatorControl,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: z.object({ sessionId: SessionId, paused: z.boolean(), capturedMs: CapturedMs }) } } },
  },
  responses: {
    204: { description: "Noted" },
    409: { description: "session_inactive" },
    ...commonErrors,
  },
});

export const recordingRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

// ─── start ───────────────────────────────────────────────────────────────────

interface StartFacts {
  readonly source: string;
  readonly status: string;
  readonly consentUserId: string | null;
  readonly chunkCount: number;
  readonly live: boolean;
}

/** Why a recording cannot start, in the plan's order of precedence, or `null`. */
function startRefusal(f: StartFacts): ProblemError | null {
  if (f.source !== "recorded") return conflict("wrong_source", "This meeting is not a recorded meeting");
  if (f.consentUserId === null) return conflict("consent_required", "Confirm the consent attestation before recording");
  if (f.status === "recording") {
    return f.live
      ? conflict("recording_elsewhere", "This meeting is being recorded on another device")
      : conflict("interrupted", "This recording was interrupted: process what was captured, or discard it");
  }
  if (f.status !== "draft") return conflict("not_draft", "Only a draft meeting can be recorded");
  if (f.chunkCount > 0) return conflict("interrupted", "This meeting already holds recorded audio");
  return null;
}

async function startFacts(meetingId: string, now: Date): Promise<StartFacts> {
  const [meeting, session, chunkCount] = await Promise.all([
    db.meeting.findUniqueOrThrow({ where: { id: meetingId } }),
    db.recordingSession.findFirst({ where: { meetingId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] }),
    db.recordingChunk.count({ where: { meetingId } }),
  ]);
  return {
    source: meeting.source,
    status: meeting.status,
    consentUserId: meeting.consentUserId,
    chunkCount,
    live: derivedStatus(meeting.status, session, now) === "recording",
  };
}

recordingRouter.openapi(startRoute, async (c) => {
  const { id } = c.req.valid("param");
  await openForControl(id, callerOf(c));

  const refusal = startRefusal(await startFacts(id, new Date()));
  if (refusal) throw refusal;

  // Signing is local, but a misconfigured store must not leave a half-started session.
  const first = await storageCall(() => requireStorage().mintChunkPost(id, 0));

  let sessionId: string;
  try {
    sessionId = await db.$transaction(async (tx) => {
      const flipped = await tx.meeting.updateMany({ where: { id, status: "draft" }, data: { status: "recording" } });
      if (flipped.count === 0) throw conflict("recording_elsewhere", "This meeting is being recorded on another device");
      const session = await tx.recordingSession.create({ data: { meetingId: id }, select: { id: true } });
      return session.id;
    });
  } catch (error) {
    // The partial UNIQUE index (one live session per meeting) lost a race.
    if ((error as { code?: unknown }).code === "P2002") {
      throw conflict("recording_elsewhere", "This meeting is being recorded on another device");
    }
    if (error instanceof ProblemError) {
      // Name the real reason if the state moved under us.
      throw startRefusal(await startFacts(id, new Date())) ?? error;
    }
    throw error;
  }

  return c.json({ sessionId, chunkSeconds: CHUNK_SECONDS as 10, maxChunkBytes: MAX_CHUNK_BYTES, next: first }, 201);
});

// ─── confirm ─────────────────────────────────────────────────────────────────

recordingRouter.openapi(confirmRoute, async (c) => {
  const { id, seq } = c.req.valid("param");
  const { sessionId, durationMs, capturedMs } = c.req.valid("json");
  await openForCapture(id, callerOf(c));

  // Cheap refusal first: no bucket round trip for an ended session.
  const live = await db.recordingSession.findFirst({ where: { id: sessionId, meetingId: id, endedAt: null }, select: { id: true } });
  if (!live) throw sessionInactive();

  const storage = requireStorage();
  const objectKey = objectKeys.chunk(id, seq);
  const head = await storageCall(() => storage.headObject(objectKey));
  if (!head) {
    throw new ProblemError({ status: 422, code: "chunk_missing", detail: "The chunk is not in storage yet: upload it, then confirm", extras: { seq } });
  }

  const now = new Date();
  const totals = await db.$transaction(async (tx) => {
    const session = await lockLiveSession(tx, id, sessionId);
    if (!session) throw sessionInactive();

    const others = await tx.recordingChunk.aggregate({
      where: { meetingId: id, storedAt: { not: null }, seq: { not: seq } },
      _sum: { durationMs: true },
    });
    if ((others._sum.durationMs ?? 0) + durationMs > MAX_RECORDING_MS) {
      throw conflict("duration_limit", "A recording can be at most 3 hours long");
    }

    await tx.recordingChunk.upsert({
      where: { meetingId_seq: { meetingId: id, seq } },
      create: { meetingId: id, seq, sessionId, objectKey, sizeBytes: head.sizeBytes, durationMs, storedAt: now },
      update: { sessionId, objectKey, sizeBytes: head.sizeBytes, durationMs, storedAt: now },
    });
    await tx.recordingSession.update({
      where: { id: sessionId },
      data: { lastChunkAt: now, capturedMs: maxOf(session.capturedMs, capturedMs) },
    });
    const stored = await tx.recordingChunk.aggregate({
      where: { meetingId: id, storedAt: { not: null } },
      _sum: { durationMs: true },
      _count: { _all: true },
    });
    return { storedChunks: stored._count._all, durationMs: stored._sum.durationMs ?? 0 };
  });

  const next = await storageCall(() => storage.mintChunkPost(id, seq + 1));
  return c.json({ ...totals, next }, 200);
});

// ─── upload-url ──────────────────────────────────────────────────────────────

recordingRouter.openapi(uploadUrlRoute, async (c) => {
  const { id, seq } = c.req.valid("param");
  const { sessionId } = c.req.valid("json");
  await openForCapture(id, callerOf(c));
  const live = await db.recordingSession.findFirst({ where: { id: sessionId, meetingId: id, endedAt: null }, select: { id: true } });
  if (!live) throw sessionInactive();
  return c.json(await storageCall(() => requireStorage().mintChunkPost(id, seq)), 200);
});

// ─── heartbeat ───────────────────────────────────────────────────────────────

recordingRouter.openapi(heartbeatRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { sessionId, paused, capturedMs } = c.req.valid("json");
  await openForCapture(id, callerOf(c));
  await db.$transaction(async (tx) => {
    const session = await lockLiveSession(tx, id, sessionId);
    if (!session) throw sessionInactive();
    await tx.recordingSession.update({
      where: { id: sessionId },
      data: { lastBeatAt: new Date(), paused, capturedMs: maxOf(session.capturedMs, capturedMs) },
    });
  });
  return c.body(null, 204);
});

// ─── stop / process / discard ────────────────────────────────────────────────

const MeetingBody = z.object({}).passthrough();
const notRecording = (): ProblemError => conflict("not_recording", "This meeting is not being recorded");

const stopRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/recording/stop",
  tags: ["Capture"],
  summary: "Stop: processing starts once chunks 0..lastSeq are all saved",
  middleware: creatorControl,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: z.object({ sessionId: SessionId, lastSeq: z.number().int().min(0).max(MAX_CHUNK_SEQ) }) } } },
  },
  responses: {
    202: { description: "The meeting, processing", content: { "application/json": { schema: MeetingBody } } },
    409: { description: "chunks_missing { missing: number[] } or session_inactive" },
    ...commonErrors,
  },
});

const processRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/recording/process",
  tags: ["Capture"],
  summary: "Process what was captured of an interrupted recording",
  middleware: creatorControl,
  request: { params: IdParams },
  responses: {
    202: { description: "The meeting, processing", content: { "application/json": { schema: MeetingBody } } },
    409: { description: "not_interrupted, no_audio or audio_deleted" },
    ...commonErrors,
  },
});

const discardRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/recording/discard",
  tags: ["Capture"],
  summary: "Discard the recording: chunks deleted, the meeting is a draft again",
  middleware: creatorControl,
  request: { params: IdParams },
  responses: {
    200: { description: "The draft meeting", content: { "application/json": { schema: MeetingBody } } },
    409: { description: "not_recording" },
    ...commonErrors, // 503 storage_unavailable: nothing was changed
  },
});

/**
 * The shared tail of stop and process: the meeting leaves `recording` for
 * `processing` (a compare-and-set, so it happens exactly once), the session ends,
 * and `prepare_audio` is queued, in the caller's transaction (the job exists iff the
 * state change committed). `durationMs` is the sum of the STORED chunks, which
 * excludes paused time by construction: nothing is captured while paused.
 */
async function beginProcessing(tx: Prisma.TransactionClient, meetingId: string, sessionId: string | null, userId: string, reason: string): Promise<void> {
  const now = new Date();
  const stored = await tx.recordingChunk.aggregate({ where: { meetingId, storedAt: { not: null } }, _sum: { durationMs: true } });
  const flipped = await tx.meeting.updateMany({
    where: { id: meetingId, status: "recording" },
    data: {
      status: "processing",
      stage: "preparing",
      durationMs: stored._sum.durationMs ?? 0,
      processingStartedAt: now,
      processingRequestedBy: userId,
      failureCode: null,
    },
  });
  if (flipped.count === 0) throw notRecording();
  if (sessionId) await tx.recordingSession.update({ where: { id: sessionId }, data: { endedAt: now, endReason: reason } });
  await enqueueJob(tx, { kind: "prepare_audio", meetingId });
}

recordingRouter.openapi(stopRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { sessionId, lastSeq } = c.req.valid("json");
  const caller = callerOf(c);
  await openForControl(id, caller);

  await db.$transaction(async (tx) => {
    const session = await lockLiveSession(tx, id, sessionId);
    if (!session) {
      // A stop that already went through (the answer was lost): the same answer, no second job.
      const done = await tx.recordingSession.findFirst({ where: { id: sessionId, meetingId: id, endReason: "stopped" }, select: { id: true } });
      if (done) return;
      throw sessionInactive();
    }
    const stored = await tx.recordingChunk.findMany({ where: { meetingId: id, storedAt: { not: null } }, select: { seq: true } });
    const have = new Set(stored.map((chunk) => chunk.seq));
    const missing: number[] = [];
    for (let seq = 0; seq <= lastSeq; seq++) if (!have.has(seq)) missing.push(seq);
    if (missing.length > 0) throw conflict("chunks_missing", "Some chunks are not saved yet", { missing });
    await beginProcessing(tx, id, sessionId, caller.userId, "stopped");
  });

  return c.json(await loadMeetingView(id, caller, new Date()), 202);
});

recordingRouter.openapi(processRoute, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);
  await openForControl(id, caller);

  await db.$transaction(async (tx) => {
    const now = new Date();
    const meeting = await tx.meeting.findUniqueOrThrow({ where: { id }, select: { status: true } });
    const latest = await tx.recordingSession.findFirst({ where: { meetingId: id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true } });
    // Lock the session (if it is still open) so a late chunk or beat cannot slip past the decision.
    const open = latest ? await lockLiveSession(tx, id, latest.id) : null;
    const session = latest ? await tx.recordingSession.findUnique({ where: { id: latest.id } }) : null;
    if (derivedStatus(meeting.status, session, now) !== "interrupted") throw conflict("not_interrupted", "Only an interrupted recording can be processed");

    const stored = await tx.recordingChunk.aggregate({ where: { meetingId: id, storedAt: { not: null } }, _min: { storedAt: true }, _count: { _all: true } });
    if (stored._count._all === 0) throw conflict("no_audio", "Nothing was saved from this recording: discard it");
    const oldest = stored._min.storedAt;
    if (oldest && now.getTime() >= oldest.getTime() + AUDIO_RETENTION_DAYS * 86_400_000) {
      throw conflict("audio_deleted", "The saved audio has been deleted");
    }
    await beginProcessing(tx, id, open ? open.id : null, caller.userId, "processed");
  });

  return c.json(await loadMeetingView(id, caller, new Date()), 202);
});

recordingRouter.openapi(discardRoute, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);
  await openForControl(id, caller);

  const meeting = await db.meeting.findUniqueOrThrow({ where: { id }, select: { status: true } });
  if (meeting.status !== "recording") throw notRecording();

  // Objects first: if the store fails, the database still says what is true (AC-4.5 posture).
  await storageCall(() => requireStorage().deletePrefix(objectKeys.prefix(id)));

  await db.$transaction(async (tx) => {
    const flipped = await tx.meeting.updateMany({ where: { id, status: "recording" }, data: { status: "draft", durationMs: null } });
    if (flipped.count === 0) throw notRecording();
    // Sessions go with their chunks (cascade): a fresh recording starts from nothing, and the
    // discarded session's `capturedMs` no longer shows up as lost audio.
    await tx.recordingSession.deleteMany({ where: { meetingId: id } });
  });

  return c.json(await loadMeetingView(id, caller, new Date()), 200);
});
