/**
 * Test-only helpers for the tests that talk to a real S3-compatible bucket
 * (local MinIO from compose). Not imported by production code.
 */

import { storage } from "../lib/storage";

/**
 * Whether the configured bucket answers with working credentials. `null` means
 * yes; otherwise the reason, for a visible skip message. A HEAD of a key that
 * does not exist is a 404 (reachable, authorised); anything else is a fault.
 */
export async function probeBucket(): Promise<string | null> {
  try {
    await storage.headObject(`__probe__/${crypto.randomUUID()}`);
    return null;
  } catch (error) {
    const name = error instanceof Error ? error.name : "error";
    return `object storage unreachable or credentials rejected (${name}) — start it with: docker compose up -d minio minio-createbucket`;
  }
}

/** Uploads `bytes` the way a browser does: policy fields first, the file last. */
export async function postToPresigned(
  upload: { url: string; fields: Record<string, string> },
  bytes: Uint8Array,
  contentType: string,
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
  form.append("file", new Blob([bytes], { type: contentType }), "upload.bin");
  return fetch(upload.url, { method: "POST", body: form });
}
