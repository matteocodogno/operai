/**
 * Upload a recording made elsewhere (specs/021-meetings US-3, AC-3.1..AC-3.3;
 * plan.md § Browser capture "Upload"; ADR-0064).
 *
 *   POST /meetings/:id/upload          mints ONE presigned POST at the fixed key
 *                                      `meetings/<id>/original` (type allowlist, <= 500 MiB,
 *                                      30 min) and remembers what was announced.
 *   POST /meetings/:id/upload/confirm  HEADs the object, then runs `ffprobe`
 *                                      SYNCHRONOUSLY over a 60 s presigned GET: demuxer
 *                                      allowlist, an audio stream, <= 3 h. A failure deletes
 *                                      the object and leaves the meeting `draft`; a pass moves
 *                                      it to `processing` and queues `prepare_audio`, which
 *                                      is the only other reader of the bytes.
 *
 * The meeting is never `processing` with an incomplete file (AC-3.3): the state change
 * happens only after the object exists AND passed the probe, in one transaction with the job.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "../lib/db";
import { IdParams, commonErrors } from "../lib/http";
import { ProblemError, conflict, validationHook } from "../lib/problem";
import { MAX_UPLOAD_BYTES, isUploadContentType, objectKeys, requireStorage } from "../lib/storage";
import { enqueueJob } from "../jobs/runner";
import { ToolMissingError, probeUpload, type RejectReason } from "../media/probe";
import { loadMeetingView } from "../meetings/view";
import type { AuthzVariables } from "../auth/authz.middleware";
import { openForControl, storageCall } from "./caller";
import { callerOf, creatorControl } from "../meetings/caller";

const PresignedPostSchema = z.object({ url: z.string(), fields: z.record(z.string()), expiresAt: z.string() });

const mintRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/upload",
  tags: ["Capture"],
  summary: "Mint a presigned POST for an audio or video file",
  middleware: creatorControl,
  request: {
    params: IdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({ contentType: z.string().min(1).max(100), sizeBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
        },
      },
    },
  },
  responses: {
    200: { description: "The upload policy", content: { "application/json": { schema: PresignedPostSchema } } },
    409: { description: "consent_required, wrong_source or not_draft" },
    ...commonErrors, // 422 also: unsupported_type, too_large
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/upload/confirm",
  tags: ["Capture"],
  summary: "Check the uploaded file and start processing",
  middleware: creatorControl,
  request: { params: IdParams },
  responses: {
    202: { description: "The meeting, processing", content: { "application/json": { schema: z.object({}).passthrough() } } },
    409: { description: "upload_incomplete, wrong_source or not_draft" },
    ...commonErrors, // 422 upload_rejected { reason }
  },
});

export const uploadRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

/** The state an upload needs, or the 409 that names what is wrong. */
async function assertUploadable(id: string): Promise<{ status: string }> {
  const meeting = await db.meeting.findUniqueOrThrow({ where: { id }, select: { source: true, status: true, consentUserId: true } });
  if (meeting.source !== "uploaded") throw conflict("wrong_source", "This meeting is not an uploaded-file meeting");
  if (meeting.consentUserId === null) throw conflict("consent_required", "Confirm the consent attestation before uploading");
  return meeting;
}

uploadRouter.openapi(mintRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { contentType, sizeBytes } = c.req.valid("json");
  await openForControl(id, callerOf(c));

  const meeting = await assertUploadable(id);
  if (meeting.status !== "draft") throw conflict("not_draft", "A file can only be uploaded to a draft meeting");
  if (!isUploadContentType(contentType)) {
    throw new ProblemError({ status: 422, code: "unsupported_type", detail: "This file type is not supported: use an audio or video file", extras: { field: "contentType" } });
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new ProblemError({ status: 422, code: "too_large", detail: "The file is larger than 500 MiB", extras: { field: "sizeBytes" } });
  }

  const post = await storageCall(() => requireStorage().mintUploadPost(id, contentType));
  const objectKey = objectKeys.original(id);
  await db.meetingUpload.upsert({
    where: { meetingId: id },
    create: { meetingId: id, objectKey, contentType, sizeBytes },
    update: { objectKey, contentType, sizeBytes, mintedAt: new Date() },
  });
  return c.json(post, 200);
});

const incomplete = (): ProblemError => conflict("upload_incomplete", "The file has not been uploaded completely: upload it again");

const rejected = (reason: RejectReason | "too_large"): ProblemError =>
  new ProblemError({ status: 422, code: "upload_rejected", detail: "The file was refused and deleted", extras: { reason } });

uploadRouter.openapi(confirmRoute, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);
  await openForControl(id, caller);

  const meeting = await assertUploadable(id);
  // The answer to a confirm that already succeeded was lost: say the same thing, queue nothing.
  if (meeting.status === "processing") return c.json(await loadMeetingView(id, caller, new Date()), 202);
  if (meeting.status !== "draft") throw conflict("not_draft", "A file can only be confirmed on a draft meeting");

  const upload = await db.meetingUpload.findUnique({ where: { meetingId: id } });
  if (!upload) throw incomplete();

  const storage = requireStorage();
  const head = await storageCall(() => storage.headObject(upload.objectKey));
  if (!head) throw incomplete();

  // Never keep what failed: the object goes, then the announcement, and the meeting stays draft.
  const discard = async (error: ProblemError): Promise<never> => {
    try {
      await storage.deleteObject(upload.objectKey);
    } catch (e) {
      // The bucket's 29-day lifecycle rule is the backstop; the refusal still stands.
      console.error("[upload] could not delete a refused file:", e instanceof Error ? e.name : "unknown error");
    }
    await db.meetingUpload.deleteMany({ where: { meetingId: id } });
    throw error;
  };

  if (head.sizeBytes > MAX_UPLOAD_BYTES) return discard(rejected("too_large"));

  const source = await storageCall(() => storage.mintProbeGet(upload.objectKey));
  let verdict;
  try {
    verdict = await probeUpload(source);
  } catch (error) {
    if (error instanceof ToolMissingError) {
      console.error("[upload] media tooling is not available:", error.tool);
      throw new ProblemError({ status: 503, code: "media_unavailable", detail: "Media checking is unavailable right now: try again later" });
    }
    throw error;
  }
  if (!verdict.ok) return discard(rejected(verdict.reason));

  const now = new Date();
  await db.$transaction(async (tx) => {
    const flipped = await tx.meeting.updateMany({
      where: { id, status: "draft" },
      data: {
        status: "processing",
        stage: "preparing",
        durationMs: verdict.durationMs,
        processingStartedAt: now,
        processingRequestedBy: caller.userId,
        failureCode: null,
      },
    });
    // Lost a race with a second confirm: that one queued the job.
    if (flipped.count === 0) throw conflict("not_draft", "A file can only be confirmed on a draft meeting");
    await tx.meetingUpload.update({ where: { meetingId: id }, data: { sizeBytes: head.sizeBytes } });
    await enqueueJob(tx, { kind: "prepare_audio", meetingId: id });
  });

  return c.json(await loadMeetingView(id, caller, new Date()), 202);
});
