/**
 * `POST /system/meeting-hours/v1/notices` over the ASSEMBLED app and the real database (specs/20261112-meeting-hours T7 —
 * AC-1.6, AC-1.7, AC-4.1, plan R8; plan § API contracts "hours-api — `POST /system/meeting-hours/v1/notices`", § Applying a
 * notice "mounted before the user `jwtMiddleware`", § Security; ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older).
 *
 * The route is hours-api's first that accepts a service credential. What is proved here is the SEAM, not the rules of
 * `apply()` (`apply.test.ts` drives those directly): that a real service JWT of `system:meetings-api` with the scope reaches
 * `apply()` through the assembled app (it would be a 401 if the router sat below the user session guard, R8), that nothing
 * else reaches it, that the credential is decided before the body, that the body is the strict wire, and that a failure is a
 * 500 that wrote nothing.
 *
 * The system guard is the REAL one (`systemAuth.middleware.ts`); the harness only supplies the key set it verifies against
 * and the tokens that key set accepts (`test-support/testAuth.ts` `signServiceToken`, `world.ts`). Time is fixed at
 * 2026-11-13 10:00Z; the default meeting began 2026-11-12 10:00 in Zurich and lasted an hour.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { SignJWT, generateKeyPair } from "jose";
import { MAX_REQUEST_BODY_BYTES, PERSONAS, app, call, db, resetWorld } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { setupTestAuth, TEST_AUDIENCE, TEST_ISSUER, TEST_KID, TEST_SERVICE_AUDIENCE } from "../test-support/testAuth";
import { __setClockForTests } from "../entries/today";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const PATH = "/system/meeting-hours/v1/notices";
const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;
const M = "m1";
const HOUR = 3_600_000;

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** The facts of a meeting: Alice created it, Bob took part, it began 2026-11-12 10:00 Zurich and lasted an hour. */
const facts = (over: Record<string, unknown> = {}) => ({
  startsAt: "2026-11-12T09:00:00Z",
  durationMs: HOUR,
  creatorId: ALICE,
  participantIds: [BOB],
  ...over,
});
const notice = (seq: number, state: Record<string, unknown> | null = facts(), meetingId = M) => ({
  noticeId: `notice-${meetingId}-${seq}`,
  meeting: { id: meetingId, seq, facts: state },
});

const harness = setupTestAuth();

/** What meetings-api sends: the notice as JSON, behind a Bearer service token. */
const send = async (body: unknown, token?: string | null) => {
  const bearer = token === undefined ? await harness.signServiceToken() : token;
  return call("POST", PATH, { as: null, ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}), body });
};

/** Every automatic entry of a meeting, as what the tests compare. */
const automatic = async (meetingId = M) => {
  const rows = await db.timeEntry.findMany({ where: { sourceMeetingId: meetingId }, orderBy: { userId: "asc" } });
  return rows.map((row) => ({ userId: row.userId, day: row.day.toISOString().slice(0, 10), minutes: row.minutes, followsMeeting: row.followsMeeting }));
};

describe("a notice from meetings-api with its credential is applied (AC-1.6, plan R8)", () => {
  it("answers 200 { applied: true } to a real service JWT of system:meetings-api, and the meeting's creator and participant each get their entry", async () => {
    const res = await send(notice(1));

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ applied: true });
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 60, followsMeeting: true },
      { userId: BOB, day: "2026-11-12", minutes: 60, followsMeeting: true },
    ]);
  });
});

describe("what the answer says, and what applying does through the route (AC-4.2, AC-3.4, AC-2.6)", () => {
  it("answers `applied` and nothing else: no counts, no ids, no person", async () => {
    const res = await send(notice(1));

    expect(Object.keys(res.json)).toEqual(["applied"]);
    expect(res.text).not.toContain(ALICE);
    expect(res.text).not.toContain(BOB);
  });

  it("says applied: false for a version older than the one applied, and changes nothing", async () => {
    expect((await send(notice(3))).json).toEqual({ applied: true });
    const before = JSON.stringify(await db.timeEntry.findMany({ orderBy: { userId: "asc" } }));

    const older = await send(notice(2, facts({ startsAt: "2026-11-10T09:00:00Z", durationMs: 3 * HOUR, participantIds: [] })));

    expect(older.status).toBe(200);
    expect(older.json).toEqual({ applied: false });
    expect(JSON.stringify(await db.timeEntry.findMany({ orderBy: { userId: "asc" } }))).toBe(before);
    expect((await db.meetingHoursMeeting.findUnique({ where: { meetingId: M } }))?.seq).toBe(3);
  });

  it("applies the same notice twice with the same answer and still one entry per person", async () => {
    const first = await send(notice(1));
    const again = await send(notice(1));

    expect([first.status, first.json, again.status, again.json]).toEqual([200, { applied: true }, 200, { applied: true }]);
    expect(await automatic()).toHaveLength(2);
  });

  it("removes the untouched entries of a meeting that no longer exists (`facts: null`)", async () => {
    await send(notice(1));

    const gone = await send(notice(2, null));

    expect(gone.json).toEqual({ applied: true });
    expect(await automatic()).toEqual([]);
  });

  it("calls nobody: applying asks no owner and notifies no one, `auth` included (AC-2.6)", async () => {
    await send(notice(1));
    await send(notice(2, null));

    expect(hosts.calls).toEqual([]);
  });
});

