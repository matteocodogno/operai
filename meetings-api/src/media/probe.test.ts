import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AUDIO_MS, ToolMissingError, buildProbeArgs, judgeProbe, probeMedia, protocolsFor, runTool } from "./probe";

// AC-3.1 / AC-3.2 (ADR-0064 point 3): what ffprobe must show before an upload is
// accepted: an allowlisted demuxer, an audio stream, a duration of at most 3 h.

const FIXTURES = join(import.meta.dir, "../../test-fixtures/media");
const hasFfprobe = Bun.which(process.env["FFPROBE_PATH"] ?? "ffprobe") !== null;
const hasFfmpeg = Bun.which(process.env["FFMPEG_PATH"] ?? "ffmpeg") !== null;

const probeJson = (format: string, streams: { codec_type: string }[], duration: string | null = "60.5") => ({
  format: { format_name: format, ...(duration !== null ? { duration } : {}) },
  streams,
});

describe("judgeProbe", () => {
  it.each([
    "mov,mp4,m4a,3gp,3g2,mj2",
    "matroska,webm",
    "ogg",
    "wav",
    "mp3",
    "aac",
    "flac",
  ])("accepts the allowlisted demuxer %s with an audio stream", (format) => {
    expect(judgeProbe(probeJson(format, [{ codec_type: "audio" }]))).toEqual({ ok: true, durationMs: 60_500, format });
  });

  it("accepts a video container as long as an audio stream is there", () => {
    const v = judgeProbe(probeJson("mov,mp4,m4a,3gp,3g2,mj2", [{ codec_type: "video" }, { codec_type: "audio" }]));
    expect(v.ok).toBe(true);
  });

  it.each(["hls,applehttp", "concat", "rtsp", "image2", "avi", "mpegts", "data", ""])(
    "refuses the demuxer %p as an unsupported type, even with an audio stream",
    (format) => {
      expect(judgeProbe(probeJson(format, [{ codec_type: "audio" }]))).toEqual({ ok: false, reason: "unsupported_type" });
    },
  );

  it("refuses a file with no audio stream: no_audio", () => {
    expect(judgeProbe(probeJson("mov,mp4,m4a,3gp,3g2,mj2", [{ codec_type: "video" }]))).toEqual({ ok: false, reason: "no_audio" });
    expect(judgeProbe(probeJson("wav", []))).toEqual({ ok: false, reason: "no_audio" });
  });

  it("refuses a duration over 3 h: too_long; exactly 3 h is fine", () => {
    expect(judgeProbe(probeJson("wav", [{ codec_type: "audio" }], "10800.001"))).toEqual({ ok: false, reason: "too_long" });
    expect(judgeProbe(probeJson("wav", [{ codec_type: "audio" }], "10800.000"))).toMatchObject({ ok: true, durationMs: MAX_AUDIO_MS });
  });

  it("a container with no duration metadata is accepted with durationMs null (the normaliser re-checks the real length)", () => {
    expect(judgeProbe(probeJson("matroska,webm", [{ codec_type: "audio" }], null))).toMatchObject({ ok: true, durationMs: null });
    expect(judgeProbe(probeJson("wav", [{ codec_type: "audio" }], "N/A"))).toMatchObject({ ok: true, durationMs: null });
  });

  it("a negative or non-numeric duration is not trusted as a duration", () => {
    expect(judgeProbe(probeJson("wav", [{ codec_type: "audio" }], "-5"))).toMatchObject({ ok: true, durationMs: null });
    expect(judgeProbe(probeJson("wav", [{ codec_type: "audio" }], "abc"))).toMatchObject({ ok: true, durationMs: null });
  });

  it("anything that is not a probe document is an unsupported type", () => {
    for (const bad of [null, undefined, "x", 3, [], {}, { format: 3 }, { format: {} }]) {
      expect(judgeProbe(bad)).toEqual({ ok: false, reason: "unsupported_type" });
    }
  });
});

describe("how ffprobe is invoked (ADR-0064 point 3)", () => {
  it("over https: only https, tls and tcp may be opened", () => {
    expect(protocolsFor("https://bucket.s3.eu-west-1.amazonaws.com/meetings/m1/original?X-Amz=1")).toBe("https,tls,tcp");
  });
  it("a local file or an http URL (dev MinIO) gets its own narrow list", () => {
    expect(protocolsFor("http://localhost:9000/b/k?sig=1")).toBe("http,tcp");
    expect(protocolsFor("/tmp/x/original")).toBe("file");
  });
  it("any other scheme is refused outright", () => {
    expect(() => protocolsFor("ftp://example.com/a")).toThrow();
    expect(() => protocolsFor("concat:a|b")).toThrow();
    expect(() => protocolsFor("file:///etc/passwd")).toThrow();
  });
  it("the argument vector pins the whitelist before the input, asks for JSON and ends at the input", () => {
    const args = buildProbeArgs("https://h/k?s=1");
    expect(args.indexOf("-protocol_whitelist")).toBeGreaterThanOrEqual(0);
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("https,tls,tcp");
    expect(args.indexOf("-protocol_whitelist")).toBeLessThan(args.indexOf("-i"));
    expect(args.slice(-2)).toEqual(["-i", "https://h/k?s=1"]);
    expect(args).toContain("-show_streams");
    expect(args).toContain("-show_format");
    expect(args[args.indexOf("-print_format") + 1]).toBe("json");
  });
});

