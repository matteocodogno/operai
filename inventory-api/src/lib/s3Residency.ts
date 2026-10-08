/**
 * EU-residency + path-style-addressing helpers for the invoice-file bucket
 * (T21, specs/015-hardware-inventory; ADR-0016 posture). Ported from
 * refund-api/src/lib/s3Residency.ts with the variable names re-pointed at
 * `INVENTORY_S3_*`; moved out of env.ts, which T1 had inlined them in until
 * this task.
 */

// ─── EU-residency guard for the invoice-file bucket (ADR-0016 posture) ───────
//
// Same endpoint-aware rule as refund-api/src/lib/s3Residency.ts (OWASP A05):
//
//   - endpoint host is `*.amazonaws.com` → the region string is meaningful, so
//     INVENTORY_S3_REGION must be in the EU AWS region allowlist;
//   - any other host (Railway, Scaleway, R2, MinIO, …) → the region string is an
//     opaque SDK placeholder that does NOT encode location, so residency is
//     enforced against the operator-declared INVENTORY_S3_EU_ENDPOINT_HOSTS
//     allowlist. An empty, unset or non-matching allowlist FAILS startup
//     closed — never a silent pass.
//

/** AWS regions whose physical location is EU. */
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

function hostMatchesEuAllowlist(
  hostname: string,
  euEndpointHosts: readonly string[],
): boolean {
  const lower = hostname.toLowerCase();
  return euEndpointHosts.some(
    (allowed) => lower === allowed || lower.endsWith(`.${allowed}`),
  );
}

/**
 * Returns an error message when EU residency cannot be asserted, or `null`
 * when it is fine to proceed.
 */
export function checkEuResidency(
  endpoint: string,
  region: string,
  euEndpointHosts: readonly string[],
): string | null {
  if (isAwsS3Endpoint(endpoint)) {
    if (!(EU_AWS_REGIONS as readonly string[]).includes(region)) {
      return (
        `INVENTORY_S3_REGION "${region}" is not an EU AWS region (data ` +
        `residency, ADR-0016/CLAUDE.md). Allowed: ${EU_AWS_REGIONS.join(", ")}`
      );
    }
    return null;
  }

  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return `INVENTORY_S3_ENDPOINT "${endpoint}" is not a valid URL`;
  }

  if (euEndpointHosts.length === 0) {
    return (
      `INVENTORY_S3_ENDPOINT "${endpoint}" is a non-AWS endpoint, but ` +
      `INVENTORY_S3_EU_ENDPOINT_HOSTS is empty/unset — residency cannot be ` +
      `verified without an operator-declared EU allowlist (data residency, ` +
      `ADR-0016/CLAUDE.md). Set it to a comma-separated list of EU endpoint ` +
      `host suffixes.`
    );
  }

  if (!hostMatchesEuAllowlist(hostname, euEndpointHosts)) {
    return (
      `INVENTORY_S3_ENDPOINT host "${hostname}" does not match any entry in ` +
      `INVENTORY_S3_EU_ENDPOINT_HOSTS (${euEndpointHosts.join(", ")}) — ` +
      `refusing to start with an unverified non-EU endpoint (data residency, ` +
      `ADR-0016/CLAUDE.md).`
    );
  }
  return null;
}

/**
 * Non-AWS S3-compatible providers (Railway, MinIO, Scaleway, R2) need
 * path-style bucket addressing; real AWS S3 keeps the SDK's virtual-hosted
 * default.
 */
export function needsPathStyleAddressing(endpoint: string): boolean {
  return !isAwsS3Endpoint(endpoint);
}
