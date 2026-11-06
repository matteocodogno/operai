import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleApiError, type GoogleAuth } from "../lib/google/auth";
import { createFakeTransientStorage, type FakeTransientStorage } from "../lib/google/fakeTransientStorage";
import { PIECE_MAX_MS, SplitError, type SplitPart, type SplitResult } from "../media/split";
import {
  WORD_OFFSETS,
  MAX_OUTPUT_BYTES,
  MAX_TRIES,
  MAX_WORDS_PER_PART,
  POLL_DEADLINE_MS,
  SPEECH_MAX_INFLIGHT,
  codeForRpc,
  createGoogleTranscriber,
  parseOffsetMs,
  pollDelayMs,
  wordsOfPart,
} from "./googleSpeech";
import { stitch } from "./stitch";
import { TranscriptionError, type TranscriptionFailureCode, type TranscriptionOutcome } from "./transcriber";

// plan § G-2, G-3, G-8, G-12: REST against hand-built fixtures; nothing reaches Google.

const FIXTURES = join(import.meta.dir, "../../test-fixtures/google-speech");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const fill = (text: string, vars: Record<string, string>): string => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

const scratch = mkdtempSync(join(tmpdir(), "google-speech-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MEETING = "meeting_1";
const ATTEMPT = 2;
const PREFIX = `transcribe/${MEETING}/`;
const OUT = (part = 1, tryNo = 1) => `transcribe/${MEETING}/${ATTEMPT}/out/${part}-${tryNo}/`;
/** How long each test part is, unless a scenario says otherwise. */
const PART_MS = 35_000;
/** "Everything is silence": the detector then never finds a gap unless a test gives it sound (`silences: []`). */
const ALL_SILENT = [{ startMs: 0, endMs: 100_000_000 }];
const auth: GoogleAuth = { accessToken: async () => "tok", client: null as never };

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
}

interface Scenario {
  /** Part start offsets; one entry per part, each `PART_MS` long. */
  starts?: number[];
  /** Part spans, overlapping or not; wins over `starts`. */
  spans?: { startMs: number; endMs: number }[];
  /** The silences of the whole recording; the default is all silence (no gap is ever detected). `[]` = all sound. */
  silences?: { startMs: number; endMs: number }[];
  submit?: (part: number, tryNo: number) => Response | Error;
  /** `pollNo` is 1-based per try. Return "running", "done", a Response or an Error. */
  poll?: (part: number, pollNo: number, tryNo: number) => "running" | "done" | Response | Error;
  /** The operation document fixture for a finished try. */
  operation?: (part: number, tryNo: number) => string;
  output?: (part: number, tryNo: number) => string | Uint8Array;
  /** Rewrites the output file URI named in the finished operation. */
  outputUri?: (part: number, uri: string, tryNo: number) => string;
  split?: () => Promise<SplitResult>;
  wordOffsets?: boolean;
  deleteOperation?: () => Response | Error;
  /** Real milliseconds each fake sleep takes (default one macrotask): lets a slower part catch up before a faster one times out. */
  realDelayMs?: number;
  /** Shared by several worlds: counts operations submitted and not yet done. */
  inflight?: { now: number; peak: number };
  /** Tries per part; default the shipped bound (`MAX_TRIES`, 1 since A8). The retry tests raise it to exercise the machinery. */
  maxTries?: number;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function world(scenario: Scenario = {}) {
  const storage: FakeTransientStorage = createFakeTransientStorage();
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const polls = new Map<string, number>();
  const submits: { part: number; tryNo: number }[] = [];
  let clock = 1_000_000;
  const spans = scenario.spans ?? (scenario.starts ?? [0]).map((startMs) => ({ startMs, endMs: startMs + PART_MS }));
  const dir = mkdtempSync(join(scratch, "case-"));
  const parts: SplitPart[] = spans.map((span, i) => {
    const path = join(dir, `part-${i}.ogg`);
    writeFileSync(path, "OggS-fake");
    return { path, ...span };
  });
  // The recorded form is `projects/<number>/locations/eu/operations/v2-<uuid>` (batch-submit.json); the test's own
  // ids end in the part and the try so a poll can be routed back to them.
  const opNameOf = (part: number, tryNo: number) => `projects/123456789012/locations/eu/operations/v2-00000000-0000-0000-0000-p${part}t${tryNo}`;
  const routeOf = (opName: string): { part: number; tryNo: number } => {
    const m = /-p(\d+)t(\d+)$/.exec(opName)!;
    return { part: Number(m[1]), tryNo: Number(m[2]) };
  };
  const inputUriOf = (part: number) => storage.uri(`transcribe/${MEETING}/${ATTEMPT}/in/${part}.ogg`);
  const counted = new Set<string>();

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url, body });
    if (method === "POST" && url.pathname.endsWith(":batchRecognize")) {
      const part = Number(/\/in\/(\d+)\.ogg$/.exec(body.files[0].uri)![1]);
      const tryNo = Number(/\/out\/\d+-(\d+)\/$/.exec(body.recognitionOutputConfig.gcsOutputConfig.uri)![1]);
      submits.push({ part, tryNo });
      const custom = scenario.submit?.(part, tryNo);
      if (custom instanceof Error) throw custom;
      if (scenario.inflight) {
        scenario.inflight.now += 1;
        scenario.inflight.peak = Math.max(scenario.inflight.peak, scenario.inflight.now);
        counted.add(`${part}-${tryNo}`);
      }
      return custom ?? json({ ...JSON.parse(fixture("batch-submit.json")), name: opNameOf(part, tryNo) });
    }
    const op = /\/(projects\/[^/]+\/locations\/eu\/operations\/(v2-[A-Za-z0-9-]+))$/.exec(url.pathname);
    if (op && method === "GET") {
      const { part, tryNo } = routeOf(op[2]!);
      const key = `${part}-${tryNo}`;
      const pollNo = (polls.get(key) ?? 0) + 1;
      polls.set(key, pollNo);
      const verdict = scenario.poll?.(part, pollNo, tryNo) ?? (pollNo === 1 ? "running" : "done");
      if (verdict instanceof Error) throw verdict;
      if (verdict instanceof Response) return verdict;
      if (verdict === "running") return new Response(fixture("operation-running.json"), { status: 200 });
      if (scenario.inflight && counted.delete(key)) scenario.inflight.now -= 1;
      const outKey = `${OUT(part, tryNo)}${part}_transcript_ab12.json`;
      const raw = scenario.operation?.(part, tryNo) ?? fixture("operation-done.json");
      const outUri = scenario.outputUri?.(part, storage.uri(outKey), tryNo) ?? storage.uri(outKey);
      if (!raw.includes("\"error\"")) storage.seed(outKey, scenario.output?.(part, tryNo) ?? fixture("output-recorded-it-word-offsets.json"));
      return new Response(fill(raw, { INPUT_URI: inputUriOf(part), OUTPUT_URI: outUri }), { status: 200 });
    }
    if (op && method === "DELETE") {
      const custom = scenario.deleteOperation?.();
      if (custom instanceof Error) throw custom;
      return custom ?? json({});
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  const transcriber = createGoogleTranscriber({
    auth,
    projectId: "operai-meetings-test",
    location: "eu",
    storage: async () => storage,
    fetchImpl,
    tmpRoot: scratch,
    now: () => clock,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      sleeps.push(ms);
      clock += ms;
      await new Promise((r) => setTimeout(r, scenario.realDelayMs ?? 0)); // a real macrotask: other parts get to run
      signal.throwIfAborted();
    },
    split: scenario.split ?? (async () => ({ parts, silences: scenario.silences ?? ALL_SILENT, durationMs: parts[parts.length - 1]!.endMs })),
    ...(scenario.wordOffsets !== undefined ? { wordOffsets: scenario.wordOffsets } : {}),
    ...(scenario.maxTries !== undefined ? { maxTries: scenario.maxTries } : {}),
  });
  const run = (locale: "it-IT" | "en-US" = "en-US", signal?: AbortSignal, context = { meetingId: MEETING, attempt: ATTEMPT }) =>
    transcriber.transcribe(new Blob(["audio"]), locale, 3, signal, context);
  return { storage, seen, sleeps, run, polls, submits, advance: (ms: number) => void (clock += ms) };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (e: unknown) => e);
