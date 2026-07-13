/**
 * Regression test for a middleware-scoping defect (specs/005-notification-center,
 * ADR-0008): list.routes.ts / raise.routes.ts / markRead.routes.ts each used to
 * register `router.use("*", jwtMiddleware)`. Because index.ts mounts every
 * notifications router at the SAME prefix (`app.route("/", listRouter)` etc.),
 * Hono merges every child router's middleware into ONE flat route table once
 * mounted — a "*" registered on ANY sub-router therefore applied to the WHOLE
 * app, including `GET /notifications/stream`, which per ADR-0008 MUST be
 * reachable WITHOUT a Bearer (EventSource cannot send one; the stream is
 * authed by the query-string ticket instead). That bug made every SSE
 * connection 401 before the ticket was ever consulted.
 *
 * THIS is the regression class a per-router test (list.routes.test.ts,
 * raise.routes.test.ts, markRead.routes.test.ts, stream.routes.test.ts) can
 * NEVER catch: each of those builds its OWN fresh `new Hono()` with only its
 * own router mounted, so a leaking "*" on one router never has a sibling
 * router present to leak onto. Only testing the REAL assembled `app` (as
 * exported from src/index.ts, exactly as it runs in production) exercises the
 * merged route table where the leak actually happens.
 *
 * WHY A SUBPROCESS, NOT `await import("./index")` IN-PROCESS: bun:test shares
 * ONE module registry across every test file in the run (see
 * stream.routes.test.ts's file header on `mock.module()` leaking process-
 * wide). list/raise/markRead/stream .routes.test.ts each `mock.module()` +
 * import ONLY their own router file, so they never collide with each other.
 * But `src/index.ts` imports ALL FOUR router files — whichever test file
 * first pulls one of those files into the shared registry permanently wires
 * whatever `@/auth/jwt.middleware` was live at that moment into that router's
 * `.use()` chain (Hono stores the resolved middleware function in a plain
 * array at registration time; a later `mock.module()` "overwrite" of the
 * export binding does not retroactively rewire an already-registered route).
 * Importing "./index" in-process here previously broke every OTHER
 * notify-api test file that also imports one of those same router files. A
 * real child process gets its own independent module registry, so it
 * exercises the exact production entrypoint (`bun run src/index.ts`, the
 * literal `export default { port, fetch }` Railway/Bun run) with zero
 * interference either direction.
 *
 * No mocking needed for jwt.middleware here: every assertion below only
 * needs the "missing/invalid Bearer → 401" short-circuit, which the REAL
 * jwtMiddleware satisfies without ever calling the (unreachable-in-CI)
 * auth-service JWKS endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

const TEST_PORT = 8179; // distinct from the dev port (8081) and any other fixture port in use
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ReturnType<typeof Bun.spawn> | undefined;

const waitForServer = async (timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any response (even a 401/404) proves the server is accepting connections.
      await fetch(`${BASE_URL}/notifications`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`notify-api did not become reachable on ${BASE_URL} within ${timeoutMs}ms`);
};

beforeAll(async () => {
  serverProcess = Bun.spawn({
    cmd: ["bun", "run", "src/index.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(TEST_PORT), NODE_ENV: "test" },
    stdout: "ignore",
    stderr: "ignore",
  });

  await waitForServer();
});

afterAll(() => {
  serverProcess?.kill();
});

const request = (path: string, init?: RequestInit) => fetch(`${BASE_URL}${path}`, init);

// ─── (a) The SSE stream must NEVER be gated by jwtMiddleware ────────────────

describe("assembled app (real process) — GET /notifications/stream is reachable without a Bearer (ADR-0008)", () => {
  it("no Authorization header, no ticket → the TICKET-validation 401, not jwtMiddleware's Bearer 401", async () => {
    const res = await request("/notifications/stream");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };

    // This is the crux of the regression: before the fix, listRouter's/
    // raiseRouter's/markReadRouter's leaked "*" jwtMiddleware intercepted this
    // request FIRST and returned "A valid Bearer token is required" — the
    // stream route's own ticket check was never reached.
    expect(body.detail).toBe("A stream ticket is required");
    expect(body.detail).not.toBe("A valid Bearer token is required");
  });

  it("no Authorization header, invalid/unknown ticket → the TICKET-validation 401, not jwtMiddleware's Bearer 401", async () => {
    const res = await request("/notifications/stream?ticket=never-minted-xyz");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };

    expect(body.detail).toBe("The stream ticket is invalid, expired, or already used");
    expect(body.detail).not.toBe("A valid Bearer token is required");
  });
});

// ─── (b) Every REST endpoint must STILL require a Bearer ───────────────────

describe("assembled app (real process) — REST endpoints remain Bearer-protected", () => {
  it("GET /notifications with no Authorization header → 401", async () => {
    const res = await request("/notifications");
    expect(res.status).toBe(401);
  });

  it("GET /notifications/unread-count with no Authorization header → 401", async () => {
    const res = await request("/notifications/unread-count");
    expect(res.status).toBe(401);
  });

  it("POST /notifications with no Authorization header → 401", async () => {
    const res = await request("/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", body: "y" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /notifications/mark-all-read with no Authorization header → 401", async () => {
    const res = await request("/notifications/mark-all-read", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /notifications/stream-ticket with no Authorization header → 401", async () => {
    const res = await request("/notifications/stream-ticket", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
