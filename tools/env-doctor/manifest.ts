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
  "crm-api": { platform: "railway", kind: "backend" },
  "meetings-api": { platform: "railway", kind: "backend" },
  "projects-api": { platform: "railway", kind: "backend" },
  shell: { platform: "vercel", kind: "frontend" },
  "estimai-ui": { platform: "vercel", kind: "frontend" },
  "refund-ui": { platform: "vercel", kind: "frontend" },
  "notify-ui": { platform: "vercel", kind: "frontend" },
  "admin-ui": { platform: "vercel", kind: "frontend" },
  "inventory-ui": { platform: "vercel", kind: "frontend" },
  "crm-ui": { platform: "vercel", kind: "frontend" },
  "meetings-ui": { platform: "vercel", kind: "frontend" },
  "projects-ui": { platform: "vercel", kind: "frontend" },
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
    // ASSUMED (matches the shell CSP, specs/017-crm) — confirm once the Vercel project exists.
    "crm-ui": "https://crm.operai.welld.io",
    // ASSUMED (specs/021-meetings, plan § Rollout) — confirm once the Vercel project exists.
    "meetings-ui": "https://meetings.operai.welld.io",
    // ASSUMED (matches the shell CSP in shell/vercel.json, specs/021-projects) — confirm once the Vercel project exists.
    "projects-ui": "https://projects.operai.welld.io",
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
    "crm-ui": "http://localhost:5179",
    "meetings-ui": "http://localhost:5180",
    "projects-ui": "http://localhost:5180",
  },
};

/** Vars that MUST hold a byte-for-byte identical value across the listed services. */
export const SHARED_VARS: ReadonlyArray<{ name: string; services: ServiceName[] }> = [
  { name: "AUTH_AUDIENCE", services: ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api"] },
  // The `aud` auth stamps on scoped service JWTs and notify-api verifies (ADR-0044).
  // specs/018 AC-3.3: crm-api verifies estimai-api's notices against it too (ADR-0073).
  // crm-api verifies them too since specs/021: meetings-api posts host notices to it as
  // `system:meetings-api` with scope `host-notices.send` (ADR-0059), and projects-api reads
  // `GET /system/companies` as `system:projects-api` (specs/021-projects).
  // specs/024: estimai-api verifies crm-api's deal-link notices against it (ADR-0076).
  { name: "SERVICE_AUDIENCE", services: ["auth", "notify-api", "crm-api", "estimai-api"] },
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
    services: ["auth", "notify-api", "crm-api", "estimai-api"],
    why: "a service token would be accepted on user routes and a user JWT on /system/notifications, /system/estimate-notices, /system/meeting-host/v1/notices, /system/deal-link-notices or /system/companies (ADR-0044)",
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
    services: ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api"],
    why: "the shared notify token was retired (specs/016, ADR-0049): every caller uses its own scoped service credential",
  },
  // specs/021 plan § Amendment 2026-11-05 (G-7, ADR-0069): the provider change to Google Cloud retired
  // these seven names. meetings-api no longer reads them; a leftover is a live Azure or AWS credential
  // (or a stale setting) nobody uses, so it is made visible. Flagged by NAME, on meetings-api only.
  ...(
    [
      ["AZURE_SPEECH_REGION", "use MEETINGS_SPEECH_LOCATION"],
      ["AZURE_SPEECH_KEY", "a live credential nobody uses; use MEETINGS_GCP_SERVICE_ACCOUNT_KEY"],
      ["AZURE_SPEECH_ENDPOINT", "the Speech endpoint is derived from MEETINGS_SPEECH_LOCATION"],
      ["BEDROCK_REGION", "use MEETINGS_VERTEX_LOCATION"],
      ["BEDROCK_MODEL_ID", "use MEETINGS_VERTEX_MODEL_ID"],
      ["MEETINGS_AWS_ACCESS_KEY_ID", "a live credential nobody uses; use MEETINGS_GCP_SERVICE_ACCOUNT_KEY"],
      ["MEETINGS_AWS_SECRET_ACCESS_KEY", "a live credential nobody uses; use MEETINGS_GCP_SERVICE_ACCOUNT_KEY"],
    ] as const
  ).map(([name, hint]) => ({
    name,
    services: ["meetings-api"] as ServiceName[],
    why: `retired by the provider change to Google Cloud (specs/021, ADR-0069): ${hint}`,
  })),
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
  // specs/018 AC-3.3: estimai-api also tells crm-api an estimate was closed or reopened (ADR-0073).
  { ...LINK_BASE, caller: "estimai-api", requiredScopes: ["notifications.push", "estimate-notices.send"] },
  { ...LINK_BASE, caller: "refund-api", requiredScopes: ["notifications.push", "emails.send"] },
  // specs/019: crm-api pushes CRM notifications, some with an email notice (both scopes, D-3);
  // notify-api looks up the notice's address in auth (ADR-0056). Both optional until provisioned.
  // specs/024: crm-api also tells estimai-api which deal an estimate belongs to (ADR-0076).
  { ...LINK_BASE, caller: "crm-api", requiredScopes: ["notifications.push", "emails.send", "deal-link-notices.send"] },
  { ...LINK_BASE, caller: "notify-api", requiredScopes: ["users.contact"] },
  // specs/021: meetings-api pushes meeting notifications (notify-api) and posts host notices to
  // crm-api (ADR-0059). No emails.send: an email notice, if ever wanted, is a deliberate widening.
  { ...LINK_BASE, caller: "meetings-api", requiredScopes: ["notifications.push", "host-notices.send"] },
  // specs/021: projects-api reads CRM company names from crm-api as itself (ADR-0059). It sends no
  // notifications, so it holds exactly this one scope. The group is optional locally and required in
  // production (PRODUCTION_REQUIRED_KEYS).
  { ...LINK_BASE, caller: "projects-api", requiredScopes: ["crm.companies.read"] },
];

