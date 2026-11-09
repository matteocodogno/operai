import { z } from "zod";
import { checkEuResidency, isAwsS3Endpoint } from "./s3Residency";

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// crm-api is an authorization-enforcing resource server (specs/017). specs/018
// adds two OPTIONAL integrations, each all-or-nothing: estimai-api (estimate
// requests, offers) and an EU bucket (offers, attachments). Without them the
// service starts and only those routes answer 503, so a developer's local setup
// keeps working before they are configured. The production template lists them
// as required (tools/env-doctor).

const S3_KEYS = [
  "CRM_S3_ENDPOINT",
  "CRM_S3_REGION",
  "CRM_S3_BUCKET",
  "CRM_S3_ACCESS_KEY_ID",
  "CRM_S3_SECRET_ACCESS_KEY",
] as const;

// specs/019: the notifier's credentials, all or none (decisions D-7).
const NOTIFY_KEYS = ["NOTIFY_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"] as const;

const envSchema = z.object({
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
  // ─── Identity (JWKS resource server, ADR-0005/0010) ───────────────────────
  AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
  AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
  // Suite-wide JWT audience (ADR-0010). A token missing the claim, or carrying
  // a different value, is rejected with 401.
  AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
  // Base URL of the `auth` service: the Bearer-forwarded GET /authz/resolve
  // (ADR-0014) and POST /authz/users/identities (ADR-0039).
  AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
  PORT: z.coerce.number().int().positive().default(8084),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  // ─── estimai-api (specs/018 US-3/US-4) ─────────────────────────────────────
  // Called with the CALLER's forwarded JWT only (no service credential): the
  // salesperson creates and reads the estimate as themselves.
  ESTIMAI_API_URL: z.string().url("ESTIMAI_API_URL must be a valid URL").optional(),
  // ─── Offers and attachments bucket (ADR-0016 posture, specs/018 US-4) ──────
  // Own bucket and credentials — never refund's or inventory's. Private: every
  // read is a ~60 s presigned GET minted after the authorization check.
  CRM_S3_ENDPOINT: z.string().url("CRM_S3_ENDPOINT must be a valid URL").optional(),
  CRM_S3_REGION: z.string().min(1).optional(),
  CRM_S3_BUCKET: z.string().min(1).optional(),
  CRM_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  CRM_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  // ─── notify-api (specs/019, ADR-0049) ──────────────────────────────────────
  // crm-api pushes as ITSELF: it trades its service client for a 5-minute scoped
  // JWT (`notifications.push emails.send`) at auth. Without the group the
  // notifier is a no-op.
  NOTIFY_INTERNAL_URL: z.string().url("NOTIFY_INTERNAL_URL must be a valid URL").optional(),
  SERVICE_CLIENT_ID: z.string().min(1).optional(),
  SERVICE_CLIENT_SECRET: z.string().min(32, "SERVICE_CLIENT_SECRET must be at least 32 characters").optional(),
  // ─── estimai-api (specs/024 US-3, ADR-0076) ────────────────────────────────
  // Base URL (Railway private network) for the deal-link notices crm-api pushes
  // as ITSELF with the service client above (scope `deal-link-notices.send`).
  // Unset: the push is a no-op, logged once at startup.
  ESTIMAI_INTERNAL_URL: z.string().url("ESTIMAI_INTERNAL_URL must be a valid URL").optional(),
  // ─── Service credentials accepted on /system/* (specs/018 AC-3.3 ADR-0073, specs/021-meetings, specs/024-projects ADR-0076) ──
  // The `aud` of the scoped service JWTs `auth` mints (`POST /system/service-token`);
  // byte-identical to auth's and notify-api's, and different from AUTH_AUDIENCE so a
  // user JWT is never a system credential. Optional so the service starts without it;
  // unset, every /system/* request (`/system/companies`, `/system/estimate-notices`,
  // `/system/meeting-host/v1/notices`, …) is a 401 (fail closed). tools/env-doctor
  // lists it as required in production.
  SERVICE_AUDIENCE: z.string().min(1, "SERVICE_AUDIENCE must not be empty").optional(),
  CRM_S3_EU_ENDPOINT_HOSTS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    ),
}).superRefine((val, ctx) => {
  if (val.SERVICE_AUDIENCE !== undefined && val.SERVICE_AUDIENCE === val.AUTH_AUDIENCE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SERVICE_AUDIENCE"], message: "SERVICE_AUDIENCE must differ from AUTH_AUDIENCE (ADR-0044)" });
  }
  if (val.ESTIMAI_INTERNAL_URL !== undefined) {
    for (const key of ["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"] as const) {
      if (val[key] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when ESTIMAI_INTERNAL_URL is set` });
      }
    }
  }
  const notifySet = NOTIFY_KEYS.filter((key) => val[key] !== undefined);
  if (notifySet.length > 0 && notifySet.length < NOTIFY_KEYS.length) {
    // With ESTIMAI_INTERNAL_URL the service client may stand without the notify URL.
    const clientOnly = val.ESTIMAI_INTERNAL_URL !== undefined && val.NOTIFY_INTERNAL_URL === undefined;
    for (const key of NOTIFY_KEYS.filter((k) => val[k] === undefined && !(clientOnly && k === "NOTIFY_INTERNAL_URL"))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when any of NOTIFY_INTERNAL_URL, SERVICE_CLIENT_ID, SERVICE_CLIENT_SECRET is set` });
    }
  }
  const set = S3_KEYS.filter((key) => val[key] !== undefined);
  if (set.length === 0) return;
  if (set.length < S3_KEYS.length) {
    for (const key of S3_KEYS.filter((k) => val[k] === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when any CRM_S3_* is set` });
    }
    return;
  }
  const residencyError = checkEuResidency(val.CRM_S3_ENDPOINT!, val.CRM_S3_REGION!, val.CRM_S3_EU_ENDPOINT_HOSTS);
  if (residencyError) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [isAwsS3Endpoint(val.CRM_S3_ENDPOINT!) ? "CRM_S3_REGION" : "CRM_S3_EU_ENDPOINT_HOSTS"],
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
