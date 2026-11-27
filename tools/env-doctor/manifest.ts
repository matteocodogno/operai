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
  // specs/20261110-activities: the shared activities/tasks/blockers store (ADR 20261110-activities-service-access-delegated-to-host). No UI of its own:
  // the CRM and projects remotes render it.
  "activities-api": { platform: "railway", kind: "backend" },
  // specs/20261116-letterhead-service (ADR 20261116-letterhead-api-is-a-rust-service-with-typst-embedded-for-document-layout-only): the one Rust service, in letterhead-api/. It is listed here BY NAME: nothing else
  // would put it in the contract, because it has no package.json of its own to trigger a check (the ADR's failure shape).
  "letterhead-api": { platform: "railway", kind: "backend" },
  // specs/20261119-accounting (ADR 20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it): the ledger accounts, VAT codes and monthly exchange rates of each legal entity, in accounting-api/.
  // refund-api reads it live over /system/v1/* with its own service JWT (scope `accounting.reference.read`).
  "accounting-api": { platform: "railway", kind: "backend" },
  // specs/20261112-time-tracking: time entries, categories and work types (ADR 20261112-hours-api-time-entries-own-service-hours-catalog). Its UI is the
  // ungated hours remote below (ADR 20261112-hours-ui-ungated-remote).
  "hours-api": { platform: "railway", kind: "backend" },
  shell: { platform: "vercel", kind: "frontend" },
  "estimai-ui": { platform: "vercel", kind: "frontend" },
  "refund-ui": { platform: "vercel", kind: "frontend" },
  "notify-ui": { platform: "vercel", kind: "frontend" },
  "admin-ui": { platform: "vercel", kind: "frontend" },
  "inventory-ui": { platform: "vercel", kind: "frontend" },
  "crm-ui": { platform: "vercel", kind: "frontend" },
  "meetings-ui": { platform: "vercel", kind: "frontend" },
  "projects-ui": { platform: "vercel", kind: "frontend" },
  // specs/20261116-letterhead-service: the letterhead configurator, a federated remote reached through the shell.
  "letterheads-ui": { platform: "vercel", kind: "frontend" },
  // specs/20261119-accounting: the Accounting remote, reached through the shell.
  "accounting-ui": { platform: "vercel", kind: "frontend" },
  "hours-ui": { platform: "vercel", kind: "frontend" },
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
    // ASSUMED (matches the shell CSP, specs/20261101-crm) — confirm once the Vercel project exists.
    "crm-ui": "https://crm.operai.welld.io",
    // ASSUMED (specs/20261104-meetings, plan § Rollout) — confirm once the Vercel project exists.
    "meetings-ui": "https://meetings.operai.welld.io",
    // ASSUMED (matches the shell CSP in shell/vercel.json, specs/20261103-projects) — confirm once the Vercel project exists.
    "projects-ui": "https://projects.operai.welld.io",
    // ASSUMED (specs/20261116-letterhead-service) — confirm once the Vercel project exists.
    "letterheads-ui": "https://letterheads.operai.welld.io",
    // ASSUMED (specs/20261119-accounting; the host shell/vercel.json's CSP names) — confirm once the Vercel project exists.
    "accounting-ui": "https://accounting.operai.welld.io",
    // ASSUMED (infra/provision-tool.sh derives <tool>.operai.welld.io, specs/20261112-time-tracking) — confirm once the Vercel project exists.
    "hours-ui": "https://hours.operai.welld.io",
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
    "projects-ui": "http://localhost:5181",
    "letterheads-ui": "http://localhost:5182",
    "accounting-ui": "http://localhost:5183",
    "hours-ui": "http://localhost:5184",
  },
};

