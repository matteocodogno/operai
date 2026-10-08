/**
 * Invoice files (T21, specs/015-hardware-inventory; AC-10.4 to AC-10.7;
 * plan § Invoice files). Either capability (`asset:manage` or `ledger:manage`),
 * scoped by the file's `entity`:
 *
 *   POST /invoice-files              mint a presigned POST (415 / 413 here)
 *   POST /invoice-files/{id}/confirm HEAD the object, then `pending` -> `stored`
 *   PUT  /invoice-files/{id}/assets  link a stored file to assets (replaces)
 *   GET  /invoice-files/{id}/url     a 60 s presigned GET
 *
 * Denials follow ADR-0014. The mint is a capability gate (403, and 403 for an
 * entity outside the caller's scope, as `POST /assets` does: the entity is a
 * body value, not an addressed record). Every route that ADDRESSES a file is
 * 404 for a caller with no capability, an out-of-scope file, an unknown id, or
 * a file that is not `stored` where that matters — so the asset's own holder,
 * who has no capability, learns nothing (AC-10.7).
 *
 * Object keys are server-generated: `inventory/{entity}/{id}/{safeName}`. The
 * client's file name is stored (sanitised) for display only.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { authorized, requireCapability, ASSET_MANAGE, LEDGER_MANAGE } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { ENTITIES, scopeFor, type Entity } from "../authz/conditions";
import { ProblemError, conflict, forbidden, notFound, problem, validationHook } from "../lib/problem";
import {
  DOWNLOAD_URL_SECONDS,
  MAX_INVOICE_BYTES,
  displayFileName,
  isAllowedContentType,
  sanitizeFileName,
  storage,
} from "../lib/storage";
import {
  ConfirmResponseSchema,
  FileIdParamSchema,
  LinkBodySchema,
  LinkResponseSchema,
  MintBodySchema,
  MintResponseSchema,
  UrlResponseSchema,
} from "./invoices.schemas";
import { createPendingFile, deletePendingFile, findFile, linkFile, markStored, type InvoiceFileRow } from "./invoices.repo";

const MINT_BODY_LIMIT = 8 * 1024;

/** The entities the caller can reach through EITHER capability. */
function readableEntities(authz: AuthzVariables["authz"]): Entity[] {
  const manage = scopeFor(authz.permissions, "asset", "manage", authz.entity);
  const ledger = scopeFor(authz.permissions, "ledger", "manage", authz.entity);
  return ENTITIES.filter((e) => manage.includes(e) || ledger.includes(e));
}

/** The file if it exists and is in scope; otherwise the one 404 every route shares. */
async function fileInScope(id: string, authz: AuthzVariables["authz"]): Promise<InvoiceFileRow> {
  const file = await findFile(id);
  if (!file || !readableEntities(authz).includes(file.entity)) throw notFound("Invoice file not found");
  return file;
}

const tooLarge = (detail: string) => new ProblemError({ status: 413, detail });
const unsupportedType = (detail: string) => new ProblemError({ status: 415, detail });

/** Best-effort removal of a rejected upload: the object, then the unconfirmed row. */
async function discard(file: InvoiceFileRow): Promise<void> {
  try {
    await storage.deleteObject(file.objectKey);
  } catch (error) {
    console.error(`[invoices] could not delete the rejected object of file ${file.id}:`, error instanceof Error ? error.message : error);
  }
  try {
    await deletePendingFile(file.id);
  } catch (error) {
    console.error(`[invoices] could not delete the rejected row of file ${file.id}:`, error instanceof Error ? error.message : error);
  }
}

const bothCapabilities = [...authorized, requireCapability(ASSET_MANAGE, LEDGER_MANAGE)];

