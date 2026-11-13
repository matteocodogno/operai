/**
 * Authorization matrix over the ASSEMBLED app (specs/029-time-tracking T20; AC-5.3, AC-1.6, AC-1.8,
 * AC-2.10, AC-3.2, AC-3.3, AC-4.2, AC-5.1, AC-5.2, AC-5.4; plan § API contracts, § Errors "Order of the
 * answers", ADR-0075, ADR-0088).
 *
 * hours-api asks `auth` for two permissions and nothing else is decided by who the caller is: a session is
 * all a person needs to record and read their own hours (AC-5.1), `time-entry:read-all` lets them LOOK at
 * everyone's, `time-list:manage` lets them write the lists. So the matrix is route x caller, where the callers
 * are told apart ONLY by what the fake `auth` says they hold (written out below as LITERALS taken from the
 * spec, never read from the code under test):
 *
 *   employee      no permission at all                         records and reads their own hours (AC-5.1)
 *   holder        `time-entry:read-all`                         reads everyone's; changes nobody's (AC-1.6)
 *   manager       `time-list:manage`                            writes the lists; reads nobody else's
 *   admin         the admin ROLE, neither permission granted    nothing here is decided by a role name (AC-3.3)
 *   adminGranted  the admin role with both default grants       lists and oversight, still never another's entry
 *
 * The route list is read from the app's own table: a route mounted without a classification here (public or
 * JWT) fails the inventory, a classified route that is not mounted fails it too, and one hiding behind method
 * `ALL` fails it. Every JWT route is then driven by every caller and refused, with and without a credential,
 * as the plan says. A refused write must change nothing (the tables are compared before and after), a request
 * that needs no decision of `auth` must not ask it, and what `auth` is asked it is asked AS THE CALLER.
 *
 * The JWT middleware is the harness's mock of the real one (same RS256, issuer and audience rules, so a
 * service credential is refused alike); the REAL middleware is proved in auth/jwt.middleware.test.ts.
 *
 * No cell may answer 501: the build-order seam of T14 is gone (plan R11) and an entry that needs an owner is
 * answered by the owner, which the owner suites (T15, T16) drive. Here every entry is on no entity, so no owner
 * is ever asked; the matrix asserts that too.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { SignJWT, generateKeyPair } from "jose";
import { PERSONAS, SEED, app, bearerOf, call, db, makeNoEntityEntry, resetWorld, type PersonaName } from "./test-support/world";
import { startHosts } from "./test-support/hosts";
import { setupTestAuth, TEST_AUDIENCE, TEST_ISSUER, TEST_KID, TEST_SERVICE_AUDIENCE } from "./test-support/testAuth";
import { __resetTimeListManageCacheForTests } from "./authz/timeListManage";
import { __setClockForTests } from "./entries/today";
import { __resetOversightCacheForTests } from "./oversight/oversight";

const harness = setupTestAuth();
await harness.init();

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

// ─── The callers, and what each holds ────────────────────────────────────────

type Who = "employee" | "holder" | "manager" | "admin" | "adminGranted";
const WHOS: readonly Who[] = ["employee", "holder", "manager", "admin", "adminGranted"];

/** The persona (JWT subject) each caller signs in as. `admin` and `adminGranted` are the same person with different grants. */
const AS: Record<Who, PersonaName> = { employee: "alice", holder: "holder", manager: "manager", admin: "admin", adminGranted: "admin" };

/** What the fake `auth` says each caller holds: `[resource, action]` pairs of the `hours` catalog (AC-5.2). */
const HOLDS: Record<Who, ReadonlyArray<readonly [string, string]>> = {
  employee: [],
  holder: [["time-entry", "read-all"]],
  manager: [["time-list", "manage"]],
  // The admin role as such holds neither: access is by permission, never by a role's name (AC-3.3, AC-5.2).
  admin: [],
  adminGranted: [
    ["time-entry", "read-all"],
    ["time-list", "manage"],
  ],
};

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  __resetTimeListManageCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** Gives the fake `auth` the grants of `who`, as of now. */
function grantsOf(who: Who): void {
  for (const [resource, action] of HOLDS[who]) hosts.auth.grant(PERSONAS[AS[who]].sub, resource, action);
}

// ─── Route classification ────────────────────────────────────────────────────

/** Answer without a credential: liveness and the API documents. Nothing else may (AC-5.3). */
const PUBLIC = ["GET /health", "GET /openapi.json", "GET /docs"] as const;

/** Every other route: a valid session, and whatever else the route asks for itself. */
const JWT = [
  "GET /time-lists",
  "POST /time-categories",
  "PATCH /time-categories/:id",
  "POST /work-types",
  "PATCH /work-types/:id",
  "POST /time-entries",
  "PATCH /time-entries/:id",
  "DELETE /time-entries/:id",
  "GET /time-entries",
  "GET /time-entries/totals",
] as const;

