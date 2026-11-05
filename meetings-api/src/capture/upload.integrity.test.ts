import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREATOR, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";
import { objectKeys } from "../lib/storage";
import { createPrepareAudio } from "../jobs/handlers/prepareAudio";
import { PermanentJobError, type JobContext } from "../jobs/runner";
import { setProberForTests, type ProbeVerdict } from "../media/probe";
import type { NormalizeRequest } from "../media/normalize";

// OWASP A08/A10 (QE fix round 1): the bytes that are DECODED must be the bytes that were
// PROBED, and nothing is read past a byte ceiling counted on what actually arrived.
// An S3 POST policy is not single-use, so (a) every upload mint gets its own key, only the
// stored one is ever used, and (b) prepare_audio probes the LOCAL file it is about to decode.

useKit();
afterEach(() => setProberForTests(null));

const MiB = 1024 * 1024;
const UPLOAD_KEY = /^meetings\/[A-Za-z0-9_-]+\/upload\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mint = (id: string, contentType = "video/mp4", sizeBytes = 5 * MiB) =>
  call("POST", `/meetings/${id}/upload`, { user: CREATOR, body: { contentType, sizeBytes } });
const confirm = (id: string) => call("POST", `/meetings/${id}/upload/confirm`, { user: CREATOR });

describe("upload mint: one key per mint, remembered by the server", () => {
  it("every mint pins a fresh upload/<uuid> key; the stored key is the latest one; the key is not echoed as a field of the response", async () => {
    const m = await mkMeeting({ source: "uploaded" });
    const first = await json<Record<string, unknown> & { fields: Record<string, string> }>(await mint(m.id));
    const second = await json<Record<string, unknown> & { fields: Record<string, string> }>(await mint(m.id));
    expect(first.fields["key"]).toMatch(UPLOAD_KEY);
    expect(second.fields["key"]).toMatch(UPLOAD_KEY);
    expect(second.fields["key"]).not.toBe(first.fields["key"]);
    expect(first["objectKey"]).toBeUndefined();
    expect((await db.meetingUpload.findUniqueOrThrow({ where: { meetingId: m.id } })).objectKey).toBe(second.fields["key"]!);
  });

  it("a re-mint retires the previous key: whatever sits there is deleted", async () => {
    const m = await mkMeeting({ source: "uploaded" });
    const first = await json<{ fields: Record<string, string> }>(await mint(m.id));
    kit.storage.put(first.fields["key"]!, 10, "video/mp4");
    await mint(m.id);
    expect(kit.storage.keys()).not.toContain(first.fields["key"]!);
  });
});

describe("upload confirm uses only the stored key", () => {
  it("probes the stored key (pinned to the declared type's demuxer), and deletes every other object under the upload prefix", async () => {
    const m = await mkMeeting({ source: "uploaded" });
    const stored = (await json<{ fields: Record<string, string> }>(await mint(m.id))).fields["key"]!;
    const stray = objectKeys.upload(m.id, "00000000-0000-4000-8000-000000000000");
    kit.storage.put(stored, 5 * MiB, "video/mp4");
    kit.storage.put(stray, 5 * MiB, "video/mp4");
    const seen: { source: string; format: string | undefined }[] = [];
    setProberForTests(async (source, format) => {
      seen.push({ source, format });
      return { ok: true, durationMs: 1000, format: "mov,mp4,m4a,3gp,3g2,mj2" } satisfies ProbeVerdict;
    });
    expect((await confirm(m.id)).status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.source).toContain(stored);
    expect(seen[0]!.source).not.toContain(stray);
    expect(seen[0]!.format).toBe("mov");
    expect(kit.storage.keys()).toEqual([stored]);
  });
});

// ─── prepare_audio ───────────────────────────────────────────────────────────