// ─── Who may send (AC-1.6, AC-1.7) ───────────────────────────────────────────

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Every credential that must NOT reach `apply()`, as the `Authorization` header value (null: no header at all). */
async function refusedCredentials(): Promise<Array<[string, string | null]>> {
  const service = (options: Parameters<typeof harness.signServiceToken>[0] = {}) => harness.signServiceToken(options);
  const user = (name: keyof typeof PERSONAS, audience?: string) =>
    harness.signToken({ sub: PERSONAS[name].sub, email: `${name}@welld.test`, ...(audience !== undefined ? { audience } : {}) });
  const { privateKey } = await generateKeyPair("RS256");
  const forged = await new SignJWT({ scope: "meeting-hours-notices.send" })
    .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
    .setIssuer(TEST_ISSUER)
    .setSubject("system:meetings-api")
    .setAudience(TEST_SERVICE_AUDIENCE)
    .setExpirationTime("5m")
    .sign(privateKey);
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "system:meetings-api", scope: "meeting-hours-notices.send", iss: TEST_ISSUER, aud: TEST_SERVICE_AUDIENCE, exp: 4102444800 })}.`;
  const valid = await service();
  return [
    ["no Authorization header", null],
    ["an empty Bearer", "Bearer "],
    ["a Bearer that is not a JWT", "Bearer not-a-jwt"],
    ["a valid service token under the Basic scheme", `Basic ${valid}`],
    ["a valid service token with no scheme", valid],
    // A person, whatever they hold: admin, a holder of time-entry:read-all, an ordinary employee (AC-1.7).
    ["a user JWT of an admin", `Bearer ${await user("admin")}`],
    ["a user JWT of a holder of time-entry:read-all", `Bearer ${await user("holder")}`],
    ["a user JWT of an employee", `Bearer ${await user("alice")}`],
    ["a user JWT of an employee, with the SERVICE audience", `Bearer ${await user("alice", TEST_SERVICE_AUDIENCE)}`],
    ["meetings-api's sub and scope, but the USER audience", `Bearer ${await service({ audience: TEST_AUDIENCE })}`],
    // Another service client holding the very scope: the allowlist names one `sub` (AC-1.6).
    ["system:crm-api holding the scope", `Bearer ${await service({ sub: "system:crm-api" })}`],
    ["system:activities-api holding the scope", `Bearer ${await service({ sub: "system:activities-api" })}`],
    ["system:hours-api itself holding the scope", `Bearer ${await service({ sub: "system:hours-api" })}`],
    ["a sub that is not a service principal", `Bearer ${await service({ sub: "meetings-api" })}`],
    ["an empty service sub", `Bearer ${await service({ sub: "system:" })}`],
    ["meetings-api without the scope claim", `Bearer ${await service({ scope: null })}`],
    ["meetings-api with another scope", `Bearer ${await service({ scope: "notifications.push" })}`],
    ["meetings-api with the scope of the hosts route", `Bearer ${await service({ scope: "meetings.hosts.read" })}`],
    ["meetings-api with a scope that only contains it", `Bearer ${await service({ scope: "meeting-hours-notices.send.extra" })}`],
    ["another audience", `Bearer ${await service({ audience: "someone-else" })}`],
    ["another issuer", `Bearer ${await service({ issuer: "http://evil.test" })}`],
    ["an expired token", `Bearer ${await service({ expiresIn: "-1h" })}`],
    ["a token signed by a key auth does not publish", `Bearer ${forged}`],
    ["an unsigned token (alg none)", `Bearer ${unsigned}`],
  ];
}

describe("only system:meetings-api with the scope reaches apply(): every other credential is the one 401 (AC-1.6, AC-1.7)", () => {
  it("answers every refused credential with the same 401, byte for byte, and nothing was written or asked", async () => {
    const refusals: Array<[string, Awaited<ReturnType<typeof call>>]> = [];
    for (const [label, authorization] of await refusedCredentials()) {
      refusals.push([label, await call("POST", PATH, { as: null, ...(authorization !== null ? { headers: { Authorization: authorization } } : {}), body: notice(1) })]);
    }

    const reference = refusals[0]![1].text;
    expect(JSON.parse(reference)).toEqual({ type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, detail: "Valid credentials are required", instance: PATH });
    for (const [label, res] of refusals) {
      expect({ label, status: res.status, contentType: res.headers.get("content-type") }).toEqual({ label, status: 401, contentType: expect.stringContaining("json") });
      expect({ label, body: res.text }).toEqual({ label, body: reference });
    }
    // Refused at the gate: no entry, no applied version, no block, and nobody was asked (the guard verifies against the key set).
    expect(await db.timeEntry.count()).toBe(0);
    expect(await db.meetingHoursMeeting.count()).toBe(0);
    expect(await db.meetingHoursBlock.count()).toBe(0);
    expect(hosts.calls).toEqual([]);
  });

  it("is decided before the body: a bad credential with an unknown key, a title or text that is not JSON is a 401, never a 400", async () => {
    const withTitle = { ...notice(1), meeting: { ...notice(1).meeting, title: "Offer review" } };
    const reference = (await send(notice(1), null)).text;
    const stranger = await harness.signToken({ sub: PERSONAS.admin.sub, email: "admin@welld.test" });
    const cases: Array<[string | null, { body?: unknown; rawBody?: string }]> = [
      [null, { body: withTitle }],
      ["not-a-jwt", { body: withTitle }],
      [stranger, { rawBody: "{ not json" }],
      [stranger, { rawBody: "" }],
      [null, { body: notice(1, facts({ participantIds: Array.from({ length: 101 }, (_, i) => `p${i}`) })) }],
    ];
    for (const [token, options] of cases) {
      const res = await call("POST", PATH, { as: null, ...(token !== null ? { headers: { Authorization: `Bearer ${token}` } } : {}), ...options });
      expect(res.status).toBe(401);
      expect(res.text).toBe(reference);
    }
    expect(await db.timeEntry.count()).toBe(0);
  });

  it("opens no other door: the same path and credential on another method are refused, and nothing is served to a person", async () => {
    const token = await harness.signServiceToken();
    // No GET, PUT, PATCH or DELETE exists on the path, so they fall to the user session guard: a service token is no session.
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const res = await call(method, PATH, { as: null, headers: { Authorization: `Bearer ${token}` } });
      expect({ method, status: res.status }).toEqual({ method, status: 401 });
    }
    // ...and a person who IS signed in is told the path serves no such method (the app's 404), not that they lack a right.
    const person = await call("GET", PATH, { as: "admin" });
    expect(person.status).toBe(404);
  });
});

// ─── The body is the strict wire (AC-4.1) ────────────────────────────────────

/** Nothing the app stores about hours or meetings: an entry, an applied version, a block. */
const stored = async () => JSON.stringify([await db.timeEntry.count(), await db.meetingHoursMeeting.count(), await db.meetingHoursBlock.count()]);

describe("the body is the strict wire: what is not a member is refused, never ignored, and nothing is written (AC-4.1)", () => {
  const TITLE = "Offer review with ACME";
  const body = (over: { top?: Record<string, unknown>; meeting?: Record<string, unknown>; facts?: Record<string, unknown> | null }) => ({
    ...notice(1),
    ...over.top,
    meeting: { ...notice(1).meeting, ...over.meeting, ...(over.facts !== undefined ? { facts: over.facts === null ? null : facts(over.facts) } : {}) },
  });

  const REFUSED: Array<[string, unknown]> = [
    ["a title at the top", body({ top: { title: TITLE } })],
    ["a title on the meeting", body({ meeting: { title: TITLE } })],
    ["a title in the facts", body({ facts: { title: TITLE } })],
    ["external participants in the facts", body({ facts: { externalParticipants: ["Ada Lovelace"] } })],
    ["a host in the facts", body({ facts: { host: { app: "crm", entityType: "deal", entityId: "d1" } } })],
    ["a member nobody defined", body({ top: { anything: 1 } })],
    ["no noticeId", { meeting: notice(1).meeting }],
    ["no `facts`: it is `null` written out that means the meeting is gone", { noticeId: "n1", meeting: { id: M, seq: 1 } }],
    ["no meeting", { noticeId: "n1" }],
    ["an empty object", {}],
    ["a 101st participant", body({ facts: { participantIds: Array.from({ length: 101 }, (_, i) => `p${i}`) } })],
    ["a participant twice", body({ facts: { participantIds: [BOB, BOB] } })],
    ["a startsAt without an offset", body({ facts: { startsAt: "2026-11-12T10:00:00" } })],
    ["a startsAt that is a date only", body({ facts: { startsAt: "2026-11-12" } })],
    ["a negative duration", body({ facts: { durationMs: -1 } })],
    ["a fractional duration", body({ facts: { durationMs: 1.5 } })],
    ["seq 0", body({ meeting: { seq: 0 } })],
    ["a seq beyond a Postgres integer", body({ meeting: { seq: 2_147_483_648 } })],
    ["a meeting id of 65 characters", body({ meeting: { id: "m".repeat(65) } })],
    ["an empty creator id", body({ facts: { creatorId: "" } })],
    ["a number where the participants should be", body({ facts: { participantIds: 3 } })],
  ];

  for (const [label, payload] of REFUSED) {
    it(`refuses ${label} with 400 invalid_request`, async () => {
      const before = await stored();

      const res = await send(payload);

      expect({ status: res.status, code: res.json?.code }).toEqual({ status: 400, code: "invalid_request" });
      expect(typeof res.json.field).toBe("string");
      expect(await stored()).toBe(before);
    });
  }

  it("names the member it refused, never what was sent in it", async () => {
    const res = await send(body({ top: { title: TITLE }, facts: { startsAt: "next Tuesday after lunch" } }));

    expect(res.status).toBe(400);
    expect(res.text).not.toContain(TITLE);
    expect(res.text).not.toContain("next Tuesday after lunch");
    expect(res.json.errors.map((error: { field: string }) => error.field)).toContain("meeting.facts.startsAt");
  });

  it("refuses a body that is not JSON (400), or not declared as JSON (a 415 Problem, as every route of this API): it is never applied as `{}`", async () => {
    const token = await harness.signServiceToken();
    const headers = { Authorization: `Bearer ${token}` };
    const before = await stored();

    for (const rawBody of ["{ not json", "", "null", "[]"]) {
      const res = await call("POST", PATH, { as: null, headers, rawBody });
      expect({ rawBody, status: res.status, code: res.json?.code }).toEqual({ rawBody, status: 400, code: "invalid_request" });
    }
    // A valid notice declared as something else (`call` always declares JSON, so these go to the app directly), or not declared at all.
    // @hono/zod-openapi 1.x answers 415 for any media type but JSON, none declared included (src/lists/lists.test.ts pins the same).
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
      const res = await app.request(PATH, {
        method: "POST",
        headers: { ...headers, ...(contentType !== undefined ? { "Content-Type": contentType } : {}) },
        // Bytes, not a string: a string body makes the runtime declare `text/plain` itself, and "none" would not be none.
        body: new TextEncoder().encode(JSON.stringify(notice(1))),
      });
      expect({ contentType, status: res.status }).toEqual({ contentType, status: 415 });
    }
    expect(await stored()).toBe(before);
  });

  it("sits behind the service's body cap: an oversized body is a 413 before anything is read, and nothing is written", async () => {
    const res = await send(body({ facts: { participantIds: ["x".repeat(MAX_REQUEST_BODY_BYTES)] } }));

    expect(res.status).toBe(413);
    expect(await stored()).toBe(JSON.stringify([0, 0, 0]));
  });

  it("accepts the closed shape at its bounds (the other side of the refusals above): 100 participants, 64-character ids, seq 2147483647, a duration of 0 and of 2147483647", async () => {
    const participantIds = Array.from({ length: 100 }, (_, i) => `p${String(i).padStart(3, "0")}`.padEnd(64, "x"));

    expect((await send({ noticeId: "n".repeat(64), meeting: { id: "m".repeat(64), seq: 2_147_483_647, facts: facts({ durationMs: 0, creatorId: "c".repeat(64), participantIds }) } })).json).toEqual({ applied: true });
    expect((await send(notice(1, facts({ durationMs: 2_147_483_647 }), "m-max"))).json).toEqual({ applied: true });
    expect((await send(notice(1, facts({ durationMs: null }), "m-null"))).json).toEqual({ applied: true });
  });
});

// ─── A failure, and what is logged ───────────────────────────────────────────

/** What a call to a console method was given, as one line each: an object is its JSON. */
const lines = (calls: readonly unknown[][]): string[] => calls.map((args) => args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));

describe("a database failure is a 500 that left nothing behind, and the sender's retry applies the notice whole (AC-4.2)", () => {
  it("answers a generic 500, never the driver's words or a person (and the app logs the error's name and code only), writes nothing, and the same notice sent again is applied", async () => {
    // A database that refuses to insert one person: the failure comes after Alice's and Bob's entries were written in the same apply.
    await db.$executeRawUnsafe(`CREATE FUNCTION t7_refuse_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER t7_refuse_boom BEFORE INSERT ON time_entry FOR EACH ROW WHEN (NEW."userId" = 'user-boom') EXECUTE FUNCTION t7_refuse_boom()`);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    let logged: string[];
    let failed: Awaited<ReturnType<typeof send>>;
    let after: string;
    try {
      failed = await send(notice(1, facts({ participantIds: [BOB, "user-boom"] })));
      after = await stored();
    } finally {
      logged = [...lines(log.mock.calls), ...lines(error.mock.calls)];
      log.mockRestore();
      error.mockRestore();
      await db.$executeRawUnsafe(`DROP TRIGGER t7_refuse_boom ON time_entry`);
      await db.$executeRawUnsafe(`DROP FUNCTION t7_refuse_boom()`);
    }

    expect(failed.status).toBe(500);
    expect(failed.json).toMatchObject({ type: "https://httpstatuses.com/500", title: "Internal Server Error", status: 500, detail: "An unexpected error occurred", instance: PATH });
    // What the app itself says (`handleError`): one `[uncaught]` line, the error's name and code. Prisma's own error log (db.ts
    // `log: ["error"]`) is not the route's and is not asserted on: it is the same for every route of this service.
    const uncaught = logged.filter((line) => line.startsWith("[uncaught]"));
    expect(uncaught).toHaveLength(1);
    for (const text of [failed.text, ...uncaught]) {
      expect(text).not.toContain("refused by the test");
      expect(text).not.toContain("user-boom");
    }
    // The failure says nothing was applied: no `meeting_hours.applied` line, and no version, entry or block was kept.
    expect(logged.filter((line) => line.startsWith("meeting_hours.applied"))).toEqual([]);
    expect(after).toBe(JSON.stringify([0, 0, 0]));

    const retry = await send(notice(1, facts({ participantIds: [BOB, "user-boom"] })));
    expect(retry.json).toEqual({ applied: true });
    expect(await automatic()).toHaveLength(3);
    expect((await db.meetingHoursMeeting.findUnique({ where: { meetingId: M } }))?.seq).toBe(1);
  });
});

describe("what a call logs: the calling service and the numbers, never a person, a token, a title or a body (AC-4.1)", () => {
  it("logs who called and what was applied, for an accepted, a refused-body and a refused-credential call alike", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const token = await harness.signServiceToken();
    const stranger = await harness.signToken({ sub: PERSONAS.admin.sub, email: "admin@welld.test" });
    let logged: string[];
    try {
      await send(notice(1), token);
      await send({ ...notice(2), meeting: { ...notice(2).meeting, title: "Offer review with ACME" } }, token);
      await send(notice(3), stranger);
      await send(notice(3), null);
    } finally {
      logged = [...lines(log.mock.calls), ...lines(warn.mock.calls), ...lines(error.mock.calls)];
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }

    // The guard names the verified caller of each call it let through (the valid one and the one with a title), and nobody else.
    expect(logged.filter((line) => line.includes("caller="))).toEqual([`[system-auth] POST ${PATH} caller=system:meetings-api`, `[system-auth] POST ${PATH} caller=system:meetings-api`]);
    expect(logged.filter((line) => line.startsWith("meeting_hours.applied"))).toHaveLength(1);
    for (const line of logged) {
      for (const secret of [ALICE, BOB, token, stranger, "Offer review with ACME", "admin@welld.test"]) expect(line).not.toContain(secret);
    }
  });
});
