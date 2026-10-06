import { z } from "zod";

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
// Kept inside env.ts for T1 (T21 ports storage.ts and s3Residency.ts as their
// own files and may move these helpers there).

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

// ─── Schema ──────────────────────────────────────────────────────────────────

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    ALLOWED_ORIGINS: z
      .string()
      .min(1, "ALLOWED_ORIGINS is required")
      .transform((v) =>
        v
          .split(",")
          .map((o) => o.trim())
          .filter((o) => o.length > 0),
      )
      .refine((origins) => origins.length > 0, "ALLOWED_ORIGINS is empty")
      .refine(
        (origins) => origins.every((o) => o !== "*"),
        "ALLOWED_ORIGINS must not contain a wildcard",
      ),
    // ─── Identity (JWKS resource server, ADR-0005/0010) ─────────────────────
    AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
    AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
    // Suite-wide JWT audience (ADR-0010). A token missing the claim, or
    // carrying a different value, is rejected with 401.
    AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
    // Base URL of the `auth` service: the Bearer-forwarded GET /authz/resolve
    // (ADR-0014), POST /authz/users/identities (ADR-0039) and
    // POST /system/service-token (ADR-0044).
    AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
    PORT: z.coerce.number().int().positive().default(8083),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    // ─── Invoice-file object storage (ADR-0016 posture) ─────────────────────
    // Own bucket and credentials — never refund-api's. All five core vars are
    // required; the service refuses to start without a fully configured
    // bucket. The bucket MUST be private: every read is a ~60 s presigned GET
    // minted after the entity-scope check.
    INVENTORY_S3_ENDPOINT: z
      .string()
      .url("INVENTORY_S3_ENDPOINT must be a valid URL"),
    INVENTORY_S3_REGION: z.string().min(1, "INVENTORY_S3_REGION is required"),
    INVENTORY_S3_BUCKET: z.string().min(1, "INVENTORY_S3_BUCKET is required"),
    INVENTORY_S3_ACCESS_KEY_ID: z
      .string()
      .min(1, "INVENTORY_S3_ACCESS_KEY_ID is required"),
    INVENTORY_S3_SECRET_ACCESS_KEY: z
      .string()
      .min(1, "INVENTORY_S3_SECRET_ACCESS_KEY is required"),
    // Operator-declared allowlist of EU endpoint host suffixes, consulted only
    // for a non-AWS endpoint (see checkEuResidency above).
    INVENTORY_S3_EU_ENDPOINT_HOSTS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h.length > 0),
      ),
    // ─── notify-api internal call (plan § Service authentication) ───────────
    // Push goes to POST /system/notifications authenticated with a scoped
    // service JWT minted by auth — NOT NOTIFY_INTERNAL_TOKEN (ADR-0040's hard
    // stop: no fourth holder of the shared token). Production: notify-api's
    // PRIVATE-networking address, never its public domain.
    NOTIFY_INTERNAL_URL: z
      .string()
      .url("NOTIFY_INTERNAL_URL must be a valid absolute URL"),
    // Client-credentials pair for auth POST /system/service-token (ADR-0044).
    // `SERVICE_CLIENT_ID` must match an entry of auth's SERVICE_CLIENTS.
    SERVICE_CLIENT_ID: z.string().min(1, "SERVICE_CLIENT_ID is required"),
    SERVICE_CLIENT_SECRET: z
      .string()
      .min(32, "SERVICE_CLIENT_SECRET must be at least 32 characters"),
  })
  .superRefine((val, ctx) => {
    const residencyError = checkEuResidency(
      val.INVENTORY_S3_ENDPOINT,
      val.INVENTORY_S3_REGION,
      val.INVENTORY_S3_EU_ENDPOINT_HOSTS,
    );
    if (residencyError) {
      // AWS branch fails on the region value; the non-AWS branch fails on the
      // endpoint/allowlist mismatch — attribute the issue to the var to fix.
      const path = isAwsS3Endpoint(val.INVENTORY_S3_ENDPOINT)
        ? ["INVENTORY_S3_REGION"]
        : ["INVENTORY_S3_EU_ENDPOINT_HOSTS"];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: residencyError,
      });
    }
  });

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables — fix before starting:");
  for (const [key, messages] of Object.entries(
    result.error.flatten().fieldErrors,
  )) {
    // Messages only — never echo a value (secrets live in this environment).
    console.error(`  ${key}: ${messages?.join(", ")}`);
  }
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
