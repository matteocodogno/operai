/**
 * Isolation guarantees for the scoped service JWT (specs/015 T6, ADR-0044;
 * env contract changed by specs/016 T3, ADR-0049),
 * each checked in a throwaway subprocess with an explicit, hand-built env so
 * the result cannot depend on this process's env or on test file order.
 *
 *  1. A service token (aud = SERVICE_AUDIENCE) is rejected by the real
 *     jwtMiddleware that guards user routes; a user token with the right
 *     aud is accepted by the same fixture (positive control).
 *  2. env.ts exits non-zero when SERVICE_AUDIENCE equals AUTH_AUDIENCE or is
 *     unset/empty, and starts fine when it differs.
 *  3. NOTIFY_INTERNAL_TOKEN is optional (transition only): env.ts starts with
 *     it present, absent or empty, and still refuses a short value.
 */

import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const ROOT = new URL("../../", import.meta.url).pathname;
const BASE_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "",
  DATABASE_URL: "postgresql://test:test@localhost:5435/test",
  ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_JWKS_URL: "http://localhost:3001/auth/jwks",
  AUTH_ISSUER: "http://localhost:3001",
  AUTH_AUDIENCE: "operai-user-aud",
  SERVICE_AUDIENCE: "operai-system-aud",
  NODE_ENV: "test",
};

const run = async (script: string, env: Record<string, string>, cwd: string) => {
  const proc = Bun.spawn([process.execPath, script], {
    env,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

describe("service JWT vs user routes", () => {
  it("jwtMiddleware rejects a service token and accepts a user token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "iso-kid", alg: "RS256", use: "sig" };
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ keys: [jwk] }, { headers: { "Cache-Control": "max-age=60" } }),
    });
    try {
      const mint = (aud: string, sub: string, extra: Record<string, unknown>) =>
        new SignJWT(extra)
          .setProtectedHeader({ alg: "RS256", kid: "iso-kid" })
          .setIssuedAt()
          .setIssuer(BASE_ENV["AUTH_ISSUER"]!)
          .setAudience(aud)
          .setSubject(sub)
          .setExpirationTime("5m")
          .sign(privateKey);

      const serviceToken = await mint("operai-system-aud", "system:inventory-api", {
        scope: "notifications.push",
        email: "svc@example.com", // even with every claim jwtMiddleware wants
      });
      const userToken = await mint("operai-user-aud", "user-1", { email: "a@example.com" });

      const { stdout, stderr, code } = await run(
        `${ROOT}src/system/userRoute.fixture.ts`,
        {
          ...BASE_ENV,
          AUTH_JWKS_URL: `http://localhost:${server.port}/jwks`,
          SERVICE_AUDIENCE: "operai-system-aud",
          TEST_SERVICE_TOKEN: serviceToken,
          TEST_USER_TOKEN: userToken,
        },
        tmpdir(),
      );
      expect(code, stderr).toBe(0);
      const result = JSON.parse(stdout.match(/RESULT (.*)/)![1]!);
      expect(result).toEqual({ service: 401, user: 200 });
    } finally {
      server.stop(true);
    }
  });
});

describe("SERVICE_AUDIENCE startup validation (env.ts)", () => {
  const load = (extra: Record<string, string>) =>
    run(`${ROOT}src/lib/env.ts`, { ...BASE_ENV, ...extra }, tmpdir());

  it("exits non-zero when it equals AUTH_AUDIENCE", async () => {
    const r = await load({ SERVICE_AUDIENCE: "operai-user-aud" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("SERVICE_AUDIENCE");
  });

  it("starts when it differs from AUTH_AUDIENCE", async () => {
    expect((await load({ SERVICE_AUDIENCE: "operai-system-aud" })).code).toBe(0);
  });

  it("exits non-zero naming it when unset or empty (required since specs/016)", async () => {
    const { SERVICE_AUDIENCE: _omit, ...withoutAudience } = BASE_ENV;
    for (const r of [
      await run(`${ROOT}src/lib/env.ts`, withoutAudience, tmpdir()),
      await load({ SERVICE_AUDIENCE: "" }),
    ]) {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("SERVICE_AUDIENCE");
    }
  });
});

describe("NOTIFY_INTERNAL_TOKEN is optional during the transition (env.ts)", () => {
  const load = (extra: Record<string, string>) =>
    run(`${ROOT}src/lib/env.ts`, { ...BASE_ENV, ...extra }, tmpdir());

  it("starts when present, absent or empty", async () => {
    expect((await load({ NOTIFY_INTERNAL_TOKEN: "x".repeat(40) })).code).toBe(0);
    expect((await load({})).code).toBe(0);
    expect((await load({ NOTIFY_INTERNAL_TOKEN: "" })).code).toBe(0);
  });

  it("still refuses a present-but-short value", async () => {
    const r = await load({ NOTIFY_INTERNAL_TOKEN: "short" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("NOTIFY_INTERNAL_TOKEN");
  });
});
