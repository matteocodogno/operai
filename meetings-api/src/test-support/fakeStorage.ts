/**
 * An in-memory `Storage` for tests (specs/021-meetings). It keeps the same
 * contract as the real one: the same fixed keys, the same refusals (a content
 * type outside the allowlist, a prefix that is not exactly one meeting's), and
 * the same "an outage throws" behaviour, so route tests exercise the 503 paths
 * without a bucket. Nothing here touches the network.
 */

import {
  CHUNK_POST_SECONDS,
  PLAYBACK_GET_SECONDS,
  UPLOAD_POST_SECONDS,
  isUploadContentType,
  objectKeys,
  type HeadResult,
  type PresignedPost,
  type Storage,
} from "../lib/storage";

export interface FakeStorage extends Storage {
  /** Simulates an upload that landed in the bucket. */
  put(objectKey: string, sizeBytes: number, contentType?: string): void;
  /** Every key currently stored, sorted. */
  keys(): string[];
  /** Makes every following call throw `error`; `null` restores normal behaviour. */
  failWith(error: Error | null): void;
  /** The posts minted so far, in order. */
  readonly minted: readonly { kind: "chunk" | "upload"; key: string }[];
}

const PREFIX_PATTERN = /^meetings\/[A-Za-z0-9_-]{1,64}\/$/;

export function createFakeStorage(): FakeStorage {
  const objects = new Map<string, HeadResult>();
  const minted: { kind: "chunk" | "upload"; key: string }[] = [];
  let failure: Error | null = null;
  const check = () => {
    if (failure) throw failure;
  };
  const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  const post = (key: string, seconds: number, extra: Record<string, string> = {}): PresignedPost => ({
    url: "http://storage.fake/meetings-bucket",
    fields: { key, ...extra },
    expiresAt: inSeconds(seconds),
  });

  return {
    minted,
    put(objectKey, sizeBytes, contentType) {
      objects.set(objectKey, { sizeBytes, contentType });
    },
    keys: () => [...objects.keys()].sort(),
    failWith(error) {
      failure = error;
    },

    async mintChunkPost(meetingId, seq) {
      check();
      const key = objectKeys.chunk(meetingId, seq);
      minted.push({ kind: "chunk", key });
      return post(key, CHUNK_POST_SECONDS);
    },
    async mintUploadPost(meetingId, contentType) {
      check();
      if (!isUploadContentType(contentType)) throw new Error("content type is not an accepted audio or video type");
      const key = objectKeys.original(meetingId);
      minted.push({ kind: "upload", key });
      return post(key, UPLOAD_POST_SECONDS, { "Content-Type": contentType });
    },
    async mintProbeGet(objectKey) {
      check();
      return `http://storage.fake/meetings-bucket/${objectKey}?probe=1`;
    },
    async mintPlaybackGet(objectKey) {
      check();
      return { url: `http://storage.fake/meetings-bucket/${objectKey}?playback=1`, expiresAt: inSeconds(PLAYBACK_GET_SECONDS) };
    },
    async headObject(objectKey) {
      check();
      return objects.get(objectKey) ?? null;
    },
    async deleteObject(objectKey) {
      check();
      objects.delete(objectKey);
    },
    async deletePrefix(prefix) {
      check();
      if (!PREFIX_PATTERN.test(prefix)) throw new Error("prefix is not exactly one meeting's");
      let deleted = 0;
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          deleted++;
        }
      }
      return deleted;
    },
  };
}
