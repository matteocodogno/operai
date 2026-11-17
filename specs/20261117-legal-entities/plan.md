---
spec: 20261117
status: approved
approved: 2026-11-17
---

# Plan: Legal entities — one registry of the group's companies, for every tool

Inputs: `spec.md` (approved 2026-11-17, OQ-1 to OQ-6 resolved as proposed), the codebase as it is (facts cited with
paths), the ADRs in `docs/adr/`. Decisions that need an ADR are marked **[ADR-n]** and listed under "ADR candidates".
Where the spec is silent, wrong or contradicts another spec, the point is listed under "Spec drift" with a proposed
amendment; the plan states what it assumes until the owner decides.

## Architecture

### Shape

```
                      person (session cookie or Bearer JWT, aud AUTH_AUDIENCE)
 admin-ui ─────────────────────────────┐   (Legal entities page, history, restore)
 crm-ui (settings link, try-preview) ──┤
 letterheads-ui (link, notice) ────────┤
                                       ▼
                          ┌──────────────────────────────────┐
                          │ auth  (Bun / Hono / Prisma)       │
                          │  /legal-entities/*      person    │──► Postgres db `auth`
                          │  /system/legal-entities service   │      legal_entity_version (append-only, trigger)
                          │  /authz/me  apps += admin (derived)│      audit_log (existing, Tier 2)
                          └──────────────────────────────────┘
                                ▲ service JWT, scope legal-entities:read (aud SERVICE_AUDIENCE)
                 ┌──────────────┴──────────────┐
                 │                             │
        crm-api (own cache 30 s/60 s)   letterhead-api (own cache 30 s/60 s)
        issuer of offers & contracts    {legal_name} {address} {vat} {iban} {contacts}
        classic path (pdf-lib) and      for renders (content v2) and the configurator
        letterhead path ── content v2 ──► preview (real details, empty = "missing" style)
        (no entityData)  + legalEntityVersion pin

 one-off move (operator, ADR 20261110 shape):
 auth/scripts/import-crm-legal-details.ts  ── reads ──► Postgres db `crm` entity_profile (read-only)
                                           ── writes ─► db `auth` legal_entity_version v1 (system) + audit_log
```

- **auth** owns the registry (owner constraint): one new table, a read API for persons and for services, a
  management API gated by a new entity-scoped permission, the import script, and one derived entry in
  `GET /authz/me`'s `apps` so a manager who is not an administrator reaches the page (AC-4.3, below).
- **admin-ui** gains the Legal entities section: list of both entities, the entity form, the history, a read-only
  version view, restore. Sections are shown by capability.
- **letterhead-api** reads the details itself (owner constraint) through a service client of its own, caches them
  (30 s fresh, 60 s at most when the registry fails), prints them per language, ignores any `entityData` a caller
  still sends, and shows real details in the configurator preview.
- **crm-api** reads the issuer from the registry for every document path (wizard generation, edit/revise, legacy
  classic path, both preview routes), stops sending `entityData`, and refuses an incomplete entity with a message
  naming what is missing. Its entity settings keep only the CRM's own values.
- **crm-ui** loses the four legal fields from the entity settings form and points to the Legal entities page;
  the try-preview reads the issuer from the registry.
- **letterheads-ui** shows the notice and legend of the "missing" style and links to the Legal entities page.
- **shell**: no code change (the `admin` tool is shown from `apps`, which auth derives).

### Key decisions (chosen, and what was rejected)

1. **Registry = one append-only table of versions in auth; current = highest version** (the letterhead precedent,
   `ADR 20261116-letterhead-versions-assets-and-change-record-are-immutable-in-the-database`). No "current" pointer
   and no mutable row: a save or a restore inserts version n+1 (AC-2.1, AC-2.4), nothing can change or delete a
   version (AC-2.7), enforced by a raising trigger — the first **Tier 1** table in auth **[ADR-1]**
   (`ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level` keeps `audit_log` at Tier 2; versions
   of the legal identity that documents print, IBAN included, are governance/financial records, i.e. Tier 1).
   Rejected: a mutable `legal_entity` row plus `audit_log` as the only history (history would depend on a Tier 2
   table and on parsing audit JSON; AC-2.3 needs whole versions); JSONB details per version (opaque, would need a
   schema version inside rows; columns give typed diffs and checks; a future detail is one `ADD COLUMN … DEFAULT`,
   which fires no row trigger).
