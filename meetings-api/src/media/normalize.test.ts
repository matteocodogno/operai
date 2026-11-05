import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, kit, mkMeeting, useKit } from "../test-support/captureKit";
import { PermanentJobError, TransientJobError, type JobContext } from "../jobs/runner";
import { createPrepareAudio } from "../jobs/handlers/prepareAudio";
import { NormalizeError, buildFfmpegArgs, groupIntoRuns, normalizeAudio, startsContainer, type NormalizeRequest } from "./normalize";
import { ffmpegBinary, ffprobeBinary, runTool } from "./probe";

// AC-3.1 (video never leaves this step), AC-2.6 (recordings, paused gaps), AC-4.4
// (audioCreatedAt) and ADR-0064: prepare_audio streams the chunks or the original to a
// per-job temp dir, runs a hardened ffmpeg, stores audio.ogg, deletes the sources and
// always removes the temp dir.

useKit();

const scratch = mkdtempSync(join(tmpdir(), "normalize-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const webmChunk = (tag: string, withHeader: boolean) => Uint8Array.from([...(withHeader ? EBML : [0x1f, 0x43, 0xb6, 0x75]), ...Buffer.from(`${tag}|`)]);
const mp4Header = Uint8Array.from([0, 0, 0, 0x18, ...Buffer.from("ftypiso5"), 0, 0, 0, 0]);

// ─── Pure pieces ─────────────────────────────────────────────────────────────

describe("startsContainer: which chunks begin a new container", () => {
  it("recognises a WebM (EBML) header and an MP4 ftyp box", () => {
    expect(startsContainer(webmChunk("a", true))).toBe(true);
    expect(startsContainer(mp4Header)).toBe(true);
  });
  it("a continuation chunk (a WebM cluster, an fMP4 moof) does not", () => {
    expect(startsContainer(webmChunk("a", false))).toBe(false);
    expect(startsContainer(Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from("moof"), 0]))).toBe(false);
    expect(startsContainer(new Uint8Array(0))).toBe(false);
    expect(startsContainer(Uint8Array.from([0x1a, 0x45]))).toBe(false);
  });
});

describe("groupIntoRuns: a rebuilt MediaRecorder starts a second container mid-recording", () => {
  const write = (name: string, bytes: Uint8Array) => {
    const path = join(scratch, name);
    writeFileSync(path, bytes);
    return path;
  };

  it("one header at the start is one run, bytes joined in order", async () => {
    const dir = mkdtempSync(join(scratch, "runs-"));
    const files = [write("r0", webmChunk("a", true)), write("r1", webmChunk("b", false)), write("r2", webmChunk("c", false))];
    const runs = await groupIntoRuns(dir, files);
    expect(runs).toHaveLength(1);
    expect(readFileSync(runs[0]!).toString("latin1")).toContain("a|");
    expect(Buffer.from(readFileSync(runs[0]!)).equals(Buffer.concat(files.map((f) => readFileSync(f))))).toBe(true);
  });

  it("a second header starts a second run; each run is exactly its own chunks", async () => {
    const dir = mkdtempSync(join(scratch, "runs-"));
    const files = [
      write("s0", webmChunk("a", true)), write("s1", webmChunk("b", false)),
      write("s2", webmChunk("c", true)), write("s3", webmChunk("d", false)),
      write("s4", webmChunk("e", true)),
    ];
    const runs = await groupIntoRuns(dir, files);
    expect(runs).toHaveLength(3);
    expect(Buffer.from(readFileSync(runs[0]!)).equals(Buffer.concat([0, 1].map((i) => readFileSync(files[i]!))))).toBe(true);
    expect(Buffer.from(readFileSync(runs[1]!)).equals(Buffer.concat([2, 3].map((i) => readFileSync(files[i]!))))).toBe(true);
    expect(Buffer.from(readFileSync(runs[2]!)).equals(readFileSync(files[4]!))).toBe(true);
  });

  it("the first chunk always opens a run, even if it carries no recognisable header", async () => {
    const dir = mkdtempSync(join(scratch, "runs-"));
    const runs = await groupIntoRuns(dir, [write("t0", webmChunk("a", false)), write("t1", webmChunk("b", false))]);
    expect(runs).toHaveLength(1);
  });

  it("no chunks is no runs", async () => {
    expect(await groupIntoRuns(mkdtempSync(join(scratch, "runs-")), [])).toEqual([]);
  });
});

