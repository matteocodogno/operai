import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PARTS,
  OVERLAP_MAX_MS,
  OVERLAP_MIN_MS,
  OVERLAP_TARGET_MS,
  PIECE_MAX_MS,
  SplitError,
  ToolMissingError,
  buildPartArgs,
  buildSilenceArgs,
  chooseParts,
  parseElapsedMs,
  parseSilences,
  splitAudio,
} from "./split";

// plan § H-1: overlapping parts of at most 10 min, both edges in a pause where one exists, written by one
// output-seeking stream copy each; the silence pass runs on every recording; the ADR-0064 hardening; one slot.

const s = (seconds: number) => Math.round(seconds * 1000);
const silence = (from: number, to: number) => ({ startMs: s(from), endMs: s(to) });

describe("parseSilences", () => {
  it("pairs silence_start and silence_end lines in order", () => {
    const log = [
      "[silencedetect @ 0x1] silence_start: 12.5",
      "[silencedetect @ 0x1] silence_end: 14.25 | silence_duration: 1.75",
      "size=N/A time=00:00:30.00 bitrate=N/A speed= 300x",
      "[silencedetect @ 0x1] silence_start: 20",
      "[silencedetect @ 0x1] silence_end: 21 | silence_duration: 1",
    ].join("\n");
    expect(parseSilences(log)).toEqual([silence(12.5, 14.25), silence(20, 21)]);
  });

  it("closes a trailing pause at the duration when it is known (a recording that ends in silence), else drops it", () => {
    expect(parseSilences("silence_start: 5\n", 35_000)).toEqual([{ startMs: 5000, endMs: 35_000 }]);
    expect(parseSilences("silence_start: 5\n")).toEqual([]);
    expect(parseSilences("silence_start: 40\n", 35_000)).toEqual([]);
  });

  it("drops a pause that never ended and ignores unrelated lines", () => {
    expect(parseSilences("noise\nsilence_start: 5\n")).toEqual([]);
    expect(parseSilences("silence_end: 5 | silence_duration: 1\n")).toEqual([]);
  });

  it("clamps a negative start to 0", () => {
    expect(parseSilences("silence_start: -0.02\nsilence_end: 1.5\n")).toEqual([{ startMs: 0, endMs: 1500 }]);
  });
});

describe("parseElapsedMs", () => {
  it("reads the last progress time", () => {
    expect(parseElapsedMs("time=00:00:01.00 x\nsize=N/A time=01:02:03.50 bitrate=N/A")).toBe(3723500);
    expect(parseElapsedMs("nothing")).toBeNull();
  });
});

