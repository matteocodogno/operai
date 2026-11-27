/**
 * A U+0000 anywhere in a request is a 400 `validation_failed` and never a 500 (specs/20261126-teams QE D2). Postgres text cannot
 * hold it. Two layers, each tested on its own: the shared schemas refuse it before any database call, and the global error handler
 * maps the database's own refusal (Prisma P2039 / Postgres 22021) to the same 400, so a route nobody remembered is still not a 500.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { call, db, resetWorld, seedDealProject } from "../test-support/world";
import { isNulDatabaseError } from "./nul";

/**
 * Only the calls that carry the safety net's own prefix. A spy another test file left on `console.warn` comes back from `spyOn` with
 * that file's calls, and an unrelated warning is not this test's (QE F3): count and read the `[nul]` lines, not the whole log.
 */
const nulLines = (spy: { mock: { calls: unknown[][] } }): unknown[][] =>
  spy.mock.calls.filter((call) => call[0] === "[nul] database refused U+0000 or invalid text");

beforeEach(resetWorld);

const NUL = "zz\u0000qq";
const enc = encodeURIComponent(NUL);

/**
 * 400 `validation_failed`; detail, field and errors never repeat the value (`instance` is the request path, as always).
 * `byValidation`: a schema refused it, so the answer names the field; the database safety net's answer names none.
 */
const expectRefused = (res: { status: number; json: Record<string, unknown> }, byValidation = true) => {
  expect(res.status).toBe(400);
  expect(res.json["code"]).toBe("validation_failed");
  expect(res.json["field"] !== "").toBe(byValidation);
  const { instance: _instance, ...rest } = res.json;
  expect(JSON.stringify(rest)).not.toContain("zz");
};

describe("NUL in free text is refused by the shared schemas", () => {
  it("GET /projects?q=", async () => expectRefused(await call("GET", `/projects?q=${enc}`, { as: "viewer" })));

  it("POST /projects name, and nothing is written", async () => {
    expectRefused(
      await call("POST", "/projects", { as: "pmCh", body: { name: NUL, type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch" } }),
    );
    expect(await db.project.count()).toBe(0);
  });

  it("PATCH /projects/{id} name", async () => {
    const project = await db.project.create({
      data: { name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
    });
    expectRefused(await call("PATCH", `/projects/${project.id}`, { as: "pmCh", body: { name: NUL }, ifMatch: project.version }));
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe("Koordy");
  });

  it("T&M terms: a position's profile", async () => {
    const project = await db.project.create({
      data: { name: "TM", type: "t_and_m", entity: "welld_ch", companyId: "co-acme", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
    });
    const res = await call("POST", `/projects/${project.id}/terms`, {
      as: "pmCh",
      ifMatch: project.version,
      body: { startDate: "2026-12-01", terms: { positions: [{ profile: NUL, plannedManDays: 5 }] } },
    });
    expectRefused(res);
    expect(await db.projectTerms.count()).toBe(0);
  });

  it("PUT the Bexio order id", async () => {
    const { project, order } = await seedDealProject();
    expectRefused(
      await call("PUT", `/projects/${project.id}/purchase-order/bexio-order`, { as: "accounting", body: { bexioOrderId: NUL }, ifMatch: order.version }),
    );
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).bexioOrderId).toBeNull();
  });
});

describe("the global error handler maps the database's NUL refusal to a 400", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  /** Makes every read of `db.project` fail with `error`, as a query that reached Postgres would. */
  const failProjectReads = (error: unknown): void => {
    const target = db as unknown as Record<string, unknown>;
    const delegate = target["project"];
    const failing = new Proxy({}, { get: () => () => Promise.reject(error) });
    const put = (value: unknown) =>
      Object.defineProperty(target, "project", { configurable: true, enumerable: true, writable: true, value });
    put(failing);
    restore = () => put(delegate);
  };

  /** The very error Prisma throws: a real query with a NUL, not a hand-made look-alike. */
  const realNulError = async (): Promise<unknown> => {
    try {
      await db.project.findMany({ where: { name: { contains: "a\u0000b" } } });
    } catch (error) {
      return error;
    }
    throw new Error("Postgres accepted a NUL");
  };

  it("recognises the real Prisma error, and nothing else", async () => {
    const error = await realNulError();
    expect(isNulDatabaseError(error)).toBe(true);
    expect(isNulDatabaseError(new Error("boom"))).toBe(false);
    expect(isNulDatabaseError(Object.assign(new Error("x"), { code: "P2002" }))).toBe(false);
    expect(isNulDatabaseError(null)).toBe(false);
    expect(isNulDatabaseError("22021")).toBe(false);
  });

  it("a route whose query reaches Postgres with a NUL answers 400, with no value and no database text", async () => {
    const error = await realNulError();
    failProjectReads(error);
    const res = await call("GET", "/projects", { as: "viewer" });
    expectRefused(res, false);
    expect(JSON.stringify(res.json)).not.toMatch(/22021|invalid byte|prisma|UTF8/i);
  });

  it("any other database failure is still a 500", async () => {
    failProjectReads(Object.assign(new Error("down"), { code: "P1001" }));
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await call("GET", "/projects", { as: "viewer" });
      expect(res.status).toBe(500);
    } finally {
      quiet.mockRestore();
    }
  });

  // Security review A09: the safety net answers 400 and leaves ONE line, the code(s) only, so a server-built bad value is not blamed on
  // the client with no trace. No message, no value, no arguments, no person.
  const adapterError = { name: "DriverAdapterError", cause: { kind: "postgres", code: "22021", originalCode: "22021" } };
  const leaky = (code: string, sqlstate: string) =>
    Object.assign(new Error("Invalid `db.project.findMany()` invocation: secret-note"), {
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
    it(`the safety net logs one line for ${label}: ${codes}, no message, no value`, async () => {
      failProjectReads(make());
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      warn.mockClear();
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect((await call("GET", "/projects", { as: "viewer" })).status).toBe(400);
        expect(nulLines(warn)).toHaveLength(1);
        expect(nulLines(warn)[0]).toEqual(["[nul] database refused U+0000 or invalid text", codes]);
        expect(JSON.stringify(nulLines(warn))).not.toMatch(/secret|invocation|Invalid|invalid byte|Unicode/);
        expect(err).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        err.mockRestore();
      }
    });
  }

  it("a database failure that is not about a NUL logs no such line", async () => {
    failProjectReads(Object.assign(new Error("down"), { code: "P1001" }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await call("GET", "/projects", { as: "viewer" })).status).toBe(500);
      expect(nulLines(warn)).toHaveLength(0);
    } finally {
      warn.mockRestore();
      quiet.mockRestore();
    }
  });
});
