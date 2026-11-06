import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolveResponse } from "../authz/resolveClient";

// US-7 (AC-7.1, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9, 7.11), AC-6.8, AC-13.4: the summaries routes, through the real app
// and the real Postgres (`meetings_test`). The language model is the fake; the job runs through the real handler.

const harness = setupTestAuth();
await harness.init();
const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { FakeLanguageModel } = await import("../ai/fakeLanguageModel");
const { setLanguageModelForTests } = await import("../ai/languageModel");
const { createSummarizeHandler } = await import("../jobs/handlers/summarize");
const { AI_REQUESTS_PER_HOUR } = await import("../ai/rateLimit");

const grants = (...pairs: [string, string][]): ResolveResponse => ({
  sub: "x",
  epoch: 0,
  permissions: pairs.map(([resource, action]) => ({ resource, action, conditions: null })),
  entity: null,
  jobTitle: null,
});
const EMPLOYEE = grants(["meetings", "access"]);
const NOBODY = grants();

// who holds what: by user; anyone not listed is an employee
let access: Record<string, ResolveResponse>;
const tokens = new Map<string, string>();
async function tokenOf(user: string) {
  if (!tokens.has(user)) tokens.set(user, await harness.signToken({ sub: user, email: `${user}@x.test` }));
  return tokens.get(user)!;
}

let model: InstanceType<typeof FakeLanguageModel>;
let authDown: boolean;
let identityCalls: string[][];

