import { afterAll, describe, expect, it } from "bun:test";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketLifecycleCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { MAX_RETENTION_DAYS, checkBedrock, checkBucket, isInferenceProfileId, type BedrockControl } from "./startupChecks";

// AC-4.4 / ADR-0063: the 30-day deletion is the bucket's own lifecycle rule, so
// the service refuses to start unless that rule is verifiably there.

type Versioning = { Status?: string } | Error;
type Lifecycle = { Rules: LifecycleRule[] } | Error;

function scripted(lifecycle: Lifecycle, versioning: Versioning): S3Client {
  return {
    send: async (command: { constructor: { name: string } }) => {
      const result = command.constructor.name === "GetBucketLifecycleConfigurationCommand" ? lifecycle : versioning;
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as S3Client;
}

const rule = (overrides: Partial<LifecycleRule> = {}): LifecycleRule => ({
  ID: "expire-all",
  Status: "Enabled",
  Filter: {},
  Expiration: { Days: 29 },
  ...overrides,
});

const ok: Versioning = {};

describe("lifecycle rule", () => {
  it("passes with one enabled, unfiltered rule expiring at 29 days and no versioning", async () => {
    expect(await checkBucket(scripted({ Rules: [rule()] }, ok), "b")).toEqual([]);
    expect(MAX_RETENTION_DAYS).toBe(29);
  });

  it("passes with a shorter retention, an empty-prefix filter or a legacy empty prefix", async () => {
    expect(await checkBucket(scripted({ Rules: [rule({ Expiration: { Days: 7 } })] }, ok), "b")).toEqual([]);
    expect(await checkBucket(scripted({ Rules: [rule({ Filter: { Prefix: "" } })] }, ok), "b")).toEqual([]);
    expect(await checkBucket(scripted({ Rules: [{ Status: "Enabled", Prefix: "", Expiration: { Days: 29 } }] }, ok), "b")).toEqual([]);
  });

  it("passes when one rule among several qualifies", async () => {
    const rules = [rule({ ID: "a", Filter: { Prefix: "tmp/" } }), rule({ ID: "b" })];
    expect(await checkBucket(scripted({ Rules: rules }, ok), "b")).toEqual([]);
  });

  it("refuses a bucket with no lifecycle configuration", async () => {
    const none = Object.assign(new Error("none"), { name: "NoSuchLifecycleConfiguration" });
    const problems = await checkBucket(scripted(none, ok), "b");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/lifecycle/i);
  });

  it("refuses a rule with Days: 30 (the object must be gone within 30 days)", async () => {
    const problems = await checkBucket(scripted({ Rules: [rule({ Expiration: { Days: 30 } })] }, ok), "b");
    expect(problems).toHaveLength(1);
  });

  it("refuses a prefix-filtered rule: it would leave other prefixes forever", async () => {
    for (const filter of [{ Prefix: "meetings/" }, { Prefix: "chunks/" }]) {
      expect(await checkBucket(scripted({ Rules: [rule({ Filter: filter })] }, ok), "b")).toHaveLength(1);
    }
    expect(await checkBucket(scripted({ Rules: [{ Status: "Enabled", Prefix: "meetings/", Expiration: { Days: 29 } }] }, ok), "b")).toHaveLength(1);
  });

  it("refuses any other filter: tag, size bounds, And", async () => {
    for (const filter of [
      { Tag: { Key: "k", Value: "v" } },
      { ObjectSizeGreaterThan: 1 },
      { ObjectSizeLessThan: 1_000_000 },
      { And: { Prefix: "", Tags: [{ Key: "k", Value: "v" }] } },
    ]) {
      expect(await checkBucket(scripted({ Rules: [rule({ Filter: filter })] }, ok), "b")).toHaveLength(1);
    }
  });

  it("refuses a disabled rule, a date-based expiration and a rule that only removes delete markers", async () => {
    expect(await checkBucket(scripted({ Rules: [rule({ Status: "Disabled" })] }, ok), "b")).toHaveLength(1);
    expect(await checkBucket(scripted({ Rules: [rule({ Expiration: { Date: new Date("2030-01-01") } })] }, ok), "b")).toHaveLength(1);
    expect(await checkBucket(scripted({ Rules: [rule({ Expiration: { ExpiredObjectDeleteMarker: true } })] }, ok), "b")).toHaveLength(1);
    expect(await checkBucket(scripted({ Rules: [rule({ Expiration: { Days: 0 } })] }, ok), "b")).toHaveLength(1);
  });

  it("refuses when the configuration cannot be read at all (fail closed)", async () => {
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied" });
    expect(await checkBucket(scripted(denied, ok), "b")).toHaveLength(1);
  });
});

describe("versioning", () => {
  it("refuses Enabled: a versioned delete is not irrecoverable", async () => {
    const problems = await checkBucket(scripted({ Rules: [rule()] }, { Status: "Enabled" }), "b");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/versioning/i);
  });

  it("accepts a never-versioned and a suspended bucket", async () => {
    expect(await checkBucket(scripted({ Rules: [rule()] }, {}), "b")).toEqual([]);
    expect(await checkBucket(scripted({ Rules: [rule()] }, { Status: "Suspended" }), "b")).toEqual([]);
  });

  it("refuses when versioning cannot be read (fail closed)", async () => {
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied" });
    expect(await checkBucket(scripted({ Rules: [rule()] }, denied), "b")).toHaveLength(1);
  });

  it("reports both problems together", async () => {
    expect(await checkBucket(scripted({ Rules: [rule({ Expiration: { Days: 30 } })] }, { Status: "Enabled" }), "b")).toHaveLength(2);
  });
});