describe("runTool", () => {
  it("captures stdout and the exit code", async () => {
    const r = await runTool("echo", ["hi"], { timeoutMs: 5000 });
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.stdout.trim()).toBe("hi");
  });

  it("kills a process that outlives its timeout", async () => {
    const started = Date.now();
    const r = await runTool("sleep", ["10"], { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a missing binary is a ToolMissingError, not a rejection of the file", async () => {
    await expect(runTool("definitely-not-a-binary-xyz", [], { timeoutMs: 1000 })).rejects.toBeInstanceOf(ToolMissingError);
  });

  it("keeps only a bounded amount of output", async () => {
    const r = await runTool("sh", ["-c", "head -c 3000000 /dev/zero | tr '\\0' a"], { timeoutMs: 5000, maxOutputBytes: 1000 });
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
  });
});

describe("probeMedia with a stubbed binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-stub-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const stub = (name: string, script: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return path;
  };

  it("a clean exit with a good document is ok", async () => {
    const bin = stub("good", `echo '{"format":{"format_name":"wav","duration":"1.0"},"streams":[{"codec_type":"audio"}]}'`);
    expect(await probeMedia("/tmp/anything", { bin })).toEqual({ ok: true, durationMs: 1000, format: "wav" });
  });

  it("a non-zero exit (ffprobe could not read it) is an unsupported type", async () => {
    const bin = stub("bad", `echo 'Invalid data found' >&2; exit 1`);
    expect(await probeMedia("/tmp/anything", { bin })).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("output that is not JSON is an unsupported type", async () => {
    const bin = stub("junk", `echo 'not json'`);
    expect(await probeMedia("/tmp/anything", { bin })).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("a probe that hangs past the timeout is an unsupported type, and the process is gone", async () => {
    const bin = stub("slow", `sleep 10`);
    const started = Date.now();
    expect(await probeMedia("/tmp/anything", { bin, timeoutMs: 200 })).toEqual({ ok: false, reason: "unsupported_type" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a missing ffprobe is a ToolMissingError (a 503 upstream), never a verdict on the file", async () => {
    await expect(probeMedia("/tmp/anything", { bin: join(dir, "nope") })).rejects.toBeInstanceOf(ToolMissingError);
  });
});

// Real ffprobe on the committed fixtures; skipped where the binary is not installed.
describe.skipIf(!hasFfprobe)("probeMedia with the real ffprobe", () => {
  it("a short WAV passes", async () => {
    const v = await probeMedia(join(FIXTURES, "tone.wav"));
    expect(v).toMatchObject({ ok: true, format: "wav" });
  });

  it("an HLS playlist is refused: it can name other URLs to fetch", async () => {
    expect(await probeMedia(join(FIXTURES, "playlist.m3u8"))).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("an unknown container is refused", async () => {
    expect(await probeMedia(join(FIXTURES, "unknown.bin"))).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("a protocol outside the whitelist is not followed (a concat playlist naming a file)", async () => {
    expect(await probeMedia(join(FIXTURES, "concat.txt"))).toEqual({ ok: false, reason: "unsupported_type" });
  });
});

describe.skipIf(!hasFfprobe || !hasFfmpeg)("probeMedia on generated media", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-gen-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const gen = async (name: string, args: string[]) => {
    const out = join(dir, name);
    const r = await runTool(process.env["FFMPEG_PATH"] ?? "ffmpeg", ["-v", "error", "-y", ...args, out], { timeoutMs: 60_000 });
    expect(r.code).toBe(0);
    return out;
  };

  it("an mp4 with video and audio passes", async () => {
    const f = await gen("av.mp4", ["-f", "lavfi", "-i", "testsrc=d=1:s=64x64:r=5", "-f", "lavfi", "-i", "sine=d=1", "-shortest"]);
    expect(await probeMedia(f)).toMatchObject({ ok: true });
  });

  it("an mp4 with no audio track is no_audio", async () => {
    const f = await gen("v.mp4", ["-f", "lavfi", "-i", "testsrc=d=1:s=64x64:r=5"]);
    expect(await probeMedia(f)).toEqual({ ok: false, reason: "no_audio" });
  });
});