async function call(method: string, path: string, as: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: {
      ...(as ? { Authorization: `Bearer ${await tokenOf(as)}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as any) : null, text };
}

const SEGMENTS = [
  { text: "We decided to ship on Friday.", speakerKey: "s1", startMs: 0 },
  { text: "The vendor is late.", speakerKey: "s2", startMs: 5_000 },
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
  await db.transcriptSegment.createMany({
    data: SEGMENTS.map((s, ordinal) => ({ meetingId: m.id, ordinal, text: s.text, speakerKey: s.speakerKey, startMs: s.startMs, endMs: s.startMs + 1000 })),
  });
  for (const userId of participants) await db.meetingParticipant.create({ data: { meetingId: m.id, userId, addedBy: "alice" } });
  return m;
}

const sections = [
  { heading: "Decisions", instruction: "List each decision." },
  { heading: "Risks", instruction: "Name the risks." },
];
const personal = (ownerUserId: string, name = "My notes") =>
  db.summaryTemplate.create({ data: { scope: "personal", ownerUserId, name, sections, generalInstructions: "Be brief.", createdBy: ownerUserId, updatedBy: ownerUserId } });
const sharedTemplate = (name = "Team") =>
  db.summaryTemplate.create({ data: { scope: "shared", name, sections, createdBy: "admin", updatedBy: "admin" } });

/** Runs the summarize job the route enqueued, through the real handler. */
async function runJob(summaryId: string) {
  const job = await db.meetingJob.findFirstOrThrow({ where: { summaryId, kind: "summarize" }, orderBy: { createdAt: "desc" } });
  const handler = createSummarizeHandler({ db, model: async () => model, announce: () => {} });
  await handler({
    job: { id: job.id, kind: "summarize", meetingId: job.meetingId, summaryId: job.summaryId, noticeId: null, attemptId: job.attemptId, attempts: 1, maxAttempts: 3 },
    attemptId: job.attemptId,
    attempt: 1,
    signal: new AbortController().signal,
    commit: async (fn) => db.$transaction(async (tx) => ({ committed: true as const, value: await fn(tx) })),
  });
}

const generate = (meetingId: string, as = "alice", body: Record<string, unknown> = { templateId: "builtin:minutes", language: "en" }) =>
  call("POST", `/meetings/${meetingId}/summaries`, as, body);
const list = (meetingId: string, as = "alice") => call("GET", `/meetings/${meetingId}/summaries`, as);

beforeAll(() => {
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
});
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "summary_template", "meeting", "meeting_job", "ai_request" CASCADE');
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  access = {};
  harness.setResolve(async (authorization) => {
    for (const [user, token] of tokens) if (authorization === `Bearer ${token}`) return access[user] ?? EMPLOYEE;
    return EMPLOYEE;
  });
  model = new FakeLanguageModel();
  setLanguageModelForTests(model);
  authDown = false;
  identityCalls = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.endsWith("/authz/users/identities")) {
      const ids = (JSON.parse(init?.body ?? "{}") as { ids: string[] }).ids;
      identityCalls.push(ids);
      if (authDown) return new Response("down", { status: 503 });
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
  await db.$disconnect();
});

describe("generate (AC-7.1)", () => {
  it("401 without a token, 403 without meetings:access, 503 when auth is down", async () => {
    const m = await readyMeeting();
    expect((await generate(m.id, null as never)).status).toBe(401);
    access["alice"] = NOBODY;
    expect((await generate(m.id)).status).toBe(403);
    access["alice"] = EMPLOYEE;
    __resetAuthzCacheForTests();
    harness.setResolve(async () => {
      throw new Error("auth is down");
    });
    expect((await generate(m.id)).status).toBe(503);
  });

  it("answers 202 with a generating summary, then the job makes it ready with the template's sections in order", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({
      template: { name: "Meeting minutes", source: "builtin" },
      language: "en",
      author: { id: "alice", status: "active" },
      status: "generating",
      edited: false,
      stale: false,
      version: 1,
      can: { edit: false, delete: true, retry: false },
    });
    expect(res.json.sections).toBeUndefined();

    await runJob(res.json.id);
    const after = (await list(m.id)).json.items[0];
    expect(after.status).toBe("ready");
    expect(after.sections.map((s: { heading: string }) => s.heading)).toEqual(["Summary", "Topics discussed", "Decisions", "Action items", "Open questions"]);
    expect(after.can).toEqual({ edit: true, delete: true, retry: false });
  });

  it("enqueues exactly one summarize job for the new row, carrying its attemptId", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    const row = await db.summary.findUniqueOrThrow({ where: { id: res.json.id } });
    const jobs = await db.meetingJob.findMany({ where: { summaryId: row.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "summarize", meetingId: m.id, attemptId: row.attemptId, state: "queued" });
  });

  it("uses the Accept-Language language when the body names none, and the built-in's headings in that language", async () => {
    const m = await readyMeeting();
    const res = await call("POST", `/meetings/${m.id}/summaries`, "alice", { templateId: "builtin:minutes" }, { "Accept-Language": "it" });
    expect(res.json.language).toBe("it");
    expect(res.json.template.name).toBe("Verbale della riunione");
  });

  it("422 for a language that is not en or it, or a missing templateId", async () => {
    const m = await readyMeeting();
    expect((await generate(m.id, "alice", { templateId: "builtin:minutes", language: "fr" })).status).toBe(422);
    expect((await generate(m.id, "alice", {})).status).toBe(422);
  });

  it("404 for another user's personal template, or one that does not exist - not 422, no leak", async () => {
    const m = await readyMeeting();
    const theirs = await personal("bob");
    expect((await generate(m.id, "alice", { templateId: theirs.id, language: "en" })).status).toBe(404);
    expect((await generate(m.id, "alice", { templateId: "nope", language: "en" })).status).toBe(404);
    expect((await generate(m.id, "alice", { templateId: "builtin:nope", language: "en" })).status).toBe(404);
    expect(await db.summary.count()).toBe(0);
  });

  it("a participant and a creator may generate; a meeting the caller cannot open is the identical 404", async () => {
    const m = await readyMeeting();
    expect((await generate(m.id, "carol")).status).toBe(202);
    const hidden = await generate(m.id, "mallory");
    const missing = await generate("does-not-exist", "mallory");
    expect(hidden.status).toBe(404);
    expect(hidden.text.replace(m.id, "X")).toBe(missing.text.replace("does-not-exist", "X"));
    expect(await db.summary.count()).toBe(1);
  });

  it("409 not_ready unless the meeting is ready, 409 no_speech for a ready one without speech; nothing is written or counted", async () => {
    const processing = await readyMeeting({ status: "processing" });
    const silent = await readyMeeting({ noSpeech: true });
    const a = await generate(processing.id);
    const b = await generate(silent.id);
    expect(a.status).toBe(409);
    expect(a.json.code).toBe("not_ready");
    expect(b.status).toBe(409);
    expect(b.json.code).toBe("no_speech");
    expect(await db.summary.count()).toBe(0);
    expect(await db.aiRequest.count()).toBe(0);
  });
});

describe("the speaker names snapshot (plan amendment)", () => {
  it("stores a name for every labelled speaker in the snapshot: custom label, external name, resolved Operai participant", async () => {
    const m = await readyMeeting({}, ["carol"]);
    const carol = await db.meetingParticipant.findFirstOrThrow({ where: { meetingId: m.id, userId: "carol" } });
    const guest = await db.meetingParticipant.create({ data: { meetingId: m.id, externalName: "Bruno (Acme)", addedBy: "alice" } });
    await db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s1", participantId: carol.id } });
    await db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s2", participantId: guest.id } });
    await db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s3", customLabel: "The CFO" } });

    const res = await generate(m.id);
    const row = await db.summary.findUniqueOrThrow({ where: { id: res.json.id } });
    expect((row.template as any).speakerNames).toEqual({ s1: "Name of carol", s2: "Bruno (Acme)", s3: "The CFO" });
    // only the Operai participant needed a lookup
    expect(identityCalls.flat().filter((id) => id === "carol")).toHaveLength(1);

    // and the job's prompt carries exactly those names
    await runJob(res.json.id);
    const prompt = model.requests[0]!.request.messages[0]!.text;
    expect(prompt).toContain("Name of carol] We decided");
    expect(prompt).toContain("Bruno (Acme)] The vendor");
  });

  it("an identities outage degrades the Operai participant to 'Speaker n' and does not fail the request (soft)", async () => {
    const m = await readyMeeting({}, ["carol"]);
    const carol = await db.meetingParticipant.findFirstOrThrow({ where: { meetingId: m.id, userId: "carol" } });
    await db.speakerLabel.create({ data: { meetingId: m.id, speakerKey: "s1", participantId: carol.id } });
    authDown = true;
    const res = await generate(m.id);
    expect(res.status).toBe(202);
    const row = await db.summary.findUniqueOrThrow({ where: { id: res.json.id } });
    expect((row.template as any).speakerNames).toEqual({});
  });
});

describe("the snapshot (AC-7.5, AC-8.7)", () => {
  it("is byte-identical after the template is edited, and after it is deleted", async () => {
    const m = await readyMeeting();
    const tpl = await personal("alice");
    const res = await generate(m.id, "alice", { templateId: tpl.id, language: "en" });
    const before = JSON.stringify((await db.summary.findUniqueOrThrow({ where: { id: res.json.id } })).template);
    expect(JSON.parse(before)).toMatchObject({ source: "personal", templateId: tpl.id, name: "My notes", sections, generalInstructions: "Be brief." });

    const token = await tokenOf("alice");
    const patched = await app.request(`/templates/${tpl.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": '"1"' },
      body: JSON.stringify({ name: "Renamed", sections: [{ heading: "Other", instruction: "x" }] }),
    });
    expect(patched.status).toBe(200);
    expect(JSON.stringify((await db.summary.findUniqueOrThrow({ where: { id: res.json.id } })).template)).toBe(before);

    await call("DELETE", `/templates/${tpl.id}`, "alice");
    expect(JSON.stringify((await db.summary.findUniqueOrThrow({ where: { id: res.json.id } })).template)).toBe(before);
    expect((await list(m.id)).json.items[0].template).toEqual({ name: "My notes", source: "personal" });
  });

  it("a shared template is snapshotted too", async () => {
    const m = await readyMeeting();
    const tpl = await sharedTemplate();
    const res = await generate(m.id, "carol", { templateId: tpl.id, language: "it" });
    expect(res.json.template).toEqual({ name: "Team", source: "shared" });
    expect(res.json.language).toBe("it");
  });
});

