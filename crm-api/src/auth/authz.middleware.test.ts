/**
 * The authorization middleware's single flight and the host variant's bounded wait (specs/20261126-teams R13 a, ADR
 * 20261119-on-demand-outbound-work-...). Fail closed throughout: a late, failed or expired answer is a 503, never `next()`.
 *
 * The fake `GET /authz/resolve` is `authzFake` (test-support/world.ts), behind the module's one seam (`authz/resolveClient`).
 * The middleware runs inside a tiny app whose "JWT middleware" copies the verified identity from test headers, so the key
 * `(sub, perm_epoch)` is chosen per request while the forwarded `Authorization` is a real persona token.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { authzFake, bearerFor, installAuthzFake, resetWorld, type PersonaName } from "../test-support/world";
import { HOST_AUTHZ_WAIT_MS } from "../lib/hostBudget";
import { createAuthzMiddleware, hostAuthzMiddleware, type AuthzVariables } from "./authz.middleware";

let reached = 0;
let release: () => void = () => {};
const releases: Array<() => void> = [];

/** Keeps every `/authz/resolve` call unanswered until `release()`. */
function holdResolve(): void {
  authzFake.hold = new Promise<void>((done) => {
    release = done;
  });
  releases.push(release);
}

beforeEach(async () => {
  installAuthzFake();
  await resetWorld();
  reached = 0;
});

// A held flight left over would settle into a later test's cache: every test lets go of what it held.
afterEach(() => {
  for (const done of releases.splice(0)) done();
});

function appWith(middleware: ReturnType<typeof createAuthzMiddleware>) {
  const app = new Hono<{ Variables: AuthzVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", c.req.header("x-sub")!);
    c.set("email", "x@welld.test");
    c.set("permEpoch", Number(c.req.header("x-epoch") ?? 0));
    await next();
  });
  app.get("/probe", middleware, (c) => {
    reached++;
    return c.json({ sub: c.get("userId"), permissions: c.get("authz").permissions.length });
  });
  return app;
}

const SUBS: Record<string, PersonaName> = { "user-consultant": "consultant", "user-colleague": "colleague", "user-admin": "admin" };

