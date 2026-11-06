import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import {
  MAX_RETENTION_DAYS,
  TRANSIENT_BUCKET_ALLOWED_LOCATIONS,
  checkVertex,
  checkBucket,
  checkTransientBucket,
  transientBucketProblems,
} from "./startupChecks";
import type { GoogleAuth } from "./google/auth";
import { checkVertexModelId } from "./residency";
import type { BucketConfig } from "./google/transientStorage";

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

// ─── Vertex: caching and logging (N3, N4; AC-4.9, ADR-0069) ──────────────────

type Answer = Response | Error;

/** A Vertex control plane that answers by script and records every request. */
function vertexWorld(script: { cache?: Answer | (() => Answer); logging?: Answer | (() => Answer) }) {
  const seen: { url: URL; method: string }[] = [];
  const auth: GoogleAuth = { accessToken: async () => "tok", client: null as never };
  const answer = (a: Answer | (() => Answer) | undefined): Response => {
    const value = typeof a === "function" ? a() : a;
    if (value instanceof Error) throw value;
    return value ?? new Response("{}", { status: 500 });
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, method: init?.method ?? "GET" });
    return url.pathname.endsWith("/cacheConfig") ? answer(script.cache) : answer(script.logging);
  }) as unknown as typeof fetch;
  const run = (over: Partial<Parameters<typeof checkVertex>[0]> = {}) =>
    checkVertex({ projectId: "operai-meetings-test", location: "eu", modelId: "claude-sonnet-5-0", auth, fetchImpl, ...over });
  return { seen, run };
}

const okJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const cacheOff = () => okJson({ name: "projects/p/cacheConfig", disableCache: true });
const notConfigured = () => new Response("{}", { status: 404 });

const recorded = (name: string): string => readFileSync(join(import.meta.dir, "../../test-fixtures/google-vertex", name), "utf8");

describe("vertex N3 and N4 on the RECORDED answers of the real eu endpoint (T107)", () => {
  it("passes: cacheConfig 200 with disableCache true, fetchPublisherModelConfig 404 NOT_FOUND for a never-configured model", async () => {
    const w = vertexWorld({
      cache: new Response(recorded("cache-config.json"), { status: 200 }),
      logging: new Response(recorded("fetch-publisher-model-config-not-found.json"), { status: 404 }),
    });
    expect(await w.run({ modelId: "claude-sonnet-5-5" })).toEqual([]);
    const control = w.seen.find((r) => r.url.pathname.endsWith(":fetchPublisherModelConfig"))!;
    expect(control.url.host).toBe("aiplatform.eu.rep.googleapis.com");
    expect(control.url.pathname).toBe("/v1beta1/projects/operai-meetings-test/locations/eu/publishers/anthropic/models/claude-sonnet-5-5:fetchPublisherModelConfig");
  });

  it("the model id is the bare id: a resource path in the variable is refused by env.ts (S3), not smuggled into the URL", () => {
    expect(checkVertexModelId("claude-sonnet-5-5")).toBeNull();
    expect(checkVertexModelId("publishers/anthropic/models/claude-sonnet-5-5")).not.toBeNull();
  });
});