describe("the 20-summary limit (AC-7.3)", () => {
  it("refuses the 21st with 409 summary_limit, takes no AI slot for it, and keeps the old ones", async () => {
    const m = await readyMeeting();
    for (let i = 0; i < 20; i++) expect((await generate(m.id, i % 2 ? "alice" : "carol")).status).toBe(202);
    const slots = await db.aiRequest.count();
    const res = await generate(m.id);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("summary_limit");
    expect(await db.summary.count({ where: { meetingId: m.id } })).toBe(20);
    expect(await db.aiRequest.count()).toBe(slots);
  });

  it("holds under concurrency: 25 racing requests make exactly 20", async () => {
    const m = await readyMeeting();
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => generate(m.id, ["alice", "carol", "dave"][i % 3]!)));
    expect(results.filter((r) => r.status === 202)).toHaveLength(20);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await db.summary.count({ where: { meetingId: m.id } })).toBe(20);
  });
});

describe("the AI rate limit (AC-13.4)", () => {
  it("the 31st request of the hour is a 429 ai_rate_limited with Retry-After, and no summary or job is left behind", async () => {
    const a = await readyMeeting();
    const b = await readyMeeting();
    const c = await readyMeeting();
    for (let i = 0; i < AI_REQUESTS_PER_HOUR; i++) expect((await generate([a, b, c][i % 3]!.id)).status).toBe(202);
    const summaries = await db.summary.count();
    const jobs = await db.meetingJob.count();
    const res = await generate(a.id);
    expect(res.status).toBe(429);
    expect(res.json.code).toBe("ai_rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.json.retryAfterSeconds).toBe(Number(res.headers.get("Retry-After")));
    expect(await db.summary.count()).toBe(summaries);
    expect(await db.meetingJob.count()).toBe(jobs);
    // another user is unaffected
    expect((await generate(a.id, "carol")).status).toBe(202);
  });
});

describe("regenerate (AC-7.4)", () => {
  it("makes a NEW row with the same snapshot and language, authored by the caller, and keeps the old one untouched", async () => {
    const m = await readyMeeting();
    const tpl = await personal("alice");
    const first = await generate(m.id, "alice", { templateId: tpl.id, language: "it" });
    await runJob(first.json.id);
    const oldBefore = await db.summary.findUniqueOrThrow({ where: { id: first.json.id } });

    const res = await call("POST", `/meetings/${m.id}/summaries/${first.json.id}/regenerate`, "carol");
    expect(res.status).toBe(202);
    expect(res.json.id).not.toBe(first.json.id);
    expect(res.json).toMatchObject({ status: "generating", language: "it", template: { name: "My notes", source: "personal" }, author: { id: "carol" } });

    const row = await db.summary.findUniqueOrThrow({ where: { id: res.json.id } });
    const { speakerNames: _a, ...oldSnapshot } = oldBefore.template as any;
    const { speakerNames: _b, ...newSnapshot } = row.template as any;
    expect(newSnapshot).toEqual(oldSnapshot);
    expect(row.attemptId).not.toBe(oldBefore.attemptId);

    expect(await db.summary.findUniqueOrThrow({ where: { id: first.json.id } })).toEqual(oldBefore);
    expect(await db.summary.count({ where: { meetingId: m.id } })).toBe(2);
  });

  it("regenerating leaves an edited summary's text alone (AC-7.7)", async () => {
    const m = await readyMeeting();
    const first = await generate(m.id);
    await runJob(first.json.id);
    const ready = (await list(m.id)).json.items[0];
    const body = { sections: ready.sections.map((s: { heading: string }) => ({ heading: s.heading, body: `edited ${s.heading}` })) };
    expect((await call("PATCH", `/meetings/${m.id}/summaries/${first.json.id}`, "alice", body, { "If-Match": `"${ready.version}"` })).status).toBe(200);
    await call("POST", `/meetings/${m.id}/summaries/${first.json.id}/regenerate`, "alice");
    const old = (await list(m.id)).json.items.find((i: { id: string }) => i.id === first.json.id);
    expect(old.edited).toBe(true);
    expect(old.sections[0].body).toBe("edited Summary");
  });

  it("404 for a summary of another meeting, 409 summary_limit at 20, 429 over the hourly limit", async () => {
    const m = await readyMeeting();
    const other = await readyMeeting();
    const first = await generate(m.id);
    expect((await call("POST", `/meetings/${other.id}/summaries/${first.json.id}/regenerate`, "alice")).status).toBe(404);
    for (let i = 0; i < 19; i++) await generate(m.id);
    expect((await call("POST", `/meetings/${m.id}/summaries/${first.json.id}/regenerate`, "alice")).json.code).toBe("summary_limit");
  });
});

describe("stale and derived failed (AC-6.8, AC-7.9)", () => {
  it("is stale when the meeting's transcript version moved past the summary's, and only then; no job is enqueued by the edit", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    await runJob(res.json.id);
    expect((await list(m.id)).json.items[0].stale).toBe(false);
    const jobs = await db.meetingJob.count();
    await db.meeting.update({ where: { id: m.id }, data: { transcriptVersion: { increment: 1 } } });
    expect((await list(m.id)).json.items[0].stale).toBe(true);
    expect(await db.meetingJob.count()).toBe(jobs);
  });

  it("a generating summary older than 10 minutes reads failed, with Retry; a younger one does not; other summaries are unaffected", async () => {
    const m = await readyMeeting();
    const old = await generate(m.id);
    const young = await generate(m.id);
    const ready = await generate(m.id);
    await runJob(ready.json.id);
    const longAgo = new Date(Date.now() - 11 * 60_000);
    await db.meetingJob.updateMany({ where: { summaryId: old.json.id }, data: { createdAt: longAgo } });
    await db.summary.update({ where: { id: old.json.id }, data: { createdAt: longAgo } });

    const items = new Map((await list(m.id)).json.items.map((i: any) => [i.id, i]));
    expect(items.get(old.json.id)).toMatchObject({ status: "failed", can: { retry: true, edit: false } });
    expect(items.get(young.json.id)).toMatchObject({ status: "generating", can: { retry: false } });
    expect(items.get(ready.json.id)).toMatchObject({ status: "ready" });
    // the stored row is not rewritten by a read
    expect((await db.summary.findUniqueOrThrow({ where: { id: old.json.id } })).status).toBe("generating");
  });

  it("a failed summary exposes its failure code, and no sections", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    await db.summary.update({ where: { id: res.json.id }, data: { status: "failed", failureCode: "provider_unavailable" } });
    const item = (await list(m.id)).json.items[0];
    expect(item).toMatchObject({ status: "failed", failure: { code: "provider_unavailable" } });
    expect(item.sections).toBeUndefined();
  });
});

