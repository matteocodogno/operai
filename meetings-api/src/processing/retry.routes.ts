/**
 * `POST /meetings/:id/retry` (specs/021-meetings plan.md § API contracts "Capture", § Processing;
 * AC-6.9, AC-6.10, AC-12.2; ADR-0062). The creator asks for failed processing to run again,
 * while the audio is still kept.
 *
 *   - `failed` only (409 `not_failed`; a second tap finds `processing` and queues nothing);
 *   - the audio must still exist (409 `audio_deleted`): `audio.ogg` for 29 days from
 *     `audioCreatedAt`, or, when `prepare_audio` itself failed and kept its sources, the saved
 *     chunks / the uploaded original for 29 days from when they were stored (the bucket's
 *     lifecycle rule is the guarantee; this only refuses what can no longer work);
 *   - it resumes at the stage that failed: `transcribe` when `audio.ogg` exists, `prepare_audio`
 *     when only the sources do. The state change and the job are ONE transaction under the
 *     meeting's row lock, so exactly one job exists iff the meeting left `failed`;
 *   - the caller becomes `processingRequestedBy`: they are the one told how this run ended.
 *
 * Expiry is DERIVED against an injectable clock (ADR-0013); nothing here writes time-based state.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { db } from "../lib/db";
import { IdParams, commonErrors } from "../lib/http";
import { conflict, validationHook } from "../lib/problem";
import type { AuthzVariables } from "../auth/authz.middleware";
import { openForControl } from "../capture/caller";
import { enqueueJob } from "../jobs/runner";
import { callerOf, creatorControl } from "../meetings/caller";
import { AUDIO_RETENTION_DAYS, audioState } from "../meetings/derived";
import { lockMeeting } from "../meetings/lock";
import { loadMeetingView } from "../meetings/view";

let clock: () => Date = () => new Date();

/** Tests only. */
export function setRetryClockForTests(next: (() => Date) | null): void {
  clock = next ?? (() => new Date());
}

const audioDeleted = () => conflict("audio_deleted", "The audio of this meeting has been deleted: it cannot be processed again");

const retryRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/retry",
  tags: ["Processing"],
  summary: "Run failed processing again, while the audio is kept",
  middleware: creatorControl,
  request: { params: IdParams },
  responses: {
    202: { description: "The meeting, processing again", content: { "application/json": { schema: z.object({}).passthrough() } } },
    409: { description: "not_failed or audio_deleted" },
    ...commonErrors,
  },
});

export const retryRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

retryRouter.openapi(retryRoute, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);
  await openForControl(id, caller);
  const now = clock();

  await db.$transaction(async (tx) => {
    await lockMeeting(tx, id);
    const meeting = await tx.meeting.findUniqueOrThrow({
      where: { id },
      select: { status: true, audioKey: true, audioCreatedAt: true, audioDeletedAt: true },
    });
    if (meeting.status !== "failed") throw conflict("not_failed", "Only a meeting whose processing failed can be retried");

    let resume: "transcribe" | "prepare_audio";
    if (meeting.audioKey !== null) {
      if (audioState(meeting, now).state !== "kept") throw audioDeleted();
      resume = "transcribe";
    } else {
      // audio.ogg never existed (or is gone): only kept sources can be processed again.
      if (meeting.audioDeletedAt !== null) throw audioDeleted();
      const [chunks, upload] = await Promise.all([
        tx.recordingChunk.aggregate({ where: { meetingId: id, storedAt: { not: null } }, _min: { storedAt: true }, _count: { _all: true } }),
        tx.meetingUpload.findUnique({ where: { meetingId: id }, select: { mintedAt: true } }),
      ]);
      const oldest = upload?.mintedAt ?? chunks._min.storedAt;
      if (oldest === null || oldest === undefined) throw audioDeleted();
      if (now.getTime() >= oldest.getTime() + AUDIO_RETENTION_DAYS * 86_400_000) throw audioDeleted();
      resume = "prepare_audio";
    }

    const flipped = await tx.meeting.updateMany({
      where: { id, status: "failed" },
      data: {
        status: "processing",
        stage: resume === "transcribe" ? "transcribing" : "preparing",
        failureCode: null,
        processedAt: null,
        processingRequestedBy: caller.userId,
      },
    });
    if (flipped.count === 0) throw conflict("not_failed", "Only a meeting whose processing failed can be retried");
    await enqueueJob(tx, { kind: resume, meetingId: id });
  });

  return c.json(await loadMeetingView(id, caller, now), 202);
});
