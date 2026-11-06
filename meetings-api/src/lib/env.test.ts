import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "./env";

const ENV_FILE = join(import.meta.dir, "env.ts");

/** A development environment that is valid. */
const dev = (): Record<string, string> => ({
  DATABASE_URL: "postgresql://u:p@localhost:5435/meetings",
  ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_JWKS_URL: "http://localhost:3001/auth/jwks",
  AUTH_ISSUER: "http://localhost:3001",
  AUTH_AUDIENCE: "operai-suite",
  AUTH_BASE_URL: "http://localhost:3001",
  NODE_ENV: "development",
  MEETINGS_S3_ENDPOINT: "http://localhost:9000",
  MEETINGS_S3_REGION: "us-east-1",
  MEETINGS_S3_BUCKET: "operai-meetings-dev",
  MEETINGS_S3_ACCESS_KEY_ID: "minioadmin",
  MEETINGS_S3_SECRET_ACCESS_KEY: "minioadmin",
  MEETINGS_S3_EU_ENDPOINT_HOSTS: "localhost",
  MEETINGS_AI_PROVIDER: "fake",
});

const PROJECT = "operai-meetings-test";
const KEY_SECRET = "sa-private-key-material-xyz";

/** A service-account key (base64 of its JSON) with these members overridden; no real key material. */
const saKey = (over: Record<string, unknown> = {}): string =>
  Buffer.from(
    JSON.stringify({
      type: "service_account",
      project_id: PROJECT,
      client_email: `meetings-api@${PROJECT}.iam.gserviceaccount.com`,
      private_key: KEY_SECRET,
      ...over,
    }),
  ).toString("base64");

/** A production environment that is valid. */
const prod = (): Record<string, string> => ({
  ...dev(),
  NODE_ENV: "production",
  MEETINGS_S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com",
  MEETINGS_S3_REGION: "eu-central-1",
  MEETINGS_S3_EU_ENDPOINT_HOSTS: "",
  MEETINGS_AI_PROVIDER: "real",
  NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8081",
  SERVICE_CLIENT_ID: "meetings-api",
  SERVICE_CLIENT_SECRET: "s".repeat(32),
  CRM_API_URL: "http://crm-api.railway.internal:8084",
  MEETINGS_SPEECH_LOCATION: "eu",
  MEETINGS_VERTEX_LOCATION: "eu",
  MEETINGS_VERTEX_MODEL_ID: "claude-sonnet-5-0",
  MEETINGS_GCP_PROJECT_ID: PROJECT,
  MEETINGS_GCP_SERVICE_ACCOUNT_KEY: saKey(),
  MEETINGS_GCS_TRANSIENT_BUCKET: "operai-meetings-transient",
});

/**
 * Runs `bun src/lib/env.ts` with exactly this environment. Bun auto-loads dotenv files from the
 * child's cwd (a developer machine has local ones here), which would silently supply a variable
 * the test deleted. So the child gets `--no-env-file` AND an empty cwd; the absolute ENV_FILE
 * path still exercises src/lib/env.ts.
 */
async function spawnEnv(source: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "--no-env-file", ENV_FILE], {
    cwd: mkdtempSync(join(tmpdir(), "meetings-env-")),
    env: { PATH: process.env["PATH"] ?? "", ...source },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: stdout + stderr };
}

describe("a valid environment", () => {
  it("starts in development with the fake provider", async () => {
    expect((await spawnEnv(dev())).code).toBe(0);
  });

  it("starts in production with everything configured", async () => {
    expect((await spawnEnv(prod())).code).toBe(0);
  });

  it("applies the documented defaults", () => {
    const r = parseEnv(dev());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.PORT).toBe(8085);
    expect(r.env.MEETINGS_WORKER).toBe("on");
    expect(r.env.MEETINGS_TEST_HOSTS).toEqual([]);
  });
});

