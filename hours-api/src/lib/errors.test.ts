/**
 * The error answers every hours-api route shares (specs/20261112-time-tracking T10; plan § Errors): RFC 7807 Problem
 * JSON with a `code`, a schema violation of any kind is 400 `invalid_request` (not the 422 the
 * shared `problem` copy's own hook gives; the 422s of this API are the named rules), and an
 * unexpected fault answers a generic 500 without the database's statement or its parameters.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { handleError, handleNotFound, invalidRequestHook } from "./errors";
import { ProblemError } from "./problem";

/**
 * Only the calls that carry the safety net's own prefix. A spy another test file left on `console.warn` comes back from `spyOn` with
 * that file's calls, and an unrelated warning is not this test's (QE F3): count and read the `[nul]` lines, not the whole log.
 */
const nulLines = (spy: { mock: { calls: unknown[][] } }): unknown[][] =>
  spy.mock.calls.filter((call) => call[0] === "[nul] database refused U+0000 or invalid text");

const body = z.object({ minutes: z.number().int(), note: z.string().optional() }).strict();

const app = new OpenAPIHono({ defaultHook: invalidRequestHook });
app.openapi(
  createRoute({
    method: "post",
    path: "/things",
    request: { body: { content: { "application/json": { schema: body } }, required: true } },
    responses: { 201: { description: "created" } },
  }),
  (c) => c.json({ ok: true }, 201),
);
app.openapi(
  createRoute({
    method: "get",
    path: "/things",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), whose: z.enum(["mine", "all"]).default("mine") }) },
    responses: { 200: { description: "list" } },
  }),
  (c) => c.json({ ok: true }),
);
app.openapi(
  createRoute({
    method: "get",
    path: "/things/{id}",
    request: { params: z.object({ id: z.string().min(1).max(8) }) },
    responses: { 200: { description: "one" } },
  }),
  (c) => c.json({ ok: true }),
);
app.get("/typed", () => {
  throw new ProblemError({ status: 403, code: "owner_only", detail: "Only the author may change it", extras: { entryId: "e1" } });
});
app.get("/boom", () => {
  throw Object.assign(new Error('insert into "time_entry" values (user-1, "a private note")'), { code: "P2010" });
});
// A NUL that reached Postgres (QE D2), in the forms the driver stack gives it: Prisma-wrapped, as the adapter's own error, unwrapped.
const adapterError = { name: "DriverAdapterError", cause: { kind: "postgres", code: "22021", originalCode: "22021" } };
app.get("/nul-wrapped", () => {
  throw Object.assign(new Error("Invalid `db.timeEntry.create()` invocation: note secret-note"), {
    code: "P2039",
    meta: { driverAdapterError: adapterError },
  });
});
app.get("/nul-raw", () => {
  throw Object.assign(new Error("Raw query failed. Code: `22P05` secret-note"), {
    code: "P2010",
    meta: { driverAdapterError: { ...adapterError, cause: { kind: "postgres", code: "22P05", originalCode: "22P05" } } },
  });
});
app.get("/nul-adapter", () => {
  throw Object.assign(new Error("invalid byte sequence for encoding UTF8: 0x00 secret-note"), adapterError);
});
app.get("/nul-pg", () => {
  throw Object.assign(new Error("unsupported Unicode escape sequence secret-note"), { code: "22P05" });
});
app.get("/other-db-failure", () => {
  throw Object.assign(new Error("duplicate"), { code: "P2039", meta: { driverAdapterError: { cause: { code: "23505", originalCode: "23505" } } } });
});
app.onError(handleError);
app.notFound(handleNotFound);

const post = (payload: unknown, raw = false) =>
  app.request("/things", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(payload) : JSON.stringify(payload) });

const PROBLEM_KEYS = ["type", "title", "status", "detail", "instance"];