describe("vertex N3: data caching is off for the project", () => {
  it("passes only for disableCache: true", async () => {
    expect(await vertexWorld({ cache: cacheOff(), logging: notConfigured() }).run()).toEqual([]);
  });

  it("refuses DURABLE and EPHEMERAL retention, an empty config and a config that says disableCache false", async () => {
    for (const body of [
      { name: "x", retentionConfig: { retentionType: "DURABLE" } },
      { name: "x", retentionConfig: { retentionType: "EPHEMERAL" } },
      {},
      { disableCache: false },
      { disableCache: "true" },
    ]) {
      const problems = await vertexWorld({ cache: okJson(body), logging: notConfigured() }).run();
      expect(problems, JSON.stringify(body)).toHaveLength(1);
      expect(problems[0]).toMatch(/caching/i);
    }
  });

  it("refuses when it cannot be read: 403, 404, 500, a network error, a body that is not JSON (fail closed)", async () => {
    for (const cache of [okJson({}, 403), okJson({}, 404), okJson({}, 500), new Error("ECONNRESET"), new Response("<html>")]) {
      const problems = await vertexWorld({ cache, logging: notConfigured() }).run();
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/cache/i);
    }
  });

  it("reads the project's cacheConfig on the host derived from the location", async () => {
    const w = vertexWorld({ cache: cacheOff(), logging: notConfigured() });
    await w.run();
    const read = w.seen.find((r) => r.url.pathname.endsWith("/cacheConfig"))!;
    expect(read.url.host).toBe("aiplatform.eu.rep.googleapis.com");
    expect(read.url.pathname).toBe("/v1/projects/operai-meetings-test/cacheConfig");
    expect(read.method).toBe("GET");
  });

  it("tries a transient failure twice, a refusal once", async () => {
    let transientCalls = 0;
    const flaky = vertexWorld({ cache: () => (transientCalls++ === 0 ? okJson({}, 503) : cacheOff()), logging: notConfigured() });
    expect(await flaky.run()).toEqual([]);
    expect(transientCalls).toBe(2);

    let refusedCalls = 0;
    const denied = vertexWorld({ cache: () => (refusedCalls++, okJson({}, 403)), logging: notConfigured() });
    await denied.run();
    expect(refusedCalls).toBe(1);

    let downCalls = 0;
    const down = vertexWorld({ cache: () => (downCalls++, okJson({}, 503)), logging: notConfigured() });
    expect((await down.run()).length).toBe(1);
    expect(downCalls).toBe(2);
  });
});

