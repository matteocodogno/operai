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
import { BEDROCK_ALLOWED_REGIONS } from "./residency";

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

// ─── Bedrock (AC-4.9, ADR-0061) ──────────────────────────────────────────────
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

/** From the environment: a real provider is checked, the fake (refused in production by env.ts) is not. */
export async function bedrockCheckFromEnv(): Promise<BedrockCheckInput | null> {
  const { env } = await import("./env");
  if (env.MEETINGS_AI_PROVIDER !== "real") return null;
  const { BedrockClient } = await import("@aws-sdk/client-bedrock");
  const credentials = { accessKeyId: env.MEETINGS_AWS_ACCESS_KEY_ID!, secretAccessKey: env.MEETINGS_AWS_SECRET_ACCESS_KEY! };
  return {
    region: env.BEDROCK_REGION!,
    modelId: env.BEDROCK_MODEL_ID!,
    controlFor: (region) => new BedrockClient({ region, credentials, maxAttempts: 2 }) as unknown as BedrockControl,
  };
}

/**
 * Runs the checks - the audio bucket, and the language model when a real provider is
 * configured - and exits 1 on any problem. Called once from `src/index.ts`, before the
 * server listens.
 */
export async function runStartupChecks(client: S3Client, bucket: string): Promise<void> {
  const audio = await checkBucket(client, bucket);
  const model = await bedrockCheckFromEnv();
  const ai = model ? await checkBedrock(model) : [];
  if (audio.length === 0 && ai.length === 0) return;
  if (audio.length > 0) {
    console.error("Audio storage is not fit for recordings, refusing to start (AC-4.4, ADR-0063):");
    for (const problem of audio) console.error(`  - ${problem}`);
  }
  if (ai.length > 0) {
    console.error("The language model is not fit to process meetings, refusing to start (AC-4.9, ADR-0061):");
    for (const problem of ai) console.error(`  - ${problem}`);
  }
  process.exit(1);
}
