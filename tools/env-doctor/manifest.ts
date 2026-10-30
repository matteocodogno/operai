/**
 * env-doctor manifest — the single, machine-checked declaration of the Operai
 * suite's cross-service env contract (Phase 1). This is the source of truth the
 * scattered `infra/README.md` notes describe in prose: which vars are SHARED
 * (must be identical), which are INTERNAL (backend↔backend calls over Railway
 * private networking), which are PUBLIC (browser-facing / identity claims), and
 * which frontend origins each backend must allow (CORS).
 *
 * `check.ts` enforces these; the doc can no longer drift from reality because
 * the doctor fails when it does.
 *
 * NOTE on values: the per-env public ORIGINS below are what the tool matches
 * `ALLOWED_ORIGINS` against — fill in / confirm your real Vercel domains. An
 * origin left `null` makes the CORS check a WARN (can't verify) rather than a
 * false ERROR.
 */

export type Platform = "railway" | "vercel";
export type Kind = "backend" | "frontend";

export interface ServiceDef {
  readonly platform: Platform;
  readonly kind: Kind;
}

export const SERVICES = {
  auth: { platform: "railway", kind: "backend" },
  "estimai-api": { platform: "railway", kind: "backend" },
  "notify-api": { platform: "railway", kind: "backend" },
  "refund-api": { platform: "railway", kind: "backend" },
  "inventory-api": { platform: "railway", kind: "backend" },
  shell: { platform: "vercel", kind: "frontend" },
  "estimai-ui": { platform: "vercel", kind: "frontend" },
  "refund-ui": { platform: "vercel", kind: "frontend" },
  "notify-ui": { platform: "vercel", kind: "frontend" },
  "admin-ui": { platform: "vercel", kind: "frontend" },
  "inventory-ui": { platform: "vercel", kind: "frontend" },
} as const satisfies Record<string, ServiceDef>;

export type ServiceName = keyof typeof SERVICES;
export const BACKENDS = Object.keys(SERVICES).filter(
  (s) => SERVICES[s as ServiceName].kind === "backend",
) as ServiceName[];

/**
 * Public origin of each FRONTEND per environment — matched against backends'
 * `ALLOWED_ORIGINS` (CORS check). `null` = unknown → CORS check WARNs instead
 * of ERRORs. CONFIRM these against your real Vercel domains.
 */
export const ORIGINS: Record<string, Partial<Record<ServiceName, string | null>>> = {
  production: {
    shell: "https://operai.welld.io",
    "admin-ui": "https://admin.operai.welld.io",
    "refund-ui": null, // TODO: confirm the real Vercel prod origin
    "notify-ui": null,
    "estimai-ui": null,
    // ASSUMED (matches the shell CSP in shell/vercel.json) — confirm the real Vercel domain.
    "inventory-ui": "https://inventory.operai.welld.io",
  },
  preview: {
    // Vercel preview URLs are per-deploy; usually validated via the live-diff
    // mode (Phase 3), not here. Left empty by design.
  },
  local: {
    shell: "http://localhost:5173",
    "estimai-ui": "http://localhost:5174",
    "refund-ui": "http://localhost:5175",
    "notify-ui": "http://localhost:5176",
    "admin-ui": "http://localhost:5177",
    "inventory-ui": "http://localhost:5178",
  },
};

