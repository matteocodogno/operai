/**
 * The global error handler answers a NUL that reached Postgres with a 400 `validation_failed`, never a 500 (specs/20261126-teams QE D2
 * follow-up). Postgres text, and the text inside jsonb, cannot hold U+0000; the request was wrong, not the server. Through the REAL app:
 * a probe route throws the error the driver stack gives for a NUL, the first of them a real one from the real database.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono, type ErrorHandler } from "hono";
import { app } from "../index";
import { db } from "./db";
import { isNulDatabaseError, NUL_REFUSAL_LOG_LINE } from "./nul";

let thrown: unknown;
// The app's own error handler (the one `app.onError` installed in index.ts), on a probe route that throws what the test says. Routes
// and middleware of the app itself (a global JWT check, a maintenance switch) are not in the way.
const probeApp = new Hono();
probeApp.get("/__nul-probe", () => {
  throw thrown;
});
probeApp.onError((app as unknown as { errorHandler: ErrorHandler }).errorHandler);

const adapterError = { name: "DriverAdapterError", cause: { kind: "postgres", code: "22021", originalCode: "22021" } };
const wrapped = (code: string, sqlstate: string) =>
  Object.assign(new Error("Invalid `db.thing.create()` invocation: secret-note"), {
    code,
    meta: { driverAdapterError: { ...adapterError, cause: { kind: "postgres", code: sqlstate, originalCode: sqlstate } } },
  });

/** The very error Prisma throws for a NUL: a real query on the real database, not a look-alike. */
const realNulError = async (): Promise<unknown> => {
  try {
    await db.$queryRaw`select ${"a\u0000b"}::text`;
  } catch (error) {
    return error;
  }
  throw new Error("Postgres accepted a NUL");
};

const probe = async () => {
  const res = await probeApp.request("/__nul-probe");
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

let errorLog: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorLog = spyOn(console, "error").mockImplementation(() => {});
  errorLog.mockClear(); // a spy another file left on `console.error` comes back with that file's calls
});
afterEach(() => errorLog.mockRestore());

describe("a NUL the database refused is a 400, never a 500", () => {
  it("the real error of a real query", async () => {
    thrown = await realNulError();
    expect(isNulDatabaseError(thrown)).toBe(true);
    const res = await probe();
    expect(res.status).toBe(400);
    expect(res.json["code"]).toBe("validation_failed");
    expect(res.json["instance"]).toBe("/__nul-probe");
    expect(res.text).not.toMatch(/22021|invalid byte|prisma|UTF8|select/i);
    expect(errorLog).not.toHaveBeenCalled();
  });

  for (const [label, make] of [
    ["Prisma-wrapped, model query (P2039, 22021)", () => wrapped("P2039", "22021")],
    ["Prisma-wrapped, raw query on jsonb (P2010, 22P05)", () => wrapped("P2010", "22P05")],
    ["the driver adapter's own error", () => Object.assign(new Error("invalid byte sequence secret-note"), adapterError)],
    ["unwrapped from pg", () => Object.assign(new Error("unsupported Unicode escape sequence secret-note"), { code: "22P05" })],
  ] as const) {
    it(`${label}: 400 \`validation_failed\`, nothing of the request or the database in the answer`, async () => {
      thrown = make();
      const res = await probe();
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ status: 400, title: "Bad Request", code: "validation_failed" });
      expect(res.text).not.toMatch(/secret-note|22021|22P05|invalid byte|prisma|UTF8/i);
    });
  }

  it("a database failure that is not about a NUL stays a 500", async () => {
    thrown = wrapped("P2039", "23505");
    expect((await probe()).status).toBe(500);
    thrown = Object.assign(new Error("down"), { code: "P1001" });
    expect((await probe()).status).toBe(500);
  });

  it("does not take a message for a code", () => {
    expect(isNulDatabaseError(new Error("invalid byte sequence for encoding UTF8: 0x00 (22021)"))).toBe(false);
    expect(isNulDatabaseError(null)).toBe(false);
    expect(isNulDatabaseError("22021")).toBe(false);
  });
});

describe("the safety net leaves one line, with the code and nothing else (security review A09)", () => {
  let warnLog: ReturnType<typeof spyOn>;
  beforeEach(() => {
    // Another file may have left a spy on `console.warn`; `spyOn` then hands it back with that file's calls. Start from none.
    warnLog = spyOn(console, "warn").mockImplementation(() => {});
    warnLog.mockClear();
  });
  afterEach(() => warnLog.mockRestore());

  /** Only the calls that carry the safety net's own prefix: a warning from anything else running meanwhile is not this test's. */
  const nulWarnings = () => warnLog.mock.calls.filter((call: unknown[]) => call[0] === NUL_REFUSAL_LOG_LINE);

  const leaky = (code: string, sqlstate: string) =>
    Object.assign(wrapped(code, sqlstate), { meta: { target: ["secret-value"], args: { data: "secret-value" }, driverAdapterError: { ...adapterError, message: "secret-note", cause: { kind: "postgres", code: sqlstate, originalCode: sqlstate, message: "secret-note" } } } });

  for (const [label, make, codes] of [
    ["Prisma-wrapped, model query", () => leaky("P2039", "22021"), "P2039/22021"],
    ["Prisma-wrapped, raw query on jsonb", () => leaky("P2010", "22P05"), "P2010/22P05"],
    ["the driver adapter's own error", () => Object.assign(new Error("invalid byte sequence secret-note"), adapterError), "22021"],
    ["unwrapped from pg", () => Object.assign(new Error("unsupported Unicode escape sequence secret-note"), { code: "22P05" }), "22P05"],
  ] as const) {
    it(`${label}: one warning carrying ${codes}, no message, no value`, async () => {
      thrown = make();
      expect((await probe()).status).toBe(400);
      const nulLines = nulWarnings();
      expect(nulLines).toHaveLength(1);
      expect(nulLines[0]).toEqual(["[nul] database refused U+0000 or invalid text", codes]);
      expect(JSON.stringify(nulLines)).not.toMatch(/secret|invocation|Invalid|invalid byte|Unicode/);
      expect(errorLog).not.toHaveBeenCalled();
    });
  }

  it("a database failure that is not about a NUL logs no such line", async () => {
    thrown = wrapped("P2039", "23505");
    expect((await probe()).status).toBe(500);
    expect(nulWarnings()).toHaveLength(0);
  });
});
