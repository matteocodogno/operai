/**
 * What the ASSEMBLED app does to every request before a route sees it (specs/029 T10): CORS for the
 * origins that may call it from a browser (hours-ui and admin-ui run inside the shell), the 64 KiB
 * body cap, and the request log that names the method and the path and nothing a person wrote.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MAX_REQUEST_BODY_BYTES, app, call, resetWorld } from "../test-support/world";

beforeEach(resetWorld);

const ALLOWED = "http://localhost:5173";

describe("CORS", () => {
  const preflight = (origin: string, method = "PATCH") =>
    app.request("/time-entries/some-id", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });

  it("answers a preflight from an allowed origin, without a credential, with the methods and headers the API uses", async () => {
    const res = await preflight(ALLOWED);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const methods = res.headers.get("access-control-allow-methods") ?? "";
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) expect(methods).toContain(method);
    const headers = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(headers).toContain("authorization");
    expect(headers).toContain("content-type");
  });

  it("does not let another origin in, on a preflight or on a request", async () => {
    expect((await preflight("http://evil.test")).headers.get("access-control-allow-origin")).toBeNull();
    const res = await call("GET", "/health", { as: null, headers: { Origin: "http://evil.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("marks a request from an allowed origin", async () => {
    const res = await call("GET", "/health", { as: null, headers: { Origin: ALLOWED } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });
});

describe("the 64 KiB body cap", () => {
  const send = (bytes: number, options: { as?: null; declare?: boolean } = {}) =>
    call("POST", "/nothing-here", {
      ...(options.as === null ? { as: null } : {}),
      rawBody: "x".repeat(bytes),
      ...(options.declare ? { headers: { "Content-Length": String(bytes) } } : {}),
    });

  it("is 64 KiB", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(64 * 1024);
  });

  it("refuses a body over the cap with a 413 Problem, whether or not it declares its length", async () => {
    for (const declare of [false, true]) {
      const res = await send(MAX_REQUEST_BODY_BYTES + 1, { declare });
      expect(res.status).toBe(413);
      expect(res.json).toMatchObject({ type: "https://httpstatuses.com/413", title: "Payload Too Large", status: 413, instance: "/nothing-here" });
    }
  });

  it("lets a body of exactly the cap through to the router (here, to a 404)", async () => {
    expect((await send(MAX_REQUEST_BODY_BYTES)).status).toBe(404);
  });

  it("refuses an oversized body before it checks the session: nothing large is read for anyone", async () => {
    expect((await send(MAX_REQUEST_BODY_BYTES + 1, { as: null })).status).toBe(413);
  });
});

describe("the request log", () => {
  let log: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    log = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("names the method, the path and the status, and drops the query string", async () => {
    await call("GET", "/health?userId=user-bob&q=a-private-search", { as: null });
    const lines = log.mock.calls.map((args) => args.join(" "));
    expect(lines.some((line) => /^GET \/health 200 \d+ms$/.test(line))).toBe(true);
    expect(lines.join("\n")).not.toContain("user-bob");
    expect(lines.join("\n")).not.toContain("a-private-search");
  });

  it("never logs a request body (a note is free text about what someone worked on)", async () => {
    await call("POST", "/nothing-here", { body: { note: "a private note about the client" } });
    expect(log.mock.calls.map((args) => args.join(" ")).join("\n")).not.toContain("a private note");
  });
});
