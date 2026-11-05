import { z } from "zod";
import { checkEuResidency, isAwsS3Endpoint } from "./s3Residency";
import {
  GCP_PROJECT_ID_PATTERN,
  GCS_BUCKET_NAME_PATTERN,
  checkNoVertexBaseUrlOverride,
  checkSpeechLocation,
  checkVertexLocation,
  checkVertexModelId,
  parseServiceAccountKey,
} from "./residency";

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// The full environment of specs/021-meetings (plan.md § Environment), validated
// at import. A misconfiguration exits 1 naming the VARIABLE, never its value
// (AC-4.9: the output is read by operators and log aggregators, and half of
// these values are secrets). Hence every custom message below is value-free and
// enums carry an explicit `errorMap`: zod's default enum message quotes the
// received value.
//
// Unlike crm-api there is no "optional group" for storage: a meetings service
// without audio storage is meaningless, so MEETINGS_S3_* is required.

const NOTIFY_KEYS = ["NOTIFY_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"] as const;
// plan.md § Amendment 2026-11-05 G-7: all six with MEETINGS_AI_PROVIDER=real; optional (and validated
// when set) with the fake, so the local dev path needs no Google project.
const REAL_PROVIDER_KEYS = [
  "MEETINGS_SPEECH_LOCATION",
  "MEETINGS_VERTEX_LOCATION",
  "MEETINGS_VERTEX_MODEL_ID",
  "MEETINGS_GCP_PROJECT_ID",
  "MEETINGS_GCP_SERVICE_ACCOUNT_KEY",
  "MEETINGS_GCS_TRANSIENT_BUCKET",
] as const;
const PRODUCTION_REQUIRED_KEYS = [...NOTIFY_KEYS, "CRM_API_URL"] as const;

const oneOf = <const T extends readonly [string, ...string[]]>(values: T, name: string) =>
  z.enum(values, { errorMap: () => ({ message: `${name} must be one of: ${values.join(", ")}` }) });