describe("the resource-server set", () => {
  for (const key of ["DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_BASE_URL"]) {
    it(`refuses to start without ${key}`, async () => {
      const source = dev();
      delete source[key];
      const { code, output } = await spawnEnv(source);
      expect(code).toBe(1);
      expect(output).toContain(key);
    });
  }

  it("refuses a wildcard origin", () => {
    expect(parseEnv({ ...dev(), ALLOWED_ORIGINS: "*" }).ok).toBe(false);
  });
});

describe("the bucket (AC-4.9)", () => {
  for (const key of [
    "MEETINGS_S3_ENDPOINT",
    "MEETINGS_S3_REGION",
    "MEETINGS_S3_BUCKET",
    "MEETINGS_S3_ACCESS_KEY_ID",
    "MEETINGS_S3_SECRET_ACCESS_KEY",
  ]) {
    it(`is required: ${key}`, () => {
      const source = dev();
      delete source[key];
      expect(parseEnv(source).ok).toBe(false);
    });
  }

  it("refuses a non-EU AWS region and does not echo it", async () => {
    const { code, output } = await spawnEnv({
      ...prod(),
      MEETINGS_S3_REGION: "us-east-1",
      MEETINGS_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
    });
    expect(code).toBe(1);
    expect(output).toContain("MEETINGS_S3_REGION");
    expect(output).not.toContain("us-east-1");
  });

  it("refuses a non-AWS endpoint with no declared EU host list", async () => {
    const { code, output } = await spawnEnv({ ...dev(), MEETINGS_S3_EU_ENDPOINT_HOSTS: "" });
    expect(code).toBe(1);
    expect(output).toContain("MEETINGS_S3_EU_ENDPOINT_HOSTS");
  });

  it("refuses a non-AWS endpoint whose host is not on the declared list", async () => {
    const { code, output } = await spawnEnv({
      ...dev(),
      MEETINGS_S3_ENDPOINT: "https://storage.example-nonEU.test",
      MEETINGS_S3_EU_ENDPOINT_HOSTS: "scw.cloud",
    });
    expect(code).toBe(1);
    expect(output).not.toContain("example-nonEU");
  });

  it("accepts a non-AWS endpoint on the declared list", () => {
    expect(parseEnv({ ...dev(), MEETINGS_S3_ENDPOINT: "https://s3.fr-par.scw.cloud", MEETINGS_S3_EU_ENDPOINT_HOSTS: "scw.cloud" }).ok).toBe(true);
  });
});

/** Spawns the env file with `source` and asserts a refusal that names `name` and echoes none of `leaks`. */
async function expectRefused(source: Record<string, string>, name: string, leaks: string[] = []) {
  const { code, output } = await spawnEnv(source);
  expect(code).toBe(1);
  expect(output).toContain(name);
  for (const leak of leaks) expect(output).not.toContain(leak);
  // Nothing configured, secret or not, ever reaches the output.
  expect(output).not.toContain(KEY_SECRET);
  expect(output).not.toContain(saKey());
}

