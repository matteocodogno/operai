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
  shell: { platform: "vercel", kind: "frontend" },
  "estimai-ui": { platform: "vercel", kind: "frontend" },
  "refund-ui": { platform: "vercel", kind: "frontend" },
  "notify-ui": { platform: "vercel", kind: "frontend" },
  "admin-ui": { platform: "vercel", kind: "frontend" },
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
  },
};

/** Vars that MUST hold a byte-for-byte identical value across the listed services. */
export const SHARED_VARS: ReadonlyArray<{ name: string; services: ServiceName[] }> = [
  { name: "AUTH_AUDIENCE", services: ["auth", "estimai-api", "notify-api", "refund-api"] },
  { name: "NOTIFY_INTERNAL_TOKEN", services: ["auth", "notify-api", "refund-api"] },
];

/**
 * The JWT `iss` claim consistency: every resource server's `AUTH_ISSUER` must
 * equal the value auth stamps as the issuer (`BETTER_AUTH_URL`). A public URL.
 */
export const ISSUER = {
  authService: "auth" as ServiceName,
  authVar: "BETTER_AUTH_URL",
  issuerVar: "AUTH_ISSUER",
  resourceServers: ["estimai-api", "notify-api", "refund-api"] as ServiceName[],
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
  { name: "AUTH_JWKS_URL", services: ["estimai-api", "notify-api", "refund-api"], target: "auth" },
  { name: "AUTH_BASE_URL", services: ["refund-api"], target: "auth" },
  { name: "NOTIFY_INTERNAL_URL", services: ["auth", "refund-api"], target: "notify-api" },
];

/** Browser-facing / identity-claim URLs — must stay PUBLIC (`https://`, not localhost/internal in prod). */
export const PUBLIC_URL_VARS: ReadonlyArray<{ name: string; services: ServiceName[] }> = [
  { name: "AUTH_ISSUER", services: ["estimai-api", "notify-api", "refund-api"] },
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
    "ALLOWED_ORIGINS", "UI_HOME_URL", "NOTIFY_INTERNAL_URL", "NOTIFY_INTERNAL_TOKEN", "PORT",
  ],
  "estimai-api": ["DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE", "PORT"],
  "notify-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE",
    "NOTIFY_INTERNAL_TOKEN", "PORT",
  ],
  "refund-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
    "NOTIFY_INTERNAL_URL", "NOTIFY_INTERNAL_TOKEN", "REFUND_APP_BASE_URL", "PORT",
  ],
};

/** A value using a Railway reference (e.g. `${{auth.PORT}}`) — self-consistent by construction, so shape checks defer. */
export const isRailwayRef = (v: string): boolean => v.includes("${{");
/**
 * A value that stands in for a secret resolved out-of-band from 1Password:
 * either an already-`op://` reference, or the committed-template `${OP:vault/item/field}`
 * sentinel (a deliberately non-`op://` spelling so gitleaks' 1password-reference
 * rule doesn't flag committed template files — see resolve.ts). Its concrete
 * value is unknowable offline, so value-shape checks skip it; `--resolve` turns
 * `${OP:…}` into a real `op inject` and proves it exists.
 */
export const isSecretRef = (v: string): boolean => v.startsWith("op://") || v.startsWith("${OP:");
/** @deprecated use {@link isSecretRef} — kept as the narrower `op://`-only predicate. */
export const isOpRef = (v: string): boolean => v.startsWith("op://");