describe("buildFfmpegArgs (ADR-0064 point 4)", () => {
  it("one input: exactly the documented hardened command", () => {
    expect(buildFfmpegArgs(["/w/run-0"], "/w/audio.ogg")).toEqual([
      "-nostdin", "-hide_banner", "-v", "error", "-y",
      "-protocol_whitelist", "file,pipe", "-i", "/w/run-0",
      "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "/w/audio.ogg",
    ]);
  });

  it("several inputs: every input carries its own protocol whitelist and the audio is concatenated, resampled and mono", () => {
    const args = buildFfmpegArgs(["/w/run-0", "/w/run-1"], "/w/audio.ogg");
    const inputs = args.flatMap((a, i) => (a === "-i" ? [i] : []));
    expect(inputs).toHaveLength(2);
    for (const i of inputs) {
      expect(args[i - 2]).toBe("-protocol_whitelist");
      expect(args[i - 1]).toBe("file,pipe");
    }
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("[0:a:0]");
    expect(filter).toContain("[1:a:0]");
    expect(filter).toContain("concat=n=2:v=0:a=1");
    expect(args[args.indexOf("-map") + 1]).toBe("[out]");
    for (const flag of ["-vn", "-sn", "-dn"]) expect(args).toContain(flag);
    expect(args.slice(-1)).toEqual(["/w/audio.ogg"]);
  });
});

// ─── normalizeAudio against stub binaries ────────────────────────────────────

