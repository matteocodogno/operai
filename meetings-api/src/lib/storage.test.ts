import { describe, expect, it } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import {
  MAX_CHUNK_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_CONTENT_TYPES,
  createStorage,
  objectKeys,
  type Storage,
} from "./storage";
import { createFakeStorage } from "../test-support/fakeStorage";

// A client that signs locally with throwaway credentials: presigning never calls the network.
const signing = () =>
  new S3Client({
    region: "eu-central-1",
    endpoint: "http://storage.test",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret-test-key" },
  });

const TOKEN = "11111111-1111-4111-8111-111111111111";
const storage = (): Storage => createStorage({ client: signing(), bucket: "meetings-test" });

type PolicyCondition = Record<string, string> | [string, ...unknown[]];
const policyOf = (fields: Record<string, string>) =>
  JSON.parse(Buffer.from(fields["Policy"]!, "base64").toString("utf8")) as { expiration: string; conditions: PolicyCondition[] };
const has = (conditions: PolicyCondition[], expected: unknown) =>
  conditions.some((c) => JSON.stringify(c) === JSON.stringify(expected));

describe("object keys are fixed server-side", () => {
  it("lays out one prefix per meeting", () => {
    expect(objectKeys.prefix("m1")).toBe("meetings/m1/");
    expect(objectKeys.chunk("m1", 0)).toBe("meetings/m1/chunks/000000");
    expect(objectKeys.chunk("m1", 123456)).toBe("meetings/m1/chunks/123456");
    expect(objectKeys.upload("m1", TOKEN)).toBe(`meetings/m1/upload/${TOKEN}`);
    expect(objectKeys.uploadPrefix("m1")).toBe("meetings/m1/upload/");
    expect(objectKeys.audio("m1")).toBe("meetings/m1/audio.ogg");
  });

  it("refuses an id that could escape the prefix, and a seq that is not a chunk number", () => {
    for (const id of ["", "../x", "a/b", "a b", "x".repeat(65), "m1/"]) expect(() => objectKeys.prefix(id)).toThrow();
    for (const seq of [-1, 1.5, 1_000_000, Number.NaN]) expect(() => objectKeys.chunk("m1", seq)).toThrow();
    for (const token of ["", "original", "../x", "11111111-1111-4111-8111-11111111111Z"]) expect(() => objectKeys.upload("m1", token)).toThrow();
  });
});

describe("chunk upload policy (presigned POST)", () => {
  it("pins the key, the size range 1..8 MiB and an audio content type, for 5 minutes", async () => {
    const before = Date.now();
    const post = await storage().mintChunkPost("m1", 7);
    const policy = policyOf(post.fields);

    expect(post.url).toContain("meetings-test");
    expect(has(policy.conditions, { key: "meetings/m1/chunks/000007" })).toBe(true);
    expect(has(policy.conditions, { bucket: "meetings-test" })).toBe(true);
    expect(has(policy.conditions, ["content-length-range", 1, 8 * 1024 * 1024])).toBe(true);
    expect(MAX_CHUNK_BYTES).toBe(8 * 1024 * 1024);
    expect(has(policy.conditions, ["starts-with", "$Content-Type", "audio/"])).toBe(true);

    const expiresAt = Date.parse(post.expiresAt);
    expect(expiresAt - before).toBeGreaterThan(299_000);
    expect(expiresAt - before).toBeLessThan(301_500);
    expect(Math.abs(Date.parse(policy.expiration) - expiresAt)).toBeLessThan(2_000);
  });

  it("gives the same key for the same seq: the client cannot choose where it writes", async () => {
    const a = await storage().mintChunkPost("m1", 3);
    const b = await storage().mintChunkPost("m1", 3);
    expect(a.fields["key"]).toBe(b.fields["key"]);
  });
});

describe("original upload policy (presigned POST)", () => {
  it("pins the key, 1 B..500 MiB and the exact declared content type, for 30 minutes", async () => {
    const before = Date.now();
    const post = await storage().mintUploadPost("m1", "video/mp4");
    const policy = policyOf(post.fields);

    expect(post.objectKey).toMatch(/^meetings\/m1\/upload\/[0-9a-f-]{36}$/);
    expect(post.fields["key"]).toBe(post.objectKey);
    expect(has(policy.conditions, { key: post.objectKey })).toBe(true);
    expect(has(policy.conditions, ["content-length-range", 1, 500 * 1024 * 1024])).toBe(true);
    expect(MAX_UPLOAD_BYTES).toBe(500 * 1024 * 1024);
    expect(has(policy.conditions, ["eq", "$Content-Type", "video/mp4"])).toBe(true);
    expect(post.fields["Content-Type"]).toBe("video/mp4");

    const ttl = Date.parse(post.expiresAt) - before;
    expect(ttl).toBeGreaterThan(1_799_000);
    expect(ttl).toBeLessThan(1_801_500);
  });

  it("mints a different key every time: a POST policy is not single-use, so a key is never shared between mints", async () => {
    const keys = await Promise.all([1, 2, 3, 4].map(() => storage().mintUploadPost("m1", "audio/mpeg")));
    expect(new Set(keys.map((k) => k.objectKey)).size).toBe(4);
  });

  it("refuses a content type outside the allowlist", async () => {
    for (const type of ["application/pdf", "text/html", "image/png", "audio/", "video/mp4; codecs=x", ""]) {
      await expect(storage().mintUploadPost("m1", type)).rejects.toThrow();
    }
  });

  it("allows audio and video containers only", () => {
    for (const type of UPLOAD_CONTENT_TYPES) expect(type.startsWith("audio/") || type.startsWith("video/")).toBe(true);
    expect(UPLOAD_CONTENT_TYPES).toContain("audio/mpeg");
    expect(UPLOAD_CONTENT_TYPES).toContain("video/mp4");
  });
});

