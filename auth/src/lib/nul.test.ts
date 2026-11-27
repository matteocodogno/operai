/**
 * A U+0000 anywhere in a request is a 400 `validation_failed` and never a 500 (specs/20261126-teams QE D2). Postgres text, and the text
 * inside jsonb, cannot hold it. Two layers: the guard in front of the whole app refuses it in the path, the query and a JSON body
 * before any route runs, and the global error handler maps the database's own refusal (Prisma P2039 / Postgres 22021) to the same 400.
 * Real Postgres, the whole app, the session mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { db } from "./db";
import { isNulDatabaseError } from "./nul";

/**
 * Only the calls that carry the safety net's own prefix. A spy another test file left on `console.warn` comes back from `spyOn` with
 * that file's calls, and an unrelated warning is not this test's (QE F3): count and read the `[nul]` lines, not the whole log.
 */
const nulLines = (spy: { mock: { calls: unknown[][] } }): unknown[][] =>
  spy.mock.calls.filter((call) => call[0] === "[nul] database refused U+0000 or invalid text");

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;
mock.module("../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession), handler: mock(async () => new Response("{}")) } },
}));
const { app } = await import("../index");

const RUN = crypto.randomUUID().slice(0, 8);
let adminId = "";
let roleId = "";
let departmentId = "";

beforeAll(async () => {
  const admin = await db.user.create({ data: { name: "nul admin", email: `nul-app-${RUN}@operai.test`, emailVerified: true } });
  adminId = admin.id;
  const adminRole = await db.role.upsert({ where: { name: "admin" }, update: {}, create: { name: "admin", isSystem: true } });
  await db.userRole.create({ data: { userId: adminId, roleId: adminRole.id } });
  roleId = (await db.role.create({ data: { name: `nul-role-${RUN}` } })).id;
  departmentId = (await db.department.create({ data: { name: `nul-dept-${RUN}` } })).id;
  currentSession = { user: { id: adminId, email: admin.email, name: "N" }, session: { id: `s-${RUN}` } };
});

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { actorUserId: adminId } });
  await db.department.deleteMany({ where: { name: { contains: RUN } } });
  await db.role.deleteMany({ where: { name: { contains: RUN } } });
  await db.user.deleteMany({ where: { id: adminId } });
});

const NUL = "zz\u0000qq";
const enc = encodeURIComponent(NUL);