describe("what a refusal says", () => {
  it("names the check and never the bucket name, the credentials or the error text", async () => {
    const leaky = Object.assign(new Error("secret-error-text for bucket-xyz-secret"), { name: "InternalError" });
    const problems = (await checkBucket(scripted(leaky, { Status: "Enabled" }), "bucket-xyz-secret")).join("\n");
    expect(problems).not.toContain("bucket-xyz-secret");
    expect(problems).not.toContain("secret-error-text");
  });
});

// ─── Bedrock: where the model routes, and that nothing is retained (AC-4.9, ADR-0061) ──────

type Reply = Record<string, unknown> | Error;

/** A control-plane client per region, answering from a script; records who was asked what. */
function bedrockWorld(script: { profile?: Reply; retention?: Record<string, Reply> }) {
  const asked: { region: string; command: string }[] = [];
  const controlFor = (region: string): BedrockControl => ({
    send: async (command: { constructor: { name: string } }) => {
      asked.push({ region, command: command.constructor.name });
      const reply =
        command.constructor.name === "GetInferenceProfileCommand"
          ? script.profile
          : (script.retention ?? {})[region] ?? new Error("no script for this region");
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  });
  return { asked, controlFor };
}

const arnIn = (region: string) => ({ modelArn: `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-test-v1:0` });
const none = { mode: "none" };

describe("which model ids are inference profiles", () => {
  it("recognises geographic and global profile ids and profile ARNs, not plain model ids", () => {
    for (const id of ["eu.anthropic.claude-x-v1:0", "us.anthropic.claude-x", "global.anthropic.claude-x", "apac.anthropic.claude-x"]) {
      expect(isInferenceProfileId(id), id).toBe(true);
    }
    expect(isInferenceProfileId("arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-x")).toBe(true);
    expect(isInferenceProfileId("arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123")).toBe(true);
    expect(isInferenceProfileId("anthropic.claude-x-v1:0")).toBe(false);
    expect(isInferenceProfileId("arn:aws:bedrock:eu-central-2::foundation-model/anthropic.claude-x")).toBe(false);
  });
});

describe("bedrock: inference-profile destinations (AC-4.9)", () => {
  const modelId = "eu.anthropic.claude-test-v1:0";

  it("passes when every destination is in the EU/CH allowlist and retention is none in each", async () => {
    const world = bedrockWorld({
      profile: { models: [arnIn("eu-central-1"), arnIn("eu-west-3"), arnIn("eu-north-1")] },
      retention: { "eu-central-2": none, "eu-central-1": none, "eu-west-3": none, "eu-north-1": none },
    });
    expect(await checkBedrock({ region: "eu-central-2", modelId, controlFor: world.controlFor })).toEqual([]);
    // the home region and EVERY destination region were asked, each once
    expect(world.asked.filter((a) => a.command === "GetAccountDataRetentionCommand").map((a) => a.region).sort()).toEqual([
      "eu-central-1",
      "eu-central-2",
      "eu-north-1",
      "eu-west-3",
    ]);
  });

  it("refuses a profile with a destination in eu-west-2 (London is not EU)", async () => {
    const world = bedrockWorld({
      profile: { models: [arnIn("eu-central-1"), arnIn("eu-west-2")] },
      retention: { "eu-central-2": none, "eu-central-1": none, "eu-west-2": none },
    });
    const problems = await checkBedrock({ region: "eu-central-2", modelId, controlFor: world.controlFor });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/destination/i);
    expect(problems[0]).not.toContain("eu-west-2");
  });

  it("refuses a profile that routes to the US, however it is named", async () => {
    const world = bedrockWorld({ profile: { models: [arnIn("us-east-1")] }, retention: { "eu-central-2": none, "us-east-1": none } });
    expect(await checkBedrock({ region: "eu-central-2", modelId: "eu.anthropic.fake", controlFor: world.controlFor })).toHaveLength(1);
  });

  it("refuses a profile with no destinations, an unparseable ARN or a profile it cannot read (fail closed)", async () => {
    for (const profile of [{ models: [] }, {}, { models: [{ modelArn: "not-an-arn" }] }, { models: [{}] }, new Error("denied")]) {
      const world = bedrockWorld({ profile, retention: { "eu-central-2": none } });
      expect((await checkBedrock({ region: "eu-central-2", modelId, controlFor: world.controlFor })).length, JSON.stringify(profile)).toBeGreaterThan(0);
    }
  });

  it("does not look up a profile for a plain model id", async () => {
    const world = bedrockWorld({ retention: { "eu-central-2": none } });
    expect(await checkBedrock({ region: "eu-central-2", modelId: "anthropic.claude-test-v1:0", controlFor: world.controlFor })).toEqual([]);
    expect(world.asked.map((a) => a.command)).toEqual(["GetAccountDataRetentionCommand"]);
  });
});