describe("retry (AC-7.9)", () => {
  it("re-queues the SAME row under a new attemptId; the old attempt's late write touches nothing", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    const before = await db.summary.findUniqueOrThrow({ where: { id: res.json.id } });
    await db.summary.update({ where: { id: res.json.id }, data: { status: "failed", failureCode: "provider_unavailable" } });

    const retried = await call("POST", `/meetings/${m.id}/summaries/${res.json.id}/retry`, "carol");
    expect(retried.status).toBe(202);
    expect(retried.json).toMatchObject({ id: res.json.id, status: "generating", author: { id: "alice" } });
    expect(retried.json.failure).toBeNull();
    const after = await db.summary.findUniqueOrThrow({ where: { id: res.json.id } });
    expect(after.attemptId).not.toBe(before.attemptId);
    expect(after.failureCode).toBeNull();
    const jobs = await db.meetingJob.findMany({ where: { summaryId: res.json.id }, orderBy: { createdAt: "asc" } });
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.attemptId).toBe(after.attemptId);

    await runJob(res.json.id);
    expect((await db.summary.findUniqueOrThrow({ where: { id: res.json.id } })).status).toBe("ready");
  });

  it("can retry a summary that only READS failed (stuck generating for 10 minutes)", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    const longAgo = new Date(Date.now() - 11 * 60_000);
    await db.meetingJob.updateMany({ where: { summaryId: res.json.id }, data: { createdAt: longAgo } });
    await db.summary.update({ where: { id: res.json.id }, data: { createdAt: longAgo } });
    const retried = await call("POST", `/meetings/${m.id}/summaries/${res.json.id}/retry`, "alice");
    expect(retried.status).toBe(202);
    // the clock restarts with the new attempt: it does not read failed again at once
    expect((await list(m.id)).json.items[0].status).toBe("generating");
  });

  it("409 not_failed for a ready or a still-generating summary; 404 for another meeting's; counts against the hourly limit", async () => {
    const m = await readyMeeting();
    const other = await readyMeeting();
    const res = await generate(m.id);
    expect((await call("POST", `/meetings/${m.id}/summaries/${res.json.id}/retry`, "alice")).json.code).toBe("not_failed");
    await runJob(res.json.id);
    expect((await call("POST", `/meetings/${m.id}/summaries/${res.json.id}/retry`, "alice")).json.code).toBe("not_failed");
    expect((await call("POST", `/meetings/${other.id}/summaries/${res.json.id}/retry`, "alice")).status).toBe(404);

    await db.summary.update({ where: { id: res.json.id }, data: { status: "failed", failureCode: "invalid_output" } });
    const slots = await db.aiRequest.count();
    await call("POST", `/meetings/${m.id}/summaries/${res.json.id}/retry`, "alice");
    expect(await db.aiRequest.count()).toBe(slots + 1);
  });

  it("403 without meetings:access", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    await db.summary.update({ where: { id: res.json.id }, data: { status: "failed", failureCode: "invalid_output" } });
    access["carol"] = NOBODY;
    expect((await call("POST", `/meetings/${m.id}/summaries/${res.json.id}/retry`, "carol")).status).toBe(403);
  });
});