/** Vars that MUST hold a byte-for-byte identical value across the listed services. */
export const SHARED_VARS: ReadonlyArray<{ name: string; services: ServiceName[] }> = [
  { name: "AUTH_AUDIENCE", services: ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api", "activities-api", "letterhead-api", "accounting-api", "hours-api"] },
  // The `aud` auth stamps on scoped service JWTs and the resource servers that take them verify:
  // notify-api (ADR 20261006-scoped-service-jwt-fourth-notify-caller); crm-api for estimai-api's estimate notices (specs/20261101-crm-sales-flow AC-3.3, ADR 20261105-estimai-closes-the-estimate-crm-follows),
  // meetings-api's host notices (`system:meetings-api`, scope `host-notices.send`, ADR 20261104-meeting-host-contract-resolve-and-notices) and
  // `GET /system/companies` (specs/20261103-projects); since specs/20261103-projects-handoff, estimai-api
  // (`/system/estimates/{id}/summary`, ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential) and projects-api (`/system/purchase-orders`, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials).
  // specs/20261108-estimate-list-oversight: estimai-api verifies crm-api's deal-link notices against it (ADR 20261108-crm-pushes-deal-links-to-estimai).
  // specs/20261110-activities (ADR 20261110-caller-chosen-ids-replace-cross-service-transactions): activities-api verifies crm-api's /system/v1/* calls (scope `activities.write`,
  // sub `system:crm-api`) against it.
  // specs/20261116-letterhead-service: letterhead-api verifies crm-api's /v1/render/* calls (scope `letterhead:render`) against it.
  // specs/20261119-accounting: accounting-api verifies refund-api's /system/v1/* calls (scope `accounting.reference.read`, sub `system:refund-api`) against it;
  // it is required there (the service exits 1 without it).
  // specs/20261112-time-tracking (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route): meetings-api verifies hours-api's `GET /system/meetings/hosts` (scope
  // `meetings.hosts.read`, sub `system:hours-api`) against it; hours-api needs the same value as the
  // audience of the service JWT it fetches from auth (`POST /system/service-token`).
  { name: "SERVICE_AUDIENCE", services: ["auth", "notify-api", "crm-api", "estimai-api", "projects-api", "activities-api", "letterhead-api", "accounting-api", "meetings-api", "hours-api"] },
];

/**
 * Pairs of vars that must hold DIFFERENT values on the same service. A service
 * token must be useless on every user route and a user JWT useless on every
 * system route, which holds only while the two audiences differ (ADR 20261006-scoped-service-jwt-fourth-notify-caller);
 * `auth` and `notify-api` each refuse to start when they are equal, and this
 * catches it before the deploy. Compared only where both values are concrete
 * (a literal, or resolved by --resolve/--dir/--live) — two different
 * `${{shared.X}}` references cannot be compared offline.
 */
export const DISTINCT_VARS: ReadonlyArray<{ a: string; b: string; services: ServiceName[]; why: string }> = [
  {
    a: "SERVICE_AUDIENCE",
    b: "AUTH_AUDIENCE",
    services: ["auth", "notify-api", "crm-api", "estimai-api", "activities-api", "letterhead-api", "accounting-api"],
    why: "a service token would be accepted on user routes and a user JWT on /system/notifications, /system/estimate-notices, /system/meeting-host/v1/notices, /system/deal-link-notices, /system/companies, /system/v1/* or /v1/render/* (ADR 20261006-scoped-service-jwt-fourth-notify-caller; letterhead-api and accounting-api refuse to start with equal values)",
  },
  {
    a: "SERVICE_AUDIENCE",
    b: "AUTH_AUDIENCE",
    services: ["estimai-api", "projects-api"],
    why: "a service token would be accepted on user routes and a user JWT on /system/estimates and /system/purchase-orders (ADR 20261006-scoped-service-jwt-fourth-notify-caller, specs/20261103-projects-handoff)",
  },
  // specs/20261112-time-tracking: meetings-api's `/system/meetings/hosts` (its env.ts refuses an equal pair at start) and
  // hours-api (required there, refuses an equal pair at start).
  {
    a: "SERVICE_AUDIENCE",
    b: "AUTH_AUDIENCE",
    services: ["meetings-api", "hours-api"],
    why: "a service token would be accepted on user routes and a user JWT on /system/meetings/hosts (ADR 20261006-scoped-service-jwt-fourth-notify-caller, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route)",
  },
];

/**
 * Vars a service must NOT hold. The shared internal notify token was retired by
 * specs/20261013-notify-service-credentials (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired): every notify-api caller authenticates with its own scoped
 * service JWT, and notify-api no longer reads the variable. A leftover is harmless
 * to a running service (none of them reads it) but means the retirement is not
 * finished — and it is a live secret nobody uses. Flagged by NAME, on all five.
 */
export const FORBIDDEN_VARS: ReadonlyArray<{ name: string; services: ServiceName[]; why: string }> = [
  {
    name: "NOTIFY_INTERNAL_TOKEN",
    services: ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api", "activities-api", "letterhead-api", "accounting-api", "hours-api"],
    why: "the shared notify token was retired (specs/20261013-notify-service-credentials, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired): every caller uses its own scoped service credential",
  },
  // specs/20261119-accounting (T23, plan § Docs, env contract; ADR 20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it): the monthly exchange rates moved to accounting-api, so the
  // source switch of specs/20261118-refund-accounting-export is accounting-api's `ACCOUNTING_FX_SOURCE` and refund-api no longer reads
  // `REFUND_FX_SOURCE` (a deployment that still sets it starts normally and the value is ignored). A leftover would make the operator
  // believe refund-api still fetches rates, or that `off` still stops an outbound call from it. Flagged by NAME, on refund-api only.
  {
    name: "REFUND_FX_SOURCE",
    services: ["refund-api"],
    why: "retired by specs/20261119-accounting: refund-api no longer fetches rates (it reads them from accounting-api) and ignores it; the switch is ACCOUNTING_FX_SOURCE on accounting-api",
  },
  // specs/20261111-push-notifications US-7 (ADR 20261112-system-endpoints-limited-per-verified-service): the one address-keyed bucket of the two /system endpoints is replaced by
  // per-service allowances. auth no longer reads these two; a leftover override sized for the old rule
  // (20, or the runbook's 60) is ignored, so the deployment would believe in a cap that does not exist.
  // Flagged by NAME, on auth only.
  ...(
    [
      ["SERVICE_TOKEN_RATE_LIMIT", "use SERVICE_TOKEN_SERVICE_LIMIT / USERS_CONTACT_SERVICE_LIMIT / SYSTEM_INVALID_CREDENTIAL_LIMIT"],
      ["SERVICE_TOKEN_RATE_WINDOW_MS", "use SYSTEM_RATE_WINDOW_MS"],
    ] as const
  ).map(([name, hint]) => ({
    name,
    services: ["auth"] as ServiceName[],
    why: `retired by the per-service system limits (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service): auth ignores it; ${hint}`,
  })),
  // specs/20261104-meetings plan § Amendment 2026-11-05 (G-7, ADR 20261105-meetings-ai-providers-google-cloud-eu): the provider change to Google Cloud retired
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
    why: `retired by the provider change to Google Cloud (specs/20261104-meetings, ADR 20261105-meetings-ai-providers-google-cloud-eu): ${hint}`,
  })),
];