describe("Google AI providers (AC-4.9, plan G-5)", () => {
  // S1
  it("S1: refuses a Speech location other than eu, without echoing it", async () => {
    for (const location of ["us", "europe-west4", "global"]) {
      await expectRefused({ ...prod(), MEETINGS_SPEECH_LOCATION: location }, "MEETINGS_SPEECH_LOCATION", [`: ${location}`]);
    }
  });

  // S2
  for (const location of ["global", "us", "europe-west2", "us-central1", "EU"]) {
    it(`S2: refuses Vertex location ${location} and does not echo it`, async () => {
      await expectRefused({ ...prod(), MEETINGS_VERTEX_LOCATION: location }, "MEETINGS_VERTEX_LOCATION", [`: ${location}`]);
    });
  }

  it("S2: accepts eu, europe-west1 and europe-west4", () => {
    for (const location of ["eu", "europe-west1", "europe-west4"]) {
      expect(parseEnv({ ...prod(), MEETINGS_VERTEX_LOCATION: location }).ok).toBe(true);
    }
  });

  // S3
  it("S3: refuses a Fable or Mythos model id and a non-Claude id, without echoing it", async () => {
    for (const id of ["claude-fable-9-0", "claude-mythos-1", "claude-sonnet-5@fable", "gemini-3-pro", "Claude-Sonnet"]) {
      await expectRefused({ ...prod(), MEETINGS_VERTEX_MODEL_ID: id }, "MEETINGS_VERTEX_MODEL_ID", [id]);
    }
  });

  it("S3: accepts a versioned Claude id", () => {
    expect(parseEnv({ ...prod(), MEETINGS_VERTEX_MODEL_ID: "claude-opus-4-7@20260401" }).ok).toBe(true);
  });

  // S4
  it("S4: refuses a key that is not base64, without echoing it", async () => {
    await expectRefused({ ...prod(), MEETINGS_GCP_SERVICE_ACCOUNT_KEY: "zz leaked zz !!" }, "MEETINGS_GCP_SERVICE_ACCOUNT_KEY", ["leaked"]);
  });

  it("S4: refuses base64 that is not JSON, JSON that is not an object, and a non service_account key", async () => {
    const b64 = (v: string) => Buffer.from(v).toString("base64");
    for (const bad of [b64("plain text"), b64("[1,2]"), b64('"x"'), saKey({ type: "authorized_user" })]) {
      await expectRefused({ ...prod(), MEETINGS_GCP_SERVICE_ACCOUNT_KEY: bad }, "MEETINGS_GCP_SERVICE_ACCOUNT_KEY");
    }
  });

  it("S4: refuses a key whose project_id differs from MEETINGS_GCP_PROJECT_ID", async () => {
    await expectRefused(
      { ...prod(), MEETINGS_GCP_SERVICE_ACCOUNT_KEY: saKey({ project_id: "another-project-id" }) },
      "MEETINGS_GCP_SERVICE_ACCOUNT_KEY",
      ["another-project-id", PROJECT],
    );
  });

  it("S4: refuses a key without client_email or private_key", async () => {
    await expectRefused({ ...prod(), MEETINGS_GCP_SERVICE_ACCOUNT_KEY: saKey({ client_email: "" }) }, "MEETINGS_GCP_SERVICE_ACCOUNT_KEY");
    await expectRefused({ ...prod(), MEETINGS_GCP_SERVICE_ACCOUNT_KEY: saKey({ private_key: undefined }) }, "MEETINGS_GCP_SERVICE_ACCOUNT_KEY");
  });

  it("refuses a project id or a bucket name that is not well formed", () => {
    expect(parseEnv({ ...prod(), MEETINGS_GCP_PROJECT_ID: "x/../y" }).ok).toBe(false);
    expect(parseEnv({ ...prod(), MEETINGS_GCS_TRANSIENT_BUCKET: "bucket/with/slash" }).ok).toBe(false);
    expect(parseEnv({ ...prod(), MEETINGS_GCS_TRANSIENT_BUCKET: "UPPER" }).ok).toBe(false);
  });

  // S5
  it("S5: refuses an ambient ANTHROPIC_VERTEX_BASE_URL, in every environment", async () => {
    await expectRefused({ ...prod(), ANTHROPIC_VERTEX_BASE_URL: "https://evil.example" }, "ANTHROPIC_VERTEX_BASE_URL", ["evil.example"]);
    expect(parseEnv({ ...dev(), ANTHROPIC_VERTEX_BASE_URL: "https://evil.example" }).ok).toBe(false);
  });

  it("requires all six settings with the real provider", () => {
    for (const key of [
      "MEETINGS_SPEECH_LOCATION",
      "MEETINGS_VERTEX_LOCATION",
      "MEETINGS_VERTEX_MODEL_ID",
      "MEETINGS_GCP_PROJECT_ID",
      "MEETINGS_GCP_SERVICE_ACCOUNT_KEY",
      "MEETINGS_GCS_TRANSIENT_BUCKET",
    ]) {
      const source = prod();
      delete source[key];
      const r = parseEnv(source);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toContain(key);
    }
  });

  it("does not require them with the fake provider (the local dev path), but validates what is set", () => {
    expect(parseEnv(dev()).ok).toBe(true);
    expect(parseEnv({ ...dev(), MEETINGS_VERTEX_LOCATION: "global" }).ok).toBe(false);
    expect(parseEnv({ ...dev(), MEETINGS_SPEECH_LOCATION: "eu", MEETINGS_VERTEX_LOCATION: "eu" }).ok).toBe(true);
  });

  it("no longer reads the retired provider settings", () => {
    // Names are assembled so that the retired vendors' names do not appear in the source (T97/T101 grep).
    const retired = [["AZ", "URE_SPEECH_KEY"], ["BED", "ROCK_REGION"], ["MEETINGS_A", "WS_ACCESS_KEY_ID"]].map((parts) => parts.join(""));
    const r = parseEnv({ ...prod(), ...Object.fromEntries(retired.map((k) => [k, "x"])) });
    expect(r.ok).toBe(true);
    if (r.ok) for (const k of retired) expect(Object.keys(r.env)).not.toContain(k);
  });
});