async function call(method: string, path: string, body?: unknown, rawBody?: string) {
  const res = await app.request(path, {
    method,
    headers: body === undefined && rawBody === undefined ? {} : { "Content-Type": "application/json" },
    ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** 400 `validation_failed`, and nothing of the input in it (`instance` is the request path by RFC 7807 convention). */
const expectRefused = (res: { status: number; json: Record<string, unknown> }) => {
  expect(res.status).toBe(400);
  expect(res.json["code"]).toBe("validation_failed");
  const { instance: _instance, ...rest } = res.json;
  expect(JSON.stringify(rest)).not.toContain("zz");
};

describe("a NUL in the path, the query or a JSON body is a 400 before any route runs", () => {
  test("POST /admin/departments name, and nothing is written", async () => {
    const before = await db.department.count();
    expectRefused(await call("POST", "/admin/departments", { name: `${NUL}-${RUN}` }));
    expect(await db.department.count()).toBe(before);
  });

  test("POST /admin/departments description", async () => {
    expectRefused(await call("POST", "/admin/departments", { name: `ok-${RUN}`, description: NUL }));
    expect(await db.department.count({ where: { name: `ok-${RUN}` } })).toBe(0);
  });

  test("GET /admin/users?q=", async () => expectRefused(await call("GET", `/admin/users?q=${enc}`)));
  test("GET /admin/users?q=%00 in lower and upper case", async () => {
    expectRefused(await call("GET", "/admin/users?q=%00"));
    expectRefused(await call("GET", "/admin/users?q=a%000b"));
  });
  test("a path parameter", async () => expectRefused(await call("GET", `/admin/departments/${enc}`)));
  test("POST /admin/roles name", async () => expectRefused(await call("POST", "/admin/roles", { name: NUL })));
  test("POST /admin/roles description", async () =>
    expectRefused(await call("POST", "/admin/roles", { name: `r-${RUN}`, description: NUL })));
  test("PATCH /admin/users/{id} jobTitle", async () =>
    expectRefused(await call("PATCH", `/admin/users/${adminId}`, { jobTitle: NUL })));
  test("PUT /admin/roles/{id}/rules, a NUL inside the jsonb conditions", async () =>
    expectRefused(
      await call("PUT", `/admin/roles/${roleId}/rules`, {
        rules: [{ resource: "request", action: "approve", conditions: { entity: [NUL] } }],
      }),
    ));
  test("POST /admin/invitations email", async () =>
    expectRefused(await call("POST", "/admin/invitations", { email: `a${NUL}@welld.ch`, roleIds: [], departmentIds: [] })));
  test("a key of the body", async () => expectRefused(await call("POST", "/admin/departments", { [NUL]: "x", name: `k-${RUN}` })));

  test("a NUL escaped with a hex digit case or spacing JSON allows is still seen", async () => {
    // The escape is always the six characters \u0000; a NUL after an escaped backslash pair is a NUL too.
    expectRefused(await call("POST", "/admin/departments", undefined, `{"name":"a\\\\\\u0000b"}`));
  });
});

describe("what is not a NUL still goes through", () => {
  test("the text `\\u0000` (a backslash, then u0000) in a body is ordinary text", async () => {
    const name = `lit-${RUN}`;
    const res = await call("POST", "/admin/departments", undefined, `{"name":"${name}\\\\u0000"}`);
    expect(res.status).toBe(201);
    expect(await db.department.count({ where: { name: `${name}\\u0000` } })).toBe(1);
  });

  test("a percent-encoded `%2500` in a query is the text %00, not a NUL", async () => {
    const res = await call("GET", "/admin/users?q=%2500");
    expect(res.status).toBe(200);
  });

  test("a clean request is unaffected, and its body is still readable by the route", async () => {
    const res = await call("POST", "/admin/departments", { name: `clean-${RUN}` });
    expect(res.status).toBe(201);
  });
});

describe("the global error handler maps the database's NUL refusal to a 400", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  /** The very error Prisma throws: a real query with a NUL, not a hand-made look-alike. */
  const realNulError = async (): Promise<unknown> => {
    try {
      await db.department.findMany({ where: { name: { contains: "a\u0000b" } } });
    } catch (error) {
      return error;
    }
    throw new Error("Postgres accepted a NUL");
  };

  /** Makes every read of `db.department` fail with `error`, as a query that reached Postgres would. */
  const failDepartmentReads = (error: unknown): void => {
    const target = db as unknown as Record<string, unknown>;
    const delegate = target["department"];
    const failing = new Proxy({}, { get: () => () => Promise.reject(error) });
    const put = (value: unknown) =>
      Object.defineProperty(target, "department", { configurable: true, enumerable: true, writable: true, value });
    put(failing);
    restore = () => put(delegate);
  };

  test("recognises the real Prisma error, and nothing else", async () => {
    expect(isNulDatabaseError(await realNulError())).toBe(true);
    expect(isNulDatabaseError(new Error("boom"))).toBe(false);
    expect(isNulDatabaseError(Object.assign(new Error("x"), { code: "P2002" }))).toBe(false);
    expect(isNulDatabaseError(null)).toBe(false);
    expect(isNulDatabaseError("22021")).toBe(false);
  });

  test("a query that reaches Postgres with a NUL answers 400, with no value and no database text", async () => {
    failDepartmentReads(await realNulError());
    const res = await call("GET", "/admin/departments");
    expect(res.status).toBe(400);
    expect(res.json["code"]).toBe("validation_failed");
    expect(res.text).not.toMatch(/22021|invalid byte|prisma|UTF8/i);
  });

  test("any other database failure is still a 500", async () => {
    failDepartmentReads(Object.assign(new Error("down"), { code: "P1001" }));
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await call("GET", "/admin/departments")).status).toBe(500);
    } finally {
      quiet.mockRestore();
    }
  });

  // Security review A09: the safety net answers 400 and leaves ONE line, the code(s) only, so a server-built bad value is not blamed on
  // the client with no trace. No message, no value, no arguments, no person.
  const adapterError = { name: "DriverAdapterError", cause: { kind: "postgres", code: "22021", originalCode: "22021" } };
  const leaky = (code: string, sqlstate: string) =>
    Object.assign(new Error("Invalid `db.department.findMany()` invocation: secret-note"), {
      code,
      meta: {
        target: ["secret-value"],
        args: { data: "secret-value" },
        driverAdapterError: { ...adapterError, message: "secret-note", cause: { kind: "postgres", code: sqlstate, originalCode: sqlstate, message: "secret-note" } },
      },
    });

  for (const [label, make, codes] of [
    ["Prisma-wrapped, model query", () => leaky("P2039", "22021"), "P2039/22021"],
    ["Prisma-wrapped, raw query on jsonb", () => leaky("P2010", "22P05"), "P2010/22P05"],
    ["the driver adapter's own error", () => Object.assign(new Error("invalid byte sequence secret-note"), adapterError), "22021"],
    ["unwrapped from pg", () => Object.assign(new Error("unsupported Unicode escape sequence secret-note"), { code: "22P05" }), "22P05"],
  ] as const) {
    test(`the safety net logs one line for ${label}: ${codes}, no message, no value`, async () => {
      failDepartmentReads(make());
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      warn.mockClear();
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect((await call("GET", "/admin/departments")).status).toBe(400);
        expect(nulLines(warn)).toHaveLength(1);
        expect(nulLines(warn)[0]).toEqual(["[nul] database refused U+0000 or invalid text", codes]);
        expect(JSON.stringify(nulLines(warn))).not.toMatch(/secret|invocation|Invalid|invalid byte|Unicode|@operai\.test/);
        expect(err).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        err.mockRestore();
      }
    });
  }

  test("a database failure that is not about a NUL logs no such line", async () => {
    failDepartmentReads(Object.assign(new Error("down"), { code: "P1001" }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await call("GET", "/admin/departments")).status).toBe(500);
      expect(nulLines(warn)).toHaveLength(0);
    } finally {
      warn.mockRestore();
      quiet.mockRestore();
    }
  });
});