describe("invalidRequestHook", () => {
  it("answers 400 `invalid_request` Problem JSON for an unknown key in a strict body, naming the key", async () => {
    const res = await post({ minutes: 60, userId: "someone-else" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ type: "https://httpstatuses.com/400", title: "Bad Request", status: 400, code: "invalid_request", instance: "/things" });
    expect(JSON.stringify(json)).toContain("userId");
    for (const key of PROBLEM_KEYS) expect(json).toHaveProperty(key);
  });

  it("answers 400 `invalid_request` for a member of the wrong type, naming the field and listing every problem", async () => {
    const res = await post({ minutes: "sixty", note: 5 });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; field: string; errors: { field: string }[] };
    expect(json.code).toBe("invalid_request");
    expect(json.field).toBe("minutes");
    expect(json.errors.map((e) => e.field).sort()).toEqual(["minutes", "note"]);
  });

  it("answers 400 `invalid_request` for a bad query and for a bad path parameter", async () => {
    for (const path of ["/things?limit=0", "/things?limit=501", "/things?limit=abc", "/things?whose=everyone", "/things/waytoolongid"]) {
      const res = await app.request(path);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
    }
  });

  it("lets a valid request through", async () => {
    expect((await post({ minutes: 60 })).status).toBe(201);
    expect((await app.request("/things?limit=500&whose=all")).status).toBe(200);
  });
});

describe("handleError", () => {
  let errorLog: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errorLog = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorLog.mockRestore());

  it("renders a thrown ProblemError as its own status, code and members", async () => {
    const res = await app.request("/typed");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ status: 403, title: "Forbidden", code: "owner_only", detail: "Only the author may change it", instance: "/typed", entryId: "e1" });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("answers 400 `invalid_request` for a malformed JSON body", async () => {
    const res = await post("{not json", true);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 400, title: "Bad Request", code: "invalid_request", instance: "/things" });
  });

  it("answers an unexpected fault with a generic 500 that carries nothing the fault said", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: 500, title: "Internal Server Error", detail: "An unexpected error occurred", instance: "/boom" });
    expect(text).not.toContain("private note");
    expect(text).not.toContain("time_entry");
  });

  it("logs a fault's name and code only, never its message (it can hold the statement and its parameters)", async () => {
    await app.request("/boom");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorLog.mock.calls[0]);
    expect(logged).toContain("P2010");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("private note");
    expect(logged).not.toContain("time_entry");
  });
});

describe("handleError, a NUL the database refused (QE D2)", () => {
  let errorLog: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errorLog = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorLog.mockRestore());

  for (const path of ["/nul-wrapped", "/nul-raw", "/nul-adapter", "/nul-pg"]) {
    it(`${path} is a 400 \`invalid_request\` that names no value and none of the database's words`, async () => {
      const res = await app.request(path);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ status: 400, title: "Bad Request", code: "invalid_request", instance: path });
      expect(text).not.toMatch(/secret-note|22021|22P05|invalid byte|prisma|UTF8/i);
      expect(errorLog).not.toHaveBeenCalled();
    });
  }

  it("a driver failure that is not about a NUL stays a 500", async () => {
    expect((await app.request("/other-db-failure")).status).toBe(500);
  });
});

// Security review A09: the safety net answers 400 and leaves ONE line, the code(s) only, so a server-built bad value is not blamed on the
// client with no trace. No message, no value, no arguments, no person.
describe("handleError, the line a NUL the database refused leaves behind (A09)", () => {
  let warnLog: ReturnType<typeof spyOn>;
  let errorLog: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnLog = spyOn(console, "warn").mockImplementation(() => {});
    warnLog.mockClear();
    errorLog = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    warnLog.mockRestore();
    errorLog.mockRestore();
  });

  for (const [path, codes] of [
    ["/nul-wrapped", "P2039/22021"],
    ["/nul-raw", "P2010/22P05"],
    ["/nul-adapter", "22021"],
    ["/nul-pg", "22P05"],
  ] as const) {
    it(`${path}: one warning carrying ${codes}, no message, no value`, async () => {
      expect((await app.request(`${path}?q=secret-query`)).status).toBe(400);
      expect(nulLines(warnLog)).toHaveLength(1);
      expect(nulLines(warnLog)[0]).toEqual(["[nul] database refused U+0000 or invalid text", codes]);
      expect(JSON.stringify(nulLines(warnLog))).not.toMatch(/secret|invocation|Invalid|invalid byte|Unicode|Raw query/);
      expect(errorLog).not.toHaveBeenCalled();
    });
  }

  it("a driver failure that is not about a NUL logs no such line", async () => {
    expect((await app.request("/other-db-failure")).status).toBe(500);
    expect(nulLines(warnLog)).toHaveLength(0);
  });
});

describe("handleNotFound", () => {
  it("answers 404 Problem JSON for a path nothing serves", async () => {
    const res = await app.request("/nothing-here");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ type: "https://httpstatuses.com/404", title: "Not Found", status: 404, instance: "/nothing-here" });
  });

  it("answers 404 for a method a path does not serve, naming neither a body nor a query", async () => {
    const res = await app.request("/nothing-here?secret=1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
