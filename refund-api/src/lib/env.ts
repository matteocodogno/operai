import { z } from "zod";
import { checkEuResidency, isAwsS3Endpoint } from "./s3Residency";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    ALLOWED_ORIGINS: z
      .string()
      .min(1)
      .transform((v) => v.split(",").map((o) => o.trim())),
    AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
    AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
    // Suite-wide JWT audience value (ADR-0010). Must match the `audience` claim
    // stamped by the auth service's jwt plugin. A token missing this claim, or
    // carrying a different value, is rejected with 401 by jwtMiddleware.
    // refund-api is the suite's first *authorization*-enforcing resource server
    // (ADR-0014) built on top of this identity layer — capability/condition
    // enforcement is layered in by T6, not this bootstrap.
    AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
    // ─── authzMiddleware (T6, specs/007-refund-service, ADR-0014) ────────────
    // Base URL of the `auth` service, used ONLY to call the Bearer-forwarded
    // `GET /authz/resolve` (T1) so refund-api can resolve the caller's own
    // effective refund permissions + entity/jobTitle locally-cached
    // (sub, perm_epoch), 30s TTL backstop. Distinct from AUTH_ISSUER (a JWT
    // claim-verification value, not necessarily dereferenceable as an HTTP
    // base — they happen to coincide in this suite's current deployment, but
    // the two concerns are kept separate here on purpose).
    AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
    PORT: z.coerce.number().int().positive().default(8082),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    // ─── Object storage (T9, specs/007-refund-service, ADR-0016) ─────────────
    // EU-region S3-compatible bucket for receipt attachments — presigned URLs
    // ONLY (src/lib/storage.ts); refund-api's own process never touches file
    // bytes. All five are required — the service refuses to start without a
    // fully-configured bucket (financial/PII documents must never fall back
    // to an unconfigured or accidentally-non-EU store).
    //
    // PROVISIONED (as of T9): a Railway S3-compatible bucket in EU Amsterdam
    // — a CUSTOM, non-AWS endpoint. See src/lib/s3Residency.ts for why the
    // EU-residency assertion below is endpoint-aware rather than a blanket
    // AWS-region allowlist (a non-AWS `region` string is an opaque SDK
    // placeholder, not a location). The bucket MUST be private (no
    // public-read ACL/policy) — every read goes through the short-lived
    // (~60s) presigned GET minted only after the ownership/entity-scope
    // check passes (GET .../attachments/:aid/url). Deploy checklist: verify
    // the Railway bucket's public-access toggle is OFF before go-live.
    REFUND_S3_ENDPOINT: z
      .string()
      .url("REFUND_S3_ENDPOINT must be a valid URL"),
    REFUND_S3_REGION: z.string().min(1, "REFUND_S3_REGION is required"),
    REFUND_S3_BUCKET: z.string().min(1, "REFUND_S3_BUCKET is required"),
    REFUND_S3_ACCESS_KEY_ID: z
      .string()
      .min(1, "REFUND_S3_ACCESS_KEY_ID is required"),
    REFUND_S3_SECRET_ACCESS_KEY: z
      .string()
      .min(1, "REFUND_S3_SECRET_ACCESS_KEY is required"),
    // OWASP A05 fix — the EU-residency guard used to be a silent no-op for
    // any non-AWS endpoint (see s3Residency.ts's file header). This
    // operator-declared allowlist makes residency code-enforced for the
    // real deployed target (a Railway EU-Amsterdam S3-compatible bucket, a
    // non-AWS host): a comma-separated list of EU endpoint host suffixes,
    // consulted ONLY when REFUND_S3_ENDPOINT's host is NOT `*.amazonaws.com`
    // (checkEuResidency, s3Residency.ts). Optional at the schema level (a
    // pure-AWS deployment never needs it — the AWS-region allowlist covers
    // that branch), but for a non-AWS endpoint like ours, an
    // empty/unset/non-matching allowlist FAILS startup closed
    // (`process.exit(1)` below) — never a silent pass.
    REFUND_S3_EU_ENDPOINT_HOSTS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h.length > 0),
      ),
    // ─── notify-api internal call (T13, specs/007-refund-service, ADR-0017) ──
    // refund-api → notify-api `POST /system/notifications` after an
    // approve/reject decision commits (best-effort, never rolls back the
    // decision — src/lib/notify.ts). Same shared-secret pattern as
    // auth → notify-api's existing `/system/emails` call (ADR-0011);
    // NOT a user JWT/JWKS path. MUST be byte-for-byte identical to
    // notify-api's own NOTIFY_INTERNAL_TOKEN (and auth's) — three services
    // now share this one secret (ADR-0017's "second internal caller" trigger,
    // knowingly not escalated to a scoped service JWT yet).
    NOTIFY_INTERNAL_TOKEN: z
      .string()
      .min(32, "NOTIFY_INTERNAL_TOKEN must be at least 32 characters"),
    // notify-api's base URL for this internal call. Local: notify-api's own
    // dev port (8081). Production (Railway): notify-api's PRIVATE-networking
    // address, NOT its public domain — this call should never traverse the
    // public internet (mirrors auth's NOTIFY_INTERNAL_URL posture).
    NOTIFY_INTERNAL_URL: z
      .string()
      .url("NOTIFY_INTERNAL_URL must be a valid absolute URL"),
  })
  .superRefine((val, ctx) => {
    const residencyError = checkEuResidency(
      val.REFUND_S3_ENDPOINT,
      val.REFUND_S3_REGION,
      val.REFUND_S3_EU_ENDPOINT_HOSTS,
    );
    if (residencyError) {
      // AWS branch fails on the region value; the non-AWS branch fails on
      // the endpoint/allowlist mismatch — attribute the zod issue to
      // whichever var the operator actually needs to fix.
      const path = isAwsS3Endpoint(val.REFUND_S3_ENDPOINT)
        ? ["REFUND_S3_REGION"]
        : ["REFUND_S3_EU_ENDPOINT_HOSTS"];
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
    console.error(`  ${key}: ${messages?.join(", ")}`);
  }
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