2. **Two read routes with one serializer** — `GET /legal-entities[/{entity}]` for any signed-in person (AC-3.1) and
   `GET /system/legal-entities[/{entity}]` for a service JWT with `legal-entities:read` (AC-3.2). Same handler body,
   same serializer, so "the same answer" holds by construction (a contract test compares bytes). Rejected: one
   route accepting both credential families (auth keeps `/system/*` for service JWTs, with its per-service rate
   limits — `ADR 20261112-system-endpoints-limited-per-verified-service`; mixing families on one route is what the
   letterhead plan's separate routers avoided). What a person may *do* (`canManage`) is not in the details answer
   — it is `GET /legal-entities/manageable` — so the person and service answers stay identical.
3. **Service scope `legal-entities:read`** (the request's `companies:read`, renamed). Why: (a) the spec's vocabulary
   is "legal entity", chosen so it is never confused with the CRM's companies (customers); `crm.companies.read`
   already exists in `KNOWN_SERVICE_SCOPES` (`auth/src/system/serviceClients.ts`) for CRM customers, and
   `companies:read` next to it is the exact confusion the spec forbids; (b) no service prefix: the registry is a
   suite resource whose host (auth) is an implementation detail — unlike `crm.companies.read`, which names the
   service that serves it; (c) the colon form matches the newest scope (`letterhead:render`) and the person
   permission it pairs with (`legal-entity:manage`). Holders: `crm-api` (added to its client), `letterhead-api`
   (a new client). Nothing else changes in the scope model.
4. **Permission `legal-entity:manage` with the `entity` condition, in the admin app's catalog** (AC-4.1). The
   `admin` app moves from the access-only `SUITE_APPS` list (`auth/src/authz/seed.ts:162`) to a declared
   `ADMIN_CATALOG` (`auth/src/authz/catalogs/admin.ts`): resource `admin` (`access`) + resource `legal-entity`
   (`manage`, `supportedConditions: ["entity"]`), registered in `DECLARED_CATALOGS`. Moving it (not adding a second
   registration) matters: `upsertAppCatalog` is a full replace per `appId`, so two registrations of `admin` would
   prune each other (the doc of `seedAppAccessCatalog`). Granted through roles like every permission. Seed: the
   `admin` role gets it unconditioned (as `letterhead:manage`, `seedLetterheadsGrants`); no other role.
   The condition is the suite's one entity condition, `{key:"entity", match:"user"}`: a conditioned grant covers
   the holder's **own** entity attribute, an unconditioned one covers both (`entityGrantFor`,
   `auth/src/authz/resolver.ts`). See Spec drift D6.
5. **Reaching the page (AC-4.3).** `/admin/$` in the shell is guarded by `apps ∋ "admin"`
   (`createToolAccessBeforeLoad('admin')`, `shell/src/router.tsx`), and every existing admin-ui API is guarded by
   `requireAdmin` (direct `admin` role). A Swiss accountant who holds `legal-entity:manage` for welld_ch only would
   not reach the page. Decision **[ADR-3]**: `GET /authz/me` derives `admin` into `apps` when the caller holds
   `legal-entity:manage` covering at least one entity (one function, `adminAreaReachable(permissions, user)`, the
   same coverage function the management routes use). The shell is unchanged (Sidebar and guard read `apps`).
   Inside admin-ui, sections are shown by capability: Roles, Departments, Users and Audit when the person holds
   `admin:access` (today's meaning, unchanged); Legal entities when `GET /legal-entities/manageable` is not empty.
   The index route redirects to the first visible section; a hidden section's URL redirects there too. The admin
   APIs keep `requireAdmin`, so the derived entry opens no admin data.
   Rejected: (a) "grant `admin:access` with the permission" — two grants that must travel together; a manager
   without the second would hold the permission and not see the page, breaking AC-4.3 as written; (b) a shell
   route outside `/admin` (the ADR 20261006 "ungated second entry" shape) — that rule is for identity-scoped
   screens every user reaches, and the spec places the page in the administration area; (c) the browser
   evaluating the entity condition (`/authz/me` carries no user entity; the letterhead plan rejected
   browser-side condition checks for the same reason, R3/G4).
6. **The letterhead service reads the details; content version 2; `entityData` ignored** **[ADR-2]**.
   `contentVersion: 2` means "the issuer's details are the service's". Both 1 and 2 are accepted; in both,
   `entityData` is accepted and discarded (AC-5.2: ignored, not refused; v1 keeps its existing structural check, so
   every request valid yesterday is valid today). crm-api sends 2 without `entityData`. Why bump the version
   although the body barely changes: a push to `main` redeploys every service in no order
   (`ADR 20261110-activities-migration-write-pause`, Context). A new crm-api that stops sending details, talking
   to an old letterhead-api, would get documents printed **without** an issuer (old AC-6.4: missing values print
   nothing, no refusal). With version 2 the old service refuses (`unsupported_content_version`) and crm-api answers
   503 `layout_service_unavailable`: the skew fails closed. Rejected: keeping v1 only (silent issuer-less
   documents during skew); a capability probe before each render (an extra call that still races the deploy).
7. **Consumer cache: fresh 30 s, usable 60 s on failure, then refuse** (AC-3.3, AC-5.5) **[ADR-2]**. One entry per
   consumer process (the list of both entities), stamped with the monotonic time the request was **sent**.
   - age < 30 s: used;
   - otherwise refreshed (single-flight, 5 s timeout, no redirects, ≤ 64 KiB body);
   - refresh fails and age ≤ 60 s: the old entry is used (logged `registry_stale_used`);
   - refresh fails and age > 60 s: 503 `legal_entities_unavailable`, `Retry-After: 5`, no document.
   Proof of AC-3.3: a document started at t > T + 60 uses an entry whose request was sent at ≥ t − 60 > T, so auth
   read the table after the save committed at T. Proof of AC-5.5: nothing older than 60 s is ever used. The 30 s
   is the suite's existing tolerance (`/authz/resolve` cache, `letterhead-api/api/src/authz/resolve.rs` `TTL`).
   auth answers `Cache-Control: no-store`; admin-ui reads live (no cache).
8. **One document = one version of the details.** crm-api prints the issuer in the body (`[EMITTENTE]`,
   `[INDIRIZZO]` through `WizardContext.issuerLegalName/issuerAddressLines`), in the snapshot and on the classic
   path; letterhead-api prints the frame from its own cache. The two caches can differ for up to 60 s, which would
   mix two versions in one PDF. So content v2 carries an optional `legalEntityVersion` (the version crm-api used):
   letterhead-api refreshes when its entry is older and answers 409 `legal_entity_version_mismatch`
   (`currentVersion`) when it still differs; crm-api drops its cache entry, rebuilds the content and retries once.
   Rejected: crm-api sending the details (owner constraint: the service reads them itself).
9. **The move: expand → copy (announced freeze of CRM entity settings) → switch → contract**, the shape the owner
   accepted for the activities move (`ADR 20261110-activities-migration-write-pause`) **[ADR-4]**. The copy is a
   dry-run-by-default operator script in auth that reads crm's `entity_profile` read-only and writes version 1 of
   each entity, attributed to the system, with an `audit_log` row; its report (found / inserted / already present /
   mismatched, plus incomplete, invalid and IBAN-print flags) is the witness. Consumers switch in a later push,
   only after the report shows both entities present and 0 mismatched. Rejected: a temporary crm-api system route
   plus an auth self-minted credential and an automatic import loop (a new auth → crm-api dependency, a second
   self-minted scope amending `ADR 20261013-auth-mints-own-service-credential-in-process`, and an import that runs
   whenever both happen to be up, with no owner look at the flags before documents change); crm-api pushing to a
   write-scoped auth endpoint (a standing service capability to rewrite legal details — the exact fraud surface of
   Security below); a Prisma migration in auth reading crm's database (the migration would carry another
   service's credentials on every deploy).
10. **Validation lives in auth only; incompleteness is answered by auth.** The read answer carries `complete` and
    `missing` (AC-1.2's closed set), so crm-api (AC-6.3), admin-ui (AC-7.3) and nobody else re-implements the rule.
11. **CRM columns are kept until a later contract push.** This release removes the legal fields from the CRM's
    settings API and UI (AC-6.1) and stops every read of them; dropping the columns is the contract step, in a
    later push (never in the switch push — ADR 20261110's rule), so reverting the switch push is a working undo.

### Release order (every environment)

A push to `main` redeploys every changed Railway service and Vercel frontend in no guaranteed order, and auth
refuses to start with a `SERVICE_CLIENTS` scope it does not know (`parseServiceClients`). So the order is a
sequence of pushes and steps, and each push is correct whatever order its services come up in.

| Step | What | Gate to go on |
| --- | --- | --- |
| **1. Expand** (push 1) | **auth only**: migration (table + trigger), `ADMIN_CATALOG` and seed, read/management/service routes, `legal-entities:read` in `KNOWN_SERVICE_SCOPES`, derived `apps`, import script. No consumer reads the registry; it answers `version: 0` for both entities. | auth `/health` reports the new version; `GET /legal-entities` → both `version: 0`. |
| **2. Credentials** (env, no code) | auth `SERVICE_CLIENTS`: `crm-api` scope += `legal-entities:read`; new entry `letterhead-api` = `{secret, scope:"legal-entities:read"}`. letterhead-api: `SERVICE_CLIENT_ID=letterhead-api`, `SERVICE_CLIENT_SECRET` (old code ignores both). | `mise run env:doctor -- --env production --resolve` green. |
| **3. Copy** (operator) | Announce: no edits to CRM entity settings until step 5 is live. Run `bun run scripts/import-crm-legal-details.ts` (dry run), then `--apply`, then the dry run again. `CRM_DATABASE_URL` and `DATABASE_URL` in the environment only (ADR 20261110 amendment L4). | Report: found 2, inserted 2 (or present 2), mismatched 0; the owner has read the flags (incomplete, invalid, IBAN print changed — D2, D3). |
| **4. Pre-switch check** | Dry run again just before push 2. | present 2, mismatched 0: nobody edited the CRM legal fields since the copy. A mismatch is resolved by a registry save (API, an admin) before going on. |
| **5. Switch** (push 2) | crm-api, crm-ui, letterhead-api, letterheads-ui, admin-ui together. Order-independent: v2 fails closed against an old letterhead-api; crm-api accepts and ignores the legacy legal keys from an old crm-ui; crm-ui reads `issuerAddress` and falls back to `issuerAddressLines` from an old crm-api; admin-ui only calls auth (already live). The freeze ends when crm-api is live. | Smoke per entity: preview an offer (classic and, where the switch is on, the service) and compare the issuer lines with the day before (AC-7.5). |
| **6. Contract** (a later release) | crm-api migration drops `legalName`, `addressLines`, `vatNumber`, `iban` from `entity_profile`; remove the `issuerAddressLines` compatibility field and the legacy-key tolerance; the import script stays as history (it refuses to run once every entity has a version). | Step 5 has been live in production; listed in the CHANGELOG as the next step. |

Undo: before step 6, reverting push 2 brings back CRM-sourced issuers (columns intact). Registry saves made after
step 5 are not in the CRM; the runbook says so.

`LETTERHEAD_SERVICE_ENABLED` is `false` in production today; nothing above depends on it. If it is on by then, v2
keeps the skew safe (decision 6).

Local and test environments: compose runs the same migration; `mise run legal-entities:import` runs the script
with the two local URLs (`--apply`); test suites seed the registry through the import function.

### Sequences

**Read (person).** `sessionMiddleware` + `requireAuth` (`auth/src/auth/auth.middleware.ts`, cookie or Bearer as
for `/authz/me`) → 401 if none → read the highest version of each entity (one query, `DISTINCT ON (entity)`) →
serialize; an entity with no version yet is `version: 0` with empty values → 200, `Cache-Control: no-store`.
Unknown entity in the path → 404 `unknown_legal_entity` (fixed body, the name not echoed — AC-3.4).

**Read (service).** Verify the service JWT in process as `POST /system/users/contact` does
(`auth/src/system/userContact.routes.ts`: RS256, issuer, `aud = SERVICE_AUDIENCE`, `sub = system:*`, scope
`legal-entities:read`; one frozen 401 for every failure) → count against the verified service
(`systemRateLimits`, new limiter `legalEntities`, 300 per window) → same handler as the person read.

**Save.** Person read path → coverage check `entityGrantFor(perms, "legal-entity", "manage", user, entity)`
(403 `forbidden` when null; AC-4.2) → bounded body (16 KiB, `auth/src/system/boundedBody.ts`) → strict schema
(422 `invalid_request`) → normalise and validate (422 `invalid_legal_entity`, every problem at once) →
`withAudit` transaction (`auth/src/authz/audit.ts`, `affectedUserIds: []`):
`pg_advisory_xact_lock(hashtext('legal_entity:' || entity))` → current = max(version) (0 if none) →
current = 0: 409 `legal_entity_not_moved` → `baseVersion ≠ current`: 409 `version_conflict` + `currentVersion`
(AC-2.6) → details equal to current: 200 `{version: current, created: false}`, no row, no audit (AC-2.1) → insert
version current+1 with `changedFields` → audit row `legal_entity.save` → 201.

**Restore.** As save, with body `{baseVersion}`; the details are version n's; n not found → 404
`version_not_found`; n's details fail today's rules (an incomplete or invalid imported version 1) → 422
`invalid_legal_entity` (D4); equal to current → 200 `created: false`; else insert with `action: restore`,
`restoredFrom: n`, audit `legal_entity.restore` (AC-2.4, AC-2.5).

**Copy (script).** Per entity: advisory lock → a version exists → compare version 1 with the CRM row under the
mapping; differ → "mismatched" (never overwritten — AC-7.4) else "present" → no version → (`--apply`) insert
version 1 `action: import`, `createdByUserId: null`, and audit `legal_entity.import` (actor null; data: source
`crm.entity_profile` + its `updatedAt`, values after, `missing`, `invalid`, `ibanPrintChanged`) in one
transaction (AC-7.1, AC-7.2). Mapping: CRM's own print rule first (`oneLine`, `crm-api/src/offers/blocks.ts`: a
line break and the blanks around it become one space, then trim — what the CRM printed); legal name; address lines
without blank ones into **both** `address.it` and `address.en`; VAT; IBAN with all whitespace removed and upper-cased
(AC-1.4's stored form; the check digits are reported, not enforced — D3); contacts empty (AC-7.1). No CRM row →
version 1 with empty values (AC-7.3). Values over today's limits are kept as they are and reported (D3). The CRM
connection is opened read-only (`default_transaction_read_only = on`); the script prints no value.

**Consumer read (crm-api, letterhead-api).** Cache (decision 7) → `GET {AUTH_BASE_URL}/system/legal-entities` with
the service token (crm-api: `serviceTokens` of `crm-api/src/lib/serviceToken.ts`; letterhead-api: a Rust port with
the same rules — cached, refreshed 60 s before expiry, single-flight, no redirects, nothing logged) → a 401 drops
the token and retries once.

**Offer generation / preview (crm-api).** Read the registry (above) **before** the deal transaction →
`complete = false` → 409 `legal_entity_incomplete` + `entity` + `missing` (AC-6.3) → build the context with
`legalName`, `address[language]`, `vatNumber`, `ibanPrint` (AC-6.2) → snapshot `issuer` from the same values
(`snapshotOf`, `wizardSnapshotOf`, `crm-api/src/offers/generation.ts`) → classic path draws from the snapshot as
today (`contractPdf.ts`), service path sends content v2 with `legalEntityVersion` → on 409 mismatch: invalidate,
re-read, rebuild, retry once.

**Render (letterhead-api).** As today, plus: after validation, before the pool, take the entity's details from the
cache (503 `legal_entities_unavailable` per decision 7) → `legalEntityVersion` check (decision 8) → the job's
`EntityData` = registry values in the request's language (`address[language]`, `contacts[language]`,
`ibanPrint`) → worker unchanged → answer gains `legalEntityVersion` (preview JSON member; PDF header
`Legal-Entity-Version`) → the one log line gains `legal_entity_version` and `entity_data_ignored`.

**Configurator preview (letterhead-api).** As today, but the sample document's body is kept and its entity data is
replaced by the registry's in the preview language, rendered with `mark_missing`: an empty placeholder prints its
label (closed set, both languages, in the engine) in the `missing` look, and a conditional segment around it is
kept so the person sees it (AC-5.4). Registry unavailable (decision 7) → the preview still renders, every
placeholder in the `missing` look, and the answer says `issuerDetails: "unavailable"` (a preview is not a
document; AC-5.5 is about documents). Real details may overflow a frame: the preview answers 422
`header_overflow`/`footer_overflow` as a render would (R9).

## Data model

### auth — Prisma migration `…_legal_entities`

```prisma
/// One version of one legal entity's details (specs/20261117-legal-entities). Append-only: the migration's
/// trigger refuses UPDATE, DELETE and TRUNCATE (Tier 1, ADR-1). The current details are the highest version.
model LegalEntityVersion {
  entity          String            // CHECK in ('welld_it','welld_ch')
  version         Int               // CHECK >= 1; contiguous per entity (advisory lock + PK)
  legalName       String            // '' = empty; never null
  addressIt       String[]          // lines, no blank line
  addressEn       String[]
  vatNumber       String
  iban            String            // electronic form: upper case, no spaces ('' = empty)
  contactsIt      String
  contactsEn      String
  action          String            // CHECK in ('import','save','restore')
  restoredFrom    Int?              // CHECK (action = 'restore') = (restoredFrom IS NOT NULL) AND restoredFrom < version
  changedFields   String[]          // closed set below, vs the version before (all non-empty fields for version 1)
  createdByUserId String?           // null = the system (the move); plain column, not a FK (User.deletedByUserId convention)
  createdByName   String?           // the person's name at the save; null for the system
  createdAt       DateTime @default(now())

  @@id([entity, version])
  @@map("legal_entity_version")
}
```

Hand-appended SQL (the convention of `auth/prisma/migrations/20260804094012_employee_address/migration.sql`):

```sql
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_entity CHECK (entity IN ('welld_it','welld_ch'));
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_positive CHECK (version >= 1);
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_action CHECK (action IN ('import','save','restore'));
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_import_is_v1_by_system
  CHECK ((action = 'import') = ("createdByUserId" IS NULL) AND (action <> 'import' OR version = 1));
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_restore
  CHECK ((action = 'restore') = ("restoredFrom" IS NOT NULL) AND ("restoredFrom" IS NULL OR "restoredFrom" < version));
-- Tier 1 (ADR-1): rows are never changed or removed.
CREATE FUNCTION legal_entity_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'legal_entity_version_immutable'; END $$;
CREATE TRIGGER legal_entity_version_no_update_delete BEFORE UPDATE OR DELETE ON legal_entity_version
  FOR EACH ROW EXECUTE FUNCTION legal_entity_version_immutable();
CREATE TRIGGER legal_entity_version_no_truncate BEFORE TRUNCATE ON legal_entity_version
  FOR EACH STATEMENT EXECUTE FUNCTION legal_entity_version_immutable();
```

- No length CHECKs: limits are AC-1.3's rules for a save, and the move keeps values that break them (D3).
- `changedFields` closed set: `legalName`, `address.it`, `address.en`, `vatNumber`, `iban`, `contacts.it`,
  `contacts.en`. Stored at insert (immutable, so it never needs recomputing) and used by AC-2.2.
- The two entities are the constant `LEGAL_ENTITIES = ["welld_it","welld_ch"]` in
  `auth/src/legalEntities/entities.ts`; `ENTITY_VALUES` of `auth/src/admin/users.routes.ts:68` imports it (one list).
- `audit_log` unchanged (Tier 2). New actions: `legal_entity.import`, `legal_entity.save`, `legal_entity.restore`,
  `targetType: "legal_entity"`, `targetId: <entity>`, `data: { version, baseVersion?, restoredFrom?,
  changes: { <field>: { before, after } } }` — before/after of each changed value (AC-2.5); for the import,
  `before` is absent and the source is named.
- Catalog/seed: `auth/src/authz/catalogs/admin.ts` (`ADMIN_CATALOG`), `SUITE_APPS` loses `admin`,
  `seedAdminCatalog` registered, `seedLegalEntityGrants` (`admin` role, `legal-entity:manage`, unconditioned,
  idempotent via `ensureGrant`), both called from `seed()` (runs at every deploy through `db:release`).
- `KNOWN_SERVICE_SCOPES` += `legal-entities:read`; `DOCUMENTED_CLIENT_SCOPES`: `crm-api` += `legal-entities:read`,
  new `letterhead-api: "legal-entities:read"`.

### crm-api — Prisma migration `…_legal_details_moved` (push 2)

- `entity_profile."legalName"` `SET DEFAULT ''`, `"addressLines"` `SET DEFAULT '{}'`: a profile row can be created
  by a PUT that no longer carries them. Nothing is dropped (step 6).
- The model keeps the columns (read by nothing but the copy script) with a doc comment pointing at step 6.
- `DealOffer.snapshot.issuer` keeps its shape; new snapshots add `legalEntityVersion` (number), additive; old
  snapshots are not touched (AC-6.4).

### letterhead-api

- No table. Content model: `CONTENT_VERSION` set {1, 2}; `RenderRequest` gains optional `legalEntityVersion: i32`
  (v2 only); `entity_data` is parsed (v1's check, unchanged) and dropped before the job is built.
- Env (`letterhead-api/api/src/env.rs`): `SERVICE_CLIENT_ID` (required, the client id) and `SERVICE_CLIENT_SECRET`
  (required, 32–256 chars, `Secret`); `AUTH_BASE_URL` (existing) is where both the token and the registry are read.
  Workers' environment is already cleared at spawn: the secret stays in the supervisor.

### Configuration contracts

- `tools/env-doctor/manifest.ts`: crm-api's link `requiredScopes` += `legal-entities:read`; a new link for
  `letterhead-api` with `legal-entities:read`; `templates/production/letterhead-api.env` +=
  `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`.
- `infra/README.md`: the release steps above, the `letterhead-api` client, the copy runbook.
- `mise.toml`: `legal-entities:import` task (local).

## API contracts

All errors are RFC 7807 `application/problem+json` with a `code`; no error body repeats a submitted value. Every
answer below carries `Cache-Control: no-store`.

### Details (the one serializer)

```jsonc
// LegalEntity
{
  "entity": "welld_ch",
  "version": 3,                         // 0: not moved yet (empty values below)
  "updatedAt": "2026-11-17T10:12:00.000Z",   // null when version is 0
  "legalName": "wellD SA",
  "address": { "it": ["Via …", "6900 Lugano", "Svizzera"], "en": ["Via …", "6900 Lugano", "Switzerland"] },
  "vatNumber": "CHE-123.456.789 IVA",
  "iban": "CH9300762011623852957",      // electronic form; "" when empty
  "ibanPrint": "CH93 0076 2011 6238 5295 7",  // groups of four (D2); "" when empty
  "contacts": { "it": "Tel. +41 91 … · info@welld.ch", "en": "Phone +41 91 … · info@welld.ch" },
  "complete": true,                     // AC-1.2's required values all present
  "missing": [],                        // ⊂ ["legalName","address.it","address.en","vatNumber"]
  "invalid": []                         // [{ field, reason }] — only a moved value can be here (D3)
}
```

| Route | Credential | Answer |
| --- | --- | --- |
| `GET /legal-entities` | person (any signed-in) | 200 `{ items: [LegalEntity welld_it, LegalEntity welld_ch] }`; 401 |
| `GET /legal-entities/{entity}` | person | 200 `LegalEntity`; 404 `unknown_legal_entity`; 401 |
| `GET /system/legal-entities` | service JWT, scope `legal-entities:read` | the same 200 body as the person route; one frozen 401; 429 (shared `tooManyRequests`) |
| `GET /system/legal-entities/{entity}` | service JWT, same | same as the person route; 404 `unknown_legal_entity` |
| `GET /legal-entities/manageable` | person | 200 `{ entities: ["welld_ch"] }` (`[]` for none) |

### Management (person; `legal-entity:manage` covering at least one entity, else 403 `forbidden`)

| Route | Extra rule | Body → answer |
| --- | --- | --- |
| `GET /legal-entities/{entity}/versions` | any covered entity may read either history (AC-4.3: the other read-only) | `{ items: [{ version, action, restoredFrom, createdBy: {id, name} \| null, createdAt, changedFields }] }`, newest first, every version (AC-2.2) |
| `GET /legal-entities/{entity}/versions/{n}` | same | `LegalEntity` of version n + `{ action, restoredFrom, createdBy, createdAt }` (AC-2.3); 404 `version_not_found` |
| `POST /legal-entities/{entity}/versions` | must cover `{entity}` | `{ baseVersion, details: { legalName, address: {it, en}, vatNumber, iban, contacts: {it, en} } }` → 201 `{ version, created: true, entity: LegalEntity }` / 200 `{ version, created: false, … }` |
| `POST /legal-entities/{entity}/versions/{n}/restore` | must cover `{entity}` | `{ baseVersion }` → as save; 404 `version_not_found` |

Refusals of the two POSTs:

| Status | `code` | When |
| --- | --- | --- |
| 401 | — | not signed in |
| 403 | `forbidden` | no `legal-entity:manage` covering the entity (AC-4.2); nothing changes |
| 409 | `version_conflict` + `currentVersion` | `baseVersion` is not the current version (AC-2.6) |
| 409 | `legal_entity_not_moved` | the entity has no version yet (the move has not run; AC-7.1/7.2 stay true) |
| 413 | `request_too_large` | body over 16 KiB |
| 422 | `invalid_request` | not the shape above (missing/unknown member, wrong type); no name of an unknown member is echoed |
| 422 | `invalid_legal_entity` + `problems: [{ field, line?, reason, limit? }]` | AC-1.2–1.4; every problem at once |

`field` ∈ the closed set of `changedFields`; `line` (0-based) for an address line; `reason` ∈ `required`,
`too_long`, `too_many_lines`, `line_break`, `control_character`, `iban_format`, `iban_check_digits`; `limit` for
`too_long`/`too_many_lines`.

**Normalisation and rules of a save** (one module, `auth/src/legalEntities/rules.ts`, also used for `invalid` on
reads and for restore):
- every value NFC-normalised, then trimmed; address lines trimmed and blank lines removed;
- required (AC-1.2): `legalName`, ≥ 1 line in `address.it`, ≥ 1 in `address.en`, `vatNumber`; `iban`, `contacts.*`
  may be empty;
- `line_break`: U+000A, U+000D, U+0085, U+2028, U+2029 in a one-line value or an address line;
  `control_character`: any other Unicode `Cc`, or a lone surrogate (AC-1.3);
- limits in Unicode code points (AC-1.3): legal name 200; address ≤ 4 lines × 120 per language; VAT 40; contacts
  200 per language; IBAN 34 after removing spaces;
- IBAN (AC-1.4): remove every whitespace, upper-case; then `^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$` (else
  `iban_format`) and ISO 7064 mod 97-10 = 1 (else `iban_check_digits`). No per-country length table (maintenance
  rejected; mod 97 catches typos, which is the owner's aim, OQ-2);
- `ibanPrint` = electronic form in groups of four separated by one space.

### `GET /authz/me` (changed)

`apps` = the resources with an `access` grant, as today, **plus** `"admin"` when `legal-entity:manage` covers at
least one entity for the caller (decision 5). Nothing else in the answer changes; `/authz/resolve`,
`/authz/app-access-check` and the directory's app filter keep their exact derivation (they answer other
questions).

### letterhead-api (changed)

- `POST /v1/render/preview` and `/v1/render/pdf`: `contentVersion` ∈ {1, 2}; `entityData` accepted and ignored in
  both; v2 adds optional `legalEntityVersion`. New answers:

| Status | `code` | When |
| --- | --- | --- |
| 503 | `legal_entities_unavailable`, `Retry-After: 5` | registry unreadable and nothing read within 60 s (AC-5.5) |
| 409 | `legal_entity_version_mismatch` + `currentVersion` | `legalEntityVersion` given and not the current one after a refresh |
| 422 | `unsupported_content_version` | 0, 3 or more (was: anything but 1) |

  Success answers gain `legalEntityVersion` (preview JSON) / `Legal-Entity-Version` (PDF header).
- `POST /v1/letterheads/{entity}/preview` (configurator): answer gains
  `issuerDetails: "current" | "unavailable"` and `legalEntityVersion` (null when unavailable).

### crm-api (changed)

- `GET /entity-profiles`: items lose `legalName`, `addressLines`, `vatNumber`, `iban` (AC-6.1).
- `PUT /entity-profiles/{entity}`: body `{ offerTermsEn, offerTermsIt, placeOfIssue }`; the four legacy keys are
  accepted and ignored until step 6 (an old crm-ui during the switch push); anything else is still refused.
- `GET /deals/{id}/offer-wizard/context`: gains `issuerAddress: { it: string[], en: string[] }`;
  `issuerLegalName` from the registry; `issuerAddressLines` (Italian) kept until step 6 for an old crm-ui.
- Generation, edit/revise, legacy draft prefill, both preview routes and try-preview — new refusals replacing
  409 `entity_profile_missing`:

| Status | `code` | When |
| --- | --- | --- |
| 409 | `legal_entity_incomplete` + `entity` + `missing[]` | the registry says `complete: false` (AC-6.3, AC-7.3) |
| 503 | `legal_entities_unavailable`, `Retry-After: 5` | the registry cannot be read within decision 7's bounds |

  `layout_service_unavailable` (503) now also covers letterhead-api's `legal_entities_unavailable` and a second
  `legal_entity_version_mismatch`.

## Test strategy

Test levels:

- **A-unit**: auth `bun test`, no DB (rules, IBAN, diff, serializer, `apps` derivation, coverage).
- **A-int**: auth `bun test` against compose Postgres (routes, transactions, trigger, audit, seed, script). Tier 1
  rows cannot be deleted, so these tests run inside a transaction that is rolled back, or on a database created per
  file from a template (R10).
- **B-int**: crm-api `bun test` with a fake registry and a fake letterhead service, plus one contract test against
  real auth in compose.
- **R-unit / R-int**: letterhead-api `cargo test` (engine; HTTP with a fake auth for JWKS, token and registry).
- **CT**: a shared fixture `specs/20261117-legal-entities/fixtures/legal-entities.json` (answers of the read route)
  consumed by the auth serializer test, crm-api's client test and letterhead-api's client test.
- **V-ui**: Vitest in admin-ui, crm-ui, letterheads-ui (axe-core in jsdom, as letterheads-ui already does).
- **E2E**: Playwright in `shell/e2e/` (test-auth users with roles and entity attributes; `axeViolations` of
  `shell/e2e/helpers/meetingsFixtures.ts`; keyboard-only flows).
- **MIG**: the move rehearsed on compose: a crm `entity_profile` fixture set (complete; missing VAT; no row;
  5 address lines; IBAN with spaces and lower case; IBAN with bad check digits; a value with a line break) → dry
  run → apply → re-run; plus the production dry run of release step 3 (a release gate, not CI).

| AC | Level | What proves it |
| --- | --- | --- |
| AC-1.1 | A-int, A-unit | list always has exactly welld_it and welld_ch with every member of `LegalEntity` (address and contacts per language); CHECK refuses a third entity name on insert |
| AC-1.2 | A-unit, A-int, V-ui | each required value empty / only blanks (incl. U+00A0, U+3000) → 422 `required` with its `field`; nothing inserted; IBAN and contacts empty accepted; admin-ui shows the message next to the control (`aria-describedby`) |
| AC-1.3 | A-unit, A-int | boundaries per limit (200/201, 120/121 per line, 4/5 lines, 40/41, 34/35 after spaces, 200/201 per language) in code points (an emoji counts 1); line break in each one-line value and in a line; tab, U+0000, U+007F, U+0085 and a lone surrogate → `control_character`; nothing saved; reason + field in the answer |
| AC-1.4 | A-unit, A-int | `" ch93 0076 2011 6238 5295 7 "` stored `CH9300762011623852957`; one changed digit → `iban_check_digits`; `CH93-…` → `iban_format`; a known valid IBAN per country used by the group (CH, IT) plus 3 reference IBANs accepted; `ibanPrint` groups of four |
| AC-1.5 | A-int, B-int, R-int | save then read (person and service) returns the new version; crm-api and letterhead-api with a fake clock use the new details once their entry is refreshed (see AC-3.3) |
| AC-2.1 | A-int | save with one change → version n+1, `createdBy` = the person, `createdAt` set; identical details (incl. differences only in spaces/case of the IBAN, trailing blanks, a blank address line, NFD vs NFC) → 200 `created: false`, no row, no audit row |
| AC-2.2 | A-int, V-ui | history newest first, every version, number, who (name; "system" for version 1), when, `changedFields` vs the previous version; restore shows the fields that differ from the version it replaced |
| AC-2.3 | A-int, V-ui, E2E | `GET …/versions/{n}` returns all details of n; the version view has no editable control and no save |
| AC-2.4 | A-int, V-ui | restore 2 when 4 is current → version 5 equals 2, versions 3 and 4 unchanged, `restoredFrom: 2`; restore of the current → `created: false`; the UI offers no restore on the current version; restore of an invalid moved version → 422 (D4) |
| AC-2.5 | A-int | each save and restore writes one `audit_log` row in the same transaction (a forced failure after the insert leaves neither): actor, time, `targetId` = entity, before/after for each changed field and only those; the audit-immutability tripwire (`auth/src/authz/audit-immutability.contract.test.ts`) still passes |
| AC-2.6 | A-int, V-ui, E2E | two saves on base n: one 201, the other 409 `version_conflict` + `currentVersion`, table unchanged by the second; the form keeps the typed values and offers to load the newer version; concurrent requests (20 in parallel) leave contiguous versions |
| AC-2.7 | A-int | raw `UPDATE`, `DELETE`, `TRUNCATE` of `legal_entity_version` raise `legal_entity_version_immutable`; no route with PUT/PATCH/DELETE under `/legal-entities` (router table test); a static scan finds no mutating call on `legalEntityVersion` in `auth/src` (the audit tripwire's pattern) |
| AC-3.1 | A-int, E2E | a person with no role at all reads the list and one entity (incl. IBAN); no cookie/token → 401 |
| AC-3.2 | A-int, CT | service JWT with `legal-entities:read` → body byte-equal to the person's; without the scope, a person JWT, wrong audience, expired → the one frozen 401; per-service 429 |
| AC-3.3 | R-unit, B-int (fake monotonic clock) | entry age 29 s used without a call; 31 s refreshed; a save at T: a document started at T+60.001 never uses an entry whose request was sent before T (property test over send/answer times and timeouts); auth answers `no-store` |
| AC-3.4 | A-int | `/legal-entities/welld_de`, `/system/legal-entities/welld_de`, `%00`, 300-char name → 404 `unknown_legal_entity`, identical bodies, name not echoed, no details |
| AC-4.1 | A-int (seed), A-unit, E2E | catalog lists `legal-entity:manage` with `supportedConditions: ["entity"]` under the admin app; role editor saves it conditioned and unconditioned; seed gives `admin` the unconditioned grant, idempotent; `SUITE_APPS` no longer registers `admin` and `admin:access` still exists after the seed |
| AC-4.2 | A-int, E2E | no grant → save/restore 403, nothing written, read still 200; grant conditioned + user entity welld_ch → welld_it 403, welld_ch 201; user entity null + conditioned → 403 on both; unrecognised condition → 403 (fail closed) |
| AC-4.3 | A-unit, A-int, V-ui, E2E | `/authz/me` `apps` gains `admin` only when the grant covers ≥ 1 entity; a welld_ch-only manager (no `admin:access`) sees the Admin tool with only Legal entities, welld_ch editable and welld_it read-only, `/admin/roles` redirects; a person without the grant sees no Admin tool (and an admin without it sees no Legal entities tab); a grant change shows/hides it after the epoch bump |
| AC-5.1 | R-unit, R-int | render v2 for each entity × language: page text contains the registry's legal name, `address[lang]` joined with ", ", VAT, `ibanPrint`, `contacts[lang]`; different it/en address printed per language |
| AC-5.2 | R-int, B-int | v1 with `entityData` "EVIL SA" → printed text has the registry's name, never "EVIL"; v1 with malformed-but-valid-yesterday data accepted; log `entity_data_ignored=true`; crm-api's request body has no `entityData` (schema test on the client) |
| AC-5.3 | R-unit, R-int | registry IBAN "" and contacts "" → placeholders print nothing, `[IBAN: {iban}]` dropped, empty line takes no height, `missingPlaceholders` lists them (existing AC-6.4/6.6 fixtures re-run with registry-sourced data) |
| AC-5.4 | R-unit, R-int, V-ui, E2E | configurator preview shows the real details in the preview language; an empty value prints its label in the `missing` look and its segment is kept; body text still the sample's; `issuerDetails: "unavailable"` renders all placeholders missing and letterheads-ui shows the notice |
| AC-5.5 | R-int (fake auth + clock) | registry down, entry age 59 s → rendered with it; 61 s or no entry → 503 `legal_entities_unavailable` + `Retry-After`, no worker job, no partial body; crm-api maps it to 503 and stores no offer (existing AC-10.6 test path) |
| AC-6.1 | B-int, V-ui, E2E | `GET /entity-profiles` has no legal keys; PUT with only terms/place works; legacy keys ignored (not stored); the settings form has no legal fields and shows the link (managers) or the text (others) to Legal entities |
| AC-6.2 | B-int, E2E | for the classic path (`contractPdf`) and the service path: legal name, address in the document language, VAT, IBAN in every place they print (header, footer, body `[EMITTENTE]`/`[INDIRIZZO]`, snapshot, PDF author) equal the registry's; an English offer prints `address.en`; `legalEntityVersion` mismatch → one retry, never two versions in one PDF |
| AC-6.3 | B-int, V-ui | registry `complete: false` → 409 `legal_entity_incomplete` naming the missing fields on generate, edit/revise, legacy draft and both previews; crm-ui message names them and links to Legal entities |
| AC-6.4 | B-int | offers generated before the switch: stored PDF bytes (hash) and snapshot JSON unchanged after the release and after a registry save; still downloadable |
| AC-7.1 | MIG, A-int | after apply: version 1 of each entity = CRM legal name, VAT, IBAN (electronic form), address lines in both `address.it` and `address.en`, contacts empty |
| AC-7.2 | MIG, A-int | version 1 `action: import`, `createdByUserId: null`, shown as "system"; one `legal_entity.import` audit row per entity with actor null |
| AC-7.3 | MIG, V-ui, B-int | CRM row without VAT (and an absent row) moved with what there is; read says `complete: false` + `missing`; the page marks it incomplete until a complete save; crm-api refuses per AC-6.3 meanwhile |
| AC-7.4 | MIG | second apply: inserted 0, present 2, mismatched 0, no new version and no new audit row; a CRM value changed after the copy → reported mismatched, registry untouched |
| AC-7.5 | MIG, B-int, release gate | golden: for each MIG fixture with complete details, the issuer lines of a classic offer and of a service render before (CRM source) and after (registry source) are equal (contacts line aside); the production dry run reports `ibanPrintChanged` per entity and the owner signs it off (D2) |
| AC-8.1 | V-ui, E2E | axe (WCAG 2.1 A/AA) on the list, the form (clean and with refusals), the history, the version view and the restore dialog: 0 violations; every control has a visible `<label>`; refused save → problems announced (live region + `aria-describedby`) and focus on the first refused control; whole flow (open, edit, save, conflict, history, restore) with the keyboard only |
| AC-8.2 | V-ui | en/it key parity (`admin-ui/src/strings.test.ts`), `noHardcodedStrings` scan, the page in Italian with `<html lang="it">`; the same for the new crm-ui and letterheads-ui strings |

**Coverage check:** 35 ACs in the spec (AC-1.1–1.5, AC-2.1–2.7, AC-3.1–3.4, AC-4.1–4.3, AC-5.1–5.5, AC-6.1–6.4,
AC-7.1–7.5, AC-8.1–8.2); all 35 appear above with at least one test. AC-7.5 relies on D2 being decided; its test
exists either way (it reports, and the gate is the owner's sign-off).

## Risks

| # | Risk | Mitigation / early check |
| --- | --- | --- |
| R1 | **Payment redirection.** Whoever can change an IBAN changes where clients pay, on every document within 60 s. | Per-entity permission, admin-only seed, Tier 1 history, audit before/after, restore. Recommended (owner, out of this spec): a notification to the other managers and administrators when an IBAN changes. Flagged to the security review. |
| R2 | The IBAN prints in a different form than the CRM's text (AC-7.5). | D2 (print in groups of four). Early check: before push 1, read both entities' IBAN in production CRM settings; the copy's dry run reports `ibanPrintChanged`; the owner signs it off before push 2. |
| R3 | CRM values break the new limits (CRM allowed 5 × 200-char lines, VAT 50, IBAN 50 without check). | Kept as they are, reported (`invalid`), marked on the page; consumers print them as before (AC-7.5). D3. |
| R4 | A CRM settings edit between copy and switch is lost. | Announced freeze; the pre-switch dry run reports `mismatched` and blocks step 5 until resolved. |
| R5 | Unordered deploys inside the switch push. | Content v2 fails closed; crm-api tolerates old crm-ui bodies; crm-ui tolerates the old context answer; admin-ui depends only on push 1. Each pairing is a B-int / V-ui test. |
| R6 | auth refuses to start with an unknown scope in `SERVICE_CLIENTS`. | Credentials are set only after push 1 is live (step 2), per `infra/README.md`'s existing rule. letterhead-api's new required variables are set before push 2. |
| R7 | auth becomes a dependency of document making: a 60 s auth outage stops offers and renders. | Owner decision OQ-6. crm-api and letterhead-api already need auth (JWKS, `/authz/resolve`). Logged `registry_stale_used` / `legal_entities_unavailable` make it visible. |
| R8 | Two caches can hold different versions for up to 60 s. | `legalEntityVersion` pin + one retry (decision 8); test in AC-6.2. |
| R9 | Real details are longer than the 40-character fit check: a footer that fit the sample may overflow with a 200-character legal name, so every render of that entity fails (`footer_overflow` → crm-api 409 `letterhead_overflow`). | The configurator preview now uses real details, so the designer sees it (AC-5.4); R-int test with a 200-character name. Not blocked at registry save (it would make auth depend on letterhead-api). |
| R10 | The Tier 1 trigger breaks auth tests that clean tables. | Registry tests use a rolled-back transaction or a per-file database; no existing test touches the new table. Checked by running the whole auth suite in T1. |
| R11 | A non-administrator in admin-ui sees admin sections that 403. | Sections by capability, hidden routes redirect; E2E in AC-4.3. The admin APIs keep `requireAdmin`. |
| R12 | The entity condition limits a grant to the holder's own entity, not to a chosen one (D6). | Matches every entity-scoped permission; the US-4 example works. Owner to confirm. |
| R13 | specs/20261116-letterhead-service is still in progress on the same files (`blocks.ts`, `letterhead-api/*`). | Start the letterhead-api and crm-api tasks after the letterhead branch's open tasks are merged; D1 makes the superseded ACs explicit so its QE does not test against them. |
| R14 | The copy script needs crm database credentials. | Environment only, read-only session, never logged; the ADR 20261110 posture, reviewed then (L4). |

## Security

**Security-sensitive: YES.** The feature adds an authorization rule (entity-scoped permission, a derived app
entry), a service scope and a new service credential, an endpoint that hands a bank account to every signed-in
person and to services, a cross-database copy run with another service's credentials, and — the main threat — a
place where changing one value (the IBAN) redirects payments on every document of the suite (R1). The
orchestrator should schedule the `owasp-reviewer` in parallel with QE and **escalate it to the frontier tier**:
the data is financial (bank details on offers and contracts) and a defect is direct monetary fraud.

Surfaces to review:
- auth `POST /legal-entities/{entity}/versions` and `…/restore`: coverage check (`entityGrantFor`, fail closed on
  unrecognised conditions), CSRF posture of cookie-authenticated POSTs (same as `/admin/*`: CORS allowlist with
  credentials, JSON-only bodies), body bounds, no value echoed, advisory-lock concurrency.
- auth `GET /legal-entities*` (any signed-in person reads the IBAN — owner decision AC-3.1) and
  `GET /system/legal-entities*` (JWT checks, frozen 401, per-service limit, `no-store`).
- auth `GET /authz/me` derived `admin` entry and admin-ui's capability-gated sections: no admin data reachable
  without `requireAdmin`.
- `auth/prisma` trigger and checks; `audit_log` now holds IBAN before/after (Tier 2, admin-only read).
- `auth/scripts/import-crm-legal-details.ts`: credentials in environment only, read-only CRM session, no value
  in output, no overwrite.
- letterhead-api service-token client (secret only in the supervisor, cleared from workers; no redirects;
  nothing logged), registry cache, `entityData` discarded (a caller can no longer choose the issuer printed on
  a document — an anti-forgery gain to confirm), the `legalEntityVersion` check.
- crm-api registry client and the removal of the legal fields from `PUT /entity-profiles`.
- Injection: registry values reach Typst only as data (existing letterhead controls), pdf-lib through `winAnsi`,
  and the CRM offer engine through its escaping (`crm-api/src/offers/engine/vectors/issuer.json` still applies).
- Personal data: the details are a company's (legal person); the contacts line may name a person or a direct
  number — low; no new retention.

## Spec drift — amendments D1–D6 (accepted by the owner 2026-11-17 and applied to spec.md)

- **D1 — Superseded ACs of specs/20261116-letterhead-service are not named.** This spec reverses letterhead
  AC-6.3 ("the values are sent by the caller; the service looks nothing up, keeps nothing"), AC-8.5 ("the sample's
  entity data … the preview never reads … any other tool") and AC-10.10 ("crm-api sends … the entity's profile
  values"), and the letterhead plan's test of AC-1.8 (`contentVersion: 2` refused). That spec is still in
  progress, so its QE/eval would fail this work. *Proposed:* add to this spec's Constraints: "This spec supersedes
  specs/20261116-letterhead-service AC-6.3, AC-8.5 and AC-10.10 (replaced by AC-5.1, AC-5.2, AC-5.4 here)", and a
  note in the letterhead spec pointing here.
- **D2 — How the IBAN prints is not said, and AC-1.4 + AC-7.5 can contradict.** AC-1.4 stores the IBAN without
  spaces; AC-7.5 wants documents unchanged on release day; today the CRM prints whatever text was typed.
  *Proposed:* add to AC-5.1/AC-6.2: "The IBAN prints in groups of four characters (for example
  CH93 0076 2011 6238 5295 7)", and to AC-7.5: "…the IBAN prints as in AC-5.1; the move reports any entity whose
  printed IBAN would differ, and the owner accepts it before the release." The plan assumes this.
- **D3 — The move of values that today's rules refuse is not covered.** AC-7.3 covers only missing required
  details; the CRM accepted 5 address lines of 200 characters, a VAT of 50 and an IBAN of 50 with no check.
  *Proposed:* AC-7.3 "…lacks a required detail **or holds a value AC-1.3 or AC-1.4 refuse**, it is still moved as
  it is; the page marks it until someone saves it correct". The plan assumes this (values kept verbatim,
  reported in `invalid`; the IBAN only loses its spaces and is upper-cased).
- **D4 — A restore of a version that fails today's rules.** AC-2.4 restores any older version; restoring the moved
  version 1 of an incomplete entity would make the current details incomplete again, which AC-1.2 forbids for a
  save. *Proposed:* AC-2.4 "…a restore is refused, as a save would be (AC-1.2–1.4), when that version's details are
  not complete or valid". The plan assumes this.
- **D5 — AC-6.1's link for people who may not see the page.** AC-4.3 hides the page from non-managers, but the
  CRM settings are seen by holders of `deal:financials`. *Proposed:* AC-6.1 "…and point to the Legal entities page
  (a link for those who may manage an entity; for the others, the name of the page and that an administrator
  keeps it)". The plan assumes this.
- **D6 — "Limited to one or both entities" (AC-4.1).** Through roles like every other permission, a conditioned
  grant means the holder's own entity attribute; it cannot name welld_it for a person attributed to welld_ch. Not
  a contradiction (the US-4 example works); stated so the owner confirms it is what they meant.

## ADR candidates

1. **ADR-1:** The legal-entity registry lives in auth as an append-only table of versions (current = highest),
   immutable at the database level — the first Tier 1 table in auth, extending
   `ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level`; read by every signed-in person and by
   services with the scope `legal-entities:read` (naming rule: suite resources hosted by auth carry no service
   prefix and use the colon form).
2. **ADR-2:** Issuer details are read by the letterhead service from the registry, never sent by callers:
   `contentVersion: 2`, `entityData` accepted and ignored in every version, a `legalEntityVersion` pin; and the
   consumers' cache rule (fresh 30 s, usable 60 s when the registry fails, then refuse). Supersedes the "caller
   sends the values" part of the letterhead design (D1).
3. **ADR-3:** An app can be reached through a capability it administers: `/authz/me` derives `admin` into `apps`
   for holders of `legal-entity:manage` over at least one entity, and admin-ui shows its sections by capability.
4. **ADR-4 (or an addendum to ADR 20261110-activities-migration-write-pause):** the CRM's legal details move by
   expand → copy under an announced settings freeze → switch → contract, with the report as the witness and
   version 1 attributed to the system.
