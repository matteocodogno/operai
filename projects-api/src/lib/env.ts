import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// projects-api is an authorization-enforcing resource server (specs/021, ADR-0014).
// It reads CRM company names from crm-api with a service credential (ADR-0059), an
// OPTIONAL group, all-or-nothing: without it the service starts, a company name is
// `null` and the company picker answers 503 `crm_unavailable`, so a developer's local
// setup keeps working before the group is configured. The production template lists
// the group as required (tools/env-doctor).

const CRM_KEYS = ["CRM_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"] as const;

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
      .refine((origins) => origins.every((o) => o !== "*"), "ALLOWED_ORIGINS must not contain a wildcard"),
    // ─── Identity (JWKS resource server, ADR-0005/0010) ─────────────────────
    AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
    AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
    // Suite-wide JWT audience (ADR-0010). A token missing the claim, or carrying
    // a different value, is rejected with 401.
    AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
    // Base URL of the `auth` service: the Bearer-forwarded GET /authz/resolve
    // (ADR-0014), POST /authz/users/identities (ADR-0039), POST /authz/app-access-check
    // (ADR-0055) and, for the service credential, POST /system/service-token (ADR-0044).
    AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
    PORT: z.coerce.number().int().positive().default(8085),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    // ─── crm-api, read as ITSELF (specs/021, ADR-0059) ───────────────────────
    // projects-api trades its service client for a 5-minute scoped JWT
    // (`crm.companies.read`) at auth and calls crm-api `GET /system/companies`.
    CRM_INTERNAL_URL: z.string().url("CRM_INTERNAL_URL must be a valid URL").optional(),
    SERVICE_CLIENT_ID: z.string().min(1).optional(),
    SERVICE_CLIENT_SECRET: z.string().min(32, "SERVICE_CLIENT_SECRET must be at least 32 characters").optional(),
    // ─── estimai-api, read as ITSELF (specs/022, ADR-0061) ───────────────────
    // Base URL of estimai-api: `GET /system/estimates/{id}/summary` with the same service
    // credential as crm-api's (scope `estimai.estimates.read`) gives the man-days the fixed-price
    // terms of a project made from a deal copy. Optional: unset, taking such a deal answers 503
    // `estimai_unconfigured`, and nothing else in the module notices.
    ESTIMAI_INTERNAL_URL: z.string().url("ESTIMAI_INTERNAL_URL must be a valid URL").optional(),
    // ─── notify-api, pushed to as ITSELF (specs/022, AC-4.3) ──────────────────
    // Base URL of notify-api: `POST /system/notifications` with the same service credential as
    // crm-api's (scope `notifications.push`, originApp `projects`) tells the ops-manager of a taken
    // deal about the new purchase order. Optional, like ESTIMAI_INTERNAL_URL: unset, or without the
    // service credential, the push is a no-op and the take is unaffected (best-effort, AC-4.4).
    NOTIFY_INTERNAL_URL: z.string().url("NOTIFY_INTERNAL_URL must be a valid URL").optional(),
    // ─── Service credentials accepted on /system/* (specs/022, ADR-0060) ─────
    // The `aud` of the scoped service JWTs `auth` mints (`POST /system/service-token`);
    // byte-identical to auth's, and different from AUTH_AUDIENCE so a user JWT is never a
    // system credential. Optional so the service starts without it; unset, every /system/*
    // request is a 401 (fail closed). tools/env-doctor lists it as required in production.
    SERVICE_AUDIENCE: z.string().min(1, "SERVICE_AUDIENCE must not be empty").optional(),
  })
  .superRefine((val, ctx) => {
    if (val.SERVICE_AUDIENCE !== undefined && val.SERVICE_AUDIENCE === val.AUTH_AUDIENCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SERVICE_AUDIENCE"],
        message: "SERVICE_AUDIENCE must differ from AUTH_AUDIENCE (ADR-0044)",
      });
    }
    const set = CRM_KEYS.filter((key) => val[key] !== undefined);
    if (set.length > 0 && set.length < CRM_KEYS.length) {
      for (const key of CRM_KEYS.filter((k) => val[k] === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when any of CRM_INTERNAL_URL, SERVICE_CLIENT_ID, SERVICE_CLIENT_SECRET is set`,
        });
      }
    }
  });

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables — fix before starting:");
  for (const [key, messages] of Object.entries(result.error.flatten().fieldErrors)) {
    // Messages only — never echo a value (secrets live in this environment).
    console.error(`  ${key}: ${messages?.join(", ")}`);
  }
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