describe("vertex N4: request-response logging is not enabled for the model", () => {
  it("a 404 (no configuration, the default) passes", async () => {
    expect(await vertexWorld({ cache: cacheOff(), logging: notConfigured() }).run()).toEqual([]);
  });

  it("a configuration with logging disabled passes", async () => {
    for (const body of [
      { loggingConfig: { enabled: false } },
      { loggingConfig: {} },
      { loggingConfig: { enabled: false, samplingRate: 1, enableOtelLogging: false }, dataSharingEnabledProvider: "MODEL_PROVIDER_UNSPECIFIED" },
    ]) {
      expect(await vertexWorld({ cache: cacheOff(), logging: okJson(body) }).run(), JSON.stringify(body)).toEqual([]);
    }
  });

  it("refuses a 200 it does not understand: no loggingConfig, an unknown top-level or loggingConfig key, a wrong type (ADR-0061)", async () => {
    for (const body of [
      {},
      { name: "x" },
      { loggingConfig: { enabled: false }, somethingNew: true },
      { loggingConfig: { enabled: false, somethingNew: true } },
      { loggingConfig: { logAllTheThings: true } },
      { loggingConfig: "off" },
      { loggingConfig: [] },
      { loggingConfig: null },
      { loggingConfig: { enabled: "false" } },
      { loggingConfig: { enableOtelLogging: 0 } },
      [],
      "ok",
      null,
    ]) {
      const problems = await vertexWorld({ cache: cacheOff(), logging: okJson(body) }).run();
      expect(problems, JSON.stringify(body)).toHaveLength(1);
      expect(problems[0]).toMatch(/logging/i);
    }
  });

  it("refuses data sharing with the model provider, and a provider value it does not know", async () => {
    for (const dataSharingEnabledProvider of ["ANTHROPIC", "SOMEONE_ELSE", true, 1]) {
      const problems = await vertexWorld({ cache: cacheOff(), logging: okJson({ loggingConfig: {}, dataSharingEnabledProvider }) }).run();
      expect(problems, String(dataSharingEnabledProvider)).toHaveLength(1);
      expect(problems[0]).toMatch(/logging/i);
    }
  });

  it("an unknown key is refused value-free: the message carries neither the key nor its value", async () => {
    const problems = (await vertexWorld({ cache: cacheOff(), logging: okJson({ loggingConfig: { secretNewKey: "secret-value" } }) }).run()).join("\n");
    expect(problems).not.toContain("secretNewKey");
    expect(problems).not.toContain("secret-value");
  });

  it("refuses enabled: true and enableOtelLogging: true, wherever the field sits", async () => {
    for (const body of [{ loggingConfig: { enabled: true } }, { loggingConfig: { enableOtelLogging: true } }, { enableOtelLogging: true }, { loggingConfig: { enabled: true, enableOtelLogging: true } }]) {
      const problems = await vertexWorld({ cache: cacheOff(), logging: okJson(body) }).run();
      expect(problems, JSON.stringify(body)).toHaveLength(1);
      expect(problems[0]).toMatch(/logging/i);
    }
  });

  it("refuses every other error: 400, 401, 403, 500, a network error, a 200 that is not JSON", async () => {
    for (const logging of [okJson({}, 400), okJson({}, 401), okJson({}, 403), okJson({}, 500), new Error("ECONNRESET"), new Response("<html>")]) {
      const problems = await vertexWorld({ cache: cacheOff(), logging }).run();
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/logging/i);
    }
  });

  it("asks about the exact location and model, with both encoded", async () => {
    const w = vertexWorld({ cache: cacheOff(), logging: notConfigured() });
    await w.run({ modelId: "claude-opus-4-7@20260401", location: "europe-west4" });
    const read = w.seen.find((r) => r.url.pathname.endsWith(":fetchPublisherModelConfig"))!;
    expect(read.url.host).toBe("europe-west4-aiplatform.googleapis.com");
    expect(read.url.pathname).toBe(
      "/v1beta1/projects/operai-meetings-test/locations/europe-west4/publishers/anthropic/models/claude-opus-4-7%4020260401:fetchPublisherModelConfig",
    );
  });

  it("reports both problems together", async () => {
    const problems = await vertexWorld({ cache: okJson({ disableCache: false }), logging: okJson({ loggingConfig: { enabled: true } }) }).run();
    expect(problems).toHaveLength(2);
  });

  it("names the check and never the project, the model, the location or the provider's error text", async () => {
    const leaky = () => new Response("secret-vertex-text operai-meetings-test", { status: 403 });
    const problems = (await vertexWorld({ cache: leaky(), logging: leaky() }).run({ modelId: "claude-secret-model" })).join("\n");
    for (const leak of ["secret-vertex-text", "operai-meetings-test", "claude-secret-model", "aiplatform", "eu"]) {
      expect(problems.toLowerCase()).not.toContain(leak === "eu" ? " eu " : leak);
    }
  });
});

// ─── The transient processing bucket (N2; AC-4.9, AC-4.12, ADR-0069) ───────

const goodTransient = (): BucketConfig => ({
  location: "EUROPE-WEST4",
  lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 1 } }] },
  softDeletePolicy: { retentionDurationSeconds: "0" },
  iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
});

