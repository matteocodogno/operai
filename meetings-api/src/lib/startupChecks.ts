/**
 * Startup checks that need the network (specs/021-meetings AC-4.4, ADR-0063).
 * The residency checks that can be decided from the environment alone live in
 * `env.ts` / `residency.ts`; these ask the bucket.
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

/**
 * Runs the checks against the configured bucket and exits 1 on any problem.
 * Called once from `src/index.ts`, before the server listens.
 */
export async function runStartupChecks(client: S3Client, bucket: string): Promise<void> {
  const problems = await checkBucket(client, bucket);
  if (problems.length === 0) return;
  console.error("Audio storage is not fit for recordings, refusing to start (AC-4.4, ADR-0063):");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
