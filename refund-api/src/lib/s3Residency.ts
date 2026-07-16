/**
 * EU-residency + path-style-addressing helpers shared by `env.ts` (startup
 * assertion) and `storage.ts` (S3 client construction) — T9,
 * specs/007-refund-service, ADR-0016, plan Risk R8.
 *
 * DEPLOYMENT NOTE (mid-task correction from the coordinator): the actual
 * provisioned bucket is a **Railway S3-compatible bucket in EU Amsterdam** —
 * a custom, non-AWS endpoint, NOT `*.amazonaws.com`. For a custom endpoint,
 * the SDK `region` string is a meaningless placeholder (commonly
 * `"us-east-1"` even for a genuinely-EU bucket) — it does NOT encode physical
 * location the way a real AWS region does. A strict AWS-style region
 * allowlist would therefore WRONGLY reject a real EU bucket. The residency
 * guard below is endpoint-aware:
 *
 *   - `REFUND_S3_ENDPOINT` host ends with `.amazonaws.com` → this IS AWS, so
 *     `region` IS meaningful → enforce `REFUND_S3_REGION` ∈ the EU allowlist.
 *   - Any other host (Railway, Scaleway, R2, MinIO, …) → residency is
 *     OPERATOR-ASSERTED by the choice of endpoint/bucket (e.g. the ops team
 *     provisioning a bucket physically in Amsterdam), not verifiable from the
 *     region string — no allowlist check; `REFUND_S3_REGION` is treated as an
 *     opaque SDK value. `REFUND_S3_ENDPOINT` itself is still required and
 *     non-empty (enforced by env.ts's own `.url()` check) — fail-closed if
 *     it's missing.
 */

/** AWS regions whose physical location is EU (ADR-0016 Risk R8). */
export const EU_AWS_REGIONS = [
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
] as const;

/** True when `endpoint` is a real AWS S3 endpoint (region string is meaningful). */
export function isAwsS3Endpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.endsWith(".amazonaws.com");
  } catch {
    return false;
  }
}

/**
 * Returns an error message when residency cannot be asserted, or `null` when
 * it's fine to proceed. Called from env.ts's `superRefine` at startup.
 */
export function checkEuResidency(
  endpoint: string,
  region: string,
): string | null {
  if (!isAwsS3Endpoint(endpoint)) {
    // Custom endpoint (Railway, Scaleway, R2, MinIO, ...) — residency is
    // operator-asserted by the bucket's own provisioning, not the region
    // string. Nothing further to check here.
    return null;
  }
  if (!(EU_AWS_REGIONS as readonly string[]).includes(region)) {
    return (
      `REFUND_S3_REGION "${region}" is not an EU AWS region (data residency, ` +
      `ADR-0016/CLAUDE.md). Allowed: ${EU_AWS_REGIONS.join(", ")}`
    );
  }
  return null;
}

/**
 * Non-AWS S3-compatible providers (Railway, MinIO, Scaleway, R2 in
 * S3-compatibility mode) generally require virtual-host-style bucket
 * addressing to be disabled in favour of path-style
 * (`https://endpoint/bucket/key` rather than `https://bucket.endpoint/key`).
 * Real AWS S3 uses virtual-hosted-style (the SDK default) — `forcePathStyle`
 * must stay `false` there.
 */
export function needsPathStyleAddressing(endpoint: string): boolean {
  return !isAwsS3Endpoint(endpoint);
}