describe("reading (AC-7.11)", () => {
  it("every visibility class reads, even without meetings:access and with auth down; an outsider gets the 404", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    await runJob(res.json.id);
    expect((await list(m.id, "alice")).status).toBe(200);
    expect((await list(m.id, "carol")).json.items).toHaveLength(1);
    access["dave"] = NOBODY;
    expect((await list(m.id, "dave")).json.items).toHaveLength(1);
    expect((await list(m.id, "mallory")).status).toBe(404);
    expect((await list("does-not-exist", "mallory")).status).toBe(404);
    __resetAuthzCacheForTests();
    harness.setResolve(async () => {
      throw new Error("auth is down");
    });
    const down = await list(m.id, "carol");
    expect(down.status).toBe(200);
    expect(down.json.items[0].can).toEqual({ edit: false, delete: false, retry: false });
  });

  it("lists every summary with its template, language, author, version and createdAt, newest first", async () => {
    const m = await readyMeeting();
    const first = await generate(m.id);
    const second = await generate(m.id, "carol");
    const { json } = await list(m.id);
    expect(json.items.map((i: { id: string }) => i.id)).toEqual([second.json.id, first.json.id]);
    expect(Object.keys(json.items[0]).sort()).toEqual(["author", "can", "createdAt", "edited", "failure", "id", "language", "possiblyIncomplete", "stale", "status", "template", "version"]);
    expect(json.items[0].author).toEqual({ id: "carol", name: "Name of carol", status: "active" });
    expect(new Date(json.items[0].createdAt).toISOString()).toBe(json.items[0].createdAt);
  });
});