type JwtRoute = (typeof JWT)[number];

const KNOWN: ReadonlySet<string> = new Set<string>([...PUBLIC, ...JWT]);

interface TableRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * What is wrong with a route table. `ALL` entries are the global middleware (`app.use("*", …)`: CORS, the
 * logger, the body limit, the session guard): they are fine on `/*` and nowhere else, because a handler
 * registered with `app.all("/x", …)`, `app.use("/x", …)` or `app.mount()` would otherwise answer without
 * passing through this classification.
 */
function audit(table: readonly TableRoute[]) {
  const mounted = [...new Set(table.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`))];
  return {
    mounted,
    unclassified: mounted.filter((key) => !KNOWN.has(key)),
    stale: [...KNOWN].filter((key) => !mounted.includes(key)),
    hiddenBehindAll: [...new Set(table.filter((route) => route.method === "ALL" && route.path !== "/*").map((route) => `ALL ${route.path}`))],
  };
}

describe("route inventory (AC-5.3)", () => {
  const real = audit(app.routes);

  it("classifies every mounted route as public or JWT, and nothing else", () => {
    expect(real.unclassified).toEqual([]);
  });

  it("mounts every classified route (no stale row)", () => {
    expect(real.stale).toEqual([]);
  });

  it("has no route behind method ALL: the only ALL entries are global middleware on /*", () => {
    expect(real.hiddenBehindAll).toEqual([]);
    expect(app.routes.some((route) => route.method === "ALL")).toBe(true); // the guard is one of them
  });

  it("has a case for every JWT route, and none for a route that does not exist", () => {
    expect([...new Set(CASES.map((c) => c.route))].sort()).toEqual([...JWT].sort());
  });

  // The checks must be able to fail: the same function, over a table that is exactly the classification
  // (so these hold whatever the app mounts) plus one thing nobody classified.
  const EXACT: TableRoute[] = [{ method: "ALL", path: "/*" }, ...[...KNOWN].map((key) => ({ method: key.split(" ")[0]!, path: key.split(" ")[1]! }))];

  it("is clean for a table that is exactly the classification", () => {
    const clean = audit(EXACT);
    expect([clean.unclassified, clean.stale, clean.hiddenBehindAll]).toEqual([[], [], []]);
  });

  it("would fail on a route mounted without a classification", () => {
    expect(audit([...EXACT, { method: "GET", path: "/secret" }]).unclassified).toEqual(["GET /secret"]);
    expect(audit([...EXACT, { method: "POST", path: "/time-entries/:id/approve" }]).unclassified).toEqual(["POST /time-entries/:id/approve"]);
    // A DELETE on a list is a new route too (AC-3.2), and so is a second verb on a classified path.
    expect(audit([...EXACT, { method: "DELETE", path: "/time-categories/:id" }]).unclassified).toEqual(["DELETE /time-categories/:id"]);
    expect(audit([...EXACT, { method: "PUT", path: "/time-entries/:id" }]).unclassified).toEqual(["PUT /time-entries/:id"]);
  });

  it("would fail on a stale row, and on a handler hiding behind method ALL", () => {
    expect(audit(EXACT.filter((route) => !(route.method === "GET" && route.path === "/time-lists"))).stale).toEqual(["GET /time-lists"]);
    expect(audit([...EXACT, { method: "ALL", path: "/internal/*" }]).hiddenBehindAll).toEqual(["ALL /internal/*"]);
    expect(audit([...EXACT, { method: "ALL", path: "/debug" }]).hiddenBehindAll).toEqual(["ALL /debug"]);
  });
});

// ─── Public routes ───────────────────────────────────────────────────────────

describe("the public routes answer anyone and ask nobody", () => {
  for (const key of PUBLIC) {
    const path = key.split(" ")[1]!;
    for (const who of [null, ...WHOS] as const) {
      it(`${key} as ${who ?? "no one"}`, async () => {
        if (who !== null) grantsOf(who);
        const res = await call("GET", path, { as: who === null ? null : AS[who] });
        expect(res.status).toBe(200);
        // Liveness is the database's alone: an `auth` or an owner being down is not hours-api being down.
        expect(hosts.calls).toEqual([]);
      });
    }
  }

  it("answers a CORS preflight without a credential, with no body and only to an allowed origin", async () => {
    const ask = (origin: string) =>
      app.request("/time-entries", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    const allowed = await ask("http://localhost:5173");
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(await allowed.text()).toBe("");
    const stranger = await ask("http://evil.test");
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
    expect(await stranger.text()).toBe("");
  });
});

// ─── No valid session: 401, before anything else (AC-5.3) ────────────────────

const concrete = (path: string) => path.replace(/:[a-zA-Z]+/g, "some-id");

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Every credential that is not a valid user session, as the `Authorization` header value (null: none at all). */
async function wrongCredentials(): Promise<Array<[string, string | null]>> {
  const token = (over: { sub?: string; audience?: string; issuer?: string; expiresIn?: string }) =>
    harness.signToken({ sub: over.sub ?? "user-alice", email: "alice@welld.test", ...over });
  const { privateKey } = await generateKeyPair("RS256");
  const forged = await new SignJWT({ email: "alice@welld.test" })
    .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
    .setIssuer(TEST_ISSUER)
    .setSubject("user-alice")
    .setAudience(TEST_AUDIENCE)
    .setExpirationTime("1h")
    .sign(privateKey);
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "user-alice", email: "alice@welld.test", iss: TEST_ISSUER, aud: TEST_AUDIENCE, exp: 4102444800 })}.`;
  return [
    ["no Authorization header", null],
    ["an empty Bearer", "Bearer "],
    ["a Bearer that is not a JWT", "Bearer not-a-jwt"],
    ["Basic credentials", "Basic dXNlcjpwYXNz"],
    // The credential hours-api itself holds for meetings-api (ADR-0044): a service JWT, never a user session.
    ["a service JWT (aud = SERVICE_AUDIENCE, sub = a system principal)", `Bearer ${await token({ sub: "system:hours-api", audience: TEST_SERVICE_AUDIENCE })}`],
    ["a PERSON's token with the SERVICE audience", `Bearer ${await token({ audience: TEST_SERVICE_AUDIENCE })}`],
    ["a token for another audience", `Bearer ${await token({ audience: "another-service" })}`],
    ["a token from another issuer", `Bearer ${await token({ issuer: "http://evil.test" })}`],
    ["an expired token", `Bearer ${await token({ expiresIn: "-1h" })}`],
    ["a token signed by a key auth does not publish", `Bearer ${forged}`],
    ["an unsigned token (alg none)", `Bearer ${unsigned}`],
  ];
}

describe("every JWT route refuses every credential that is not a valid session with 401 (AC-5.3)", () => {
  for (const key of JWT) {
    it(`${key}`, async () => {
      const [method, template] = key.split(" ") as [string, string];
      const path = concrete(template);
      const before = await snapshot();
      for (const [label, authorization] of await wrongCredentials()) {
        const res = await call(method, path, {
          as: null,
          ...(authorization !== null ? { headers: { Authorization: authorization } } : {}),
          ...(method === "GET" ? {} : { body: {} }),
        });
        expect({ credential: label, status: res.status }).toEqual({ credential: label, status: 401 });
        expect(res.headers.get("content-type")).toContain("json");
        expect(res.json).toMatchObject({ type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, instance: path });
      }
      // Refused at the gate: nobody was asked (not `auth`, not an owner) and nothing changed.
      expect(hosts.calls).toEqual([]);
      expect(await snapshot()).toBe(before);

      // Control, so the 401s above are not vacuous: a valid session gets past the gate on this very route.
      const ok = await call(method, path, { as: "alice", ...(method === "GET" ? {} : { body: {} }) });
      expect(ok.status).not.toBe(401);
    });
  }
});

describe("default-deny: a path or a method nothing serves is refused like a JWT route, and tells nothing about the route table", () => {
  const UNSERVED: Array<[string, string]> = [
    ["GET", "/"],
    ["GET", "/nothing-here"],
    ["GET", "/health/"],
    ["GET", "/health/extra"],
    ["GET", "/docs/"],
    ["GET", "/openapi.json/"],
    ["POST", "/health"],
    ["DELETE", "/health"],
    ["PUT", "/time-entries"],
    ["PATCH", "/time-entries"],
    ["DELETE", "/time-entries"],
    ["GET", "/time-entries/some-id"],
    ["POST", "/time-entries/totals"],
    ["GET", "/time-categories"],
    ["GET", "/work-types"],
    ["DELETE", "/time-categories/some-id"],
    ["DELETE", "/work-types/some-id"],
    ["DELETE", "/time-lists"],
    ["PUT", "/time-categories/some-id"],
    ["GET", "/metrics"],
    ["GET", "/admin"],
    ["GET", "/system/anything"],
  ];

  for (const [method, path] of UNSERVED) {
    it(`${method} ${path}: 401 without a credential, 404 with one`, async () => {
      const refused = await call(method, path, { as: null });
      expect(refused.status).toBe(401);
      expect(refused.json).toMatchObject({ status: 401, instance: path });

      const missing = await call(method, path, { as: "alice" });
      expect(missing.status).toBe(404);
      expect(missing.json).toMatchObject({ type: "https://httpstatuses.com/404", title: "Not Found", status: 404, instance: path });
      // The answer names what was asked, never what exists: the method and the path, and no other member.
      expect(Object.keys(missing.json).sort()).toEqual(["detail", "instance", "status", "title", "type"]);
      expect(missing.json.detail).toBe(`${method} ${path} does not exist`);
      expect(hosts.calls).toEqual([]);
    });
  }

  it("answers HEAD on a JWT route without a credential with 401 too", async () => {
    expect((await call("HEAD", "/time-entries", { as: null })).status).toBe(401);
    expect((await call("HEAD", "/time-lists", { as: null })).status).toBe(401);
  });
});

// ─── The cells: route x caller, with the literal expectation of each ─────────

type Expected = number | readonly [number, string];

const NOT_MANAGER: Expected = [403, "time_list_manage_required"];
const NOT_HOLDER: Expected = [403, "read_all_required"];
const OWNER_ONLY: Expected = [403, "owner_only"];
const INVALID: Expected = [400, "invalid_request"];

/** Any session: no permission is asked, so every caller gets the same answer. */
const ANYONE = (answer: Expected): Record<Who, Expected> => ({ employee: answer, holder: answer, manager: answer, admin: answer, adminGranted: answer });
/** `time-list:manage`: the manager and the admin who was granted it, and nobody else, whatever their role is called (AC-3.3). */
const MANAGE = (answer: Expected, refused: Expected = NOT_MANAGER): Record<Who, Expected> => ({
  employee: refused,
  holder: refused,
  manager: answer,
  admin: refused,
  adminGranted: answer,
});
/** `time-entry:read-all`: the holder and the admin who was granted it, and nobody else (AC-4.2, AC-5.2). */
const READ_ALL = (answer: Expected): Record<Who, Expected> => ({
  employee: NOT_HOLDER,
  holder: answer,
  manager: NOT_HOLDER,
  admin: NOT_HOLDER,
  adminGranted: answer,
});
/**
 * Someone else's entry (AC-1.6): a holder of `time-entry:read-all` may read it, so they are told it is not theirs to
 * change (403); everyone else is told what they are told for an entry that does not exist (404), an admin included.
 */
const SOMEONE_ELSES: Record<Who, Expected> = { employee: 404, holder: OWNER_ONLY, manager: 404, admin: 404, adminGranted: OWNER_ONLY };

const DAY = "2026-11-05";
const NOVEMBER = "from=2026-11-01&to=2026-11-30";
const TRAINING = SEED.categories.training;
const GHOST = "cmhx0p3v10000nobody0000000";
const TOO_LONG = "x".repeat(65);
const BOB = PERSONAS.bob.sub;
const SEEDED_WORK_TYPE = SEED.workTypes.project.development;

/** The entries the world holds for a cell: one of each persona, 60 minutes on the same day. */
interface Seeded {
  /** The caller's own entry. */
  readonly own: string;
  /** Bob's: nobody in the matrix is bob, so it is always someone else's. */
  readonly others: string;
  /** Every entry there is, and bob's alone. */
  readonly all: readonly string[];
}

async function seed(who: Who): Promise<Seeded> {
  const ids = new Map<PersonaName, string>();
  for (const name of Object.keys(PERSONAS) as PersonaName[]) {
    ids.set(name, (await makeNoEntityEntry(TRAINING, { userId: PERSONAS[name].sub, day: DAY, minutes: 60, note: `Note of ${name}` })).id);
  }
  return { own: ids.get(AS[who])!, others: ids.get("bob")!, all: [...ids.values()] };
}

/** Everything the tables hold, in a stable order: a refused request must leave it equal. */
async function snapshot(): Promise<string> {
  return JSON.stringify([
    await db.timeEntry.findMany({ orderBy: { id: "asc" } }),
    await db.timeCategory.findMany({ orderBy: { id: "asc" } }),
    await db.workType.findMany({ orderBy: { id: "asc" } }),
  ]);
}

interface Req {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

type Res = Awaited<ReturnType<typeof call>>;

interface Case {
  readonly route: JwtRoute;
  /** What the case is about, for the test name. */
  readonly what: string;
  /** Whether it changes data (a refused one must leave the tables as they were). */
  readonly writes: boolean;
  /** How many times `auth` is asked (`GET /authz/resolve`) by one request: the same for every caller. */
  readonly auth: number;
  readonly request: (s: Seeded) => Req;
  /** The literal expectation for every caller; a missing caller fails. */
  readonly expect: Readonly<Record<Who, Expected>>;
  /** Also holds for an id nobody has: a caller refused with a 404 is told the same as for an entry that does not exist (AC-1.6). */
  readonly sameAsNoSuchEntry?: boolean;
  /** Extra assertions on an answer that succeeded. */
  readonly check?: (res: Res, s: Seeded, who: Who) => void;
}

const WITHOUT_DATA = ["items", "groups", "totalMinutes", "nextCursor"] as const;

const ids = (res: Res): string[] => res.json.items.map((item: { id: string }) => item.id).sort();

const CASES: readonly Case[] = [
  // ── GET /time-lists: any session ──
  {
    route: "GET /time-lists",
    what: "the lists, retired items included",
    writes: false,
    auth: 0,
    request: () => ({ method: "GET", path: "/time-lists?includeRetired=true" }),
    expect: ANYONE(200),
    check: (res) => {
      expect(res.json.categories.map((c: { id: string }) => c.id)).toContain(TRAINING);
      expect(res.json.workTypes.project.length).toBeGreaterThan(0);
    },
  },

  // ── POST /time-categories, POST /work-types: time-list:manage, asked FIRST (before the body is read) ──
  {
    route: "POST /time-categories",
    what: "add a category",
    writes: true,
    auth: 1,
    request: () => ({ method: "POST", path: "/time-categories", body: { name: "Matrix category" } }),
    expect: MANAGE(201),
  },
  {
    route: "POST /time-categories",
    what: "a body that breaks the schema: refused for the permission before it is validated",
    writes: true,
    auth: 1,
    request: () => ({ method: "POST", path: "/time-categories", body: {} }),
    expect: MANAGE(INVALID),
  },
  {
    route: "POST /work-types",
    what: "add a work type",
    writes: true,
    auth: 1,
    request: () => ({ method: "POST", path: "/work-types", body: { list: "project", name: "Matrix work type" } }),
    expect: MANAGE(201),
  },
  {
    route: "POST /work-types",
    what: "a body that breaks the schema: refused for the permission before it is validated",
    writes: true,
    auth: 1,
    request: () => ({ method: "POST", path: "/work-types", body: { list: "elsewhere" } }),
    expect: MANAGE(INVALID),
  },

  // ── PATCH /time-categories/:id, PATCH /work-types/:id: the same gate, before the path is read ──
  ...(
    [
      ["PATCH /time-categories/:id", "/time-categories", TRAINING],
      ["PATCH /work-types/:id", "/work-types", SEEDED_WORK_TYPE],
    ] as const
  ).flatMap(([route, base, seeded]): Case[] => [
    {
      route,
      what: "rename a seeded item",
      writes: true,
      auth: 1,
      request: () => ({ method: "PATCH", path: `${base}/${seeded}`, body: { name: "Renamed by the matrix" } }),
      expect: MANAGE(200),
    },
    {
      route,
      what: "retire a seeded item",
      writes: true,
      auth: 1,
      request: () => ({ method: "PATCH", path: `${base}/${seeded}`, body: { retired: true } }),
      expect: MANAGE(200),
    },
    {
      route,
      what: "an id outside the id rule: the permission is asked before the path is read",
      writes: true,
      auth: 1,
      request: () => ({ method: "PATCH", path: `${base}/${TOO_LONG}`, body: { name: "x" } }),
      expect: MANAGE(INVALID),
    },
    {
      route,
      what: "an id nobody has: only a manager is told it does not exist",
      writes: true,
      auth: 1,
      request: () => ({ method: "PATCH", path: `${base}/${GHOST}`, body: { name: "x" } }),
      expect: MANAGE(404),
    },
  ]),

  // ── POST /time-entries: any session, always one's own, never on someone's behalf (AC-1.6, AC-1.8) ──
  {
    route: "POST /time-entries",
    what: "record one's own hours",
    writes: true,
    auth: 0,
    request: () => ({ method: "POST", path: "/time-entries", body: { day: DAY, minutes: 60, on: { type: "none", categoryId: TRAINING } } }),
    expect: ANYONE(201),
    check: (res, _s, who) => {
      // The author is the session's subject, never client input.
      expect(res.json.person.id).toBe(PERSONAS[AS[who]].sub);
    },
  },
  {
    route: "POST /time-entries",
    what: "on someone else's behalf (a userId): refused for everyone, holders and admins included",
    writes: true,
    auth: 0,
    request: () => ({ method: "POST", path: "/time-entries", body: { userId: BOB, day: DAY, minutes: 60, on: { type: "none", categoryId: TRAINING } } }),
    expect: ANYONE(INVALID),
  },
  {
    route: "POST /time-entries",
    what: "with a start and an end time (AC-1.8): an entry is a day and a duration only",
    writes: true,
    auth: 0,
    request: () => ({
      method: "POST",
      path: "/time-entries",
      body: { day: DAY, minutes: 60, start: "09:00", end: "10:00", on: { type: "none", categoryId: TRAINING } },
    }),
    expect: ANYONE(INVALID),
  },

  // ── PATCH /time-entries/:id: the caller's own entry, whatever they hold (AC-1.5, AC-1.6) ──
  {
    route: "PATCH /time-entries/:id",
    what: "one's own entry",
    writes: true,
    auth: 0,
    request: (s) => ({ method: "PATCH", path: `/time-entries/${s.own}`, body: { minutes: 90 } }),
    expect: ANYONE(200),
    check: (res, _s, who) => {
      expect(res.json.minutes).toBe(90);
      expect(res.json.person.id).toBe(PERSONAS[AS[who]].sub);
    },
  },
  {
    route: "PATCH /time-entries/:id",
    what: "someone else's entry",
    writes: true,
    auth: 1,
    request: (s) => ({ method: "PATCH", path: `/time-entries/${s.others}`, body: { minutes: 90 } }),
    expect: SOMEONE_ELSES,
    sameAsNoSuchEntry: true,
  },
  {
    route: "PATCH /time-entries/:id",
    what: "someone else's entry, with a body that breaks a rule: looked up before any rule, so never a 422",
    writes: true,
    auth: 1,
    request: (s) => ({ method: "PATCH", path: `/time-entries/${s.others}`, body: { minutes: 15 } }),
    expect: SOMEONE_ELSES,
    sameAsNoSuchEntry: true,
  },
  {
    route: "PATCH /time-entries/:id",
    what: "an id no entry has",
    writes: true,
    auth: 1,
    request: () => ({ method: "PATCH", path: `/time-entries/${GHOST}`, body: { minutes: 90 } }),
    expect: ANYONE(404),
  },
  {
    route: "PATCH /time-entries/:id",
    what: "an id outside the id rule: 400 for everyone and nobody is asked, a holder included",
    writes: true,
    auth: 0,
    request: () => ({ method: "PATCH", path: `/time-entries/${TOO_LONG}`, body: { minutes: 90 } }),
    expect: ANYONE(INVALID),
  },

  // ── DELETE /time-entries/:id: the same ──
  {
    route: "DELETE /time-entries/:id",
    what: "one's own entry",
    writes: true,
    auth: 0,
    request: (s) => ({ method: "DELETE", path: `/time-entries/${s.own}` }),
    expect: ANYONE(204),
  },
  {
    route: "DELETE /time-entries/:id",
    what: "someone else's entry",
    writes: true,
    auth: 1,
    request: (s) => ({ method: "DELETE", path: `/time-entries/${s.others}` }),
    expect: SOMEONE_ELSES,
    sameAsNoSuchEntry: true,
  },
  {
    route: "DELETE /time-entries/:id",
    what: "an id no entry has",
    writes: true,
    auth: 1,
    request: () => ({ method: "DELETE", path: `/time-entries/${GHOST}` }),
    expect: ANYONE(404),
  },
  {
    route: "DELETE /time-entries/:id",
    what: "an id outside the id rule: 400 for everyone and nobody is asked, a holder included",
    writes: true,
    auth: 0,
    request: () => ({ method: "DELETE", path: `/time-entries/${TOO_LONG}` }),
    expect: ANYONE(INVALID),
  },

  // ── GET /time-entries: one's own with a session; everyone's with time-entry:read-all, asked live (AC-4.2, AC-5.4) ──
  {
    route: "GET /time-entries",
    what: "whose=mine: only the caller's own, and `auth` is not asked",
    writes: false,
    auth: 0,
    request: () => ({ method: "GET", path: `/time-entries?${NOVEMBER}` }),
    expect: ANYONE(200),
    check: (res, s) => expect(ids(res)).toEqual([s.own]),
  },
  {
    route: "GET /time-entries",
    what: "whose=all",
    writes: false,
    auth: 1,
    request: () => ({ method: "GET", path: `/time-entries?${NOVEMBER}&whose=all` }),
    expect: READ_ALL(200),
    check: (res, s) => expect(ids(res)).toEqual([...s.all].sort()),
  },
  {
    route: "GET /time-entries",
    what: "whose=all for one person (userId)",
    writes: false,
    auth: 1,
    request: () => ({ method: "GET", path: `/time-entries?${NOVEMBER}&whose=all&userId=${BOB}` }),
    expect: READ_ALL(200),
    check: (res, s) => expect(ids(res)).toEqual([s.others]),
  },

  // ── GET /time-entries/totals: the same question as a sum ──
  {
    route: "GET /time-entries/totals",
    what: "whose=mine: only the caller's own hours, and `auth` is not asked",
    writes: false,
    auth: 0,
    request: () => ({ method: "GET", path: `/time-entries/totals?groupBy=day&${NOVEMBER}` }),
    expect: ANYONE(200),
    check: (res) => expect(res.json.totalMinutes).toBe(60),
  },
  {
    route: "GET /time-entries/totals",
    what: "whose=all, by person",
    writes: false,
    auth: 1,
    request: () => ({ method: "GET", path: `/time-entries/totals?groupBy=person&${NOVEMBER}&whose=all` }),
    expect: READ_ALL(200),
    check: (res, s) => {
      expect(res.json.totalMinutes).toBe(60 * s.all.length);
      expect(res.json.groups).toHaveLength(s.all.length);
    },
  },
  {
    route: "GET /time-entries/totals",
    what: "whose=all for one person (userId)",
    writes: false,
    auth: 1,
    request: () => ({ method: "GET", path: `/time-entries/totals?groupBy=day&${NOVEMBER}&whose=all&userId=${BOB}` }),
    expect: READ_ALL(200),
    check: (res) => expect(res.json.totalMinutes).toBe(60),
  },
];

const statusOf = (expected: Expected): [number, string | undefined] => (typeof expected === "number" ? [expected, undefined] : [expected[0], expected[1]]);

/** An answer with the id it was asked about set aside: `instance` and a detail may echo the requested path. */
const withoutId = (res: Res, id: string) => ({ status: res.status, text: res.text.replaceAll(id, "<id>") });

describe("authorization matrix: route x caller", () => {
  for (const c of CASES) {
    describe(`${c.route}: ${c.what}`, () => {
      it("states an expectation for every caller, and for none that does not exist", () => {
        expect(Object.keys(c.expect).sort()).toEqual([...WHOS].sort());
      });

      for (const who of WHOS) {
        it(who, async () => {
          grantsOf(who);
          const seeded = await seed(who);
          const before = await snapshot();
          const [status, code] = statusOf(c.expect[who]);
          const req = c.request(seeded);

          const res = await call(req.method, req.path, { as: AS[who], ...(req.body !== undefined ? { body: req.body } : {}) });

          // The literal answer. A 501 is the build-order seam of T14: it must be gone from every cell (plan R11).
          expect(res.status).not.toBe(501);
          expect(res.status).toBe(status);
          if (code !== undefined) expect(res.json.code).toBe(code);
          if (status === 200 || status === 201) c.check?.(res, seeded, who);
          if (status === 204) expect(res.text).toBe("");

          // A refusal changes nothing (AC-1.6, AC-3.3): no entry, no list item, not one column.
          if (c.writes && status >= 400) expect(await snapshot()).toBe(before);
          // ...and hands out nothing: a refused read carries no rows, no groups, no total.
          if (!c.writes && status >= 400) for (const member of WITHOUT_DATA) expect(res.json).not.toHaveProperty(member);

          // `auth` is asked exactly when the route needs a permission, once, and AS THE CALLER: the caller's own
          // Authorization header, never a credential of hours-api's and never someone else's.
          const asked = hosts.callsTo("auth.resolve");
          expect({ route: c.route, what: c.what, asked: asked.length }).toEqual({ route: c.route, what: c.what, asked: c.auth });
          const bearer = await bearerOf(AS[who]);
          expect(asked.every((resolve) => resolve.authorization === bearer)).toBe(true);
          // Every entry here is on no entity: no owner is asked, nothing is minted for one.
          expect(hosts.calls.filter((made) => made.host !== "auth")).toEqual([]);
          expect(hosts.calls.filter((made) => made.route === "auth.service-token")).toEqual([]);

          // AC-1.6, AC-2.10: a caller told 404 for someone else's entry is told what an entry nobody has gets.
          if (c.sameAsNoSuchEntry && status === 404) {
            const ghost = c.request({ ...seeded, others: GHOST });
            const missing = await call(ghost.method, ghost.path, { as: AS[who], ...(ghost.body !== undefined ? { body: ghost.body } : {}) });
            expect(withoutId(res, seeded.others)).toEqual(withoutId(missing, GHOST));
          }
        });
      }
    });
  }
});

// ─── AC-3.2: nobody, admins included, deletes a category or a work type ──────

describe("no route deletes a category or a work type (AC-3.2): DELETE is the app's 404 for everyone", () => {
  const PATHS = [`/time-categories/${TRAINING}`, `/work-types/${SEEDED_WORK_TYPE}`, `/time-categories/${GHOST}`, "/time-categories", "/work-types", "/time-lists"];

  for (const who of WHOS) {
    it(`${who}`, async () => {
      grantsOf(who);
      const before = await snapshot();
      for (const path of PATHS) {
        const res = await call("DELETE", path, { as: AS[who] });
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
        expect(res.json).toMatchObject({ type: "https://httpstatuses.com/404", title: "Not Found", status: 404 });
        expect(res.json).not.toHaveProperty("code");
      }
      expect(await snapshot()).toBe(before);
      // Not even a manager's DELETE reaches a permission check: there is no such route.
      expect(hosts.callsTo("auth.resolve")).toEqual([]);
    });
  }
});

// ─── The permissions are not each other (AC-3.3, AC-4.2, AC-5.2) ─────────────

describe("one permission is not the other, and a role's name grants nothing", () => {
  it("time-entry:read-all does not write the lists, and time-list:manage does not read everyone's hours", async () => {
    grantsOf("holder");
    grantsOf("manager");
    expect((await call("POST", "/time-categories", { as: "holder", body: { name: "Not mine" } })).json).toMatchObject({ code: "time_list_manage_required" });
    expect((await call("GET", `/time-entries?${NOVEMBER}&whose=all`, { as: "manager" })).json).toMatchObject({ code: "read_all_required" });
    expect(await db.timeCategory.count({ where: { name: "Not mine" } })).toBe(0);
  });

  it("an admin without the permissions is a plain employee: lists refused, everyone's hours refused", async () => {
    // The fake `auth` says the admin holds nothing: whatever the role is called, only a grant counts.
    expect((await call("POST", "/work-types", { as: "admin", body: { list: "deal", name: "Admin's" } })).json).toMatchObject({ code: "time_list_manage_required" });
    expect((await call("GET", `/time-entries/totals?groupBy=person&${NOVEMBER}&whose=all`, { as: "admin" })).json).toMatchObject({ code: "read_all_required" });
    expect(await db.workType.count({ where: { name: "Admin's" } })).toBe(0);
  });

  it("a grant is seen on the very next request: a revoked admin stops writing the lists at once", async () => {
    grantsOf("adminGranted");
    expect((await call("POST", "/time-categories", { as: "admin", body: { name: "While granted" } })).status).toBe(201);
    hosts.reset();
    for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
    // Same token, same `perm_epoch`: no grant is remembered, so the revocation holds immediately (ADR-0075).
    expect((await call("POST", "/time-categories", { as: "admin", body: { name: "After revoke" } })).json).toMatchObject({ code: "time_list_manage_required" });
  });
});

// ─── AC-5.4: an `auth` outage is never read as a grant ───────────────────────

describe("`auth` down: what needs a permission is refused as unavailable, what does not keeps working (AC-5.4)", () => {
  it("is 503 authz_unavailable for every permission-gated route, and a person's own hours still answer", async () => {
    grantsOf("adminGranted");
    hosts.fail("auth.resolve", { status: 500 });

    const gated: Array<[string, string, unknown]> = [
      ["POST", "/time-categories", { name: "While down" }],
      ["POST", "/work-types", { list: "project", name: "While down" }],
      ["PATCH", `/time-categories/${TRAINING}`, { name: "While down" }],
      ["PATCH", `/work-types/${SEEDED_WORK_TYPE}`, { name: "While down" }],
      ["GET", `/time-entries?${NOVEMBER}&whose=all`, undefined],
      ["GET", `/time-entries/totals?groupBy=day&${NOVEMBER}&whose=all`, undefined],
    ];
    const before = await snapshot();
    for (const [method, path, body] of gated) {
      const res = await call(method, path, { as: "admin", ...(body !== undefined ? { body } : {}) });
      expect({ method, path, status: res.status, code: res.json?.code }).toEqual({ method, path, status: 503, code: "authz_unavailable" });
    }
    expect(await snapshot()).toBe(before);

    // Nothing of a person's own needs `auth`.
    expect((await call("GET", "/time-lists", { as: "admin" })).status).toBe(200);
    expect((await call("GET", `/time-entries?${NOVEMBER}`, { as: "admin" })).status).toBe(200);
    expect((await call("GET", `/time-entries/totals?groupBy=day&${NOVEMBER}`, { as: "admin" })).status).toBe(200);
    expect((await call("POST", "/time-entries", { as: "admin", body: { day: DAY, minutes: 30, on: { type: "none", categoryId: TRAINING } } })).status).toBe(201);
  });

  it("is never a grant: a write to someone else's entry while `auth` is down is the 404 of a stranger", async () => {
    grantsOf("holder");
    const bobs = await makeNoEntityEntry(TRAINING, { userId: BOB, day: DAY });
    hosts.fail("auth.resolve", { status: 500 });
    const before = await snapshot();

    expect((await call("PATCH", `/time-entries/${bobs.id}`, { as: "holder", body: { minutes: 90 } })).status).toBe(404);
    expect((await call("DELETE", `/time-entries/${bobs.id}`, { as: "holder" })).status).toBe(404);
    expect(await snapshot()).toBe(before);
  });
});