/** Vars that MUST hold a byte-for-byte identical value across the listed services. */
export const SHARED_VARS: ReadonlyArray<{ name: string; services: ServiceName[] }> = [
  { name: "AUTH_AUDIENCE", services: ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api"] },
  // The `aud` auth stamps on scoped service JWTs and notify-api verifies (ADR-0044).
  { name: "SERVICE_AUDIENCE", services: ["auth", "notify-api"] },
];

/**
 * Pairs of vars that must hold DIFFERENT values on the same service. A service
 * token must be useless on every user route and a user JWT useless on every
 * system route, which holds only while the two audiences differ (ADR-0044);
 * `auth` and `notify-api` each refuse to start when they are equal, and this
 * catches it before the deploy. Compared only where both values are concrete
 * (a literal, or resolved by --resolve/--dir/--live) — two different
 * `${{shared.X}}` references cannot be compared offline.
 */
export const DISTINCT_VARS: ReadonlyArray<{ a: string; b: string; services: ServiceName[]; why: string }> = [
  {
    a: "SERVICE_AUDIENCE",
    b: "AUTH_AUDIENCE",
    services: ["auth", "notify-api"],
    why: "a service token would be accepted on user routes and a user JWT on /system/notifications (ADR-0044)",
  },
];

/**
 * Vars a service must NOT hold. The shared internal notify token was retired by
 * specs/016 (ADR-0049): every notify-api caller authenticates with its own scoped
 * service JWT, and notify-api no longer reads the variable. A leftover is harmless
 * to a running service (none of them reads it) but means the retirement is not
 * finished — and it is a live secret nobody uses. Flagged by NAME, on all five.
 */
export const FORBIDDEN_VARS: ReadonlyArray<{ name: string; services: ServiceName[]; why: string }> = [
  {
    name: "NOTIFY_INTERNAL_TOKEN",
    services: ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api"],
    why: "the shared notify token was retired (specs/016, ADR-0049): every caller uses its own scoped service credential",
  },
];

/**
 * Service-token client credentials (ADR-0044). `auth.SERVICE_CLIENTS` is a JSON
 * object keyed by client id; each caller's own id + secret vars must match its
 * entry, and the entry must carry the scope the receiving service requires.
 */
const LINK_BASE = {
  idVar: "SERVICE_CLIENT_ID",
  secretVar: "SERVICE_CLIENT_SECRET",
  registry: { service: "auth", var: "SERVICE_CLIENTS" },
} as const;
export const SERVICE_CLIENT_LINKS: ReadonlyArray<{
  caller: ServiceName;
  idVar: string;
  secretVar: string;
  registry: { service: ServiceName; var: string };
  /** Exactly the scopes the caller needs: a missing one fails, so does an extra one (least privilege, specs/016 AC-2.1). */
  requiredScopes: readonly string[];
}> = [
  { ...LINK_BASE, caller: "inventory-api", requiredScopes: ["notifications.push"] },
  { ...LINK_BASE, caller: "estimai-api", requiredScopes: ["notifications.push"] },
  { ...LINK_BASE, caller: "refund-api", requiredScopes: ["notifications.push", "emails.send"] },
];

/**
 * Object-storage residency, mirrored from each service's `src/lib/s3Residency.ts`
 * (the authoritative check, run at startup): an AWS endpoint needs an EU region,
 * any other endpoint needs its host to match the operator-declared EU host list.
 */
export const S3_RESIDENCY: ReadonlyArray<{ service: ServiceName; prefix: string }> = [
  { service: "refund-api", prefix: "REFUND_S3" },
  { service: "inventory-api", prefix: "INVENTORY_S3" },
];
export const EU_AWS_REGIONS: ReadonlyArray<string> = [
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2",
  "eu-north-1", "eu-south-1", "eu-south-2",
];

/**
 * The JWT `iss` claim consistency: every resource server's `AUTH_ISSUER` must
 * equal the value auth stamps as the issuer (`BETTER_AUTH_URL`). A public URL.
 */
export const ISSUER = {
  authService: "auth" as ServiceName,
  authVar: "BETTER_AUTH_URL",
  issuerVar: "AUTH_ISSUER",
  resourceServers: ["estimai-api", "notify-api", "refund-api", "inventory-api"] as ServiceName[],
};

/**
 * Backend→backend CALL URLs — must use Railway private networking (`http://` +
 * `*.railway.internal` in prod, or a `${{svc.…}}` reference) on the TARGET
 * service's port. `target` is the service the URL points at (for the
 * port-consistency check).
 */
export const INTERNAL_URL_VARS: ReadonlyArray<{
  name: string;
  services: ServiceName[];
  target: ServiceName;
}> = [
  { name: "AUTH_JWKS_URL", services: ["estimai-api", "notify-api", "refund-api", "inventory-api"], target: "auth" },
  { name: "AUTH_BASE_URL", services: ["refund-api", "inventory-api"], target: "auth" },
  { name: "NOTIFY_INTERNAL_URL", services: ["auth", "refund-api", "inventory-api"], target: "notify-api" },
];

/** Browser-facing / identity-claim URLs — must stay PUBLIC (`https://`, not localhost/internal in prod). */
export const PUBLIC_URL_VARS: ReadonlyArray<{ name: string; services: ServiceName[] }> = [
  { name: "AUTH_ISSUER", services: ["estimai-api", "notify-api", "refund-api", "inventory-api"] },
  { name: "BETTER_AUTH_URL", services: ["auth"] },
  { name: "UI_HOME_URL", services: ["auth"] },
  { name: "REFUND_APP_BASE_URL", services: ["refund-api"] },
];

/** Each backend's `ALLOWED_ORIGINS` must include the public origin of these frontends (CORS). */
export const CORS_REQUIREMENTS: ReadonlyArray<{ backend: ServiceName; mustAllow: ServiceName[] }> = [
  { backend: "auth", mustAllow: ["shell"] },
  { backend: "estimai-api", mustAllow: ["shell"] },
  { backend: "notify-api", mustAllow: ["shell"] },
  // refund-api additionally serves admin-ui's DIRECT cross-origin /rates + /settings calls (ADR-0023).
  { backend: "refund-api", mustAllow: ["shell", "admin-ui"] },
  // inventory-ui is a remote reached through the shell, so the browser Origin is the shell's (ADR-0006).
  { backend: "inventory-api", mustAllow: ["shell"] },
];

/**
 * Minimal required-keys presence per BACKEND (Layer A light — the authoritative
 * per-service schema is each service's own `src/lib/env.ts`, run at startup;
 * this is a fast pre-deploy presence check focused on the criticals + the vars
 * the cross-service invariants depend on).
 */
export const REQUIRED_KEYS: Partial<Record<ServiceName, string[]>> = {
  auth: [
    "DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "AUTH_AUDIENCE",
    "ALLOWED_ORIGINS", "UI_HOME_URL", "NOTIFY_INTERNAL_URL", "PORT",
    // SERVICE_AUDIENCE is required by auth's env.ts (specs/016, ADR-0048); SERVICE_CLIENTS is
    // optional there but required by the contract: without it the service-token endpoint
    // authenticates nobody and the callers' pushes are silently dead.
    "SERVICE_AUDIENCE", "SERVICE_CLIENTS",
  ],
  "estimai-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE", "PORT",
    "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", // specs/016: estimai-api authenticates to notify-api as itself
  ],
  "notify-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE", "PORT",
    // Required by notify-api's env.ts since specs/016: the only credential its /system routes accept.
    "SERVICE_AUDIENCE",
  ],
  "refund-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
    "NOTIFY_INTERNAL_URL", "REFUND_APP_BASE_URL", "PORT",
    "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", // specs/016
  ],
  // The S3 bucket name and both credentials are set directly on the Railway service (no
  // 1Password item yet), so the committed template omits them and they are not required here;
  // inventory-api's own src/lib/env.ts is the authority and exits at startup without them.
  "inventory-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
    "NOTIFY_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET",
    "INVENTORY_S3_ENDPOINT", "INVENTORY_S3_REGION", "INVENTORY_S3_EU_ENDPOINT_HOSTS", "PORT",
  ],
};