describe("prepare_audio decodes exactly the file it probed", () => {
  let tmpRoot: string;
  let normalized: NormalizeRequest[];
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "integrity-"));
    normalized = [];
  });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const ctxFor = (meetingId: string): JobContext => ({
    job: { id: "job-1", kind: "prepare_audio", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: 1, maxAttempts: 3 },
    attemptId: null,
    attempt: 1,
    signal: new AbortController().signal,
    commit: async (fn) => ({ committed: true, value: await db.$transaction(fn) }),
  });
  const fakeNormalize = async (req: NormalizeRequest) => {
    normalized.push(req);
    writeFileSync(req.output, "OggS");
    return { durationMs: 1000 };
  };
  const failed = async (id: string) => (await db.meeting.findUniqueOrThrow({ where: { id } })).failureCode;

  async function uploadedAt(key: string, bytes: Uint8Array, recordedSize = bytes.length) {
    const m = await mkMeeting({ source: "uploaded", status: "processing", stage: "preparing", durationMs: null, processingStartedAt: new Date() });
    const objectKey = key.replace("<id>", m.id);
    kit.storage.put(objectKey, recordedSize, "video/mp4", bytes);
    await db.meetingUpload.create({ data: { meetingId: m.id, objectKey, contentType: "video/mp4", sizeBytes: recordedSize } });
    return { m, objectKey };
  }

  it("the file handed to ffmpeg is the file the local probe saw, with the demuxer the probe named pinned", async () => {
    const { m } = await uploadedAt("meetings/<id>/upload/11111111-1111-4111-8111-111111111111", Uint8Array.from([9, 9, 9]));
    const probed: { path: string; bytes: Buffer }[] = [];
    const handler = createPrepareAudio({
      normalize: fakeNormalize,
      tmpRoot,
      probe: async (path) => {
        probed.push({ path, bytes: readFileSync(path) });
        return { ok: true, durationMs: 1000, format: "mov,mp4,m4a,3gp,3g2,mj2" };
      },
    });
    await handler(ctxFor(m.id));
    expect(probed).toHaveLength(1);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.inputs).toEqual([probed[0]!.path]);
    expect(normalized[0]!.inputFormats).toEqual(["mov"]);
    expect(probed[0]!.bytes).toEqual(Buffer.from([9, 9, 9]));
  });

  it("an object swapped for a playlist after confirm is refused by the local probe: ffmpeg never runs, the meeting fails, the temp dir is empty", async () => {
    const playlist = Buffer.from("#EXTM3U\n#EXTINF:10,\nhttp://169.254.169.254/latest/meta-data/\n");
    const { m } = await uploadedAt("meetings/<id>/upload/22222222-2222-4222-8222-222222222222", new Uint8Array(playlist));
    const handler = createPrepareAudio({
      normalize: fakeNormalize,
      tmpRoot,
      probe: async (path) => (readFileSync(path).toString().startsWith("#EXTM3U") ? { ok: false, reason: "unsupported_type" } : { ok: true, durationMs: 1, format: "wav" }),
    });
    await expect(handler(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(normalized).toHaveLength(0);
    expect(await failed(m.id)).toBe("audio_unreadable");
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("only the stored key is read; strays under the upload prefix are deleted with the original", async () => {
    const { m, objectKey } = await uploadedAt("meetings/<id>/upload/33333333-3333-4333-8333-333333333333", Uint8Array.from([1, 2]));
    const stray = objectKeys.upload(m.id, "44444444-4444-4444-8444-444444444444");
    kit.storage.put(stray, 3, "video/mp4", Uint8Array.from([7]));
    await createPrepareAudio({ normalize: fakeNormalize, tmpRoot, probe: async () => ({ ok: true, durationMs: 1, format: "wav" }) })(ctxFor(m.id));
    expect(kit.storage.reads).toEqual([objectKey]);
    expect(kit.storage.keys()).toEqual([`meetings/${m.id}/audio.ogg`]);
  });

  it("an original that grew past the upload ceiling after confirm is refused on the bytes actually read", async () => {
    const { m } = await uploadedAt("meetings/<id>/upload/55555555-5555-4555-8555-555555555555", new Uint8Array(64), 2);
    const handler = createPrepareAudio({ normalize: fakeNormalize, tmpRoot, maxUploadBytes: 10, probe: async () => ({ ok: true, durationMs: 1, format: "wav" }) });
    await expect(handler(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(normalized).toHaveLength(0);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("the default probe runs ffprobe on the local file with only the file protocol: no URL, no network protocol on the command line", async () => {
    const argsFile = join(tmpRoot, "args.txt");
    const stub = join(tmpRoot, "ffprobe-stub");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{"format":{"format_name":"hls,applehttp"},"streams":[{"codec_type":"audio"}]}'\n`);
    chmodSync(stub, 0o755);
    const previous = process.env["FFPROBE_PATH"];
    process.env["FFPROBE_PATH"] = stub;
    try {
      const playlist = Buffer.from("#EXTM3U\nhttp://169.254.169.254/x\n");
      const { m } = await uploadedAt("meetings/<id>/upload/66666666-6666-4666-8666-666666666666", new Uint8Array(playlist));
      const work = mkdtempSync(join(tmpdir(), "integrity-work-"));
      try {
        await expect(createPrepareAudio({ normalize: fakeNormalize, tmpRoot: work })(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
        const args = readFileSync(argsFile, "utf8").trim().split("\n");
        expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
        const input = args[args.indexOf("-i") + 1]!;
        expect(input.startsWith(work)).toBe(true);
        expect(args.filter((a) => /^[a-z][a-z0-9+.-]*:/i.test(a))).toEqual([]);
        expect(normalized).toHaveLength(0);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env["FFPROBE_PATH"];
      else process.env["FFPROBE_PATH"] = previous;
    }
  });
});

describe("prepare_audio caps the bytes actually written, across the whole recording", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "integrity-cap-"));
  });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const ctxFor = (meetingId: string): JobContext => ({
    job: { id: "job-1", kind: "prepare_audio", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: 1, maxAttempts: 3 },
    attemptId: null,
    attempt: 1,
    signal: new AbortController().signal,
    commit: async (fn) => ({ committed: true, value: await db.$transaction(fn) }),
  });

  /** Chunks recorded as 1 byte each, then overwritten (the 5-minute POST policy is still open) with `actual` bytes. */
  async function overwritten(count: number, actual: number) {
    const m = await mkMeeting({ status: "processing", stage: "preparing", durationMs: 30_000, processingStartedAt: new Date() });
    const session = await db.recordingSession.create({ data: { meetingId: m.id, endedAt: new Date(), endReason: "stopped", capturedMs: 30_000 } });
    for (let seq = 0; seq < count; seq++) {
      const key = objectKeys.chunk(m.id, seq);
      kit.storage.put(key, 1, "audio/webm", new Uint8Array(actual).fill(1));
      kit.storage.put(key, 1, "audio/webm", new Uint8Array(actual).fill(1));
      await db.recordingChunk.create({ data: { meetingId: m.id, seq, sessionId: session.id, objectKey: key, sizeBytes: 1, durationMs: 10_000, storedAt: new Date() } });
    }
    return m;
  }

  it("hands each read only what is left of the budget, stops at the first chunk that overruns it, normalises nothing and cleans up", async () => {
    const m = await overwritten(5, 40);
    let ran = false;
    const handler = createPrepareAudio({
      tmpRoot,
      maxRecordingBytes: 100,
      normalize: async () => {
        ran = true;
        return { durationMs: 1 };
      },
      probe: async () => ({ ok: true, durationMs: 1, format: "matroska,webm" }),
    });
    await expect(handler(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(kit.storage.limits).toEqual([100, 60, 20]); // 40 + 40 written; the third would pass 100
    expect(ran).toBe(false);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).failureCode).toBe("audio_unreadable");
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("a recording that fits is unaffected", async () => {
    const m = await overwritten(2, 40);
    const handler = createPrepareAudio({
      tmpRoot,
      maxRecordingBytes: 100,
      normalize: async (req) => {
        writeFileSync(req.output, "OggS");
        return { durationMs: 1 };
      },
      probe: async () => ({ ok: true, durationMs: 1, format: "matroska,webm" }),
    });
    await handler(ctxFor(m.id));
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).audioKey).toBe(`meetings/${m.id}/audio.ogg`);
  });
});