const optionalString = () => z.string().min(1).optional();

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
    // Suite-wide JWT audience (ADR-0010): a token without it, or with another value, is a 401.
    AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
    // `auth`: GET /authz/resolve (ADR-0014), POST /authz/users/identities (ADR-0039),
    // POST /system/service-token (ADR-0044/0049).
    AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
    PORT: z.coerce.number().int().positive().default(8085),
    NODE_ENV: oneOf(["development", "production", "test"], "NODE_ENV").default("development"),

    // ─── The audio bucket (ADR-0016 posture; ADR-0063) ──────────────────────
    // Own bucket and credentials, never another service's. Private: every read
    // is a presigned GET minted after the visibility check.
    MEETINGS_S3_ENDPOINT: z.string().url("MEETINGS_S3_ENDPOINT must be a valid URL"),
    MEETINGS_S3_REGION: z.string().min(1, "MEETINGS_S3_REGION is required"),
    MEETINGS_S3_BUCKET: z.string().min(1, "MEETINGS_S3_BUCKET is required"),
    MEETINGS_S3_ACCESS_KEY_ID: z.string().min(1, "MEETINGS_S3_ACCESS_KEY_ID is required"),
    MEETINGS_S3_SECRET_ACCESS_KEY: z.string().min(1, "MEETINGS_S3_SECRET_ACCESS_KEY is required"),
    MEETINGS_S3_EU_ENDPOINT_HOSTS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h.length > 0),
      ),

    // ─── notify-api (ADR-0044/0049): in-app notifications as `system:meetings-api` ─
    // All or none; required in production.
    NOTIFY_INTERNAL_URL: z.string().url("NOTIFY_INTERNAL_URL must be a valid URL").optional(),
    SERVICE_CLIENT_ID: optionalString(),
    SERVICE_CLIENT_SECRET: z.string().min(32, "SERVICE_CLIENT_SECRET must be at least 32 characters").optional(),

    // ─── Hosts (ADR-0059) ───────────────────────────────────────────────────
    // The CRM host's base URL (Railway private DNS). Required in production.
    CRM_API_URL: z.string().url("CRM_API_URL must be a valid URL").optional(),
    // JSON array of host definitions; TEST ONLY, refused in production. Its shape is
    // validated by the host registry (src/hosts/registry.ts).
    MEETINGS_TEST_HOSTS: z.string().optional(),

    // ─── AI providers (ADR-0061 principle, ADR-0069 providers) ──────────────
    MEETINGS_AI_PROVIDER: oneOf(["real", "fake"], "MEETINGS_AI_PROVIDER").default("real"),
    // Speech-to-Text v2 (Chirp 3): the endpoint host is derived from the location, never configured (S1).
    MEETINGS_SPEECH_LOCATION: optionalString(),
    // Claude on Vertex AI: the base URL is derived from the location (S2); the model id is pinned (S3).
    MEETINGS_VERTEX_LOCATION: optionalString(),
    MEETINGS_VERTEX_MODEL_ID: optionalString(),
    MEETINGS_GCP_PROJECT_ID: optionalString(),
    // Base64 of the runtime service account's JSON key (S4). SECRET: never logged, never echoed.
    MEETINGS_GCP_SERVICE_ACCOUNT_KEY: optionalString(),
    // The transient processing bucket; its location and rules are read at startup (N2).
    MEETINGS_GCS_TRANSIENT_BUCKET: optionalString(),
    // Refused when set (S5): the adapter derives its own base URL and must not be redirected by the environment.
    ANTHROPIC_VERTEX_BASE_URL: z.string().optional(),

    // ─── Worker (ADR-0062) ──────────────────────────────────────────────────
    MEETINGS_WORKER: oneOf(["on", "off", "only"], "MEETINGS_WORKER").default("on"),
  })
  .superRefine((val, ctx) => {
    const issue = (key: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
    const production = val.NODE_ENV === "production";

    // Bucket residency (AC-4.9), only meaningful once the five values are individually valid.
    const residency = checkEuResidency(val.MEETINGS_S3_ENDPOINT, val.MEETINGS_S3_REGION, val.MEETINGS_S3_EU_ENDPOINT_HOSTS);
    if (residency) {
      issue(isAwsS3Endpoint(val.MEETINGS_S3_ENDPOINT) ? "MEETINGS_S3_REGION" : "MEETINGS_S3_EU_ENDPOINT_HOSTS", residency);
    }

    // notify group: all or none, and required in production.
    const notifySet = NOTIFY_KEYS.filter((key) => val[key] !== undefined);
    if (notifySet.length > 0 && notifySet.length < NOTIFY_KEYS.length) {
      for (const key of NOTIFY_KEYS.filter((k) => val[k] === undefined)) {
        issue(key, `${key} is required when any of ${NOTIFY_KEYS.join(", ")} is set`);
      }
    }
    if (production) {
      for (const key of PRODUCTION_REQUIRED_KEYS) {
        if (val[key] === undefined) issue(key, `${key} is required in production`);
      }
    }

    // Test seams never reach production.
    if (production && val.MEETINGS_AI_PROVIDER === "fake") {
      issue("MEETINGS_AI_PROVIDER", "MEETINGS_AI_PROVIDER=fake is refused in production");
    }
    if (production && val.MEETINGS_TEST_HOSTS !== undefined) {
      issue("MEETINGS_TEST_HOSTS", "MEETINGS_TEST_HOSTS is refused in production");
    }
    if (val.MEETINGS_TEST_HOSTS !== undefined && !production) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(val.MEETINGS_TEST_HOSTS);
      } catch {
        parsed = undefined;
      }
      if (!Array.isArray(parsed)) issue("MEETINGS_TEST_HOSTS", "MEETINGS_TEST_HOSTS must be a JSON array");
    }

    // Real providers: everything present (AC-4.9 is only as good as the config being complete)...
    if (val.MEETINGS_AI_PROVIDER === "real") {
      for (const key of REAL_PROVIDER_KEYS) {
        if (val[key] === undefined) issue(key, `${key} is required with MEETINGS_AI_PROVIDER=real`);
      }
    }
    // ...and located in the EU, with a key that is the right kind of key. Checked whenever set, fake
    // provider included: a wrong location should not wait for production to be noticed.
    if (val.MEETINGS_SPEECH_LOCATION !== undefined) {
      const speech = checkSpeechLocation(val.MEETINGS_SPEECH_LOCATION);
      if (speech) issue("MEETINGS_SPEECH_LOCATION", speech);
    }
    if (val.MEETINGS_VERTEX_LOCATION !== undefined) {
      const vertex = checkVertexLocation(val.MEETINGS_VERTEX_LOCATION);
      if (vertex) issue("MEETINGS_VERTEX_LOCATION", vertex);
    }
    if (val.MEETINGS_VERTEX_MODEL_ID !== undefined) {
      const model = checkVertexModelId(val.MEETINGS_VERTEX_MODEL_ID);
      if (model) issue("MEETINGS_VERTEX_MODEL_ID", model);
    }
    // The project id and the bucket name are placed in request paths: a shape check keeps them from steering one.
    if (val.MEETINGS_GCP_PROJECT_ID !== undefined && !GCP_PROJECT_ID_PATTERN.test(val.MEETINGS_GCP_PROJECT_ID)) {
      issue("MEETINGS_GCP_PROJECT_ID", "MEETINGS_GCP_PROJECT_ID is not a valid Google Cloud project id");
    }
    if (val.MEETINGS_GCS_TRANSIENT_BUCKET !== undefined && !GCS_BUCKET_NAME_PATTERN.test(val.MEETINGS_GCS_TRANSIENT_BUCKET)) {
      issue("MEETINGS_GCS_TRANSIENT_BUCKET", "MEETINGS_GCS_TRANSIENT_BUCKET is not a valid bucket name");
    }
    if (val.MEETINGS_GCP_SERVICE_ACCOUNT_KEY !== undefined) {
      if (val.MEETINGS_GCP_PROJECT_ID === undefined) {
        issue("MEETINGS_GCP_PROJECT_ID", "MEETINGS_GCP_PROJECT_ID is required when MEETINGS_GCP_SERVICE_ACCOUNT_KEY is set");
      } else {
        const key = parseServiceAccountKey(val.MEETINGS_GCP_SERVICE_ACCOUNT_KEY, val.MEETINGS_GCP_PROJECT_ID);
        if (key.error) issue("MEETINGS_GCP_SERVICE_ACCOUNT_KEY", key.error);
      }
    }
    const baseUrl = checkNoVertexBaseUrlOverride(val.ANTHROPIC_VERTEX_BASE_URL);
    if (baseUrl) issue("ANTHROPIC_VERTEX_BASE_URL", baseUrl);
  })
  .transform((val) => ({
    ...val,
    // Already validated as a JSON array above; the registry validates each element.
    MEETINGS_TEST_HOSTS: (val.MEETINGS_TEST_HOSTS === undefined ? [] : (JSON.parse(val.MEETINGS_TEST_HOSTS) as unknown[])),
  }));

export type Env = z.output<typeof envSchema>;

export type EnvResult =
  | { readonly ok: true; readonly env: Env }
  | { readonly ok: false; readonly errors: Readonly<Record<string, readonly string[]>> };

/** Pure: no exit, no logging. `env` below is this applied to `process.env`. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): EnvResult {
  const result = envSchema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  const errors: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(result.error.flatten().fieldErrors)) {
    errors[key] = (messages as string[] | undefined) ?? [];
  }
  return { ok: false, errors };
}

const parsed = parseEnv(process.env);

if (!parsed.ok) {
  console.error("Invalid environment variables, fix before starting:");
  for (const [key, messages] of Object.entries(parsed.errors)) {
    // Variable names and value-free messages only: secrets live in this environment.
    console.error(`  ${key}: ${messages.join(", ")}`);
  }
  process.exit(1);
}

export const env: Env = parsed.env;
