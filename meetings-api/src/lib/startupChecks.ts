/**
 * Startup checks that need the network (specs/021-meetings AC-4.4, AC-4.9,
 * ADR-0063, ADR-0069). The residency checks that can be decided from the
 * environment alone live in `env.ts` / `residency.ts`; these ask the audio bucket,
 * the transient bucket and Vertex's control plane.
 *
 * Audio is deleted by the BUCKET, not by this service (no cron, ADR-0013): one
 * bucket-wide lifecycle rule expires every object within 30 days of creation.
 * That promise to users (AC-4.4) is only as good as the rule being there, so the
 * service REFUSES TO START unless:
 *   - an enabled rule expires current objects after at most 29 days (S3 rounds
 *     expiration up to the next midnight UTC, so 29 d keeps the deletion within
 *     30 d), and
 *   - that rule has NO filter of any kind (a prefix- or tag-filtered rule would
 *     leave other objects for ever), and
 *   - versioning is not Enabled (a versioned delete only adds a delete marker; it
 *     is not irrecoverable).
 * An unreadable configuration is a refusal too: fail closed.
 *
 * A refusal names what is wrong and never the bucket, the endpoint, the
 * credentials or the provider's error text.
 */

import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  type LifecycleRule,
  type S3Client,
} from "@aws-sdk/client-s3";
import { GoogleApiError, defaultFetch, googleAuth, googleFetch, type GoogleAuth } from "./google/auth";
import { vertexHost } from "./residency";
import { readBucketConfig, type BucketConfig } from "./google/transientStorage";

/** AC-4.4: 30 days (+ at most 24 h) from creation; expiration rounds up to midnight UTC. */
export const MAX_RETENTION_DAYS = 29;

/** Whether `rule` expires every current object after 1..29 days: enabled, day-based, and unfiltered. */
function qualifies(rule: LifecycleRule): boolean {
  if (rule.Status !== "Enabled") return false;
  const days = rule.Expiration?.Days;
  if (typeof days !== "number" || days < 1 || days > MAX_RETENTION_DAYS) return false;

  // The deprecated top-level Prefix, and every member of Filter, narrow the rule.
  if (rule.Prefix !== undefined && rule.Prefix !== "") return false;
  const filter = rule.Filter;
  if (filter) {
    if (filter.Prefix !== undefined && filter.Prefix !== "") return false;
    if (filter.Tag !== undefined) return false;
    if (filter.ObjectSizeGreaterThan !== undefined || filter.ObjectSizeLessThan !== undefined) return false;
    if (filter.And !== undefined) return false;
  }
  return true;
}

/** The problems with `bucket` (empty when it is fit to hold audio). Never throws. */
export async function checkBucket(client: S3Client, bucket: string): Promise<string[]> {
  const problems: string[] = [];

  try {
    const { Rules } = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    if (!(Rules ?? []).some(qualifies)) {
      problems.push(
        `the bucket has no lifecycle rule that expires every object after at most ${MAX_RETENTION_DAYS} days ` +
          "(enabled, day-based, no prefix, tag or size filter)",
      );
    }
  } catch {
    problems.push("the bucket's lifecycle configuration is missing or cannot be read");
  }

  try {
    const { Status } = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (Status === "Enabled") problems.push("bucket versioning is enabled: a versioned delete is not irrecoverable");
  } catch {
    problems.push("the bucket's versioning state cannot be read");
  }

  return problems;
}

// ─── The transient processing bucket (N2; AC-4.9, AC-4.12, ADR-0069) ─────────
//
// Chirp 3 reads audio only from Cloud Storage, so each transcription attempt stages its parts in a bucket of
// ours (plan § G-2). The promise users get (AC-4.12) is only as good as that bucket's own rules, because
// Google's defaults keep a deleted object for a week (soft delete) and nothing else guarantees the 1-day
// backstop. Everything the bucket's metadata exposes is read at startup; absent or unreadable is a refusal.

/**
 * Bucket locations that keep data in the EU or Switzerland AND are served by a regional endpoint (the EU
 * multi-region and single regions; dual-regions such as EUR4 have no regional endpoint). London
 * (`EUROPE-WEST2`) is not in the EU.
 */