const segmentsOf = (outcome: TranscriptionOutcome) => {
  if (outcome.kind !== "segments") throw new Error("expected segments");
  return outcome;
};

let logged: string[];
let spies: ReturnType<typeof spyOn>[];
beforeEach(() => {
  logged = [];
  const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  spies = [spyOn(console, "log").mockImplementation(capture), spyOn(console, "warn").mockImplementation(capture), spyOn(console, "error").mockImplementation(capture)];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

/** The bucket is empty; the first storage call cleared older attempts and the last emptied this attempt's prefix (the `finally`). */
const cleaned = (storage: FakeTransientStorage) => {
  expect(storage.keys()).toEqual([]);
  expect(storage.events[0]).toEqual({ op: "deleteBefore", key: `${PREFIX}<${ATTEMPT}` });
  expect(storage.events[storage.events.length - 1]).toEqual({ op: "deletePrefix", key: `${PREFIX}${ATTEMPT}/` });
};

describe("one part", () => {
  it("transcribes a RECORDED output, with the part offsets and the speakers in order of appearance", async () => {
    const w = world();
    const outcome = segmentsOf(await w.run("it-IT"));
    expect(outcome.partStartsMs).toEqual([0]);
    expect(outcome.parts).toEqual([{ startMs: 0, endMs: PART_MS }]);
    expect(outcome.gaps).toEqual([]);
    // output-recorded-it-word-offsets.json: ONE result, two speaker runs, times from the run's first and last word.
    expect(outcome.segments).toEqual([
      {
        ordinal: 0,
        startMs: 0,
        endMs: 17_080,
        part: 1,
        speakerKey: "s1",
        text: "Il cliente ha segnalato la documentazione tecnica prima della riunione di lunedì. Il progetto ha completato l'analisi dei rischi con il supporto del reparto legale.",
      },
      {
        ordinal: 1,
        startMs: 18_040,
        endMs: 29_760,
        part: 1,
        speakerKey: "s2",
        text: "Il fornitore richiede ancora il piano di rilascio secondo le priorità di questo mese. Il nuovo sistema richiede ancora l'analisi dei rischi entro venerdì prossimo. Il team di sviluppo richiede ancora le modifiche al contratto",
      },
    ]);
    cleaned(w.storage);
  });

  it("sends the planned request: chirp_3, ONE locale, diarization, output to our bucket, no speaker counts", async () => {
    for (const locale of ["it-IT", "en-US"] as const) {
      const w = world();
      await w.run(locale);
      const post = w.seen.find((r) => r.method === "POST")!;
      expect(post.url.host).toBe("eu-speech.googleapis.com");
      expect(post.url.pathname).toBe("/v2/projects/operai-meetings-test/locations/eu/recognizers/_:batchRecognize");
      const body = post.body as { config: Record<string, unknown>; files: { uri: string }[]; recognitionOutputConfig: Record<string, unknown> };
      expect(body.config["model"]).toBe("chirp_3");
      expect(body.config["languageCodes"]).toEqual([locale]);
      expect(JSON.stringify(body)).not.toContain('"auto"');
      expect(body.config["autoDecodingConfig"]).toEqual({});
      expect(body.config["features"]).toEqual({ diarizationConfig: {}, enableWordTimeOffsets: true }); // T107: the only source of times
      expect(JSON.stringify(body)).not.toMatch(/SpeakerCount/i);
      expect(body.files).toEqual([{ uri: `gs://fake-transient-bucket/transcribe/${MEETING}/${ATTEMPT}/in/1.ogg` }]);
      expect(body.recognitionOutputConfig).toEqual({ gcsOutputConfig: { uri: `gs://fake-transient-bucket/${OUT()}` } });
      expect(JSON.stringify(body)).not.toContain("inlineResponseConfig");
    }
  });

  it("asks for word offsets by default (T107) and not when switched off", async () => {
    expect(WORD_OFFSETS).toBe(true);
    const on = world();
    await on.run();
    expect((on.seen.find((r) => r.method === "POST")!.body as { config: { features: unknown } }).config.features).toEqual({ diarizationConfig: {}, enableWordTimeOffsets: true });
    const off = world({ wordOffsets: false, output: () => fixture("output-with-word-offsets.json") });
    const outcome = segmentsOf(await off.run());
    expect((off.seen.find((r) => r.method === "POST")!.body as { config: { features: unknown } }).config.features).toEqual({ diarizationConfig: {} });
    expect(outcome.segments).toHaveLength(1); // offsets ignored: the synthetic result-level times are used
  });

  it("polls 30 s after the submit and every 15 s after that (H-4), calls operations.delete after reading, and uses the lease signal", async () => {
    const w = world({ poll: (_part, n) => (n < 6 ? "running" : "done") });
    await w.run();
    expect(w.sleeps).toEqual([30_000, 15_000, 15_000, 15_000, 15_000, 15_000]);
    expect(pollDelayMs(100)).toBe(15_000);
    expect(w.seen.filter((r) => r.method === "DELETE").map((r) => r.url.pathname)).toEqual(["/v2/projects/123456789012/locations/eu/operations/v2-00000000-0000-0000-0000-p1t1"]);
    // every call went to the eu Speech host (the order: submit, polls, delete)
    expect(new Set(w.seen.map((r) => r.url.host))).toEqual(new Set(["eu-speech.googleapis.com"]));
  });

  it("an attempt that heard nothing is noSpeech (AC-6.7)", async () => {
    for (const name of ["output-empty.json", "output-silence.json"]) {
      const w = world({ output: () => fixture(name) });
      expect(await w.run()).toEqual({ kind: "noSpeech" });
      cleaned(w.storage);
    }
  });

  it("unlabelled speech is one voice in the part", async () => {
    const w = world({ output: () => fixture("output-no-labels.json") });
    const outcome = segmentsOf(await w.run("it-IT"));
    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]!.speakerKey).toBe("s1");
  });
});