async function probe(app: ReturnType<typeof appWith>, sub = "user-consultant", epoch = 0) {
  const res = await app.request("/probe", {
    headers: { Authorization: await bearerFor(SUBS[sub]!), "x-sub": sub, "x-epoch": String(epoch) },
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const settle = () => new Promise<void>((done) => setTimeout(done, 20));

describe("the host variant of the authorization middleware (R13 a)", () => {
  it("answers 503 authz_unavailable once the wait is over, before the resolve answers, and never reaches the handler", async () => {
    const app = appWith(createAuthzMiddleware(50));
    holdResolve();
    const started = Date.now();
    const res = await probe(app);
    expect(res.status).toBe(503);
    expect(res.json.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(400);
    expect(reached).toBe(0);
    expect(authzFake.calls).toBe(1);
  });

  it("does not abort the resolve: its late answer fills the cache and the retry is served with no new call", async () => {
    const app = appWith(createAuthzMiddleware(50));
    holdResolve();
    expect((await probe(app)).status).toBe(503);
    release();
    await settle();
    const retry = await probe(app);
    expect(retry.status).toBe(200);
    expect(retry.json.sub).toBe("user-consultant");
    expect(authzFake.calls).toBe(1);
  });

  it("with the real figure the 503 arrives in [500, 700) ms", async () => {
    const app = appWith(hostAuthzMiddleware);
    holdResolve();
    const started = Date.now();
    const res = await probe(app);
    const took = Date.now() - started;
    expect(res.status).toBe(503);
    expect(took).toBeGreaterThanOrEqual(HOST_AUTHZ_WAIT_MS - 5);
    expect(took).toBeLessThan(700);
  });

  it("serves a cached answer at once, with no wait and no call", async () => {
    const app = appWith(createAuthzMiddleware(50));
    expect((await probe(app)).status).toBe(200);
    holdResolve(); // would hang a second resolve
    const started = Date.now();
    expect((await probe(app)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(40);
    expect(authzFake.calls).toBe(1);
  });

  it("fails closed when the resolve fails: 503 for every waiter, nothing cached, the next request starts a new flight", async () => {
    const host = appWith(createAuthzMiddleware(500));
    const page = appWith(createAuthzMiddleware(null));
    authzFake.delayMs = 30;
    authzFake.fail = true;
    const answers = await Promise.all([probe(host), probe(host), probe(page)]);
    expect(answers.map((a) => a.status)).toEqual([503, 503, 503]);
    expect(reached).toBe(0);
    expect(authzFake.calls).toBe(1); // one flight, shared
    authzFake.fail = false;
    const next = await probe(host);
    expect(next.status).toBe(200);
    expect(authzFake.calls).toBe(2);
  });

  it("never serves an expired entry while the refresh is slow", async () => {
    const app = appWith(createAuthzMiddleware(50));
    let now = 1_700_000_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect((await probe(app)).status).toBe(200);
      now += 30_001; // past the 30 s of the entry
      holdResolve();
      const res = await probe(app);
      expect(res.status).toBe(503);
      expect(reached).toBe(1); // only the first request reached the handler
    } finally {
      clock.mockRestore();
    }
  });
});

describe("one flight per (sub, perm_epoch) (R13 a)", () => {
  it("three concurrent requests of one key, two host and one page, make ONE resolve call; the page request waits for it", async () => {
    const host = appWith(createAuthzMiddleware(50));
    const page = appWith(createAuthzMiddleware(null));
    holdResolve();
    const pending = Promise.all([probe(host), probe(host), probe(page)]);
    setTimeout(() => release(), 150); // the answer arrives after the host wait
    const [h1, h2, p] = await pending;
    expect([h1!.status, h2!.status]).toEqual([503, 503]);
    expect(p!.status).toBe(200);
    expect(authzFake.calls).toBe(1);
  });

  it("a request that arrives while the flight runs joins it with a full wait of its own", async () => {
    const app = appWith(createAuthzMiddleware(200));
    holdResolve();
    const first = probe(app);
    await new Promise<void>((done) => setTimeout(done, 150));
    const second = probe(app); // 150 ms into the flight, its own 200 ms wait ends at 350 ms
    setTimeout(() => release(), 100); // the flight answers at 250 ms: past the first's wait, inside the second's
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(503);
    expect(b.status).toBe(200);
    expect(authzFake.calls).toBe(1);
  });

  it("never shares an answer across people or epochs: a joiner gets the answer for ITS key only", async () => {
    const app = appWith(createAuthzMiddleware(null));
    authzFake.delayMs = 40;
    const [viewer, admin, colleague, viewerEpoch1] = await Promise.all([
      probe(app, "user-consultant", 0),
      probe(app, "user-admin", 0),
      probe(app, "user-colleague", 0),
      probe(app, "user-consultant", 1),
    ]);
    expect(authzFake.calls).toBe(4);
    expect(viewer.json).toEqual({ sub: "user-consultant", permissions: 1 });
    expect(admin.json).toEqual({ sub: "user-admin", permissions: 4 });
    expect(colleague.json.sub).toBe("user-colleague");
    expect(viewerEpoch1.status).toBe(200);
  });

  it("forwards the verified caller's own Authorization header, never another person's", async () => {
    const app = appWith(createAuthzMiddleware(null));
    authzFake.delayMs = 20;
    await Promise.all([probe(app, "user-consultant"), probe(app, "user-admin")]);
    expect(new Set(authzFake.headers)).toEqual(new Set([await bearerFor("consultant"), await bearerFor("admin")]));
  });

  it("the flight is removed when it settles: after the cache entry expires a new request asks again", async () => {
    const app = appWith(createAuthzMiddleware(null));
    let now = 1_700_000_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect((await probe(app)).status).toBe(200);
      now += 30_001;
      expect((await probe(app)).status).toBe(200);
      expect(authzFake.calls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("an answer arriving 4 s after its send is usable until send + 30 s, not until answer + 30 s", async () => {
    const app = appWith(createAuthzMiddleware(null));
    const sentAt = 1_700_000_000_000;
    let now = sentAt;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      holdResolve();
      const first = probe(app);
      await settle(); // the flight is sent
      now = sentAt + 4_000;
      release();
      expect((await first).status).toBe(200);

      now = sentAt + 29_000;
      expect((await probe(app)).status).toBe(200);
      expect(authzFake.calls).toBe(1); // still cached

      now = sentAt + 30_001; // only 26 s after the answer, but past send + 30 s
      expect((await probe(app)).status).toBe(200);
      expect(authzFake.calls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("the page variant of the authorization middleware (unchanged by R13 a)", () => {
  it("waits for the whole flight: an answer after 2 s is a 200", async () => {
    const app = appWith(createAuthzMiddleware(null));
    authzFake.delayMs = 1_200;
    const started = Date.now();
    const res = await probe(app);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_100);
  });

  it("the exported `hostAuthzMiddleware` is the host variant", async () => {
    // a resolve slower than the host wait but inside the test's patience: the host answer is the 503
    const app = appWith(hostAuthzMiddleware);
    authzFake.delayMs = HOST_AUTHZ_WAIT_MS + 200;
    expect((await probe(app)).status).toBe(503);
    await new Promise<void>((done) => setTimeout(done, 300)); // let the run-on flight settle inside this test
  });
});
