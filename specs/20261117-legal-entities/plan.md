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
   *(Superseded in part — only a pin newer than the held version forces a refresh, at most 1/s and 30 per 10 min
   per process, keeping the held entry as fallback; crm-api waits 1.1 s before its retry: see Sync 2026-11-18, H1.)*
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
| **1. Expand** (push 1) | **auth only** *(amended: + `operai-ui` and `shell`, E10)*: migration (table + trigger), `ADMIN_CATALOG` and seed, read/management/service routes, `legal-entities:read` in `KNOWN_SERVICE_SCOPES`, derived `apps`, import script. No consumer reads the registry; it answers `version: 0` for both entities. | auth `/health` reports the new version; `GET /legal-entities` → both `version: 0`. |
| **2. Credentials** (env, no code) | auth `SERVICE_CLIENTS`: `crm-api` scope += `legal-entities:read`; new entry `letterhead-api` = `{secret, scope:"legal-entities:read"}`. letterhead-api: `SERVICE_CLIENT_ID=letterhead-api`, `SERVICE_CLIENT_SECRET` (old code ignores both). | `mise run env:doctor -- --env production --resolve` green. |
| **3. Copy** (operator) *(stop rule and report categories: E11)* | Announce: no edits to CRM entity settings until step 5 is live. Run `bun run scripts/import-crm-legal-details.ts` (dry run), then `--apply`, then the dry run again. `CRM_DATABASE_URL` and `DATABASE_URL` in the environment only (ADR 20261110 amendment L4). | Report: found 2, inserted 2 (or present 2), mismatched 0; the owner has read the flags (incomplete, invalid, IBAN print changed — D2, D3). |
| **4. Pre-switch check** | Dry run again just before push 2 *(gate amended: E11)*. | present 2, mismatched 0: nobody edited the CRM legal fields since the copy. A mismatch is resolved by a registry save (API, an admin) before going on. |
| **5. Switch** (push 2) *(+ post-switch dry run, E11)* | crm-api, crm-ui, letterhead-api, letterheads-ui, admin-ui together. Order-independent: v2 fails closed against an old letterhead-api; crm-api accepts and ignores the legacy legal keys from an old crm-ui; crm-ui reads `issuerAddress` and falls back to `issuerAddressLines` from an old crm-api; admin-ui only calls auth (already live). The freeze ends when crm-api is live. | Smoke per entity: preview an offer (classic and, where the switch is on, the service) and compare the issuer lines with the day before (AC-7.5). |
| **6. Contract** (a later release) | crm-api migration drops `legalName`, `addressLines`, `vatNumber`, `iban` from `entity_profile`; remove the `issuerAddressLines` compatibility field and the legacy-key tolerance; the import script stays as history *(stop rule restated in E11: it exits once the CRM columns are gone)*. | Step 5 has been live in production; listed in the CHANGELOG as the next step. |

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
re-read, rebuild, retry once *(after a fixed 1.1 s wait: see Sync 2026-11-18, H1)*.

**Render (letterhead-api).** As today, plus: after validation, before the pool, take the entity's details from the
cache (503 `legal_entities_unavailable` per decision 7) → `legalEntityVersion` check (decision 8; *as built: see Sync 2026-11-18, H1*) → the job's
`EntityData` = registry values in the request's language (`address[language]`, `contacts[language]`,
`ibanPrint`) → worker unchanged → answer gains `legalEntityVersion` (preview JSON member; PDF header
`Legal-Entity-Version`) → the one log line gains `legal_entity_version` and `entity_data_ignored`.

**Configurator preview (letterhead-api).** *(Text alternative of a missing value: E3.)* As today, but the sample document's body is kept and its entity data is
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
  "invalid": []                         // [{ field, line?, reason, limit? }] (E6) — only a moved value can be here (D3)
}
```

| Route | Credential | Answer |
| --- | --- | --- |
| `GET /legal-entities` | person (any signed-in) | 200 `{ items: [LegalEntity welld_it, LegalEntity welld_ch] }`; 401 |
| `GET /legal-entities/{entity}` | person | 200 `LegalEntity`; 404 `unknown_legal_entity`; 401 |
| `GET /system/legal-entities` | service JWT, scope `legal-entities:read` | the same 200 body as the person route; one frozen 401; 429 (shared `tooManyRequests`) |
| `GET /system/legal-entities/{entity}` | service JWT, same | same as the person route; 404 `unknown_legal_entity` |
| `GET /legal-entities/manageable` | person | 200 `{ entities: ["welld_ch"] }` (`[]` for none) — consumers and routing: E2 |

### Management (person; `legal-entity:manage` covering at least one entity, else 403 `forbidden`)

| Route | Extra rule | Body → answer |
| --- | --- | --- |
| `GET /legal-entities/{entity}/versions` | any covered entity may read either history (AC-4.3: the other read-only); items gain `restorable` (E1) | `{ items: [{ version, action, restoredFrom, createdBy: {id, name} \| null, createdAt, changedFields }] }`, newest first, every version (AC-2.2) |
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

`field` ∈ the closed set of `changedFields`; `line` (0-based, against the submitted array: E5) for an address line; `reason` ∈ `required`,
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
| 409 | `legal_entity_version_mismatch` + `currentVersion` | `legalEntityVersion` given and not the current one after a refresh *(a refresh only for a newer pin, within a budget; an older or equal pin is 409 at once: see Sync 2026-11-18, H1)* |
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
- *(Amended: `entity_profile_missing` is removed from every document path, E4.)* Generation, edit/revise, legacy draft prefill, both preview routes and try-preview — new refusals replacing
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
| R8 | Two caches can hold different versions for up to 60 s. | `legalEntityVersion` pin + one retry (decision 8); test in AC-6.2. *(Pin rule and the 1.1 s retry wait as built: see Sync 2026-11-18, H1.)* |
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
   sends the values" part of the letterhead design (D1). *(Written; its point 3 "The pin" and point 4 are amended by
   the pin-refresh ADR of 2026-11-18: see Sync 2026-11-18, H1 and H2.)*
3. **ADR-3:** An app can be reached through a capability it administers: `/authz/me` derives `admin` into `apps`
   for holders of `legal-entity:manage` over at least one entity, and admin-ui shows its sections by capability.
4. **ADR-4 (or an addendum to ADR 20261110-activities-migration-write-pause):** the CRM's legal details move by
   expand → copy under an announced settings freeze → switch → contract, with the report as the witness and
   version 1 attributed to the system.

## Amendment 2026-11-17 after design

Source: `design.md` (owner decisions Q1=B one page with entity tabs, Q2=B four address line inputs per language,
Q3=B reapply on conflict; designer's recommendations DR-1 to DR-12, adopted by the owner's non-objection), and
the loose points the ADR writer flagged in the four `docs/adr/20261117-*` ADRs. The plan stays `approved`:
these are owner-accepted design decisions and settlements of points the plan left loose. **No acceptance
criterion changes.** Two findings would change wording of a spec (this one's AC-7.3, and AC-1.8 of
specs/20261116-letterhead-service): they are listed as spec drift D7 and D8 at the end of this block and are
not applied here. Where the body above says otherwise, this block wins; the body carries pointers (E1…E14).

### E1 — Versions list: `restorable` per item (DR-1)

`GET /legal-entities/{entity}/versions` items gain `restorable: boolean`: true when that version's details pass
`rules.ts` **today** (complete and `invalid` empty), the same check the restore route applies (D4). Computed at
read time (the rules can change; a stored flag would go stale), present on every item including the current one
(the UI never offers restoring the current version, AC-2.4). The flag is the page's hint; the guard stays the
422 `invalid_legal_entity` of the restore route.

```jsonc
{ "items": [ { "version": 3, "action": "save", "restoredFrom": null, "createdBy": { "id": "u_…", "name": "…" },
               "createdAt": "…", "changedFields": ["iban"], "restorable": true },
             { "version": 1, "action": "import", "restoredFrom": null, "createdBy": null,
               "createdAt": "…", "changedFields": ["legalName", "address.it", "address.en"], "restorable": false } ] }
```

### E2 — `GET /legal-entities/manageable`: its consumers and its routing (DR-2)

- Consumers: admin-ui (which sections and which entity tabs are editable), crm-ui (S9 Settings note, S10 refusal
  notice) and letterheads-ui (S11 preview source line), each through its own `useCanManageLegalEntity(entity)`
  (one copy per app: apps cannot share a hook through `shell/session`). The hook calls
  `apiFetch(getAuthBaseUrl() + "/legal-entities/manageable")` once per session per app (module-level promise,
  dropped on `onSignOut`), and **fails closed**: any error or a non-200 means "may not manage" (the sentence,
  never the link). The browser never evaluates the `entity` condition (decision 5c).
- Routing: `manageable` is a reserved path segment of the person router, registered **before**
  `/legal-entities/{entity}`; it is not an entity name. `/system/legal-entities/manageable` does not exist and
  answers the frozen 404 `unknown_legal_entity` of AC-3.4. The answer is about the caller only; it names no other
  person.

### E3 — The missing look has a text alternative (DR-4)

The configurator preview's "mark missing" mode (sequence "Configurator preview") prints, for an empty
placeholder, its label between `⟦` (U+27E6) and `⟧` (U+27E7): in the drawing, in the `missing` look, **and** in
the page's `text` (the preview's text alternative, letterhead AC-8.6). The labels are a closed set in the engine:

| Placeholder | it | en |
| --- | --- | --- |
| `legal_name` | Ragione sociale | Legal name |
| `address` | Indirizzo | Address |
| `vat` | Partita IVA | VAT number |
| `iban` | IBAN | IBAN |
| `contacts` | Riga contatti | Contacts line |

Only the configurator preview route sets the mode. The render routes (`/v1/render/preview` and `/pdf`) never do,
so a document never carries `⟦ ⟧` and letterhead AC-1.3 (preview text = PDF text for one request) is untouched.
The engine's non-marking output stays byte-identical (golden corpus unchanged).

### E4 — `entity_profile_missing` is removed from every document path (DR-5)

- crm-api: generation, edit/revise, legacy draft prefill, both preview routes and try-preview never answer
  `entity_profile_missing`. They answer 409 `legal_entity_incomplete` (`entity`, `missing[]`) when the registry
  says `complete: false`, and 503 `legal_entities_unavailable` (`Retry-After: 5`) when it cannot be read within
  decision 7's bounds. `requireIssuerName` and `entityDataOf`'s refusal go.
- A missing CRM profile **row** no longer blocks an offer: the CRM's own values take their existing null meaning
  (place of issue "Lugano", no standard terms, no classic letterhead: a plain page on the classic path).
- The code survives only on the two classic letterhead upload routes (`POST /entity-profiles/{entity}/letterhead`
  and `…/confirm`, already 410 with the switch on), where it still means "the profile row does not exist yet";
  crm-ui's `templates.letterhead.errors.profileMissing` stays with it.
- `GET /deals/{id}/offer-wizard/context` answers 200 whenever the registry is readable, also for an incomplete
  entity (the values as they are; an autosave is never refused), and 503 `legal_entities_unavailable` when it is
  not. Generation and the previews are where incompleteness refuses.
- crm-ui: `offerFailure()` drops `entity_profile_missing` and maps `legal_entity_incomplete` and
  `legal_entities_unavailable`; `useServicePreview`'s `profileMissing` kind becomes `legalEntityIncomplete`;
  strings `settings.notSet` (removed), `offers.errors.profileMissing` and `offerWizard.preview.profileMissing`
  (both occurrences, en and it; replaced by `offerWizard.legalEntity.*` and `LegalEntityNotice`).

Updated crm-api refusal table (replaces the one under "crm-api (changed)"):

| Status | `code` | Routes | When |
| --- | --- | --- | --- |
| 409 | `legal_entity_incomplete` + `entity` + `missing[]` | generate, edit/revise, legacy draft prefill, both previews, try-preview | registry `complete: false` (AC-6.3, AC-7.3) |
| 503 | `legal_entities_unavailable`, `Retry-After: 5` | the above + wizard context | registry unreadable beyond 60 s (AC-5.5) |
| 503 | `layout_service_unavailable` | service path | also letterhead-api's `legal_entities_unavailable` and a second `legal_entity_version_mismatch` |
| 409 | `entity_profile_missing` | classic letterhead upload and confirm **only** | the CRM profile row does not exist |

### E5 — `problems[].line` counts the submitted array (DR-9)

`line` is the 0-based position **in the array the client submitted** for that language, before blank lines are
removed. admin-ui sends its line inputs in order, blanks included (four, or one per stored line for a moved
address longer than four, design S2). Reasons that carry `line`: `too_long`, `line_break`, `control_character` on
an address line. Reasons that carry no `line`: `required` (no non-blank line in that language) and
`too_many_lines` (more than four non-blank lines; `limit: 4`). The strict schema caps each submitted address
array at 16 entries (more is 422 `invalid_request`), so `too_many_lines` covers 5 to 16 and the 16 KiB body
bound is never the first to trip.

### E6 — `invalid[]` items carry `line` and `limit` (DR-10)

`LegalEntity.invalid` items are `{ field, line?, reason, limit? }`, produced by the same `rules.ts` with the same
vocabulary as `problems`. On a read, `line` is the index in the **stored** array (stored arrays hold no blank
line, so it is the line the page shows); `too_many_lines` has no `line` (the page marks the inputs beyond the
fourth). `required` never appears in `invalid` (that is `missing`). The shared fixture
`specs/20261117-legal-entities/fixtures/legal-entities.json` includes an entity with a moved 5-line address and a
121-character line.

### E7 — admin-ui route and the links into it (DR-11)

One route in admin-ui's inner router, `/legal-entities` (shell URL `/admin/legal-entities`), with search params
`entity ∈ {welld_it, welld_ch}`, `view ∈ {details, history}` and `version` (whole number ≥ 1, only with
`view=history`). Any other value is replaced in the URL by the default (`replace`, never echoed): entity = the
first one the person may manage, else `welld_it`; view = `details`; a bad `version` is dropped. A whole-number
version that does not exist shows "This version does not exist" (the API's 404). An unknown entity is **not** a
404 page: AC-3.4 is about the API, which is unchanged. crm-ui and letterheads-ui link with a plain
`<a href="/admin/legal-entities?entity={entity}">`. The hidden-section redirect of decision 5 is unchanged; the
index waits for `manageable` before redirecting a manager-only person.

### E8 — `Tabs` and `TabNav` can wrap, opt-in (DR-12)

`@operai/ui` `Tabs` and `TabNav` gain a `wrap` prop (the list wraps onto further rows instead of scrolling
sideways); the default is unchanged. Chosen opt-in rather than a new default because `@operai/ui` is a singleton
served by the live shell (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell, point 6): a default
change reaches every remote at the next shell deploy, untested by them. The entity tabs and admin-ui's section nav
use `wrap` (WCAG 1.4.10 reflow at 320 px, AC-8.1).

### E9 — Decision: lift `ErrorSummary`, `VersionTable` and `VersionBanner` into `@operai/ui` now

**Chosen:** build the three in `@operai/ui` from the letterheads-ui code (presentational APIs of design.md's
LIFT table; each with a story and a test, no app strings, no fetching), use them in admin-ui now, and leave
letterheads-ui on its own copies until a follow-up change, after specs/20261116-letterhead-service is done,
replaces them with thin adapters. `RestoreDialog` is not lifted (it owns an API call; its confirmation is already
`ConfirmDialog`).

Why: the library rule ("a pattern used by two apps lives in the library — never copy a component from another
app") is met for every new consumer from day one; the letterheads copies become a bounded, listed debt instead of
a second fork growing inside admin-ui. Migrating letterheads-ui inside this spec was rejected: no AC asks for it,
and it would edit `HistoryPanel*.tsx` and `ErrorSummary.tsx` while that spec's QE/eval (its T36) may still fix
them (R13). admin-ui building its own was rejected: about 150 lines copied, against the library rule.
Consequence: the follow-up is listed in tasks.md's notes and in the `@operai/ui` changeset; it is not a task of
this spec (it serves none of its ACs).

### E10 — Release order: the library ships in push 1

`@operai/ui` reaches a remote through the **live shell** (ADR 20261114, point 6: "an added export is used by a
remote only once a shell that has it is live"). Push 2 deploys Vercel projects in no order, so admin-ui (the only
consumer of the three lifted components and of `wrap`) could go live before a shell that exports them and fail in
`RemoteMount`. Therefore:

- **Push 1 = auth + `operai-ui` + `shell`** (the library change is additive: three new exports, one opt-in prop;
  no remote changes). Step 1's gate adds: `https://operai.welld.io/version.json` reports the push-1 version.
