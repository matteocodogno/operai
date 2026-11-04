/**
 * S3-compatible object storage for meeting audio (specs/021-meetings, ADR-0016
 * posture, ADR-0063). Adapted from crm-api/src/lib/storage.ts.
 *
 * The bucket holds ONLY audio: recording chunks, an uploaded original, and the
 * normalised `audio.ogg`. Transcripts and everything else live in Postgres. One
 * bucket-wide lifecycle rule removes every object within 30 days of creation;
 * `startupChecks.ts` refuses to start unless that rule is there.
 *
 * meetings-api never proxies a file a client asked for:
 * - chunks and uploaded originals go up through a presigned POST (the browser
 *   uploads straight to the EU bucket) and are HEADed at confirm time;
 * - playback is a presigned GET minted after the visibility check.
 * The bucket is private; there is no other client-facing path. (The service does
 * READ bytes itself to normalise audio: ADR-0064, a separate, bounded reader.)
 *
 * Every key is built here, from a meeting id and a number, and checked again
 * before use: a caller cannot name the key it writes, and no method can reach
 * outside `meetings/<id>/`.
 *
 * Routes call the wired instance's methods (never destructure them) so a test can
 * replace it with `setStorageForTests`.
 */

import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NotFound,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";
import { needsPathStyleAddressing } from "./s3Residency";

// ─── Policy ──────────────────────────────────────────────────────────────────

/** One recorded chunk: 10 s of opus at 32 kbit/s is tens of KB; 8 MiB is a generous ceiling (plan.md). */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** AC-3.1: an uploaded file is at most 500 MiB (and 3 h, checked by ffprobe at confirm). */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Audio and video containers a user may upload (AC-3.2). Anything else is refused before it is stored. */
export const UPLOAD_CONTENT_TYPES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

export const isUploadContentType = (value: string): value is UploadContentType =>
  (UPLOAD_CONTENT_TYPES as readonly string[]).includes(value);

/** The chunk policy is valid 5 minutes (plan.md § Browser capture); the client re-mints after that. */
export const CHUNK_POST_SECONDS = 5 * 60;
/** The upload policy is valid 30 minutes (plan.md § Capture: `POST /meetings/:id/upload`). */
export const UPLOAD_POST_SECONDS = 30 * 60;
/** A GET handed to ffprobe at upload confirm. */
export const PROBE_GET_SECONDS = 60;
/** Playback: `<audio>` makes range requests for the whole listening session (plan.md § Other decisions). */
export const PLAYBACK_GET_SECONDS = 15 * 60;

/** `audio.ogg` is opus in an ogg container. Pinned on the response so a stored object can never be served as HTML. */
const PLAYBACK_CONTENT_TYPE = "audio/ogg";

// ─── Keys ────────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SEQ = 999_999;
const KEY_PATTERN = /^meetings\/[A-Za-z0-9_-]{1,64}\/(chunks\/\d{6}|original|audio\.ogg)$/;
const PREFIX_PATTERN = /^meetings\/[A-Za-z0-9_-]{1,64}\/$/;

function assertMeetingId(meetingId: string): void {
  if (!ID_PATTERN.test(meetingId)) throw new Error("invalid meeting id for an object key");
}

export const objectKeys = {
  /** Everything stored for one meeting. */
  prefix(meetingId: string): string {
    assertMeetingId(meetingId);
    return `meetings/${meetingId}/`;
  },
  chunk(meetingId: string, seq: number): string {
    assertMeetingId(meetingId);
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) throw new Error("invalid chunk sequence number");
    return `meetings/${meetingId}/chunks/${String(seq).padStart(6, "0")}`;
  },
  /** The uploaded file as received (audio or video); deleted once `audio.ogg` exists. */
  original(meetingId: string): string {
    assertMeetingId(meetingId);
    return `meetings/${meetingId}/original`;
  },
  /** The normalised mono 16 kHz opus audio (AC-3.1). */
  audio(meetingId: string): string {
    assertMeetingId(meetingId);
    return `meetings/${meetingId}/audio.ogg`;
  },
} as const;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error("object key is outside the meetings layout");
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface PresignedPost {
  readonly url: string;
  readonly fields: Record<string, string>;
  /** ISO 8601; when the policy stops being accepted. */
  readonly expiresAt: string;
}

export interface HeadResult {
  readonly sizeBytes: number;
  readonly contentType: string | undefined;
}

