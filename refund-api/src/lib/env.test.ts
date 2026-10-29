/**
 * AC-4.1 (specs/011-refund-settings) — refund-api's environment schema no
 * longer declares, requires, or validates `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`
 * (superseded by the admin-managed `accounting-distribution-email`
 * refund_setting, src/settings/). Boot must succeed with the var absent from
 * the environment ENTIRELY — not merely "unused by application code
 * elsewhere" but genuinely never read/validated at startup.
 *
 * Spawned in a REAL subprocess (rather than `import("./env")` in-process) so
 * this is a true from-scratch boot, immune to `./env`'s module-load-order
 * already having happened (and been cached) via some earlier-loaded test
 * file in the same `bun test` process — every other integration test in
 * this suite ALSO now boots without the var (it has been removed from every
 * test file's `process.env[...]` fixture block), but this test is the one
 * direct, unambiguous proof.
 */

import { describe, expect, it } from "bun:test";

const REQUIRED_ENV_WITHOUT_ACCOUNTING_DISTRIBUTION_EMAIL: Record<string, string> = {
  DATABASE_URL: "postgresql://user:pass@localhost:5435/refund_env_boot_test",
  ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_JWKS_URL: "http://localhost:3001/auth/jwks",
  AUTH_ISSUER: "http://localhost:3001",
  AUTH_AUDIENCE: "operai-suite",
  AUTH_BASE_URL: "http://localhost:3001",
  REFUND_S3_ENDPOINT: "https://test.s3.railway-eu-amsterdam.example.com",
  REFUND_S3_REGION: "auto",
  REFUND_S3_EU_ENDPOINT_HOSTS: "s3.railway-eu-amsterdam.example.com",
  REFUND_S3_BUCKET: "test-bucket",
  REFUND_S3_ACCESS_KEY_ID: "test-key",
  REFUND_S3_SECRET_ACCESS_KEY: "test-secret",
  NOTIFY_INTERNAL_TOKEN: "test-notify-internal-token-at-least-32-characters",
  NOTIFY_INTERNAL_URL: "http://localhost:8081",
  SERVICE_CLIENT_ID: "refund-api",
  SERVICE_CLIENT_SECRET: "test-service-client-secret-at-least-32-characters",
  REFUND_APP_BASE_URL: "http://localhost:5173",
  NODE_ENV: "test",
};

describe("env.ts (AC-4.1, specs/011-refund-settings)", () => {
  it("parses successfully with NO REFUND_ACCOUNTING_DISTRIBUTION_EMAIL present at all", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "--no-env-file",
        "-e",
        "import('./src/lib/env.ts').then(() => process.exit(0)).catch(() => process.exit(1))",
      ],
      cwd: import.meta.dir + "/../..",
      env: {
        ...REQUIRED_ENV_WITHOUT_ACCOUNTING_DISTRIBUTION_EMAIL,
        PATH: process.env["PATH"] ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("REFUND_ACCOUNTING_DISTRIBUTION_EMAIL");
  });

  // AC-4.2 (specs/016-notify-service-credentials) — each service-credential
  // setting is required, and a deployment without one exits naming it.
  async function boot(overrides: Record<string, string | undefined>) {
    const env: Record<string, string> = {
      ...REQUIRED_ENV_WITHOUT_ACCOUNTING_DISTRIBUTION_EMAIL,
      PATH: process.env["PATH"] ?? "",
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const proc = Bun.spawn({
      // `--no-env-file`: Bun otherwise auto-loads the dotenv file in the cwd into
      // the child; on a configured machine it defines SERVICE_CLIENT_* and turns
      // every "variable is missing" case into a successful boot (T21, specs/016).
      cmd: [
        "bun",
        "--no-env-file",
        "-e",
        "import('./src/lib/env.ts').then(() => process.exit(0))",
      ],
      cwd: import.meta.dir + "/../..",
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  }

  for (const name of ["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"]) {
    it(`exits naming ${name} when it is missing`, async () => {
      const { exitCode, stderr } = await boot({ [name]: undefined });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(name);
    });
  }

  it("exits naming SERVICE_CLIENT_ID when it is empty", async () => {
    const { exitCode, stderr } = await boot({ SERVICE_CLIENT_ID: "" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SERVICE_CLIENT_ID");
  });

  it("exits naming SERVICE_CLIENT_SECRET when it is shorter than 32 characters, without echoing it", async () => {
    const short = "too-short-secret";
    const { exitCode, stderr } = await boot({ SERVICE_CLIENT_SECRET: short });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SERVICE_CLIENT_SECRET");
    expect(stderr).not.toContain(short);
  });
});