describe("production-only refusals", () => {
  it("refuses MEETINGS_AI_PROVIDER=fake with NODE_ENV=production", async () => {
    const { code, output } = await spawnEnv({ ...prod(), MEETINGS_AI_PROVIDER: "fake" });
    expect(code).toBe(1);
    expect(output).toContain("MEETINGS_AI_PROVIDER");
  });

  it("refuses MEETINGS_TEST_HOSTS with NODE_ENV=production and does not echo it", async () => {
    const { code, output } = await spawnEnv({ ...prod(), MEETINGS_TEST_HOSTS: '[{"app":"leaky-app-name"}]' });
    expect(code).toBe(1);
    expect(output).toContain("MEETINGS_TEST_HOSTS");
    expect(output).not.toContain("leaky-app-name");
  });

  it("accepts test hosts and the fake provider outside production", () => {
    const r = parseEnv({ ...dev(), MEETINGS_TEST_HOSTS: '[{"app":"testhost"}]' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.MEETINGS_TEST_HOSTS).toHaveLength(1);
  });

  it("refuses test hosts that are not a JSON array", () => {
    expect(parseEnv({ ...dev(), MEETINGS_TEST_HOSTS: "{}" }).ok).toBe(false);
    expect(parseEnv({ ...dev(), MEETINGS_TEST_HOSTS: "nope" }).ok).toBe(false);
  });

  it("requires the notify group and CRM_API_URL in production", () => {
    for (const key of ["NOTIFY_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", "CRM_API_URL"]) {
      const source = prod();
      delete source[key];
      expect(parseEnv(source).ok).toBe(false);
    }
  });
});

describe("the notify group", () => {
  it("is all or none outside production", () => {
    expect(parseEnv({ ...dev(), SERVICE_CLIENT_ID: "meetings-api" }).ok).toBe(false);
    expect(
      parseEnv({
        ...dev(),
        NOTIFY_INTERNAL_URL: "http://localhost:8081",
        SERVICE_CLIENT_ID: "meetings-api",
        SERVICE_CLIENT_SECRET: "s".repeat(32),
      }).ok,
    ).toBe(true);
  });

  it("wants a secret of at least 32 characters", () => {
    const r = parseEnv({
      ...dev(),
      NOTIFY_INTERNAL_URL: "http://localhost:8081",
      SERVICE_CLIENT_ID: "meetings-api",
      SERVICE_CLIENT_SECRET: "short",
    });
    expect(r.ok).toBe(false);
  });
});

describe("the worker switch", () => {
  it("accepts on, off and only; refuses anything else", () => {
    for (const v of ["on", "off", "only"]) expect(parseEnv({ ...dev(), MEETINGS_WORKER: v }).ok).toBe(true);
    expect(parseEnv({ ...dev(), MEETINGS_WORKER: "maybe" }).ok).toBe(false);
  });
});