/**
 * Service-token client credentials (ADR 20261006-scoped-service-jwt-fourth-notify-caller). `auth.SERVICE_CLIENTS` is a JSON
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
  /** Exactly the scopes the caller needs: a missing one fails, so does an extra one (least privilege, specs/20261013-notify-service-credentials AC-2.1). */
  requiredScopes: readonly string[];
}> = [
  // specs/20261006-hardware-inventory US-15: the weekly reminder to confirm an assignment is also an email notice.
  { ...LINK_BASE, caller: "inventory-api", requiredScopes: ["notifications.push", "emails.send"] },
  // specs/20261101-crm-sales-flow AC-3.3: estimai-api also tells crm-api an estimate was closed or reopened (ADR 20261105-estimai-closes-the-estimate-crm-follows).
  { ...LINK_BASE, caller: "estimai-api", requiredScopes: ["notifications.push", "estimate-notices.send"] },
  // specs/20261119-accounting (AC-3.8): refund-api also reads accounting-api over /system/v1/* with `accounting.reference.read`, verified by
  // accounting-api. Granted in production on 2026-11-20 (release runbook step 4), here and in auth's template in one change. `users.contact`
  // is NOT listed: refund-api holds it only during the accounting release window (T84), and `--live` reports it while it is held.
  { ...LINK_BASE, caller: "refund-api", requiredScopes: ["notifications.push", "emails.send", "accounting.reference.read"] },
  // One service client per caller, whatever it calls. crm-api's is the notifier's (specs/20261101-crm-notifications: CRM
  // notifications, some with an email notice, both scopes, D-3; notify-api looks up the notice's
  // address in auth, ADR 20261101-notify-api-resolves-email-notice-address-from-auth) and, since specs/20261103-projects-handoff, also reads projects-api for a deal's purchase
  // order and Bexio order id (`projects.purchase-orders.read`, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials). Optional locally, required in
  // production (PRODUCTION_REQUIRED_KEYS); once the client is set the entry in auth holds all its
  // scopes, whichever URL is set.
  // specs/20261108-estimate-list-oversight: crm-api also tells estimai-api which deal an estimate belongs to (ADR 20261108-crm-pushes-deal-links-to-estimai).
  // specs/20261110-activities (ADR 20261110-caller-chosen-ids-replace-cross-service-transactions): crm-api also writes to activities-api (the migration copy, the host's deal
  // delete/erase/transfer calls) as `system:crm-api`.
  // specs/20261116-letterhead-service (T44, AC-9.3): crm-api also renders offers through letterhead-api as itself (`letterhead:render`,
  // verified by letterhead-api's /v1/render/*; the same client, so it is in the entry whatever the switch says).
  // specs/20261117-legal-entities (T12, AC-3.2): crm-api also reads the issuer's details from auth's registry as itself
  // (`legal-entities:read`, verified by auth's GET /system/legal-entities, ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds).
  { ...LINK_BASE, caller: "crm-api", requiredScopes: ["notifications.push", "emails.send", "deal-link-notices.send", "activities.write", "projects.purchase-orders.read", "letterhead:render", "legal-entities:read"] },
  { ...LINK_BASE, caller: "notify-api", requiredScopes: ["users.contact"] },
  // specs/20261104-meetings: meetings-api pushes meeting notifications (notify-api) and posts host notices to
  // crm-api (ADR 20261104-meeting-host-contract-resolve-and-notices). No emails.send: an email notice, if ever wanted, is a deliberate widening.
  { ...LINK_BASE, caller: "meetings-api", requiredScopes: ["notifications.push", "host-notices.send"] },
  // specs/20261103-projects: projects-api reads CRM company names from crm-api as itself (ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential); specs/20261103-projects-handoff adds
  // the won deals of the to-start queue (`crm.deals.read`, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials), the contacts of a deal's company
  // for the referent (`crm.contacts.read`, held by this client only), a deal's estimate man-days from
  // estimai-api (`estimai.estimates.read`, ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential) and, after a take, a push to the PO's ops-manager
  // through notify-api (`notifications.push`, T22/T25). specs/20261126-teams (T10, AC-4.1, AC-4.7): it also reads the teams attached to a project, with their members and
  // app access, from auth's `GET /system/teams` as itself (`teams:read`; no new variable, it reuses AUTH_BASE_URL and its own SERVICE_CLIENT_*). Exactly these six. The group
  // is optional locally and required in production (PRODUCTION_REQUIRED_KEYS).
  {
    ...LINK_BASE,
    caller: "projects-api",
    requiredScopes: ["crm.companies.read", "crm.deals.read", "crm.contacts.read", "estimai.estimates.read", "notifications.push", "teams:read"],
  },
  // specs/20261110-activities: activities-api pushes task notifications to notify-api, some with an email notice
  // (AC-6.1/6.3, ADR 20261101-notify-api-resolves-email-notice-address-from-auth), so BOTH scopes: without emails.send notify-api refuses every email notice
  // and only the in-app row is written. It calls the hosts as the caller, never as itself.
  { ...LINK_BASE, caller: "activities-api", requiredScopes: ["notifications.push", "emails.send"] },
  // specs/20261117-legal-entities (T12, AC-3.2, plan decision 3): letterhead-api reads the issuer's details from auth's registry as
  // itself (GET /system/legal-entities) and prints them in every render. Exactly this one scope: it VERIFIES `letterhead:render`
  // on /v1/render/* but does not HOLD it (that is its callers'), and it sends no notices. A new client at auth, so the entry,
  // the shared secret and this caller's SERVICE_CLIENT_ID/SECRET are one change (release step 2); auth refuses to start with a
  // scope it does not know, so the entry is added only after the new auth is live.
  { ...LINK_BASE, caller: "letterhead-api", requiredScopes: ["legal-entities:read"] },
  // specs/20261112-time-tracking (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route): hours-api reads which deal a meeting is linked to from meetings-api's
  // `GET /system/meetings/hosts` as itself. EXACTLY this one scope: every other owner (projects-api,
  // crm-api, activities-api, meetings-api's `ids`) is asked as the caller with the forwarded JWT, never
  // with a service credential, and hours-api sends no notification.
  { ...LINK_BASE, caller: "hours-api", requiredScopes: ["meetings.hosts.read"] },
];

