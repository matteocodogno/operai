/**
 * Startup validation of the service-token env (T4, specs/015-hardware-
 * inventory — ADR-0044): `lib/env.ts` must exit non-zero when
 * `SERVICE_AUDIENCE` equals `AUTH_AUDIENCE`, when clients are configured
 * without an audience, or when `SERVICE_CLIENTS` is malformed — and must never
 * print a secret while doing so.
 *
 * `env.ts` validates at import time and calls `process.exit(1)`, so each case
 * imports it in a fresh `bun` subprocess. The child inherits this process's
 * environment (the `test-setup.ts` preload has already filled in every
 * required variable); only the service-token variables are overridden. Dummy
 * secrets only.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const AUTH_DIR = resolve(import.meta.dir, "../..");
const SECRET = "dummy-startup-secret-0123456789-abcdefg";
const CLIENTS = JSON.stringify({ "inventory-api": { secret: SECRET, scope: "notifications.push" } });

async function importEnv(
  overrides: Record<string, string | undefined>,
): Promise<{ exitCode: number; output: string }> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...process.env,
    SERVICE_AUDIENCE: undefined,
    SERVICE_CLIENTS: undefined,
    ...overrides,
  })) {
    if (value !== undefined) childEnv[key] = value;
  }

  // `--no-env-file`: Bun would otherwise load a developer's local env file from
  // `cwd` and put back the very variables a case removes.
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", 'await import("./src/lib/env"); console.log("ENV_OK");'],
    {
      cwd: AUTH_DIR,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

describe("lib/env.ts — service-token startup validation (ADR-0044)", () => {
  test("starts with neither variable set (no service caller yet)", async () => {
    const { exitCode, output } = await importEnv({});
    expect(exitCode).toBe(0);
    expect(output).toContain("ENV_OK");
  });

  test("starts with a distinct audience and a valid client", async () => {
    const { exitCode, output } = await importEnv({
      SERVICE_AUDIENCE: "operai-service-startup-test",
      SERVICE_CLIENTS: CLIENTS,
    });
    expect(exitCode).toBe(0);
    expect(output).toContain("ENV_OK");
  });

  test("exits non-zero when SERVICE_AUDIENCE equals AUTH_AUDIENCE", async () => {
    const { exitCode, output } = await importEnv({
      SERVICE_AUDIENCE: process.env["AUTH_AUDIENCE"],
      SERVICE_CLIENTS: CLIENTS,
    });
    expect(exitCode).not.toBe(0);
    expect(output).toContain("SERVICE_AUDIENCE must differ from AUTH_AUDIENCE");
    expect(output).not.toContain("ENV_OK");
    expect(output).not.toContain(SECRET);
  });

  test("exits non-zero when SERVICE_AUDIENCE equals AUTH_AUDIENCE even with no clients", async () => {
    const { exitCode } = await importEnv({ SERVICE_AUDIENCE: process.env["AUTH_AUDIENCE"] });
    expect(exitCode).not.toBe(0);
  });

  test("exits non-zero when clients are configured without an audience", async () => {
    const { exitCode, output } = await importEnv({ SERVICE_CLIENTS: CLIENTS });
    expect(exitCode).not.toBe(0);
    expect(output).toContain("SERVICE_AUDIENCE is required");
    expect(output).not.toContain(SECRET);
  });

  test("exits non-zero on a malformed SERVICE_CLIENTS and never prints the secret", async () => {
    for (const bad of [
      "{not json",
      JSON.stringify({ "inventory-api": { secret: SECRET, scope: "email.send" } }),
      JSON.stringify({ "inventory-api": { secret: "short", scope: "notifications.push" } }),
    ]) {
      const { exitCode, output } = await importEnv({
        SERVICE_AUDIENCE: "operai-service-startup-test",
        SERVICE_CLIENTS: bad,
      });
      expect(exitCode).not.toBe(0);
      expect(output).toContain("SERVICE_CLIENTS");
      expect(output).not.toContain(SECRET);
    }
  });
});
