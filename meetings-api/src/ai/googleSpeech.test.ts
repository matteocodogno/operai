import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleApiError, type GoogleAuth } from "../lib/google/auth";
import { createFakeTransientStorage, type FakeTransientStorage } from "../lib/google/fakeTransientStorage";
import { PIECE_MAX_MS, SplitError, type SplitPart, type SplitResult } from "../media/split";
import {
  WORD_OFFSETS,
  POLL_DEADLINE_MS,
  MAX_OUTPUT_BYTES,
  codeForRpc,
  createGoogleTranscriber,
  parseOffsetMs,
  phrasesOfPart,
  pollDelayMs,
} from "./googleSpeech";
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
const OUT = `transcribe/${MEETING}/${ATTEMPT}/out/`;
const auth: GoogleAuth = { accessToken: async () => "tok", client: null as never };

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
}

interface Scenario {
  /** Part start offsets; one entry per part. */
  starts?: number[];
  submit?: (part: number) => Response | Error;
  /** `pollNo` is 1-based per part. Return "running", "done", a Response or an Error. */
  poll?: (part: number, pollNo: number) => "running" | "done" | Response | Error;
  /** The operation document fixture for a finished part. */
  operation?: (part: number) => string;
  output?: (part: number) => string | Uint8Array;
  /** Rewrites the output file URI named in the finished operation. */
  outputUri?: (part: number, uri: string) => string;
  split?: () => Promise<SplitResult>;
  wordOffsets?: boolean;
  deleteOperation?: () => Response | Error;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function world(scenario: Scenario = {}) {
  const storage: FakeTransientStorage = createFakeTransientStorage();
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const polls = new Map<number, number>();
  let clock = 1_000_000;
  const starts = scenario.starts ?? [0];
  const dir = mkdtempSync(join(scratch, "case-"));
  const parts: SplitPart[] = starts.map((startMs, i) => {
    const path = join(dir, `part-${i}.ogg`);
    writeFileSync(path, "OggS-fake");
    return { path, startMs, endMs: startMs + PIECE_MAX_MS };
  });
  // The recorded form is `projects/<number>/locations/eu/operations/v2-<uuid>` (batch-submit.json); the test's own
  // ids end in the part number so a poll can be routed back to its part.
  const opNameOf = (part: number) => `projects/123456789012/locations/eu/operations/v2-00000000-0000-0000-0000-00000000000${part}`;
  const partOf = (opName: string): number => Number(/(\d)$/.exec(opName)![1]);
  const inputUriOf = (part: number) => storage.uri(`transcribe/${MEETING}/${ATTEMPT}/in/${part}.ogg`);

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url, body });
    if (method === "POST" && url.pathname.endsWith(":batchRecognize")) {
      const part = Number(/\/in\/(\d+)\.ogg$/.exec(body.files[0].uri)![1]);
      const custom = scenario.submit?.(part);
      if (custom instanceof Error) throw custom;
      return custom ?? json({ ...JSON.parse(fixture("batch-submit.json")), name: opNameOf(part) });
    }
    const op = /\/(projects\/[^/]+\/locations\/eu\/operations\/(v2-[A-Za-z0-9-]+))$/.exec(url.pathname);
    if (op && method === "GET") {
      const part = partOf(op[2]!);
      const pollNo = (polls.get(part) ?? 0) + 1;
      polls.set(part, pollNo);
      const verdict = scenario.poll?.(part, pollNo) ?? (pollNo === 1 ? "running" : "done");
      if (verdict instanceof Error) throw verdict;
      if (verdict instanceof Response) return verdict;
      if (verdict === "running") return new Response(fixture("operation-running.json"), { status: 200 });
      const outKey = `${OUT}${part}_transcript_ab12.json`;
      const raw = scenario.operation?.(part) ?? fixture("operation-done.json");
      const outUri = scenario.outputUri?.(part, storage.uri(outKey)) ?? storage.uri(outKey);
      if (!raw.includes("\"error\"")) storage.seed(outKey, scenario.output?.(part) ?? fixture("output-recorded-it-word-offsets.json"));
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
      await new Promise((r) => setTimeout(r, 0)); // a real macrotask: other parts get to run
      signal.throwIfAborted();
    },
    split: scenario.split ?? (async () => ({ parts, silences: [], durationMs: parts[parts.length - 1]!.endMs })),
    ...(scenario.wordOffsets !== undefined ? { wordOffsets: scenario.wordOffsets } : {}),
  });
  const run = (locale: "it-IT" | "en-US" = "en-US", signal?: AbortSignal, context = { meetingId: MEETING, attempt: ATTEMPT }) =>
    transcriber.transcribe(new Blob(["audio"]), locale, 3, signal, context);
  return { storage, seen, sleeps, run, polls, advance: (ms: number) => void (clock += ms) };
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
    // output-recorded-it-word-offsets.json: ONE result, two speaker runs, times from the run's first and last word.
    expect(outcome.segments).toEqual([
      {
        ordinal: 0,
        startMs: 0,
        endMs: 17_080,
        speakerKey: "s1",
        text: "Il cliente ha segnalato la documentazione tecnica prima della riunione di lunedì. Il progetto ha completato l'analisi dei rischi con il supporto del reparto legale.",
      },
      {
        ordinal: 1,
        startMs: 18_040,
        endMs: 29_760,
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
      expect(body.recognitionOutputConfig).toEqual({ gcsOutputConfig: { uri: `gs://fake-transient-bucket/${OUT}` } });
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

  it("polls 10 s first and backs off to 30 s, calls operations.delete after reading, and uses the lease signal", async () => {
    const w = world({ poll: (_part, n) => (n < 6 ? "running" : "done") });
    await w.run();
    expect(w.sleeps).toEqual([10_000, 15_000, 20_000, 25_000, 30_000, 30_000]);
    expect(pollDelayMs(100)).toBe(30_000);
    expect(w.seen.filter((r) => r.method === "DELETE").map((r) => r.url.pathname)).toEqual(["/v2/projects/123456789012/locations/eu/operations/v2-00000000-0000-0000-0000-000000000001"]);
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
  const phrases = (name: string, wordOffsets: boolean) => phrasesOfPart(doc(name), 1, 0, wordOffsets)!;

  it("the submit answer's operation name is accepted and the polls address it (v2-<uuid>, project NUMBER)", async () => {
    const w = world();
    await w.run();
    const got = w.seen.find((r) => r.method === "GET")!;
    expect(got.url.pathname).toBe("/v2/projects/123456789012/locations/eu/operations/v2-00000000-0000-0000-0000-000000000001");
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
    const bounded = phrasesOfPart(doc("output-recorded-garbled-offsets.json"), 1, 0, true, 1_116_000)!;
    expect(bounded.map((p) => [p.speaker, p.startMs, p.startMs + p.durationMs])).toEqual([
      ["p1:0", 805_160, 807_800],
      ["p1:1", 811_440, 814_120],
      ["p1:0", 815_120, 817_840],
    ]);
    // Unbounded, the same words would start the second run at 9985 s and every later one after it: the poison.
    const unbounded = phrasesOfPart(doc("output-recorded-garbled-offsets.json"), 1, 0, true, 4 * 3_600_000)!;
    expect(unbounded.some((p) => p.startMs > 9_000_000)).toBe(true);
  });

  it("the bound also holds when nobody says how long the part is: a part is never longer than PIECE_MAX_MS", () => {
    const words = [
      { word: "a", speakerLabel: "1", startOffset: "1s", endOffset: "2s" },
      { word: "b", speakerLabel: "1", startOffset: "99999s", endOffset: "100000s" },
    ];
    const got = phrasesOfPart({ results: [{ alternatives: [{ transcript: "a b", words }] }] }, 1, 0, true)!;
    expect([got[0]!.startMs, got[0]!.startMs + got[0]!.durationMs]).toEqual([1000, 2000]);
  });

  it("a word whose offsets run backwards, are absurdly long or precede what was already heard is not trusted", () => {
    const result = (words: Record<string, string>[]) => ({ results: [{ alternatives: [{ transcript: "a b c d", words }] }] });
    const word = (w: string, startOffset: string | undefined, endOffset: string | undefined) => ({ word: w, speakerLabel: "1", ...(startOffset ? { startOffset } : {}), ...(endOffset ? { endOffset } : {}) });
    const got = phrasesOfPart(result([word("a", "1s", "2s"), word("b", "176.4s", "12.68s"), word("c", "2s", "400s"), word("d", "3s", "4s")]), 1, 0, true)!;
    expect(got).toHaveLength(1);
    expect([got[0]!.startMs, got[0]!.startMs + got[0]!.durationMs]).toEqual([1000, 4000]);
  });

  it("a run with no trustworthy word at all starts where the previous phrase ended, and never earlier", () => {
    const words = [
      { word: "a", speakerLabel: "1", startOffset: "1s", endOffset: "5s" },
      { word: "b", speakerLabel: "2" },
    ];
    const got = phrasesOfPart({ results: [{ alternatives: [{ transcript: "a b", words }] }] }, 1, 0, true)!;
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
    const got = phrasesOfPart({ results: [{ alternatives: [{ transcript: "ciao [BACKGROUND] [ grazie", words }] }] }, 1, 0, true)!;
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
      { ordinal: 0, startMs: 0, endMs: 3000, speakerKey: "s1", text: "Ready?" },
      { ordinal: 1, startMs: 0, endMs: 3000, speakerKey: "s2", text: "Yes, go ahead." },
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

  it("submits one operation per part, each with its own input and the same output prefix", async () => {
    const w = world({ starts: [0, 3_600_000, 7_200_000], output: (part) => outputs[part]! });
    await w.run();
    const posts = w.seen.filter((r) => r.method === "POST").map((r) => r.body as { files: { uri: string }[]; recognitionOutputConfig: unknown });
    expect(posts.map((p) => p.files[0]!.uri.split("/").pop()).sort()).toEqual(["1.ogg", "2.ogg", "3.ogg"]);
    expect(new Set(posts.map((p) => JSON.stringify(p.recognitionOutputConfig))).size).toBe(1);
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
      poll: (part, n) => (part === 2 ? new Response("{}", { status: 403 }) : "running"),
    });
    const error = (await rejection(w.run())) as TranscriptionError;
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.code).toBe("provider_rejected");
    expect(w.polls.get(1)!).toBeLessThan(5); // part 1 was told to stop, not left polling for 45 minutes
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
    ["output URI outside the attempt's out/", { outputUri: () => "gs://fake-transient-bucket/transcribe/other_meeting/1/out/x.json" }, "provider_rejected", false],
    ["output URI in another bucket", { outputUri: () => "gs://someone-elses-bucket/transcribe/meeting_1/2/out/x.json" }, "provider_rejected", false],
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
    expect(w.storage.events.filter((e) => e.op === "deletePrefix").map((e) => e.key)).toEqual([`transcribe/${MEETING}/${ATTEMPT}/`]);

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
    const older = `transcribe/${MEETING}/${ATTEMPT - 1}/out/late.json`;
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

  it("result times never run backwards and a result without an end reuses the last one", () => {
    const phrases = phrasesOfPart(
      { results: [{ alternatives: [{ transcript: "a" }], resultEndOffset: "5s" }, { alternatives: [{ transcript: "b" }], resultEndOffset: "3s" }, { alternatives: [{ transcript: "c" }] }] },
      1,
      1000,
      false,
    )!;
    expect(phrases.map((p) => [p.startMs, p.durationMs])).toEqual([[1000, 5000], [6000, 0], [6000, 0]]);
  });

  it("refuses documents of the wrong shape", () => {
    for (const doc of [null, [], "x", { results: {} }, { results: [null] }, { results: [{ alternatives: "x" }] }, { results: [{ alternatives: [{ transcript: 5 }] }] }, { results: [{ alternatives: [{ words: "x" }] }] }]) {
      expect(phrasesOfPart(doc, 1, 0, false), JSON.stringify(doc)).toBeNull();
    }
  });

  it("namespaces a label that is not safe as a key into the part's unlabelled voice", () => {
    const phrases = phrasesOfPart({ results: [{ alternatives: [{ transcript: "x", words: [{ word: "x", speakerLabel: "../evil label" }] }], resultEndOffset: "1s" }] }, 3, 0, false)!;
    expect(phrases[0]!.speaker).toBe("p3:0");
  });
});