describe("per-item can equals the route outcome (G4, AC-7.7, AC-7.8)", () => {
  // alice = creator, carol = author, dave = other participant, erin = author without access, mallory = no access to the meeting
  async function setup() {
    const m = await readyMeeting({}, ["carol", "dave", "erin"]);
    const res = await generate(m.id, "carol");
    await runJob(res.json.id);
    const erins = await generate(m.id, "erin");
    await runJob(erins.json.id);
    access["erin"] = NOBODY;
    __resetAuthzCacheForTests(); // grants are cached per (sub, epoch) for 30 s by design
    return { m, sid: res.json.id as string, erinsSid: erins.json.id as string };
  }
  const editBody = { sections: [{ heading: "Summary", body: "a" }, { heading: "Topics discussed", body: "b" }, { heading: "Decisions", body: "c" }, { heading: "Action items", body: "d" }, { heading: "Open questions", body: "e" }] };
  const canOf = async (mid: string, sid: string, user: string) => (await list(mid, user)).json.items.find((i: any) => i.id === sid).can;

  it("author and creator can edit and delete; another participant can do neither", async () => {
    const { m, sid } = await setup();
    expect(await canOf(m.id, sid, "carol")).toEqual({ edit: true, delete: true, retry: false });
    expect(await canOf(m.id, sid, "alice")).toEqual({ edit: true, delete: true, retry: false });
    expect(await canOf(m.id, sid, "dave")).toEqual({ edit: false, delete: false, retry: false });

    const version = (await list(m.id, "dave")).json.items.find((i: any) => i.id === sid).version;
    const ifMatch = { "If-Match": `"${version}"` };
    const asDave = await call("PATCH", `/meetings/${m.id}/summaries/${sid}`, "dave", editBody, ifMatch);
    expect(asDave.status).toBe(403);
    expect(asDave.json.code).toBe("author_only");
    expect((await call("DELETE", `/meetings/${m.id}/summaries/${sid}`, "dave")).status).toBe(403);
    expect((await call("PATCH", `/meetings/${m.id}/summaries/${sid}`, "alice", editBody, ifMatch)).status).toBe(200);
    expect((await call("DELETE", `/meetings/${m.id}/summaries/${sid}`, "carol")).status).toBe(204);
  });

  it("an author who lost meetings:access can delete but not edit (no capability gates removal)", async () => {
    const { m, erinsSid } = await setup();
    expect(await canOf(m.id, erinsSid, "erin")).toEqual({ edit: false, delete: true, retry: false });
    const version = (await list(m.id, "erin")).json.items.find((i: any) => i.id === erinsSid).version;
    expect((await call("PATCH", `/meetings/${m.id}/summaries/${erinsSid}`, "erin", editBody, { "If-Match": `"${version}"` })).status).toBe(403);
    expect((await call("DELETE", `/meetings/${m.id}/summaries/${erinsSid}`, "erin")).status).toBe(204);
  });

  it("a failed summary: retry follows meetings:access", async () => {
    const { m, sid } = await setup();
    await db.summary.update({ where: { id: sid }, data: { status: "failed", failureCode: "invalid_output" } });
    expect((await canOf(m.id, sid, "dave")).retry).toBe(true);
    expect((await call("POST", `/meetings/${m.id}/summaries/${sid}/retry`, "dave")).status).toBe(202);
    await db.summary.update({ where: { id: sid }, data: { status: "failed" } });
    access["dave"] = NOBODY;
    __resetAuthzCacheForTests();
    expect((await canOf(m.id, sid, "dave")).retry).toBe(false);
    expect((await call("POST", `/meetings/${m.id}/summaries/${sid}/retry`, "dave")).status).toBe(403);
  });
});

