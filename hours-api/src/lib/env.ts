import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// hours-api is a JWKS resource server (specs/029, ADR-0088): who is calling is the JWT, and
// whether that person may book on a project, a deal or a meeting is asked of each owner as the
// caller (ADR-0089). So the four owner URLs are required: with no owner to ask, nothing can be
// authorised, and a missing URL stops the start rather than reading as "no access".
// The service credential (client id and secret, the audience of the JWT they mint) is required
// too: a meeting's current deal is read from meetings-api with hours-api's OWN credential, and
// without it every deal-filtered read would be refused and every by-deal total would be wrong.
// Every variable is validated here, so the tasks that use one read it without editing this file.

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
    // ─── Identity (JWKS resource server, ADR-0005/0010) ───────────────────────
    AUTH_JWKS_URL: z.string().url("AUTH_JWKS_URL must be a valid URL"),
    AUTH_ISSUER: z.string().url("AUTH_ISSUER must be a valid URL"),
    // Suite-wide JWT audience (ADR-0010). A token missing the claim, or carrying a different
    // value, is rejected with 401.
    AUTH_AUDIENCE: z.string().min(1, "AUTH_AUDIENCE is required"),
    // Base URL of the `auth` service: users/identities, resolve (the two permissions), and the
    // service token endpoint.
    AUTH_BASE_URL: z.string().url("AUTH_BASE_URL must be a valid URL"),
    // ─── Owners (ADR-0089) ────────────────────────────────────────────────────
    // Railway private network. Called with the caller's own Authorization header, except
    // meetings-api's system route, which gets hours-api's own service JWT.
    PROJECTS_API_URL: z.string().url("PROJECTS_API_URL must be a valid URL"),
    CRM_API_URL: z.string().url("CRM_API_URL must be a valid URL"),
    ACTIVITIES_API_URL: z.string().url("ACTIVITIES_API_URL must be a valid URL"),
    MEETINGS_API_URL: z.string().url("MEETINGS_API_URL must be a valid URL"),
    // ─── Service credential, as itself (ADR-0044/0049) ────────────────────────
    SERVICE_CLIENT_ID: z.string().min(1, "SERVICE_CLIENT_ID is required"),
    SERVICE_CLIENT_SECRET: z.string().min(32, "SERVICE_CLIENT_SECRET must be at least 32 characters"),
    // Audience of the service JWT: auth's SERVICE_AUDIENCE, never the user audience (ADR-0044).
    SERVICE_AUDIENCE: z.string().min(1, "SERVICE_AUDIENCE is required"),
    PORT: z.coerce.number().int().positive().default(8088),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .superRefine((val, ctx) => {
    if (val.SERVICE_AUDIENCE === val.AUTH_AUDIENCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SERVICE_AUDIENCE"],
        message: "SERVICE_AUDIENCE must differ from AUTH_AUDIENCE (ADR-0044)",
      });
    }
  });

export type EnvResult =
  | { readonly ok: true; readonly env: z.output<typeof envSchema> }
  | { readonly ok: false; readonly errors: Readonly<Record<string, readonly string[]>> };

/** Pure: no exit, no logging. `env` below is this applied to `process.env`. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): EnvResult {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: parsed.data };
  const errors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    // Messages only — never a received value (secrets live in this environment).
    (errors[issue.path.join(".") || "(env)"] ??= []).push(issue.message);
  }
  return { ok: false, errors };
}

const result = parseEnv(process.env);

if (!result.ok) {
  console.error("Invalid environment variables — fix before starting:");
  for (const [key, messages] of Object.entries(result.errors)) console.error(`  ${key}: ${messages.join(", ")}`);
  process.exit(1);
}

// Not frozen on purpose: a test points an owner URL at its own fake host.
export const env = result.env;
export type Env = typeof env;
