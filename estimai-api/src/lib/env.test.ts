/**
 * Startup-validation tests for the new estimate-sharing environment
 * variables (T5, specs/013-estimate-sharing) — `AUTH_BASE_URL`,
 * `NOTIFY_INTERNAL_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` are REQUIRED
 * (no default; specs/016 AC-4.2 — the service credential replaced the shared
 * notify token);
 * `SHARE_LOOKUP_FLOOR_MS`, `SHARE_ADD_RATE_LIMIT`, `SHARE_ADD_RATE_WINDOW_MS`
 * have defaults and must NOT block boot when absent.
 *
 * Spawned in a REAL subprocess (mirrors refund-api/src/lib/env.test.ts) so
 * this is a true from-scratch boot, immune to `./env`'s module-load-order
 * already having happened via an earlier test file in the same `bun test`
 * process.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";

const BASE_REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://user:pass@localhost:5435/estimai_env_boot_test",
  ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_JWKS_URL: "http://localhost:3001/auth/jwks",
  AUTH_ISSUER: "http://localhost:3001",
  AUTH_AUDIENCE: "operai-suite",
  AUTH_BASE_URL: "http://localhost:3001",
  SERVICE_CLIENT_ID: "estimai-api",
  SERVICE_CLIENT_SECRET: "test-service-client-secret-at-least-32-characters",
  NOTIFY_INTERNAL_URL: "http://localhost:8081",
  NODE_ENV: "test",
};

async function spawnEnvImport(env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      `import(${JSON.stringify(import.meta.dir + "/env.ts")}).then(() => process.exit(0)).catch(() => process.exit(1))`,
    ],
    // Not the service root: Bun auto-loads a dotenv file from the cwd, which
    // would fill in exactly the variables these tests remove, so an "absent"
    // test would pass through on a developer machine.
    cwd: tmpdir(),
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

  // AC-4.2 (specs/016) — each service-credential setting is required, and a
  // deployment without one exits naming it.
  for (const name of ["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"]) {
    it(`exits non-zero naming ${name} when it is absent`, async () => {
      const { [name]: _omit, ...rest } = BASE_REQUIRED_ENV;
      const { exitCode, stderr } = await spawnEnvImport(rest);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(name);
    });
  }

  it("exits non-zero naming SERVICE_CLIENT_ID when it is empty", async () => {
    const { exitCode, stderr } = await spawnEnvImport({
      ...BASE_REQUIRED_ENV,
      SERVICE_CLIENT_ID: "",
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("SERVICE_CLIENT_ID");
  });

  it("exits non-zero naming SERVICE_CLIENT_SECRET when it is under 32 characters, without echoing it", async () => {
    const short = "too-short-secret";
    const { exitCode, stderr } = await spawnEnvImport({
      ...BASE_REQUIRED_ENV,
      SERVICE_CLIENT_SECRET: short,
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("SERVICE_CLIENT_SECRET");
    expect(stderr).not.toContain(short);
  });
});

// AC-5.2 (specs/016) — the retired shared notify token is not a setting this
// service reads, requires or documents; a deployment that still has it set
// starts normally. The name is assembled so this file does not itself contain
// it (the repo-wide scan below would otherwise flag its own test).
const RETIRED_TOKEN = ["NOTIFY", "INTERNAL", "TOKEN"].join("_");

describe("env.ts — the retired shared notify token (AC-5.2, specs/016)", () => {
  it("boots with the retired variable absent", async () => {
    const { exitCode, stderr } = await spawnEnvImport(BASE_REQUIRED_ENV);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("boots with the retired variable still set (a leftover is simply not read), even malformed", async () => {
    for (const value of ["test-notify-internal-token-at-least-32-characters", "short"]) {
      const { exitCode, stderr } = await spawnEnvImport({
        ...BASE_REQUIRED_ENV,
        [RETIRED_TOKEN]: value,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }
  });

  it("appears in no file under src/", async () => {
    const proc = Bun.spawn({
      cmd: ["grep", "-rl", RETIRED_TOKEN, "src"],
      cwd: import.meta.dir + "/../..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("");
  });
});

describe("env.ts — estimate-sharing optional overrides", () => {
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