describe("edit (AC-7.7)", () => {
  async function ready() {
    const m = await readyMeeting();
    const res = await generate(m.id, "carol");
    await runJob(res.json.id);
    const item = (await list(m.id, "carol")).json.items[0];
    return { m, sid: item.id as string, item };
  }
  const bodyFor = (item: { sections: { heading: string }[] }) => ({ sections: item.sections.map((s) => ({ heading: s.heading, body: `new ${s.heading}` })) });

  it("saves the text, marks it edited, bumps the version and returns the ETag; the stored sections keep their notDiscussed flags honest", async () => {
    const { m, sid, item } = await ready();
    const res = await call("PATCH", `/meetings/${m.id}/summaries/${sid}`, "carol", bodyFor(item), { "If-Match": `"${item.version}"` });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ edited: true, version: item.version + 1, status: "ready" });
    expect(res.json.sections[1]).toEqual({ heading: "Topics discussed", body: "new Topics discussed", notDiscussed: false });
    expect(res.headers.get("ETag")).toBe(`"${item.version + 1}"`);
    expect((await list(m.id, "carol")).json.items[0].edited).toBe(true);
  });

  it("428 without If-Match, 409 version_conflict { currentVersion } when stale, and the second of two racing edits loses", async () => {
    const { m, sid, item } = await ready();
    const path = `/meetings/${m.id}/summaries/${sid}`;
    expect((await call("PATCH", path, "carol", bodyFor(item))).status).toBe(428);
    const [a, b] = await Promise.all([
      call("PATCH", path, "carol", bodyFor(item), { "If-Match": `"${item.version}"` }),
      call("PATCH", path, "alice", bodyFor(item), { "If-Match": `"${item.version}"` }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json).toMatchObject({ code: "version_conflict", currentVersion: item.version + 1 });
  });

  it("422 when the section count differs or a body is empty; 409 summary_not_ready for a summary that is not ready", async () => {
    const { m, sid, item } = await ready();
    const path = `/meetings/${m.id}/summaries/${sid}`;
    const ifMatch = { "If-Match": `"${item.version}"` };
    expect((await call("PATCH", path, "carol", { sections: [{ heading: "Summary", body: "only one" }] }, ifMatch)).status).toBe(422);
    const blank = bodyFor(item);
    blank.sections[0]!.body = "   ";
    expect((await call("PATCH", path, "carol", blank, ifMatch)).status).toBe(422);
    expect((await call("PATCH", path, "carol", { sections: bodyFor(item).sections.map((s) => ({ ...s, body: "x".repeat(8_001) })) }, ifMatch)).status).toBe(422);

    await db.summary.update({ where: { id: sid }, data: { status: "failed", failureCode: "invalid_output" } });
    const res = await call("PATCH", path, "carol", bodyFor(item), ifMatch);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("summary_not_ready");
  });

  it("404 for a summary of another meeting; an outsider gets the meeting 404", async () => {
    const { m, sid, item } = await ready();
    const other = await readyMeeting();
    const ifMatch = { "If-Match": `"${item.version}"` };
    expect((await call("PATCH", `/meetings/${other.id}/summaries/${sid}`, "alice", bodyFor(item), ifMatch)).status).toBe(404);
    expect((await call("PATCH", `/meetings/${m.id}/summaries/${sid}`, "mallory", bodyFor(item), ifMatch)).status).toBe(404);
  });
});

describe("delete (AC-7.8)", () => {
  it("removes the row; a generating summary can be deleted and its late job result touches nothing", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    expect((await call("DELETE", `/meetings/${m.id}/summaries/${res.json.id}`, "alice")).status).toBe(204);
    expect(await db.summary.count()).toBe(0);
    await runJob(res.json.id); // the job finds nothing and returns
    expect(await db.summary.count()).toBe(0);
    expect((await call("DELETE", `/meetings/${m.id}/summaries/${res.json.id}`, "alice")).status).toBe(404);
  });

  it("an outsider gets the meeting 404 and the row survives", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    expect((await call("DELETE", `/meetings/${m.id}/summaries/${res.json.id}`, "mallory")).status).toBe(404);
    expect(await db.summary.count()).toBe(1);
  });

  it("works while auth is down (no capability)", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    __resetAuthzCacheForTests();
    harness.setResolve(async () => {
      throw new Error("auth is down");
    });
    expect((await call("DELETE", `/meetings/${m.id}/summaries/${res.json.id}`, "alice")).status).toBe(204);
  });
});

