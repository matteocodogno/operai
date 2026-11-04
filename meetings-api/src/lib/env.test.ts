import { describe, expect, it } from "bun:test";
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
  AZURE_SPEECH_REGION: "westeurope",
  AZURE_SPEECH_KEY: "azure-key-value",
  BEDROCK_REGION: "eu-central-2",
  BEDROCK_MODEL_ID: "eu.anthropic.claude-model-v1:0",
  MEETINGS_AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  MEETINGS_AWS_SECRET_ACCESS_KEY: "aws-secret-value",
});

/** Runs `bun src/lib/env.ts` with exactly this environment. */
async function spawnEnv(source: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, ENV_FILE], {
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

describe("transcription (AC-4.9)", () => {
  it("refuses an Azure region outside the EU and Switzerland, without echoing it", async () => {
    const { code, output } = await spawnEnv({ ...prod(), AZURE_SPEECH_REGION: "eastus" });
    expect(code).toBe(1);
    expect(output).toContain("AZURE_SPEECH_REGION");
    expect(output).not.toContain("eastus");
  });

  it("refuses an endpoint that does not match the region", async () => {
    const { code, output } = await spawnEnv({
      ...prod(),
      AZURE_SPEECH_ENDPOINT: "https://eastus.api.cognitive.microsoft.com",
    });
    expect(code).toBe(1);
    expect(output).toContain("AZURE_SPEECH_ENDPOINT");
  });

  it("accepts a matching endpoint", () => {
    expect(parseEnv({ ...prod(), AZURE_SPEECH_ENDPOINT: "https://westeurope.api.cognitive.microsoft.com" }).ok).toBe(true);
  });

  it("requires the Azure region and key with the real provider", () => {
    for (const key of ["AZURE_SPEECH_REGION", "AZURE_SPEECH_KEY"]) {
      const source = prod();
      delete source[key];
      expect(parseEnv(source).ok).toBe(false);
    }
  });

  it("never echoes the key", async () => {
    const { output } = await spawnEnv({ ...prod(), AZURE_SPEECH_REGION: "eastus" });
    expect(output).not.toContain("azure-key-value");
  });
});

describe("language model (AC-4.9)", () => {
  for (const region of ["eu-west-2", "us-east-1"]) {
    it(`refuses Bedrock region ${region} and does not echo it`, async () => {
      const { code, output } = await spawnEnv({ ...prod(), BEDROCK_REGION: region });
      expect(code).toBe(1);
      expect(output).toContain("BEDROCK_REGION");
      expect(output).not.toContain(region);
    });
  }

  it("requires the Bedrock settings and AWS credentials with the real provider", () => {
    for (const key of ["BEDROCK_REGION", "BEDROCK_MODEL_ID", "MEETINGS_AWS_ACCESS_KEY_ID", "MEETINGS_AWS_SECRET_ACCESS_KEY"]) {
      const source = prod();
      delete source[key];
      expect(parseEnv(source).ok).toBe(false);
    }
  });

  it("does not require provider settings with the fake provider", () => {
    expect(parseEnv(dev()).ok).toBe(true);
  });

  it("never echoes the AWS secret", async () => {
    const { output } = await spawnEnv({ ...prod(), BEDROCK_REGION: "us-east-1" });
    expect(output).not.toContain("aws-secret-value");
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