export const TRANSIENT_BUCKET_ALLOWED_LOCATIONS = [
  "EU",
  "EUROPE-CENTRAL2",
  "EUROPE-NORTH1",
  "EUROPE-NORTH2",
  "EUROPE-SOUTHWEST1",
  "EUROPE-WEST1",
  "EUROPE-WEST3",
  "EUROPE-WEST4",
  "EUROPE-WEST6",
  "EUROPE-WEST8",
  "EUROPE-WEST9",
  "EUROPE-WEST10",
  "EUROPE-WEST12",
] as const;

/** Whether a lifecycle rule deletes EVERY object after one day: `Delete`, `age` 1, and no other condition. */
function expiresEverythingAfterOneDay(rule: NonNullable<NonNullable<BucketConfig["lifecycle"]>["rule"]>[number]): boolean {
  if (rule.action?.type !== "Delete") return false;
  const condition = rule.condition;
  if (typeof condition !== "object" || condition === null) return false;
  // `age` is the only condition allowed: prefix, suffix, storage class, `isLive`, dates... all narrow the rule.
  // Age 0 is refused too: it would delete the parts an attempt has just uploaded and is still waiting on.
  return Object.keys(condition).every((k) => k === "age") && condition["age"] === 1;
}

/** The problems with a transient bucket's configuration (empty when it is fit). Names the property, never a value. */
export function transientBucketProblems(config: BucketConfig): string[] {
  const problems: string[] = [];
  const location = typeof config.location === "string" ? config.location.toUpperCase() : "";
  if (!(TRANSIENT_BUCKET_ALLOWED_LOCATIONS as readonly string[]).includes(location)) {
    problems.push("the transient bucket's location is not in the EU/CH allowlist");
  }
  const rules = config.lifecycle?.rule;
  if (!Array.isArray(rules) || !rules.some(expiresEverythingAfterOneDay)) {
    problems.push("the transient bucket has no lifecycle rule that deletes every object after one day (age 1, no other condition)");
  }
  if (config.versioning?.enabled === true) problems.push("the transient bucket has versioning enabled");
  const soft = config.softDeletePolicy?.retentionDurationSeconds;
  if (soft === undefined) problems.push("the transient bucket's soft-delete policy cannot be read");
  else if (Number(soft) !== 0 || soft === "" || soft === null) problems.push("the transient bucket keeps deleted objects (soft delete is not off)");
  if (config.retentionPolicy !== undefined && config.retentionPolicy !== null) problems.push("the transient bucket has a retention policy");
  if (config.defaultEventBasedHold === true) problems.push("the transient bucket places a hold on new objects");
  if (config.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) {
    problems.push("the transient bucket does not enforce uniform bucket-level access");
  }
  if (config.iamConfiguration?.publicAccessPrevention !== "enforced") {
    problems.push("the transient bucket does not enforce public access prevention");
  }
  return problems;
}

/** The problems with the transient bucket (empty when fit). Never throws; an unreadable bucket is a problem. */
export async function checkTransientBucket(input: { bucket: string; auth: GoogleAuth; fetchImpl?: typeof fetch }): Promise<string[]> {
  let config: BucketConfig;
  try {
    config = await readBucketConfig(input);
  } catch {
    return ["the transient bucket's configuration cannot be read"];
  }
  return transientBucketProblems(config);
}

// ─── Vertex AI: caching and request-response logging (N3, N4; AC-4.9, ADR-0069) ─────────
//
// Two facts about the language model are not in our repository and are not on the request: whether the
// PROJECT caches prompts (Google documents implicit caching for its own models, and the setting is
// project-wide) and whether request-response LOGGING is on for this publisher model in this location. Both are
// read from Google's control plane at startup; anything that cannot be read, or is not what the promise needs,
// refuses the start. Both reads carry a project id and no content, the same class as the token exchange.

export interface VertexCheckInput {
  /** `MEETINGS_GCP_PROJECT_ID`. */
  readonly projectId: string;
  /** `MEETINGS_VERTEX_LOCATION`, already checked (S2). */
  readonly location: string;
  /** `MEETINGS_VERTEX_MODEL_ID`, already checked (S3). */
  readonly modelId: string;
  readonly auth: GoogleAuth;
  readonly fetchImpl?: typeof fetch;
}

const CONTROL_TIMEOUT_MS = 30_000;

