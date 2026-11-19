/**
 * accounting-api's environment schema (T4, specs/20261119-accounting). Each case boots `src/lib/env.ts` in a REAL
 * subprocess, from scratch, with exactly the variables given: `env.ts` validates at import and exits the process on
 * failure, so only a fresh process can prove "starts" and "exits 1 naming the variable". `--no-env-file` keeps a
 * developer's own dotenv file out of the child (it would otherwise define the very variables a case removes).
 */

import { describe, expect, it } from "bun:test";

const VALID: Record<string, string> = {
  DATABASE_URL: "postgresql://user:db-password-1234@localhost:5445/accounting",
  ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_JWKS_URL: "http://localhost:3001/auth/jwks",
  AUTH_ISSUER: "http://localhost:3001",
  AUTH_AUDIENCE: "operai-suite",
  AUTH_BASE_URL: "http://localhost:3001",
  SERVICE_AUDIENCE: "operai-service",
};

async function boot(overrides: Record<string, string | undefined>, print = "") {
  const env: Record<string, string> = { ...VALID, PATH: process.env["PATH"] ?? "" };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `import('./src/lib/env.ts').then((m) => { ${print ? `console.log(JSON.stringify(${print}));` : ""} process.exit(0); })`,
    ],
    cwd: `${import.meta.dir}/../..`,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe("env.ts", () => {
  it("starts with the required variables only, and applies the defaults", async () => {
    const { exitCode, stdout } = await boot({}, "[m.env.PORT, m.env.ACCOUNTING_FX_SOURCE, m.env.NODE_ENV, m.env.ALLOWED_ORIGINS]");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([8089, "bazg", "development", ["http://localhost:5173"]]);
  });

  for (const name of [
    "DATABASE_URL",
    "ALLOWED_ORIGINS",
    "AUTH_JWKS_URL",
    "AUTH_ISSUER",
    "AUTH_AUDIENCE",
    "AUTH_BASE_URL",
    "SERVICE_AUDIENCE",
  ]) {
    it(`exits 1 naming ${name} when it is missing`, async () => {
      const { exitCode, stderr } = await boot({ [name]: undefined });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(name);
    });
  }

  it("exits 1 naming SERVICE_AUDIENCE when it is empty", async () => {
    const { exitCode, stderr } = await boot({ SERVICE_AUDIENCE: "" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SERVICE_AUDIENCE");
  });

  it("exits 1 when SERVICE_AUDIENCE equals AUTH_AUDIENCE (a user JWT must never be a system credential), without echoing the value", async () => {
    const { exitCode, stderr } = await boot({ SERVICE_AUDIENCE: "operai-suite" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SERVICE_AUDIENCE");
    expect(stderr).toContain("must differ from AUTH_AUDIENCE");
    expect(stderr).not.toContain("operai-suite");
  });

  it("exits 1 naming ALLOWED_ORIGINS for a wildcard, also inside a list", async () => {
    for (const origins of ["*", "http://localhost:5173, *"]) {
      const { exitCode, stderr } = await boot({ ALLOWED_ORIGINS: origins });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("ALLOWED_ORIGINS");
    }
  });

  it("exits 1 naming ALLOWED_ORIGINS when it holds only separators", async () => {
    const { exitCode, stderr } = await boot({ ALLOWED_ORIGINS: " , " });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ALLOWED_ORIGINS");
  });

  it("exits 1 naming the variable for a URL that is not one", async () => {
    for (const name of ["AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_BASE_URL"]) {
      const { exitCode, stderr } = await boot({ [name]: "not a url" });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(name);
    }
  });

  it("accepts ACCOUNTING_FX_SOURCE `off` and refuses any other value (the host is a constant, never configuration)", async () => {
    const off = await boot({ ACCOUNTING_FX_SOURCE: "off" }, "m.env.ACCOUNTING_FX_SOURCE");
    expect(off.exitCode).toBe(0);
    expect(JSON.parse(off.stdout)).toBe("off");
    for (const value of ["https://evil.example", "BAZG", "", "on"]) {
      const { exitCode, stderr } = await boot({ ACCOUNTING_FX_SOURCE: value });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("ACCOUNTING_FX_SOURCE");
    }
  });

  it("exits 1 naming PORT for a value that is not a positive integer", async () => {
    for (const value of ["abc", "0", "-1", "80.5"]) {
      const { exitCode, stderr } = await boot({ PORT: value });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("PORT");
    }
  });

  it("never prints a value: a failure on another variable does not echo the database password", async () => {
    const { exitCode, stderr } = await boot({ AUTH_ISSUER: undefined });
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("db-password-1234");
  });
});
