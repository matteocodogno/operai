/**
 * The error answers every hours-api route shares (specs/029 T10; plan § Errors): RFC 7807 Problem
 * JSON with a `code`, a schema violation of any kind is 400 `invalid_request` (not the 422 the
 * shared `problem` copy's own hook gives; the 422s of this API are the named rules), and an
 * unexpected fault answers a generic 500 without the database's statement or its parameters.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { handleError, handleNotFound, invalidRequestHook } from "./errors";
import { ProblemError } from "./problem";

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