/**
 * Object-storage residency, mirrored from each service's `src/lib/s3Residency.ts`
 * (the authoritative check, run at startup): an AWS endpoint needs an EU region,
 * any other endpoint needs its host to match the operator-declared EU host list.
 */
export const S3_RESIDENCY: ReadonlyArray<{ service: ServiceName; prefix: string }> = [
  { service: "refund-api", prefix: "REFUND_S3" },
  { service: "inventory-api", prefix: "INVENTORY_S3" },
  // specs/20261101-crm-sales-flow: optional until the CRM bucket is provisioned (crm-api starts without it).
  { service: "crm-api", prefix: "CRM_S3" },
  // specs/20261104-meetings (ADR 20261104-meetings-ai-providers-eu-zero-retention/0063): REQUIRED — a tool without audio storage is meaningless, and
  // meetings-api additionally verifies the bucket's lifecycle rule and versioning at startup.
  { service: "meetings-api", prefix: "MEETINGS_S3" },
  // ADR 20261113-task-description-files-in-activities-api-bucket: task images and attachments. Optional like the CRM's: without it the file routes
  // answer 503 storage_unconfigured and the rest of activities-api works.
  { service: "activities-api", prefix: "ACTIVITIES_S3" },
  // specs/20261116-letterhead-service AC-3.8: REQUIRED, and letterhead-api exits at startup when it fails
  // (letterhead-api/api/src/env.rs, a port of crm-api's s3Residency.ts): logos and backgrounds live in its own EU bucket.
  { service: "letterhead-api", prefix: "LETTERHEAD_S3" },
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
  resourceServers: ["estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api", "activities-api", "letterhead-api", "accounting-api", "hours-api"] as ServiceName[],
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
  { name: "AUTH_JWKS_URL", services: ["estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api", "activities-api", "letterhead-api", "accounting-api"], target: "auth" },
  // specs/20261101-crm-notifications: notify-api resolves an email notice's address through auth (ADR 20261101-notify-api-resolves-email-notice-address-from-auth).
  { name: "AUTH_BASE_URL", services: ["refund-api", "inventory-api", "crm-api", "notify-api", "meetings-api", "projects-api", "activities-api", "letterhead-api", "accounting-api"], target: "auth" },
  // specs/20261103-projects-handoff: projects-api notifies a PO's ops-manager after a take (T25); the push is a no-op without it.
  { name: "NOTIFY_INTERNAL_URL", services: ["auth", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api", "activities-api"], target: "notify-api" },
  // specs/20261101-crm-sales-flow: crm-api calls estimai-api with the caller's JWT (estimate requests, offers).
  { name: "ESTIMAI_API_URL", services: ["crm-api"], target: "estimai-api" },
  // specs/20261101-crm-sales-flow AC-3.3: estimai-api tells crm-api an estimate was closed or reopened (ADR 20261105-estimai-closes-the-estimate-crm-follows).
  // specs/20261103-projects: projects-api reads CRM companies from crm-api with its own service credential (ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential).
  { name: "CRM_INTERNAL_URL", services: ["estimai-api", "projects-api"], target: "crm-api" },
  // specs/20261108-estimate-list-oversight: crm-api tells estimai-api an estimate was linked to or unlinked from a deal (ADR 20261108-crm-pushes-deal-links-to-estimai).
  { name: "ESTIMAI_INTERNAL_URL", services: ["crm-api"], target: "estimai-api" },
  // specs/20261104-meetings: meetings-api calls the CRM host's resolve (as the caller) and notices (as itself), ADR 20261104-meeting-host-contract-resolve-and-notices.
  // specs/20261110-activities (ADR 20261110-activities-service-access-delegated-to-host): activities-api asks each host "may this user ..." with the caller's own JWT.
  { name: "CRM_API_URL", services: ["meetings-api", "activities-api"], target: "crm-api" },
  // specs/20261104-meetings A18: meetings-api also asks Projects (a meeting linked to a project); optional there.
  { name: "PROJECTS_API_URL", services: ["activities-api", "meetings-api"], target: "projects-api" },
  // specs/20261110-activities (ADR 20261110-caller-chosen-ids-replace-cross-service-transactions): crm-api calls activities-api's user routes (as the caller) and /system/v1/* (as itself).
  { name: "ACTIVITIES_API_URL", services: ["crm-api"], target: "activities-api" },
  // specs/20261103-projects-handoff: projects-api reads a deal's estimate man-days from estimai-api with the same service
  // credential (ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential). Its service-token provider is built only when CRM_INTERNAL_URL is set, so
  // the two go together.
  { name: "ESTIMAI_INTERNAL_URL", services: ["projects-api"], target: "estimai-api" },
  // specs/20261103-projects-handoff: crm-api reads a deal's project and Bexio order id from projects-api as itself (ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials).
  { name: "PROJECTS_INTERNAL_URL", services: ["crm-api"], target: "projects-api" },
  // specs/20261116-letterhead-service (plan § Architecture): crm-api renders offers through letterhead-api as itself (service JWT,
  // scope `letterhead:render`). Optional in crm-api until the switch: LETTERHEAD_SERVICE_ENABLED is off and the CRM behaves as before (AC-10.12).
  { name: "LETTERHEAD_API_URL", services: ["crm-api"], target: "letterhead-api" },
  // specs/20261119-accounting: refund-api reads Accounting's reference data and rates live, with its own service JWT (ADR 20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it).
  // Required (refund-api exits 1 without it) and private: the token must never travel over the public domain.
  { name: "ACCOUNTING_INTERNAL_URL", services: ["refund-api"], target: "accounting-api" },
  // specs/20261112-time-tracking (ADR 20261112-hours-api-time-entries-own-service-hours-catalog, 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route): hours-api's calls, all over Railway private networking. auth for the JWKS,
  // identities, the live permissions and the service token; the four owners it asks "may this person
  // book ..." as the caller (the forwarded JWT); meetings-api also gets hours-api's own service JWT.
  { name: "AUTH_JWKS_URL", services: ["hours-api"], target: "auth" },
  { name: "AUTH_BASE_URL", services: ["hours-api"], target: "auth" },
  { name: "PROJECTS_API_URL", services: ["hours-api"], target: "projects-api" },
  { name: "CRM_API_URL", services: ["hours-api"], target: "crm-api" },
  { name: "ACTIVITIES_API_URL", services: ["hours-api"], target: "activities-api" },
  { name: "MEETINGS_API_URL", services: ["hours-api"], target: "meetings-api" },
];

/** Browser-facing / identity-claim URLs — must stay PUBLIC (`https://`, not localhost/internal in prod). */
export const PUBLIC_URL_VARS: ReadonlyArray<{ name: string; services: ServiceName[] }> = [
  { name: "AUTH_ISSUER", services: ["estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "meetings-api", "projects-api", "activities-api", "accounting-api"] },
  { name: "BETTER_AUTH_URL", services: ["auth"] },
  { name: "UI_HOME_URL", services: ["auth"] },
  { name: "REFUND_APP_BASE_URL", services: ["refund-api"] },
  // specs/20261101-crm-notifications: the shell origin the email notice links to.
  { name: "APP_BASE_URL", services: ["notify-api"] },
  // specs/20261116-letterhead-service: the configurator talks to letterhead-api's person routes from the browser, so this origin is public.
  { name: "VITE_LETTERHEADS_API_URL", services: ["letterheads-ui"] },
  // specs/20261119-accounting: accounting-ui calls accounting-api from the browser, so this origin is public.
  { name: "VITE_ACCOUNTING_API_URL", services: ["accounting-ui"] },
  // specs/20261112-time-tracking: hours-api's JWT `iss` (it is also in ISSUER.resourceServers).
  { name: "AUTH_ISSUER", services: ["hours-api"] },
];

/** Each backend's `ALLOWED_ORIGINS` must include the public origin of these frontends (CORS). */
export const CORS_REQUIREMENTS: ReadonlyArray<{ backend: ServiceName; mustAllow: ServiceName[] }> = [
  { backend: "auth", mustAllow: ["shell"] },
  { backend: "estimai-api", mustAllow: ["shell"] },
  { backend: "notify-api", mustAllow: ["shell"] },
  // refund-api additionally serves admin-ui's DIRECT cross-origin /rates + /settings calls (ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition).
  { backend: "refund-api", mustAllow: ["shell", "admin-ui"] },
  // inventory-ui is a remote reached through the shell, so the browser Origin is the shell's (ADR 20260709-suite-frontend-module-federation).
  { backend: "inventory-api", mustAllow: ["shell"] },
  // crm-ui is a remote reached through the shell (specs/20261101-crm).
  { backend: "crm-api", mustAllow: ["shell"] },
  // meetings-ui is a remote reached through the shell (specs/20261104-meetings); the audio bucket's own CORS rule
  // (shell origin, POST + GET) is separate and cannot be checked here: infra/meetings-bucket-policy.sh.
  { backend: "meetings-api", mustAllow: ["shell"] },
  // projects-ui is a remote reached through the shell (specs/20261103-projects).
  { backend: "projects-api", mustAllow: ["shell"] },
  // The CRM and projects remotes call activities-api from the shell's origin (ADR 20260709-suite-frontend-module-federation); there is no activities-ui.
  { backend: "activities-api", mustAllow: ["shell"] },
  // letterheads-ui is a remote reached through the shell (specs/20261116-letterhead-service), so the browser Origin is the shell's.
  { backend: "letterhead-api", mustAllow: ["shell"] },
  // accounting-ui is a remote reached through the shell (specs/20261119-accounting), so the browser Origin is the shell's.
  { backend: "accounting-api", mustAllow: ["shell"] },
  // hours-ui is a remote reached through the shell (ADR 20260709-suite-frontend-module-federation, ADR 20261112-hours-ui-ungated-remote),
  // its Settings tab with the time lists included since specs/20261112-time-tracking D51 (they left admin-ui).
  { backend: "hours-api", mustAllow: ["shell"] },
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
    // SERVICE_AUDIENCE is required by auth's env.ts (specs/20261013-notify-service-credentials, ADR 20261013-auth-mints-own-service-credential-in-process); SERVICE_CLIENTS is
    // optional there but required by the contract: without it the service-token endpoint
    // authenticates nobody and the callers' pushes are silently dead.
    "SERVICE_AUDIENCE", "SERVICE_CLIENTS",
    // specs/20261105-signup-gate: the sign-up gate's allowed domains; auth's env.ts exits without it.
    "ALLOWED_SIGNUP_DOMAINS",
  ],
  "estimai-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE", "PORT",
    "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", // specs/20261013-notify-service-credentials: estimai-api authenticates to notify-api as itself
    // specs/20261101-crm-sales-flow AC-3.3: optional in estimai-api's env.ts, required by the contract: without it a
    // closed estimate never becomes ready in the CRM (ADR 20261105-estimai-closes-the-estimate-crm-follows).
    "CRM_INTERNAL_URL",
    // specs/20261108-estimate-list-oversight: optional in estimai-api's env.ts (the deal-link notice route then refuses every
    // call), required by the contract: without it the EstimAI "Deal" badge never appears (ADR 20261108-crm-pushes-deal-links-to-estimai).
    "SERVICE_AUDIENCE",
  ],
  "notify-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE", "PORT",
    // Required by notify-api's env.ts since specs/20261013-notify-service-credentials: the only credential its /system routes accept.
    "SERVICE_AUDIENCE",
  ],
  "refund-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
    "NOTIFY_INTERNAL_URL", "REFUND_APP_BASE_URL", "PORT",
    "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", // specs/20261013-notify-service-credentials
    // specs/20261119-accounting: refund-api's env.ts exits 1 without it (a deployment without it keeps its previous version, which is
    // the release runbook's step 2); it is where every Accounting read goes.
    "ACCOUNTING_INTERNAL_URL",
  ],
  // The S3 bucket name and both credentials are set directly on the Railway service (no
  // 1Password item yet), so the committed template omits them and they are not required here;
  // inventory-api's own src/lib/env.ts is the authority and exits at startup without them.
  "inventory-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
    "NOTIFY_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET",
    "INVENTORY_S3_ENDPOINT", "INVENTORY_S3_REGION", "INVENTORY_S3_EU_ENDPOINT_HOSTS", "PORT",
  ],
  // specs/20261101-crm: a plain resource server — no notify calls (D-14). specs/20261101-crm-sales-flow adds
  // ESTIMAI_API_URL and CRM_S3_*, optional in crm-api's env.ts (the estimate and file routes
  // answer 503 without them) and therefore not required here until they are provisioned (T16).
  // specs/20261101-crm-notifications adds NOTIFY_INTERNAL_URL + SERVICE_CLIENT_*, optional the same way (019 D-7, T11).
  // specs/20261101-crm-sales-flow AC-3.3: SERVICE_AUDIENCE is optional in env.ts (the notices route then refuses
  // everything) but required by the contract, like CRM_INTERNAL_URL on estimai-api (ADR 20261105-estimai-closes-the-estimate-crm-follows).
  // specs/20261103-projects-handoff adds PROJECTS_INTERNAL_URL to the same service client: env.ts requires the client pair
  // (SERVICE_CLIENT_ID + SERVICE_CLIENT_SECRET) with EITHER URL and never alone, so the group is not
  // notify-only; production lists the pair and PROJECTS_INTERNAL_URL in PRODUCTION_REQUIRED_KEYS.
  "crm-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE", "PORT",
    // specs/20261104-meetings: crm-api verifies the scoped service JWT meetings-api posts host notices with (ADR 20261104-meeting-host-contract-resolve-and-notices).
    // Required by the contract: without it every notice is a silent 401 and the deal never learns about
    // its meetings. (crm-api's own env.ts may treat it as optional until the host endpoints ship.)
    "SERVICE_AUDIENCE",
  ],
  // specs/20261104-meetings. A plain-REQUIRED set (no "optional group"): the tool is meaningless without audio
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
  // specs/20261103-projects: a JWKS + authorization-enforcing resource server (ADR 20260716-refund-api-authorization-enforcing-resource-server). Its CRM
  // service-credential group is optional in env.ts, so it is listed in PRODUCTION_REQUIRED_KEYS instead.
  "projects-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE", "PORT",
  ],
  // specs/20261110-activities (ADR 20261110-activities-service-access-delegated-to-host/0082): a JWKS + host-delegating resource server. CRM_API_URL and
  // PROJECTS_API_URL are the hosts it asks (without them every read is 503 host_unavailable);
  // NOTIFY_INTERNAL_URL + SERVICE_CLIENT_* let it notify as itself; SERVICE_AUDIENCE is what crm-api's
  // /system/v1/* calls are verified against. ACTIVITIES_MAINTENANCE is a runbook switch (default false),
  // deliberately not required; so is TASK_DUE_REMINDERS (`on` default | `off`: the due-date reminder scheduler,
  // which sends nothing without the notify group above).
  "activities-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
    "CRM_API_URL", "PROJECTS_API_URL", "NOTIFY_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET",
    "SERVICE_AUDIENCE", "PORT",
  ],
  // specs/20261116-letterhead-service: a JWKS resource server with two audiences (person tokens on /v1/letterheads/*, service tokens on
  // /v1/render/*). The whole list is what letterhead-api/api/src/env.rs requires at startup, minus the bucket's name and two credentials (set by reference to the Railway bucket) and its
  // optional LH_WORKERS / LH_QUEUE (default 2 / 4). The bucket's two credentials are set by reference to the Railway bucket and stay
  // out of the committed template, as for crm-api / inventory-api. A new CALLER of /v1/render/* needs a credential at `auth`, not a
  // line here (AC-9.3). Since specs/20261117-legal-entities (T12) it also HAS a service client of its own (to read the registry):
  // SERVICE_CLIENT_ID/SECRET are optional in its env.rs until the registry client ships (T21), so they are required for production
  // only (PRODUCTION_REQUIRED_KEYS), where the SERVICE_CLIENT_LINKS entry above checks them against auth's registry.
  "letterhead-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE", "SERVICE_AUDIENCE",
    "LETTERHEAD_S3_ENDPOINT", "LETTERHEAD_S3_REGION", "LETTERHEAD_S3_EU_ENDPOINT_HOSTS", "PORT",
  ],
  // specs/20261119-accounting: a JWKS + authorization-enforcing resource server (ADR 20260716-refund-api-authorization-enforcing-resource-server) with one narrow service read
  // (/system/v1/*). The list is what accounting-api/src/lib/env.ts requires at startup (everything but PORT, NODE_ENV and ACCOUNTING_FX_SOURCE,
  // which default). It holds no service client of its own: it calls no service but auth's /authz/resolve and, on demand, the one fixed BAZG host
  // (a constant in its source, not a variable), so there is no SERVICE_CLIENT_* and no *_INTERNAL_URL here. SERVICE_AUDIENCE is required: without it no
  // /system/* caller could be told from a stranger. ACCOUNTING_FX_SOURCE (`bazg` default, `off` for e2e and offline) is optional and
  // deliberately not required.
  "accounting-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE", "SERVICE_AUDIENCE", "PORT",
  ],
  // specs/20261112-time-tracking (ADR 20261112-hours-api-time-entries-own-service-hours-catalog, 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route): a JWKS resource server whose `src/lib/env.ts` requires EVERY
  // variable at start (nothing optional, no group): the four owners it asks as the caller, its own service
  // credential (a meeting's current deal is read from meetings-api as itself) and the audience of that
  // credential, which must differ from AUTH_AUDIENCE. It sends no notification, so no NOTIFY_INTERNAL_URL.
  "hours-api": [
    "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
    "PROJECTS_API_URL", "CRM_API_URL", "ACTIVITIES_API_URL", "MEETINGS_API_URL",
    "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", "SERVICE_AUDIENCE", "PORT",
  ],
};