describe("bedrock: retention mode (AC-4.9)", () => {
  const plain = "anthropic.claude-test-v1:0";
  const check = (retention: Reply) => checkBedrock({ region: "eu-central-2", modelId: plain, controlFor: bedrockWorld({ retention: { "eu-central-2": retention } }).controlFor });

  it("passes only for none", async () => {
    expect(await check(none)).toEqual([]);
  });

  it("refuses default, inherit, aws_review, provider_data_share and anything unexpected", async () => {
    for (const mode of ["default", "inherit", "aws_review", "provider_data_share", "NONE", "", "no", 0, null]) {
      const problems = await check({ mode });
      expect(problems, String(mode)).toHaveLength(1);
      expect(problems[0]).toMatch(/retention/i);
    }
    expect(await check({})).toHaveLength(1); // no mode in the answer
  });

  it("refuses when the mode cannot be read - an AccessDenied is a refusal, not a pass", async () => {
    const denied = Object.assign(new Error("not authorized to perform bedrock:GetAccountDataRetention"), { name: "AccessDeniedException" });
    const problems = await check(denied);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/cannot be read/i);
  });

  it("refuses when a destination region's retention is not none even if the home region's is", async () => {
    const world = bedrockWorld({
      profile: { models: [arnIn("eu-central-1")] },
      retention: { "eu-central-2": none, "eu-central-1": { mode: "default" } },
    });
    const problems = await checkBedrock({ region: "eu-central-2", modelId: "eu.anthropic.x", controlFor: world.controlFor });
    expect(problems).toHaveLength(1);
  });

  it("names the check and never the provider's error text or the model id", async () => {
    const leaky = Object.assign(new Error("secret-bedrock-text arn:aws:iam::123456789012:user/x"), { name: "AccessDeniedException" });
    const problems = (await check(leaky)).join("\n");
    expect(problems).not.toContain("secret-bedrock-text");
    expect(problems).not.toContain("123456789012");
    expect(problems).not.toContain(plain);
  });
});

// ─── Against a real S3-compatible store (the compose MinIO) ──────────────────
//
// An ISOLATED, uniquely named bucket that this file creates and removes: no other
// service's bucket is read or written. Skipped, loudly, when MinIO is not reachable
// or its credentials differ from the compose defaults.

const MINIO = {
  endpoint: process.env["MEETINGS_TEST_MINIO_ENDPOINT"] ?? "http://localhost:9000",
  accessKeyId: process.env["MEETINGS_TEST_MINIO_ACCESS_KEY"] ?? "minioadmin",
  secretAccessKey: process.env["MEETINGS_TEST_MINIO_SECRET_KEY"] ?? "minioadmin",
};
const minio = new S3Client({
  region: "us-east-1",
  endpoint: MINIO.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: MINIO.accessKeyId, secretAccessKey: MINIO.secretAccessKey },
});
const bucket = `meetings-t14-${crypto.randomUUID().slice(0, 8)}`;
const reachable = await minio
  .send(new CreateBucketCommand({ Bucket: bucket }))
  .then(() => true)
  .catch(() => false);
if (!reachable) console.warn("[startupChecks.test] MinIO is not reachable with the compose credentials: skipping the MinIO cases");

afterAll(async () => {
  if (!reachable) return;
  const listed = await minio.send(new ListObjectsV2Command({ Bucket: bucket })).catch(() => null);
  if (listed?.Contents?.length) console.warn("[startupChecks.test] scratch bucket was not empty");
  await minio.send(new DeleteBucketLifecycleCommand({ Bucket: bucket })).catch(() => {});
  await minio.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {});
});

const lifecycle = (rules: LifecycleRule[]) =>
  minio.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: rules } }));

describe.skipIf(!reachable)("against MinIO", () => {
  it("fails for a bucket with no rule", async () => {
    expect((await checkBucket(minio, bucket)).length).toBeGreaterThan(0);
  });

  it("passes for a 29-day, unfiltered rule and versioning off", async () => {
    await lifecycle([{ ID: "expire", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 29 } }]);
    expect(await checkBucket(minio, bucket)).toEqual([]);
  });

  it("fails for Days: 30", async () => {
    await lifecycle([{ ID: "expire", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 30 } }]);
    expect((await checkBucket(minio, bucket)).length).toBeGreaterThan(0);
  });

  it("fails for a prefix-filtered rule", async () => {
    await lifecycle([{ ID: "expire", Status: "Enabled", Filter: { Prefix: "meetings/" }, Expiration: { Days: 29 } }]);
    expect((await checkBucket(minio, bucket)).length).toBeGreaterThan(0);
  });

  it("fails once versioning is enabled, even with a good rule", async () => {
    await lifecycle([{ ID: "expire", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 29 } }]);
    expect(await checkBucket(minio, bucket)).toEqual([]);
    await minio.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    const problems = await checkBucket(minio, bucket);
    expect(problems.some((p) => /versioning/i.test(p))).toBe(true);
  });
});
