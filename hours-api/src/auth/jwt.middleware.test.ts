/**
 * The REAL JWT middleware (ADR-0005/0010): RS256, issuer and audience pinned. Every other
 * test file runs behind the harness's mock of it, so this file imports the real module under
 * a distinct specifier (`?real`) and serves the fixture public key from a stubbed fetch.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { SignJWT, generateKeyPair } from "jose";
import type { JwtVariables } from "./jwt.middleware";
import { setupTestAuth, TEST_AUDIENCE, TEST_ISSUER, TEST_JWKS_URL, TEST_KID, TEST_SERVICE_AUDIENCE } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

// @ts-expect-error — the query string is the point: a distinct module instance, not the mock
const { jwtMiddleware } = (await import("./jwt.middleware.ts?real")) as typeof import("./jwt.middleware");

// Assigned, not `spyOn`: when another test file's world already stubs `fetch`, spyOn returns THAT
// spy, this file's implementation replaces theirs, and mockRestore drops theirs for every file
// after this one. Whatever `fetch` is when these tests start is what goes back afterwards.
let realFetch: typeof fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
    String(url) === TEST_JWKS_URL
      ? Response.json(harness.jwks(), { headers: { "Cache-Control": "max-age=3600" } })
      : realFetch(url as string, init)) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const app = new Hono<{ Variables: JwtVariables }>();
app.use("*", jwtMiddleware);
app.get("/who", (c) => c.json({ sub: c.get("userId"), email: c.get("email"), name: c.get("userName") ?? null }));

const get = (token?: string) => app.request("/who", token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } });

describe("jwtMiddleware (real)", () => {
  it("accepts a token from auth and exposes sub, email and name", async () => {
    const res = await get(await harness.signToken({ sub: "user-1", email: "a@welld.test", name: "Ada" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "user-1", email: "a@welld.test", name: "Ada" });
  });

  it("refuses a missing or malformed Authorization header with 401", async () => {
    expect((await get()).status).toBe(401);
    expect((await app.request("/who", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
    expect((await get("")).status).toBe(401);
    expect((await get("not-a-jwt")).status).toBe(401);
  });

  it("refuses a validly signed token for another audience (ADR-0010)", async () => {
    expect((await get(await harness.signToken({ sub: "user-1", email: "a@welld.test", audience: "another-service" }))).status).toBe(401);
  });

  it("refuses a validly signed token carrying the SERVICE audience: a service credential is not a user (ADR-0044)", async () => {
    expect((await get(await harness.signToken({ sub: "system:hours-api", email: "svc@welld.test", audience: TEST_SERVICE_AUDIENCE }))).status).toBe(401);
  });

  it("refuses a validly signed token from another issuer", async () => {
    expect((await get(await harness.signToken({ sub: "user-1", email: "a@welld.test", issuer: "http://evil.test" }))).status).toBe(401);
  });

  it("refuses an expired token", async () => {
    expect((await get(await harness.signToken({ sub: "user-1", email: "a@welld.test", expiresIn: "-1h" }))).status).toBe(401);
  });

  it("refuses a token signed with a key auth does not publish", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "a@welld.test" })
      .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
      .setIssuer(TEST_ISSUER)
      .setSubject("user-1")
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime("1h")
      .sign(privateKey);
    expect((await get(forged)).status).toBe(401);
  });

  it("refuses an unsigned (alg none) token", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "none" })}.${b64({ sub: "user-1", email: "a@welld.test", iss: TEST_ISSUER, aud: TEST_AUDIENCE })}.`;
    expect((await get(unsigned)).status).toBe(401);
  });
});