describe("transient bucket (N2)", () => {
  it("passes a bucket that matches every property", () => {
    expect(transientBucketProblems(goodTransient())).toEqual([]);
  });

  it("passes the EU multi-region and every allowlisted single region, in any letter case", () => {
    for (const location of TRANSIENT_BUCKET_ALLOWED_LOCATIONS) {
      expect(transientBucketProblems({ ...goodTransient(), location }), location).toEqual([]);
      expect(transientBucketProblems({ ...goodTransient(), location: location.toLowerCase() }), location).toEqual([]);
    }
  });

  const refusals: [string, (c: BucketConfig) => BucketConfig, RegExp][] = [
    ["soft delete 7 days (the GCS default)", (c) => ({ ...c, softDeletePolicy: { retentionDurationSeconds: "604800" } }), /soft delete/i],
    ["a soft-delete policy that is absent", ({ softDeletePolicy: _drop, ...c }) => c, /soft-delete/i],
    ["a soft-delete value that is null or empty", (c) => ({ ...c, softDeletePolicy: { retentionDurationSeconds: null } }), /soft delete/i],
    ["versioning on", (c) => ({ ...c, versioning: { enabled: true } }), /versioning/i],
    ["a matchesPrefix rule", (c) => ({ ...c, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 1, matchesPrefix: ["transcribe/"] } }] } }), /lifecycle/i],
    ["a matchesSuffix, storage class or isLive narrowing", (c) => ({ ...c, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 1, isLive: true } }] } }), /lifecycle/i],
    ["age 2", (c) => ({ ...c, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 2 } }] } }), /lifecycle/i],
    ["age 0 (would delete parts in flight)", (c) => ({ ...c, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 0 } }] } }), /lifecycle/i],
    ["a rule that is not a Delete", (c) => ({ ...c, lifecycle: { rule: [{ action: { type: "SetStorageClass" }, condition: { age: 1 } }] } }), /lifecycle/i],
    ["no lifecycle at all", ({ lifecycle: _drop, ...c }) => c, /lifecycle/i],
    ["London (EUROPE-WEST2)", (c) => ({ ...c, location: "EUROPE-WEST2" }), /location/i],
    ["the US", (c) => ({ ...c, location: "US" }), /location/i],
    ["a dual-region", (c) => ({ ...c, location: "EUR4" }), /location/i],
    ["no location", ({ location: _drop, ...c }) => c, /location/i],
    ["public access prevention not enforced", (c) => ({ ...c, iamConfiguration: { ...c.iamConfiguration, publicAccessPrevention: "inherited" } }), /public access/i],
    ["uniform access off", (c) => ({ ...c, iamConfiguration: { ...c.iamConfiguration, uniformBucketLevelAccess: { enabled: false } } }), /uniform/i],
    ["a retention policy", (c) => ({ ...c, retentionPolicy: { retentionPeriod: "60" } }), /retention policy/i],
    ["a default event-based hold", (c) => ({ ...c, defaultEventBasedHold: true }), /hold/i],
  ];
  for (const [name, mutate, expected] of refusals) {
    it(`refuses ${name}`, () => {
      const problems = transientBucketProblems(mutate(goodTransient()));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).toMatch(expected);
    });
  }

  it("accepts a lifecycle with an extra unrelated rule next to the qualifying one", () => {
    const good = goodTransient();
    const config: BucketConfig = { ...good, lifecycle: { rule: [{ action: { type: "SetStorageClass" }, condition: { age: 30 } }, ...good.lifecycle!.rule!] } };
    expect(transientBucketProblems(config)).toEqual([]);
  });

  it("never names a value", () => {
    const problems = transientBucketProblems({ ...goodTransient(), location: "US-SECRET-9", softDeletePolicy: { retentionDurationSeconds: "604800" } }).join("\n");
    expect(problems).not.toContain("US-SECRET-9");
    expect(problems).not.toContain("604800");
  });
});

describe("checkTransientBucket", () => {
  const auth: GoogleAuth = { accessToken: async () => "tok", client: null as never };
  const stubFetch = (respond: () => Response | Promise<Response>) => (async () => respond()) as unknown as typeof fetch;

  it("reads the metadata and passes a good bucket", async () => {
    const fetchImpl = stubFetch(() => Response.json(goodTransient()));
    expect(await checkTransientBucket({ bucket: "operai-transient", auth, fetchImpl })).toEqual([]);
  });

  it("refuses unreadable metadata (403, 500 twice, not JSON) without naming the bucket or the error", async () => {
    for (const respond of [() => new Response("denied secret-text", { status: 403 }), () => new Response("{}", { status: 500 }), () => new Response("not json")]) {
      const problems = await checkTransientBucket({ bucket: "bucket-xyz-secret", auth, fetchImpl: stubFetch(respond) });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/cannot be read/i);
      expect(problems.join()).not.toContain("bucket-xyz-secret");
      expect(problems.join()).not.toContain("secret-text");
    }
  });

  it("refuses a network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await checkTransientBucket({ bucket: "b-ucket", auth, fetchImpl })).toHaveLength(1);
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
