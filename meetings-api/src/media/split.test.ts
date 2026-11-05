import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CUT_WINDOW_MS,
  MAX_PARTS,
  PIECE_MAX_MS,
  SplitError,
  ToolMissingError,
  buildSegmentArgs,
  buildSilenceArgs,
  chooseCuts,
  parseElapsedMs,
  parseSegmentList,
  parseSilences,
  splitAudio,
} from "./split";

// plan § G-3: cut at the longest pause in the 90 s before each mark, else hard at the mark; a stream
// copy; offsets from parts.csv; the ADR-0064 hardening; one ffmpeg slot.

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

  it("splits the longest meeting (3 h + 60 s) into parts that are all within it, and no more than the sanity ceiling", () => {
    const duration = 3 * 3_600_000 + 60_000;
    const cuts = chooseCuts(duration, []);
    const edges = [0, ...cuts, duration];
    for (let i = 1; i < edges.length; i += 1) expect(edges[i]! - edges[i - 1]!).toBeLessThanOrEqual(PIECE_MAX_MS);
    expect(cuts.length + 1).toBeLessThanOrEqual(MAX_PARTS);
  });
});

describe("chooseCuts", () => {
  const piece = PIECE_MAX_MS;
  const pieceS = piece / 1000;

  it("needs no cut for a recording no longer than a part", () => {
    expect(chooseCuts(piece, [])).toEqual([]);
    expect(chooseCuts(10 * 60_000, [silence(100, 102)])).toEqual([]);
  });

  it("cuts a 3 h recording hard at each mark when there is no pause", () => {
    const duration = 3 * 3_600_000 + 60_000;
    const cuts = chooseCuts(duration, []);
    expect(cuts).toEqual(Array.from({ length: Math.ceil(duration / piece) - 1 }, (_, i) => (i + 1) * piece));
  });

  it("cuts in the middle of the longest pause within the window before the mark", () => {
    const silences = [silence(pieceS - 80, pieceS - 79), silence(pieceS - 60, pieceS - 55), silence(pieceS - 30, pieceS - 29)];
    expect(chooseCuts(piece + 5 * 60_000, silences)).toEqual([s(pieceS - 57.5)]);
  });

  it("ignores a pause that ends before the window opens and one shorter than 0.5 s", () => {
    const tooEarly = silence(pieceS - 200, pieceS - 150);
    const tooShort = silence(pieceS - 40, pieceS - 39.7);
    expect(chooseCuts(piece + 600_000, [tooEarly, tooShort])).toEqual([piece]);
  });

  it("takes only the part of a pause that lies inside the window", () => {
    // pause from mark-100 to mark-85: only mark-90..mark-85 is inside the window
    expect(chooseCuts(piece + 300_000, [silence(pieceS - 100, pieceS - 85)])).toEqual([s(pieceS - 87.5)]);
  });

  it("measures the next mark from the previous cut, so no part exceeds the maximum", () => {
    const duration = 3 * 3_600_000 + 60_000;
    const cuts = chooseCuts(duration, [silence(pieceS - 10, pieceS - 8), silence(2 * pieceS - 70, 2 * pieceS - 60)]);
    const edges = [0, ...cuts, duration];
    for (let i = 1; i < edges.length; i += 1) expect(edges[i]! - edges[i - 1]!).toBeLessThanOrEqual(PIECE_MAX_MS);
    expect(cuts[0]).toBe(s(pieceS - 9));
  });

  it("honours a smaller piece length and window", () => {
    expect(chooseCuts(75_000, [silence(27, 30), silence(57, 60)], 30_000, CUT_WINDOW_MS)).toEqual([s(28.5), s(57.75)]);
  });

  it("never cuts again in the pause the previous cut used", () => {
    // one long pause 27-30 s, pieces of 30 s: the second cut must not fall back into it
    expect(chooseCuts(75_000, [silence(27, 30), silence(57, 60)], 30_000)).toEqual([s(28.5), s(57.75)]);
    expect(chooseCuts(75_000, [silence(27, 30)], 30_000)).toEqual([s(28.5), s(58.5)]);
  });

  it("rejects a non-positive piece length", () => {
    expect(() => chooseCuts(1000, [], 0)).toThrow();
  });
});

