/**
 * The credential gate of the ASSEMBLED app (specs/029 T10; AC-5.3, AC-5.1): `GET /health` and the
 * API documents answer anyone; every other path needs a valid session, and "every other path"
 * includes one nothing serves, so a route added later without its own check is still refused
 * (default-deny), and the answer does not tell a caller which paths exist. A session needs
 * nothing else: any active user records and reads their own hours (AC-5.1).
 *
 * The JWT middleware is mocked by the harness (the same RS256, issuer and audience rules); the REAL
 * one is proved in jwt.middleware.test.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, resetWorld } from "../test-support/world";
import { setupTestAuth, TEST_AUDIENCE, TEST_ISSUER, TEST_SERVICE_AUDIENCE } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

/** A validly SIGNED token with at most one wrong claim: the test names only the claim it breaks. */
const harnessToken = (over: { sub?: string; audience?: string; issuer?: string; expiresIn?: string } = {}) =>
  harness.signToken({
    sub: over.sub ?? "user-alice",
    email: `${over.sub ?? "user-alice"}@welld.test`,
    ...(over.audience !== undefined ? { audience: over.audience } : {}),
    ...(over.issuer !== undefined ? { issuer: over.issuer } : {}),
    ...(over.expiresIn !== undefined ? { expiresIn: over.expiresIn } : {}),
  });

beforeEach(resetWorld);

const PROBLEM_KEYS = ["type", "title", "status", "detail", "instance"];

describe("public routes", () => {
  it("answers /health, /openapi.json and /docs without a credential", async () => {
    expect((await call("GET", "/health", { as: null })).status).toBe(200);
    const doc = await call("GET", "/openapi.json", { as: null });
    expect(doc.status).toBe(200);
    expect(doc.json.openapi).toBe("3.1.0");
    expect((await call("GET", "/docs", { as: null })).status).toBe(200);
  });
});

describe("every other path, without a session (AC-5.3)", () => {
  const PATHS: Array<[string, string]> = [
    ["GET", "/time-entries"],
    ["POST", "/time-entries"],
    ["PATCH", "/time-entries/some-id"],
    ["DELETE", "/time-entries/some-id"],
    ["GET", "/time-entries/totals"],
    ["GET", "/time-lists"],
    ["POST", "/time-categories"],
    ["PATCH", "/work-types/some-id"],
    // Paths nothing serves: refused the same way, so a probe learns nothing about the route table.
    ["GET", "/nothing-here"],
    ["DELETE", "/time-categories/some-id"],
    ["GET", "/"],
    ["GET", "/health/extra"],
  ];

  for (const [method, path] of PATHS) {
    it(`${method} ${path} without a credential is a 401 Problem`, async () => {
      const res = await call(method, path, { as: null });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("json");
      expect(res.json).toMatchObject({ type: "https://httpstatuses.com/401", title: "Unauthorized", status: 401, instance: path });
      for (const key of PROBLEM_KEYS) expect(res.json).toHaveProperty(key);
    });
  }

  it("answers a malformed Authorization header, a non-Bearer one and garbage with the same 401", async () => {
    const bodies = new Set<string>();
    for (const headers of [{ Authorization: "Basic abc" }, { Authorization: "Bearer" }, { Authorization: "Bearer not-a-jwt" }, {}]) {
      const res = await call("GET", "/time-entries", { as: null, headers });
      expect(res.status).toBe(401);
      bodies.add(res.json.detail);
    }
    expect(bodies.size).toBeLessThanOrEqual(2); // "a valid Bearer token is required" / "invalid or expired"
  });
});

describe("a token that is not a valid user session (AC-5.3, ADR-0010, ADR-0044)", () => {
  const refused = async (token: string) => (await call("GET", "/time-entries", { as: null, headers: { Authorization: `Bearer ${token}` } })).status;

  it("refuses a validly signed token whose audience is not AUTH_AUDIENCE", async () => {
    expect(await refused(await harnessToken({ audience: "another-service" }))).toBe(401);
  });

  it("refuses a service credential: a token with the SERVICE audience is not a user", async () => {
    expect(await refused(await harnessToken({ audience: TEST_SERVICE_AUDIENCE, sub: "system:crm-api" }))).toBe(401);
  });

  it("refuses a validly signed token from another issuer, and an expired one", async () => {
    expect(await refused(await harnessToken({ issuer: "http://evil.test" }))).toBe(401);
    expect(await refused(await harnessToken({ expiresIn: "-1h" }))).toBe(401);
  });

  it("accepts a token with the user audience and issuer", async () => {
    // Nothing serves /time-entries yet at this task: past the gate the answer is the 404 of an unknown path.
    const token = await harnessToken({ audience: TEST_AUDIENCE, issuer: TEST_ISSUER });
    expect(await refused(token)).not.toBe(401);
  });
});

describe("past the gate", () => {
  it("answers a path nothing serves with a 404 Problem, for any signed-in user and no grant (AC-5.1)", async () => {
    const res = await call("GET", "/nothing-here", { as: "alice" });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ type: "https://httpstatuses.com/404", title: "Not Found", status: 404, instance: "/nothing-here" });
  });
});
