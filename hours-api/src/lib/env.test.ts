/**
 * `parseEnv` and the start-up refusal (specs/029 T10): every variable of plan § Components is
 * required, the service credential is a pair, the service audience differs from the user
 * audience, and no message ever carries a received value (secrets live in this environment).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "./env";

const SECRET = "t".repeat(40);

const BASE = {
  DATABASE_URL: "postgresql://u:p@localhost:5435/hours",
  ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_JWKS_URL: "http://localhost:3001/auth/jwks",
  AUTH_ISSUER: "http://localhost:3001",
  AUTH_AUDIENCE: "operai-suite",
  AUTH_BASE_URL: "http://localhost:3001",
  PROJECTS_API_URL: "http://localhost:8086",
  CRM_API_URL: "http://localhost:8084",
  ACTIVITIES_API_URL: "http://localhost:8087",
  MEETINGS_API_URL: "http://localhost:8085",
  SERVICE_CLIENT_ID: "hours-api",
  SERVICE_CLIENT_SECRET: SECRET,
  SERVICE_AUDIENCE: "operai-services",
} as const;

const REQUIRED = Object.keys(BASE) as Array<keyof typeof BASE>;

describe("parseEnv", () => {
  it("accepts the full set and defaults the port to 8088 and the environment to development", () => {
    const result = parseEnv(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.PORT).toBe(8088);
    expect(result.env.NODE_ENV).toBe("development");
    expect(result.env.PROJECTS_API_URL).toBe("http://localhost:8086");
    expect(result.env.SERVICE_AUDIENCE).toBe("operai-services");
  });

  it("reads the port and the environment when they are set", () => {
    const result = parseEnv({ ...BASE, PORT: "9001", NODE_ENV: "production" });
    expect(result.ok).toBe(true);
    if (result.ok) expect([result.env.PORT, result.env.NODE_ENV]).toEqual([9001, "production"]);
  });

  for (const key of REQUIRED) {
    it(`refuses a missing ${key}, naming only that variable`, () => {
      const { [key]: _omitted, ...rest } = BASE;
      const result = parseEnv(rest);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(Object.keys(result.errors)).toEqual([key]);
    });
  }

  for (const key of ["AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_BASE_URL", "PROJECTS_API_URL", "CRM_API_URL", "ACTIVITIES_API_URL", "MEETINGS_API_URL"] as const) {
    it(`refuses a malformed ${key}, without echoing the value`, () => {
      const result = parseEnv({ ...BASE, [key]: "not a url" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(Object.keys(result.errors)).toEqual([key]);
        expect(JSON.stringify(result.errors)).not.toContain("not a url");
      }
    });
  }

  it("refuses an empty ALLOWED_ORIGINS and a wildcard one", () => {
    expect(parseEnv({ ...BASE, ALLOWED_ORIGINS: " , " }).ok).toBe(false);
    expect(parseEnv({ ...BASE, ALLOWED_ORIGINS: "http://localhost:5173,*" }).ok).toBe(false);
  });

  it("splits ALLOWED_ORIGINS on commas and trims each", () => {
    const result = parseEnv({ ...BASE, ALLOWED_ORIGINS: "http://a.test , http://b.test" });
    expect(result.ok && result.env.ALLOWED_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
  });

  it("refuses a service secret shorter than 32 characters, without echoing it", () => {
    const result = parseEnv({ ...BASE, SERVICE_CLIENT_SECRET: "short-secret" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual(["SERVICE_CLIENT_SECRET"]);
      expect(JSON.stringify(result.errors)).not.toContain("short-secret");
    }
  });

  it("refuses a SERVICE_AUDIENCE equal to AUTH_AUDIENCE (ADR-0044) and accepts a different one", () => {
    const same = parseEnv({ ...BASE, SERVICE_AUDIENCE: BASE.AUTH_AUDIENCE });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(Object.keys(same.errors)).toEqual(["SERVICE_AUDIENCE"]);
    expect(parseEnv({ ...BASE, SERVICE_AUDIENCE: "operai-services-2" }).ok).toBe(true);
  });

  it("refuses an unknown NODE_ENV and a non-numeric or non-positive PORT", () => {
    expect(parseEnv({ ...BASE, NODE_ENV: "staging" }).ok).toBe(false);
    expect(parseEnv({ ...BASE, PORT: "eight" }).ok).toBe(false);
    expect(parseEnv({ ...BASE, PORT: "0" }).ok).toBe(false);
  });
});

/**
 * The example file is the contract a person copies into their direnv file, so it must list exactly
 * the variables `env.ts` reads: one `env.ts` requires and the example forgets is a service that will
 * not start, one the example lists and `env.ts` ignores is a setting that does nothing.
 */
describe("hours-api/.env.example", () => {
  const example = readFileSync(join(import.meta.dir, "..", "..", ".env.example"), "utf8");
  const listed = example
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf("=")))
    .sort();
  const withDefaults = ["NODE_ENV", "PORT"];
  const failure = parseEnv({});
  const required = failure.ok ? [] : Object.keys(failure.errors);

  it("sets every variable env.ts requires, and the two it defaults, and nothing else", () => {
    expect(required).toHaveLength(13);
    expect(listed).toEqual([...required, ...withDefaults].sort());
  });

  it("shows the local defaults: port 8088 and the `hours` database", () => {
    expect(example).toContain("PORT=8088");
    expect(example).toContain("localhost:5435/hours\n");
  });
});

/**
 * The module itself, in a process of its own: `src/lib/env` validates at import and exits 1, and a
 * unit test of `parseEnv` cannot see the exit. The child runs from an empty directory so no `.env`
 * file next to the service can fill in a variable the test left out.
 */
describe("importing src/lib/env", () => {
  const ENV_MODULE = join(import.meta.dir, "env.ts");
  const cwd = mkdtempSync(join(tmpdir(), "hours-env-"));

  function load(vars: Record<string, string | undefined>) {
    const clean: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
    for (const [key, value] of Object.entries(vars)) if (value !== undefined) clean[key] = value;
    const child = Bun.spawnSync([process.execPath, "-e", `import ${JSON.stringify(ENV_MODULE)}`], { cwd, env: clean });
    return { code: child.exitCode, stderr: child.stderr.toString(), stdout: child.stdout.toString() };
  }

  it("starts when every variable is set", () => {
    expect(load(BASE).code).toBe(0);
  });

  it("exits 1 on a missing variable, naming it and never echoing a secret", () => {
    const { SERVICE_AUDIENCE: _omitted, ...rest } = BASE;
    const out = load(rest);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("SERVICE_AUDIENCE");
    expect(out.stderr + out.stdout).not.toContain(SECRET);
  });

  it("exits 1 when SERVICE_AUDIENCE equals AUTH_AUDIENCE", () => {
    const out = load({ ...BASE, SERVICE_AUDIENCE: BASE.AUTH_AUDIENCE });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("SERVICE_AUDIENCE must differ from AUTH_AUDIENCE");
  });
});
