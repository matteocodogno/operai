/**
 * Log privacy over the ASSEMBLED app (specs/021-meetings T42; AC-4.10): "logs and error reports
 * hold identifiers and sizes only". Canary strings are planted in everything a person writes or
 * says (title, transcript, summary, question, answer, template, external participant) and in the
 * caller's own token (email, display name), then every route of the real route table is run as
 * several callers, in the happy path and under each fault the service survives (auth down, identities
 * down, storage down, a host down, an uncaught error), and every job kind is run through the real
 * runner with the model and the transcriber returning or throwing canaries. Everything written to
 * the console is captured; none of it may contain one.
 *
 * It tests the logging, not the response: a canary may well appear in a response to the person who
 * wrote it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { createKit } from "./test-support/routeKit";
import { PERSONAS, ROWS, SPECS, kindsOf, rowName, seedWorld, type Persona, type RouteRow, type Texts } from "./test-support/matrixKit";

// Each test below walks the whole route table as several callers.
setDefaultTimeout(120_000);

const kit = await createKit();
const { createRunner, enqueueJob } = await import("./jobs/runner");
const { handlers } = await import("./jobs/handlers");
const { setLanguageModelForTests, SUMMARY_TOOL } = await import("./ai/languageModel");
const { defaultOutput } = await import("./ai/fakeLanguageModel");
const { setTranscriberForTests, TranscriptionError } = await import("./ai/transcriber");
const { mapPhrases } = await import("./ai/segments");

// ─── The canaries ────────────────────────────────────────────────────────────

const CANARY = {
  title: "CNRY-title-q7x Quarterly plan",
  transcript: "CNRY-transcript-q7x the budget is eight hundred",
  summaryHeading: "CNRY-heading-q7x",
  summaryBody: "CNRY-summary-q7x we decided to hire",
  question: "CNRY-question-q7x who owns the budget?",
  answer: "CNRY-answer-q7x the finance lead owns it",
  externalName: "CNRY-external-q7x",
  externalOrg: "CNRY-org-q7x",
  templateName: "CNRY-template-q7x",
  instruction: "CNRY-instruction-q7x",
  speakerLabel: "CNRY-speaker-q7x",
} satisfies Texts;
const TOKEN_EMAIL = "cnry.email.q7x@canary-mail.test";
const TOKEN_NAME = "CNRY-name-q7x";
const ALL = [...Object.values(CANARY), TOKEN_EMAIL, TOKEN_NAME, "cnry-"];

// ─── Capturing the console ───────────────────────────────────────────────────

const captured: string[] = [];
const spies: ReturnType<typeof spyOn>[] = [];
const text = (args: unknown[]) => args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}` : Bun.inspect(arg))).join(" ");

beforeAll(() => {
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    spies.push(spyOn(console, method).mockImplementation((...args: unknown[]) => void captured.push(text(args))));
  }
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  setLanguageModelForTests(null);
  setTranscriberForTests(null);
});
beforeEach(() => {
  captured.length = 0;
});

/** Every captured line that holds a canary, with which one. */
const leaks = () =>
  captured.flatMap((line) => {
    const canary = ALL.find((candidate) => line.toLowerCase().includes(candidate.toLowerCase()));
    return canary ? [`${canary} in: ${line.slice(0, 200)}`] : [];
  });

// ─── The model and the transcriber speak canaries, or throw them ─────────────

let providers: "speak" | "throw" = "speak";
setLanguageModelForTests({
  async complete(request, schema) {
    if (providers === "throw") throw new Error(`provider exploded: ${CANARY.summaryBody} ${CANARY.question}`);
    const out = defaultOutput(request, schema) as { sections?: { body: string }[]; answer?: string };
    if (schema.name === SUMMARY_TOOL) return { ...out, sections: out.sections?.map((s) => ({ ...s, body: CANARY.summaryBody })) };
    return { ...out, ...(out.answer ? { answer: CANARY.answer } : {}) };
  },
});
setTranscriberForTests({
  async transcribe() {
    if (providers === "throw") throw new Error(`provider exploded: ${CANARY.transcript}`);
    return { kind: "segments", segments: mapPhrases([{ speaker: 1, startMs: 0, durationMs: 2_000, text: CANARY.transcript }]), partStartsMs: [0], parts: [{ startMs: 0, endMs: 2_000 }], gaps: [] };
  },
});

// ─── Requests: every call carries a token whose email and name are canaries ──

