/**
 * Attachment endpoints (T9, specs/007-refund-service, ADR-0016).
 *
 *   POST   /requests/:id/lines/:lineId/attachments             → mint (draft-only)
 *   POST   /requests/:id/lines/:lineId/attachments/:aid/confirm → HEAD-verify → stored
 *   DELETE /requests/:id/lines/:lineId/attachments/:aid        → draft-only, deletes object too
 *   GET    /requests/:id/lines/:lineId/attachments/:aid/url    → signed GET, owner OR in-scope accounting
 *
 * Mint/confirm/delete are draft-only + owner-scoped (404/409, same pattern as
 * lines.routes.ts). GET url is NOT draft-only — it reuses requests.repo's
 * `findRequestWithLines` + `canReadRequest` (the SAME predicate GET
 * /requests/:id uses) so an in-scope accounting reviewer can also download a
 * submitted request's receipts (AC-6.2), and the signed URL is minted ONLY
 * after that check passes (ADR-0016 § Download).
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { db } from "../lib/db";
import { ConflictError, DatabaseError, NotFoundError } from "../lib/errors";
import {
  deleteObject,
  headObject,
  mintPresignedGet,
  mintPresignedPost,
  sanitizeFileName,
} from "../lib/storage";
import { findRequestWithLines } from "../requests/requests.repo";
import {
  AttachmentIdParamSchema,
  LineIdParamSchema,
  ProblemSchema,
} from "../requests/requests.schemas";
import { canReadRequest } from "../requests/requests.service";
import {
  createPendingAttachment,
  deleteAttachmentRow,
  ensureOwnedDraftLine,
  findAttachmentInLine,
  markAttachmentStored,
} from "./attachments.repo";
import {
  AttachmentConfirmResponseSchema,
  MintAttachmentBodySchema,
  MintAttachmentResponseSchema,
  SignedUrlResponseSchema,
} from "./attachments.schemas";

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const notFoundProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404 as const,
  detail,
  instance: path,
});

const conflictProblem = (path: string, detail: string) => ({
  type: "https://httpstatuses.com/409",
  title: "Conflict",
  status: 409 as const,
  detail,
  instance: path,
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const attachmentsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/422",
          title: "Unprocessable Entity",
          status: 422,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        422,
      );
    }
    return undefined;
  },
});

attachmentsRouter.use("/requests/:id/lines/:lineId/attachments", jwtMiddleware);
attachmentsRouter.use("/requests/:id/lines/:lineId/attachments", authzMiddleware);
attachmentsRouter.use("/requests/:id/lines/:lineId/attachments/*", jwtMiddleware);
attachmentsRouter.use("/requests/:id/lines/:lineId/attachments/*", authzMiddleware);

function requireCreateCapabilityOr404(
  authz: AuthzVariables["authz"],
  path: string,
  requestId: string,
) {
  if (hasCapability(authz.permissions, "request", "create")) return null;
  return notFoundProblem(path, `Refund request ${requestId} not found`);
}

/**
 * Narrows the draft-line guard's error union (which also carries
 * `DatabaseError`) to a 404/409 Problem response, or `null` when the error
 * is a `DatabaseError` the caller should instead throw/500 on.
 */
function mapDraftLineGuardError(
  error: DatabaseError | NotFoundError | ConflictError,
  path: string,
): { status: 404 | 409; body: ReturnType<typeof notFoundProblem> | ReturnType<typeof conflictProblem> } | null {
  if (error instanceof NotFoundError) {
    return { status: 404, body: notFoundProblem(path, error.message) };
  }
  if (error instanceof ConflictError) {
    return { status: 409, body: conflictProblem(path, error.message) };
  }
  return null;
}

// ─── POST /requests/:id/lines/:lineId/attachments — mint ──────────────────

const mintAttachmentRoute = createRoute({
  method: "post",
  path: "/requests/{id}/lines/{lineId}/attachments",
  tags: ["Attachments"],
  summary: "Mint a presigned upload for a receipt attachment",
  description:
    "Draft-only (409 otherwise). Returns a presigned POST — the browser " +
    "uploads directly to the EU bucket; refund-api never touches the file " +
    "bytes (ADR-0016). content-length-range (<=10 MiB) and Content-Type are " +
    "pinned inside the signed policy itself.",
  security: [{ Bearer: [] }],
  request: {
    params: LineIdParamSchema,
    body: { required: true, content: { "application/json": { schema: MintAttachmentBodySchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: MintAttachmentResponseSchema } },
      description: "Presigned upload minted",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request/line not found, not owned, or capability missing",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not a draft",
    },
    422: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "sizeBytes over the cap or contentType not in the allowed set",
    },
  },
});

