/**
 * S3-compatible object storage wrapper (T9, specs/007-refund-service,
 * ADR-0016; +`putObject`, T2, specs/008-refund-monthly-processing,
 * ADR-0019).
 *
 * For RECEIPT bytes, refund-api's own process NEVER touches them — it only
 * mints presigned URLs (POST for upload, GET for download) and HEADs
 * objects to re-verify metadata at confirm time. Two-phase upload: mint →
 * browser uploads direct-to-bucket → confirm (HEAD re-validates
 * size/content-type).
 *
 * The compiled-batch PDF (T2) is the one exception: refund-api generates
 * those bytes itself (it authored them, unlike a receipt), so it legitimately
 * `PutObject`s them directly via `putObject` below, then serves them back
 * through the same `mintPresignedGet` pattern.
 *
 * DEPLOYMENT: the provisioned bucket is a Railway S3-compatible bucket in EU
 * Amsterdam — a custom, non-AWS endpoint. `forcePathStyle` and the EU-
 * residency startup assertion are both endpoint-aware (see
 * src/lib/s3Residency.ts) rather than assuming AWS.
 */

import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  NotFound,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";
import { needsPathStyleAddressing } from "./s3Residency";

// ─── Policy constants (ADR-0016 § Limits) ──────────────────────────────────

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB
export const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export function isAllowedContentType(
  contentType: string,
): contentType is AllowedContentType {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType);
}

// ─── S3 client (module-scope singleton) ─────────────────────────────────────

const s3 = new S3Client({
  region: env.REFUND_S3_REGION,
  endpoint: env.REFUND_S3_ENDPOINT,
  forcePathStyle: needsPathStyleAddressing(env.REFUND_S3_ENDPOINT),
  credentials: {
    accessKeyId: env.REFUND_S3_ACCESS_KEY_ID,
    secretAccessKey: env.REFUND_S3_SECRET_ACCESS_KEY,
  },
});

// ─── fileName sanitization (path-traversal defense, ADR-0016 § Key namespacing) ──

/**
 * Strips path separators, `..` traversal, and any character outside a safe
 * subset before the client-supplied `fileName` is embedded in an object key
 * (`refund/{requestId}/{lineId}/{attachmentId}/{safeName}`). The RAW
 * `fileName` is still stored verbatim as DISPLAY metadata (`Attachment.
 * fileName`) — only the KEY-embedded copy is sanitized.
 */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "file";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "") // no leading dots (hidden files / bare ".."]
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "file";
}

// ─── Presigned POST (mint) ──────────────────────────────────────────────────

export interface PresignedPostResult {
  readonly url: string;
  readonly fields: Record<string, string>;
}

/**
 * Mints a policy-constrained presigned POST — `content-length-range` capped
 * at MAX_ATTACHMENT_BYTES, `Content-Type` pinned to the exact value the
 * caller declared — enforced server-side, inside the signed policy itself,
 * so the browser cannot exceed either regardless of what it sends.
 */
export async function mintPresignedPost(
  objectKey: string,
  contentType: AllowedContentType,
): Promise<PresignedPostResult> {
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: env.REFUND_S3_BUCKET,
    Key: objectKey,
    Conditions: [
      ["content-length-range", 0, MAX_ATTACHMENT_BYTES],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: {
      "Content-Type": contentType,
    },
    Expires: 300, // seconds the POST policy itself remains valid
  });
  return { url, fields };
}

// ─── HEAD (confirm-time re-validation) ──────────────────────────────────────

export interface HeadResult {
  readonly sizeBytes: number;
  readonly contentType: string | undefined;
}

/** Returns `null` when the object does not exist (upload never completed). */
export async function headObject(objectKey: string): Promise<HeadResult | null> {
  try {
    const result = await s3.send(
      new HeadObjectCommand({ Bucket: env.REFUND_S3_BUCKET, Key: objectKey }),
    );
    return {
      sizeBytes: result.ContentLength ?? 0,
      contentType: result.ContentType,
    };
  } catch (err) {
    if (err instanceof NotFound) return null;
    // Some S3-compatible providers return a generic error shape rather than
    // the typed NotFound class — fall back to inspecting $metadata.httpStatusCode.
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw err;
  }
}

// ─── Presigned GET (download, authz-gated, minted last) ────────────────────

export async function mintPresignedGet(
  objectKey: string,
  expiresInSeconds = 60,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.REFUND_S3_BUCKET, Key: objectKey }),
    { expiresIn: expiresInSeconds },
  );
}

// ─── PutObject (server-authored bytes — batch PDFs only, T2/ADR-0019) ───────

/**
 * Uploads bytes refund-api generated itself (currently: only the compiled-
 * batch PDF, `src/batches/pdf.ts`). Unlike every other object in this
 * bucket, these bytes never pass through a presigned browser upload —
 * refund-api authored them, so it writes them directly.
 */
export async function putObject(
  objectKey: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.REFUND_S3_BUCKET,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function deleteObject(objectKey: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: env.REFUND_S3_BUCKET, Key: objectKey }),
  );
}