/**
 * Vars whose VALUES are secret and must never be printed. In `--live` mode the
 * doctor holds real deployed values in memory; any value surfaced in a finding
 * for one of these is redacted to a non-reversible fingerprint (so drift is
 * still visible — two different fingerprints — without leaking the secret).
 */
export const SECRET_VARS: ReadonlySet<string> = new Set([
  "BETTER_AUTH_SECRET",
  "DATABASE_URL", // carries the Postgres password
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "RESEND_API_KEY",
  "REFUND_S3_ACCESS_KEY_ID",
  "REFUND_S3_SECRET_ACCESS_KEY",
  "SERVICE_CLIENTS", // JSON carrying every service client's secret (auth)
  "SERVICE_CLIENT_SECRET", // each caller's half of that secret (refund-api, estimai-api, inventory-api)
  "INVENTORY_S3_ACCESS_KEY_ID",
  "INVENTORY_S3_SECRET_ACCESS_KEY",
]);
export const isSecretVar = (name: string): boolean => SECRET_VARS.has(name);

/** A value using a Railway reference (e.g. `${{auth.PORT}}`) — self-consistent by construction, so shape checks defer. */
export const isRailwayRef = (v: string): boolean => v.includes("${{");
/**
 * A value that stands in for a secret resolved out-of-band from 1Password:
 * either an already-`op://` reference, or the committed-template `${OP:vault/item/field}`
 * sentinel (a deliberately non-`op://` spelling so the secret scanner's 1password-reference
 * rule doesn't flag committed template files — see resolve.ts). Its concrete
 * value is unknowable offline, so value-shape checks skip it; `--resolve` turns
 * `${OP:…}` into a real `op read` and proves it exists.
 */
export const isSecretRef = (v: string): boolean => v.startsWith("op://") || v.startsWith("${OP:");
/** @deprecated use {@link isSecretRef} — kept as the narrower `op://`-only predicate. */
export const isOpRef = (v: string): boolean => v.startsWith("op://");