attachmentsRouter.openapi(mintAttachmentRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id: requestId, lineId } = c.req.valid("param");
  const { fileName, contentType, sizeBytes } = c.req.valid("json");

  const capDenial = requireCreateCapabilityOr404(authz, c.req.path, requestId);
  if (capDenial) return c.json(capDenial, 404);

  const guardExit = await Effect.runPromiseExit(
    ensureOwnedDraftLine(requestId, lineId, sub),
  );
  if (guardExit._tag === "Failure") {
    const cause = guardExit.cause;
    if (cause._tag === "Fail") {
      const mapped = mapDraftLineGuardError(cause.error, c.req.path);
      if (mapped) return c.json(mapped.body, mapped.status);
    }
    throw new Error("Unexpected database failure minting attachment upload");
  }

  const attachmentId = crypto.randomUUID();
  const safeName = sanitizeFileName(fileName);
  const objectKey = `refund/${requestId}/${lineId}/${attachmentId}/${safeName}`;

  const upload = await mintPresignedPost(objectKey, contentType);

  const createExit = await Effect.runPromiseExit(
    createPendingAttachment({
      id: attachmentId,
      lineId,
      objectKey,
      fileName,
      contentType,
      sizeBytes,
    }),
  );
  if (createExit._tag === "Failure") {
    throw new Error("Unexpected database failure recording pending attachment");
  }

  return c.json({ attachmentId, upload: { ...upload, objectKey } }, 201);
});

// ─── POST /requests/:id/lines/:lineId/attachments/:aid/confirm ─────────────

const confirmAttachmentRoute = createRoute({
  method: "post",
  path: "/requests/{id}/lines/{lineId}/attachments/{aid}/confirm",
  tags: ["Attachments"],
  summary: "Confirm a completed upload",
  description:
    "HEADs the object and re-validates its actual size/content-type against " +
    "the metadata recorded at mint time (ADR-0016 defense-in-depth); flips " +
    "`uploadStatus` to `stored` on match. 409 if the object is missing or " +
    "the metadata mismatches, or if the request is no longer a draft.",
  security: [{ Bearer: [] }],
  request: { params: AttachmentIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: AttachmentConfirmResponseSchema } },
      description: "Attachment confirmed (uploadStatus=stored)",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request/line/attachment not found, not owned, or capability missing",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request not a draft, object missing, or metadata mismatch",
    },
  },
});

attachmentsRouter.openapi(confirmAttachmentRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id: requestId, lineId, aid } = c.req.valid("param");

  const capDenial = requireCreateCapabilityOr404(authz, c.req.path, requestId);
  if (capDenial) return c.json(capDenial, 404);

  const guardExit = await Effect.runPromiseExit(
    ensureOwnedDraftLine(requestId, lineId, sub),
  );
  if (guardExit._tag === "Failure") {
    const cause = guardExit.cause;
    if (cause._tag === "Fail") {
      const mapped = mapDraftLineGuardError(cause.error, c.req.path);
      if (mapped) return c.json(mapped.body, mapped.status);
    }
    throw new Error("Unexpected database failure confirming attachment");
  }

  const findExit = await Effect.runPromiseExit(findAttachmentInLine(lineId, aid));
  if (findExit._tag === "Failure") {
    throw new Error("Unexpected database failure looking up attachment");
  }
  const attachment = findExit.value;
  if (!attachment) {
    return c.json(notFoundProblem(c.req.path, `Attachment ${aid} not found`), 404);
  }

  const head = await headObject(attachment.objectKey);
  if (!head) {
    return c.json(
      conflictProblem(
        c.req.path,
        "The upload was not found in storage — upload the file before confirming",
      ),
      409,
    );
  }
  if (
    head.sizeBytes !== attachment.sizeBytes ||
    (head.contentType && head.contentType !== attachment.contentType)
  ) {
    return c.json(
      conflictProblem(
        c.req.path,
        "The uploaded object's size or content-type does not match what was declared at mint time",
      ),
      409,
    );
  }

  const markExit = await Effect.runPromiseExit(markAttachmentStored(aid));
  if (markExit._tag === "Failure") {
    throw new Error("Unexpected database failure marking attachment stored");
  }

  const stored = markExit.value;
  return c.json(
    {
      id: stored.id,
      fileName: stored.fileName,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      uploadStatus: "stored" as const,
    },
    200,
  );
});

// ─── DELETE /requests/:id/lines/:lineId/attachments/:aid ───────────────────

