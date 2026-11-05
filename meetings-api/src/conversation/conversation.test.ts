import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolveResponse } from "../authz/resolveClient";

// US-9 (AC-9.1 to AC-9.8), AC-13.4: ask the meeting. Real app, real Postgres (`meetings_test`), the fake language model.

const harness = setupTestAuth();
await harness.init();
const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { FakeLanguageModel } = await import("../ai/fakeLanguageModel");
const { LanguageModelError, setLanguageModelForTests } = await import("../ai/languageModel");
const { AI_REQUESTS_PER_HOUR } = await import("../ai/rateLimit");
const { NOT_IN_MEETING, ANSWER_SYSTEM_PROMPT } = await import("../ai/prompts/answer");
const { askConfig } = await import("./conversation.routes");

const grants = (...pairs: [string, string][]): ResolveResponse => ({
  sub: "x",
  epoch: 0,
  permissions: pairs.map(([resource, action]) => ({ resource, action, conditions: null })),
  entity: null,
  jobTitle: null,
});
const EMPLOYEE = grants(["meetings", "access"]);
const NOBODY = grants();

let access: Record<string, ResolveResponse>;
const tokens = new Map<string, string>();
async function tokenOf(user: string) {
  if (!tokens.has(user)) tokens.set(user, await harness.signToken({ sub: user, email: `${user}@x.test` }));
  return tokens.get(user)!;
}

let model: InstanceType<typeof FakeLanguageModel>;
let authDown: boolean;

