/**
 * Startup-validation tests for the new estimate-sharing environment
 * variables (T5, specs/013-estimate-sharing) — `AUTH_BASE_URL`,
 * `NOTIFY_INTERNAL_URL`, `NOTIFY_INTERNAL_TOKEN` are REQUIRED (no default);
 * `SHARE_LOOKUP_FLOOR_MS`, `SHARE_ADD_RATE_LIMIT`, `SHARE_ADD_RATE_WINDOW_MS`
 * have defaults and must NOT block boot when absent.
 *
 * Spawned in a REAL subprocess (mirrors refund-api/src/lib/env.test.ts) so
 * this is a true from-scratch boot, immune to `./env`'s module-load-order
 * already having happened via an earlier test file in the same `bun test`
 * process.
 */

import { describe, expect, it } from "bun:test";

const BASE_REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://user:pass@localhost:5435/estimai_env_boot_test",
  ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_JWKS_URL: "http://localhost:3001/auth/jwks",
  AUTH_ISSUER: "http://localhost:3001",
  AUTH_AUDIENCE: "operai-suite",
  AUTH_BASE_URL: "http://localhost:3001",
  NOTIFY_INTERNAL_TOKEN: "test-notify-internal-token-at-least-32-characters",
  NOTIFY_INTERNAL_URL: "http://localhost:8081",
  NODE_ENV: "test",
};

async function spawnEnvImport(env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      "import('./src/lib/env.ts').then(() => process.exit(0)).catch(() => process.exit(1))",
    ],
    cwd: import.meta.dir + "/../..",
    env: { ...env, PATH: process.env["PATH"] ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

describe("env.ts — estimate-sharing outbound-client variables (T5, specs/013)", () => {
  it("boots successfully with only the required vars present (all new defaults applied)", async () => {
    const { exitCode, stderr } = await spawnEnvImport(BASE_REQUIRED_ENV);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("exits non-zero with a named message when AUTH_BASE_URL is absent", async () => {
    const { AUTH_BASE_URL: _omit, ...rest } = BASE_REQUIRED_ENV;
    const { exitCode, stderr } = await spawnEnvImport(rest);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("AUTH_BASE_URL");
  });

  it("exits non-zero with a named message when NOTIFY_INTERNAL_URL is absent", async () => {
    const { NOTIFY_INTERNAL_URL: _omit, ...rest } = BASE_REQUIRED_ENV;
    const { exitCode, stderr } = await spawnEnvImport(rest);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("NOTIFY_INTERNAL_URL");
  });

  it("exits non-zero with a named message when NOTIFY_INTERNAL_TOKEN is absent", async () => {
    const { NOTIFY_INTERNAL_TOKEN: _omit, ...rest } = BASE_REQUIRED_ENV;
    const { exitCode, stderr } = await spawnEnvImport(rest);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("NOTIFY_INTERNAL_TOKEN");
  });

  it("exits non-zero with a named message when NOTIFY_INTERNAL_TOKEN is under 32 characters", async () => {
    const { exitCode, stderr } = await spawnEnvImport({
      ...BASE_REQUIRED_ENV,
      NOTIFY_INTERNAL_TOKEN: "too-short",
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("NOTIFY_INTERNAL_TOKEN");
  });

  it("boots with explicit SHARE_LOOKUP_FLOOR_MS / SHARE_ADD_RATE_LIMIT / SHARE_ADD_RATE_WINDOW_MS overrides", async () => {
    const { exitCode, stderr } = await spawnEnvImport({
      ...BASE_REQUIRED_ENV,
      SHARE_LOOKUP_FLOOR_MS: "500",
      SHARE_ADD_RATE_LIMIT: "10",
      SHARE_ADD_RATE_WINDOW_MS: "300000",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
