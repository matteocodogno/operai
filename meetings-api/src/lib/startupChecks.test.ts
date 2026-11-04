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
import { MAX_RETENTION_DAYS, checkBucket } from "./startupChecks";

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