- **Push 2** as before; admin-ui in it may rely on the push-1 shell. crm-ui and letterheads-ui use no new export.
- Window note for the runbook: between pushes, a person granted `legal-entity:manage` would see the Admin tool
  (derived `apps`) with the old admin-ui and no section of theirs. The seed grants only the `admin` role, which
  already reaches admin-ui; managers are granted only after push 2.
- The branch delivers two merges to `main`: the push-1 tasks first (tasks.md marks each task's push), the push-2
  tasks after release steps 2–4.

### E11 — The import script: stop rule, report categories, and a post-switch detector

Settles the ADR writer's two flags (the stop rule stated loosely; the freeze window R4).

- **No refusal while the CRM columns exist.** A dry run (default) may run at any time; `--apply` inserts version 1
  only for entities with no version; an apply when both have a version inserts nothing, writes no audit row and
  exits 0 (AC-7.4). The plan's "refuses to run once every entity has a version" is withdrawn: it contradicted the
  dry runs of steps 3 and 4.
- **It stops when the source is gone.** After step 6 drops the CRM columns, the script exits 2 with
  `crm_legal_columns_absent` before reading any row. It never overwrites, never repairs, prints no value.
- **Report categories** per entity: `inserted` · `present` (the CRM row, under the mapping, equals version 1) ·
  `resolved` (it differs from version 1, but equals the **current** registry version on the values the CRM holds:
  `legalName`, `address.it`, `vatNumber`, `iban` — someone carried the CRM edit into the registry) ·
  `mismatched` (differs from both). Plus the flags `incomplete`, `invalid`, `ibanPrintChanged`. Comparing with
  version 1 (not the current one) means later registry saves are not drift; the `resolved` category is needed
  because the plan's step-4 remedy ("resolved by a registry save") could otherwise never turn the gate green.
  `address.en` is not compared (the CRM has one language; an English address saved in the registry is not drift).
- **Gate of steps 3–4:** both entities `inserted`/`present`/`resolved`, `mismatched` 0; the owner has read the
  flags.
- **R4 (freeze window), decided: keep the announcement and add a cheap detector.** New step **5b**: once push 2's
  crm-api is live, run the dry run once more. From then on the CRM's PUT ignores the legal keys, so the columns
  are final; any `mismatched` entity is an edit made between the pre-switch check and the switch, resolved by a
  registry save. Cost: one command, no code; a code-enforced freeze (ADR 20261110's write-pause flag) stays
  rejected for a source edited by two or three people (escalation trigger of the move ADR).

### E12 — v1 requests: `entityData` ignored, confirmed

Both content versions print the registry's issuer; `entityData` is parsed for structure only (AC-5.2, owner
OQ-5), so a v1 request that was valid stays valid. The engine's interface is unchanged (the job still carries
`EntityData`; the supervisor fills it from the registry), so letterhead's golden corpus and pinning tests stay
byte-identical. Consequence outside this spec: specs/20261116-letterhead-service AC-1.8 promises that a request
of a supported version "renders after the upgrade with the same pages"; for the issuer's details it no longer
does (on release day the IBAN regroups, D2; after any registry save the name or address may differ). Reported
as spec drift **D7**; not applied.

### E13 — "Incomplete" and "Needs correction" (DR-6)

The page marks a moved entity **Incomplete** when a required value is missing (blocks offers, AC-6.3) and
**Needs correction** when it only holds values today's rules refuse (blocks nothing; prints as moved, AC-7.5).
The plan's AC-7.3 test asserts both marks and that only the first makes crm-api refuse. Whether "Needs
correction" satisfies AC-7.3's "marks it incomplete" is the owner's reading: spec drift **D8**; not applied.

### E14 — Smaller precisions

- crm-api's registry client uses the existing `SERVICE_CLIENT_ID`/`SECRET` pair; without it (no `serviceTokens`),
  every registry read fails closed (503 `legal_entities_unavailable`) and one warning is logged at startup. No
  change to crm-api's env contract (every environment with a letterhead/notify URL already has the pair).
- The shared engine copies (`crm-api/src/offers/engine/**` ⇄ `crm-ui/src/lib/offerEngine/**`) are not changed:
  crm-api fills `WizardContext.issuerAddressLines` with `address[language]`, and crm-ui does the same from the
  context's new `issuerAddress`.
- `.railway/railway.ts` needs no change: no new service, domain or bucket, and the project's variables are not
  managed by it (`variables: { managed: false }`). The new variables are set in Railway (step 2) and checked by
  env-doctor; `railway config plan` must still show no drift at each push.

### Test strategy deltas

| AC | Added to "What proves it" |
| --- | --- |
| AC-1.3 | `line` is the submitted position (blank line at 1, over-long line at 2 → `line: 2`); `required`/`too_many_lines` have no `line`; 17 lines → `invalid_request` (E5) |
| AC-2.4 | versions list: moved incomplete or invalid v1 → `restorable: false`, a complete version → `true`; restore still 422 for it (E1) |
| AC-4.3 | `/admin/legal-entities?entity=welld_ch&view=history` deep link; `?entity=welld_de` → default tab, value not echoed; manager-only lands on Legal entities (E7) |
| AC-5.4 | the configurator preview's page `text` holds `⟦IBAN⟧` for an empty IBAN; a render route's text never holds `⟦` (E3) |
| AC-6.1 | the Settings link is `/admin/legal-entities?entity={entity}`; `manageable` failing → the sentence, no link (E2, E7) |
| AC-6.3 | no document route answers `entity_profile_missing`; a missing profile row still generates; the letterhead upload still answers it (E4) |
| AC-7.3 | Incomplete vs Needs correction marks; only Incomplete refuses in crm-api (E13) |
| AC-7.4 | apply on a fully moved registry: inserted 0, exit 0, no audit row; `resolved` after a registry save that carries a CRM edit; `crm_legal_columns_absent` once the columns are dropped (E11) |
| AC-7.5 | the post-switch dry run (step 5b) reports `mismatched` 0 (E11) |
| AC-8.1 | entity strip at 320 px wraps (no horizontal scroll), with `wrap` (E8) |

### Spec drift found (reported, not applied)

- **D7 — letterhead AC-1.8 vs this spec's AC-5.2.** specs/20261116 AC-1.8: "a request of a version the service
  supported before an upgrade renders after the upgrade with the same pages". With AC-5.2 a v1 request's
  `entityData` no longer decides the issuer, so its pages can change. *Proposed:* extend this spec's D1 constraint
  with "…and AC-1.8's 'same pages' does not extend to the issuer's details, which are the registry's (AC-5.2)",
  plus a note on AC-1.8 in the letterhead spec. Affects that spec's open QE/eval (its T36); nothing in this plan
  changes either way.
- **D8 — AC-7.3's word "incomplete".** The design separates Incomplete (missing a required value; AC-6.3 refuses)
  from Needs correction (out-of-rule moved values; nothing refuses). *Proposed:* AC-7.3 "…the Legal entities page
  marks it incomplete, or in need of correction when only AC-1.3/AC-1.4 refuse its values, until someone saves it
  complete and valid; AC-6.3 applies to it meanwhile". If the owner prefers the literal reading, the page shows
  "Incomplete" for both and only the badge wording changes (design S1).

## Amendment 2026-11-17 after security review

> Approved by the owner on 2026-11-17 together with tasks T51–T71; readings confirmed: push text English only, a 422 refusal comes before the confirmation, "administrator" = effective admin, notice time in Europe/Zurich.

Source: `security-review.md` (T46: F1 medium, F2–F7 low), the spec's **US-9 (AC-9.1–AC-9.17)**, owner-approved
2026-11-17 as the answer to F1, the owner's decision of the same day to **fix every low finding (F2–F7) in this
feature**, the follow-ups FU-1–FU-10 of `tasks.md`, defect D1 (`62babb4e`), and the owner's decision that **push 1 is
released together with push 2 at the end**. The plan stays `approved`: US-9 is an owner-approved spec change and the
rest settles findings; nothing here changes an acceptance criterion. Where the body or the first amendment says
otherwise, this block wins. Items are numbered G1…G16 so tasks can cite them.

### G1 — US-9 in one picture

```
 admin-ui form ── Save ──► POST /legal-entities/{e}/versions/check ─► 200 { protectedChanges[] } (writes nothing)
     │                         (same rules.ts, same authorisation as the save)
     │  protectedChanges ≠ [] → ProtectedChangeDialog (Old / New, Cancel focused) ── Cancel → nothing sent
     │  Confirm (or no protected change) ──────────────────────────────────────────────────────────┐
     ▼                                                                                               ▼
 restore dialog (lists protected Old/New from the two          POST …/versions  |  POST …/versions/{n}/restore
 versions the page reads)                                                  │
                                                     ┌─────────────────────┴───────────────────────────┐
                                                     │ ONE transaction (withAudit, entity advisory lock) │
                                                     │  insert legal_entity_version n                    │
                                                     │  audit legal_entity.save|restore                   │
                                                     │  protected change? → recipients NOW →              │
                                                     │    insert legal_entity_notice rows (pending)       │
                                                     │    (none at all → audit legal_entity.notice_no_recipients)
                                                     └─────────────────────┬───────────────────────────┘
                              after commit: kick ──► NoticeDispatcher (in auth; also a 15 s sweep, every replica)
                                                     claim rows FOR UPDATE SKIP LOCKED (lease 60 s)
                                                     │ in_app  → notify-api POST /system/notifications
                                                     │           { recipientId, originApp:"admin", en + it, link, idempotencyKey }
                                                     │           → notification centre (SSE) + web push (notify-api's own)
                                                     │ email   → notify-api POST /system/emails
                                                     │           { template:"legal_entity_change", recipientId | to, data, idempotencyKey }
                                                     ▼
                                       delivered | retry (+1, +3, +5, +10, +20, then every 30 min) | given up at 24 h
                                       audit: notice_failed (first) · notice_delivered (after a failure) · notice_given_up
```

Why this shape (and what was rejected):

1. **Durable duty: an outbox table written in the version's transaction** (AC-9.14 "the duty to send is kept
   together with the version"). Rejected: the suite's usual fire-and-forget after commit
   (`signup/notifyAdmins.ts`, ADR 20260716 §4, ADR 20261105): a restart between commit and send loses the notice, and
   there is no retry. Rejected: a queue service (none exists in the suite; a new dependency for one notice).
   Consequence, stated honestly: if auth cannot write the duty (its own database fails while computing recipients
   or inserting the rows), the save fails as any database error would (500, nothing stored). That is not a
   *delivery* failure, which AC-9.14 covers; it is the price of "kept together with the version". A notify-api
   failure never reaches the save: no notify-api call happens inside the request.