describe("recorded Google responses (T107; test-fixtures/google-speech/README.md)", () => {
  const doc = (name: string): unknown => JSON.parse(fixture(name));
  /** What the transcript says about one recorded part: its words through the stitcher, as the adapter does for a lone part. */
  const phrasesOf = (document: unknown, wordOffsets: boolean, partEndMs: number = PIECE_MAX_MS, partNo = 1, partStartMs = 0) =>
    stitch({ parts: [wordsOfPart(document, partNo, partStartMs, partStartMs + partEndMs, wordOffsets)!], gaps: [] }).phrases;
  const phrases = (name: string, wordOffsets: boolean) => phrasesOf(doc(name), wordOffsets);

  it("the submit answer's operation name is accepted and the polls address it (v2-<uuid>, project NUMBER)", async () => {
    const w = world();
    await w.run();
    const got = w.seen.find((r) => r.method === "GET")!;
    expect(got.url.pathname).toBe("/v2/projects/123456789012/locations/eu/operations/v2-00000000-0000-0000-0000-p1t1");
  });

  it("without word offsets Google returns ONE result with no resultEndOffset: speaker runs survive, every time collapses to the part start", () => {
    const got = phrases("output-recorded-it.json", false);
    expect(got.map((p) => p.speaker)).toEqual(["p1:0", "p1:1", "p1:0"]);
    expect(got.every((p) => p.startMs === 0 && p.durationMs === 0)).toBe(true); // why WORD_OFFSETS is on
  });

  it("with word offsets the times of a run are its first word's start and its last word's end", () => {
    const got = phrases("output-recorded-it-word-offsets.json", true);
    expect(got.map((p) => [p.speaker, p.startMs, p.durationMs])).toEqual([
      ["p1:0", 0, 17_080], // the first word omits startOffset: proto3 drops a zero
      ["p1:1", 18_040, 11_720],
    ]);
  });

  it("garbled word offsets inside the first utterance (a recorded defect) do not move a run's edges", () => {
    const words = (doc("output-recorded-it-word-offsets.json") as { results: { alternatives: { words: Record<string, string>[] }[] }[] }).results[0]!.alternatives[0]!.words;
    // Recorded: 'documentazione' has no endOffset, 'tecnica' no startOffset, 'lunedì.' ends at 162.84 s, the next word starts at 176.4 s and ends at 12.68 s.
    expect(words[5]).not.toHaveProperty("endOffset");
    expect(words[6]).not.toHaveProperty("startOffset");
    expect(words[11]!["endOffset"]).toBe("162.840s");
    const got = phrases("output-recorded-it-word-offsets.json", true);
    expect(got[0]!.startMs + got[0]!.durationMs).toBe(17_080);
  });

  it("RECORDED: a sentence-initial word at 9985 s inside an 18.6-minute part is ignored, not believed (the part's duration bounds every word)", () => {
    // output-recorded-garbled-offsets.json: 'legale.' 807.8->9852.8 s, 'Il' 9985.28->9985.44 s, 'progetto' 9985.44->810.88 s, ...
    const bounded = phrasesOf(doc("output-recorded-garbled-offsets.json"), true, 1_116_000);
    expect(bounded.map((p) => [p.speaker, p.startMs, p.startMs + p.durationMs])).toEqual([
      ["p1:0", 805_160, 807_800],
      ["p1:1", 811_440, 814_120],
      ["p1:0", 815_120, 817_840],
    ]);
    // Unbounded, the same words would start the second run at 9985 s and every later one after it: the poison.
    const unbounded = phrasesOf(doc("output-recorded-garbled-offsets.json"), true, 4 * 3_600_000);
    expect(unbounded.some((p) => p.startMs > 9_000_000)).toBe(true);
  });

  it("the bound also holds when nobody says how long the part is: a part is never longer than PIECE_MAX_MS", () => {
    const words = [
      { word: "a", speakerLabel: "1", startOffset: "1s", endOffset: "2s" },
      { word: "b", speakerLabel: "1", startOffset: "99999s", endOffset: "100000s" },
    ];
    const got = phrasesOf({ results: [{ alternatives: [{ transcript: "a b", words }] }] }, true);
    expect([got[0]!.startMs, got[0]!.startMs + got[0]!.durationMs]).toEqual([1000, 2000]);
  });

  it("a word whose offsets run backwards, are absurdly long or precede what was already heard is not trusted", () => {
    const result = (words: Record<string, string>[]) => ({ results: [{ alternatives: [{ transcript: "a b c d", words }] }] });
    const word = (w: string, startOffset: string | undefined, endOffset: string | undefined) => ({ word: w, speakerLabel: "1", ...(startOffset ? { startOffset } : {}), ...(endOffset ? { endOffset } : {}) });
    const got = phrasesOf(result([word("a", "1s", "2s"), word("b", "176.4s", "12.68s"), word("c", "2s", "400s"), word("d", "3s", "4s")]), true);
    expect(got).toHaveLength(1);
    expect([got[0]!.startMs, got[0]!.startMs + got[0]!.durationMs]).toEqual([1000, 4000]);
  });

  it("a run with no trustworthy word at all starts where the previous phrase ended, and never earlier", () => {
    const words = [
      { word: "a", speakerLabel: "1", startOffset: "1s", endOffset: "5s" },
      { word: "b", speakerLabel: "2" },
    ];
    const got = phrasesOf({ results: [{ alternatives: [{ transcript: "a b", words }] }] }, true);
    expect(got.map((p) => [p.startMs, p.durationMs])).toEqual([[1000, 4000], [5000, 0]]);
  });

  it("Google labels from 0 or from 1 and the English recording from 1: every label is just the part's key", () => {
    expect(phrases("output-recorded-en.json", false).map((p) => p.speaker)).toEqual(["p1:1", "p1:2", "p1:1", "p1:2"]);
  });

  it("silence and noise come back as a lone '[' (the model's [BACKGROUND] cut short): that is no speech (AC-6.7)", async () => {
    expect(phrases("output-recorded-silence.json", true)).toEqual([]);
    const w = world({ output: () => fixture("output-recorded-silence.json") });
    expect(await w.run("it-IT")).toEqual({ kind: "noSpeech" });
    cleaned(w.storage);
  });

  it("a [BACKGROUND] marker inside a transcript is dropped, the words around it are kept", () => {
    const words = [
      { word: "ciao", speakerLabel: "0", startOffset: "0.5s", endOffset: "1s" },
      { word: "[BACKGROUND]", speakerLabel: "0", startOffset: "1s", endOffset: "2s" },
      { word: "[", speakerLabel: "0", startOffset: "2s", endOffset: "2.5s" },
      { word: "grazie", speakerLabel: "0", startOffset: "3s", endOffset: "3.5s" },
    ];
    const got = phrasesOf({ results: [{ alternatives: [{ transcript: "ciao [BACKGROUND] [ grazie", words }] }] }, true);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe("ciao grazie");
    expect([got[0]!.startMs, got[0]!.durationMs]).toEqual([500, 3000]);
  });

  it("a per-file 'too long' (code 3, recorded) is audio_unreadable, which is why PIECE_MAX_MS must stay under 20 min", async () => {
    const w = world({ operation: () => fixture("operation-done-file-too-long.json") });
    expect(await rejection(w.run())).toMatchObject({ code: "audio_unreadable", transient: false });
  });

  it("a per-file 'object not found' (code 5, recorded) is provider_rejected and no output is read", async () => {
    const w = world({ operation: () => fixture("operation-done-file-not-found.json") });
    expect(await rejection(w.run())).toMatchObject({ code: "provider_rejected", transient: false });
    cleaned(w.storage);
  });

  it("an undecodable file (code 3, recorded) is audio_unreadable", async () => {
    const w = world({ operation: () => fixture("operation-done-file-error.json") });
    expect(await rejection(w.run())).toMatchObject({ code: "audio_unreadable", transient: false });
  });
});

describe("a result whose words change speaker (AC-6.2)", () => {
  it("becomes one segment per run, every run starting where the result starts (never late)", async () => {
    const w = world({ output: () => fixture("output-speaker-change.json") });
    const outcome = segmentsOf(await w.run());
    expect(outcome.segments).toEqual([
      { ordinal: 0, startMs: 0, endMs: 3000, part: 1, speakerKey: "s1", text: "Ready?" },
      { ordinal: 1, startMs: 0, endMs: 3000, part: 1, speakerKey: "s2", text: "Yes, go ahead." },
    ]);
  });
});