async function call(method: string, path: string, as: string | null, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      ...(as ? { Authorization: `Bearer ${await tokenOf(as)}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as any) : null, text };
}

const SEGMENTS = [
  { text: "We decided to ship on Friday.", speakerKey: "s1", startMs: 0 },
  { text: "The vendor is late.", speakerKey: "s2", startMs: 65_000 },
];

async function readyMeeting(over: Record<string, unknown> = {}, participants: string[] = ["carol", "dave"]) {
  const m = await db.meeting.create({
    data: {
      title: "Quarterly planning",
      format: "online",
      startsAt: new Date("2026-11-04T09:00:00Z"),
      language: "en",
      source: "recorded",
      status: "ready",
      creatorUserId: "alice",
      transcriptVersion: 3,
      ...over,
    } as never,
  });
  const text = over["source"] === "text";
  await db.transcriptSegment.createMany({
    data: SEGMENTS.map((s, ordinal) => ({
      meetingId: m.id,
      ordinal,
      text: s.text,
      speakerKey: text ? null : s.speakerKey,
      startMs: text ? null : s.startMs,
      endMs: text ? null : s.startMs + 1000,
    })),
  });
  for (const userId of participants) await db.meetingParticipant.create({ data: { meetingId: m.id, userId, addedBy: "alice" } });
  return m;
}

const ask = (meetingId: string, question: string, as = "alice") => call("POST", `/meetings/${meetingId}/conversation/questions`, as, { question });
const turns = (meetingId: string, as = "alice") => call("GET", `/meetings/${meetingId}/conversation`, as);
const segmentIds = async (meetingId: string) => (await db.transcriptSegment.findMany({ where: { meetingId }, orderBy: { ordinal: "asc" } })).map((s) => s.id);

beforeAll(() => {
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
});
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "meeting", "ai_request" CASCADE');
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  access = {};
  harness.setResolve(async (authorization) => {
    for (const [user, token] of tokens) if (authorization === `Bearer ${token}`) return access[user] ?? EMPLOYEE;
    return EMPLOYEE;
  });
  model = new FakeLanguageModel();
  setLanguageModelForTests(model);
  askConfig.timeoutMs = 90_000;
  authDown = false;
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.endsWith("/authz/users/identities")) {
      if (authDown) return new Response("down", { status: 503 });
      const ids = (JSON.parse(init?.body ?? "{}") as { ids: string[] }).ids;
      return Response.json({ users: ids.map((id) => ({ id, status: "active", name: `Name of ${id}` })) });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as never);
});
afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});
afterAll(async () => {
  setLanguageModelForTests(null);
  askConfig.timeoutMs = 90_000;
  await db.$disconnect();
});

describe("access", () => {
  it("401 without a token; ask and retry need meetings:access (403) and a live auth (503); reading and clearing do not", async () => {
    const m = await readyMeeting();
    expect((await ask(m.id, "Hi", null as never)).status).toBe(401);
    expect((await turns(m.id, null as never)).status).toBe(401);
    const first = await ask(m.id, "What was decided?");
    expect(first.status).toBe(201);

    access["alice"] = NOBODY;
    __resetAuthzCacheForTests();
    expect((await ask(m.id, "Again?")).status).toBe(403);
    expect((await call("POST", `/meetings/${m.id}/conversation/questions/${first.json.id}/retry`, "alice")).status).toBe(403);
    expect((await turns(m.id)).json.turns).toHaveLength(1);

    __resetAuthzCacheForTests();
    harness.setResolve(async () => {
      throw new Error("auth is down");
    });
    expect((await ask(m.id, "Again?")).status).toBe(503);
    expect((await turns(m.id)).status).toBe(200);
    expect((await call("DELETE", `/meetings/${m.id}/conversation`, "alice")).status).toBe(204);
  });

  it("a meeting the caller cannot open is the identical 404 for every route; a participant may ask", async () => {
    const m = await readyMeeting();
    const hidden = await ask(m.id, "Hi", "mallory");
    const missing = await ask("does-not-exist", "Hi", "mallory");
    expect(hidden.status).toBe(404);
    expect(hidden.text.replace(m.id, "X")).toBe(missing.text.replace("does-not-exist", "X"));
    expect((await turns(m.id, "mallory")).status).toBe(404);
    expect((await call("DELETE", `/meetings/${m.id}/conversation`, "mallory")).status).toBe(404);
    expect((await call("POST", `/meetings/${m.id}/conversation/questions/x/retry`, "mallory")).status).toBe(404);
    expect((await ask(m.id, "Hi", "carol")).status).toBe(201);
  });

  it("409 not_ready / no_speech; nothing is stored and no AI slot is taken", async () => {
    const processing = await readyMeeting({ status: "processing" });
    const silent = await readyMeeting({ noSpeech: true });
    const a = await ask(processing.id, "Hi");
    const b = await ask(silent.id, "Hi");
    expect([a.status, a.json.code]).toEqual([409, "not_ready"]);
    expect([b.status, b.json.code]).toEqual([409, "no_speech"]);
    expect(await db.conversationTurn.count()).toBe(0);
    expect(await db.aiRequest.count()).toBe(0);
    expect(model.requests).toHaveLength(0);
  });
});

describe("the question (AC-9.1)", () => {
  it("0 characters and 1001 characters are 422; 1 and 1000 are fine; blank is not a question", async () => {
    const m = await readyMeeting();
    expect((await ask(m.id, "")).status).toBe(422);
    expect((await ask(m.id, "   \n ")).status).toBe(422);
    expect((await ask(m.id, "x".repeat(1001))).status).toBe(422);
    expect((await call("POST", `/meetings/${m.id}/conversation/questions`, "alice", {})).status).toBe(422);
    expect((await ask(m.id, "x")).status).toBe(201);
    expect((await ask(m.id, "y".repeat(1000))).status).toBe(201);
    expect(await db.conversationTurn.count()).toBe(2);
  });

  it("answers synchronously: 201, answered, text, and citations resolved with segment id, ordinal, time and speaker", async () => {
    const m = await readyMeeting();
    const ids = await segmentIds(m.id);
    model.respondWith({ answer: "They decided to ship on Friday.", citations: ["S0", "S1"], notInMeeting: false });
    const res = await ask(m.id, "What did we decide?");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      question: "What did we decide?",
      status: "answered",
      answer: {
        text: "They decided to ship on Friday.",
        notInMeeting: false,
        citations: [
          { segmentId: ids[0], ordinal: 0, startMs: 0, speaker: "Speaker 1" },
          { segmentId: ids[1], ordinal: 1, startMs: 65_000, speaker: "Speaker 2" },
        ],
      },
    });
    expect(Object.keys(res.json).sort()).toEqual(["answer", "createdAt", "id", "question", "status"]);
    expect((await turns(m.id)).json.turns).toEqual([res.json]);
  });

  it("sends the whole transcript, the question and nothing else: no summary, no title, no other meeting, no other user's turns (AC-9.2)", async () => {
    const m = await readyMeeting();
    const other = await readyMeeting({ title: "Other meeting" });
    await db.transcriptSegment.updateMany({ where: { meetingId: other.id }, data: { text: "OTHER-MEETING-CANARY" } });
    await db.summary.create({
      data: { meetingId: m.id, authorUserId: "alice", template: {}, language: "en", status: "ready", attemptId: "a", sections: [{ heading: "H", body: "SUMMARY-CANARY", notDiscussed: false }], transcriptVersion: 3 },
    });
    await db.conversationTurn.create({
      data: { meetingId: m.id, userId: "carol", question: "CAROLS-QUESTION", status: "answered", answer: { text: "CAROLS-ANSWER", citations: [], notInMeeting: true }, transcriptVersion: 3 },
    });
    await ask(m.id, "What is the plan?");
    const { request } = model.requests[0]!;
    expect(request.system).toBe(ANSWER_SYSTEM_PROMPT);
    const all = request.messages.map((x) => x.text).join("\n");
    expect(all).toContain("[S0 00:00:00 Speaker 1] We decided to ship on Friday.");
    expect(all).toContain("[S1 00:01:05 Speaker 2] The vendor is late.");
    expect(all).toContain("What is the plan?");
    for (const secret of ["OTHER-MEETING-CANARY", "SUMMARY-CANARY", "CAROLS-QUESTION", "CAROLS-ANSWER", "Quarterly planning", "Other meeting"]) expect(all).not.toContain(secret);
  });

  it("names speakers live with the caller's token: custom label, external, resolved Operai participant", async () => {
    const m = await readyMeeting({}, ["carol"]);
    const carol = await db.meetingParticipant.findFirstOrThrow({ where: { meetingId: m.id, userId: "carol" } });
    await db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s1", participantId: carol.id } });
    await db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s2", customLabel: "The vendor rep" } });
    model.respondWith({ answer: "Both spoke.", citations: ["S0", "S1"], notInMeeting: false });
    const res = await ask(m.id, "Who spoke?");
    expect(res.json.answer.citations.map((c: { speaker: string }) => c.speaker)).toEqual(["Name of carol", "The vendor rep"]);
    const prompt = model.requests[0]!.request.messages[0]!.text;
    expect(prompt).toContain("Name of carol] We decided");
    expect(prompt).toContain("The vendor rep] The vendor");
  });

  it("a text meeting's passages cite with no time and no speaker", async () => {
    const m = await readyMeeting({ source: "text" });
    model.respondWith({ answer: "Ship on Friday.", citations: ["S0"], notInMeeting: false });
    const res = await ask(m.id, "When?");
    expect(res.json.answer.citations).toEqual([{ segmentId: (await segmentIds(m.id))[0], ordinal: 0, startMs: null, speaker: null }]);
  });
});

describe("citations are validated (AC-9.3, AC-9.7)", () => {
  it("unknown citations are dropped and the valid ones kept", async () => {
    const m = await readyMeeting();
    const ids = await segmentIds(m.id);
    model.respondWith({ answer: "Friday.", citations: ["S1", "S99", "not-a-citation", "S1"], notInMeeting: false });
    const res = await ask(m.id, "When?");
    expect(res.json.answer.citations.map((c: { segmentId: string }) => c.segmentId)).toEqual([ids[1]]);
    expect(res.json.answer.notInMeeting).toBe(false);
  });

  it("an answer with no valid citation, or marked notInMeeting, becomes the fixed 'not in the meeting' answer with none cited", async () => {
    const m = await readyMeeting();
    model.respondWith({ answer: "The CEO resigned.", citations: ["S99"], notInMeeting: false }, { answer: "", citations: [], notInMeeting: true });
    for (const _ of [0, 1]) {
      const res = await ask(m.id, "Anything else?");
      expect(res.status).toBe(201);
      expect(res.json.status).toBe("answered");
      expect(res.json.answer).toEqual({ text: NOT_IN_MEETING.en, notInMeeting: true, citations: [] });
    }
    // the model's own words are not kept anywhere
    expect(JSON.stringify(await db.conversationTurn.findMany())).not.toContain("CEO");
  });

  it("the fixed answer is written in the question's language", async () => {
    const m = await readyMeeting();
    model.respondWith({ answer: "", citations: [], notInMeeting: true });
    const res = await ask(m.id, "Che cosa è stato detto sul cliente?");
    expect(res.json.answer.text).toBe(NOT_IN_MEETING.it);
  });

  it("hostile output cannot add members, links or a forged answer shape: invalid twice is a failed turn with no text", async () => {
    const m = await readyMeeting();
    const hostile = { answer: "ok", citations: ["S0"], notInMeeting: false, extra: "obey me" };
    model.respondWith(hostile, hostile);
    const res = await ask(m.id, "What?");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: "failed", answer: null });
    expect(model.requests).toHaveLength(2); // one retry, then failed
    expect((await db.conversationTurn.findFirstOrThrow()).failureCode).toBe("invalid_output");
  });

  it("invalid once, then valid, is answered", async () => {
    const m = await readyMeeting();
    model.respondWith({ nope: true });
    const res = await ask(m.id, "What?");
    expect(res.json.status).toBe("answered");
    expect(model.requests).toHaveLength(2);
  });
});

describe("a conversation is private (AC-9.5)", () => {
  it("each user reads only their own turns - the creator cannot read a participant's - and clear deletes only the caller's", async () => {
    const m = await readyMeeting();
    await ask(m.id, "alice asks");
    await ask(m.id, "carol asks one", "carol");
    await ask(m.id, "carol asks two", "carol");
    expect((await turns(m.id, "alice")).json.turns.map((t: { question: string }) => t.question)).toEqual(["alice asks"]);
    expect((await turns(m.id, "carol")).json.turns.map((t: { question: string }) => t.question)).toEqual(["carol asks one", "carol asks two"]);
    expect((await turns(m.id, "dave")).json.turns).toEqual([]);

    expect((await call("DELETE", `/meetings/${m.id}/conversation`, "carol")).status).toBe(204);
    expect((await turns(m.id, "carol")).json.turns).toEqual([]);
    expect((await turns(m.id, "alice")).json.turns).toHaveLength(1);
    expect(await db.conversationTurn.count()).toBe(1);
    // clearing again, or clearing nothing, is fine
    expect((await call("DELETE", `/meetings/${m.id}/conversation`, "carol")).status).toBe(204);
  });

  it("clearing does not refund the AI limit", async () => {
    const m = await readyMeeting();
    await ask(m.id, "one");
    await call("DELETE", `/meetings/${m.id}/conversation`, "alice");
    expect(await db.aiRequest.count()).toBe(1);
  });

  it("the conversation is kept: it is shown again on return, oldest first", async () => {
    const m = await readyMeeting();
    await ask(m.id, "first");
    await ask(m.id, "second");
    const { json } = await turns(m.id);
    expect(json.turns.map((t: { question: string }) => t.question)).toEqual(["first", "second"]);
    expect(json.turns.every((t: { status: string }) => t.status === "answered")).toBe(true);
  });
});

describe("follow-ups (AC-9.4)", () => {
  it("sends the previous 10 answered turns, in order, and not the 11th", async () => {
    const m = await readyMeeting();
    const base = Date.now() - 3_600_000;
    for (let i = 1; i <= 12; i++) {
      await db.conversationTurn.create({
        data: {
          meetingId: m.id,
          userId: "alice",
          question: `question ${i}`,
          status: "answered",
          answer: { text: `answer ${i}`, citations: [], notInMeeting: true },
          transcriptVersion: 3,
          createdAt: new Date(base + i * 1000),
        },
      });
    }
    // a failed turn is not history
    await db.conversationTurn.create({ data: { meetingId: m.id, userId: "alice", question: "failed one", status: "failed", transcriptVersion: 3, createdAt: new Date(base + 13_000) } });
    await ask(m.id, "latest question");
    const { messages } = model.requests[0]!.request;
    expect(messages).toHaveLength(21);
    const text = messages.map((x) => x.text).join("\n");
    expect(text).not.toContain("question 1<");
    expect(text).not.toContain("question 2<");
    expect(text).toContain("question 3<");
    expect(text).toContain("question 12<");
    expect(text).not.toContain("failed one");
    expect(messages.at(-1)!.text).toContain("latest question");
  });
});

describe("failure (AC-9.6)", () => {
  it("an AI outage stores the question as failed with no answer text, answers 201, and a retry is offered", async () => {
    const m = await readyMeeting();
    model.failWith(new LanguageModelError("provider_unavailable", true, 503));
    const res = await ask(m.id, "What did we decide?");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ question: "What did we decide?", status: "failed", answer: null });
    const row = await db.conversationTurn.findFirstOrThrow();
    expect([row.status, row.answer, row.failureCode]).toEqual(["failed", null, "provider_unavailable"]);
    expect((await turns(m.id)).json.turns[0]).toMatchObject({ status: "failed", answer: null });
  });

  it("a model that never answers is cut off by the route's own timeout: failed, timed_out", async () => {
    const m = await readyMeeting();
    askConfig.timeoutMs = 50;
    model.respondWith(() => new Promise(() => {}));
    const res = await ask(m.id, "Hello?");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: "failed", answer: null });
    expect((await db.conversationTurn.findFirstOrThrow()).failureCode).toBe("timed_out");
  });

  it("a refusal fails at once, without a second sample", async () => {
    const m = await readyMeeting();
    model.failWith(new LanguageModelError("provider_rejected", false, 400));
    const res = await ask(m.id, "Hello?");
    expect(res.json.status).toBe("failed");
    expect(model.requests).toHaveLength(1);
  });

  it("a pending turn older than 2 minutes reads failed; a younger one stays pending; the stored row is not rewritten", async () => {
    const m = await readyMeeting();
    const old = await db.conversationTurn.create({ data: { meetingId: m.id, userId: "alice", question: "old", status: "pending", transcriptVersion: 3, createdAt: new Date(Date.now() - 3 * 60_000) } });
    const young = await db.conversationTurn.create({ data: { meetingId: m.id, userId: "alice", question: "young", status: "pending", transcriptVersion: 3, createdAt: new Date(Date.now() - 30_000) } });
    const byId = new Map((await turns(m.id)).json.turns.map((t: { id: string }) => [t.id, t]));
    expect(byId.get(old.id)).toMatchObject({ status: "failed", answer: null });
    expect(byId.get(young.id)).toMatchObject({ status: "pending", answer: null });
    expect((await db.conversationTurn.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("pending");
  });
});

describe("retry (AC-9.6)", () => {
  async function failedTurn() {
    const m = await readyMeeting();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5)); // createdAt has millisecond resolution
    await ask(m.id, "An earlier answered one");
    await pause();
    model.failWith(new LanguageModelError("provider_unavailable", true, 503));
    const failed = await ask(m.id, "What did we decide?");
    await pause();
    await ask(m.id, "A later one");
    model.requests.length = 0;
    return { m, tid: failed.json.id as string };
  }

  it("answers the same turn: same id and question, now answered; history is the turns BEFORE it only; takes one AI slot", async () => {
    const { m, tid } = await failedTurn();
    const slots = await db.aiRequest.count();
    model.respondWith({ answer: "Ship on Friday.", citations: ["S0"], notInMeeting: false });
    const res = await call("POST", `/meetings/${m.id}/conversation/questions/${tid}/retry`, "alice");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: tid, question: "What did we decide?", status: "answered", answer: { text: "Ship on Friday." } });
    expect(await db.aiRequest.count()).toBe(slots + 1);
    expect(await db.conversationTurn.count()).toBe(3);
    const text = model.requests[0]!.request.messages.map((x) => x.text).join("\n");
    expect(text).toContain("An earlier answered one");
    expect(text).not.toContain("A later one");
    expect((await db.conversationTurn.findUniqueOrThrow({ where: { id: tid } })).failureCode).toBeNull();
  });

  it("a retry that fails again leaves the turn failed, still retryable", async () => {
    const { m, tid } = await failedTurn();
    model.failWith(new LanguageModelError("provider_unavailable", true, 503));
    const res = await call("POST", `/meetings/${m.id}/conversation/questions/${tid}/retry`, "alice");
    expect(res.json).toMatchObject({ id: tid, status: "failed", answer: null });
    model.respondWith({ answer: "Friday.", citations: ["S0"], notInMeeting: false });
    expect((await call("POST", `/meetings/${m.id}/conversation/questions/${tid}/retry`, "alice")).json.status).toBe("answered");
  });

  it("can retry a turn that only READS failed (pending for over 2 minutes)", async () => {
    const m = await readyMeeting();
    const old = await db.conversationTurn.create({ data: { meetingId: m.id, userId: "alice", question: "stuck", status: "pending", transcriptVersion: 3, createdAt: new Date(Date.now() - 3 * 60_000) } });
    const res = await call("POST", `/meetings/${m.id}/conversation/questions/${old.id}/retry`, "alice");
    expect(res.json.status).toBe("answered");
  });

  it("409 not_failed for an answered or a still-young pending turn, with no slot taken; 404 for another user's turn or another meeting's", async () => {
    const m = await readyMeeting();
    const other = await readyMeeting();
    const done = await ask(m.id, "done");
    const young = await db.conversationTurn.create({ data: { meetingId: m.id, userId: "alice", question: "young", status: "pending", transcriptVersion: 3 } });
    const slots = await db.aiRequest.count();
    expect((await call("POST", `/meetings/${m.id}/conversation/questions/${done.json.id}/retry`, "alice")).json.code).toBe("not_failed");
    expect((await call("POST", `/meetings/${m.id}/conversation/questions/${young.id}/retry`, "alice")).json.code).toBe("not_failed");
    expect(await db.aiRequest.count()).toBe(slots);
    // carol cannot touch alice's turn, and the creator cannot touch carol's
    expect((await call("POST", `/meetings/${m.id}/conversation/questions/${done.json.id}/retry`, "carol")).status).toBe(404);
    expect((await call("POST", `/meetings/${other.id}/conversation/questions/${done.json.id}/retry`, "alice")).status).toBe(404);
  });
});

describe("the AI rate limit (AC-9.8, AC-13.4)", () => {
  it("the 31st request of the hour is a 429 ai_rate_limited with Retry-After and no turn is stored for it", async () => {
    const m = await readyMeeting();
    for (let i = 0; i < AI_REQUESTS_PER_HOUR; i++) expect((await ask(m.id, `q${i}`)).status).toBe(201);
    const res = await ask(m.id, "one too many");
    expect(res.status).toBe(429);
    expect(res.json.code).toBe("ai_rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.json.retryAfterSeconds).toBe(Number(res.headers.get("Retry-After")));
    expect(await db.conversationTurn.count()).toBe(AI_REQUESTS_PER_HOUR);
    expect(model.requests).toHaveLength(AI_REQUESTS_PER_HOUR);
    // a retry is refused the same way, and another user is unaffected
    const failed = await db.conversationTurn.findFirstOrThrow();
    await db.conversationTurn.update({ where: { id: failed.id }, data: { status: "failed" } });
    expect((await call("POST", `/meetings/${m.id}/conversation/questions/${failed.id}/retry`, "alice")).status).toBe(429);
    expect((await ask(m.id, "fine", "carol")).status).toBe(201);
  });

  it("summaries and questions share one allowance", async () => {
    const m = await readyMeeting();
    for (let i = 0; i < AI_REQUESTS_PER_HOUR - 1; i++) await db.aiRequest.create({ data: { userId: "alice", kind: "summary" } });
    expect((await ask(m.id, "last one")).status).toBe(201);
    expect((await ask(m.id, "over")).status).toBe(429);
  });
});