2. **Recipients are computed inside the transaction, only for a protected change** (AC-9.8 "at the moment the
   version is stored"). Rejected: computing them at send time (a role removal between store and send would silence
   a recipient — the very attack AC-9.10 guards against). Non-protected saves pay nothing.
3. **Receiver-side idempotency in notify-api** (AC-9.14 "no recipient gets two notices on the same channel for the
   same version, retries included"). A timeout after notify-api committed is ambiguous; only the receiver can make
   the retry safe. Key = `legal-entity-notice:<outbox row id>` (no value in it), scoped per calling service. For
   email the same key is passed to Resend as its `Idempotency-Key` (Resend keeps keys 24 h, the same window as the
   retries). Rejected: accepting rare duplicates (contradicts AC-9.14); deduplicating in auth only (cannot see an
   ambiguous outcome).
4. **Two channels as two outbox rows, two notify-api calls** (AC-9.14 "a failure for one recipient or one channel
   does not stop or delay the others"). Rejected: `/system/notifications` with `email: true` (ADR 20261105's shape):
   one call carries both channels, so a failed email can only be retried by repeating the in-app call, and its
   `skipped` hides the reason.
5. **The email is a closed, typed template `legal_entity_change` in notify-api, bound to `system:auth`**, addressed
   by `recipientId` for a person (notify-api resolves the address from auth, ADR 20261101 — auth still puts no
   person's address in a request) and by `to` for the one outside mailbox (AC-9.10; it has no user id). The typed
   `data` cannot carry a value beyond an IBAN's last 4 characters (`^[A-Z0-9]{4}$`), so AC-9.12 is enforced by the
   receiver too. Rejected: a generic "caller-supplied text" email template (any `emails.send` holder could then mail
   arbitrary text from wellD's domain — a phishing surface); auth sending persons' addresses (against ADR 20261101
   and 20261105).
6. **The in-app notice carries `en` and `it`** (`it` variant, ADR 20261104); the reader's language picks it
   (AC-9.13). The email is English for everyone (AC-9.13). The copy of both lives with its sender: in-app texts in
   auth's catalog `auth/src/legalEntities/notices/copy.ts` (en/it parity test), the email in notify-api's template;
   the designer writes both (G13, design TODO).
7. **The confirmation is admin-ui's, backed by a read-only server check** (AC-9.1 "as they would be stored",
   AC-9.5 "IBAN typed with other spacing or case only" asks nothing). Plan decision 10 keeps the rules in auth only,
   so the page does not mirror the normalisation: it asks auth. Rejected: a client copy of NFC/trim/IBAN
   normalisation (two rule sets that can drift; a drift would ask for a spacing-only IBAN change, breaking AC-9.5, or
   skip a real one); a `confirmation_required` refusal of the save itself (that is "a confirmation enforced by the
   registry", a Non-goal — direct callers are covered by the notice only, OQ-13).
8. **Origin `admin`, no new scope.** `system:auth` already holds `emails.send` and `notifications.push` and is bound
   to origin `admin` (ADR 20261105). ADR 20261105's escalation trigger ("auth raising a second kind of notice")
   fires: recorded as ADR candidate 5 (an amendment), not a silent widening.

### G2 — Protected change, computed once

`rules.ts` gains `PROTECTED_FIELDS = ["legalName","vatNumber","iban"]` and `protectedChanged(changedFields)`. A
protected change is `changedFields ∩ PROTECTED_FIELDS ≠ ∅`, where `changedFields` is what the save already stores
(after normalisation: NFC, trim, IBAN without whitespace and upper-cased), so "filling an empty value and emptying a
filled one count; a different spacing or case of the same IBAN does not" holds by construction. A restore's
`changedFields` is against the version it replaced (the spec's "version before it"). The import (`import.ts`,
action `import`) never calls the notice code and the outbox has a CHECK that excludes it (G4): AC-9.16.

### G3 — Recipients (AC-9.8–AC-9.10)

Computed in the version's transaction, only for a protected change:

- **managers of the entity**: active users (`deletedAt IS NULL`) holding a rule for `legal-entity:manage` through a
  role or a department role (the candidate narrowing of `authz/holders.routes.ts`), confirmed per candidate by
  `resolveEffectivePermissions` + `coveredEntities` ∋ entity (conditioned grants cover the holder's own entity only,
  D6; a welld_it-only holder gets nothing for welld_ch);
- **administrators**: `getEffectiveAdminUserIds` (the `admin` role directly or through a department, active users
  only — the suite's definition, `admin/lastAdminGuard.ts`), whether or not they hold the permission;
- **the actor** (AC-9.9), as a receipt;
- de-duplicated by user id → per person one `in_app` row and one `email` row (`@@unique` makes a second impossible);
- **the outside mailbox** `LEGAL_ENTITY_NOTICE_EMAIL` (auth env, optional, one address for both entities, AC-9.10):
  when set at that moment, one `email` row with `recipient = "outside"`; when unset, no row and nothing else changes;
- no person and no outside row → audit `legal_entity.notice_no_recipients` in the same transaction (AC-9.15; in
  practice unreachable, since the actor is always a recipient, but required and tested with an injected empty set).

Reading R-c (not drift): "administrator" = effective admin as above, the same set that receives access-request
notices.

### G4 — Data model

**auth — Prisma migration `…_legal_entity_notices` (push 2, additive)**

```prisma
/// The duty to tell people about one protected change (specs/20261117-legal-entities US-9). One row per
/// (version, recipient, channel), written in the transaction that stores the version. Tier 2 (status changes);
/// it holds NO value of any detail (AC-9.12): content is rebuilt from the immutable versions at send time.
model LegalEntityNotice {
  id            String    @id @default(cuid())
  entity        String
  version       Int
  recipient     String    // a user id, or "outside"
  recipientKind String    // 'person' | 'outside'
  channel       String    // 'in_app' | 'email'
  status        String    @default("pending")   // 'pending' | 'delivered' | 'given_up'
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now())
  leaseUntil    DateTime?
  lastReason    String?   // closed set below
  firstFailedAt DateTime?
  deliveredAt   DateTime?
  givenUpAt     DateTime?
  createdAt     DateTime  @default(now())        // = the version's transaction time (Postgres now())

  @@unique([entity, version, recipient, channel])
  @@index([status, nextAttemptAt])
  @@map("legal_entity_notice")
}
```

Hand-appended SQL: FK `(entity, version)` → `legal_entity_version` (`ON DELETE RESTRICT`); CHECKs `recipientKind IN
('person','outside')`, `channel IN ('in_app','email')`, `status IN ('pending','delivered','given_up')`,
`(recipientKind = 'outside') = (recipient = 'outside')`, `recipientKind <> 'outside' OR channel = 'email'`, and a
trigger-free guard that the referenced version is not an import: `legal_entity_notice_not_import` is enforced in
code and by a test (a CHECK cannot see the other table; a trigger for it is not worth a second Tier 1 surface).
`lastReason` closed set: `notify_unreachable` (network, timeout), `notify_refused` (4xx after the 401 retry),
`notify_error` (5xx), `recipient_inactive`, `email_not_configured` (notify-api's email group or Resend unset),
`outside_address_unset` (unset between store and send), `recipient_deleted` (deleted between store and send: given up
at once, never sent — the spirit of AC-9.8), `expired` (never attempted within 24 h). No cleanup job: a few rows per
protected change.

New `audit_log` actions (Tier 2; `targetType: "legal_entity"`, `targetId: <entity>`, `actorUserId: null`):
`legal_entity.notice_failed` (first failure of a row), `legal_entity.notice_delivered` (success of a row that had
failed), `legal_entity.notice_given_up`, `legal_entity.notice_no_recipients`. `data: { version, recipient:
"person"|"outside", userId?, channel, reason?, at }` — never a value, never the outside address.

**notify-api — Prisma migration `…_system_idempotency` (push 1, additive)**

- `Notification` += `callerSub String?`, `idempotencyKey String?`; partial unique index `(callerSub, idempotencyKey)
  WHERE idempotencyKey IS NOT NULL`.
- `EmailDelivery` += `callerSub String?`, `idempotencyKey String?`; index `(callerSub, idempotencyKey)` (several
  failed attempts may share a key; at most one `sent`). *(As built, "at most one `sent`" is a partial unique index
  `WHERE idempotencyKey IS NOT NULL AND status = 'sent'`, plus a CHECK on both tables that a key never exists without
  its caller: see Sync 2026-11-18, H3.)*

**auth env** (`lib/env.ts`): `LEGAL_ENTITY_NOTICE_EMAIL` (optional, an email address; unset = no outside
recipient), `LEGAL_ENTITY_WRITE_RATE_LIMIT` (default 10), `LEGAL_ENTITY_CHECK_RATE_LIMIT` (default 60),
`LEGAL_ENTITY_RATE_WINDOW_MS` (default 600000) — the suite's `*_RATE_LIMIT` convention (G9).

### G5 — API contracts (new and changed)

**auth `POST /legal-entities/{entity}/versions/check`** (push 1; person; read-only; G1.7)

Body: exactly the save's `{ baseVersion, details }`. Same order of refusals as the save (401, 403, 404, 403, 413,
422 `invalid_request`, 422 `invalid_legal_entity`), then 409 `legal_entity_not_moved`, 409 `version_conflict` +
`currentVersion` when `baseVersion` is not current, 429 `too_many_requests` (its own per-person limiter, G9).
*(As built, the 429 comes right after the authorisation refusals and before 413: see Sync 2026-11-18, H4.)* No
lock, no transaction, no row, no audit row, `Cache-Control: no-store`.

```jsonc
// 200
{ "baseVersion": 7, "outcome": "change",               // "same" when the save would be a no-op (AC-2.1)
  "changedFields": ["iban", "contacts.en"],
  "protectedChanges": [                                  // only legalName / vatNumber / iban, closed-set order
    { "field": "iban", "before": "CH93 0076 2011 6238 5295 7", "after": "" }   // as stored; IBAN in print form; "" = empty
  ] }
```

The values are those a manager can already read (AC-3.1); nothing the request sent is echoed in a refusal. A
`POST …/versions` does **not** require a prior check (Non-goal, OQ-13); the notice covers direct callers.

**auth `GET /legal-entities/{entity}/versions`** (push 1, F3): query `limit` (1–100, default 50) and `before` (a
version number; items with `version < before`), newest first; answer gains `nextBefore: number | null`. Any other
query member or a bad value → 422 `invalid_request` (after the 403s; nothing echoed). AC-2.2's "every version" is
the union of the pages; the page asks for the next one (G11).

**auth save, restore, check: 429** (F3): `too_many_requests` (the suite's `tooManyRequests` body, `Retry-After`),
counted per user id after authorisation and before the body is read; save and restore share one window, the check
has its own. *(`Retry-After` is exposed over CORS, T74: see Sync 2026-11-18, H4.)*

**auth save, restore, check, history, version view, `manageable`: a deleted user** (F2) → 403 `forbidden` (the
constant body); `manageable` answers `{ entities: [] }`; person reads `GET /legal-entities[/{entity}]` → 401.

**notify-api `POST /system/notifications`** (push 1): optional `idempotencyKey` (1–200 chars,
`^[A-Za-z0-9._:-]+$`). First call: 201 as today. A repeat with the same calling `sub` and key: **200** with the stored
notification; nothing is published, pushed or mailed. A concurrent repeat losing the unique race reads the winner
and answers 200.

**notify-api `POST /system/emails`** (push 1): optional `idempotencyKey` (same rule); a repeat after a `sent` attempt
→ 200 with the same `deliveryId`, nothing sent *(answered before the address lookup: see Sync 2026-11-18, H3)*; after only
`failed` attempts → a new attempt. Template
**`legal_entity_change`**: bound to `system:auth` only (another caller → 403 `template_not_allowed`, nothing
written); exactly one of `to` | `recipientId`, and `recipientId` is accepted **only** for this template (no other
caller gains "mail any user by id"; *as built, `recipientId` on another template is 400 `recipient_id_not_allowed`:
see Sync 2026-11-18, H3*). With `recipientId`: inactive user → 200 `{ status: "skipped", reason:
"recipient_inactive" }`; contact lookup failed → `{ status: "failed", reason: "contact_lookup_failed" }`; email group
unset → `{ status: "skipped", reason: "not_configured" }`. Response `status` gains `skipped` and an optional closed
`reason`.

```jsonc
// data of "legal_entity_change" (strict; every member required unless marked)
{ "entity": "welld_ch",                                 // closed: welld_it | welld_ch
  "action": "save", "restoredFrom": null,               // "restore" + the restored version number
  "actorName": "Anna Rossi",                            // ≤ 200, controls/bidi stripped by the sender, escaped by the template
  "storedAt": "2026-11-17T09:12:00.000Z",               // rendered in Europe/Zurich with its zone name (R-d)
  "version": 8,
  "protectedChanged": ["iban"],                          // ⊂ legalName | vatNumber | iban, ≥ 1, unique
  "otherChanged": ["contacts.en"],                       // ⊂ address.it | address.en | contacts.it | contacts.en
  "iban": { "old": { "state": "tail", "last4": "5957" }, "new": { "state": "none" } } }   // present iff "iban" changed;
                                                         // state: none | set (≤ 8 chars) | tail (last4 ^[A-Z0-9]{4}$)
```

*(D9: `actorName` is replaced by `actorEmail`, the author's account email captured when the version was stored, or
null; no display name anywhere in a notice: see Amendment 2026-11-18 — D9, J3–J4.)*

The link is built by notify-api from its `APP_BASE_URL` and the closed entity:
`/admin/legal-entities?entity=<entity>&view=history` (E7). Resend receives `Idempotency-Key: <sub>:<key>`
(SDK option if 6.17 has it, else the raw header; the task verifies which). *(Settled: the SDK option, resend 6.17.2:
see Sync 2026-11-18, H3.)*

**auth → notify-api, the in-app call**: `{ recipientId, originApp: "admin", severity: "warning", title, body,
it: { title, body }, link: { href: "/admin/legal-entities?entity=<e>&view=history" }, idempotencyKey }` (no
`email`). Titles ≤ 200, bodies ≤ 2000 (asserted for the longest case: three protected and four other names, a
200-character actor name).

### G6 — The dispatcher (auth, `auth/src/legalEntities/notices/dispatcher.ts`)

- Started in `src/index.ts` when the server starts, never under `bun test` (`NODE_ENV === "test"`), timer `unref()`;
  tests build it with an injected clock and notify client.
- **Kick** after the save's transaction commits (`void dispatcher.kick()`; never awaited by the request, so the
  answer is the same whatever notify-api does — AC-9.14). **Sweep** every 15 s on every replica: claim up to 25 due
  rows (`status='pending' AND nextAttemptAt <= now() AND (leaseUntil IS NULL OR leaseUntil < now())`, `FOR UPDATE
  SKIP LOCKED`, set `leaseUntil = now()+60 s`, `attempts += 1`). AC-9.7's 60 s: the kick hands over at once; a lost
  kick is covered by the next sweep (≤ 15 s); a restart sweeps on start (AC-9.14 durability).
- Each claimed row is sent on its own (concurrency 4, timeout 5 s per call, the 401-retry-once of `lib/notify.ts`).
  Content is rebuilt from versions n and n−1 (immutable, so a retry sends the same text). Before sending to a person
  the row's user is re-read: deleted → `given_up` `recipient_deleted`.
- Outcome, written in one transaction with its audit row: delivered → `status='delivered'` (+ `notice_delivered`
  when `firstFailedAt` is set); failure → first time `firstFailedAt` + `notice_failed`; if `now ≥ createdAt + 24 h`
  → `given_up` + `notice_given_up`, else `nextAttemptAt = min(now + delay(attempts), createdAt + 24 h)` with delays
  1, 3, 5, 10, 20 min, then 30 min (first retry within 5 minutes: AC-9.14). A pending row found past 24 h with no
  attempt → `given_up` `expired` (+ `notice_failed` and `notice_given_up`).
- A notify answer of `skipped` (inactive, not configured) is a failure with its reason (AC-9.14 "a recipient has no
  usable email address") and is retried like any other, except `recipient_deleted`.
- Logs: `legal_entity_notice_{delivered,failed,given_up}` with row id, entity, version, channel, reason; once per
  sweep, `legal_entity_notice_overdue` with the count of rows pending for more than 5 minutes. Never a name, address
  or value.

### G7 — admin-ui: where the confirmation lives

- **Save** (`LegalEntityForm`): Save → `checkSave()` (busy "Checking…") → 422/409/403/5xx/429 handled exactly as a
  save's refusal (no dialog) → `protectedChanges = []` → `POST …/versions` as today (AC-9.5) → otherwise the new
  **`ProtectedChangeDialog`** (built on `ConfirmDialog`, no acknowledge checkbox — with a field the library would not
  focus Cancel; AC-9.1) → Cancel / Escape / close: nothing sent, values kept, focus back on Save (AC-9.2, 9.6) →
  Confirm: `POST …/versions` with the same body; its answer takes the existing paths (saved, no-op, refused,
  conflict, 403, failed); the dialog closes first *(superseded: the dialog stays open and busy until the save's
  answer, sends the checked body, and is mounted beside the form, never inside it: see Sync 2026-11-18, H5)*. A
  confirmation is never remembered: every Save checks again (AC-9.3). A failed check (network, 5xx, 404 during push skew) → "could not check" banner + Retry, nothing saved
  (fail closed: without the check the page cannot know whether to ask).
- **Restore** (`RestoreDialog`): on open it reads version n when the page does not hold it (loading state), and
  lists, under "Old" (current) / "New" (version n), each protected detail that differs, from the two `LegalEntity`
  answers (`ibanPrint` for the IBAN); none differ → the dialog is as before (AC-9.4). Version n cannot be read →
  Confirm unavailable with the reason + Retry *(built as an `aria-disabled` Confirm with a described reason, T73:
  see Sync 2026-11-18, H5)*.
- One presentational **`ProtectedChangeList`** renders the list in both dialogs: a `<dl>`/table per detail with the
  visible labels "Old"/"New", the empty value as the word "None" (never blank), legal name and VAT in full, IBAN in
  groups of four, `lang` not set on values (they are not prose).
- **Reading R-b (not drift):** a save the rules refuse (422) is refused before any confirmation, as the check
  answers 422 — the confirmation is for a change that could be stored; AC-9.3 covers refusals that happen after it
  (a conflict or a lost grant in between).
- design.md needs a small amendment (G13).

### G8 — F2: a deleted person loses the registry at once (decided: fix as proposed, wider)

One helper `activeUserProfile(userId)` in `auth/src/legalEntities/coverage.ts` returns `{ entity }` or null for a
missing **or soft-deleted** user; used by the write `authorize`, the history/version guard, `manageable`, the check
route, and the person reads (401). Recipients exclude deleted users (G3). `/authz/me` is not changed (outside this
feature; its `apps` derivation would hide the Admin tool but the routes already refuse). Rejected: disabling
better-auth's cookie cache (suite-wide session cost for one route group).

### G9 — F3: throttle and paging (decided: fix as proposed)

`createSlidingWindowRateLimiter` per process, keyed by user id: save + restore share `LEGAL_ENTITY_WRITE_RATE_LIMIT`
(10) per `LEGAL_ENTITY_RATE_WINDOW_MS` (10 min); the check has `LEGAL_ENTITY_CHECK_RATE_LIMIT` (60). The limiter also
bounds the notice volume an abused session can cause (10 protected changes × recipients per 10 minutes) and the
save-then-restore flip-flop of F1. In-memory per replica (N replicas = N × the limit), as every auth limiter;
accepted. compose sets a high limit only for the e2e stack. History paging as G5; admin-ui pages it (G11). Keep the
16 KiB cap.

### G10 — F4, F5, F6, F7 (decided)

- **F4 (fix as proposed).** The "real transactions" group of `write.routes.test.ts` runs only when the host of
  `DATABASE_URL` is `localhost`, `127.0.0.1`, `::1`, `host.docker.internal` or the compose service name (`postgres`),
  and never for `*.railway.internal` / `*.rlwy.net`; otherwise it is skipped with one loud line. `testDb.ts`'s header
  states the exception. Any new committed-transaction test (the dispatcher's, G6) uses the same guard *(applied to
  `notices/duty.test.ts` by T75: see Sync 2026-11-18, H4)*.
- **F5 (fix all three).** (1) devops: the runbook creates a `SELECT`-only role on `entity_profile`'s legal columns,
  `updatedAt` and `updatedBy` in the `crm` database for the copy window, `CRM_DATABASE_URL` set by hand to it, the
  role dropped afterwards (T18 uses it). (2) the import audit row's `source` gains `updatedBy` (a person id). (3) the
  report prints each entity's IBAN tail by the same rule as a notice (`none` / `set` / `…1234`, one shared function
  `ibanTail` in `auth/src/legalEntities/ibanTail.ts`), in the dry run and the apply; `infra/README.md` says so. Still
  no other value.
- **F6 (fix as proposed).** letterhead-api coalesces forced refreshes: at most one per second per process; a
  mismatching pin with an entry fetched less than a second ago answers 409 `legal_entity_version_mismatch` at once,
  without calling auth. A matching pin still costs nothing. *(Superseded by T64 + T76 + T77: a pin at or below the held
  version is 409 with no registry call; only a newer pin forces a refresh, at most 1/s and 30 per 10 minutes per
  process (T77), keeping the held entry as fallback; crm-api waits 1.1 s before its single retry, T72. See Sync
  2026-11-18, H1.)*
- **F7 (decided: the page, not the row).** `AuditPage` derives the Before/After panes from `data.changes` when
  `data.before`/`data.after` are absent (`{ field: before }` / `{ field: after }`, value names as stored keys); the
  notice actions show their `data` as today's panes would (no values in them). Rejected: also writing `before`/
  `after` into the audit row (duplicates every value in Tier 2 storage and touches the contended `write.routes.ts`).
  The IBAN stays visible on this administrator-only page (as the review says).

### G11 — admin-ui history paging (F3)

`LegalEntityHistory` asks for the first page and shows "Show older versions" while `nextBefore` is not null
(appends; focus stays on the button, then moves to the first new row's Open); loading and failure states
(design TODO). The version view still reads one version; "The current version is m" is unchanged.

### G12 — D1 (TrieRouter) and the new routes

It matters only as a constraint: SmartRouter picks one router for the whole app, and any route RegExpRouter cannot
take flips every route to TrieRouter. The two agree on valid patterns, so behaviour is the same; what bit D1 was an
invalid pattern (`"/**"`). Rules for this amendment: new routes use `router.on(METHOD, exactPath, …)` (no `use` on a
wildcard, no `"/**"`); the check route `POST /legal-entities/:entity/versions/check` shares no pattern with a GET
guard (the `/versions/:n` guards are GET-only); `auth.mount.test.ts` gains a probe for it and `routerTable.test.ts`
accepts exactly three POSTs. No performance concern at auth's route count.

### G13 — design.md amendment (designer, small)

Required, because design.md says "no confirmation step on an IBAN change" and lists it as scope creep. The designer
adds (inline TODO in design.md, task T51): S12 the protected-change confirmation (states and copy keys), the S7
restore additions, the S5 "Show older versions" states, the 429 state, the notice copy (in-app en/it, email en),
and the copy owed by FU-1, FU-4, FU-7 and FU-9. *(S12's busy state as built differs from the design's wording:
see Sync 2026-11-18, H5.)*

### G14 — Follow-ups FU-1…FU-10

| FU | Decision | Task |
| --- | --- | --- |
| FU-1 crm-ui overflow copy points at CRM Settings | fix (copy from T51; link for managers, sentence otherwise, as `LegalEntityNotice`) | T63 |
| FU-2 classic `GenerateOfferDialog`/`OffersCard` show no link for `legal_entity_incomplete` | fix (render `LegalEntityNotice`) | T63 |
| FU-3 `wrap` vs 320 px reflow | no code: verified in the widened T40 sweep at 320 px and by QE | T40, T45 |
| FU-4 `toCorrect.title` copy invented | designer confirms or replaces | T51 (applied in T40) |
| FU-5 configurator mark drawn by a runtime template patch | no code: ADR candidate 8 *(written: Sync 2026-11-18, H2)* | — |
| FU-6 `DOCUMENTED_CLIENT_SCOPES["crm-api"]` omits `letterhead:render` | fix | T53 |
| FU-7 admin-ui string gaps | fix (owner: T40 widened, copy from T51) | T40 |
| FU-8 2 failing tests in `LegalEntitiesPage.test.tsx` | fix (owner: T40 widened) | T40 |
| FU-9 sample intro still says "(SAMPLE)" company data | fix (copy from T51) | T65 |
| FU-10 letterheads-ui reads `getAuthBaseUrl` through a cast | fix (typing only) | T66 |

### G15 — Release order (amends E10 and the table above)

Owner decision 2026-11-17: **push 1 is no longer released early; both pushes go out at the end, in one release
session**, still as two pushes because the copy (step 3) needs push-1 auth live and push-2 consumers need the copy:
QE PASS (T45) and the security re-review (T70) first → **push 1** (T16: auth, `@operai/ui`, shell, **notify-api**)
→ step 2 credentials (T17) → step 3 copy (T18) → step 4 → **push 2** (T48: crm-api, crm-ui, letterhead-api,
letterheads-ui, admin-ui, **auth (US-9 notices)**) → step 5 smoke and 5b (T49) → **step 7 (new, T71)**: set
`LEGAL_ENTITY_NOTICE_EMAIL` and confirm the notice path in production; only after it may `legal-entity:manage` be
granted to anyone but the `admin` role (spec Constraint, OQ-12). *(Confirmed after implementation, with T44's
changesets prepared ahead on the branch and consumed after T16: see Sync 2026-11-18, H8.)*

| Goes in | Why |
| --- | --- |
| push 1: notify-api (idempotency, `legal_entity_change`, `recipientId`) | additive; must be live before auth sends the new template (else a 400, retried) |
| push 1: auth F2, F3, F4, F5, FU-6 and the check route | hardening of push-1 routes; F5 changes the copy run at step 3; the check route must exist before push 2's admin-ui calls it |
| push 2: auth notices (outbox, dispatcher) | the spec: the notice ships in the second push; independent of admin-ui's deploy order |
| push 2: admin-ui confirmation, history paging, F7 | admin-ui is push 2 |
| push 2: F6, FU-1, FU-2, FU-9, FU-10 | their services are push 2 |

Between push 1 and push 2 (minutes, same session) a save by an administrator stores no notice; only administrators
hold the grant then (seed), and the copy is not a protected change (AC-9.16). Push-2 skew: admin-ui needs only the
push-1 check route; auth's notices need only push-1 notify-api; an old notify-api answering 400 to the new template
is retried (G6), so no order breaks a notice. The push-1 branch is still cut by cherry-picking (T16 note): every
push-1 task of this amendment precedes, in deps and on the branch, the push-2 tasks touching the same files.

### Test strategy — US-9

Levels as above, plus **N-int**: notify-api `bun test` against compose Postgres (fake Resend, fake contact lookup),
and **A-int (clock)**: the dispatcher with an injected clock and a fake notify-api over HTTP.

| AC | Level | What proves it |
| --- | --- | --- |
| AC-9.1 | A-int, V-ui, E2E | check route: `protectedChanges` against `baseVersion`, stored forms (NFC/trim, IBAN print form), only protected fields, `outcome`; dialog names the entity, lists only changing protected details with visible "Old"/"New" labels, "None" for an empty side, full legal name and VAT, grouped IBAN, Confirm and Cancel, Cancel focused on open; E2E: change the IBAN with spaces/lower case → the dialog shows both grouped |
| AC-9.2 | V-ui, A-int, E2E | Cancel, Escape and the close control each: no `POST …/versions` (fetch spy), values unchanged, focus on Save; server side: a check alone writes no version, audit or notice row |
| AC-9.3 | V-ui | Confirm → one POST with the same body; 409/403/5xx after Confirm → the existing conflict/lost/failed states and no dialog left open; Save again → check again → dialog again |
| AC-9.4 | V-ui | restore with differing IBAN/VAT → list with Old = current, New = version n; no protected difference → no list (dialog as before); version n read on open when not held; read failure → no Confirm; Cancel → no restore call |
| AC-9.5 | A-int, V-ui | address-only, contacts-only, IBAN spacing/case-only → `protectedChanges: []` → no dialog, POST sent directly |
| AC-9.6 | V-ui, E2E | axe 0 on dialog (save and restore variants, en and it, dark and light); focus moves in and returns to Save / the row's Restore; content announced (`alertdialog` labelled and described); keyboard only; strings parity |
| AC-9.7 | A-int (clock) | a direct `POST` (no check, no UI) changing the IBAN → rows in the version's transaction (a forced failure after the insert leaves no version, no audit, no notice row); kick hands over at once; a lost kick → handed over by the next sweep (≤ 15 s); restore with a protected change → rows too |
| AC-9.8 | A-int | welld_ch-conditioned manager notified for welld_ch, not welld_it; unconditioned holder for both; an administrator via a department without the grant notified; a soft-deleted holder/admin not; a person who is admin + manager + actor → exactly one in_app and one email row; recipients fixed at store time (role removed afterwards → still sent) |
| AC-9.9 | A-int | the actor has rows |
| AC-9.10 | A-int | `LEGAL_ENTITY_NOTICE_EMAIL` set → one email row `outside`, no in_app; unset → none, other rows identical; unset between store and send → `given_up` `outside_address_unset` + audit |
| AC-9.11 | A-unit, N-int | *(author by email since D9: see Amendment 2026-11-18 — D9, J8)* content builder per case: entity label, actor name as stored, save vs restore of version m, date/time/zone in Europe/Zurich (CET and CEST dates), version n, protected names, IBAN tails (empty → none; 8 chars → set; 9 chars → last 4), other names, history link; `legal_entity_change` renders the same facts in English with an absolute link |
| AC-9.12 | A-int, N-int | sentinel legal name, VAT, IBAN (old and new), address and contacts lines: none appears in any request auth sends (in-app en/it, email data, key), in `legal_entity_notice` rows, in notice audit rows, in the dispatcher's log lines, nor in the stored notify-api notification or rendered email (only the two last-4 tails); notify-api refuses a `data` member outside the strict shape and a `last4` not matching `^[A-Z0-9]{4}$` |
| AC-9.13 | A-int, N-int, E2E | per person one in-app call with `it` and one email call with `recipientId` (English); outside: email only; notify-api with an idempotent in-app call raises one push dispatch; E2E: the notice appears in the notification centre, Italian when the shell is Italian |
| AC-9.14 | A-int (clock), N-int | notify-api down → save answers 201 exactly as with it up; one recipient's 500 does not delay another's call; first retry at +1 min, then the schedule, `given_up` at 24 h; a new dispatcher instance (restart) sends pending rows; a timeout after notify-api stored → retry → 200 idempotent → one notification; two dispatchers on one database → one call per row; email repeat after `sent` → nothing sent |
| AC-9.15 | A-int | exactly one `notice_failed` per row whatever the retries, `notice_delivered` after a later success, `notice_given_up` at 24 h, `notice_no_recipients` with an injected empty recipient set; each with entity, version, person/outside, channel, reason, time; no value |
| AC-9.16 | A-int | import apply (first and repeated) → 0 notice rows, 0 notify calls |
| AC-9.17 | A-int, V-ui | address/contacts-only save, IBAN spacing-only, restore with equal protected details, no-op 200, 422, 409, 403, and a cancelled dialog → 0 notice rows and 0 notify calls |

Test deltas for the fixes:

| AC / finding | Added |
| --- | --- |
| AC-4.2 (F2) | a soft-deleted holder with a live session: save, restore, check, history, version view → 403; `manageable` → `[]`; person read → 401 |
| AC-2.2 (F3) | history pages of 50, `before` cursor, `nextBefore` null on the last page, union = every version; bad `limit`/`before` → 422; admin-ui "Show older versions" |
| AC-2.6/AC-1.5 (F3) | the 11th save/restore of a person within 10 minutes → 429 with `Retry-After`, nothing written; another person unaffected; admin-ui shows the 429 state |
| F4 | the real-transaction group skips (and says so) for a `*.railway.internal` host; runs for `localhost` |
| AC-7.2/AC-7.5 (F5) | the import audit `source.updatedBy`; the report shows `…1234`/`set`/`none` and never a full IBAN (marker scan) |
| AC-5.5/AC-6.2 (F6) | 100 mismatching renders in one second → at most one registry call; the second within 1 s → 409 without a call *(extended by T72/T76/T77: see Sync 2026-11-18, H10)* |
| AC-2.5 (F7) | `AuditPage` shows before/after of a `legal_entity.save` row from `data.changes` |

**Coverage check:** 52 ACs (the 35 above + AC-9.1–9.17); every one has at least one row in the two tables.

### Risks (added)

| # | Risk | Mitigation / early check |
| --- | --- | --- |
| R15 | Duplicate notice after an ambiguous failure. | notify-api idempotency per caller + key; Resend `Idempotency-Key` (24 h). Residual: if the SDK cannot pass the key, a crash between Resend's accept and notify-api's record → one duplicate email; the task records which. *(The SDK passes it: residual closed for 24 h, Sync 2026-11-18, H3.)* |
| R16 | The dispatcher stops (crash loop, a bug) and notices wait. | Sweep on start; `legal_entity_notice_overdue` log; every row ends `delivered` or `given_up` with an audit entry within 24 h. |
| R17 | Recipients computed under the entity lock slow a protected save. | Candidates narrowed by the rule; a handful of users; A-int measures the save with 50 candidates. Only protected saves pay. |
| R18 | Notice spam from an abused session. | F3 limiter (10 writes per 10 min per person). |
| R19 | notify-api not configured for email in an environment (`APP_BASE_URL` group, Resend) → every email `skipped`. | Retried, then given up with audit entries (visible); env-doctor already requires the group in production; T71 checks it. |
| R20 | Push text is English (notify-api's push sends the English title/body, specs/20261111 AC-2.5). | Reading R-a: AC-9.13's language clause is the notification centre's; the push carries the English text. If the owner wants Italian push, it is a change of the push channel (notify-api + service worker), not of this plan. |
| R21 | `LEGAL_ENTITY_NOTICE_EMAIL` mistyped → the outside notice fails silently to the person. | Validated as an email at startup; failures audited; T71 has the owner confirm receipt of the first notice. |
| R22 | Check route as an oracle or load. | Same authorisation as the save, own limiter, writes nothing, answers only what a manager may read. |

### Security (amended)

Still **YES**, and the re-review is scheduled (T70, `owasp-reviewer`, frontier tier: financial data, R1). Surfaces:

- auth `POST /legal-entities/{entity}/versions/check` (authorisation order, no echo, limiter, no writes).
- auth notice duty and dispatcher: recipients (fail closed on unrecognised conditions, deleted users), outbox rows
  and audit rows free of values (AC-9.12), the 24 h retry and leases, logs, the self-minted token's scopes unchanged.
- notify-api: idempotency keys scoped per calling `sub` (no cross-caller collision or replay oracle), the
  `legal_entity_change` template bound to `system:auth`, `recipientId` addressing limited to that template, the
  strict `data` shape (no free text but the escaped actor name), Resend key handling.
- F2–F7 as fixed (G8–G10), and admin-ui's dialogs (no value in a URL or storage; drafts stay in memory).
- Residual accepted by the owner (Non-goals): no step-up sign-in, no dual control, no delay, session length unchanged
  (F1 items 2, 4, 5); a direct caller is not asked to confirm, only notified.

### ADR candidates (added)

*(All four written 2026-11-18, with their paths in Sync 2026-11-18, H2.)*

5. **Notices of a protected change are a durable duty**: an outbox written in the version's transaction,
   at-least-once dispatch with receiver idempotency, retries for 24 h, outcomes in the audit log. Amends ADR
   20261105 (auth raises a second kind of notice under origin `admin`) and departs from ADR 20260716 §4
   (best-effort, no retry) for this notice. **Written:**
   `docs/adr/20261117-notices-of-a-protected-legal-entity-change-are-a-durable-duty-an-outbox-written-in-the-versions-transaction-sent-at-least-once-for-24-hours-with-outcomes-in-the-audit-log.md`.
6. **notify-api `/system/*` idempotency keys and per-template caller binding**, with `recipientId` addressing for a
   bound template (amends ADR 20260714 and ADR 20261101). **Written:**
   `docs/adr/20261117-notify-api-system-routes-protect-against-repeats-by-a-caller-scoped-idempotency-key-and-bind-a-template-to-its-caller-with-closed-typed-data.md`.
7. **A confirmation backed by a read-only server check**: admin-ui asks auth what a save would change; the registry
   enforces no confirmation (spec Non-goal). **Written:**
   `docs/adr/20261117-a-confirmation-is-backed-by-a-read-only-server-check-it-is-admin-uis-and-the-registry-does-not-enforce-it-and-when-the-check-cannot-be-made-nothing-is-saved.md`.
8. **(FU-5)** How a letterhead layout draws the configurator's "missing" mark (runtime one-line template patch in
   `layout/mod.rs`; a future layout 2 must provide it). **Written:**
   `docs/adr/20261117-a-layout-draws-the-configurators-missing-mark-through-a-runtime-patch-of-one-template-line-the-label-only-in-the-drawing-and-the-brackets-only-in-the-page-text-and-a-layout-that-cannot-is-refused.md`.

### Spec drift

None found. US-9 is buildable as written. Readings the owner may confirm (none changes an AC): R-a (push text
English, R20), R-b (a rule refusal comes before the confirmation, G7), R-c (administrator = effective admin, G3),
R-d (the notice's time zone is Europe/Zurich, stated with its abbreviation).

## Sync 2026-11-18 after implementation

Source: the branch as built (product code up to `95ebd129`, then T77 `da0b000c`; ADRs in `caf5564a`, forward
pointers in `43850795`), `tasks.md` (T72–T76, D1–D3, the
follow-ups and the orchestrator's recorded decisions), `qe-report.md` (T45, PASS 52/52), `security-review-2.md` (T70,
PASS WITH NOTES, and its delta review of T76/D2/D3), the six ADRs of 2026-11-17/18, and eval round 1 (2026-11-18, spec fidelity finding (b)). The plan
stays `approved`: this block records what was built and decided after approval. It designs nothing new and
**changes no acceptance criterion**. Where the text above is now wrong, it carries a pointer "(see Sync 2026-11-18,
Hn)", and this block wins. Items are numbered H1…H12.

### H1 — The version pin as built (F6 → T64 + T76 + T77; crm-api T72)

This supersedes decision 8's "refreshes when its entry is older", G10 F6, and the pin part of ADR candidate 2
(ADR-2 point 3).

- **A pin at or below the held version** gets 409 `legal_entity_version_mismatch` + `currentVersion` at once, with
  **no registry call**. Versions only go up, so a read cannot cure it. A matching pin still costs nothing.
- **Only a newer pin forces a refresh.** `refresh_for_pin()` sets the held entry aside (not away, T77) so that the
  next read asks auth. It does not do so when any of these holds:
  - a forced refresh started less than 1 s ago (`FORCED_REFRESH_EVERY`);
  - the entry itself was sent less than 1 s ago;
  - 30 forced refreshes started in the last 600 s (`PIN_REFRESH_BUDGET = 30`, `PIN_REFRESH_WINDOW`, a sliding
    window, per process; 100 under T76, lowered by T77 because auth's 300 per 10 min is shared by every replica:
    one replica makes at most 30 forced plus about 20 natural reads (one per 30 s) ≈ 50 per 600 s, so 300 holds
    up to about 6 replicas; there is one today, `.railway/railway.ts`).

  A started refresh counts against the budget whatever its outcome. A refused one does not count. When no refresh is
  made, the read uses the held entry or joins the refresh already in flight, and a pin that still differs is the
  caller's 409 at once.
  (`letterhead-api/api/src/registry/cache.rs`, `api/src/routes/render.rs` `issuer_details`.)
- **The held entry stays the fallback of a forced refresh (T77, security-review-2.md T76-1).** Under T76 a forced
  refresh dropped the entry before its outcome was known, so during an auth fault each forced refresh removed the
  60 s stale fallback for every caller. Now the entry set aside is kept as `fallback` while the refresh is in flight
  and if it fails:
  - unpinned and matching-pin reads keep being served from it, under the same rule as decision 7 (usable up to 60 s
    from when that entry was sent; after that, 503 `legal_entities_unavailable` as before);
  - a newer pin gets that entry too, so its answer is 409 with `currentVersion` = the held version, not 503;
  - a refresh that succeeds replaces the entry and drops the fallback; `invalidate()` forgets both.
- **crm-api waits 1.1 s before its single retry (T72).** On 409 it drops its entry, waits
  `issuerPinRetry.waitMs = 1100` (fixed, behind a test seam, past the one-second window), re-reads, rebuilds and
  retries **once**. A second mismatch is 503 `layout_service_unavailable` (`crm-api/src/offers/generation.ts`).
- **Unchanged:** the 30 s / 60 s cache rule (the fallback never outlives 60 s from its send), the sent-time stamp, single flight, and the 409 / retry-once contract.
  The ordinary 30 s refresh is not budgeted, so AC-3.3 and AC-5.5 hold as proved in decision 7. No PDF mixes two
  versions (AC-6.2): a pin is never "cured" by stale data.
- **Why (security-review-2.md N2).** The 1/s spacing alone still allowed 600 forced refreshes per 10 minutes per
  process. auth allows each service 300 legal-entity reads per 10 minutes in total, so a stream of mismatching pins
  could use up letterhead-api's allowance, and every render would then become 503. The delta review of T76
  (security-review-2.md T76-1, T76-2) found the dropped-entry window and the per-process budget against a
  per-service allowance; T77 (`da0b000c`) fixed both.
- **Record:** `docs/adr/20261118-a-pin-ahead-of-the-held-version-forces-one-registry-refresh-at-most-once-a-second-and-100-times-in-10-minutes-per-process-and-any-other-mismatching-pin-is-answered-409-at-once.md`.
  It amends points 3 and 4 of ADR-2
  (`docs/adr/20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds.md`),
  which now points forward to it (`43850795`). The pin ADR's "Amendment 2026-11-18" records T77: wherever it, its
  title or its file name says 100, read 30.
- **Approved by the owner on 2026-11-18:** the numbers (1 s, 30 per 600 s, 1.1 s; T72, T76, T77) were decided by the orchestrator during the owner-requested unattended run 2026-11-17/18 (recorded in tasks.md), approved by the owner on 2026-11-18,
  from the re-review's recommendation. The ADR's Status is Accepted (owner, 2026-11-18).

### H2 — ADR candidates: all written

The eight plan candidates are Accepted (approved with the plan and its amendments). The two records of 2026-11-18
are **Accepted (owner, 2026-11-18)**: decided by the orchestrator during the owner-requested unattended run 2026-11-17/18 (recorded in tasks.md), approved by the owner on 2026-11-18.

| Candidate | Record |
| --- | --- |
| ADR-1 | `docs/adr/20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database.md` |
| ADR-2 | `docs/adr/20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds.md` (points 3–4 amended, H1) |
| ADR-3 | `docs/adr/20261117-an-app-is-reachable-through-a-capability-it-administers-admin-in-authz-me-apps-and-admin-ui-sections-by-capability.md` |
| ADR-4 | `docs/adr/20261117-the-crms-legal-details-move-to-the-registry-by-expand-copy-switch-contract-and-version-1-is-attributed-to-the-system.md` |
| 5 (durable notices; amends 20261105, departs from 20260716 §4) | `docs/adr/20261117-notices-of-a-protected-legal-entity-change-are-a-durable-duty-an-outbox-written-in-the-versions-transaction-sent-at-least-once-for-24-hours-with-outcomes-in-the-audit-log.md` |
| 6 (notify-api idempotency and template binding; amends 20260714, 20261101) | `docs/adr/20261117-notify-api-system-routes-protect-against-repeats-by-a-caller-scoped-idempotency-key-and-bind-a-template-to-its-caller-with-closed-typed-data.md` |
| 7 (confirmation backed by a read-only check) | `docs/adr/20261117-a-confirmation-is-backed-by-a-read-only-server-check-it-is-admin-uis-and-the-registry-does-not-enforce-it-and-when-the-check-cannot-be-made-nothing-is-saved.md` |
| 8 (FU-5, the missing mark) | `docs/adr/20261117-a-layout-draws-the-configurators-missing-mark-through-a-runtime-patch-of-one-template-line-the-label-only-in-the-drawing-and-the-brackets-only-in-the-page-text-and-a-layout-that-cannot-is-refused.md` |
| not a candidate (D3 rule; **Accepted** (owner, 2026-11-18)) | `docs/adr/20261118-a-dialog-that-renders-its-own-form-is-mounted-beside-the-form-never-inside-it.md` |
| not a candidate (F6/N2, H1; **Accepted** (owner, 2026-11-18)) | `docs/adr/20261118-a-pin-ahead-of-the-held-version-forces-one-registry-refresh-at-most-once-a-second-and-100-times-in-10-minutes-per-process-and-any-other-mismatching-pin-is-answered-409-at-once.md` (amended 2026-11-18: budget 30, T77) |

- `AGENTS.md` gained one line for each of the six new records (`caf5564a`).
- The new records state their amendments in their Status lines, and the older ADRs (20260714, 20260716, 20261101,
  20261105 and ADR-2) now point forward to them (`43850795`).

### H3 — notify-api: where the code differs from G4/G5 (found by the ADR writer)

- **Emails: a partial unique index.** `email_delivery` has the ordinary index of G4 **and** a partial unique index on
  `(callerSub, idempotencyKey) WHERE idempotencyKey IS NOT NULL AND status = 'sent'`. So "at most one `sent`" is
  enforced by the database, not only by the code, and failed attempts may still repeat. Both tables also gain a CHECK
  that a key never exists without its caller (`idempotencyKey IS NULL OR callerSub IS NOT NULL`), so a NULL `callerSub`
  cannot get around the unique indexes (`notify-api/prisma/migrations/20261117100000_system_idempotency`).
- **`recipientId` on another template → 400 `recipient_id_not_allowed`.**
  - The binding is a policy table, `EMAIL_TEMPLATE_POLICY` (`callers`, `allowRecipientId`).
  - A caller outside `callers` gets 403 `template_not_allowed`, with nothing written (as in G5).
  - A template absent from the table stays open to every `emails.send` holder and takes `to` only.

  (`notify-api/src/system/emails.routes.ts`.)
- **The Resend key goes through the SDK option**: `emails.send(payload, { idempotencyKey })`, resend 6.17.2.
  - A `<sub>:<key>` pair over 256 characters is hashed, not truncated.
  - Resend refusing a reused key is a soft `failed`, never a throw.
  - R15's residual (no key reaching Resend) does not apply: the 24 h window is covered.
- **A repeat of a delivered email answers before the address lookup.** A repeat after a `sent` attempt answers 200
  with the same `deliveryId` **before** looking up the recipient's address. A recipient who became inactive since
  then cannot turn a delivered send into a `skipped`.

No AC is affected. AC-9.12 and AC-9.14 are covered as G5 intended, and the strict `data` shape is unchanged.

### H4 — auth: smaller deltas

- **Check route, refusal order (G5).** As built and recorded in ADR 7, the order is:
  401 → 403 → 404 → 403 → **429** (the check's own limiter) → 413 → 422 `invalid_request` → 422
  `invalid_legal_entity` → 409 `legal_entity_not_moved` → 409 `version_conflict`.
  That is, the 429 is counted after authorisation and before the body is read, as G5's 429 paragraph already says.
  The list in G5 put it last.
- **T74.** auth's CORS middleware exposes `Retry-After` (`Access-Control-Expose-Headers`). admin-ui reads the real
  wait of a 429 from another origin; before this, every 429 would read "a few minutes". Push 1 (`e531ab30`).
- **T75.** The committed "real transactions" group of `auth/src/legalEntities/notices/duty.test.ts` runs only when
  `committedTransactionsSkipReason(DATABASE_URL)` is null. This is G10 F4's guard, as G10 required for any new
  committed-transaction test. Push 2 (`815d58eb`).
- **D1 (`62babb4e`, push 1).** Better Auth is mounted on `"/*"` and no longer on `"/**"`.
  - Why: `"/**"` is not Hono wildcard syntax. Once the legal-entities router made SmartRouter fall back to
    TrieRouter, every `/auth/**` route answered 404.
  - `auth/src/auth/auth.mount.test.ts` now goes through the assembled app.
  - G12's routing rules are the lesson. They held for the check route.

### H5 — admin-ui: the confirmation as built (D3, T73, the S12 busy reading)

- **D3 (`95ebd129`, high, found by the T68 e2e).** Confirm did not save. `ProtectedChangeDialog` was mounted inside the
  form's `<form>`, and `ConfirmDialog` renders its own `<form>` without a portal. Confirm therefore did the browser's
  native submit (a navigation) and no POST was sent. As built now:
  - the dialog is a **sibling** of the form, never inside it;
  - Confirm sends **one** save with the body that was checked (`open.sent`, `open.baseVersion`), not a re-read of
    the form;
  - the dialog **stays open and busy until the save's answer** and then goes. This supersedes G7's "the dialog closes
    first"; design F15 already said "the dialog stays busy until the answer";
  - D-T68-2: both dialogs' computed accessible descriptions hold every Old and New value.

  A unit test asserts that there is no nested `<form>` and drives a real `requestSubmit`. The rule is recorded as
  `docs/adr/20261118-a-dialog-that-renders-its-own-form-is-mounted-beside-the-form-never-inside-it.md`.
- **S12 busy state (2026-11-18, T40 report; decided by the orchestrator during the owner-requested unattended run 2026-11-17/18 (recorded in tasks.md), approved by the owner on 2026-11-18).** design.md S12 says both
  buttons are `aria-disabled` while the confirmation is busy. `@operai/ui` `ConfirmDialog` disables Confirm
  **natively** while `busy`, which is shared library behaviour for every dialog in the suite.
  - Accepted as is: the busy state is short and announced, and axe is clean on both dialogs.
  - S12 is read as "Confirm unavailable while busy". There is no library change.
  - Amending the S12 text and the a11y line in design.md belongs to the designer (eval round 1, design fidelity), not
    to this plan.
- **T73 (library in push 1 `bbc1e27c`, admin-ui in push 2 `5ffee437`).** `ConfirmDialog` gains three opt-in props:
  - `scrollBody`: the body scrolls and the footer stays visible at 320 px;
  - `confirmDisabledReason`: Confirm is `aria-disabled`, with the reason in its description;
  - `size`.

  Existing dialogs are unchanged. The restore dialog uses `confirmDisabledReason` while it reads version n and after a
  failed read: this is how G7's "Confirm unavailable with the reason + Retry" is built. admin-ui relies on the
  push-1 shell for these props, as E10 allows.

### H6 — letterhead-api engine: D2

`c63a0681` (found by QE in the T43 e2e): in the configurator preview's page text, a missing label that wraps onto a
second line keeps its `⟦ ⟧`. The case was the English "Contacts line" in a footer line `{iban} {contacts}`. Real
documents' output is unchanged, and the golden corpus stays byte-identical. This refines E3 and is recorded in ADR 8.

### H7 — Design decisions taken unattended (orchestrator, 2026-11-17; recorded in tasks.md for the owner's review)

Each item below was decided by the orchestrator during the owner-requested unattended run 2026-11-17/18 (recorded in tasks.md), approved by the owner on 2026-11-18.

- **DR-14.** An effective administrator can always open the notice's history link. The reason: the `admin` role holds
  `legal-entity:manage` unconditioned by seed (T3), and department admins inherit that role. No design change.
  Consistent with G3, which notifies effective administrators whether or not they hold the grant.
- **DR-17.** The push text on a lock screen may show the actor's name and the two IBAN tails. This is allowed by
  AC-9.12 and by reading R-a (push text in English, R20). Accepted by the orchestrator, approved by the owner on 2026-11-18.
- DR-13, DR-15, DR-16 and DR-18 stand as design.md says; DR-18 was done in T63.
- Still open with the owner (not plan decisions):
  - **N1 / O-1:** the actor's display name can be edited by its holder through `POST /auth/update-user`, and the
    notice prints that name. *(Decided by the owner on 2026-11-18: the notice names the author by account email
    only, spec amendment D9; designed in "Amendment 2026-11-18 — D9" below.)*
  - The copy review of T51.

### H8 — Release order: G15 still holds

The sequence is unchanged: QE (T45) and T70 → **T16 push 1** → T17 → T18 → step 4 → **T48 push 2** → T49 → T71 → T50.

T44's six push-2 changesets (`87a24dee`) are already on the branch:
`.changeset/legal-entities-{admin-ui,auth-notices,crm-api,crm-ui,letterhead-api,letterheads-ui}.md`. T44's dep on
T16 is read as **"consumed after T16"**, not "written after T16". This is safe for these reasons:

- **The push-1 cut is built from `main` by cherry-picking only push-1 commits** (T16 note). `87a24dee` is a push-2
  commit and is not picked, so T16's release cut cannot consume or bump these six packages.
- **They are consumed by T48's cut**, after T16, T17, T18 and step 4, in the same release session. That is exactly
  what T44's note asks: "push-2 changesets must not be consumed by the push-1 cut".
- **The late commits fall on the correct side of the split:**
  - push 1: `62babb4e` (D1), `e531ab30` (T74) and `bbc1e27c` (T73's library half);
  - push 2: `aa345b64` (T72), `5ffee437` (T73's admin-ui half), `815d58eb` (T75), `fcaedf07` (T76), `da0b000c` (T77),
    `c63a0681` (D2), `95ebd129` (D3) and `87a24dee` (T44).

  T73 was already committed as two commits, so the split needs no surgery.

Added check at T16, before cutting: the push-1 release branch contains none of the six files above. (`changeset
status` will still list auth, from its push-1 changesets `legal-entities-registry-auth*.md`; that is expected.)

T44 is now unticked in tasks.md (`dc658437`): "prepared" on the branch, open until consumed after T16. That matches
this reading and does not change the order.

### H9 — FU-12: root cause found, still open (test infrastructure, not the product)

`letterhead-api/api/tests/render.rs:680` is the spawned server **exiting** before `/health` ("the database did not
answer in time" / `PoolTimedOut`). It is not a start-up timeout and not a `free_port` race (QE simulated
13 200 starts with 0 failed binds).

**Root cause: Postgres connection exhaustion.** About 40 tests each start a server with its own pool, and compose's
default `max_connections = 100` is reached by one instance of the suite. Any other client on the shared compose
Postgres tips it over: another session's suite or an e2e stack. CI has its own Postgres per job and is green, but
it also peaks at the cap.

**Recommendation** (QE §11; owners: dev for the helpers, devops for compose):
1. Do not widen the `/health` wait.
2. In the helpers of `render.rs`, `preview.rs`, `read.rs`, `write.rs` and `residue.rs` that spawn the binary, bound
   the servers starting at once (a process-wide semaphore of about 4), or give the spawned server a smaller pool
   through its environment.
3. Set `max_connections=200` in `compose.yaml` for machines where several sessions share it.

No product code changes, and no AC depends on it. It weakens the R-int level's reliability on shared hosts only.

### H10 — Test strategy deltas (as built)

| AC / finding | Added to "What proves it" |
| --- | --- |
| AC-5.5/AC-6.2 (F6, T76) | an older or equal pin → 409 at once and again a second later, with no registry call; a newer pin refreshes once, then waits a second; a failed forced refresh still counts for the second; the budget is 30 per 600 s and the window slides (`registry_the_forced_refresh_budget_is_30_per_10_minutes`, T77) (`api/tests/registry.rs`, `api/tests/render.rs`) |
| AC-5.5 (T77) | a failed forced refresh keeps serving the old entry within 60 s of its send, also to reads that joined the refresh; a refresh that works replaces the entry and drops the fallback; `invalidate()` drops it; a failed pin refresh keeps the held entry for every other render (`registry_a_failed_forced_refresh_keeps_serving_the_old_entry_within_60_s_of_its_send`, `registry_reads_that_join_a_forced_refresh_get_the_old_entry_if_it_fails`, `registry_a_forced_refresh_that_works_replaces_the_entry_and_drops_the_fallback`, `registry_invalidate_drops_the_fallback_a_forced_refresh_set_aside`, `render_a_failed_pin_refresh_keeps_the_held_entry_for_everybody_else`) |
| AC-6.2 (T72) | a fake letterhead service answering 409 for 1 s then 200 → one retry after ≥ 1.1 s and a 200; the existing retry tests (a second mismatch → 503 `layout_service_unavailable`) stay green |
| AC-9.3/AC-9.1 (D3) | no nested `<form>` anywhere on the page; Confirm drives a real `requestSubmit` and calls the save once with the checked body; e2e journeys of `protected-legal-details.spec.ts` and `legal-entities.spec.ts` |
| AC-9.6 (D3, T73) | the computed accessible description of both dialogs holds each Old/New value; the footer stays in view at 320 px; Confirm is `aria-disabled` with a described reason while the restore dialog reads |
| AC-5.4 (D2) | an engine test of an English wrapped missing label keeps `⟦ ⟧` in the page text; real output unchanged |
| AC-9.14 (H3) | a repeat after `sent` sends nothing and a repeat after `failed` sends again; the key is not shared across callers; the key reaches Resend as `Idempotency-Key` through the SDK option and a Resend refusal of a key is a soft failure (`emails.idempotency.test.ts`, `email.channel.resend.test.ts`) |
| AC-8.1/AC-9.6 (T74) | a CORS request to a throttled registry route exposes `Retry-After` |

**Coverage check:** unchanged. All 52 ACs map to at least one test, and QE executed every one (qe-report.md §9).

### H11 — Risks (updated)

| # | Risk | Mitigation / early check |
| --- | --- | --- |
| R8 (amended) | Two caches differ for up to 60 s. | The pin, refreshed only when newer, within the budget; crm-api retries once after 1.1 s (H1). |
| R15 (closed) | A duplicate email after an ambiguous failure. | The Resend key goes through the SDK option (H3). |
| R23 | The pin budget is used up (30 forced refreshes per 10 min per process) by abuse or a crm-api bug. A pin newer than the held entry then gets 409 at once, crm-api's one retry after 1.1 s also gets 409, and that offer fails with 503 `layout_service_unavailable`. | Bounded per registry save to at most 30 s: the ordinary 30 s refresh is not budgeted, so the held entry catches up and the next pin matches (security-review-2.md T76-3). Unpinned and matching renders are unaffected. Residual: the budget's refusal writes no log line, so exhaustion is visible only as those 503s (T76-3's A09 note; not fixed). |
| R25 | An auth fault during a forced refresh. | T77: the held entry stays the fallback, so other renders keep working within 60 s of its send and a newer pin gets 409 (`currentVersion` = held), not 503. After 60 s, 503 as AC-5.5 requires. |
| R24 | The budget is per process: N replicas of letterhead-api make N × 30 against auth's 300 per service, plus about 20 natural reads per process. | One replica makes at most 30 forced + about 20 natural (one per 30 s) ≈ 50 reads per 600 s, so 300 holds up to about 6 replicas (10 replicas would make about 500; 10 × 30 forced alone is the whole allowance). Every service in `.railway/railway.ts` declares one replica today. If letterhead-api is scaled beyond one replica (and before it nears six), or auth's `LEGAL_ENTITIES_SERVICE_LIMIT` is lowered, revisit H1 (the pin ADR's own trigger). |

### H12 — Spec drift

**None found.** H1 (with T77) changes when letterhead-api re-reads the registry and what it falls back to within
the 60 s rule, not what a document prints. AC-3.3, AC-5.5 and
AC-6.2 hold, and a budget refusal is a refused document (503), never a document printed with older details. H3–H6
settle points the plan left open, or fix the plan's own text against a design that was already approved (F15). The
open owner items (N1/O-1 and the T51 copy) are listed in H7. They would become spec changes only through the PO.

## Amendment 2026-11-18 — D9

> Plan status stays `approved`. Source: spec amendment D9 (`269090f1`: AC-9.11, AC-9.12, AC-9.16, the two new
> Non-goals, OQ-14 to OQ-16), the owner's decision of 2026-11-18 recorded in tasks.md (`d1da2ecc`),
> security-review-2.md N1 and qe-report.md O-1. The code read for it: `auth/src/legalEntities/notices/{duty,dispatcher,content,copy}.ts`,
> `write.routes.ts`, `repo.ts`, `auth/prisma/schema.prisma` (`LegalEntityVersion`, `LegalEntityNotice`, `User`),
> `auth/src/auth/auth.config.ts` (session cookie cache), `auth/src/lib/notify.ts`, notify-api
> `src/system/{emails.schemas,emailTemplates,emails.routes}.ts`, `src/channels/push.channel.ts`, `src/lib/zodHook.ts`,
> design.md N1, ADR 5 and ADR 6. Where any text above says that a notice names the actor by name (`actorName`,
> `sanitizeActorName`, `createdByName` read by the notice code), this block wins. Items J1…J12; tasks T78–T87.

### J1 — What changes

```
 before  send time: versionOf(n).createdByName ── sanitizeActorName ──► "Change saved by Anna Rossi."   (editable by its holder: N1)
 after   store time, in the version's transaction (recordNoticeDuty):
           SELECT email FROM "user" WHERE id = actor  ──► legal_entity_notice."authorEmail" on every row of version n
         send time (dispatcher): claimed row ─ authorEmail ─► content.ts ─► in-app en/it body + email data.actorEmail
                                                                         ─► notify-api legal_entity_change template
```

Unchanged: the history (AC-2.2) and the audit log (AC-2.5) still show the name (OQ-16); `legal_entity_version` still
stores `createdByName` for them; recipients, schedule, keys, leases, reasons and every other closed slot of a notice.
The notice code stops reading `createdByName` altogether, so no path from the display name into a notice remains.

### J2 — Where the email is captured (decision)

**Chosen: a nullable column `authorEmail` on `legal_entity_notice`, written by `recordNoticeDuty` with the rows, from
a read of the actor's `user` row inside the version's transaction.**

1. **Fixed with the version, like the recipients.** AC-9.8's recipients are already fixed by the rows written at
   store time; AC-9.11 asks for the author's email to be fixed "like the recipients", and the same insert does it. A
   send-time read of `user.email` by `createdByUserId` (security-review-2.md N1 fix 2) is **rejected**: a change of
   the address or a deletion of the account before a retry (AC-9.14, up to 24 h) would change what the notice says.
2. **Only where it is needed.** Only a protected change has notice rows. A version without notices needs no email,
   so there is **no backfill**, and the import never reaches the duty (G2, AC-9.16): the system needs no email.
3. **Tier 2, not Tier 1.** `legal_entity_notice` is Tier 2 (rows change status, no immutability trigger; G4,
   ADR 20260804). `legal_entity_version` is Tier 1, append-only, with UPDATE/DELETE/TRUNCATE triggers (ADR-1): an
   address written there could never be corrected or erased, even under a data-protection request.
4. **The dispatcher works per row.** A claimed row then carries everything it needs beyond the two immutable
   versions; the claim's `RETURNING` gains one column; no join to `user` at send time.

**Read in the transaction, not from the session.** Better Auth serves the session's user from a cookie cache up to
5 minutes old (`auth.config.ts`, `cookieCache.maxAge`), and the save handler takes `user` from that session. The
duty therefore reads `tx.user.findUnique({ where: { id: actorUserId }, select: { email: true } })` after
`appendVersion`, under the entity lock: the committed address at the moment the version is stored. One primary-key
read, on protected changes only (R17 unchanged). `write.routes.ts` does not change.

**Stored verbatim.** No lowercasing or rewriting: the notice states the address the account had. An empty string or
a missing row becomes `null`. Missing is unreachable today: the F2 authorisation step refuses a missing or deleted
person, users are only soft-deleted, and `User.email` is required and unique (OQ-15). `null` makes the notice say
"no email address on record" (J5); it never falls back to the display name.

**The capture never fails the save.** There is no CHECK on the form or length of the address, because a CHECK that
fails would turn a legitimate save into a 500. The one CHECK is `"authorEmail" IS NULL OR "authorEmail" <> ''`,
which the code guarantees by writing `null` for an empty string.

Rejected:

- (a) **`createdByEmail` on `legal_entity_version`.** The data would sit in Tier 1 forever (point 3 above). It would
  be written for every save, protected or not. It would also live in the table that the history, the version view
  and the service reads select from (`GET /system/legal-entities`, read by letterhead-api and crm-api), so one
  SELECT-list change would leak it into an API that OQ-16 keeps unchanged. And ADR-1's contract test would be
  touched for a concern that belongs to the notice only.
- (b) **A table `legal_entity_notice_author` with one row per noticed version.** It keeps one copy instead of 2N+1,
  but it adds a table, a foreign key and a Tier 2 surface for a few dozen bytes on a few rows per protected change.
  The per-row copy is written by one `createMany` from one value, so the rows of a version cannot disagree (tested).
- (c) **The session's `user.email`.** It can be up to 5 minutes stale (cookie cache).
- (d) **Editing the unreleased migration `…_legal_entity_notices` instead of adding one.** It has been applied on
  compose, CI and e2e databases, and editing it would break Prisma's migration checksum. A new additive migration
  is used instead.

### J3 — Data model (auth, push 2)

```prisma
model LegalEntityNotice {
  // … as G4 …
  /// The actor's account email when the version was stored (AC-9.11, amendment D9); null = none on record.
  /// Personal data: content of the notice only; never in a log line or an audit entry. Written once, never updated.
  authorEmail   String?
}
```

`auth/prisma/migrations/<ts>_legal_entity_notice_author_email/migration.sql` (additive, no data changed):

```sql
ALTER TABLE "legal_entity_notice" ADD COLUMN "authorEmail" TEXT;
ALTER TABLE "legal_entity_notice"
  ADD CONSTRAINT "legal_entity_notice_authorEmail_not_empty" CHECK ("authorEmail" IS NULL OR "authorEmail" <> '');
```

- **No backfill.** Production has no notice row: auth's notices ship in push 2 (T48), together with this change.
  A row written by a pre-D9 build on a development, CI or e2e database reads `null`, so its notice says "no email
  address on record" and never shows a name.
- **Never updated.** The dispatcher's `updateMany` calls set status columns only. A test asserts that no update
  of a notice row names `authorEmail`.
- **Comments.** The schema and `duty.ts` comments that say the rows hold no personal value are corrected. They now
  hold no value *of a detail* (AC-9.12) and one personal value, the author's email.

### J4 — Contracts

**auth (internal).** `NoticeDutyRequest` is unchanged: it already has `actorUserId`, and the duty reads the address
itself. `NoticeFacts.actorName` becomes `authorEmail: string | null`. `sanitizeActorName` and `ACTOR_NAME_MAX` go
away, and `noticeFacts(current, previous, authorEmail)` takes the row's value.

**The one rule for an author address.** `noticeAuthorEmail = z.string().email().max(320)`, exported by `content.ts`.
It is the rule of notify-api's `ToSchema` and of auth's `LEGAL_ENTITY_NOTICE_EMAIL`, and it refuses blanks,
control and format characters. How `content.ts` uses it:

- an address that passes is shown verbatim;
- `null` gives the "no email address on record" sentence;
- an address that is present but fails the rule follows reading **R-D9a** (J11): it is treated as "no email address
  on record", and the log line `legal_entity_notice_author_email_unusable` is written with `{ id, entity, version,
  channel }` and no value.

**notify-api `legal_entity_change` `data`** (push 1; still a `strictObject`):

```jsonc
{ "entity": "welld_ch", "action": "save", "restoredFrom": null,
  "actorEmail": "anna.rossi@welld.ch",   // REQUIRED. An email address by the rule of `to`, at most 320 characters;
                                         // or null = "no email address on record". Never a display name.
  "storedAt": "…", "version": 8, "protectedChanged": ["iban"], "otherChanged": [], "iban": { … } }
// "actorName" is removed: sent by a caller, it is an unknown member → 400 (strictObject). A missing "actorEmail" → 400.
```

zod: `actorEmail: z.string().email("data.actorEmail must be an email address").max(320).nullable()`.

**Template.**

- `actorEmail` is HTML-escaped and printed as text, with no `mailto:` link. A mail client may still auto-link it,
  which is acceptable: the notice does not vouch for who was behind the account (Non-goal).
- `null` gives the no-email sentence. The fallback "an unnamed user" is removed, and no fallback can name a person.
- Subject and title are unchanged and hold closed values only (design DA-6). The address is in the body only.

**In-app call.** Its shape is unchanged (G5). The body line `notice.byAction.*` carries the address in `en` and `it`.

**Push (DR-17).** The push text is the English title and body, so a lock screen shows the author's address. This
was accepted by the owner: AC-9.12 counts push text as part of a notice.

**Longest case.** With a 320-character address, a restore, three protected names, four other names and Italian, the
body is about 930 UTF-16 units, under the 2000 limit. The push JSON is about 1.6 KB, under notify-api's 3000-byte
cap, so `shrink` never cuts the body and the address is never shown cut short. A test asserts both.

### J5 — Copy (designer, T78)

The binding contract for the designer:

- the slot of `notice.byAction.save` and `notice.byAction.restore` takes the address;
- `notice.unknownActor` ("an unnamed person" / "una persona senza nome") is replaced by a key for "no email address
  on record", in `en` and `it`;
- the email template's "an unnamed user" is replaced by the same English words;
- in both channels the address appears once, in the body.

Recommendation (the designer decides). Name the **account**, not a person, because the notice states the address
as recorded and does not prove who used it (Non-goal):

- with an address: "Change saved by the account anna.rossi@welld.ch." / "Modifica salvata dall'account
  anna.rossi@welld.ch.";
- with none: "Change saved by an account with no email address on record." / "Modifica salvata da un account senza
  indirizzo email registrato.";
- rename the slot `{actor}` to `{author}`.

design.md N1 is updated to match: the closed slots, DA-6, the worked example, the longest case and DR-17. The open
item "N1 / O-1" is closed by D9.

### J6 — Personal data: where the address may and may not appear

**Allowed (notice content, AC-9.12 as amended).**

- the in-app body (`en`, `it`) and the push text derived from it;
- the email's HTML body and its request `data`, including the outside mailbox's email (AC-9.10);
- the notification notify-api stores (its `body` and `bodyIt` columns);
- the Resend payload;
- the outbox column `authorEmail`.

**Never.**

- **auth log lines.**
  - The dispatcher keeps its fixed fields: id, entity, version, channel, reason, attempts, error class.
  - `NoticeContentError` messages stay constant strings.
  - Failures of a save log `safeErrorText` only: class and code. A Prisma error message could hold the inserted
    value, so it is never logged.
  - The duty logs nothing, and `lib/notify.ts` never logs a body.
- **Audit entries.** `legal_entity.notice_*` keep `data: { version, recipient, userId?, channel, reason?, at }` and
  their summaries. `legal_entity.save` and `legal_entity.restore` are unchanged: `actorUserId` already identifies
  the person.
- **Idempotency keys**, which carry the row id only.
- **notify-api logs.**
  - The system routes log no `data` (the log-privacy tests).
  - zod 4 issues carry no input unless `reportInput` is set, and it is not. A 400 for a bad `actorEmail` therefore
    returns the path and the message, never the value (tested).
  - `email_delivery` stores `to`, template and status, not `data`.

**Retention.** The column stays with its row; G4 has no cleanup job. A future procedure that erases an account's
personal data must also cover `legal_entity_notice.authorEmail` and notify-api's stored notifications. No such
procedure exists today. Recorded here so the next spec that needs one finds it.

### J7 — Release order and skew (confirmed)

**The split.** The notify-api change (T79, with its changeset T82) is **push 1**. The auth capture, content and
copy (T80, T81, changeset T83) are **push 2**.

- T16 has not been cut, so the D9 notify-api commit is cherry-picked into the push-1 release branch like T56/T57.
- T79's commits touch notify-api and its push-1 changeset only. T80, T81 and T83 touch auth and the push-2
  changeset only, so the cut needs no surgery (H8).

**New auth and old notify-api.** The strict schema answers 400: `actorEmail` is an unknown member and `actorName`
is missing. The dispatcher records `notify_refused` and retries on the G6 schedule until notify-api is upgraded.
After 24 h the row is given up, with `notice_failed` and `notice_given_up` in the audit log. The in-app channel is
not affected. **This cannot happen in the planned order** (G15: push 1, then steps 2–4, then push 2). Confirmed.

**New notify-api and old auth** (between push 1 and push 2). Push-1 auth has no dispatcher and sends no
`legal_entity_change`, so there is nothing to refuse. notify-api therefore replaces the member outright.

Rejected: accepting both `actorName` and `actorEmail` for a transition. It is needed by no caller, and it would keep
a display-name input alive in the template, against "no display name anywhere in a notice".

**Rollback.**

- notify-api rolled back below D9 while push-2 auth runs: as above (retried, then given up with audit entries; the
  in-app channel works).
- auth rolled back to push 1: the dispatcher stops and the rows wait. This is unchanged.

**Checks.**

- T16: the push-1 cut contains T79's commit and T82's changeset, and none of T80, T81, T83 or T84.
- T48: notify-api in production is the push-1 version, so it accepts `actorEmail`. QE (T85) rehearses the
  new-auth + old-notify-api pairing on compose.

### J8 — Test strategy (the changed ACs)

| AC | Level | What proves it |
| --- | --- | --- |
| AC-9.11 | A-int (duty) | A protected save → every row of the version carries the actor's `user.email`, read in the transaction: person rows and the outside row, all equal. The address is changed in the database after the session was made and before the save → the rows carry the new one (the session's snapshot is not used). Missing row or empty address (injected) → `null`, and the save still succeeds. A non-protected save, a no-op or a refusal → no row (as T58). |
| AC-9.11 | A-int (clock) | After the version is stored, the actor's `email` and `name` are changed and the actor is soft-deleted. The notice then sent to the other recipients still states the captured address. The actor's own rows end `given_up` `recipient_deleted` as before. A retry sends the same words. No update of a row touches `authorEmail`. |
| AC-9.11 | A-unit, N-int | The save and restore lines carry the address in `en` and `it`. `null` and an unusable address give the no-email sentence in both languages, and everything else of the list is still stated. `emailData(...).actorEmail` is the address or `null`. The template renders the address escaped (`<`, `&`, `"` in a hostile local part) with no `mailto:`, and `null` as the no-email sentence. Longest case: a 320-character address stays within 200/2000, and the push payload is under 3000 bytes with nothing shrunk. Copy parity of `en` and `it`. |
| AC-9.11 | E2E | The notice body (en and it) contains the actor's account email. |
| AC-9.12 | A-int, N-int | **Sentinel display name** `D9 Sentinel Display Name` on the actor: it is absent from every request auth sends, every row, every audit entry and every log line, from the stored notification and from the rendered email. **Sentinel address** `d9-sentinel-author@operai.test`: it appears only in the J6 "allowed" places, and never in a log line (dispatcher success, failure and error; a failed save; notify-api) nor in an audit entry, a title or a subject. **notify-api:** an `actorName` member → 400; `actorEmail` missing, not an address, or over 320 characters → 400, and the 400 body does not contain the value. The existing value sentinels stay. |
| AC-9.12 | E2E | The actor renames themselves to a sentinel through `POST /auth/update-user` before the save, using a dedicated persona so the history assertions of other specs keep their names. The sentinel is absent from the in-app notice (title and body, en and it), and the account email is present. |
| AC-9.10, AC-9.13 | A-int | The outside row's email `data` carries the same `actorEmail` as the person rows. |
| AC-9.16 | A-int | Unchanged tests: the first and repeated import apply → 0 notice rows and 0 calls. The capture lives only in `recordNoticeDuty`, which `import.ts` does not import (existing scan). The system never has an author address to state. |

**Coverage check:** 52 ACs, the same set. AC-9.11, AC-9.12 and AC-9.16 are re-mapped above. AC-9.10 and AC-9.13 gain
one assertion each. Every other row of "Test strategy — US-9" and H10 stands. The mapping is total.

### J9 — Risks (added)

| # | Risk | Mitigation / early check |
| --- | --- | --- |
| R26 | An account address that fails the shared rule (over 320 characters, or a form zod refuses) would make notify-api refuse the email channel of every notice by that author. | `content.ts` applies the same rule first, under reading R-D9a. Early check **T87**: a read-only count, over production `user` rows, of addresses that fail the rule. Only the count is recorded, never an address. Sign-in is by Google or GitHub only, so 0 is expected. |
| R27 | Wider reach of personal data: the author's address now goes to every recipient, the outside mailbox and lock screens, and is stored in notify-api's notifications and the outbox. | Owner-accepted (AC-9.12, Non-goals). J6 keeps it out of logs, audit and keys, and J6 records the retention note. |
| R28 | The push-1 cut misses T79: every notice email gets 400, is retried, then given up. | J7 checks at T16 and T48. The give-ups are audited and visible. QE (T85) rehearses the pairing. |
| R29 | Notices written by a pre-D9 build (development databases only) say "no email address on record". | Production never runs a pre-D9 notice build: T48 depends on T80 and T81. |

### J10 — Security

**YES**, unchanged. An `owasp-reviewer` **delta** pass (T86, frontier tier: financial data, R1) runs in parallel
with the QE delta (T85). Surfaces:

- the capture in `notices/duty.ts`: read inside the transaction, never from the session; written once;
- the new column, and the claim's `RETURNING`;
- `content.ts`/`copy.ts`: no path from `createdByName` or `user.name` into a notice; R-D9a;
- notify-api `emails.schemas.ts` (the `actorEmail` rule, the strict shape, a 400 that does not echo the value) and
  `emailTemplates.ts` (escaped text, no link, no name fallback);
- the push text;
- log and audit privacy across auth and notify-api.

The pass also confirms that N1 / O-1 is closed. The display name stays editable (fix 1 of N1 was not chosen), and
it still shows in the history, which is out of D9's scope (OQ-16).

### J11 — Spec drift and readings

- **R-D9a (reading, proposed for the owner; not blocking).** The spec defines what a notice says when the account
  had **no** email address, but not when the recorded address is not a well-formed one. The plan reads it as "no
  email address on record", because it must never fall back to the display name. A notice must still go out, since
  it is the safeguard. The case is believed unreachable (R26, T87).

  Proposed sentence for AC-9.11: *"An email address that is not a valid email address counts as no email address on
  record."* Until the owner decides, the plan applies this reading.
- design.md, for the designer (T78), not spec drift: commit `d1da2ecc` left three contradictions in it. The
  "Decided by the orchestrator …, approved by the owner on 2026-11-18 (built as decided; not owner-approved yet)"
  heading, the unticked DR-14/DR-17 boxes, and the open "N1 / O-1" item.
- This commit corrects the same kind of stale text in this plan: H1's last bullet, H2's intro and H7's intro said
  "Proposed" or "None is owner-approved yet" after the owner's approval.
- No other drift was found. D9 is buildable as written.

### J12 — ADR candidates

- **D9-1.** "A notice identifies its author by the account email captured in the version's transaction, and that
  address is the one personal value a notice carries." It records J2's choice (the outbox column, not the Tier 1
  version, and not a send-time read) and the content rule of J4–J6.
  - It **amends** ADR 5 (`20261117-notices-of-…-audit-log.md`): point 3 "The rows hold no value", its open note on
    N1, and its GDPR line.
  - It **amends** ADR 6 (`20261117-notify-api-system-routes-…-closed-typed-data.md`): point 7 (a bounded actor name
    becomes `actorEmail`) and its GDPR line "No address is added to any request". auth now sends **one** person's
    address as **content**, never as addressing. Recipient addressing by `recipientId` is unchanged, so ADR
    20261101 and ADR 6's rejected Option E still hold.
  - For the `adr-writer`: a new short record with forward pointers in ADR 5 and ADR 6.