describe("presigned GET", () => {
  const expiresIn = (url: string) => Number(new URL(url).searchParams.get("X-Amz-Expires"));

  it("a probe lives 60 s and a playback URL 15 minutes", async () => {
    const s = storage();
    expect(expiresIn(await s.mintProbeGet(`meetings/m1/upload/${TOKEN}`))).toBe(60);
    const playback = await s.mintPlaybackGet("meetings/m1/audio.ogg");
    expect(expiresIn(playback.url)).toBe(900);
    const ttl = Date.parse(playback.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(898_000);
    expect(ttl).toBeLessThan(901_500);
  });

  it("pins the response content type of playback so a stored file can never run as HTML", async () => {
    const { url } = await storage().mintPlaybackGet("meetings/m1/audio.ogg");
    expect(new URL(url).searchParams.get("response-content-type")).toBe("audio/ogg");
  });

  it("refuses a key outside the meetings/ layout", async () => {
    await expect(storage().mintProbeGet("other/x")).rejects.toThrow();
    await expect(storage().mintPlaybackGet("meetings/../x")).rejects.toThrow();
  });
});

// ─── HEAD and delete-prefix against a scripted client ────────────────────────

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

function scripted(handler: (name: string, input: Record<string, unknown>) => unknown) {
  const sent: Sent[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return handler(command.constructor.name, command.input);
    },
  } as unknown as S3Client;
  return { client, sent };
}

describe("headObject", () => {
  it("returns the size and content type", async () => {
    const { client } = scripted(() => ({ ContentLength: 42, ContentType: "audio/webm" }));
    expect(await createStorage({ client, bucket: "b" }).headObject("meetings/m1/chunks/000000")).toEqual({
      sizeBytes: 42,
      contentType: "audio/webm",
    });
  });

  it("returns null when the object does not exist", async () => {
    const { client } = scripted(() => {
      throw Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
    });
    expect(await createStorage({ client, bucket: "b" }).headObject("meetings/m1/audio.ogg")).toBeNull();
  });

  it("lets any other failure through: a storage outage is not 'missing'", async () => {
    const { client } = scripted(() => {
      throw Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } });
    });
    await expect(createStorage({ client, bucket: "b" }).headObject("meetings/m1/audio.ogg")).rejects.toThrow("boom");
  });
});

describe("deletePrefix", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `meetings/m1/chunks/${String(i).padStart(6, "0")}`);

  it("lists every page and deletes in batches of at most 1000", async () => {
    const all = keys(2500);
    const { client, sent } = scripted((name, input) => {
      if (name === "ListObjectsV2Command") {
        const start = input["ContinuationToken"] ? Number(input["ContinuationToken"]) : 0;
        const page = all.slice(start, start + 1000);
        const next = start + 1000;
        return { Contents: page.map((Key) => ({ Key })), IsTruncated: next < all.length, NextContinuationToken: String(next) };
      }
      return { Deleted: ((input["Delete"] as { Objects: { Key: string }[] }).Objects).map((o) => ({ Key: o.Key })) };
    });
    const count = await createStorage({ client, bucket: "b" }).deletePrefix("meetings/m1/");
    expect(count).toBe(2500);
    const deletes = sent.filter((s) => s.name === "DeleteObjectsCommand");
    expect(deletes.map((d) => (d.input["Delete"] as { Objects: unknown[] }).Objects.length)).toEqual([1000, 1000, 500]);
    expect(sent.filter((s) => s.name === "ListObjectsV2Command").every((s) => s.input["Prefix"] === "meetings/m1/")).toBe(true);
  });

  it("is a no-op for an empty prefix listing", async () => {
    const { client, sent } = scripted(() => ({ Contents: undefined, IsTruncated: false }));
    expect(await createStorage({ client, bucket: "b" }).deletePrefix("meetings/m1/")).toBe(0);
    expect(sent.some((s) => s.name === "DeleteObjectsCommand")).toBe(false);
  });

  it("throws when the store reports a key it could not delete, so the caller can answer 503 and change nothing", async () => {
    const { client } = scripted((name) =>
      name === "ListObjectsV2Command"
        ? { Contents: [{ Key: "meetings/m1/audio.ogg" }], IsTruncated: false }
        : { Errors: [{ Key: "meetings/m1/audio.ogg", Code: "AccessDenied" }] },
    );
    await expect(createStorage({ client, bucket: "b" }).deletePrefix("meetings/m1/")).rejects.toThrow();
  });

  it("refuses any prefix that is not exactly one meeting's: it must never wipe the bucket", async () => {
    const { client, sent } = scripted(() => ({}));
    const s = createStorage({ client, bucket: "b" });
    for (const prefix of ["", "/", "meetings/", "meetings//", "meetings/m1", "meetings/m1/chunks/", "meetings/../", "other/m1/"]) {
      await expect(s.deletePrefix(prefix)).rejects.toThrow();
    }
    expect(sent).toHaveLength(0);
  });
});