describe("PIECE_MAX_MS (T107: Google refuses a Chirp 3 batch file over 20 minutes)", () => {
  it("stays under Google's 20-minute limit with a margin for the cut and the container", () => {
    // Recorded: "Only audio files up to 20 minutes long are supported for BatchRecognize." (code 3, billed 0 s)
    expect(PIECE_MAX_MS).toBeLessThanOrEqual(19 * 60_000);
    expect(PIECE_MAX_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("keeps the overlap constants of plan H-1", () => {
    expect([OVERLAP_MIN_MS, OVERLAP_TARGET_MS, OVERLAP_MAX_MS]).toEqual([60_000, 90_000, 120_000]);
    expect(MAX_PARTS).toBe(32);
  });
});

describe("chooseParts (plan H-1)", () => {
  const piece = PIECE_MAX_MS;
  const longest = s(10_860); // 3 h + 60 s
  const gaps = (parts: { startMs: number; endMs: number }[]) => parts.slice(1).map((p, i) => parts[i]!.endMs - p.startMs);

  it("is one part for a recording no longer than a part", () => {
    expect(chooseParts(piece, [])).toEqual([{ startMs: 0, endMs: piece }]);
    expect(chooseParts(5 * 60_000, [silence(100, 102)])).toEqual([{ startMs: 0, endMs: 300_000 }]);
  });

  it("10 860 s with no pause: 22 parts, each at most 600 s, overlaps of 90 s", () => {
    const parts = chooseParts(longest, []);
    expect(parts.length).toBe(22);
    expect(parts[0]!.startMs).toBe(0);
    expect(parts[parts.length - 1]!.endMs).toBe(longest);
    for (const part of parts) expect(part.endMs - part.startMs).toBeLessThanOrEqual(piece);
    for (const overlap of gaps(parts)) {
      expect(overlap).toBeGreaterThanOrEqual(60_000);
      expect(overlap).toBeLessThanOrEqual(120_000);
      expect(overlap).toBe(90_000);
    }
  });

  it("10 860 s with pauses offered: both edges of each cut in a pause, overlaps within [60, 120] s", () => {
    // a 2 s pause every 37 s: every window of 90 s holds two or three of them
    const pauses = Array.from({ length: 300 }, (_, i) => silence(i * 37 + 10, i * 37 + 12));
    const parts = chooseParts(longest, pauses);
    expect(parts.length).toBeLessThanOrEqual(MAX_PARTS);
    const inPause = (ms: number) => pauses.some((p) => ms >= p.startMs && ms <= p.endMs);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      expect(part.endMs - part.startMs).toBeLessThanOrEqual(piece);
      if (i > 0) expect(inPause(part.startMs), `start of part ${i + 1}`).toBe(true);
      if (i < parts.length - 1) expect(inPause(part.endMs), `end of part ${i + 1}`).toBe(true);
    }
    for (const overlap of gaps(parts)) {
      expect(overlap).toBeGreaterThanOrEqual(60_000);
      expect(overlap).toBeLessThanOrEqual(120_000);
    }
  });

  it("ends a part in the middle of the longest pause in the 90 s before the mark, never reaching back past half a part", () => {
    const pieceS = piece / 1000;
    const pauses = [silence(pieceS - 80, pieceS - 79), silence(pieceS - 60, pieceS - 55), silence(pieceS - 30, pieceS - 29), silence(pieceS - 400, pieceS - 300)];
    expect(chooseParts(piece + 5 * 60_000, pauses)[0]!.endMs).toBe(s(pieceS - 57.5));
  });

  it("starts the next part in the middle of the longest pause 60-120 s before the end, else 90 s before", () => {
    const pauses = [silence(500, 504)]; // the cut falls hard at 600 s (no pause in the last 90 s); 504 is inside [480, 540]
    const [a, b] = chooseParts(piece + 5 * 60_000, pauses);
    expect(a!.endMs).toBe(piece);
    expect(b!.startMs).toBe(s(502));
    expect(chooseParts(piece + 5 * 60_000, [])[1]!.startMs).toBe(piece - OVERLAP_TARGET_MS);
  });

  it("takes only the part of a pause that lies inside the window, and ignores one under 0.5 s", () => {
    const pieceS = piece / 1000;
    // from mark-100 to mark-85: only mark-90..mark-85 is inside the window
    expect(chooseParts(piece + 300_000, [silence(pieceS - 100, pieceS - 85)])[0]!.endMs).toBe(s(pieceS - 87.5));
    expect(chooseParts(piece + 300_000, [silence(pieceS - 40, pieceS - 39.7)])[0]!.endMs).toBe(piece);
  });

  it("on a tie takes the later pause", () => {
    const pieceS = piece / 1000;
    expect(chooseParts(piece + 300_000, [silence(pieceS - 60, pieceS - 58), silence(pieceS - 30, pieceS - 28)])[0]!.endMs).toBe(s(pieceS - 29));
  });

  it("honours a smaller piece length and overlap (the real-ffmpeg case: 30 s and 10 s)", () => {
    const parts = chooseParts(75_000, [silence(27, 30), silence(57, 60)], { pieceMaxMs: 30_000, overlapTargetMs: 10_000 });
    expect(parts[0]!.startMs).toBe(0);
    expect(parts[0]!.endMs).toBeGreaterThanOrEqual(27_000); // in the 27-30 s pause
    expect(parts[0]!.endMs).toBeLessThanOrEqual(30_000);
    for (const part of parts) expect(part.endMs - part.startMs).toBeLessThanOrEqual(30_000);
    expect(parts[parts.length - 1]!.endMs).toBe(75_000);
    for (const overlap of gaps(parts)) expect(overlap).toBeGreaterThanOrEqual(6_600);
  });

  it("refuses a recording that would need more than MAX_PARTS", () => {
    expect(() => chooseParts(40 * 3_600_000, [])).toThrow(SplitError);
  });

  it("rejects a non-positive piece length", () => {
    expect(() => chooseParts(1000, [], { pieceMaxMs: 0 })).toThrow();
  });
});

describe("the ffmpeg command lines (ADR-0064 hardening)", () => {
  const joined = (args: string[]) => args.join(" ");

  it("both passes whitelist the file protocol only, pin ogg and whitelist the formats", () => {
    for (const args of [buildSilenceArgs("/w/audio.ogg"), buildPartArgs("/w/audio.ogg", 1000, 5000, "/w/part-001.ogg")]) {
      expect(joined(args)).toContain("-protocol_whitelist file ");
      expect(joined(args)).toContain("-f ogg -i /w/audio.ogg");
      expect(args).toContain("-format_whitelist");
      expect(args).toContain("-nostdin");
      expect(joined(args)).not.toMatch(/https?:|tcp|tls/);
    }
  });

  it("a part is one output-seeking stream copy (no re-encode, no segment muxer)", () => {
    const args = buildPartArgs("/w/audio.ogg", 28_500, 58_500, "/w/part-002.ogg");
    expect(joined(args)).toContain("-ss 28.500 -t 30.000 -c copy -f ogg /w/part-002.ogg");
    expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
    expect(args).not.toContain("libopus");
    expect(args).not.toContain("segment");
  });

  it("the silence pass uses the planned threshold and minimum length, on a speech-band signal", () => {
    expect(joined(buildSilenceArgs("/w/a.ogg"))).toContain("highpass=f=150,lowpass=f=4000,silencedetect=noise=-35dB:d=0.5");
  });
});

// ─── splitAudio with stubbed binaries ────────────────────────────────────────

describe("splitAudio", () => {
  const root = mkdtempSync(join(tmpdir(), "split-stub-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const dirs = () => {
    const base = join(root, `case-${n++}`);
    const bin = join(base, "bin");
    const work = join(base, "work");
    for (const d of [bin, work]) Bun.spawnSync(["mkdir", "-p", d]);
    return { bin, work };
  };
  const stub = (path: string, script: string) => {
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const probeJson = (durationSeconds: number | null) =>
    `echo '{"format":{"format_name":"ogg"${durationSeconds === null ? "" : `,"duration":"${durationSeconds}"`}},"streams":[{"codec_type":"audio"}]}'`;

  const SILENCE_LOG = "silence_start: 27\\nsilence_end: 30 | silence_duration: 3\\nsilence_start: 57\\nsilence_end: 60 | silence_duration: 3\\n";

  it("a recording no longer than a part is not re-muxed: one part, the input itself, and the silence list still comes back", async () => {
    const { bin, work } = dirs();
    const marker = join(work, "ffmpeg-args");
    const ffprobeBin = stub(join(bin, "ffprobe"), probeJson(600));
    const ffmpegBin = stub(join(bin, "ffmpeg"), `printf '%s\\n' "$*" >> ${marker}; printf '${SILENCE_LOG}' >&2`);
    const result = await splitAudio({ input: "/in/audio.ogg", workDir: work, ffmpegBin, ffprobeBin });
    expect(result.parts).toEqual([{ path: "/in/audio.ogg", startMs: 0, endMs: 600_000 }]);
    expect(result.durationMs).toBe(600_000);
    expect(result.silences).toEqual([silence(27, 30), silence(57, 60)]);
    // exactly one ffmpeg run: the silence pass
    const runs = readFileSync(marker, "utf8").trim().split("\n");
    expect(runs.length).toBe(1);
    expect(runs[0]).toContain("silencedetect");
  });

  it("a long recording is cut into overlapping parts, one stream copy each, with the planned spans", async () => {
    const { bin, work } = dirs();
    const ffprobeBin = stub(join(bin, "ffprobe"), probeJson(75));
    // The stub plays both passes: a silence log on `-f null`, a written part on `-f ogg`.
    const ffmpegBin = stub(
      join(bin, "ffmpeg"),
      `case "$*" in
  *silencedetect*) printf '${SILENCE_LOG}' >&2 ;;
  *"-c copy"*) printf '%s\\n' "$*" >> "${work}/part-args"
     for last; do :; done; : > "$last" ;;
esac`,
    );
    const result = await splitAudio({ input: "/in/audio.ogg", workDir: work, pieceMaxMs: 30_000, overlapTargetMs: 10_000, ffmpegBin, ffprobeBin });
    expect(result.parts.map((p) => [p.startMs, p.endMs])).toEqual(
      chooseParts(75_000, [silence(27, 30), silence(57, 60)], { pieceMaxMs: 30_000, overlapTargetMs: 10_000 }).map((p) => [p.startMs, p.endMs]),
    );
    expect(result.parts.map((p) => p.path)).toEqual(result.parts.map((_, i) => join(work, `part-${String(i + 1).padStart(3, "0")}.ogg`)));
    expect(result.silences).toEqual([silence(27, 30), silence(57, 60)]);
    expect(result.durationMs).toBe(75_000);
    const runs = readFileSync(join(work, "part-args"), "utf8").trim().split("\n");
    expect(runs.length).toBe(result.parts.length);
    expect(runs[0]).toContain("-ss 0.000 -t 29.167");
  });

  it("reads the duration off the decode pass when the header has none", async () => {
    const { bin, work } = dirs();
    const ffprobeBin = stub(join(bin, "ffprobe"), probeJson(null));
    const ffmpegBin = stub(
      join(bin, "ffmpeg"),
      `case "$*" in
  *silencedetect*) printf 'size=N/A time=00:01:15.00 bitrate=N/A\\n' >&2 ;;
  *"-c copy"*) for last; do :; done; : > "$last" ;;
esac`,
    );
    const result = await splitAudio({ input: "/in/audio.ogg", workDir: work, pieceMaxMs: 30_000, overlapTargetMs: 10_000, ffmpegBin, ffprobeBin });
    expect(result.durationMs).toBe(75_000);
    expect(result.parts.length).toBeGreaterThan(1);
  });

  it("is audio_unreadable when ffprobe, the silence pass or a part pass fails, or a part is not written", async () => {
    const cases: [string, string, string][] = [
      ["ffprobe exits non-zero", `exit 1`, `true`],
      ["ffprobe answers junk", `echo junk`, `true`],
      ["ffprobe says it is not audio", `echo '{"format":{"format_name":"ogg","duration":"75"},"streams":[]}'`, `true`],
      ["the silence pass fails", probeJson(75), `exit 1`],
      ["a part pass fails", probeJson(75), `case "$*" in *silencedetect*) true ;; *) exit 1 ;; esac`],
      ["a part is not written", probeJson(75), `true`],
    ];
    for (const [name, probeScript, ffmpegScript] of cases) {
      const { bin, work } = dirs();
      const ffprobeBin = stub(join(bin, "ffprobe"), probeScript);
      const ffmpegBin = stub(join(bin, "ffmpeg"), ffmpegScript);
      await expect(splitAudio({ input: "/in/audio.ogg", workDir: work, pieceMaxMs: 30_000, overlapTargetMs: 10_000, ffmpegBin, ffprobeBin }), name).rejects.toBeInstanceOf(SplitError);
    }
  });

  it("a missing binary is a ToolMissingError, not a verdict on the audio", async () => {
    const { bin, work } = dirs();
    await expect(
      splitAudio({ input: "/in/audio.ogg", workDir: work, ffmpegBin: join(bin, "nope"), ffprobeBin: join(bin, "nope") }),
    ).rejects.toBeInstanceOf(ToolMissingError);
  });

  it("runs the tools with a minimal environment: none of the service's secrets, the Google key above all", async () => {
    const { bin, work } = dirs();
    const dump = join(work, "env.txt");
    const ffprobeBin = stub(join(bin, "ffprobe"), `env > ${dump}; ${probeJson(600)}`);
    const previous = process.env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"];
    process.env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"] = "gcp-key-secret-value";
    try {
      await splitAudio({ input: "/in/audio.ogg", workDir: work, ffprobeBin, ffmpegBin: stub(join(bin, "ffmpeg"), `env > ${dump}-ffmpeg; true`) });
    } finally {
      if (previous === undefined) delete process.env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"];
      else process.env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"] = previous;
    }
    for (const file of [dump, `${dump}-ffmpeg`]) {
      const seen = readFileSync(file, "utf8");
      expect(seen).not.toContain("gcp-key-secret-value");
      expect(seen).not.toContain("MEETINGS_GCP_SERVICE_ACCOUNT_KEY");
      expect(seen).toContain(`TMPDIR=${work}`);
    }
  });

  it("holds the process's ffmpeg slot: two splits never overlap", async () => {
    const a = dirs();
    const b = dirs();
    const log = join(root, "overlap.log");
    writeFileSync(log, "");
    const probe = (work: string, id: string) => stub(join(work, "..", "bin", "ffprobe"), `echo start-${id} >> ${log}; sleep 0.15; echo end-${id} >> ${log}; ${probeJson(600)}`);
    const noop = (d: { bin: string }) => stub(join(d.bin, "ffmpeg"), "true");
    const pa = splitAudio({ input: "/in/a.ogg", workDir: a.work, ffprobeBin: probe(a.work, "a"), ffmpegBin: noop(a) });
    const pb = splitAudio({ input: "/in/b.ogg", workDir: b.work, ffprobeBin: probe(b.work, "b"), ffmpegBin: noop(b) });
    await Promise.all([pa, pb]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });

  it("a lost lease while waiting for the slot never starts the work", async () => {
    const a = dirs();
    const b = dirs();
    const hold = splitAudio({ input: "/in/a.ogg", workDir: a.work, ffprobeBin: stub(join(a.bin, "ffprobe"), `sleep 0.2; ${probeJson(600)}`), ffmpegBin: stub(join(a.bin, "ffmpeg"), "true") });
    const controller = new AbortController();
    const marker = join(b.work, "ran");
    const waiting = splitAudio({ input: "/in/b.ogg", workDir: b.work, ffprobeBin: stub(join(b.bin, "ffprobe"), `touch ${marker}; ${probeJson(600)}`), ffmpegBin: stub(join(b.bin, "ffmpeg"), "true"), signal: controller.signal });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort(new Error("lease lost"));
    await expect(waiting).rejects.toThrow("lease lost");
    await hold;
    expect(existsSync(marker)).toBe(false);
  });
});
