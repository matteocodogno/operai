/**
 * Startup checks that need the network (specs/021-meetings AC-4.4, AC-4.9,
 * ADR-0063, ADR-0061). The residency checks that can be decided from the
 * environment alone live in `env.ts` / `residency.ts`; these ask the bucket and
 * Bedrock's control plane.
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

import { GetAccountDataRetentionCommand, GetInferenceProfileCommand } from "@aws-sdk/client-bedrock";
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  type LifecycleRule,
  type S3Client,
} from "@aws-sdk/client-s3";
import { googleAuth, type GoogleAuth } from "./google/auth";
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

// ─── Bedrock (AC-4.9, ADR-0061) - REMOVED BY T101 ────────────────────────────
// Superseded by ADR-0069 (T95 dropped its environment). Kept only until T101 replaces it with the Vertex checks
// N3/N4, so that the code between the two commits still loads; nothing reads it at runtime.
const BEDROCK_ALLOWED_REGIONS = ["eu-central-1", "eu-central-2", "eu-west-1", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2"] as const;
//
//
// Two facts about the language model are not in our repository: WHERE a request is
// processed (an inference profile can route to any Region in its set, and AWS warns
// not to rely on the geographic prefix) and WHETHER anything is kept (the account's
// data-retention mode, per Region). Both are read from AWS at startup; anything that
// cannot be read, or is not what the promise needs, refuses the start.

/** What this module needs of a Bedrock control-plane client: tests pass a stub. */
export interface BedrockControl {
  send(command: GetInferenceProfileCommand | GetAccountDataRetentionCommand): Promise<unknown>;
}

export interface BedrockCheckInput {
  /** `BEDROCK_REGION`: where requests are sent, and whose retention mode applies first. */
  readonly region: string;
  /** `BEDROCK_MODEL_ID`: a model id, or an inference profile id or ARN. */
  readonly modelId: string;
  /** A control-plane client for a Region (retention is read per Region). */
  readonly controlFor: (region: string) => BedrockControl;
}

/** A geographic or global profile id (`eu.anthropic...`) or a profile ARN, as opposed to a plain model id. */
export function isInferenceProfileId(modelId: string): boolean {
  return /(^|\/)(eu|us|us-gov|apac|jp|au|ca|global)\./.test(modelId) || /:(application-)?inference-profile\//.test(modelId);
}

const arnRegion = (arn: unknown): string | null =>
  typeof arn === "string" ? (/^arn:aws[a-z-]*:bedrock:([a-z0-9-]+):/.exec(arn)?.[1] ?? null) : null;

const isAllowed = (region: string): boolean => (BEDROCK_ALLOWED_REGIONS as readonly string[]).includes(region);

/**
 * The problems with the configured model (empty when fit). Never throws. A problem names
 * the check, never a Region, a model id, an account id or the provider's error text.
 */
export async function checkBedrock(input: BedrockCheckInput): Promise<string[]> {
  const problems: string[] = [];
  const regions = new Set<string>([input.region]);

  if (isInferenceProfileId(input.modelId)) {
    try {
      const profile = (await input.controlFor(input.region).send(
        new GetInferenceProfileCommand({ inferenceProfileIdentifier: input.modelId }),
      )) as { models?: { modelArn?: unknown }[] } | undefined;
      const destinations = (profile?.models ?? []).map((model) => arnRegion(model.modelArn));
      if (destinations.length === 0 || destinations.includes(null)) {
        problems.push("the model's inference profile lists no readable destination Regions");
      }
      for (const destination of destinations) {
        if (destination === null) continue;
        if (isAllowed(destination)) regions.add(destination);
        else problems.push("the model's inference profile has a destination Region outside the EU/CH allowlist");
      }
    } catch {
      problems.push("the model's inference profile cannot be read");
    }
  }

  // Retention is a per-Region setting that does not propagate, and a profile may process a
  // request in any destination Region: every one of them must read `none`.
  let notNone = 0;
  let unreadable = 0;
  for (const region of regions) {
    try {
      const answer = (await input.controlFor(region).send(new GetAccountDataRetentionCommand({}))) as { mode?: unknown } | undefined;
      if (answer?.mode !== "none") notNone += 1;
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable > 0) problems.push("Bedrock's data-retention mode cannot be read in every Region the model may run in");
  if (notNone > 0) problems.push("Bedrock's data-retention mode is not 'none' in every Region the model may run in");

  return problems;
}

/** Removed with T101 (the environment it read no longer exists). */
async function bedrockCheckFromEnv(): Promise<BedrockCheckInput | null> {
  return null;
}

/**
 * Runs the checks - the audio bucket, and with a real provider the transient bucket and the language
 * model - and exits 1 on any problem. Called once from `src/index.ts`, before the server listens.
 */
export async function runStartupChecks(client: S3Client, bucket: string): Promise<void> {
  const audio = await checkBucket(client, bucket);
  const model = await bedrockCheckFromEnv();
  const ai = model ? await checkBedrock(model) : [];
  const transient = await transientCheckFromEnv();
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
    console.error("The language model is not fit to process meetings, refusing to start (AC-4.9, ADR-0061):");
    for (const problem of ai) console.error(`  - ${problem}`);
  }
  process.exit(1);
}

/** From the environment: the transient bucket is checked with a real provider, never with the fake. */
async function transientCheckFromEnv(): Promise<string[]> {
  const { env } = await import("./env");
  if (env.MEETINGS_AI_PROVIDER !== "real") return [];
  return checkTransientBucket({ bucket: env.MEETINGS_GCS_TRANSIENT_BUCKET!, auth: await googleAuth() });
}