/**
 * Keys a service's own `src/lib/env.ts` treats as OPTIONAL (a developer's local setup starts without
 * them) but that production must hold. Checked in addition to REQUIRED_KEYS, and only for a prod-like
 * environment (production/preview) — a local run is not flagged for lacking them.
 */
export const PRODUCTION_REQUIRED_KEYS: Partial<Record<ServiceName, string[]>> = {
  // crm-api's SERVICE_AUDIENCE is in REQUIRED_KEYS since specs/20261101-crm-sales-flow AC-3.3 (ADR 20261105-estimai-closes-the-estimate-crm-follows); specs/20261103-projects's
  // `GET /system/companies` relies on the same key (ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential), so no production-only entry is needed.
  // specs/20261103-projects-handoff: the deal page reads its project and Bexio order id from projects-api
  // (PROJECTS_INTERNAL_URL; without it the page says the delivery side is unavailable), which needs the
  // service client pair — env.ts requires the pair with this URL or with NOTIFY_INTERNAL_URL.
  // specs/20261110-activities: ACTIVITIES_API_URL is where crm-api reaches activities-api. Without it the CRM's
  // activity, task and blocker routes have no store.
  //
  // specs/20261116-letterhead-service (T44): LETTERHEAD_API_URL (where crm-api reaches letterhead-api, checked as an internal URL above) and
  // LETTERHEAD_SERVICE_ENABLED (the switch, AC-10.12, `false` in the production template until the owner turns it on) are optional in
  // crm-api's env.ts until the switch, but production must state both so the switch is never an implicit default. They are listed in ONE
  // change with `letterhead:render` in crm-api's SERVICE_CLIENT_LINKS entry and in auth's SERVICE_CLIENTS template (a scope listed on one
  // side only fails).
  "crm-api": ["PROJECTS_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", "ACTIVITIES_API_URL", "LETTERHEAD_API_URL", "LETTERHEAD_SERVICE_ENABLED"],
  // specs/20261103-projects-handoff: every /system/* route answers 401 until the service knows its audience (ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential); equal
  // across auth, notify-api, crm-api, estimai-api and projects-api, and different from AUTH_AUDIENCE.
  "estimai-api": ["SERVICE_AUDIENCE"],
  // specs/20261103-projects: projects-api's all-or-none CRM group — without it a company name is `null` and the
  // company picker answers 503 `crm_unavailable`. specs/20261103-projects-handoff adds SERVICE_AUDIENCE (its own
  // `/system/purchase-orders`, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials), ESTIMAI_INTERNAL_URL (without it taking a deal that has an
  // estimate answers 503 `estimai_unconfigured`; it goes with CRM_INTERNAL_URL, whose presence builds
  // the service-token provider both calls use) and NOTIFY_INTERNAL_URL (without it a take still
  // succeeds but the PO's ops-manager is never notified, AC-4.3 / AC-4.4 — optional in env.ts, so
  // required here only for production).
  "projects-api": ["CRM_INTERNAL_URL", "ESTIMAI_INTERNAL_URL", "NOTIFY_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", "SERVICE_AUDIENCE"],
  // specs/20261117-legal-entities (T12, AC-3.2): letterhead-api reads the legal-entity registry with its own service client. Without the
  // pair every registry read fails closed (503 legal_entities_unavailable) and no document prints an issuer. Production states both, so
  // that the link to auth's SERVICE_CLIENTS entry (scope `legal-entities:read`) is actually checked rather than skipped as "missing".
  "letterhead-api": ["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"],
  // specs/20261112-time-tracking T9 (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route): optional in meetings-api's env.ts on purpose (a missing value must close
  // /system/meetings/hosts with a 401, not stop a service that holds recordings from starting), required
  // here for production: without it hours-api's deal-filtered reads are refused 503 and its by-deal
  // totals cannot name a meeting's deal. Equal across auth, notify-api, crm-api, estimai-api,
  // projects-api, activities-api, meetings-api and hours-api, and different from AUTH_AUDIENCE.
  "meetings-api": ["SERVICE_AUDIENCE"],
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
  "VAPID_PRIVATE_KEY", // notify-api's web-push signing key (specs/20261111-push-notifications); the public key is not secret
  "REFUND_S3_ACCESS_KEY_ID",
  "REFUND_S3_SECRET_ACCESS_KEY",
  "SERVICE_CLIENTS", // JSON carrying every service client's secret (auth)
  "SERVICE_CLIENT_SECRET", // each client's half of that secret (refund-api, estimai-api, inventory-api, crm-api, notify-api, projects-api, activities-api)
  "INVENTORY_S3_ACCESS_KEY_ID",
  "INVENTORY_S3_SECRET_ACCESS_KEY",
  "CRM_S3_ACCESS_KEY_ID",
  "CRM_S3_SECRET_ACCESS_KEY",
  "MEETINGS_S3_ACCESS_KEY_ID",
  "MEETINGS_S3_SECRET_ACCESS_KEY",
  "ACTIVITIES_S3_ACCESS_KEY_ID",
  "ACTIVITIES_S3_SECRET_ACCESS_KEY",
  "LETTERHEAD_S3_ACCESS_KEY_ID",
  "LETTERHEAD_S3_SECRET_ACCESS_KEY",
  "MEETINGS_GCP_SERVICE_ACCOUNT_KEY", // base64 service-account JSON key, carries a private key (specs/20261104-meetings, G-6/G-7)
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

/**
 * Legal-entity registry configuration on `auth` (specs/20261117-legal-entities, plan G4 and G9, security review F3 and F5; T67).
 * Every name here is OPTIONAL: auth starts without any of them, so none is in REQUIRED_KEYS and none is pinned as a literal in
 * `templates/production/auth.env` (a pinned literal would make `--live` report it MISSING from a deployed auth that relies on the
 * default). The template carries them as comments; the rules below are what a value must satisfy when one is set.
 *
 * `legalEntityConfigProblems` is pure and names only: it never returns a value. The shipped template is checked against it in
 * `check.test.ts`, which is what fails a template that raises the write limit above `LEGAL_ENTITY_WRITE_RATE_LIMIT_PRODUCTION_MAX`.
 * (`check.ts` does not call it yet: it is outside T67's files, so a deployed value is not inspected by `mise run env:doctor`.)
 */
export const LEGAL_ENTITY_NOTICE_EMAIL = "LEGAL_ENTITY_NOTICE_EMAIL";

/** Security review F3: save and restore are throttled per person; production must not widen the default. */
export const LEGAL_ENTITY_WRITE_RATE_LIMIT_PRODUCTION_MAX = 10;

export const LEGAL_ENTITY_RATE_VARS = {
  LEGAL_ENTITY_WRITE_RATE_LIMIT: { default: 10, min: 1 },
  LEGAL_ENTITY_CHECK_RATE_LIMIT: { default: 60, min: 1 },
  /** The one window of both limiters, in milliseconds (auth's env.ts: at least 1000). */
  LEGAL_ENTITY_RATE_WINDOW_MS: { default: 600000, min: 1000 },
} as const;

/** One address, local@domain.tld: no list, no display name, no whitespace. The same shape auth's env.ts validates at startup. */
const SINGLE_EMAIL = /^[^\s@<>,;()[\]"']+@[^\s@<>,;()[\]"'@]+\.[^\s@<>,;()[\]"'@]+$/;

/**
 * What is wrong with the legal-entity variables of one auth environment, by name. Unset or empty = fine (the defaults apply, no
 * outside recipient); a Railway or secret-store reference cannot be judged offline and is skipped.
 */
export function legalEntityConfigProblems(authEnv: Readonly<Record<string, string | undefined>>, opts: { prodLike: boolean }): string[] {
  const out: string[] = [];
  const concrete = (v: string | undefined): v is string => v !== undefined && v !== "" && !isRailwayRef(v) && !isSecretRef(v);
  const email = authEnv[LEGAL_ENTITY_NOTICE_EMAIL];
  if (concrete(email) && !SINGLE_EMAIL.test(email.trim())) {
    out.push(`${LEGAL_ENTITY_NOTICE_EMAIL} must be one email address (auth refuses to start otherwise), or unset for no outside recipient`);
  }
  for (const [name, rule] of Object.entries(LEGAL_ENTITY_RATE_VARS)) {
    const raw = authEnv[name];
    if (!concrete(raw)) continue;
    const n = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < rule.min) {
      out.push(`${name} must be an integer of at least ${rule.min} (auth refuses to start otherwise)`);
    }
  }
  const write = authEnv.LEGAL_ENTITY_WRITE_RATE_LIMIT;
  if (opts.prodLike && concrete(write) && /^\d+$/.test(write.trim()) && Number(write) > LEGAL_ENTITY_WRITE_RATE_LIMIT_PRODUCTION_MAX) {
    out.push(
      `LEGAL_ENTITY_WRITE_RATE_LIMIT must not exceed ${LEGAL_ENTITY_WRITE_RATE_LIMIT_PRODUCTION_MAX} in production (security review F3: it bounds how fast one stolen session can rewrite the issuer's details); the high value is for the e2e stack only`,
    );
  }
  return out;
}
