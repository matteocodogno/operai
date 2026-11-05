/**
 * An in-memory `TransientStorage` for tests and for `MEETINGS_AI_PROVIDER=fake` (dev, test and e2e only;
 * env.ts refuses the fake provider in production). Same contract as the real one: the same key layout, the
 * same refusal of any prefix that is not exactly one meeting's, and "an outage throws", so route and job tests
 * exercise the 503 and cleanup paths without a bucket. Nothing here touches the network.
 */

import { GoogleApiError } from "./auth";
import { TransientObjectTooLargeError, attemptOfKey, transientKeys, type TransientStorage } from "./transientStorage";

export interface TransientEvent {
  readonly op: "put" | "read" | "deletePrefix" | "deleteBefore";
  readonly key: string;
}

export interface FakeTransientStorage extends TransientStorage {
  /** Every call, in order (a rejected prefix is not recorded). */
  readonly events: readonly TransientEvent[];
  /** Every key currently stored, sorted. */
  keys(): string[];
  /** Seeds an object, as if Speech or an earlier attempt had written it. */
  seed(key: string, bytes: Uint8Array | string): void;
  /** Makes every following mutating or reading call throw `error`; `null` restores normal behaviour. */
  failWith(error: Error | null): void;
}

const BUCKET = "fake-transient-bucket";
const PREFIX_PATTERN = /^transcribe\/[A-Za-z0-9_-]{1,64}\/(?:[1-9][0-9]{0,2}\/)?$/;

export function createFakeTransientStorage(): FakeTransientStorage {
  const objects = new Map<string, Uint8Array>();
  const events: TransientEvent[] = [];
  let failure: Error | null = null;
  const check = () => {
    if (failure) throw failure;
  };

  return {
    events,
    keys: () => [...objects.keys()].sort(),
    seed(key, bytes) {
      objects.set(key, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
    },
    failWith(error) {
      failure = error;
    },
    uri: (key) => `gs://${BUCKET}/${key}`,
    keyOfUri(uri) {
      const head = `gs://${BUCKET}/`;
      return uri.startsWith(head) ? uri.slice(head.length) : null;
    },
    async put(key, body, signal) {
      signal?.throwIfAborted();
      check();
      events.push({ op: "put", key });
      if (objects.has(key)) throw new GoogleApiError(false, 412);
      objects.set(key, body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body);
    },
    async read(key, maxBytes, signal) {
      signal?.throwIfAborted();
      check();
      events.push({ op: "read", key });
      const bytes = objects.get(key);
      if (!bytes) throw new GoogleApiError(false, 404);
      if (bytes.byteLength > maxBytes) throw new TransientObjectTooLargeError();
      return bytes;
    },
    async deletePrefix(prefix) {
      if (!PREFIX_PATTERN.test(prefix)) throw new Error("prefix is not exactly one meeting's or one attempt's");
      check();
      events.push({ op: "deletePrefix", key: prefix });
      let deleted = 0;
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
    async deleteAttemptsBefore(meetingId, attempt) {
      const prefix = transientKeys.prefix(meetingId);
      if (!Number.isInteger(attempt) || attempt < 1 || attempt > 999) throw new Error("invalid attempt number");
      check();
      events.push({ op: "deleteBefore", key: `${prefix}<${attempt}` });
      let deleted = 0;
      for (const key of [...objects.keys()]) {
        const mine = key.startsWith(prefix) ? attemptOfKey(key) : null;
        if (mine !== null && mine < attempt) {
          objects.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}
