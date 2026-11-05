/**
 * The transient processing bucket (specs/021-meetings plan.md § Amendment 2026-11-05 G-2, ADR-0069; AC-4.5,
 * AC-4.6, AC-4.9, AC-4.12): the one place Google can read audio from. Chirp 3 `BatchRecognize` accepts only
 * `gs://` URIs, so each `transcribe` attempt stages its parts here and Speech writes its output beside them.
 * Bytes live here only while one attempt runs; Railway's bucket stays the only place audio is KEPT (ADR-0063).
 *
 *   transcribe/<meetingId>/<attempt>/in/<n>.ogg     the parts we upload
 *   transcribe/<meetingId>/<attempt>/out/...        what Speech writes
 *
 * Names carry identifiers only (no title, no content, AC-4.10): Google's residency guarantee excludes
 * resource metadata such as object names.
 *
 * REGIONAL ENDPOINT ONLY. Every object call goes to `https://storage.<location>.rep.googleapis.com`, derived
 * from the location the bucket reports, never configured: regional endpoints keep object data at rest AND in
 * transit in that location and refuse the request if the bucket is elsewhere. The one metadata read (startup
 * and first use) goes to the global JSON endpoint; it carries no content.
 *
 * REST through `fetch`, not `@google-cloud/storage` (a large dependency for five JSON-API calls that would hide
 * the very URL the residency check pins).
 *
 * `deletePrefix` takes EXACTLY `transcribe/<meetingId>/` (the delete routes: every attempt) or
 * `transcribe/<meetingId>/<attempt>/` (one attempt: an attempt cleans up after itself only, because a stale one
 * must not delete what a newer attempt of the same meeting has staged), as the Railway storage does for
 * `meetings/<id>/`: a shorter prefix would wipe other meetings' attempts. `deleteAttemptsBefore` is the start of
 * an attempt: it clears the leftovers of OLDER attempts only.
 */

import { GoogleApiError, defaultFetch, googleAuth, googleFetch, toGoogleApiError, type GoogleAuth } from "./auth";
import { TRANSIENT_BUCKET_ALLOWED_LOCATIONS } from "../residency";

const ID = "[A-Za-z0-9_-]{1,64}";
const PREFIX_PATTERN = new RegExp(`^transcribe/${ID}/(?:[1-9][0-9]{0,2}/)?$`);
const KEY_PATTERN = new RegExp(`^transcribe/${ID}/${ID}/(in|out)/(?!\\.+$)[A-Za-z0-9._=-]{1,200}$`);
const ID_PATTERN = new RegExp(`^${ID}$`);
/** The one prefix Speech is given as its output location: exactly one attempt's `out/`. */
const OUTPUT_PREFIX_PATTERN = new RegExp(`^transcribe/${ID}/[1-9][0-9]{0,2}/out/$`);
/** Whether `key` is an object name of the transient layout (`in/` or `out/`, never a prefix). Fakes share it. */
export const isTransientKey = (key: string): boolean => KEY_PATTERN.test(key);
/** Whether `prefix` is exactly one attempt's `out/` prefix. Fakes share it. */
export const isOutputPrefix = (prefix: string): boolean => OUTPUT_PREFIX_PATTERN.test(prefix);

/** 2 min per part upload (plan § G-9). */
const UPLOAD_TIMEOUT_MS = 2 * 60_000;
const READ_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 30_000;
const DELETE_PARALLELISM = 8;

export const GLOBAL_STORAGE_HOST = "storage.googleapis.com";

/** The object names of one attempt. Everything is built from ids that are checked, never from free text. */
export const transientKeys = {
  /** Everything staged for one meeting, whatever the attempt. The only prefix `deletePrefix` accepts. */
  prefix(meetingId: string): string {
    assertId(meetingId);
    return `transcribe/${meetingId}/`;
  },
  attemptPrefix(meetingId: string, attempt: number): string {
    assertId(meetingId);
    assertAttempt(attempt);
    return `transcribe/${meetingId}/${attempt}/`;
  },
  input(meetingId: string, attempt: number, part: number): string {
    if (!Number.isInteger(part) || part < 1 || part > 999) throw new Error("invalid part number");
    return `${this.attemptPrefix(meetingId, attempt)}in/${part}.ogg`;
  },
  /** Where Speech writes this attempt's output (a prefix, with a trailing slash). */
  outputPrefix(meetingId: string, attempt: number): string {
    return `${this.attemptPrefix(meetingId, attempt)}out/`;
  },
} as const;

function assertId(meetingId: string): void {
  if (!ID_PATTERN.test(meetingId)) throw new Error("invalid meeting id for a transient object key");
}

/** The attempt number in `transcribe/<id>/<attempt>/...`, or null when the key has none that is a number. */
export function attemptOfKey(key: string): number | null {
  const match = new RegExp(`^transcribe/${ID}/([1-9][0-9]{0,2})/`).exec(key);
  return match ? Number(match[1]) : null;
}

function assertAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 999) throw new Error("invalid attempt number");
}

/** An object over the caller's ceiling. Never carries the key. */
export class TransientObjectTooLargeError extends Error {
  constructor() {
    super("transient object exceeds the size limit");
    this.name = "TransientObjectTooLargeError";
  }
}

export interface TransientStorage {
  /** `gs://<bucket>/<key>`, the form Speech takes. */
  uri(key: string): string;
  /**
   * `gs://<bucket>/transcribe/<id>/<attempt>/out/`: where Speech is told to write. A PREFIX (T107: the real
   * `uri()` refuses it, as it only names objects), and only an attempt's own `out/`.
   */
  prefixUri(prefix: string): string;
  /** The key behind a `gs://<bucket>/<key>` URI of THIS bucket, or null for anything else. */
  keyOfUri(uri: string): string | null;
  /** Creates the object; refuses to overwrite one (`ifGenerationMatch=0`). */
  put(key: string, body: Blob | Uint8Array, signal?: AbortSignal): Promise<void>;
  /** At most `maxBytes` of the object; `TransientObjectTooLargeError` otherwise, before the rest is read. */
  read(key: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Deletes everything under `transcribe/<meetingId>/` or `transcribe/<meetingId>/<attempt>/` (and only that); returns how many objects went. */
  deletePrefix(prefix: string): Promise<number>;
  /** Deletes what attempts numbered BELOW `attempt` staged for the meeting; this attempt and later ones are untouched. */
  deleteAttemptsBefore(meetingId: string, attempt: number): Promise<number>;
}

export interface TransientStorageOptions {
  readonly bucket: string;
  /** The bucket's location as Google reports it (`EU`, `EUROPE-WEST4`): lowercased into the endpoint host. */
  readonly location: string;
  readonly auth: GoogleAuth;
  readonly fetchImpl?: typeof fetch;
}

/** The regional endpoint for a bucket location. */
export const regionalHost = (location: string): string => `storage.${location.toLowerCase()}.rep.googleapis.com`;

export function createTransientStorage(options: TransientStorageOptions): TransientStorage {
  const { bucket, auth } = options;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const host = regionalHost(options.location);
  const bucketPath = encodeURIComponent(bucket);
  const assertKey = (key: string) => {
    if (!KEY_PATTERN.test(key)) throw new Error("object key is outside the transient layout");
  };

  return {
    uri: (key) => {
      assertKey(key);
      return `gs://${bucket}/${key}`;
    },
    prefixUri: (prefix) => {
      if (!OUTPUT_PREFIX_PATTERN.test(prefix)) throw new Error("prefix is not one attempt's output prefix");
      return `gs://${bucket}/${prefix}`;
    },
    keyOfUri(uri) {
      const head = `gs://${bucket}/`;
      if (!uri.startsWith(head)) return null;
      const key = uri.slice(head.length);
      return KEY_PATTERN.test(key) ? key : null;
    },

    async put(key, body, signal) {
      assertKey(key);
      const url =
        `https://${host}/upload/storage/v1/b/${bucketPath}/o` +
        `?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(key)}`;
      await googleFetch(auth, fetchImpl, url, {
        method: "POST",
        headers: { "Content-Type": "audio/ogg" },
        body,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
    },

    async read(key, maxBytes, signal) {
      assertKey(key);
      const url = `https://${host}/download/storage/v1/b/${bucketPath}/o/${encodeURIComponent(key)}?alt=media`;
      const response = await googleFetch(auth, fetchImpl, url, {
        timeoutMs: READ_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new TransientObjectTooLargeError();
      }
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new TransientObjectTooLargeError();
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof TransientObjectTooLargeError) throw error;
        throw new GoogleApiError(true);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },

    async deletePrefix(prefix) {
      // `transcribe/<id>/` or `transcribe/<id>/<attempt>/`: an empty or shorter prefix would wipe other meetings.
      if (!PREFIX_PATTERN.test(prefix)) throw new Error("prefix is not exactly one meeting's or one attempt's");
      return purge(prefix, () => true);
    },

    async deleteAttemptsBefore(meetingId, attempt) {
      const prefix = transientKeys.prefix(meetingId);
      assertAttempt(attempt);
      return purge(prefix, (name) => {
        const mine = attemptOfKey(name);
        return mine !== null && mine < attempt;
      });
    },
  };

  async function purge(prefix: string, selected: (name: string) => boolean): Promise<number> {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ prefix, fields: "items(name),nextPageToken" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await googleFetch(auth, fetchImpl, `https://${host}/storage/v1/b/${bucketPath}/o?${query}`, {
        timeoutMs: CONTROL_TIMEOUT_MS,
      });
      const page = (await response.json().catch(() => null)) as { items?: { name?: unknown }[]; nextPageToken?: unknown } | null;
      if (page === null || typeof page !== "object") throw new GoogleApiError(true);
      for (const item of page.items ?? []) {
        // Belt and braces: whatever the listing says, only names under the prefix are ever deleted.
        if (typeof item.name === "string" && item.name.startsWith(prefix) && selected(item.name)) names.push(item.name);
      }
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    } while (pageToken);

    let deleted = 0;
    for (let i = 0; i < names.length; i += DELETE_PARALLELISM) {
      const batch = names.slice(i, i + DELETE_PARALLELISM);
      await Promise.all(
        batch.map(async (name) => {
          // 404: already gone (a lifecycle rule, a concurrent cleanup): that is the goal.
          const response = await googleFetch(
            auth,
            fetchImpl,
            `https://${host}/storage/v1/b/${bucketPath}/o/${encodeURIComponent(name)}`,
            { method: "DELETE", timeoutMs: CONTROL_TIMEOUT_MS, allow: [404] },
          );
          await response.body?.cancel().catch(() => {});
        }),
      );
      deleted += batch.length;
    }
    return deleted;
  }
}

// ─── The bucket's own configuration (metadata read) ─────────────────────────

/** The members of a bucket resource this service reads (N2). Everything is optional: absent = unreadable. */
export interface BucketConfig {
  readonly location?: unknown;
  readonly lifecycle?: { rule?: { action?: { type?: unknown }; condition?: Record<string, unknown> }[] };
  readonly versioning?: { enabled?: unknown };
  readonly softDeletePolicy?: { retentionDurationSeconds?: unknown };
  readonly retentionPolicy?: unknown;
  readonly defaultEventBasedHold?: unknown;
  readonly iamConfiguration?: {
    uniformBucketLevelAccess?: { enabled?: unknown };
    publicAccessPrevention?: unknown;
  };
}

const CONFIG_FIELDS = "location,lifecycle,versioning,softDeletePolicy,retentionPolicy,defaultEventBasedHold,iamConfiguration";

/**
 * Reads the bucket's configuration from the GLOBAL JSON endpoint (it carries no content). `maxAttempts` 2: a
 * control-plane blip should not stop a deploy (plan R21), but a persistent failure must (fail closed).
 */
export async function readBucketConfig(options: {
  bucket: string;
  auth: GoogleAuth;
  fetchImpl?: typeof fetch;
}): Promise<BucketConfig> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const url = `https://${GLOBAL_STORAGE_HOST}/storage/v1/b/${encodeURIComponent(options.bucket)}?fields=${CONFIG_FIELDS}`;
  let last: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await googleFetch(options.auth, fetchImpl, url, { timeoutMs: CONTROL_TIMEOUT_MS });
      const body = (await response.json()) as unknown;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new GoogleApiError(false);
      return body as BucketConfig;
    } catch (error) {
      last = error;
      if (!(error instanceof GoogleApiError) && !(error instanceof SyntaxError)) throw toGoogleApiError(error);
      if (error instanceof GoogleApiError && !error.transient) break;
    }
  }
  throw toGoogleApiError(last);
}