describe("three parts (ADR-0070)", () => {
  const outputs: Record<number, string> = {
    1: fixture("output-two-speakers.json"), // speakers 1 and 2
    2: fixture("output-two-speakers.json"), // 1 and 2 again: DIFFERENT people as far as we can know
    3: fixture("output-no-labels.json"),
  };

  it("adds each part's offset, namespaces the speaker labels per part and lists the part starts", async () => {
    const w = world({ starts: [0, 3_600_000, 7_200_000], output: (part) => outputs[part]! });
    const outcome = segmentsOf(await w.run());
    expect(outcome.partStartsMs).toEqual([0, 3_600_000, 7_200_000]);
    expect(outcome.parts).toEqual([0, 3_600_000, 7_200_000].map((startMs) => ({ startMs, endMs: startMs + PART_MS })));
    expect(outcome.segments.map((s) => s.part)).toEqual([1, 1, 2, 2, 3]);
    expect(outcome.segments.map((s) => [s.startMs, s.speakerKey])).toEqual([
      [0, "s1"],
      [4200, "s2"],
      [3_600_000, "s3"],
      [3_604_200, "s4"],
      [7_200_000, "s5"],
    ]);
    expect(outcome.segments.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4]);
    cleaned(w.storage);
  });

  it("submits one operation per part, each with its own input and an output prefix of its own (H-4)", async () => {
    const w = world({ starts: [0, 3_600_000, 7_200_000], output: (part) => outputs[part]! });
    await w.run();
    const posts = w.seen.filter((r) => r.method === "POST").map((r) => r.body as { files: { uri: string }[]; recognitionOutputConfig: { gcsOutputConfig: { uri: string } } });
    expect(posts.map((p) => p.files[0]!.uri.split("/").pop()).sort()).toEqual(["1.ogg", "2.ogg", "3.ogg"]);
    expect(posts.map((p) => p.recognitionOutputConfig.gcsOutputConfig.uri.split("/out/")[1]).sort()).toEqual(["1-1/", "2-1/", "3-1/"]);
  });

  it("a part with nothing in it still counts as a part", async () => {
    const w = world({ starts: [0, 3_600_000], output: (part) => (part === 2 ? fixture("output-empty.json") : fixture("output-two-speakers.json")) });
    const outcome = segmentsOf(await w.run());
    expect(outcome.partStartsMs).toEqual([0, 3_600_000]);
    expect(outcome.segments).toHaveLength(2);
  });

  it("one part failing fails the whole attempt: no partial transcript, the other part stops polling, the prefix is emptied", async () => {
    const w = world({
      starts: [0, 3_600_000],
      // part 1 must not reach its 45-minute deadline (180 polls) before part 2 has had its first poll, whatever the load
      realDelayMs: 3,
      poll: (part, n) => (part === 2 ? new Response("{}", { status: 403 }) : "running"),
    });
    const error = (await rejection(w.run())) as TranscriptionError;
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.code).toBe("provider_rejected");
    // part 1 was told to stop, not left polling for 45 minutes (180 polls at 15 s); how many it got in before part 2's 403 depends on
    // scheduling, and under load part 2 can reject before part 1 has polled at all, when the map has no entry (zero polls)
    expect(w.polls.get("1-1") ?? 0).toBeLessThan(30);
    cleaned(w.storage);
  });
});