/** One control-plane read, tried twice when the first failure is transient (plan R21); a refusal is final. */
async function readControlPlane(input: VertexCheckInput, url: string, allow: readonly number[]): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  let last: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await googleFetch(input.auth, fetchImpl, url, { timeoutMs: CONTROL_TIMEOUT_MS, allow });
    } catch (error) {
      last = error;
      if (!(error instanceof GoogleApiError) || !error.transient) break;
    }
  }
  throw last;
}

const jsonObject = async (response: Response): Promise<Record<string, unknown> | null> => {
  const body = (await response.json().catch(() => null)) as unknown;
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
};

/**
 * The problems with the Vertex project and model (empty when fit). Never throws. A problem names the check,
 * never a project, a location, a model id or the provider's error text.
 */
export async function checkVertex(input: VertexCheckInput): Promise<string[]> {
  const problems: string[] = [];
  const base = `https://${vertexHost(input.location)}`;
  const project = encodeURIComponent(input.projectId);

  // N3: all caching off for the project. `DURABLE` and `EPHEMERAL` (and an answer we cannot read) refuse.
  try {
    const body = await jsonObject(await readControlPlane(input, `${base}/v1/projects/${project}/cacheConfig`, []));
    if (body?.["disableCache"] !== true) problems.push("Vertex data caching is not disabled for the project (cacheConfig)");
  } catch {
    problems.push("Vertex's cache configuration cannot be read");
  }

  // N4: request-response logging not enabled for this exact location and model. A 404 is Google's "no
  // configuration", i.e. the default, disabled state; `enabled` or `enableOtelLogging` true refuses; every other
  // answer or error refuses.
  try {
    const url =
      `${base}/v1beta1/projects/${project}/locations/${encodeURIComponent(input.location)}` +
      `/publishers/anthropic/models/${encodeURIComponent(input.modelId)}:fetchPublisherModelConfig`;
    const response = await readControlPlane(input, url, [404]);
    if (response.status !== 404) {
      const body = await jsonObject(response);
      if (body === null) {
        problems.push("Vertex's request-response logging configuration cannot be read");
      } else {
        const logging = (typeof body["loggingConfig"] === "object" && body["loggingConfig"] !== null ? body["loggingConfig"] : {}) as Record<string, unknown>;
        if (logging["enabled"] === true || logging["enableOtelLogging"] === true || body["enableOtelLogging"] === true) {
          problems.push("Vertex request-response logging is enabled for the model");
        }
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
  } catch {
    problems.push("Vertex's request-response logging configuration cannot be read");
  }

  return problems;
}

/**
 * Runs the checks - the audio bucket, and with a real provider the transient bucket and Vertex - and exits 1
 * on any problem. Called once from `src/index.ts`, before the server listens.
 */
export async function runStartupChecks(client: S3Client, bucket: string): Promise<void> {
  const audio = await checkBucket(client, bucket);
  const { transient, ai } = await providerChecksFromEnv();
  if (audio.length === 0 && ai.length === 0 && transient.length === 0) return;
  if (audio.length > 0) {
    console.error("Audio storage is not fit for recordings, refusing to start (AC-4.4, ADR-0063):");
    for (const problem of audio) console.error(`  - ${problem}`);
  }
  if (transient.length > 0) {
    console.error("The transient transcription bucket is not fit to stage audio, refusing to start (AC-4.9, AC-4.12, ADR-0069):");
    for (const problem of transient) console.error(`  - ${problem}`);
  }
  if (ai.length > 0) {
    console.error("The language model is not fit to process meetings, refusing to start (AC-4.9, ADR-0069):");
    for (const problem of ai) console.error(`  - ${problem}`);
  }
  process.exit(1);
}

/** From the environment: a real provider is checked, the fake (refused in production by env.ts) is not. */
async function providerChecksFromEnv(): Promise<{ transient: string[]; ai: string[] }> {
  const { env } = await import("./env");
  if (env.MEETINGS_AI_PROVIDER !== "real") return { transient: [], ai: [] };
  const auth = await googleAuth();
  return {
    transient: await checkTransientBucket({ bucket: env.MEETINGS_GCS_TRANSIENT_BUCKET!, auth }),
    ai: await checkVertex({
      projectId: env.MEETINGS_GCP_PROJECT_ID!,
      location: env.MEETINGS_VERTEX_LOCATION!,
      modelId: env.MEETINGS_VERTEX_MODEL_ID!,
      auth,
    }),
  };
}