export interface Storage {
  /** Key `meetings/<id>/chunks/<seq>`, size 1..8 MiB, an `audio/*` content type, 5 minutes. */
  mintChunkPost(meetingId: string, seq: number): Promise<PresignedPost>;
  /** Key `meetings/<id>/original`, size 1..500 MiB, exactly `contentType` (allowlisted), 30 minutes. */
  mintUploadPost(meetingId: string, contentType: string): Promise<PresignedPost>;
  /** A 60 s GET for ffprobe at upload confirm. */
  mintProbeGet(objectKey: string): Promise<string>;
  /** A 15 min GET for `<audio>`; mint only after the visibility check. */
  mintPlaybackGet(objectKey: string): Promise<{ url: string; expiresAt: string }>;
  /** `null` when the object does not exist. Any other failure throws: an outage is not "missing". */
  headObject(objectKey: string): Promise<HeadResult | null>;
  deleteObject(objectKey: string): Promise<void>;
  /**
   * Deletes every object under exactly one meeting's prefix (`meetings/<id>/`) and
   * returns how many. Throws, having possibly deleted some, when the store fails or
   * reports a key it could not delete: the caller answers 503 and changes nothing
   * in the database (AC-4.5/4.6). Any other prefix is refused.
   */
  deletePrefix(prefix: string): Promise<number>;
}

const DELETE_BATCH = 1000;

export function createStorage(deps: { client: S3Client; bucket: string }): Storage {
  const { client, bucket } = deps;
  const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  return {
    async mintChunkPost(meetingId, seq) {
      const key = objectKeys.chunk(meetingId, seq);
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ["content-length-range", 1, MAX_CHUNK_BYTES],
          // MediaRecorder reports audio/webm (Chromium, Firefox) or audio/mp4 (Safari): any audio type.
          ["starts-with", "$Content-Type", "audio/"],
        ],
        Expires: CHUNK_POST_SECONDS,
      });
      return { url, fields, expiresAt: inSeconds(CHUNK_POST_SECONDS) };
    },

    async mintUploadPost(meetingId, contentType) {
      if (!isUploadContentType(contentType)) throw new Error("content type is not an accepted audio or video type");
      const key = objectKeys.original(meetingId);
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ["content-length-range", 1, MAX_UPLOAD_BYTES],
          ["eq", "$Content-Type", contentType],
        ],
        Fields: { "Content-Type": contentType },
        Expires: UPLOAD_POST_SECONDS,
      });
      return { url, fields, expiresAt: inSeconds(UPLOAD_POST_SECONDS) };
    },

    async mintProbeGet(objectKey) {
      assertKey(objectKey);
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), {
        expiresIn: PROBE_GET_SECONDS,
      });
    },

    async mintPlaybackGet(objectKey) {
      assertKey(objectKey);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: objectKey, ResponseContentType: PLAYBACK_CONTENT_TYPE }),
        { expiresIn: PLAYBACK_GET_SECONDS },
      );
      return { url, expiresAt: inSeconds(PLAYBACK_GET_SECONDS) };
    },

    async headObject(objectKey) {
      assertKey(objectKey);
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType };
      } catch (err) {
        if (err instanceof NotFound) return null;
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw err;
      }
    },

    async deleteObject(objectKey) {
      assertKey(objectKey);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    },

    async deletePrefix(prefix) {
      // Exactly `meetings/<id>/`: an empty or shorter prefix would wipe other meetings.
      if (!PREFIX_PATTERN.test(prefix)) throw new Error("prefix is not exactly one meeting's");
      let deleted = 0;
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }),
        );
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
        for (let i = 0; i < keys.length; i += DELETE_BATCH) {
          const batch = keys.slice(i, i + DELETE_BATCH);
          const result = await client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
          );
          if ((result.Errors ?? []).length > 0) {
            // Codes only: a key carries a meeting id, which is an identifier but still not worth echoing.
            throw new Error(`storage refused to delete ${result.Errors!.length} object(s) under a meeting prefix`);
          }
          deleted += batch.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return deleted;
    },
  };
}

// ─── The wired instance ──────────────────────────────────────────────────────

/** The S3 client for the configured bucket. Shared with the startup checks. */
export function createS3Client(): S3Client {
  return new S3Client({
    region: env.MEETINGS_S3_REGION,
    endpoint: env.MEETINGS_S3_ENDPOINT,
    forcePathStyle: needsPathStyleAddressing(env.MEETINGS_S3_ENDPOINT),
    credentials: {
      accessKeyId: env.MEETINGS_S3_ACCESS_KEY_ID,
      secretAccessKey: env.MEETINGS_S3_SECRET_ACCESS_KEY,
    },
  });
}

let current: Storage | null = null;

/** The configured storage. Storage is required configuration (env.ts), so there is no "unconfigured" branch. */
export function requireStorage(): Storage {
  current ??= createStorage({ client: createS3Client(), bucket: env.MEETINGS_S3_BUCKET });
  return current;
}

/** Tests only: swap in a fake. */
export function setStorageForTests(storage: Storage | null): void {
  current = storage;
}