/**
 * Object-storage residency, mirrored from each service's `src/lib/s3Residency.ts`
 * (the authoritative check, run at startup): an AWS endpoint needs an EU region,
 * any other endpoint needs its host to match the operator-declared EU host list.
 */
export const S3_RESIDENCY: ReadonlyArray<{ service: ServiceName; prefix: string }> = [
  { service: "refund-api", prefix: "REFUND_S3" },
  { service: "inventory-api", prefix: "INVENTORY_S3" },
  // specs/018: optional until the CRM bucket is provisioned (crm-api starts without it).
  { service: "crm-api", prefix: "CRM_S3" },
  // specs/021 (ADR-0061/0063): REQUIRED — a tool without audio storage is meaningless, and
  // meetings-api additionally verifies the bucket's lifecycle rule and versioning at startup.
  { service: "meetings-api", prefix: "MEETINGS_S3" },
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
  resourceServers: ["estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api"] as ServiceName[],
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
  { name: "AUTH_JWKS_URL", services: ["estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api"], target: "auth" },
  // specs/019: notify-api resolves an email notice's address through auth (ADR-0056).
  { name: "AUTH_BASE_URL", services: ["refund-api", "inventory-api", "crm-api", "notify-api", "meetings-api", "projects-api"], target: "auth" },
  { name: "NOTIFY_INTERNAL_URL", services: ["auth", "refund-api", "inventory-api", "crm-api", "meetings-api"], target: "notify-api" },
  // specs/018: crm-api calls estimai-api with the caller's JWT (estimate requests, offers).
  { name: "ESTIMAI_API_URL", services: ["crm-api"], target: "estimai-api" },
  // specs/018 AC-3.3: estimai-api tells crm-api an estimate was closed or reopened (ADR-0073).
  // specs/021: projects-api reads CRM companies from crm-api with its own service credential (ADR-0059).
  { name: "CRM_INTERNAL_URL", services: ["estimai-api", "projects-api"], target: "crm-api" },
  // specs/024: crm-api tells estimai-api an estimate was linked to or unlinked from a deal (ADR-0076).
  { name: "ESTIMAI_INTERNAL_URL", services: ["crm-api"], target: "estimai-api" },
  // specs/021: meetings-api calls the CRM host's resolve (as the caller) and notices (as itself), ADR-0059.
  { name: "CRM_API_URL", services: ["meetings-api"], target: "crm-api" },
];