describe("normalizeAudio (stub ffmpeg/ffprobe)", () => {
  const bin = (name: string, script: string) => {
    const path = join(scratch, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return path;
  };
  const okFfmpeg = bin("ff-ok", `for a; do last="$a"; done; printf OggS > "$last"`);
  const probeOf = (duration: string, extra = "") =>
    bin(`fp-${duration}${extra}`, `echo '{"format":{"format_name":"ogg","duration":"${duration}"},"streams":[{"codec_type":"audio"}${extra}]}'`);
  const request = (over: Partial<NormalizeRequest> = {}): NormalizeRequest => ({
    inputs: ["/w/run-0"], output: join(scratch, "out.ogg"), ffmpegBin: okFfmpeg, ffprobeBin: probeOf("12.5"), ...over,
  });

  it("returns the real duration of what ffmpeg produced", async () => {
    expect(await normalizeAudio(request())).toEqual({ durationMs: 12_500 });
  });

  it("a failing ffmpeg is audio_unreadable", async () => {
    const bad = bin("ff-bad", `echo 'Invalid data found when processing input' >&2; exit 1`);
    const error = await normalizeAudio(request({ ffmpegBin: bad })).catch((e) => e);
    expect(error).toBeInstanceOf(NormalizeError);
    expect(error.code).toBe("audio_unreadable");
  });

  it("an ffmpeg that produces nothing is audio_unreadable", async () => {
    const empty = bin("ff-empty", `exit 0`);
    expect(((await normalizeAudio(request({ ffmpegBin: empty, output: join(scratch, "never.ogg") })).catch((e) => e)) as NormalizeError).code).toBe("audio_unreadable");
  });

  it("an ffmpeg past its timeout is killed and is audio_unreadable", async () => {
    const slow = bin("ff-slow", `sleep 10`);
    const started = Date.now();
    const error = await normalizeAudio(request({ ffmpegBin: slow, timeoutMs: 200 })).catch((e) => e);
    expect((error as NormalizeError).code).toBe("audio_unreadable");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a result longer than 3 h + 60 s is too_long; 3 h + 30 s (a recording's grace) is fine", async () => {
    expect(((await normalizeAudio(request({ ffprobeBin: probeOf("10861") })).catch((e) => e)) as NormalizeError).code).toBe("too_long");
    expect(await normalizeAudio(request({ ffprobeBin: probeOf("10830") }))).toEqual({ durationMs: 10_830_000 });
  });

  it("output with a video stream is refused (video never leaves this step)", async () => {
    const error = await normalizeAudio(request({ ffprobeBin: probeOf("5", `,{"codec_type":"video"}`) })).catch((e) => e);
    expect((error as NormalizeError).code).toBe("audio_unreadable");
  });

  it("missing binaries are a ToolMissingError, not a verdict on the audio", async () => {
    const error = await normalizeAudio(request({ ffmpegBin: join(scratch, "no-such-ffmpeg") })).catch((e) => e);
    expect((error as Error).name).toBe("ToolMissingError");
  });

  it("an aborted signal kills ffmpeg", async () => {
    const slow = bin("ff-slow2", `sleep 10`);
    const controller = new AbortController();
    const started = Date.now();
    const pending = normalizeAudio(request({ ffmpegBin: slow, signal: controller.signal })).catch((e) => e);
    setTimeout(() => controller.abort(), 100);
    await pending;
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

// ─── the prepare_audio handler (fake normaliser, real database and fake storage) ──

describe("prepare_audio handler", () => {
  let tmpRoot: string;
  let calls: { inputs: string[]; bytes: Buffer[] }[];
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(scratch, "tmp-root-"));
    calls = [];
  });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const fakeNormalize = (durationMs = 30_000, hook?: () => Promise<void>) => async (req: NormalizeRequest) => {
    calls.push({ inputs: [...req.inputs], bytes: req.inputs.map((f) => readFileSync(f)) });
    await hook?.();
    writeFileSync(req.output, "OggS-normalised");
    return { durationMs };
  };

  const ctxFor = (meetingId: string, over: { attempt?: number; maxAttempts?: number; signal?: AbortSignal } = {}): JobContext => ({
    job: { id: "job-1", kind: "prepare_audio", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: over.attempt ?? 1, maxAttempts: over.maxAttempts ?? 3 },
    attemptId: null,
    attempt: over.attempt ?? 1,
    signal: over.signal ?? new AbortController().signal,
    commit: async (fn) => ({ committed: true, value: await db.$transaction(fn) }),
  });
  const handler = (normalize = fakeNormalize()) => createPrepareAudio({ normalize, tmpRoot });
  const chunkKey = (id: string, seq: number) => `meetings/${id}/chunks/${String(seq).padStart(6, "0")}`;

  async function recorded(chunks: Uint8Array[]) {
    const m = await mkMeeting({ status: "processing", stage: "preparing", durationMs: 30_000, processingStartedAt: new Date() });
    const session = await db.recordingSession.create({ data: { meetingId: m.id, endedAt: new Date(), endReason: "stopped", capturedMs: 30_000 } });
    for (const [seq, bytes] of chunks.entries()) {
      kit.storage.put(chunkKey(m.id, seq), bytes.length, "audio/webm", bytes);
      await db.recordingChunk.create({ data: { meetingId: m.id, seq, sessionId: session.id, objectKey: chunkKey(m.id, seq), sizeBytes: bytes.length, durationMs: 10_000, storedAt: new Date() } });
    }
    return m;
  }
  async function uploadedMeeting(bytes: Uint8Array, over = {}) {
    const m = await mkMeeting({ source: "uploaded", status: "processing", stage: "preparing", durationMs: null, processingStartedAt: new Date(), ...over });
    kit.storage.put(`meetings/${m.id}/original`, bytes.length, "video/mp4", bytes);
    await db.meetingUpload.create({ data: { meetingId: m.id, objectKey: `meetings/${m.id}/original`, contentType: "video/mp4", sizeBytes: bytes.length } });
    return m;
  }

  it("recorded: joins the chunks in order, stores audio.ogg, sets audioCreatedAt, queues transcribe, deletes the chunk objects, leaves no temp files", async () => {
    const m = await recorded([webmChunk("a", true), webmChunk("b", false), webmChunk("c", false)]);
    const before = Date.now();
    await handler()(ctxFor(m.id));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.inputs).toHaveLength(1);
    expect(calls[0]!.bytes[0]!.toString("latin1")).toMatch(/a\|.*b\|.*c\|/s);

    expect(kit.storage.bytesOf(`meetings/${m.id}/audio.ogg`)).toBeDefined();
    expect(kit.storage.keys()).toEqual([`meetings/${m.id}/audio.ogg`]); // the chunks are gone

    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.audioKey).toBe(`meetings/${m.id}/audio.ogg`);
    expect(row.audioBytes).toBe("OggS-normalised".length);
    expect(row.audioCreatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.status).toBe("processing"); // transcribe finishes it
    const jobs = await db.meetingJob.findMany({ where: { meetingId: m.id } });
    expect(jobs.map((j) => j.kind)).toEqual(["transcribe"]);
    // metadata kept: it is what tells the creator how much offline audio was lost
    expect(await db.recordingChunk.count({ where: { meetingId: m.id } })).toBe(3);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("a second container header in the middle of the session reaches ffmpeg as a second input (microphone rebuilt after Resume)", async () => {
    const m = await recorded([webmChunk("a", true), webmChunk("b", false), webmChunk("c", true), webmChunk("d", false)]);
    await handler()(ctxFor(m.id));
    expect(calls[0]!.inputs).toHaveLength(2);
    expect(calls[0]!.bytes[0]!.toString("latin1")).toMatch(/a\|.*b\|/s);
    expect(calls[0]!.bytes[0]!.toString("latin1")).not.toContain("c|");
    expect(calls[0]!.bytes[1]!.toString("latin1")).toMatch(/c\|.*d\|/s);
  });

  it("a gap in the sequence (process what was captured) still normalises the chunks that exist", async () => {
    const m = await recorded([webmChunk("a", true), webmChunk("b", false), webmChunk("c", false)]);
    await db.recordingChunk.delete({ where: { meetingId_seq: { meetingId: m.id, seq: 1 } } });
    await handler()(ctxFor(m.id));
    expect(calls[0]!.bytes[0]!.toString("latin1")).toMatch(/a\|.*c\|/s);
    expect(calls[0]!.bytes[0]!.toString("latin1")).not.toContain("b|");
  });

  it("uploaded: streams the original, deletes it and its announcement, takes the duration from the output when none was known", async () => {
    const m = await uploadedMeeting(Uint8Array.from([1, 2, 3, 4]));
    await handler(fakeNormalize(61_000))(ctxFor(m.id));
    expect(kit.storage.reads).toEqual([`meetings/${m.id}/original`]);
    expect(kit.storage.keys()).toEqual([`meetings/${m.id}/audio.ogg`]);
    expect(await db.meetingUpload.count({ where: { meetingId: m.id } })).toBe(0);
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.durationMs).toBe(61_000);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("a permanent normalisation failure marks the meeting failed (audio_unreadable), keeps the sources for a retry, queues nothing, and cleans up", async () => {
    const m = await recorded([webmChunk("a", true)]);
    const failing = async () => {
      throw new NormalizeError("audio_unreadable");
    };
    await expect(handler(failing)(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row).toMatchObject({ status: "failed", failureCode: "audio_unreadable", stage: null, audioKey: null });
    expect(kit.storage.keys()).toEqual([chunkKey(m.id, 0)]);
    expect(await db.meetingJob.count()).toBe(0);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("too_long from the normaliser is the failure code too_long", async () => {
    const m = await recorded([webmChunk("a", true)]);
    await expect(handler(async () => { throw new NormalizeError("too_long"); })(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).failureCode).toBe("too_long");
  });

  it("a forced failure of any kind leaves the temp dir empty", async () => {
    const m = await recorded([webmChunk("a", true)]);
    await expect(handler(async (req) => { writeFileSync(req.output, "partial"); throw new Error("boom"); })(ctxFor(m.id))).rejects.toBeInstanceOf(TransientJobError);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("a storage outage is retried (the meeting stays processing) until the last attempt, then it fails as provider_unavailable", async () => {
    const m = await recorded([webmChunk("a", true)]);
    kit.storage.failWith(new Error("down"));
    await expect(handler()(ctxFor(m.id, { attempt: 1, maxAttempts: 3 }))).rejects.toBeInstanceOf(TransientJobError);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("processing");
    await expect(handler()(ctxFor(m.id, { attempt: 3, maxAttempts: 3 }))).rejects.toBeInstanceOf(TransientJobError);
    expect(await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "failed", failureCode: "provider_unavailable" });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("chunks that together exceed the recording byte ceiling fail before any read", async () => {
    const m = await recorded([webmChunk("a", true)]);
    await db.recordingChunk.update({ where: { meetingId_seq: { meetingId: m.id, seq: 0 } }, data: { sizeBytes: 200 * 1024 * 1024 } });
    await expect(handler()(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(kit.storage.reads).toEqual([]);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).failureCode).toBe("audio_unreadable");
  });

  it("an uploaded original announced above 500 MiB is never read", async () => {
    const m = await uploadedMeeting(Uint8Array.from([1]));
    await db.meetingUpload.update({ where: { meetingId: m.id }, data: { sizeBytes: 500 * 1024 * 1024 + 1 } });
    await expect(handler()(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(kit.storage.reads).toEqual([]);
  });

  it("a meeting with nothing to normalise fails as audio_unreadable", async () => {
    const m = await mkMeeting({ status: "processing", stage: "preparing" });
    await expect(handler()(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).failureCode).toBe("audio_unreadable");
  });

  it("is idempotent: audio already stored means no second read, no second job, and leftover sources are removed", async () => {
    const m = await recorded([webmChunk("a", true)]);
    await handler()(ctxFor(m.id));
    kit.storage.put(chunkKey(m.id, 0), 5); // a leftover from a crash between commit and cleanup
    await handler()(ctxFor(m.id));
    expect(calls).toHaveLength(1);
    expect(await db.meetingJob.count({ where: { meetingId: m.id, kind: "transcribe" } })).toBe(1);
    expect(kit.storage.keys()).toEqual([`meetings/${m.id}/audio.ogg`]);
  });

  it("a meeting that is no longer processing (discarded, or deleted meanwhile) is left alone", async () => {
    const m = await recorded([webmChunk("a", true)]);
    await db.meeting.update({ where: { id: m.id }, data: { status: "draft" } });
    await handler()(ctxFor(m.id));
    expect(calls).toHaveLength(0);
    await handler()(ctxFor("missing-meeting-id"));
    expect(kit.storage.reads).toEqual([]);
  });

  it("a meeting deleted while ffmpeg ran: the audio.ogg that was put is removed again", async () => {
    const m = await recorded([webmChunk("a", true)]);
    await handler(fakeNormalize(1000, async () => { await db.meeting.delete({ where: { id: m.id } }); }))(ctxFor(m.id));
    expect(kit.storage.keys().filter((k) => k.endsWith("audio.ogg"))).toEqual([]);
    expect(await db.meetingJob.count()).toBe(0);
  });

  it("a lost lease (aborted signal) is not recorded as a failure of the meeting", async () => {
    const m = await recorded([webmChunk("a", true)]);
    const controller = new AbortController();
    const aborting = async () => {
      controller.abort();
      throw new NormalizeError("audio_unreadable");
    };
    await handler(aborting)(ctxFor(m.id, { signal: controller.signal })).catch(() => {});
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("processing");
  });

  it("the temp dir is created under the configured root with owner-only permissions", async () => {
    const m = await recorded([webmChunk("a", true)]);
    let mode = 0;
    await handler(async (req) => {
      const { statSync } = await import("node:fs");
      mode = statSync(join(req.output, "..")).mode & 0o777;
      writeFileSync(req.output, "OggS");
      return { durationMs: 1 };
    })(ctxFor(m.id));
    expect(mode).toBe(0o700);
  });
});

// ─── real ffmpeg ─────────────────────────────────────────────────────────────

const hasFfmpeg = Bun.which(ffmpegBinary()) !== null && Bun.which(ffprobeBinary()) !== null;

describe.skipIf(!hasFfmpeg)("prepare_audio with the real ffmpeg on generated fixtures", () => {
  const dir = mkdtempSync(join(scratch, "real-"));
  const ff = async (args: string[]) => {
    const r = await runTool(ffmpegBinary(), ["-v", "error", "-y", ...args], { timeoutMs: 120_000 });
    expect(r.code).toBe(0);
  };
  const streams = async (file: string) => {
    const r = await runTool(ffprobeBinary(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: 30_000 });
    return JSON.parse(r.stdout) as { streams: { codec_type: string; codec_name: string; channels?: number; sample_rate?: string }[]; format: { duration: string } };
  };
  const splitBytes = (file: string, parts: number): Uint8Array[] => {
    const all = readFileSync(file);
    const step = Math.ceil(all.length / parts);
    return Array.from({ length: parts }, (_, i) => new Uint8Array(all.subarray(i * step, (i + 1) * step)));
  };
  /** The encoder's input sample rate: OpusHead is magic(8) version(1) channels(1) pre-skip(2) then a little-endian u32. */
  const opusInputRate = (file: string): number => {
    const bytes = readFileSync(file);
    const at = bytes.indexOf("OpusHead");
    expect(at).toBeGreaterThanOrEqual(0);
    return bytes.readUInt32LE(at + 12);
  };
  const assertOpusMono = async (file: string, seconds: number) => {
    const probe = await streams(file);
    expect(probe.streams).toHaveLength(1);
    // Ogg Opus always DECODES at 48 kHz (RFC 7845 section 5.1), so ffprobe reports 48000 whatever
    // the encoder was fed. The 16 kHz the pipeline asks for (`-ar 16000`) is recorded in the
    // OpusHead "input sample rate" field, which is what is pinned below.
    expect(probe.streams[0]).toMatchObject({ codec_type: "audio", codec_name: "opus", channels: 1, sample_rate: "48000" });
    expect(opusInputRate(file)).toBe(16_000);
    expect(Math.abs(Number(probe.format.duration) - seconds)).toBeLessThan(0.6);
  };
  const run = async (inputs: Uint8Array[]) => {
    const work = mkdtempSync(join(dir, "w-"));
    const files = inputs.map((bytes, i) => {
      const p = join(work, `c${i}`);
      writeFileSync(p, bytes);
      return p;
    });
    const runs = await groupIntoRuns(work, files);
    const output = join(work, "audio.ogg");
    const { durationMs } = await normalizeAudio({ inputs: runs, output });
    return { output, durationMs, runs };
  };

  it("Chrome-style WebM/Opus chunks (header in the first chunk only)", async () => {
    await ff(["-f", "lavfi", "-i", "sine=f=440:d=3", "-c:a", "libopus", "-b:a", "32k", join(dir, "a.webm")]);
    const out = await run(splitBytes(join(dir, "a.webm"), 3));
    expect(out.runs).toHaveLength(1);
    await assertOpusMono(out.output, 3);
  });

  it("Safari-style fragmented MP4 chunks", async () => {
    await ff(["-f", "lavfi", "-i", "sine=f=440:d=3", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof", join(dir, "a.mp4")]);
    const out = await run(splitBytes(join(dir, "a.mp4"), 3));
    expect(out.runs).toHaveLength(1);
    await assertOpusMono(out.output, 3);
  });

  it("two concatenated WebM streams (recorder rebuilt after a pause) are both kept, in order", async () => {
    await ff(["-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libopus", "-b:a", "32k", join(dir, "p1.webm")]);
    await ff(["-f", "lavfi", "-i", "sine=f=880:d=2", "-c:a", "libopus", "-b:a", "32k", join(dir, "p2.webm")]);
    const out = await run([...splitBytes(join(dir, "p1.webm"), 2), ...splitBytes(join(dir, "p2.webm"), 2)]);
    expect(out.runs).toHaveLength(2);
    await assertOpusMono(out.output, 4);
  });

  it("an mp4 with a video track yields audio only", async () => {
    await ff(["-f", "lavfi", "-i", "testsrc=d=2:s=64x64:r=5", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-c:a", "aac", join(dir, "v.mp4")]);
    const out = await run([new Uint8Array(readFileSync(join(dir, "v.mp4")))]);
    await assertOpusMono(out.output, 2);
    expect((await streams(out.output)).streams.some((s) => s.codec_type === "video")).toBe(false);
  });

  it("garbage is audio_unreadable", async () => {
    const error = await run([new Uint8Array(1000).fill(7)]).catch((e) => e);
    expect((error as NormalizeError).code).toBe("audio_unreadable");
  });
});

// keep the unused-import linter honest about helpers used only in skipped blocks
void mkdirSync;