describe("failures map into the closed codes (G-8) and the prefix is emptied each time", () => {
  type Row = [name: string, scenario: Scenario, code: TranscriptionFailureCode, transient: boolean];
  const op = (error: unknown) => JSON.stringify({ name: "projects/1/locations/eu/operations/op-1", done: true, error });
  const rows: Row[] = [
    ["submit: network error", { submit: () => new Error("ECONNRESET") }, "provider_unavailable", true],
    ...[408, 429, 500, 502, 503, 504].map((status): Row => [`submit: HTTP ${status}`, { submit: () => json({}, status) }, "provider_unavailable", true]),
    ...[400, 403, 404].map((status): Row => [`submit: HTTP ${status}`, { submit: () => json({}, status) }, "provider_rejected", false]),
    ["submit: a name outside the expected form", { submit: () => json({ name: "projects/1/locations/us/operations/x" }) }, "provider_unavailable", true],
    ["submit: a body that is not JSON", { submit: () => new Response("<html>") }, "provider_unavailable", true],
    ["poll: HTTP 403", { poll: () => new Response("{}", { status: 403 }) }, "provider_rejected", false],
    ["poll: 404", { poll: () => new Response("{}", { status: 404 }) }, "provider_rejected", false],
    ["poll: three 503 in a row", { poll: () => new Response("{}", { status: 503 }) }, "provider_unavailable", true],
    ["poll: a body that is not an object", { poll: () => new Response("null") }, "provider_unavailable", true],
    ...[4, 8, 10, 13, 14].map((code): Row => [`operation error ${code}`, { operation: () => op({ code, message: "x" }) }, "provider_unavailable", true]),
    ...[5, 7, 9, 16, 3].map((code): Row => [`operation error ${code}`, { operation: () => op({ code, message: "x" }) }, "provider_rejected", false]),
    ["file error 3 (cannot decode)", { operation: () => fixture("operation-done-file-error.json") }, "audio_unreadable", false],
    ["file error 14", { operation: () => fixture("operation-done-file-error.json").replace('"code": 3', '"code": 14') }, "provider_unavailable", true],
    ["file error 7", { operation: () => fixture("operation-done-file-error.json").replace('"code": 3', '"code": 7') }, "provider_rejected", false],
    ["the fixture's own operation error", { operation: () => fixture("operation-done-error.json") }, "provider_unavailable", true],
    ["a finished operation with no results", { operation: () => JSON.stringify({ done: true, response: {} }) }, "provider_unavailable", true],
    ["output URI outside the try's out/", { outputUri: () => "gs://fake-transient-bucket/transcribe/other_meeting/1/out/1-1/x.json" }, "provider_rejected", false],
    ["output URI under another try's prefix", { outputUri: () => `gs://fake-transient-bucket/${OUT(1, 2)}x.json` }, "provider_rejected", false],
    ["output URI under another part's prefix", { outputUri: () => `gs://fake-transient-bucket/${OUT(2, 1)}x.json` }, "provider_rejected", false],
    ["output URI in another bucket", { outputUri: () => "gs://someone-elses-bucket/transcribe/meeting_1/2/out/1-1/x.json" }, "provider_rejected", false],
    ["output URI in this attempt's in/ prefix", { outputUri: () => `gs://fake-transient-bucket/transcribe/${MEETING}/${ATTEMPT}/in/1.ogg` }, "provider_rejected", false],
    ["output over 8 MiB", { output: () => new Uint8Array(MAX_OUTPUT_BYTES + 1) }, "provider_rejected", false],
    ["output that is not JSON", { output: () => "not json" }, "provider_unavailable", true],
    ["output of the wrong shape", { output: () => JSON.stringify({ results: "nope" }) }, "provider_unavailable", true],
    ["output result of the wrong shape", { output: () => JSON.stringify({ results: [7] }) }, "provider_unavailable", true],
    ["the audio cannot be split", { split: async () => Promise.reject(new SplitError()) }, "audio_unreadable", false],
  ];

  for (const [name, scenario, code, transient] of rows) {
    it(`${name} -> ${code}${transient ? " (transient)" : ""}`, async () => {
      const w = world(scenario);
      const error = (await rejection(w.run())) as TranscriptionError;
      expect(error).toBeInstanceOf(TranscriptionError);
      expect(error.code).toBe(code);
      expect(error.transient).toBe(transient);
      cleaned(w.storage);
    });
  }

  it("a single blip while polling is tolerated", async () => {
    const w = world({ poll: (_p, n) => (n === 1 ? new Response("{}", { status: 503 }) : n === 2 ? "running" : "done") });
    segmentsOf(await w.run());
  });

  it("the poll deadline (45 min per part) is transient, and the prefix is emptied", async () => {
    const w = world({ poll: () => "running" });
    const error = (await rejection(w.run())) as TranscriptionError;
    expect(error).toMatchObject({ code: "provider_unavailable", transient: true });
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(POLL_DEADLINE_MS);
    cleaned(w.storage);
  });

  it("an upload that fails is mapped, and nothing is submitted", async () => {
    const w = world();
    const original = w.storage.put.bind(w.storage);
    w.storage.put = async () => {
      throw new GoogleApiError(true, 503);
    };
    const error = (await rejection(w.run())) as TranscriptionError;
    expect(error).toMatchObject({ code: "provider_unavailable", transient: true });
    expect(w.seen.some((r) => r.method === "POST")).toBe(false);
    w.storage.put = original;
  });

  it("an upload that is refused (403) is provider_rejected", async () => {
    const w = world();
    w.storage.put = async () => {
      throw new GoogleApiError(false, 403);
    };
    expect(await rejection(w.run())).toMatchObject({ code: "provider_rejected", transient: false });
  });

  it("cleans up only its own attempt's prefix: a newer attempt's staged parts survive, on success and on failure (ADR-0062 stale attempt)", async () => {
    const newer = `transcribe/${MEETING}/${ATTEMPT + 1}/in/1.ogg`;
    const w = world();
    w.storage.seed(newer, "newer attempt's audio");
    segmentsOf(await w.run());
    expect(w.storage.keys()).toEqual([newer]);
    // the try's own prefix at once, and this attempt's prefix at the end: never another attempt's
    expect(w.storage.events.filter((e) => e.op === "deletePrefix").map((e) => e.key)).toEqual([OUT(), `transcribe/${MEETING}/${ATTEMPT}/`]);

    const failing = world();
    failing.storage.seed(newer, "newer attempt's audio");
    failing.storage.put = async () => {
      throw new GoogleApiError(false, 403);
    };
    await rejection(failing.run());
    expect(failing.storage.keys()).toEqual([newer]);
  });

  it("at its start clears the leftovers of OLDER attempts only, never a newer attempt's", async () => {
    const w = world();
    const older = `transcribe/${MEETING}/${ATTEMPT - 1}/out/1-1/late.json`;
    const newer = `transcribe/${MEETING}/${ATTEMPT + 1}/in/1.ogg`;
    const another = `transcribe/other_meeting/1/in/1.ogg`;
    for (const object of [older, newer, another]) w.storage.seed(object, "x");
    segmentsOf(await w.run());
    expect(w.storage.events[0]).toEqual({ op: "deleteBefore", key: `transcribe/${MEETING}/<${ATTEMPT}` });
    expect(w.storage.keys()).toEqual([another, newer].sort());
  });

  it("a failure to empty the prefix before the attempt stops it before any upload", async () => {
    const w = world();
    w.storage.failWith(new GoogleApiError(true, 503));
    const error = (await rejection(w.run())) as TranscriptionError;
    expect(error).toMatchObject({ code: "provider_unavailable", transient: true });
    expect(w.storage.events.some((e) => e.op === "put")).toBe(false);
  });

  it("a failure to empty the prefix at the end does not mask the transcript, and says so without naming anything", async () => {
    const w = world();
    const original = w.storage.deletePrefix.bind(w.storage);
    w.storage.deletePrefix = async (prefix) => {
      // The start is deleteAttemptsBefore; the only deletePrefix is the one at the end.
      if (prefix === `transcribe/${MEETING}/${ATTEMPT}/`) throw new GoogleApiError(true, 503);
      return original(prefix);
    };
    segmentsOf(await w.run());
    expect(logged.join("\n")).toContain("transient cleanup failed");
    expect(logged.join("\n")).not.toContain(MEETING);
  });

  it("operations.delete failing does not fail the attempt", async () => {
    const w = world({ deleteOperation: () => new Error("down") });
    segmentsOf(await w.run());
  });
});

describe("a lost lease", () => {
  it("aborts the poll with the signal's own reason, empties the prefix and writes nothing else", async () => {
    const controller = new AbortController();
    const w = world({
      poll: (_p, n) => {
        if (n === 2) controller.abort(new Error("lease lost"));
        return "running";
      },
    });
    const error = await rejection(w.run("en-US", controller.signal));
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(TranscriptionError);
    expect(controller.signal.aborted).toBe(true);
    cleaned(w.storage);
  });

  it("an already-aborted lease never reaches Google", async () => {
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));
    const w = world();
    await rejection(w.run("en-US", controller.signal));
    expect(w.seen).toHaveLength(0);
  });
});

describe("programming errors send nothing", () => {
  it("no context, or a locale outside it-IT/en-US, is provider_rejected before any call", async () => {
    const w = world();
    const noContext = createGoogleTranscriber({ auth, projectId: "operai-meetings-test", location: "eu", storage: async () => w.storage });
    expect(await rejection(noContext.transcribe(new Blob(["a"]), "en-US", 2))).toMatchObject({ code: "provider_rejected" });
    expect(await rejection(w.run("auto" as never))).toMatchObject({ code: "provider_rejected" });
    expect(w.seen).toHaveLength(0);
    expect(w.storage.events).toEqual([]);
  });

  it("refuses ids that could steer an object name", async () => {
    const w = world();
    await expect(w.run("en-US", undefined, { meetingId: "../other", attempt: 1 })).rejects.toThrow();
    expect(w.seen).toHaveLength(0);
  });
});

describe("log privacy (AC-4.10)", () => {
  it("a failure's message and the logs carry no URL, project, meeting id or provider text", async () => {
    const w = world({ poll: () => new Response(JSON.stringify({ error: { message: "Secret Title of the Meeting" } }), { status: 403 }) });
    const error = (await rejection(w.run())) as Error;
    for (const text of [error.message, logged.join("\n")]) {
      expect(text).not.toContain("Secret Title");
      expect(text).not.toContain("googleapis");
      expect(text).not.toContain(MEETING);
      expect(text).not.toContain("operai-meetings-test");
    }
  });
});

