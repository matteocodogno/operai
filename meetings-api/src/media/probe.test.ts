import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLOAD_CONTENT_TYPES } from "../lib/storage";
import {
  MAX_AUDIO_MS,
  ToolMissingError,
  buildProbeArgs,
  demuxerForContentType,
  judgeProbe,
  pinnedDemuxer,
  probeMedia,
  protocolsFor,
  runTool,
} from "./probe";

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

  it("an UPLOAD must state a length: requireDuration refuses no, N/A, negative and non-numeric durations as unsupported", () => {
    const audio = [{ codec_type: "audio" }];
    for (const duration of [null, "N/A", "-5", "abc"]) {
      expect(judgeProbe(probeJson("matroska,webm", audio, duration), MAX_AUDIO_MS, { requireDuration: true })).toEqual({ ok: false, reason: "unsupported_type" });
    }
    expect(judgeProbe(probeJson("wav", audio, "0"), MAX_AUDIO_MS, { requireDuration: true })).toMatchObject({ ok: true, durationMs: 0 });
    expect(judgeProbe(probeJson("wav", audio, "12.5"), MAX_AUDIO_MS, { requireDuration: true })).toMatchObject({ ok: true, durationMs: 12_500 });
  });

  it("requireDuration does not hide the other verdicts: too_long and no_audio still win over the missing duration", () => {
    expect(judgeProbe(probeJson("wav", [{ codec_type: "audio" }], "99999"), MAX_AUDIO_MS, { requireDuration: true })).toEqual({ ok: false, reason: "too_long" });
    expect(judgeProbe(probeJson("wav", [], null), MAX_AUDIO_MS, { requireDuration: true })).toEqual({ ok: false, reason: "no_audio" });
    expect(judgeProbe(probeJson("hls", [{ codec_type: "audio" }], null), MAX_AUDIO_MS, { requireDuration: true })).toEqual({ ok: false, reason: "unsupported_type" });
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
  it("the argument vector pins the whitelist and the input format before the input, asks for JSON and ends at the input", () => {
    const args = buildProbeArgs("https://h/k?s=1", "mov");
    expect(args.indexOf("-protocol_whitelist")).toBeGreaterThanOrEqual(0);
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("https,tls,tcp");
    expect(args.indexOf("-protocol_whitelist")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-f") + 1]).toBe("mov");
    expect(args.indexOf("-f")).toBeLessThan(args.indexOf("-i"));
    expect(args.slice(-2)).toEqual(["-i", "https://h/k?s=1"]);
    expect(args).toContain("-show_streams");
    expect(args).toContain("-show_format");
    expect(args[args.indexOf("-print_format") + 1]).toBe("json");
  });

  it("a scheme list is not a destination list: a URL is never probed without a pinned format (no playlist demuxer can be chosen)", () => {
    expect(() => buildProbeArgs("https://h/k?s=1")).toThrow();
    expect(() => buildProbeArgs("http://localhost:9000/b/k?s=1")).toThrow();
    for (const bad of ["hls", "mov,mp4", "-i", "", "mov;x"]) expect(() => buildProbeArgs("https://h/k", bad)).toThrow();
  });

  it("a local file is probed with the file protocol only, and no network protocol appears anywhere in the vector", () => {
    for (const args of [buildProbeArgs("/work/in-000000"), buildProbeArgs("/work/in-000000", "matroska")]) {
      expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
      expect(args.slice(-2)).toEqual(["-i", "/work/in-000000"]);
      expect(args.join(" ")).not.toMatch(/https?|tcp|tls|ftp/);
    }
  });

  it("pins the demuxer from the declared content type: never a playlist-following one", () => {
    expect(demuxerForContentType("video/mp4")).toBe("mov");
    expect(demuxerForContentType("audio/mpeg")).toBe("mp3");
    expect(demuxerForContentType("video/webm")).toBe("matroska");
    for (const type of UPLOAD_CONTENT_TYPES) {
      const demuxer = demuxerForContentType(type);
      expect(demuxer).toBeDefined();
      expect(["hls", "dash", "concat", "sdp", "rtsp", "applehttp"]).not.toContain(demuxer!);
    }
    expect(demuxerForContentType("application/vnd.apple.mpegurl")).toBeUndefined();
  });

  it("the decode is pinned to the first allowlisted name of the format the probe reported", () => {
    expect(pinnedDemuxer("mov,mp4,m4a,3gp,3g2,mj2")).toBe("mov");
    expect(pinnedDemuxer("matroska,webm")).toBe("matroska");
    expect(pinnedDemuxer("wav")).toBe("wav");
    expect(pinnedDemuxer("hls,applehttp")).toBeUndefined();
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

  it("runs the tool with a minimal environment: PATH and TMPDIR only, none of the service's secrets", async () => {
    const secrets = {
      DATABASE_URL: "postgresql://u:p@db/x",
      AZURE_SPEECH_KEY: "azure-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      MEETINGS_S3_SECRET_ACCESS_KEY: "s3-secret",
      SERVICE_CLIENT_SECRET: "client-secret",
    };
    const previous = Object.fromEntries(Object.keys(secrets).map((k) => [k, process.env[k]]));
    Object.assign(process.env, secrets);
    try {
      const r = await runTool("env", [], { timeoutMs: 5000, tmpDir: "/work/job-1" });
      const seen = Object.fromEntries(r.stdout.trim().split("\n").map((line) => [line.split("=")[0], line.slice(line.indexOf("=") + 1)]));
      expect(Object.keys(seen).filter((k) => !["PATH", "TMPDIR", "PWD", "SHLVL", "_", "OLDPWD"].includes(k as string))).toEqual([]);
      expect(seen["TMPDIR"]).toBe("/work/job-1");
      expect(seen["PATH"]).toBe(process.env["PATH"]);
      for (const secret of Object.values(secrets)) expect(r.stdout).not.toContain(secret);
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
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

  it("requireDuration is passed through: a duration-less document is refused for an upload, accepted for a recording run", async () => {
    const bin = stub("nodur", `echo '{"format":{"format_name":"matroska,webm"},"streams":[{"codec_type":"audio"}]}'`);
    expect(await probeMedia("/tmp/anything", { bin, requireDuration: true })).toEqual({ ok: false, reason: "unsupported_type" });
    expect(await probeMedia("/tmp/anything", { bin })).toEqual({ ok: true, durationMs: null, format: "matroska,webm" });
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
