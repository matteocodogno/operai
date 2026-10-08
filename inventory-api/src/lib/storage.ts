/**
 * S3-compatible object storage for invoice files (T21, specs/015-hardware-
 * inventory; AC-10.4, AC-10.6, AC-10.7; ADR-0016 posture). Ported from
 * refund-api/src/lib/storage.ts, minus the paths inventory has no use for
 * (no PutObject of server-authored bytes, no GetObject: ADR-0043's bounded
 * departure is refund-api's alone).
 *
 * inventory-api NEVER touches invoice bytes. It mints a presigned POST (the
 * browser uploads straight to the EU bucket), HEADs the object at confirm time
 * to re-verify what actually landed, and mints a ~60 s presigned GET after the
 * entity-scope check. The bucket is private; there is no other read path.
 *
 * `createStorage` takes its client so tests stub `send` (HEAD/DELETE) and still
 * get REAL signing; `storage` (bottom) is the one wired from `INVENTORY_S3_*`.
 * Routes call the wired instance's methods (never destructure them) so a test
 * can `spyOn(storage, "headObject")`.
 */

import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  NotFound,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";
import { needsPathStyleAddressing } from "./s3Residency";

// ─── Policy (AC-10.4, AC-10.6) ───────────────────────────────────────────────

export const MAX_INVOICE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const ALLOWED_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const isAllowedContentType = (contentType: string): contentType is AllowedContentType =>
  (ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType);

/** Seconds the presigned POST policy stays valid. */
const POST_EXPIRES_SECONDS = 300;
/** Seconds a presigned GET stays valid (AC-10.4 "short-lived"). */
export const DOWNLOAD_URL_SECONDS = 60;

// ─── Names ───────────────────────────────────────────────────────────────────

/**
 * The copy of a client file name that is embedded in an object KEY: path
 * separators, traversal and every character outside a safe subset are removed.
 * The key itself is server-generated (`inventory/{entity}/{id}/{safeName}`);
 * the client name never decides where an object lives.
 */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "file";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "file";
}

/**
 * The name that is STORED and SHOWN (asset panel, history events, download
 * header): the client's own name, minus path components, control characters and
 * bidi overrides (a file shown as `invoice‮fdp.exe` is a classic spoof),
 * whitespace collapsed, clipped to 200 characters. Never empty.
 */
export function displayFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 200)
    .trim();
  return cleaned.length > 0 ? cleaned : "invoice";
}

/**
 * `Content-Disposition` for the download: an ASCII `filename` fallback plus the
 * RFC 5987 `filename*` for the real name, so no header-splitting character can
 * survive and a non-ASCII name still round-trips. `inline` because the panel
 * opens the file in a new tab; the type is pinned separately (see
 * `mintPresignedGet`), so inline cannot be used to render anything but
 * pdf/jpeg/png.
 */
export function contentDisposition(fileName: string): string {
  const ascii = sanitizeFileName(fileName);
  const encoded = encodeURIComponent(displayFileName(fileName)).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface PresignedPostResult {
  readonly url: string;
  readonly fields: Record<string, string>;
}

export interface HeadResult {
  readonly sizeBytes: number;
  readonly contentType: string | undefined;
}

export interface Storage {
  /**
   * A policy-constrained presigned POST: `content-length-range` 1..10 MiB and
   * `Content-Type` pinned to the declared value, both enforced by the bucket
   * itself inside the signed policy.
   */
  mintPresignedPost(objectKey: string, contentType: AllowedContentType): Promise<PresignedPostResult>;
  /** `null` when the object does not exist (the upload never completed). */
  headObject(objectKey: string): Promise<HeadResult | null>;
  /**
   * A presigned GET. The response type and disposition are OVERRIDDEN in the
   * signed URL from what this service recorded, never taken from the object's
   * own metadata.
   */
  mintPresignedGet(
    objectKey: string,
    options: { contentType: AllowedContentType; fileName: string; expiresInSeconds?: number },
  ): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}

export function createStorage(deps: { client: S3Client; bucket: string }): Storage {
  const { client, bucket } = deps;
  return {
    async mintPresignedPost(objectKey, contentType) {
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: objectKey,
        Conditions: [
          ["content-length-range", 1, MAX_INVOICE_BYTES],
          ["eq", "$Content-Type", contentType],
        ],
        Fields: { "Content-Type": contentType },
        Expires: POST_EXPIRES_SECONDS,
      });
      return { url, fields };
    },

    async headObject(objectKey) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType };
      } catch (err) {
        if (err instanceof NotFound) return null;
        // Some S3-compatible providers answer with a generic error rather than
        // the typed NotFound: look at the HTTP status.
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw err;
      }
    },

    async mintPresignedGet(objectKey, options) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          ResponseContentType: options.contentType,
          ResponseContentDisposition: contentDisposition(options.fileName),
        }),
        { expiresIn: options.expiresInSeconds ?? DOWNLOAD_URL_SECONDS },
      );
    },

    async deleteObject(objectKey) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    },
  };
}

/** The instance wired from `INVENTORY_S3_*` (EU-residency checked at startup by env.ts). */
export const storage: Storage = createStorage({
  bucket: env.INVENTORY_S3_BUCKET,
  client: new S3Client({
    region: env.INVENTORY_S3_REGION,
    endpoint: env.INVENTORY_S3_ENDPOINT,
    forcePathStyle: needsPathStyleAddressing(env.INVENTORY_S3_ENDPOINT),
    credentials: {
      accessKeyId: env.INVENTORY_S3_ACCESS_KEY_ID,
      secretAccessKey: env.INVENTORY_S3_SECRET_ACCESS_KEY,
    },
  }),
});