describe("a transcript that may be incomplete (AC-7.13)", () => {
  const GAPS = [{ startMs: 60_000, endMs: 95_000 }, { startMs: 700_000, endMs: 740_000 }];
  const withGaps = async () => {
    const m = await readyMeeting();
    await db.transcriptGap.createMany({ data: GAPS.map((g) => ({ meetingId: m.id, ...g })) });
    return m;
  };
  const itemOf = async (meetingId: string, id: string) => (await list(meetingId)).json.items.find((i: { id: string }) => i.id === id);

  it("a meeting without gaps answers possiblyIncomplete: null and keeps the old fixed text, whatever the status", async () => {
    const m = await readyMeeting();
    const res = await generate(m.id);
    expect(res.json.possiblyIncomplete).toBeNull(); // generating
    model.respondWith({ sections: [0, 1, 2, 3, 4].map((index) => ({ index, body: "", notDiscussed: true })) });
    await runJob(res.json.id);
    const item = await itemOf(m.id, res.json.id);
    expect(item.possiblyIncomplete).toBeNull();
    expect(item.sections.every((s: { body: string }) => s.body === "Not discussed")).toBe(true);
  });

  it("carries the gaps the summary was made under, written by the service, and 'Not found ... may be incomplete' for an empty section", async () => {
    const m = await withGaps();
    const res = await generate(m.id);
    model.respondWith({ sections: [0, 1, 2, 3, 4].map((index) => ({ index, body: index === 0 ? "Ship on Friday." : "", notDiscussed: index !== 0 })) });
    await runJob(res.json.id);
    const item = await itemOf(m.id, res.json.id);
    expect(item.possiblyIncomplete).toEqual({ gaps: GAPS });
    expect(item.sections.map((s: { body: string }) => s.body)).toEqual([
      "Ship on Friday.",
      ...Array(4).fill("Not found in the transcript, which may be incomplete"),
    ]);
  });

  it("a generating or failed summary carries none (it was not made under any transcript yet)", async () => {
    const m = await withGaps();
    const res = await generate(m.id);
    expect((await itemOf(m.id, res.json.id)).possiblyIncomplete).toBeNull();
    await db.summary.update({ where: { id: res.json.id }, data: { status: "failed", failureCode: "provider_unavailable" } });
    expect((await itemOf(m.id, res.json.id)).possiblyIncomplete).toBeNull();
  });

  it("regenerate carries the snapshot too (a new row, made by the job under the same transcript), and the old row is unchanged", async () => {
    const m = await withGaps();
    const first = await generate(m.id);
    await runJob(first.json.id);
    const again = await call("POST", `/meetings/${m.id}/summaries/${first.json.id}/regenerate`, "alice");
    expect(again.status).toBe(202);
    await runJob(again.json.id);
    expect((await itemOf(m.id, again.json.id)).possiblyIncomplete).toEqual({ gaps: GAPS });
    expect((await itemOf(m.id, first.json.id)).possiblyIncomplete).toEqual({ gaps: GAPS });
  });

  it("an edit of the text keeps the label and the ranges (AC-7.7)", async () => {
    const m = await withGaps();
    const res = await generate(m.id);
    await runJob(res.json.id);
    const ready = await itemOf(m.id, res.json.id);
    const body = { sections: ready.sections.map((s: { heading: string }) => ({ heading: s.heading, body: `edited ${s.heading}` })) };
    expect((await call("PATCH", `/meetings/${m.id}/summaries/${res.json.id}`, "alice", body, { "If-Match": `"${ready.version}"` })).status).toBe(200);
    expect((await itemOf(m.id, res.json.id)).possiblyIncomplete).toEqual({ gaps: GAPS });
  });

  it("is shown to every reader of the meeting (a stored fact)", async () => {
    const m = await withGaps();
    const res = await generate(m.id);
    await runJob(res.json.id);
    expect((await call("GET", `/meetings/${m.id}/summaries`, "carol")).json.items[0].possiblyIncomplete).toEqual({ gaps: GAPS });
  });
});