const mintRoute = createRoute({
  method: "post",
  path: "/invoice-files",
  tags: ["Invoice files"],
  summary: "Mint a presigned upload for an invoice file (pending until confirmed)",
  middleware: [
    ...bothCapabilities,
    bodyLimit({
      maxSize: MINT_BODY_LIMIT,
      onError: (c) => problem({ status: 413, detail: "Request body is too large" }, c.req.path),
    }),
  ],
  request: { body: { content: { "application/json": { schema: MintBodySchema } }, required: true } },
  responses: {
    201: { description: "Upload minted", content: { "application/json": { schema: MintResponseSchema } } },
    403: { description: "No capability, or the entity is out of scope" },
    413: { description: "More than 10 MiB" },
    415: { description: "Not pdf, jpeg or png" },
    422: { description: "Invalid body" },
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/invoice-files/{id}/confirm",
  tags: ["Invoice files"],
  summary: "Confirm a finished upload",
  middleware: authorized,
  request: { params: FileIdParamSchema },
  responses: {
    200: { description: "Stored", content: { "application/json": { schema: ConfirmResponseSchema } } },
    404: { description: "Unknown, out of scope, or no capability" },
    409: { description: "upload_not_found: no object, or its size or type differs from what was declared" },
    413: { description: "The stored object is over 10 MiB (deleted)" },
    415: { description: "The stored object is not pdf, jpeg or png (deleted)" },
  },
});

const linkRoute = createRoute({
  method: "put",
  path: "/invoice-files/{id}/assets",
  tags: ["Invoice files"],
  summary: "Link a stored file to assets that carry its invoice reference",
  middleware: authorized,
  request: {
    params: FileIdParamSchema,
    body: { content: { "application/json": { schema: LinkBodySchema } }, required: true },
  },
  responses: {
    200: { description: "Linked", content: { "application/json": { schema: LinkResponseSchema } } },
    404: { description: "Unknown file, or an asset that is unknown or out of scope" },
    409: { description: "invoice_ref_mismatch | asset_disposed, naming the asset" },
    422: { description: "Invalid body" },
  },
});

const urlRoute = createRoute({
  method: "get",
  path: "/invoice-files/{id}/url",
  tags: ["Invoice files"],
  summary: "A 60-second download URL",
  middleware: authorized,
  request: { params: FileIdParamSchema },
  responses: {
    200: { description: "The URL", content: { "application/json": { schema: UrlResponseSchema } } },
    404: { description: "Unknown, not stored, out of scope, no capability, or the stored object no longer matches what was confirmed (size / ETag)" },
  },
});

export const invoicesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

invoicesRouter.openapi(mintRoute, async (c) => {
  const body = c.req.valid("json");
  if (!readableEntities(c.get("authz")).includes(body.entity)) {
    throw forbidden("You may not upload invoice files for this entity");
  }
  // Type before size, as the UI's own pre-check does.
  if (!isAllowedContentType(body.contentType)) {
    throw unsupportedType("Only PDF, JPEG or PNG files can be uploaded");
  }
  if (body.sizeBytes > MAX_INVOICE_BYTES) {
    throw tooLarge("An invoice file can be at most 10 MiB");
  }

  const id = crypto.randomUUID();
  const objectKey = `inventory/${body.entity}/${id}/${sanitizeFileName(body.fileName)}`;
  const upload = await storage.mintPresignedPost(objectKey, body.contentType);
  await createPendingFile({
    id,
    entity: body.entity,
    invoiceRef: body.invoiceRef,
    objectKey,
    fileName: displayFileName(body.fileName),
    contentType: body.contentType,
    sizeBytes: body.sizeBytes,
    createdByUserId: c.get("userId"),
  });
  return c.json({ id, upload }, 201);
});

invoicesRouter.openapi(confirmRoute, async (c) => {
  const { id } = c.req.valid("param");
  const file = await fileInScope(id, c.get("authz"));
  if (file.uploadStatus === "stored") return c.json({ id: file.id, fileName: file.fileName }, 200);

  const head = await storage.headObject(file.objectKey);
  if (!head) {
    // Nothing landed (yet): keep the row so the client can retry the upload.
    throw conflict("upload_not_found", "The upload was not found in storage — upload the file before confirming");
  }
  if (head.sizeBytes > MAX_INVOICE_BYTES) {
    await discard(file);
    throw tooLarge("The uploaded file is larger than 10 MiB and was removed");
  }
  if (head.contentType !== undefined && !isAllowedContentType(head.contentType)) {
    await discard(file);
    throw unsupportedType("The uploaded file is not a PDF, JPEG or PNG and was removed");
  }
  if (head.sizeBytes !== file.sizeBytes || (head.contentType !== undefined && head.contentType !== file.contentType)) {
    await discard(file);
    throw conflict(
      "upload_not_found",
      "The uploaded file does not match what was declared (size or type) and was removed",
    );
  }

  const stored = await markStored(file.id, head.etag ?? null);
  if (!stored) throw notFound("Invoice file not found");
  return c.json({ id: stored.id, fileName: stored.fileName }, 200);
});

invoicesRouter.openapi(linkRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { assetIds } = c.req.valid("json");
  const authz = c.get("authz");
  const file = await fileInScope(id, authz);
  // A file that was never confirmed does not exist as far as links go.
  if (file.uploadStatus !== "stored") throw notFound("Invoice file not found");

  const linked = await linkFile({
    file,
    assetIds,
    scope: readableEntities(authz),
    actor: { userId: c.get("userId"), email: c.get("email") },
  });
  return c.json({ linked }, 200);
});

invoicesRouter.openapi(urlRoute, async (c) => {
  const { id } = c.req.valid("param");
  const file = await fileInScope(id, c.get("authz"));
  if (file.uploadStatus !== "stored") throw notFound("Invoice file not found");

  // The upload window is short, but the key is fixed: re-check that the object
  // is still the one confirm verified (size, and ETag where one was recorded).
  const head = await storage.headObject(file.objectKey);
  if (!head || head.sizeBytes !== file.sizeBytes || (file.etag !== null && head.etag !== file.etag)) {
    throw notFound("Invoice file not found");
  }

  const url = await storage.mintPresignedGet(file.objectKey, {
    contentType: file.contentType as "application/pdf" | "image/jpeg" | "image/png",
    fileName: file.fileName,
    expiresInSeconds: DOWNLOAD_URL_SECONDS,
  });
  // The URL is a bearer credential for ~60 s: never cache it.
  c.header("Cache-Control", "no-store");
  return c.json({ url, expiresInSeconds: 60 as const }, 200);
});
