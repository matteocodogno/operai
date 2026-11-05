/**
 * Playback and deletion of a meeting's audio (specs/021-meetings plan.md § API
 * contracts "Capture"; AC-4.4, AC-4.5, AC-6.5; amendment A4; ADR-0063).
 *
 *   GET    /meetings/:id/audio   selfScoped + visibility: a 15-minute presigned GET, never
 *                                proxied bytes (ADR-0016). Expiry is DERIVED from
 *                                `audioCreatedAt + 29 d` (ADR-0013); the first read that
 *                                observes it deletes the object, lazily and idempotently,
 *                                and records `audioDeletedAt`. The bucket's lifecycle rule is
 *                                the guarantee; this only keeps the meeting's own record honest.
 *   DELETE /meetings/:id/audio   the creator's, not frozen, and NEEDING NO `meetings:access`:
 *                                removing your own data never depends on a grant (A4). Deletes
 *                                everything under the meeting's prefix FIRST, then records it, so
 *                                a storage failure is a 503 with nothing changed (AC-4.5).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "../lib/db";
import { IdParams, commonErrors } from "../lib/http";
import { conflict, validationHook } from "../lib/problem";
import { objectKeys, requireStorage } from "../lib/storage";
import { selfScoped } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { audioState } from "../meetings/derived";
import { loadMeetingView } from "../meetings/view";
import { assertCreatorControl, openMeeting } from "../meetings/visibility";
import { callerOf, storageCall } from "../capture/caller";

// ─── Clock seam (expiry is derived against it) ───────────────────────────────

let clock: () => Date = () => new Date();

/** Tests only. */
export function setAudioClockForTests(next: (() => Date) | null): void {
  clock = next ?? (() => new Date());
}

const audioUnavailable = () => conflict("audio_unavailable", "The audio of this meeting is not available");

// ─── Routes ──────────────────────────────────────────────────────────────────

const getRoute = createRoute({
  method: "get",
  path: "/meetings/{id}/audio",
  tags: ["Audio"],
  summary: "A 15-minute presigned URL for the audio, while it is kept",
  middleware: selfScoped,
  request: { params: IdParams },
  responses: {
    200: { description: "Where to play it", content: { "application/json": { schema: z.object({ url: z.string(), expiresAt: z.string() }) } } },
    401: { description: "Missing or invalid token" },
    404: { description: "No such meeting, or not visible to the caller" },
    409: { description: "audio_unavailable: none, expired or deleted" },
    503: { description: "storage_unavailable" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/meetings/{id}/audio",
  tags: ["Audio"],
  summary: "Delete the recording now",
  // Not `capability(...)`: deleting your own data needs no grant (A4). Identity lookups below fail closed.
  middleware: selfScoped,
  request: { params: IdParams },
  responses: {
    200: { description: "The meeting, audio deleted", content: { "application/json": { schema: z.object({}).passthrough() } } },
    409: { description: "audio_unavailable (nothing to delete) or in_progress" },
    ...commonErrors,
  },
});

export const audioRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

audioRouter.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  await openMeeting(id, callerOf(c));

  const meeting = await db.meeting.findUniqueOrThrow({
    where: { id },
    select: { audioKey: true, audioCreatedAt: true, audioDeletedAt: true },
  });
  const now = clock();
  const state = audioState(meeting, now);

  if (state.state === "kept" && meeting.audioKey !== null) {
    return c.json(await storageCall(() => requireStorage().mintPlaybackGet(meeting.audioKey as string)), 200);
  }

  // Expiry observed and not yet recorded: delete the object, then say so. If the store is
  // down the answer is still "unavailable"; nothing is recorded, so the next read retries.
  if (state.state === "deleted" && meeting.audioDeletedAt === null && meeting.audioKey !== null) {
    try {
      await requireStorage().deleteObject(meeting.audioKey);
      await db.meeting.updateMany({
        where: { id, audioDeletedAt: null },
        data: { audioDeletedAt: now, audioKey: null, audioBytes: null },
      });
    } catch (error) {
      console.error("[audio] could not delete expired audio:", error instanceof Error ? error.name : "unknown error");
    }
  }
  throw audioUnavailable();
});

audioRouter.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);
  const { meeting, role } = await openMeeting(id, caller);
  // creator_only, then frozen (live, fail closed); `holdsAccess` is deliberately not required (A4).
  await assertCreatorControl(role, { ...caller, holdsAccess: true }, meeting.creatorUserId);

  const row = await db.meeting.findUniqueOrThrow({
    where: { id },
    select: { status: true, audioCreatedAt: true, audioDeletedAt: true },
  });
  const now = clock();
  if (audioState(row, now).state === "deleted") return c.json(await loadMeetingView(id, caller, now), 200);
  // A live recording writes chunks here and a job reads audio.ogg: never pull the files from under them.
  if (row.status === "recording" || row.status === "processing") {
    throw conflict("in_progress", "The meeting is being recorded or processed: try again when it is done");
  }
  const [chunks, upload] = await Promise.all([
    db.recordingChunk.count({ where: { meetingId: id } }),
    db.meetingUpload.count({ where: { meetingId: id } }),
  ]);
  if (row.audioCreatedAt === null && chunks === 0 && upload === 0) throw audioUnavailable();

  // Storage first: if it fails, the database still says the audio exists (AC-4.5).
  await storageCall(() => requireStorage().deletePrefix(objectKeys.prefix(id)));

  await db.$transaction(async (tx) => {
    await tx.meeting.update({ where: { id }, data: { audioKey: null, audioBytes: null, audioDeletedAt: now } });
    await tx.meetingUpload.deleteMany({ where: { meetingId: id } });
  });
  return c.json(await loadMeetingView(id, caller, now), 200);
});