const deleteAttachmentRoute = createRoute({
  method: "delete",
  path: "/requests/{id}/lines/{lineId}/attachments/{aid}",
  tags: ["Attachments"],
  summary: "Remove a receipt attachment",
  description:
    "Draft-only (409 otherwise). Best-effort deletes the underlying storage " +
    "object (a failure there is logged but does not block the API response — " +
    "the DB record is the source of truth for what is visible) before " +
    "removing the attachment record.",
  security: [{ Bearer: [] }],
  request: { params: AttachmentIdParamSchema },
  responses: {
    204: { description: "Deleted" },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request/line/attachment not found, not owned, or capability missing",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Request is not a draft",
    },
  },
});

attachmentsRouter.openapi(deleteAttachmentRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id: requestId, lineId, aid } = c.req.valid("param");

  const capDenial = requireCreateCapabilityOr404(authz, c.req.path, requestId);
  if (capDenial) return c.json(capDenial, 404);

  const guardExit = await Effect.runPromiseExit(
    ensureOwnedDraftLine(requestId, lineId, sub),
  );
  if (guardExit._tag === "Failure") {
    const cause = guardExit.cause;
    if (cause._tag === "Fail") {
      const mapped = mapDraftLineGuardError(cause.error, c.req.path);
      if (mapped) return c.json(mapped.body, mapped.status);
    }
    throw new Error("Unexpected database failure deleting attachment");
  }

  const findExit = await Effect.runPromiseExit(findAttachmentInLine(lineId, aid));
  if (findExit._tag === "Failure") {
    throw new Error("Unexpected database failure looking up attachment");
  }
  const attachment = findExit.value;
  if (!attachment) {
    return c.json(notFoundProblem(c.req.path, `Attachment ${aid} not found`), 404);
  }

  // Best-effort object delete — a storage-side failure (network blip,
  // already-gone object) is logged but must not block removing the DB
  // record; a decision the plan leaves to implementation (ADR-0016 names no
  // cron for orphan cleanup either way).
  try {
    await deleteObject(attachment.objectKey);
  } catch (err) {
    console.error("[attachments] best-effort object delete failed:", err);
  }

  const deleteExit = await Effect.runPromiseExit(deleteAttachmentRow(aid));
  if (deleteExit._tag === "Failure") {
    throw new Error("Unexpected database failure deleting attachment record");
  }

  return new Response(null, { status: 204 });
});

// ─── GET /requests/:id/lines/:lineId/attachments/:aid/url ──────────────────

const getAttachmentUrlRoute = createRoute({
  method: "get",
  path: "/requests/{id}/lines/{lineId}/attachments/{aid}/url",
  tags: ["Attachments"],
  summary: "Mint a short-lived signed download URL",
  description:
    "Owner OR in-scope accounting only (404 otherwise — same predicate as " +
    "GET /requests/:id). The signed GET (~60s) is minted ONLY after that " +
    "check passes (ADR-0016). Only a `stored` attachment is ever reachable.",
  security: [{ Bearer: [] }],
  request: { params: AttachmentIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: SignedUrlResponseSchema } },
      description: "Signed URL minted",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Not found, not owned, not in scope, or not yet stored",
    },
  },
});

const SIGNED_GET_EXPIRES_SECONDS = 60;

attachmentsRouter.openapi(getAttachmentUrlRoute, async (c) => {
  const sub = c.get("userId");
  const authz = c.get("authz");
  const { id: requestId, lineId, aid } = c.req.valid("param");

  const exit = await Effect.runPromiseExit(findRequestWithLines(requestId));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure fetching refund request");
  }

  const request = exit.value;
  if (!request || !canReadRequest(request, authz, sub)) {
    return c.json(notFoundProblem(c.req.path, `Refund request ${requestId} not found`), 404);
  }

  const line = request.lines.find((l) => l.id === lineId);
  const attachment = line?.attachments?.find((a) => a.id === aid);
  if (!line || !attachment) {
    return c.json(notFoundProblem(c.req.path, `Attachment ${aid} not found`), 404);
  }

  // The mapped LineRow shape doesn't carry objectKey (it's never on the
  // wire) — fetch it directly, scoped by the id we just proved is
  // authorized to read.
  const objectKeyRow = await db.attachment.findUnique({
    where: { id: aid },
    select: { objectKey: true },
  });
  if (!objectKeyRow) {
    return c.json(notFoundProblem(c.req.path, `Attachment ${aid} not found`), 404);
  }

  const url = await mintPresignedGet(objectKeyRow.objectKey, SIGNED_GET_EXPIRES_SECONDS);
  const expiresAt = new Date(Date.now() + SIGNED_GET_EXPIRES_SECONDS * 1000).toISOString();

  return c.json({ url, expiresAt }, 200);
});
