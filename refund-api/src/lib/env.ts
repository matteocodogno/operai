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
    // Suite-wide JWT audience value (ADR 20260713-jwt-audience-claim-enforcement). Must match the `audience` claim
    // stamped by the auth service's jwt plugin. A token missing this claim, or
    // carrying a different value, is rejected with 401 by jwtMiddleware.
    // refund-api is the suite's first *authorization*-enforcing resource server
    // (ADR 20260716-refund-api-authorization-enforcing-resource-server) built on top of this identity layer — capability/condition
    // enforcement is layered in by T6, not this bootstrap.
    AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
    // ─── authzMiddleware (T6, specs/20260716-refund-service, ADR 20260716-refund-api-authorization-enforcing-resource-server) ────────────
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
    // ─── Object storage (T9, specs/20260716-refund-service, ADR 20260716-eu-object-storage-refund-attachments) ─────────────
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
    // ─── notify-api internal call (T13, specs/20260716-refund-service, ADR 20260716-system-notifications-cross-user-trigger) ──
    // refund-api → notify-api `POST /system/notifications` and `/system/emails`
    // (best-effort, never rolls back the business action — src/lib/notify.ts,
    // notifyEmail.ts). Authenticated with refund-api's own service JWT
    // (SERVICE_CLIENT_* below, specs/20261013-notify-service-credentials, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired). The retired shared token
    // is no longer read — a deployment that still sets it starts normally and
    // the value is ignored.
    // notify-api's base URL for this internal call. Local: notify-api's own
    // dev port (8081). Production (Railway): notify-api's PRIVATE-networking
    // address, NOT its public domain — this call should never traverse the
    // public internet (mirrors auth's NOTIFY_INTERNAL_URL posture).
    NOTIFY_INTERNAL_URL: z
      .string()
      .url("NOTIFY_INTERNAL_URL must be a valid absolute URL"),
    // ─── Service credential (specs/20261013-notify-service-credentials, AC-4.2, ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049) ───────────────
    // Client-credentials pair for auth `POST /system/service-token`: the
    // scoped 5-minute JWT refund-api will present to notify-api. Required, so
    // a deployment without them exits at startup naming the variable.
    // `SERVICE_CLIENT_ID` must match an entry of auth's SERVICE_CLIENTS.
    SERVICE_CLIENT_ID: z.string().min(1, "SERVICE_CLIENT_ID is required"),
    SERVICE_CLIENT_SECRET: z
      .string()
      .min(32, "SERVICE_CLIENT_SECRET must be at least 32 characters"),
    // ─── Accounting (T17, specs/20261119-accounting; plan § "How Refund reads Accounting", ADR 20261119-accounting-reference-data-belongs-to-accounting-api-...) ──
    // accounting-api's base URL for the live, read-only reference-data and rate reads (`/system/v1/*`), authenticated with
    // refund-api's own service JWT (scope `accounting.reference.read`, via SERVICE_CLIENT_* above). Production (Railway):
    // accounting-api's PRIVATE-networking address, never its public domain. Required: the service refuses to start
    // without it. Only http(s) is accepted, and the client never follows a redirect, so the URL is the only place the
    // service token can go.
    ACCOUNTING_INTERNAL_URL: z
      .string()
      .url("ACCOUNTING_INTERNAL_URL must be a valid absolute URL")
      .refine((v) => /^https?:\/\//i.test(v), "ACCOUNTING_INTERNAL_URL must be an http(s) URL")
      .transform((v) => v.replace(/\/+$/, "")),
    // ─── Monthly batch processing (T14, specs/20260719-refund-monthly-processing,
    // ADR 20260719-refund-batch-signed-link-email-delivery) ────────────────────────────────────────────────────────────
    // specs/20260722-refund-settings (AC-4.1, D7, ADR 20260722-batch-email-recipient-live-resolution-amends-0021) — the accounting/
    // payroll distribution address the compiled-batch email (AC-3.1/3.4) is
    // sent to is NO LONGER a startup env var. It is now the admin-managed
    // `accounting-distribution-email` refund_setting (src/settings/),
    // resolved LIVE at every send/resend attempt (batches/email.ts). This
    // service does NOT read, require, or validate
    // `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — or any environment variable
    // — for it; startup succeeds with no such variable present at all. The
    // one-time production cutover of the formerly-deployed env value into
    // the new setting is a deliberate, documented operator step
    // (`bun run settings:seed`, refund-api/scripts/seed-setting.ts,
    // infra/README.md) — never a schema migration or a startup env read.
    //
    // Absolute base URL of the shell-hosted app (the shell's own public
    // origin, e.g. https://operai.welld.io — NOT refund-api's own URL and
    // NOT VITE_REFUND_API_URL, which is refund-api's origin), used to build
    // the compiled-batch email's in-app deep link
    // `${REFUND_APP_BASE_URL}/refund/batches/:id` (ADR 20260719-refund-batch-signed-link-email-delivery). The email
    // carries this link, never a raw presigned S3 URL — the recipient must
    // sign in and pass the same `request:review` authz check as any in-app
    // batch view before a short-lived presigned GET is minted. Required.
    REFUND_APP_BASE_URL: z
      .string()
      .url("REFUND_APP_BASE_URL must be a valid absolute URL"),
    // ─── Monthly exchange rates (T9, specs/20261118-refund-accounting-export) ──
    // Where `src/fx/` gets the federal monthly average rates: `bazg` (default) calls
    // the one fixed BAZG host on demand, `off` never makes an outbound call and
    // records every attempt as `disabled` (offline dev, e2e: rates are typed by
    // hand). Not a URL on purpose: the host is a constant in `fx/bazgSource.ts`
    // so no configuration can turn the fetch into a request to somewhere else
    // (SSRF guard). Any other value fails startup.
    REFUND_FX_SOURCE: z.enum(["bazg", "off"]).default("bazg"),
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
    z.flattenError(result.error).fieldErrors,
  )) {
    console.error(`  ${key}: ${messages?.join(", ")}`);
  }
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
