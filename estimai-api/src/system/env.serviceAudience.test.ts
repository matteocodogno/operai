/**
 * `SERVICE_AUDIENCE` (specs/022 T2, ADR-0061): the `aud` of the service JWTs accepted on
 * `/system/*`. Optional (unset → every `/system/*` request is a 401, fail closed) but never
 * equal to AUTH_AUDIENCE, or a user JWT would pass for a system credential.
 *
 * Spawned in a real subprocess, like env.test.ts: a from-scratch boot, immune to the module
 * cache of the other test files.
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
      "--no-env-file",
      "-e",
      `import(${JSON.stringify(import.meta.dir + "/../lib/env.ts")}).then(() => process.exit(0)).catch(() => process.exit(1))`,
    ],
    cwd: tmpdir(),
    env: { ...env, PATH: process.env["PATH"] ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

describe("env.ts — SERVICE_AUDIENCE", () => {
  it("boots without it (the /system/* routes then fail closed)", async () => {
    const { exitCode } = await spawnEnvImport(BASE_REQUIRED_ENV);
    expect(exitCode).toBe(0);
  });

  it("boots with an audience of its own", async () => {
    const { exitCode } = await spawnEnvImport({ ...BASE_REQUIRED_ENV, SERVICE_AUDIENCE: "operai-system" });
    expect(exitCode).toBe(0);
  });

  it("refuses to start with SERVICE_AUDIENCE equal to AUTH_AUDIENCE, naming the variable", async () => {
    const { exitCode, stderr } = await spawnEnvImport({ ...BASE_REQUIRED_ENV, SERVICE_AUDIENCE: "operai-suite" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SERVICE_AUDIENCE");
  });

  it("refuses to start with an empty SERVICE_AUDIENCE", async () => {
    const { exitCode, stderr } = await spawnEnvImport({ ...BASE_REQUIRED_ENV, SERVICE_AUDIENCE: "" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SERVICE_AUDIENCE");
  });
});