const tokens = new Map<string, string>();
async function send(sub: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  let auth: Record<string, string> = {};
  if (sub !== null) {
    let token = tokens.get(sub);
    if (!token) {
      token = await kit.harness.signToken({ sub, email: TOKEN_EMAIL, name: TOKEN_NAME });
      tokens.set(sub, token);
    }
    auth = { Authorization: `Bearer ${token}` };
  }
  return kit.app.request(path, {
    method,
    headers: { ...auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Seeds a canary world for `persona` and fires `row` as that persona; returns the response. */
async function fire(row: RouteRow, persona: Persona, before?: () => void) {
  const world = await seedWorld(kit, persona, kindsOf(row), CANARY);
  before?.();
  const [method] = row.route.split(" ") as [string];
  return send(SPECS[persona].caller, method, row.path(world), row.body?.(world), row.headers);
}

async function runAll(personas: readonly Persona[], before?: () => void) {
  const statuses = new Map<number, number>();
  for (const row of ROWS) {
    for (const persona of personas) {
      const res = await fire(row, persona, before);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      await res.body?.cancel();
    }
  }
  return statuses;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("the canary check itself", () => {
  it("sees a canary in any argument shape the code could log", () => {
    console.log("plain", CANARY.title);
    console.error(new Error(`wrapped ${CANARY.transcript}`));
    console.warn({ nested: { text: CANARY.summaryBody } });
    console.info(["list", TOKEN_EMAIL]);
    expect(leaks()).toHaveLength(4);
  });

  it("the world really holds the canaries, so a leak would have something to leak", async () => {
    const world = await seedWorld(kit, "creator", ["ready"], CANARY);
    const res = await send("u-creator", "GET", `/meetings/${world.m.ready}`);
    expect(await res.text()).toContain(CANARY.title);
    const transcript = await send("u-creator", "GET", `/meetings/${world.m.ready}/transcript`);
    expect(await transcript.text()).toContain(CANARY.transcript);
  });
});

describe("every route, every kind of caller", () => {
  it("logs ids, paths, statuses and durations only", async () => {
    const statuses = await runAll(["creator", "participant", "hostReader", "outsider", "creatorNoAccess", "frozenCreator", "eraser", "anonymous"]);
    // Not vacuous: the run really exercised successes, refusals and not-founds, and logged each request.
    expect([...statuses.keys()].filter((status) => status >= 200 && status < 300).length).toBeGreaterThan(0);
    for (const status of [401, 403, 404]) expect(statuses.get(status), `no ${status} in the run`).toBeGreaterThan(0);
    expect(captured.filter((line) => /^(GET|POST|PUT|PATCH|DELETE) \//.test(line)).length).toBeGreaterThan(ROWS.length * 4);
    expect(leaks()).toEqual([]);
  });

  it("the request logger drops the query string, where a search term would sit", async () => {
    await seedWorld(kit, "creator", ["ready"], CANARY);
    await send("u-creator", "GET", `/meetings?q=${encodeURIComponent(CANARY.title)}&status=ready`);
    await send("u-creator", "GET", `/erase/meetings?q=${encodeURIComponent(CANARY.title)}`);
    await send("u-creator", "GET", `/templates?meetingId=${encodeURIComponent(CANARY.title)}`);
    expect(captured.some((line) => line.startsWith("GET /meetings 200"))).toBe(true);
    expect(leaks()).toEqual([]);
  });
});

describe("under each fault the service survives", () => {
  it("auth down", async () => {
    await runAll(["creator", "participant", "outsider"], () => kit.setAuthDown(true));
    expect(captured.some((line) => line.startsWith("[authz]"))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it("identities down (display names soft, creator and participants fail closed)", async () => {
    await runAll(["creator", "participant"], () => kit.setIdentitiesDown(true));
    expect(captured.some((line) => line.startsWith("[identities]"))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it("storage failing with an error whose message holds a canary", async () => {
    await runAll(["creator", "creatorNoAccess"], () => kit.storage.failWith(new Error(`bucket exploded for ${CANARY.title} ${CANARY.transcript}`)));
    expect(captured.some((line) => line.includes("[storage]") || line.includes("[meetings]"))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it("the model throwing the transcript at every ask and summarise", async () => {
    providers = "throw";
    try {
      await runAll(["creator", "participant"]);
    } finally {
      providers = "speak";
    }
    expect(captured.some((line) => line.startsWith("[conversation]"))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it("the host answering 500 to resolve and to notices, for a creator and a host reader", async () => {
    await runAll(["creator", "hostReader"], () => {
      kit.fake.mode.resolve = { status: 500 };
      kit.fake.mode.notices = { status: 500 };
    });
    expect(captured.some((line) => line.startsWith("[hosts]"))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it("an uncaught error carrying the title: the handler logs its name only", async () => {
    const world = await seedWorld(kit, "creator", ["ready"], CANARY);
    const visibility = await import("./meetings/visibility");
    const spy = spyOn(visibility, "loadMeetingForVisibility").mockRejectedValue(new TypeError(`unexpected ${CANARY.title} ${CANARY.summaryBody}`));
    let res: Response;
    try {
      res = await send("u-creator", "GET", `/meetings/${world.m.ready}/transcript`);
    } finally {
      spy.mockRestore();
    }
    const body = await res.text();
    expect(res.status).toBe(500);
    // The response to the caller does not echo it either.
    expect(body).not.toContain("CNRY");
    // The handler's own line is there, and (checked by every `leaks()` here) it holds the error's name, not its message.
    expect(captured.some((line) => line.startsWith("[uncaught] TypeError"))).toBe(true);
    expect(leaks()).toEqual([]);
  });
});

describe("every job kind, through the real runner", () => {
  const runner = createRunner({ db: kit.db, handlers, listenUrl: null, backoffMs: [0], idlePollMs: 3_600_000 });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  afterAll(() => runner.stop(1_000));

  /** Runs what is due, and what a failure re-queues, until nothing is. */
  async function drain() {
    for (let round = 0; round < 12; round++) {
      await runner.tick();
      while (runner.running() > 0) await sleep(15);
      const due = await kit.db.meetingJob.count({ where: { state: "queued", runAfter: { lte: new Date() } } });
      if (due === 0) return;
    }
  }

  async function processingMeeting(world: Awaited<ReturnType<typeof seedWorld>>) {
    const meeting = await kit.db.meeting.create({
      data: {
        title: CANARY.title,
        format: "online",
        startsAt: new Date(),
        language: "en",
        source: "recorded",
        status: "processing",
        stage: "transcribing",
        creatorUserId: world.owner,
        processingRequestedBy: world.owner,
        processingStartedAt: new Date(),
        audioBytes: 10,
        audioCreatedAt: new Date(),
      },
    });
    const audioKey = `meetings/${meeting.id}/audio.ogg`;
    await kit.db.meeting.update({ where: { id: meeting.id }, data: { audioKey } });
    kit.storage.put(audioKey, 10, "audio/ogg", new Uint8Array([1, 2, 3]));
    await kit.db.$transaction((tx) => enqueueJob(tx, { kind: "transcribe", meetingId: meeting.id }));
    return meeting.id;
  }

  async function queueFromRoutes(world: Awaited<ReturnType<typeof seedWorld>>) {
    const calls: [string, string, unknown?][] = [
      ["POST", `/meetings/${world.m.ready}/summaries`, { templateId: world.sharedTemplateId, language: "en" }],
      ["POST", `/meetings/${world.m.ready}/summaries/${world.summaryId}/regenerate`],
      ["POST", `/meetings/${world.m.ready}/summaries/${world.failedSummaryId}/retry`],
      ["POST", `/meetings/${world.m.failed}/retry`],
      ["POST", `/meetings/${world.m.interrupted}/recording/process`],
      ["POST", `/meetings/${world.m.live}/recording/stop`, { sessionId: world.sessionId, lastSeq: 0 }],
    ];
    for (const [method, path, body] of calls) expect((await send("u-creator", method, path, body)).status, path).toBeLessThan(300);
  }

  it.each(["speak", "throw"] as const)("summarize, transcribe and prepare_audio with a provider that %ss canaries", async (mode) => {
    const world = await seedWorld(kit, "creator", ["ready", "failed", "interrupted", "live"], CANARY);
    await queueFromRoutes(world);
    await processingMeeting(world);
    providers = mode;
    try {
      await drain();
    } finally {
      providers = "speak";
    }
    const done = await kit.db.meetingJob.groupBy({ by: ["kind", "state"], _count: true });
    const kinds = new Set(done.map((row) => row.kind));
    // Not vacuous: all three kinds really ran.
    expect([...kinds].sort()).toEqual(["prepare_audio", "summarize", "transcribe"]);
    expect(captured.filter((line) => line.startsWith("[jobs]")).length).toBeGreaterThan(2);
    expect(leaks()).toEqual([]);
  });

  it("a transcription the provider refused with a typed error, and one that says no speech", async () => {
    const world = await seedWorld(kit, "creator", ["ready"], CANARY);
    await processingMeeting(world);
    setTranscriberForTests({
      async transcribe() {
        throw new TranscriptionError("provider_rejected", false, 400);
      },
    });
    try {
      await drain();
    } finally {
      setTranscriberForTests({
        async transcribe() {
          return { kind: "noSpeech" };
        },
      });
    }
    await processingMeeting(world);
    await drain();
    expect(leaks()).toEqual([]);
  });

  it("deliver_host_notice for a deleted meeting, with the host refusing", async () => {
    const world = await seedWorld(kit, "hostReader", ["ready"], CANARY);
    // The creator of a host-linked meeting deletes it: `deleted` is an until-delivered notice with no title.
    await kit.db.meeting.update({ where: { id: world.m.ready! }, data: { creatorUserId: "u-creator" } });
    kit.grant("u-creator", "access");
    kit.fake.mode.notices = { status: 500 };
    expect((await send("u-creator", "DELETE", `/meetings/${world.m.ready}`)).status).toBe(204);
    const queued = await kit.db.meetingJob.count({ where: { kind: "deliver_host_notice" } });
    expect(queued).toBe(1);
    await drain();
    expect(captured.some((line) => line.startsWith("[hosts]") || line.startsWith("[jobs]"))).toBe(true);
    expect(leaks()).toEqual([]);
  });
});

describe("coverage of this test", () => {
  it("runs every row of the route table and every persona", () => {
    expect(ROWS.length).toBeGreaterThan(40);
    expect(PERSONAS.length).toBeGreaterThan(8);
    expect(ROWS.map(rowName).length).toBe(ROWS.length);
  });
});
