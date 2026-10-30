import { z } from "zod";
import { checkEuResidency, isAwsS3Endpoint } from "./s3Residency";

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
    // service JWT minted by auth (ADR-0044/0049). Production: notify-api's
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