describe("parseSegmentList", () => {
  it("reads name, start and end in seconds", () => {
    expect(parseSegmentList("part-000.ogg,0.000000,28.500000\npart-001.ogg,28.500000,60\n")).toEqual([
      { name: "part-000.ogg", startMs: 0, endMs: 28500 },
      { name: "part-001.ogg", startMs: 28500, endMs: 60000 },
    ]);
  });

  it("refuses names that could leave the work directory and rows of the wrong shape", () => {
    for (const bad of ["../x.ogg,0,1", "/etc/passwd,0,1", "part-0.ogg,0,1", "part-000.ogg,0", "part-000.ogg,a,b", "part-000.ogg,5,1", "part-000.ogg,0,1,2"]) {
      expect(() => parseSegmentList(bad), bad).toThrow(SplitError);
    }
  });
});

describe("the ffmpeg command lines (ADR-0064 hardening)", () => {
  const joined = (args: string[]) => args.join(" ");

  it("both passes whitelist the file protocol only, pin ogg and whitelist the formats", () => {
    for (const args of [buildSilenceArgs("/w/audio.ogg"), buildSegmentArgs("/w/audio.ogg", [1000], "/w/parts.csv", "/w/part-%03d.ogg")]) {
      expect(joined(args)).toContain("-protocol_whitelist file ");
      expect(joined(args)).toContain("-f ogg -i /w/audio.ogg");
      expect(args).toContain("-format_whitelist");
      expect(args).toContain("-nostdin");
      expect(joined(args)).not.toMatch(/https?:|tcp|tls/);
    }
  });

  it("the segment pass copies the stream (no re-encode) and lists the parts", () => {
    const args = buildSegmentArgs("/w/audio.ogg", [28500, 57750], "/w/parts.csv", "/w/part-%03d.ogg");
    expect(joined(args)).toContain("-c copy");
    expect(joined(args)).toContain("-segment_times 28.500,57.750");
    expect(joined(args)).toContain("-segment_list /w/parts.csv -segment_list_type csv");
    expect(args).not.toContain("libopus");
  });

  it("the silence pass uses the planned threshold and minimum length", () => {
    expect(joined(buildSilenceArgs("/w/a.ogg"))).toContain("silencedetect=noise=-35dB:d=0.5");
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

  it("a recording no longer than a part is not touched: one part, the input itself, ffmpeg never run", async () => {
    const { bin, work } = dirs();
    const marker = join(work, "ffmpeg-ran");
    const ffprobeBin = stub(join(bin, "ffprobe"), probeJson(600));
    const ffmpegBin = stub(join(bin, "ffmpeg"), `touch ${marker}`);
    const parts = await splitAudio({ input: "/in/audio.ogg", workDir: work, ffmpegBin, ffprobeBin });
    expect(parts).toEqual([{ path: "/in/audio.ogg", startMs: 0, durationMs: 600_000 }]);
    expect(existsSync(marker)).toBe(false);
  });

  it("a long recording is cut where the pauses are and the parts come back with the starts parts.csv gave", async () => {
    const { bin, work } = dirs();
    const ffprobeBin = stub(join(bin, "ffprobe"), probeJson(75));
    // The stub plays both passes: a silence log on `-f null`, a part list on `-f segment`.
    const ffmpegBin = stub(
      join(bin, "ffmpeg"),
      `case "$*" in
  *silencedetect*) printf 'silence_start: 27\\nsilence_end: 30 | silence_duration: 3\\nsilence_start: 57\\nsilence_end: 60 | silence_duration: 3\\n' >&2 ;;
  *segment_times*) printf '%s\\n' "$*" > "${work}/segment-args"
     printf 'part-000.ogg,0.000000,28.520000\\npart-001.ogg,28.520000,57.760000\\npart-002.ogg,57.760000,75.000000\\n' > "${work}/parts.csv" ;;
esac`,
    );
    const parts = await splitAudio({ input: "/in/audio.ogg", workDir: work, pieceMaxMs: 30_000, ffmpegBin, ffprobeBin });
    expect(parts).toEqual([
      { path: join(work, "part-000.ogg"), startMs: 0, durationMs: 28520 },
      { path: join(work, "part-001.ogg"), startMs: 28520, durationMs: 29240 },
      { path: join(work, "part-002.ogg"), startMs: 57760, durationMs: 17240 },
    ]);
    expect(readFileSync(join(work, "segment-args"), "utf8")).toContain("-segment_times 28.500,57.750");
  });

  it("reads the duration off the decode pass when the header has none", async () => {
    const { bin, work } = dirs();
    const ffprobeBin = stub(join(bin, "ffprobe"), probeJson(null));
    const ffmpegBin = stub(
      join(bin, "ffmpeg"),
      `case "$*" in
  *silencedetect*) printf 'size=N/A time=00:01:15.00 bitrate=N/A\\n' >&2 ;;
  *segment_times*) printf 'part-000.ogg,0,30\\npart-001.ogg,30,60\\npart-002.ogg,60,75\\n' > "${work}/parts.csv" ;;
esac`,
    );
    const parts = await splitAudio({ input: "/in/audio.ogg", workDir: work, pieceMaxMs: 30_000, ffmpegBin, ffprobeBin });
    expect(parts.map((p) => p.startMs)).toEqual([0, 30000, 60000]);
  });

  it("is audio_unreadable when ffprobe, either ffmpeg pass or the part list fails", async () => {
    const cases: [string, string, string][] = [
      ["ffprobe exits non-zero", `exit 1`, `true`],
      ["ffprobe answers junk", `echo junk`, `true`],
      ["ffprobe says it is not audio", `echo '{"format":{"format_name":"ogg","duration":"75"},"streams":[]}'`, `true`],
      ["the silence pass fails", probeJson(75), `exit 1`],
      ["no part list is written", probeJson(75), `case "$*" in *silencedetect*) true ;; *) true ;; esac`],
      ["a part list with a name outside the work directory", probeJson(75), `case "$*" in *segment_times*) printf '../evil.ogg,0,75\\n' > "$(dirname "$0")/../work/parts.csv" ;; esac`],
    ];
    for (const [name, probeScript, ffmpegScript] of cases) {
      const { bin, work } = dirs();
      const ffprobeBin = stub(join(bin, "ffprobe"), probeScript);
      const ffmpegBin = stub(join(bin, "ffmpeg"), ffmpegScript);
      await expect(splitAudio({ input: "/in/audio.ogg", workDir: work, pieceMaxMs: 30_000, ffmpegBin, ffprobeBin }), name).rejects.toBeInstanceOf(SplitError);
    }
  });

  it("is audio_unreadable when fewer parts than cuts were written", async () => {
    const { bin, work } = dirs();
    const ffprobeBin = stub(join(bin, "ffprobe"), probeJson(75));
    const ffmpegBin = stub(join(bin, "ffmpeg"), `case "$*" in *segment_times*) printf 'part-000.ogg,0,75\\n' > "${work}/parts.csv" ;; esac`);
    await expect(splitAudio({ input: "/in/audio.ogg", workDir: work, pieceMaxMs: 30_000, ffmpegBin, ffprobeBin })).rejects.toBeInstanceOf(SplitError);
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
      await splitAudio({ input: "/in/audio.ogg", workDir: work, ffprobeBin, ffmpegBin: join(bin, "ffmpeg") });
    } finally {
      if (previous === undefined) delete process.env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"];
      else process.env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"] = previous;
    }
    const seen = readFileSync(dump, "utf8");
    expect(seen).not.toContain("gcp-key-secret-value");
    expect(seen).not.toContain("MEETINGS_GCP_SERVICE_ACCOUNT_KEY");
    expect(seen).toContain(`TMPDIR=${work}`);
  });

  it("holds the process's ffmpeg slot: two splits never overlap", async () => {
    const a = dirs();
    const b = dirs();
    const log = join(root, "overlap.log");
    writeFileSync(log, "");
    const probe = (work: string, id: string) => stub(join(work, "..", "bin", "ffprobe"), `echo start-${id} >> ${log}; sleep 0.15; echo end-${id} >> ${log}; ${probeJson(600)}`);
    const pa = splitAudio({ input: "/in/a.ogg", workDir: a.work, ffprobeBin: probe(a.work, "a"), ffmpegBin: "x" });
    const pb = splitAudio({ input: "/in/b.ogg", workDir: b.work, ffprobeBin: probe(b.work, "b"), ffmpegBin: "x" });
    await Promise.all([pa, pb]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });

  it("a lost lease while waiting for the slot never starts the work", async () => {
    const a = dirs();
    const b = dirs();
    const hold = splitAudio({ input: "/in/a.ogg", workDir: a.work, ffprobeBin: stub(join(a.bin, "ffprobe"), `sleep 0.2; ${probeJson(600)}`), ffmpegBin: "x" });
    const controller = new AbortController();
    const marker = join(b.work, "ran");
    const waiting = splitAudio({ input: "/in/b.ogg", workDir: b.work, ffprobeBin: stub(join(b.bin, "ffprobe"), `touch ${marker}; ${probeJson(600)}`), ffmpegBin: "x", signal: controller.signal });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort(new Error("lease lost"));
    await expect(waiting).rejects.toThrow("lease lost");
    await hold;
    expect(existsSync(marker)).toBe(false);
  });
});