describe("pure helpers", () => {
  it("parses duration strings", () => {
    expect(parseOffsetMs("12.340s")).toBe(12340);
    expect(parseOffsetMs("0s")).toBe(0);
    for (const bad of ["12", "12.3", "-1s", "s", 5, null, undefined]) expect(parseOffsetMs(bad)).toBeNull();
  });

  it("maps rpc codes (G-8)", () => {
    expect(codeForRpc(14, false)).toEqual({ code: "provider_unavailable", transient: true });
    expect(codeForRpc(3, true)).toEqual({ code: "audio_unreadable", transient: false });
    expect(codeForRpc(3, false)).toEqual({ code: "provider_rejected", transient: false });
    expect(codeForRpc("x", true)).toEqual({ code: "provider_rejected", transient: false });
  });

  it("result times (older shapes) never run backwards: a result without a later end has no time of its own", () => {
    const part = wordsOfPart(
      { results: [{ alternatives: [{ transcript: "a" }], resultEndOffset: "5s" }, { alternatives: [{ transcript: "b" }], resultEndOffset: "3s" }, { alternatives: [{ transcript: "c" }] }] },
      1,
      1000,
      601_000,
      false,
    )!;
    expect(part.words.map((w) => w.span)).toEqual([{ startMs: 1000, endMs: 6000 }, null, null]);
  });

  it("refuses documents of the wrong shape", () => {
    for (const doc of [null, [], "x", { results: {} }, { results: [null] }, { results: [{ alternatives: "x" }] }, { results: [{ alternatives: [{ transcript: 5 }] }] }, { results: [{ alternatives: [{ words: "x" }] }] }]) {
      expect(wordsOfPart(doc, 1, 0, 600_000, false), JSON.stringify(doc)).toBeNull();
    }
  });

  it("an output with more than MAX_WORDS_PER_PART words is refused, permanently (H-11)", () => {
    const words = Array.from({ length: MAX_WORDS_PER_PART + 1 }, (_, i) => ({ word: `w${i}`, speakerLabel: "1" }));
    expect(() => wordsOfPart({ results: [{ alternatives: [{ transcript: "x", words }] }] }, 1, 0, 600_000, false)).toThrow(TranscriptionError);
    const ok = words.slice(0, MAX_WORDS_PER_PART);
    expect(wordsOfPart({ results: [{ alternatives: [{ transcript: "x", words: ok }] }] }, 1, 0, 600_000, false)!.words).toHaveLength(MAX_WORDS_PER_PART);
  });

  it("namespaces a label that is not safe as a key into the part's unlabelled voice", () => {
    const part = wordsOfPart({ results: [{ alternatives: [{ transcript: "x", words: [{ word: "x", speakerLabel: "../evil label" }] }], resultEndOffset: "1s" }] }, 3, 0, 600_000, false)!;
    expect(part.words[0]!.label).toBe("p3:0");
  });

  it("marks a word with no usable speaker label as unlabelled (AC-6.13), and a real label `0` as a label", () => {
    const words = [{ word: "a", speakerLabel: "0" }, { word: "b" }, { word: "c", speakerLabel: "../evil" }, { word: "d", speakerLabel: "2" }];
    const part = wordsOfPart({ results: [{ alternatives: [{ transcript: "a b c d", words }] }] }, 1, 0, 600_000, false)!;
    expect(part.words.map((w) => w.unlabelled === true)).toEqual([false, true, true, false]);
    const bare = wordsOfPart({ results: [{ alternatives: [{ transcript: "uno due" }] }] }, 1, 0, 600_000, false)!;
    expect(bare.words.every((w) => w.unlabelled === true)).toBe(true);
  });
});

// ─── Per-part tries, the detector and the stitcher through the adapter (H-4, AC-6.7, AC-6.11, AC-6.12, AC-4.12) ───

type W = { word: string; startOffset: string; endOffset: string; speakerLabel: string };
const W = (word: string, from: number, to: number, speakerLabel = "1"): W => ({ word, startOffset: `${from}s`, endOffset: `${to}s`, speakerLabel });
/** One word every 2 s from `from` to `to` (part-relative seconds), `<tag><n>`. */
const speech = (tag: string, from: number, to: number, label = "1"): W[] => {
  const out: W[] = [];
  for (let t = from, i = 0; t < to; t += 2, i += 1) out.push(W(`${tag}${i}`, t, t + 1.5, label));
  return out;
};
const docOf = (...groups: W[][]): string => {
  const words = groups.flat();
  return JSON.stringify({ results: [{ alternatives: [{ transcript: words.map((w) => w.word).join(" "), words }] }] });
};
const A_PART = [{ startMs: 0, endMs: 100_000 }];
/** Complete: no stretch of 20 s without a word. */
const completeDoc = (tag: string) => docOf(speech(tag, 0, 100));
/** Words only at 0-10 s and from `resume` s on: a hole of `resume - 9.5` s that is all sound when `silences: []`. */
const holedDoc = (tag: string, resume = 70) => docOf(speech(tag, 0, 10), speech(`${tag}b`, resume, 100));
const textOfOutcome = (outcome: TranscriptionOutcome) => segmentsOf(outcome).segments.map((s) => s.text).join(" ");

