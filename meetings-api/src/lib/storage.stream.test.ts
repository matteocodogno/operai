import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { ObjectTooLargeError, createStorage } from "./storage";

// ADR-0064: the streaming read (to disk, bounded) and the audio.ogg put.

const dir = mkdtempSync(join(tmpdir(), "storage-stream-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function client(handler: (name: string, input: Record<string, unknown>) => unknown) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const c = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return handler(command.constructor.name, command.input);
    },
  } as unknown as S3Client;
  return { storage: createStorage({ client: c, bucket: "b" }), sent };
}

const body = (bytes: Uint8Array, parts = 3) => ({
  transformToWebStream: () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const step = Math.ceil(bytes.length / parts);
        for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.subarray(i, i + step));
        controller.close();
      },
    }),
});

describe("getObjectToFile", () => {
  it("streams the object to disk and reports the bytes written", async () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const { storage, sent } = client(() => ({ Body: body(bytes), ContentLength: bytes.length }));
    const dest = join(dir, "a.bin");
    expect(await storage.getObjectToFile("meetings/m1/chunks/000000", dest, 10_000)).toBe(5000);
    expect(new Uint8Array(readFileSync(dest))).toEqual(bytes);
    expect(sent[0]).toMatchObject({ name: "GetObjectCommand", input: { Bucket: "b", Key: "meetings/m1/chunks/000000" } });
  });

  it("refuses at once when the announced length is over the ceiling", async () => {
    const { storage } = client(() => ({ Body: body(new Uint8Array(100)), ContentLength: 100 }));
    await expect(storage.getObjectToFile("meetings/m1/original", join(dir, "b.bin"), 99)).rejects.toBeInstanceOf(ObjectTooLargeError);
  });

  it("stops a stream that outgrows the ceiling even when no length was announced", async () => {
    const { storage } = client(() => ({ Body: body(new Uint8Array(1000), 10) }));
    await expect(storage.getObjectToFile("meetings/m1/original", join(dir, "c.bin"), 500)).rejects.toBeInstanceOf(ObjectTooLargeError);
  });

  it("refuses a key outside the meetings layout", async () => {
    const { storage, sent } = client(() => ({}));
    await expect(storage.getObjectToFile("other/x", join(dir, "d.bin"), 10)).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("putAudioFile", () => {
  it("puts the file at the fixed audio.ogg key with an audio/ogg type and its exact length", async () => {
    const file = join(dir, "audio.ogg");
    writeFileSync(file, Buffer.from("OggS-test-bytes"));
    const { storage, sent } = client(() => ({}));
    expect(await storage.putAudioFile("m1", file)).toEqual({ sizeBytes: 15 });
    expect(sent[0]).toMatchObject({ name: "PutObjectCommand", input: { Bucket: "b", Key: "meetings/m1/audio.ogg", ContentType: "audio/ogg", ContentLength: 15 } });
  });

  it("refuses an empty file and a bad meeting id", async () => {
    const empty = join(dir, "empty.ogg");
    writeFileSync(empty, "");
    const { storage, sent } = client(() => ({}));
    await expect(storage.putAudioFile("m1", empty)).rejects.toThrow();
    await expect(storage.putAudioFile("../x", join(dir, "audio.ogg"))).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});