describe("deleteUploadsExcept", () => {
  const keep = `meetings/m1/upload/${TOKEN}`;
  const stray = "meetings/m1/upload/22222222-2222-4222-8222-222222222222";

  it("lists only the meeting's upload prefix and deletes everything but the kept key", async () => {
    const { client, sent } = scripted((name) =>
      name === "ListObjectsV2Command" ? { Contents: [{ Key: keep }, { Key: stray }], IsTruncated: false } : { Deleted: [{ Key: stray }] },
    );
    expect(await createStorage({ client, bucket: "b" }).deleteUploadsExcept("m1", keep)).toBe(1);
    expect(sent[0]!.input["Prefix"]).toBe("meetings/m1/upload/");
    expect(sent[1]!.input["Delete"]).toEqual({ Objects: [{ Key: stray }], Quiet: true });
  });

  it("without a kept key it deletes them all; with nothing there it deletes nothing", async () => {
    const all = scripted((name) => (name === "ListObjectsV2Command" ? { Contents: [{ Key: keep }, { Key: stray }], IsTruncated: false } : {}));
    expect(await createStorage({ client: all.client, bucket: "b" }).deleteUploadsExcept("m1")).toBe(2);
    const none = scripted(() => ({ Contents: [{ Key: keep }], IsTruncated: false }));
    expect(await createStorage({ client: none.client, bucket: "b" }).deleteUploadsExcept("m1", keep)).toBe(0);
    expect(none.sent.some((s) => s.name === "DeleteObjectsCommand")).toBe(false);
  });

  it("refuses an id that could escape the prefix and a kept key outside the layout", async () => {
    const { client, sent } = scripted(() => ({}));
    await expect(createStorage({ client, bucket: "b" }).deleteUploadsExcept("../x")).rejects.toThrow();
    await expect(createStorage({ client, bucket: "b" }).deleteUploadsExcept("m1", "other/x")).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("deleteObject", () => {
  it("deletes one key", async () => {
    const { client, sent } = scripted(() => ({}));
    await createStorage({ client, bucket: "b" }).deleteObject(`meetings/m1/upload/${TOKEN}`);
    expect(sent[0]).toEqual({ name: "DeleteObjectCommand", input: { Bucket: "b", Key: `meetings/m1/upload/${TOKEN}` } });
  });
});

// ─── The fake keeps the same contract ────────────────────────────────────────

describe("fake storage", () => {
  it("mints the same keys and enforces the same refusals", async () => {
    const fake = createFakeStorage();
    expect((await fake.mintChunkPost("m1", 2)).fields["key"]).toBe("meetings/m1/chunks/000002");
    expect((await fake.mintUploadPost("m1", "audio/mpeg")).fields["key"]).toMatch(/^meetings\/m1\/upload\/[0-9a-f-]{36}$/);
    await expect(fake.mintUploadPost("m1", "application/pdf")).rejects.toThrow();
    await expect(fake.deletePrefix("meetings/")).rejects.toThrow();
  });

  it("heads what was put, deletes by prefix and counts the deletions", async () => {
    const fake = createFakeStorage();
    fake.put("meetings/m1/chunks/000000", 10, "audio/webm");
    fake.put("meetings/m1/audio.ogg", 5, "audio/ogg");
    fake.put("meetings/m2/audio.ogg", 5, "audio/ogg");
    expect(await fake.headObject("meetings/m1/audio.ogg")).toEqual({ sizeBytes: 5, contentType: "audio/ogg" });
    expect(await fake.headObject("meetings/m1/missing")).toBeNull();
    expect(await fake.deletePrefix("meetings/m1/")).toBe(2);
    expect(await fake.headObject("meetings/m1/audio.ogg")).toBeNull();
    expect(await fake.headObject("meetings/m2/audio.ogg")).not.toBeNull();
  });

  it("can be told to fail, to exercise the 503 paths", async () => {
    const fake = createFakeStorage();
    fake.failWith(new Error("storage down"));
    await expect(fake.deletePrefix("meetings/m1/")).rejects.toThrow("storage down");
    await expect(fake.headObject("meetings/m1/x")).rejects.toThrow("storage down");
    fake.failWith(null);
    expect(await fake.deletePrefix("meetings/m1/")).toBe(0);
  });
});