describe("tries of a part (AC-6.11, H-4; the bound is 1 since A8, the retry tests raise it with `maxTries`)", () => {
  it("a complete part is submitted once, its input put once and every copy deleted as soon as it has been used (AC-4.12)", async () => {
    const w = world({ spans: A_PART, silences: [], output: () => completeDoc("a") });
    const outcome = await w.run();
    expect(w.submits).toEqual([{ part: 1, tryNo: 1 }]);
    expect(w.storage.events.filter((e) => e.op === "put")).toHaveLength(1);
    expect(segmentsOf(outcome).gaps).toEqual([]);
    const ops = w.storage.events.map((e) => `${e.op}:${e.key}`);
    const read = ops.findIndex((o) => o.startsWith("read:"));
    // the try's prefix goes right after its output was read, the input when the part has settled, the attempt prefix last
    expect(ops[read + 1]).toBe(`deletePrefix:${OUT()}`);
    expect(ops.indexOf(`delete:transcribe/${MEETING}/${ATTEMPT}/in/1.ogg`)).toBeGreaterThan(read + 1);
    expect(ops[ops.length - 1]).toBe(`deletePrefix:${PREFIX}${ATTEMPT}/`);
    cleaned(w.storage);
  });

  it("a part with a gap is transcribed again, in a prefix of its own, and the complete try is kept", async () => {
    const w = world({ spans: A_PART, silences: [], maxTries: 3, output: (_part, tryNo) => (tryNo === 1 ? holedDoc("a") : completeDoc("b")) });
    const outcome = await w.run();
    expect(w.submits).toEqual([
      { part: 1, tryNo: 1 },
      { part: 1, tryNo: 2 },
    ]);
    const bodies = w.seen.filter((r) => r.method === "POST").map((r) => (r.body as { recognitionOutputConfig: { gcsOutputConfig: { uri: string } } }).recognitionOutputConfig.gcsOutputConfig.uri);
    expect(bodies).toEqual([`gs://fake-transient-bucket/${OUT(1, 1)}`, `gs://fake-transient-bucket/${OUT(1, 2)}`]);
    expect(w.storage.events.filter((e) => e.op === "put")).toHaveLength(1); // the input is reused by the tries that follow each other
    const text = textOfOutcome(outcome);
    expect(text).toContain("b0");
    expect(text).not.toContain("a0");
    expect(segmentsOf(outcome).gaps).toEqual([]);
    cleaned(w.storage);
  });

  it("by default a part is transcribed ONCE (A8): a gap is marked, nothing is uploaded or polled a second time", async () => {
    expect(MAX_TRIES).toBe(1);
    const w = world({ spans: A_PART, silences: [], output: (_part, tryNo) => (tryNo === 1 ? holedDoc("a") : completeDoc("b")) });
    const outcome = segmentsOf(await w.run());
    expect(w.submits).toEqual([{ part: 1, tryNo: 1 }]);
    expect(w.seen.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(w.storage.events.filter((e) => e.op === "put")).toHaveLength(1);
    expect([...w.polls.keys()]).toEqual(["1-1"]);
    expect(textOfOutcome(outcome).split(" ")).toContain("a0");
    expect(textOfOutcome(outcome).split(" ")).not.toContain("b0");
    expect(outcome.gaps).toEqual([{ startMs: 9_500, endMs: 70_000 }]); // final gap and caveats unchanged
    cleaned(w.storage);
    expect(logged.find((l) => l.startsWith("[transcribe] parts="))).toContain("tries=1");
  });

  it("a part still incomplete after three tries keeps the best: fewest gaps, then least gap time (the gap is reported, in meeting time)", async () => {
    const tries: Record<number, string> = {
      1: docOf(speech("a", 0, 10), speech("ab", 40, 50), speech("ac", 80, 100)), // two gaps
      2: holedDoc("mid", 70), // one gap of 60.5 s
      3: holedDoc("best", 50), // one gap of 40.5 s: the best
    };
    const w = world({ spans: A_PART, silences: [], maxTries: 3, output: (_part, tryNo) => tries[tryNo]! });
    const outcome = segmentsOf(await w.run());
    expect(w.submits.map((s) => s.tryNo)).toEqual([1, 2, 3]);
        expect(textOfOutcome(outcome)).toContain("best0");
    expect(textOfOutcome(outcome)).not.toContain("mid0");
    expect(textOfOutcome(outcome)).not.toContain("a0");
    expect(outcome.gaps).toEqual([{ startMs: 9_500, endMs: 50_000 }]);
    cleaned(w.storage);
  });

  it("on a complete tie the earlier try stays", async () => {
    const w = world({ spans: A_PART, silences: [], maxTries: 3, output: (_part, tryNo) => holedDoc(`t${tryNo}`) });
    const outcome = await w.run();
    expect(w.submits).toHaveLength(3);
    expect(textOfOutcome(outcome)).toContain("t10");
    expect(textOfOutcome(outcome)).not.toContain("t20");
  });

  it("a part that came back complete is never submitted again, whatever the other parts do", async () => {
    const w = world({
      spans: [{ startMs: 0, endMs: 100_000 }, { startMs: 3_600_000, endMs: 3_700_000 }],
      silences: [],
      maxTries: 3,
      output: (part, tryNo) => (part === 1 ? completeDoc("a") : holedDoc(`p${tryNo}`)),
    });
    const outcome = segmentsOf(await w.run());
    expect(w.submits.filter((s) => s.part === 1)).toHaveLength(1);
    expect(w.submits.filter((s) => s.part === 2).map((s) => s.tryNo)).toEqual([1, 2, 3]);
    // the gap of part 2, in the meeting's time (the part's offset included)
    expect(outcome.gaps).toEqual([{ startMs: 3_609_500, endMs: 3_670_000 }]);
    cleaned(w.storage);
    // each part's input went when ITS part settled: part 1's input was deleted before part 2's last try was read
    const ops = w.storage.events.map((e) => `${e.op}:${e.key}`);
    const lastRead2 = ops.map((o, i) => (o.startsWith(`read:${OUT(2, 3)}`) ? i : -1)).filter((i) => i >= 0)[0]!;
    expect(ops.indexOf(`delete:transcribe/${MEETING}/${ATTEMPT}/in/1.ogg`)).toBeLessThan(lastRead2);
    expect(ops.indexOf(`delete:transcribe/${MEETING}/${ATTEMPT}/in/2.ogg`)).toBeGreaterThan(lastRead2);
  });

  it("an error on try 2 settles the part with try 1, which is then marked (AC-6.9): not a failure", async () => {
    const w = world({
      spans: A_PART,
      silences: [],
      maxTries: 3,
      output: () => holedDoc("a"),
      submit: (_part, tryNo) => (tryNo === 2 ? json({}, 503) : undefined) as Response,
    });
    const outcome = segmentsOf(await w.run());
    expect(w.submits.map((s) => s.tryNo)).toEqual([1, 2]);
    expect(textOfOutcome(outcome)).toContain("a0");
    expect(outcome.gaps).toEqual([{ startMs: 9_500, endMs: 70_000 }]);
    expect(logged.join("\n")).toContain("retry ended: provider_unavailable");
    cleaned(w.storage);
  });

  it("an error on try 1 still fails the whole attempt, as before (AC-6.9)", async () => {
    const w = world({ spans: A_PART, silences: [], submit: () => json({}, 503) });
    expect(await rejection(w.run())).toMatchObject({ code: "provider_unavailable", transient: true });
    expect(w.submits).toHaveLength(1);
    cleaned(w.storage);
  });

  it("a lost lease during a retry aborts with the lease's own reason, not a settled part", async () => {
    const controller = new AbortController();
    const w = world({ spans: A_PART, silences: [], maxTries: 3, output: () => holedDoc("a"), poll: (_p, n, tryNo) => {
      if (tryNo === 2 && n === 1) controller.abort(new Error("lease lost"));
      return n === 1 ? "running" : "done";
    } });
    const error = await rejection(w.run("en-US", controller.signal));
    expect(error).not.toBeInstanceOf(TranscriptionError);
    cleaned(w.storage);
  });

  it("a repetition is NOT detectable incompleteness (A8): one try, the stitcher removes the repeat, even with retries enabled", async () => {
    const phrase = (tag: string, from: number) => "il budget del prossimo trimestre va rivisto subito".split(" ").map((t, i) => W(`${tag}${t}`, from + i * 0.3, from + i * 0.3 + 0.25));
    const repeated = docOf(speech("pad", 0, 20), phrase("x", 20), phrase("x", 23.9), speech("tail", 30, 60));
    const clean = docOf(speech("pad", 0, 20), phrase("x", 20), speech("tail", 30, 60));
    for (const maxTries of [undefined, 3]) {
      const w = world({ spans: [{ startMs: 0, endMs: 60_000 }], silences: [], ...(maxTries ? { maxTries } : {}), output: (_p, tryNo) => (tryNo === 1 ? repeated : clean) });
      const outcome = await w.run();
      expect(w.submits.map((s) => s.tryNo)).toEqual([1]);
      expect(segmentsOf(outcome).gaps).toEqual([]);
      expect(textOfOutcome(outcome).split(" ").filter((t) => t === "xbudget")).toHaveLength(1); // the repeat is gone
    }
  });

  it("writes no ai_request row: transcription retries are not AI requests (AC-13.4)", () => {
    const source = readFileSync(join(import.meta.dir, "googleSpeech.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).not.toMatch(/lib\/db|aiRequest|ai_request|PrismaClient/);
  });
});

describe("an empty transcript (AC-6.7)", () => {
  it("empty with no sound of the gap bound is noSpeech, after one try", async () => {
    const w = world({ spans: A_PART, output: () => "{}" }); // all silence
    expect(await w.run()).toEqual({ kind: "noSpeech" });
    expect(w.submits).toHaveLength(1);
  });

  it("markers only is noSpeech too, even where there is sound: the provider declared it non-speech", async () => {
    const w = world({ spans: A_PART, silences: [], output: () => fixture("output-recorded-silence.json") });
    expect(await w.run("it-IT")).toEqual({ kind: "noSpeech" });
    expect(w.submits).toHaveLength(1);
  });

  it("empty although the recording has sound and no marker: speech_not_transcribed, permanent, never 'no speech', after ONE try (A8)", async () => {
    const w = world({ spans: A_PART, silences: [], output: () => "{}" });
    const error = (await rejection(w.run())) as TranscriptionError;
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.code).toBe("speech_not_transcribed");
    expect(error.transient).toBe(false);
    expect(w.submits.map((s) => s.tryNo)).toEqual([1]);
    cleaned(w.storage);
  });

  it("with retries enabled the same empty part is tried three times first (the machinery is kept, behind the bound)", async () => {
    const w = world({ spans: A_PART, silences: [], maxTries: 3, output: () => "{}" });
    expect(((await rejection(w.run())) as TranscriptionError).code).toBe("speech_not_transcribed");
    expect(w.submits.map((s) => s.tryNo)).toEqual([1, 2, 3]);
  });

  it("a second try that finds the speech turns the same part into a transcript (retries enabled)", async () => {
    const w = world({ spans: A_PART, silences: [], maxTries: 3, output: (_p, tryNo) => (tryNo === 1 ? "{}" : completeDoc("b")) });
    const outcome = segmentsOf(await w.run());
    expect(outcome.gaps).toEqual([]);
    expect(textOfOutcome(outcome)).toContain("b0");
  });
});

describe("operations in flight (H-4)", () => {
  it("at most 24 across two concurrent transcribers, and all of them finish", async () => {
    expect(SPEECH_MAX_INFLIGHT).toBe(24);
    const inflight = { now: 0, peak: 0 };
    const spans = Array.from({ length: 22 }, (_, i) => ({ startMs: i * 3_600_000, endMs: i * 3_600_000 + PART_MS }));
    const a = world({ spans, inflight });
    const b = world({ spans, inflight });
    const [one, two] = await Promise.all([a.run(), b.run()]);
    expect(segmentsOf(one).parts).toHaveLength(22);
    expect(segmentsOf(two).parts).toHaveLength(22);
    expect(inflight.peak).toBe(24); // the semaphore binds, and holds
    expect(inflight.now).toBe(0);
  });

  it("a lease lost while waiting for a place never takes one", async () => {
    const inflight = { now: 0, peak: 0 };
    const spans = Array.from({ length: 30 }, (_, i) => ({ startMs: i * 3_600_000, endMs: i * 3_600_000 + PART_MS }));
    const controller = new AbortController();
    const w = world({ spans, inflight, poll: (_p, n) => {
      if (n === 1) queueMicrotask(() => controller.abort(new Error("lease lost")));
      return "running";
    } });
    expect(await rejection(w.run("en-US", controller.signal))).toBeDefined();
    expect(inflight.peak).toBeLessThanOrEqual(24);
    cleaned(w.storage);
  });
});

describe("overlapping parts through the adapter (AC-6.12, AC-6.13, AC-6.14)", () => {
  const OVERLAP = [{ startMs: 0, endMs: 600_000 }, { startMs: 510_000, endMs: 1_110_000 }];
  /** The recording's words: one every 2 s, `w<second>`; labels decided by `labelOf(second)` for each version. */
  const version = (fromS: number, toS: number, labelOf: (t: number) => string, skip: (t: number) => boolean = () => false): string => {
    const words: W[] = [];
    for (let t = fromS; t < toS; t += 2) if (!skip(t)) words.push(W(`w${t}`, t - fromS, t - fromS + 1.5, labelOf(t)));
    return docOf(words);
  };

  it("speech returned by both parts appears once, and the label the overlap shows to be the same person is one speaker", async () => {
    // part 1: speaker 1 until 555 s, then speaker 2; part 2 numbers them the other way round
    const w = world({
      spans: OVERLAP,
      silences: [],
      output: (part) => (part === 1 ? version(0, 600, (t) => (t < 555 ? "1" : "2")) : version(510, 1110, (t) => (t < 555 ? "2" : "1"))),
    });
    const outcome = segmentsOf(await w.run());
    const words = outcome.segments.flatMap((s) => s.text.split(" "));
    expect(words).toHaveLength(555); // every second of the recording once
    expect(new Set(words).size).toBe(555);
    expect(outcome.gaps).toEqual([]);
    expect(outcome.parts).toEqual(OVERLAP);
    expect(outcome.partStartsMs).toEqual([0, 510_000]);
    // joined: part 2's "1" (after 555 s) is part 1's "2"; nothing took a third number
    expect(new Set(outcome.segments.map((s) => s.speakerKey))).toEqual(new Set(["s1", "s2"]));
    const after = outcome.segments.filter((s) => s.startMs >= 600_000);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((s) => s.speakerKey === "s2" && s.part === 2)).toBe(true);
    expect(w.submits).toHaveLength(2);
  });

  it("a gap of part 1 that part 2 transcribed is not reported, though part 1 was retried for it", async () => {
    const w = world({
      spans: OVERLAP,
      silences: [],
      maxTries: 3,
      output: (part) => (part === 1 ? version(0, 600, () => "1", (t) => t >= 520 && t < 590) : version(510, 1110, () => "1")),
    });
    const outcome = segmentsOf(await w.run());
    expect(w.submits.filter((s) => s.part === 1)).toHaveLength(3);
    expect(w.submits.filter((s) => s.part === 2)).toHaveLength(1);
    expect(outcome.gaps).toEqual([]);
    expect(textOfOutcome(outcome)).toContain("w560");
  });

  it("a gap that no other version covers is reported once, merged across the boundary", async () => {
    // nothing from 540 s to 640 s in either version
    const w = world({
      spans: OVERLAP,
      silences: [],
      output: (part) => (part === 1 ? version(0, 600, () => "1", (t) => t >= 540) : version(510, 1110, () => "1", (t) => t < 640)),
    });
    const outcome = segmentsOf(await w.run());
    expect(outcome.gaps).toEqual([{ startMs: 539_500, endMs: 640_000 }]);
  });
});

describe("what the adapter logs (AC-4.10)", () => {
  it("one line of counts per attempt, no range, no text, no id", async () => {
    const w = world({ spans: A_PART, silences: [], maxTries: 3, output: (_p, tryNo) => (tryNo === 1 ? holedDoc("a") : completeDoc("b")) });
    await w.run();
    const line = logged.find((l) => l.startsWith("[transcribe] parts="))!;
    expect(line).toBe("[transcribe] parts=1 tries=2 gaps=0 excused=0 removed=0 joined=0 separate=0");
    for (const text of [logged.join("\n")]) {
      expect(text).not.toContain(MEETING);
      expect(text).not.toMatch(/\b9500\b|70000/);
    }
  });
});

describe("the recorded overlap fixtures (T124: real Chirp 3 output of a 60-minute synthetic file, boundary 1|2)", () => {
  const meta = JSON.parse(fixture("overlap-recorded-meta.json"))["overlap-it"] as { parts: { startMs: number; endMs: number }[]; silences: { startMs: number; endMs: number }[] };

  it("two consecutive overlapping parts: the overlap appears once, both speakers are joined across the parts, no gap", async () => {
    const w = world({ spans: meta.parts, silences: meta.silences, output: (part) => fixture(`overlap-it-part-${part}.json`) });
    const outcome = segmentsOf(await w.run("it-IT"));
    expect(outcome.gaps).toEqual([]);
    expect(w.submits).toHaveLength(2);
    // 335 + 339 words returned, 272 of them said in both parts and kept once
    expect(outcome.segments.flatMap((s) => s.text.split(" "))).toHaveLength(335 + 339 - 272);
    const keysOf = (part: number) => new Set(outcome.segments.filter((s) => s.part === part).map((s) => s.speakerKey));
    expect(keysOf(1).size).toBe(2);
    expect(keysOf(2)).toEqual(keysOf(1));
    expect(outcome.parts).toEqual(meta.parts);
  });
});