/** Browser-facing / identity-claim URLs — must stay PUBLIC (`https://`, not localhost/internal in prod). */
export const PUBLIC_URL_VARS: ReadonlyArray<{ name: string; services: ServiceName[] }> = [
  { name: "AUTH_ISSUER", services: ["estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api"] },
  { name: "BETTER_AUTH_URL", services: ["auth"] },
  { name: "UI_HOME_URL", services: ["auth"] },
  { name: "REFUND_APP_BASE_URL", services: ["refund-api"] },
  // specs/019: the shell origin the email notice links to.
  { name: "APP_BASE_URL", services: ["notify-api"] },
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
  // crm-ui is a remote reached through the shell (specs/017-crm).
  { backend: "crm-api", mustAllow: ["shell"] },
  // meetings-ui is a remote reached through the shell (specs/021); the audio bucket's own CORS rule
  // (shell origin, POST + GET) is separate and cannot be checked here: infra/meetings-bucket-policy.sh.
  { backend: "meetings-api", mustAllow: ["shell"] },
  // projects-ui is a remote reached through the shell (specs/021-projects).
  { backend: "projects-api", mustAllow: ["shell"] },
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
    // specs/023: the sign-up gate's allowed domains; auth's env.ts exits without it.
    "ALLOWED_SIGNUP_DOMAINS",
  ],
  "estimai-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE", "PORT",
    "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", // specs/016: estimai-api authenticates to notify-api as itself
    // specs/018 AC-3.3: optional in estimai-api's env.ts, required by the contract: without it a
    // closed estimate never becomes ready in the CRM (ADR-0073).
    "CRM_INTERNAL_URL",
    // specs/024: optional in estimai-api's env.ts (the deal-link notice route then refuses every
    // call), required by the contract: without it the EstimAI "Deal" badge never appears (ADR-0076).
    "SERVICE_AUDIENCE",
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
  // specs/017-crm: a plain resource server — no notify calls (D-14). specs/018 adds
  // ESTIMAI_API_URL and CRM_S3_*, optional in crm-api's env.ts (the estimate and file routes
  // answer 503 without them) and therefore not required here until they are provisioned (T16).
  // specs/019 adds NOTIFY_INTERNAL_URL + SERVICE_CLIENT_*, optional the same way (019 D-7, T11).
  // specs/018 AC-3.3: SERVICE_AUDIENCE is optional in env.ts (the notices route then refuses
  // everything) but required by the contract, like CRM_INTERNAL_URL on estimai-api (ADR-0073).
  "crm-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE", "PORT",
    // specs/021: crm-api verifies the scoped service JWT meetings-api posts host notices with (ADR-0059).
    // Required by the contract: without it every notice is a silent 401 and the deal never learns about
    // its meetings. (crm-api's own env.ts may treat it as optional until the host endpoints ship.)
    "SERVICE_AUDIENCE",
  ],
  // specs/021-meetings. A plain-REQUIRED set (no "optional group"): the tool is meaningless without audio
  // storage, transcription or an LLM (plan § Environment). The bucket NAME and its two credentials are
  // set by reference to the Railway bucket by infra/provision-tool.sh --bucket and stay out of the
  // committed template (as for crm-api / inventory-api), so they are not required here; meetings-api's own
  // src/lib/env.ts is the authority and exits at startup without them.
  "meetings-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
    "NOTIFY_INTERNAL_URL", "CRM_API_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET",
    "MEETINGS_S3_ENDPOINT", "MEETINGS_S3_REGION", "MEETINGS_S3_EU_ENDPOINT_HOSTS",
    // Google Cloud (plan § Amendment 2026-11-05, G-7): Speech-to-Text v2 (Chirp 3), Claude on Vertex AI
    // and the transient GCS bucket, one project and one service account. The locations, the model id and
    // the key are validated by meetings-api (env.ts S1-S5, startup checks N2-N4); here only their
    // presence is part of the contract.
    "MEETINGS_SPEECH_LOCATION", "MEETINGS_VERTEX_LOCATION", "MEETINGS_VERTEX_MODEL_ID",
    "MEETINGS_GCP_PROJECT_ID", "MEETINGS_GCP_SERVICE_ACCOUNT_KEY", "MEETINGS_GCS_TRANSIENT_BUCKET",
    "MEETINGS_AI_PROVIDER", "PORT",
  ],
  // specs/021-projects: a JWKS + authorization-enforcing resource server (ADR-0014). Its CRM
  // service-credential group is optional in env.ts, so it is listed in PRODUCTION_REQUIRED_KEYS instead.
  "projects-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE", "PORT",
  ],
};

/**
 * Keys a service's own `src/lib/env.ts` treats as OPTIONAL (a developer's local setup starts without
 * them) but that production must hold. Checked in addition to REQUIRED_KEYS, and only for a prod-like
 * environment (production/preview) — a local run is not flagged for lacking them.
 */
export const PRODUCTION_REQUIRED_KEYS: Partial<Record<ServiceName, string[]>> = {
  // crm-api's SERVICE_AUDIENCE is in REQUIRED_KEYS since specs/018 AC-3.3 (ADR-0073); specs/021's
  // `GET /system/companies` relies on the same key (ADR-0059), so no production-only entry is needed.
  // specs/021: projects-api's all-or-none CRM group — without it a company name is `null` and the
  // company picker answers 503 `crm_unavailable`.
  "projects-api": ["CRM_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"],
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
  "SERVICE_CLIENT_SECRET", // each client's half of that secret (refund-api, estimai-api, inventory-api, crm-api, notify-api, projects-api)
  "INVENTORY_S3_ACCESS_KEY_ID",
  "INVENTORY_S3_SECRET_ACCESS_KEY",
  "CRM_S3_ACCESS_KEY_ID",
  "CRM_S3_SECRET_ACCESS_KEY",
  "MEETINGS_S3_ACCESS_KEY_ID",
  "MEETINGS_S3_SECRET_ACCESS_KEY",
  "MEETINGS_GCP_SERVICE_ACCOUNT_KEY", // base64 service-account JSON key, carries a private key (specs/021, G-6/G-7)
  // The retired provider credentials stay redacted: if one is found live it is flagged by name
  // (FORBIDDEN_VARS) and its value must still never be surfaced.
  "AZURE_SPEECH_KEY",
  "MEETINGS_AWS_ACCESS_KEY_ID",
  "MEETINGS_AWS_SECRET_ACCESS_KEY",
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
