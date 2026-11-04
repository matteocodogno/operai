/**
 * EU-residency + path-style-addressing helpers for the Meetings audio bucket (specs/021-meetings,
 * AC-4.9; ADR-0016 posture). Copied from crm-api/src/lib/s3Residency.ts with the variable
 * names re-pointed at `MEETINGS_S3_*`. One deliberate change: a refusal never echoes the
 * endpoint, host or region that was configured (the startup contract of T11: a
 * misconfiguration is named by variable, its value stays out of the logs).
 */

// ─── EU-residency guard for the Meetings audio bucket (ADR-0016 posture) ───────
//
// Same endpoint-aware rule as refund-api/src/lib/s3Residency.ts (OWASP A05):
//
//   - endpoint host is `*.amazonaws.com` → the region string is meaningful, so
//     MEETINGS_S3_REGION must be in the EU AWS region allowlist;
//   - any other host (Railway, Scaleway, R2, MinIO, …) → the region string is an
//     opaque SDK placeholder that does NOT encode location, so residency is
//     enforced against the operator-declared MEETINGS_S3_EU_ENDPOINT_HOSTS
//     allowlist. An empty, unset or non-matching allowlist FAILS startup
//     closed — never a silent pass.
//

// shared-copy:begin s3ResidencyAllowlist
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

// shared-copy:end s3ResidencyAllowlist

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
        `MEETINGS_S3_REGION is not an EU AWS region (data residency, ADR-0016/AGENTS.md). ` +
        `Allowed: ${EU_AWS_REGIONS.join(", ")}`
      );
    }
    return null;
  }

  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return "MEETINGS_S3_ENDPOINT is not a valid URL";
  }

  if (euEndpointHosts.length === 0) {
    return (
      "MEETINGS_S3_ENDPOINT is a non-AWS endpoint, but MEETINGS_S3_EU_ENDPOINT_HOSTS is empty/unset: " +
      "residency cannot be verified without an operator-declared EU allowlist (data residency, " +
      "ADR-0016/AGENTS.md). Set it to a comma-separated list of EU endpoint host suffixes."
    );
  }

  if (!hostMatchesEuAllowlist(hostname, euEndpointHosts)) {
    return (
      "MEETINGS_S3_ENDPOINT host does not match any entry in MEETINGS_S3_EU_ENDPOINT_HOSTS: " +
      "refusing to start with an unverified non-EU endpoint (data residency, ADR-0016/AGENTS.md)."
    );
  }
  return null;
}

// shared-copy:begin s3ResidencyAddressing
/**
 * Non-AWS S3-compatible providers (Railway, MinIO, Scaleway, R2) need
 * path-style bucket addressing; real AWS S3 keeps the SDK's virtual-hosted
 * default.
 */
export function needsPathStyleAddressing(endpoint: string): boolean {
  return !isAwsS3Endpoint(endpoint);
}
// shared-copy:end s3ResidencyAddressing
