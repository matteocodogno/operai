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
 *   - Any other host (Railway, Scaleway, R2, MinIO, …) → `region` is an
 *     opaque SDK value that does NOT encode location, so residency instead
 *     must be CODE-ENFORCED against an operator-declared EU allowlist:
 *     `REFUND_S3_EU_ENDPOINT_HOSTS` (env.ts, comma-separated host suffixes).
 *     If the endpoint's host matches none of them — INCLUDING when the
 *     allowlist itself is empty/unset — startup FAILS CLOSED
 *     (`process.exit(1)` via env.ts's `superRefine`, never a silent no-op).
 *
 * OWASP A05 fix (data-residency guard was a no-op for non-AWS endpoints):
 * previously a non-AWS endpoint returned `null` (pass) unconditionally —
 * residency was merely "operator-asserted by the choice of endpoint" with no
 * code-level check at all. A mis-set non-EU non-AWS endpoint would have
 * started silently. `REFUND_S3_EU_ENDPOINT_HOSTS` closes that gap: residency
 * for a non-AWS endpoint is now both code-enforced AND explicitly
 * operator-declared, never assumed.
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
 * True when `hostname` exactly matches, or is a subdomain of, one of the
 * operator-declared EU endpoint host suffixes.
 */
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
 * Returns an error message when residency cannot be asserted, or `null` when
 * it's fine to proceed. Called from env.ts's `superRefine` at startup.
 *
 * `euEndpointHosts` is `REFUND_S3_EU_ENDPOINT_HOSTS` (env.ts) — a
 * comma-separated, operator-declared allowlist of EU endpoint host suffixes,
 * consulted ONLY for a non-AWS endpoint (see file header). Fails closed: an
 * empty/unset allowlist, or a non-matching host, both reject — never a
 * silent pass.
 */
export function checkEuResidency(
  endpoint: string,
  region: string,
  euEndpointHosts: readonly string[],
): string | null {
  if (isAwsS3Endpoint(endpoint)) {
    if (!(EU_AWS_REGIONS as readonly string[]).includes(region)) {
      return (
        `REFUND_S3_REGION "${region}" is not an EU AWS region (data residency, ` +
        `ADR-0016/CLAUDE.md). Allowed: ${EU_AWS_REGIONS.join(", ")}`
      );
    }
    return null;
  }

  // Non-AWS endpoint (Railway, Scaleway, R2, MinIO, ...) — `region` is an
  // opaque SDK value that does not encode location (see file header), so
  // residency must be code-enforced against the operator-declared
  // REFUND_S3_EU_ENDPOINT_HOSTS allowlist. OWASP A05 fix: this branch used
  // to return `null` unconditionally here — a silent no-op that would let a
  // mis-set non-EU endpoint start without any check at all.
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return `REFUND_S3_ENDPOINT "${endpoint}" is not a valid URL`;
  }

  if (euEndpointHosts.length === 0) {
    return (
      `REFUND_S3_ENDPOINT "${endpoint}" is a non-AWS endpoint, but ` +
      `REFUND_S3_EU_ENDPOINT_HOSTS is empty/unset — residency cannot be ` +
      `verified for a non-AWS endpoint without an operator-declared EU ` +
      `allowlist (data residency, ADR-0016/CLAUDE.md). Set ` +
      `REFUND_S3_EU_ENDPOINT_HOSTS to a comma-separated list of EU endpoint ` +
      `host suffixes (e.g. "s3.railway-eu-amsterdam.example.com").`
    );
  }

  if (!hostMatchesEuAllowlist(hostname, euEndpointHosts)) {
    return (
      `REFUND_S3_ENDPOINT host "${hostname}" does not match any entry in ` +
      `REFUND_S3_EU_ENDPOINT_HOSTS (${euEndpointHosts.join(", ")}) — refusing ` +
      `to start with an unverified non-EU endpoint (data residency, ` +
      `ADR-0016/CLAUDE.md).`
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