// ─── The wired instance ──────────────────────────────────────────────────────

let current: Promise<TransientStorage> | null = null;

/**
 * The transient storage for this process. Real provider: the configured bucket, whose location is read once and
 * kept (a bucket's location cannot change). Fake provider (dev and test; env.ts refuses it in production): an
 * in-memory fake that never touches the network, so deletion paths run unchanged.
 */
export function requireTransientStorage(): Promise<TransientStorage> {
  current ??= build().catch((error: unknown) => {
    current = null; // a failed first read is retried by the next caller
    throw error;
  });
  return current;
}

async function build(): Promise<TransientStorage> {
  const { env } = await import("../env");
  if (env.MEETINGS_AI_PROVIDER === "fake") {
    const { createFakeTransientStorage } = await import("./fakeTransientStorage");
    return createFakeTransientStorage();
  }
  const auth = await googleAuth();
  const bucket = env.MEETINGS_GCS_TRANSIENT_BUCKET!;
  return createTransientStorageForBucket({ bucket, auth });
}

/**
 * The storage for a bucket whose location is read NOW and checked against the EU/CH allowlist again before the
 * regional host is built from it (defence in depth: startup proved it once, but the bucket named in the
 * configuration could since have been deleted and recreated elsewhere, and a host built from an unchecked
 * location would send audio there). A location that is missing or not allowed is a refusal, not a guess.
 */
export async function createTransientStorageForBucket(options: {
  bucket: string;
  auth: GoogleAuth;
  fetchImpl?: typeof fetch;
}): Promise<TransientStorage> {
  const config = await readBucketConfig(options);
  const location = typeof config.location === "string" ? config.location.toUpperCase() : "";
  if (!(TRANSIENT_BUCKET_ALLOWED_LOCATIONS as readonly string[]).includes(location)) throw new GoogleApiError(false);
  return createTransientStorage({
    bucket: options.bucket,
    location,
    auth: options.auth,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

/** Tests only: install a storage (or `null` to rebuild from the environment). */
export function setTransientStorageForTests(replacement: TransientStorage | null): void {
  current = replacement ? Promise.resolve(replacement) : null;
}
