---
spec: 20261117
generated: 2026-11-17
---

# Tasks: Legal entities — one registry of the group's companies, for every tool

Derived from `spec.md` (approved, D1–D6), `plan.md` (approved, with "Amendment 2026-11-17 after design" E1–E14)
and `design.md` (draft; owner decisions Q1=B, Q2=B, Q3=B; DR-1–DR-12 adopted).
Re-synced 2026-11-17 with spec US-9 (AC-9.1–AC-9.17), `plan.md` "Amendment 2026-11-17 after security review"
(G1–G16: US-9, F2–F7, FU-1–FU-10, the release at the end) and `security-review.md` (T46): new tasks T51–T71 at the
end of this file; T16, T40, T43, T44, T45, T47, T48 and T50 amended in place.

Reading the list:

- **Release.** Every task belongs to one push of the plan's release order (E10): **push 1** (expand: auth,
  `@operai/ui`, shell) or **push 2** (switch: crm-api, crm-ui, letterhead-api, letterheads-ui, admin-ui). Push-1
  tasks are merged to `main` first, on their own (T16); push-2 commits are merged only after release steps 2–4
  (T17, T18, T48). If commits interleave on the branch, the push-1 merge is cut by cherry-picking the push-1
  tasks' commits onto a release branch; no push-2 task is a dependency of a push-1 task (checked below).
- **Release at the end (owner, 2026-11-17; plan G15).** Push 1 is no longer released early: both pushes go out at the
  end, in one release session — QE (T45) and the security re-review (T70), then T16 (push 1, now with notify-api) →
  T17 → T18 → T48 (push 2, now with auth's US-9 notices) → T49 → T71 (notice path confirmed; only then may managers
  other than the `admin` role be granted). The push-1 cut by cherry-picking is unchanged.
- **Library rule for push 2 (plan E10).** Only admin-ui may use what push 1 adds to `@operai/ui` (`wrap`,
  `ErrorSummary`, `VersionTable`, `VersionBanner`), because it ships after a shell that has them is live. crm-ui
  and letterheads-ui tasks (T30–T32) use existing exports only.
- **Owner tasks** are marked **[OWNER]**: they need production credentials, a release push or the owner's
  sign-off, and are never run by an agent. An agent may prepare their commands and read their outputs.
- **Gate R13 — lifted by the owner on 2026-11-17.** specs/20261116 is stuck after its bounded eval loop; its code is
  merged and live. Tasks once marked with the gate start when their deps allow, on main as it is; any later fix of
  that spec is rebased onto this work (plan R13 stays a risk, not a gate).
- **Paths.** `letterhead-api/` paths: `engine/` = the pure crate, `api/` = the supervisor. The shared engine copies
  `crm-api/src/offers/engine/**` and `crm-ui/src/lib/offerEngine/**` are not touched by any task (plan E14).
- **Follow-ups that are not tasks** (they serve no AC of this spec): letterheads-ui moves onto the lifted
  `ErrorSummary`/`VersionTable`/`VersionBanner` as thin adapters, after specs/20261116 is done (plan E9); the
  contract release (release step 6: drop the CRM columns, the `issuerAddressLines` field and the legacy-key
  tolerance), named in the push-2 changeset as the next step.

## Push 1 — auth

- [x] T1: auth — the `legal_entity_version` table, its checks and immutability triggers, and the one list of entities — refs: AC-1.1, AC-2.7 — deps: none
  - touch: `auth/prisma/schema.prisma`, `auth/prisma/migrations/*`, `auth/src/legalEntities/entities.ts`, `auth/src/legalEntities/immutability.contract.test.ts`, `auth/src/legalEntities/testDb.ts`, `auth/src/admin/users.routes.ts`
  - agent: backend-dev · push 1
  - Details:
    - Prisma model `LegalEntityVersion` and the migration with the hand-appended SQL of plan § Data model: the
      five CHECKs, the row trigger (UPDATE, DELETE) and the statement trigger (TRUNCATE), both raising
      `legal_entity_version_immutable`.
    - `LEGAL_ENTITIES = ["welld_it","welld_ch"]` in `entities.ts`; `ENTITY_VALUES` of `users.routes.ts` imports it.
    - `testDb.ts`: the registry tests' isolation (a rolled-back transaction, or a database per file from a
      template), because Tier 1 rows cannot be deleted (R10).
  - done when: `bun run db:deploy` applies on compose; the contract test shows raw `UPDATE`, `DELETE` and
    `TRUNCATE` raise `legal_entity_version_immutable`, and an insert of `welld_de`, of version 0, of an `import`
    with a creator, of an `import` at version 2, and of a `restore` without `restoredFrom` is refused; the whole
    auth suite (`bun test` in `auth/`) is green.

- [x] T2: auth — the rules of a save: normalisation, validation, IBAN, print form, changed fields, restorable (`rules.ts`) — refs: AC-1.2, AC-1.3, AC-1.4, AC-2.1, AC-2.4 — deps: none
  - touch: `auth/src/legalEntities/rules.ts`, `auth/src/legalEntities/rules.test.ts`
  - agent: backend-dev · push 1
  - Details:
    - Plan § "Normalisation and rules of a save": NFC then trim; blank address lines removed; required set;
      `line_break` and `control_character` sets; limits in code points; IBAN whitespace removal, upper case,
      format and mod 97; `ibanPrint` in groups of four.
    - `problems` with the line semantics of E5 (`line` = position in the submitted array before blank removal;
      `required` and `too_many_lines` carry none; `limit` on `too_long`/`too_many_lines`).
    - `invalid(stored)` with the shape of E6 (no `required`; `line` = stored index).
    - `missing`, `complete`, `changedFields(prev, next)` over the closed set, `sameDetails` after normalisation,
      `restorable(details)` (E1).
  - done when: `bun test src/legalEntities/rules.test.ts` passes with the cases of the plan's AC-1.2, AC-1.3 and
    AC-1.4 rows (every boundary 200/201, 120/121, 4/5 lines, 40/41, 34/35, emoji counts 1, U+00A0 and U+3000
    blanks, tab, U+0000, U+007F, U+0085, lone surrogate, a CH and an IT IBAN plus 3 reference IBANs, one changed
    digit, `CH93-…`), the E5 line positions (blank line at 1 and an over-long line at 2 → `line: 2`), the AC-2.1
    no-op equivalences (IBAN spaces/case, trailing blanks, a blank address line, NFD vs NFC), and `restorable`
    false for an incomplete or out-of-rule version.

- [x] T3: auth — `ADMIN_CATALOG` with `legal-entity:manage` (entity condition), `admin` out of `SUITE_APPS`, the admin role's grant — refs: AC-4.1 — deps: none
  - touch: `auth/src/authz/catalogs/admin.ts`, `auth/src/authz/catalogs/admin.test.ts`, `auth/src/authz/seed.ts`, `auth/src/authz/seed.test.ts`, `auth/src/authz/catalogs/uniqueResourceKeys.test.ts`
  - agent: backend-dev · push 1
  - Details: plan decision 4 — resource `admin` (`access`) and `legal-entity` (`manage`,
    `supportedConditions: ["entity"]`), registered in `DECLARED_CATALOGS`; `seedAdminCatalog`;
    `seedLegalEntityGrants` (admin role, unconditioned, `ensureGrant`), both called from `seed()`.
  - done when: catalog test lists `legal-entity:manage` with `["entity"]` under `admin`; seed test: run twice,
    the admin role holds the unconditioned grant once, `admin:access` still exists, `SUITE_APPS` no longer
    registers `admin`, no role other than `admin` gets the grant; `uniqueResourceKeys` passes with `admin` in
    `DECLARED_CATALOGS`.

- [x] T4: auth — coverage of `legal-entity:manage` per entity, and `admin` derived into `/authz/me` `apps` — refs: AC-4.2, AC-4.3 — deps: T1, T3
  - touch: `auth/src/legalEntities/coverage.ts`, `auth/src/legalEntities/coverage.test.ts`, `auth/src/authz/authz.routes.ts`, `auth/src/authz/authz.routes.test.ts`
  - agent: backend-dev · push 1
  - Details: `coveredEntities(perms, user)` and `adminAreaReachable(perms, user)` over `entityGrantFor`
    (`auth/src/authz/resolver.ts`, unchanged); `/authz/me` adds `"admin"` to `apps` when ≥ 1 entity is
    covered (decision 5). `/authz/resolve`, `/authz/app-access-check` and the directory filter are unchanged.
  - done when: unit tests — unconditioned grant covers both; conditioned grant + user entity welld_ch covers
    only welld_ch; user entity null + conditioned covers none; an unrecognised condition covers none (fail
    closed); route test — `apps` gains `admin` only with coverage ≥ 1, and is unchanged for every other caller.

- [x] T5: auth — the person read API: one serializer, `GET /legal-entities[/{entity}]`, `GET /legal-entities/manageable`, and the shared fixture — refs: AC-1.1, AC-3.1, AC-3.4, AC-4.3 — deps: T1, T2, T4
  - touch: `auth/src/legalEntities/serialize.ts`, `auth/src/legalEntities/serialize.test.ts`, `auth/src/legalEntities/repo.ts`, `auth/src/legalEntities/read.routes.ts`, `auth/src/legalEntities/read.routes.test.ts`, `auth/src/index.ts`, `specs/20261117-legal-entities/fixtures/legal-entities.json`
  - agent: backend-dev · push 1
  - Details: plan § API contracts "Details" with `invalid` items of E6; `version: 0` with empty values before the
    move; `Cache-Control: no-store`; 404 `unknown_legal_entity` fixed body, name not echoed; `manageable`
    registered before `/{entity}` (E2). The fixture holds both entities, one complete and one with a moved
    5-line address, a 121-character line and a bad-check-digit IBAN (CT for crm-api and letterhead-api).
  - done when: route tests — a person with no role reads the list and one entity (IBAN included); no
    cookie/token → 401; `/legal-entities/welld_de`, `%00` and a 300-character name → identical 404 bodies that
    do not contain the name; `manageable` → `["welld_ch"]` for a welld_ch-conditioned holder, `[]` without a
    grant; the serializer test asserts its output byte-equals the fixture for the fixture's rows.

- [x] T6: auth — the service read API: `GET /system/legal-entities[/{entity}]`, the scope `legal-entities:read`, the per-service limit — refs: AC-3.2, AC-3.4 — deps: T5
  - touch: `auth/src/legalEntities/system.routes.ts`, `auth/src/legalEntities/system.routes.test.ts`, `auth/src/system/serviceClients.ts`, `auth/src/system/serviceClients.test.ts`, `auth/src/system/systemRateLimits.ts`, `auth/src/system/systemRateLimits.test.ts`, `auth/src/system/systemCapacity.contract.test.ts`, `auth/src/index.ts`
  - agent: backend-dev · push 1
  - Details: in-process JWT verification as `userContact.routes.ts` (RS256, issuer, `aud = SERVICE_AUDIENCE`,
    `sub = system:*`, scope); one frozen 401; limiter `legalEntities` (300 per window); the person route's handler
    and serializer. `KNOWN_SERVICE_SCOPES += legal-entities:read`; `DOCUMENTED_CLIENT_SCOPES`: `crm-api` +=
    it, new `letterhead-api`.
  - done when: a service JWT with the scope gets a body byte-equal to the person route's (same rows); without
    the scope, a person JWT, a wrong audience and an expired token get the identical frozen 401; the 301st call
    in a window → 429; `parseServiceClients` accepts the new scope and refuses an unknown one; capacity contract
    test green.

- [x] T7: auth — history and version view: `GET …/versions` (with `restorable`) and `GET …/versions/{n}` — refs: AC-2.2, AC-2.3, AC-2.4, AC-4.3, AC-7.2 — deps: T2, T5
  - touch: `auth/src/legalEntities/history.routes.ts`, `auth/src/legalEntities/history.routes.test.ts`, `auth/src/legalEntities/repo.ts`, `auth/src/index.ts`
  - agent: backend-dev · push 1
  - done when: route tests — 403 `forbidden` without a covering grant; a welld_ch-only manager reads both
    histories; items newest first, every version, `createdBy` null for the import, `changedFields` as stored,
    `restorable` false for an incomplete/out-of-rule version and true otherwise (E1); `versions/{n}` returns all
    details of n plus `action`, `restoredFrom`, `createdBy`, `createdAt`; unknown n → 404 `version_not_found`.

- [x] T8: auth — save and restore: advisory lock, conflict, no-op, not moved, audit in the same transaction — refs: AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-2.1, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-4.2 — deps: T2, T4, T7
  - touch: `auth/src/legalEntities/write.routes.ts`, `auth/src/legalEntities/write.routes.test.ts`, `auth/src/legalEntities/routerTable.test.ts`, `auth/src/legalEntities/repo.ts`, `auth/src/index.ts`
  - agent: backend-dev · push 1
  - Details: plan sequences "Save" and "Restore"; strict schema with ≤ 16 lines per language (E5); 16 KiB bound;
    `withAudit` (`legal_entity.save` / `legal_entity.restore`, before/after of each changed value only).
  - done when: route tests — each refusal of the plan's table (401, 403 and nothing written, 409
    `version_conflict` + `currentVersion`, 409 `legal_entity_not_moved`, 413, 422 `invalid_request` without
    echoing a member name, 422 `invalid_legal_entity` with every problem); a one-value change → 201 version n+1
    with the person and time; an equivalent body → 200 `created: false`, no row, no audit row; restore 2 when 4
    is current → version 5 equal to 2 with `restoredFrom: 2`; restore of a non-restorable version → 422; a
    forced failure after the insert leaves neither row nor audit; 20 parallel saves leave contiguous versions;
    the router table has no PUT/PATCH/DELETE under `/legal-entities`; the static scan finds no mutating call on
    `legalEntityVersion` in `auth/src`; `audit-immutability.contract.test.ts` still passes.

- [x] T9: auth — the import script (dry run, `--apply`), its report and stop rule, the MIG fixture set and `mise run legal-entities:import` — refs: AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.5 — deps: T1, T2
  - touch: `auth/scripts/import-crm-legal-details.ts`, `auth/src/legalEntities/import.ts`, `auth/src/legalEntities/import.test.ts`, `specs/20261117-legal-entities/fixtures/crm-entity-profiles.json`, `mise.toml`
  - agent: backend-dev · push 1
  - Details:
    - Plan sequence "Copy (script)" with the stop rule, categories and gate of E11: never a refusal while the
      CRM columns exist; `inserted` / `present` / `resolved` / `mismatched` plus `incomplete`, `invalid`,
      `ibanPrintChanged`; exit 2 `crm_legal_columns_absent` once they are dropped; read-only CRM session; no
      value printed; version 1 and its `legal_entity.import` audit row in one transaction.
    - `crm-entity-profiles.json`: the MIG fixture set (complete; missing VAT; no row; 5 address lines; IBAN with
      spaces and lower case; IBAN with bad check digits; a value with a line break). T24 reads it too.
    - `mise.toml`: task `legal-entities:import` (local URLs, `--apply`).
  - done when: `import.test.ts` against compose, on the fixture set: dry run writes nothing; apply → version 1 per
    entity with the mapping (legal name, VAT, IBAN electronic form, address lines in both languages, contacts
    empty), `action: import`, `createdByUserId: null`, one audit row with actor null; second apply → inserted 0,
    present 2, exit 0, no new version or audit row; CRM value changed afterwards → `mismatched`, registry
    untouched; then a registry save carrying the change → `resolved`; an attempted write on the CRM connection
    fails; stdout contains none of the fixture's values (marker scan); with the CRM columns dropped → exit 2
    `crm_legal_columns_absent`; `ibanPrintChanged` true exactly for the fixtures whose typed IBAN text differs
    from `ibanPrint`.

## Push 1 — `@operai/ui` (shipped by the shell)

- [x] T10: `@operai/ui` — `Tabs` and `TabNav` can wrap (opt-in `wrap`) — refs: AC-8.1 — deps: none
  - touch: `operai-ui/src/components/Tabs.tsx`, `operai-ui/src/components/Tabs.stories.tsx`, `operai-ui/src/components/TabNav.tsx`, `operai-ui/src/components/TabNav.stories.tsx`, `operai-ui/src/components/components.test.tsx`
  - agent: frontend-dev · push 1
  - Details: plan E8 — one layout property behind `wrap`, default unchanged; stories with long labels carrying
    badges, at 320 px.
  - done when: component tests — with `wrap` the list wraps (no horizontal scroll container), without it the
    rendered markup is unchanged (snapshot of the existing stories); `mise run ui:check` green.

- [x] T11: `@operai/ui` — lift `ErrorSummary`, `VersionTable` and `VersionBanner` — refs: AC-2.2, AC-2.3, AC-8.1 — deps: none
  - touch: `operai-ui/src/components/ErrorSummary*`, `operai-ui/src/components/VersionTable*`, `operai-ui/src/components/VersionBanner*`, `operai-ui/src/index.ts`, `operai-ui/docs/design-system.md`, `operai-ui/docs/decisions.md`
  - agent: frontend-dev · push 1
  - Details: plan E9 and design.md's LIFT table — presentational, no app strings, no fetching; built from
    `letterheads-ui/src/components/ErrorSummary.tsx`, `HistoryPanel.tsx`, `HistoryPanelVersion.tsx`, which are
    **not** edited. Record the decision (and the letterheads follow-up) in `docs/decisions.md`.
  - done when: each component has a story and a test (axe 0 violations; `ErrorSummary` is an assertive alert with
    one button per item that calls `onGo(id)`; `VersionTable` has a caption, row headers, row-named Open/Restore
    buttons and an `aria-disabled` Restore with its description; `VersionBanner`'s heading takes focus on mount);
    the three are exported from `index.ts`; `mise run ui:check` green.

## Push 1 — configuration contract and release plumbing

- [x] T12: Config contract and runbook — env-doctor link and template for `letterhead-api`, crm-api's scope, `infra/README.md`, `auth/.env.example` — refs: AC-3.2, AC-7.4, AC-7.5 — deps: T6, T9
  - touch: `tools/env-doctor/manifest.ts`, `tools/env-doctor/check.test.ts`, `tools/env-doctor/live.test.ts`, `tools/env-doctor/resolve.test.ts`, `tools/env-doctor/retiredToken.test.ts`, `tools/env-doctor/templates/production/letterhead-api.env`, `infra/README.md`, `auth/.env.example`, `auth/Dockerfile`
  - agent: devops · push 1
  - added 2026-11-17 (T9 report): auth's production image copies only `src` and `prisma`; copy
    `scripts/import-crm-legal-details.ts` too, and check on the real image (bun 1.3-alpine) that the CRM session
    opens read-only (`default_transaction_read_only`), else the script fails closed with `crm_not_read_only`.
  - Details:
    - Manifest: crm-api link `requiredScopes += legal-entities:read`; a new link for caller `letterhead-api`
      (`legal-entities:read`); the template gains `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`.
    - `infra/README.md`: release steps 1–6 as amended (E10, E11, step 5b), the `letterhead-api` client and its
      shared secret, the copy runbook (dry run / apply / dry run, categories, gate, `crm_legal_columns_absent`),
      "grant managers only after push 2", "registry saves after the switch are not in the CRM" (undo).
    - `auth/.env.example`: a local `SERVICE_CLIENTS` example with `letterhead-api`.
    - `.railway/railway.ts` is **not** changed (plan E14): no new service, domain or bucket; variables unmanaged.
  - done when: `mise run env:doctor` passes locally; the env-doctor tests pass with the new link (a resolved
    production fixture without the scope fails naming `letterhead-api` and `legal-entities:read`); the README
    runbook names every command of T17, T18, T48 and T49.

- [x] T13: Changesets for push 1 — auth (minor), `@operai/ui` (minor), shell (patch: ships the new library) — refs: AC-1.1, AC-3.1, AC-3.2, AC-4.1, AC-4.3, AC-8.1 — deps: T3, T4, T6, T8, T9, T10, T11, T12
  - touch: `.changeset/*`
  - agent: backend-dev · push 1
  - done when: `pnpm exec changeset status --verbose` lists auth, ui and shell with these bumps;
    `node scripts/check-changeset.mjs --base=origin/main --head=HEAD` exits 0 for the push-1 commits.

## Owner steps before the switch

- [x] T14: **[OWNER]** Decide spec drift D7 (letterhead AC-1.8 "same pages" vs AC-5.2) and D8 (AC-7.3 "incomplete" vs Needs correction) — refs: AC-5.2, AC-7.3 — deps: none
  - touch: `specs/20261117-legal-entities/spec.md`, `specs/20261116-letterhead-service/spec.md`
  - agent: owner (the product-owner agent writes the amendment the owner dictates)
  - done when: both spec files carry the owner's decision (amendment applied or rejected, dated); if D8 is
    rejected, T36's status labels are re-synced before T36 starts.

- [ ] T15: **[OWNER]** Early check R2 — read both IBANs in production CRM Settings and note whether grouping in fours changes their print — refs: AC-7.5 — deps: none
  - touch: `specs/20261117-legal-entities/release-log.md`
  - agent: owner
  - done when: the release log says, per entity, "IBAN print unchanged / changes" (no IBAN written in it).

- [ ] T16: **[OWNER]** Release push 1 (expand): merge the push-1 tasks to `main`, cut the release, push — refs: AC-1.1, AC-3.1, AC-4.1 — deps: T13, T15, T45, T69, T70
  - touch: `CHANGELOG.md`, `*/CHANGELOG.md`, `*/package.json`, `shell/src/lib/suiteVersion.generated.json`, `.changeset/*`, `specs/20261117-legal-entities/release-log.md`
  - agent: owner (RELEASING.md)
  - note (T29 report, 2026-11-17): the feature branch interleaves push-2 commits (crm-api T29 onwards) with push-1
    ones, so push 1 is NOT the branch head. Build it as a branch from `main` holding only the push-1 commits (auth,
    operai-ui, shell, docs/specs, their changesets), rebased in branch order; T29 must ship with T26 in push 2, or
    the CRM settings stop saving the legal fields while documents still read them.
  - note (owner, 2026-11-17; plan G15): push 1 is released at the end, in the same session as push 2, after QE
    (T45) and the security re-review (T70). It now also carries notify-api (T56, T57) and the push-1 auth fixes and
    check route (T52–T55); its changesets are T13's and T69's. Push-2 commits of this amendment (T58–T66) stay out.
  - done when: auth `/health` reports the new version; signed in, `GET /legal-entities` answers both entities
    with `version: 0`; notify-api `/health` reports its new version; `https://operai.welld.io/version.json` reports
    the push-1 version (the library change is live, E10); `railway config plan` shows no drift; logged in the
    release log.

- [ ] T17: **[OWNER]** Release step 2 — credentials: auth `SERVICE_CLIENTS` (crm-api scope += `legal-entities:read`; new `letterhead-api` entry), the shared secret, letterhead-api `SERVICE_CLIENT_ID`/`SECRET` — refs: AC-3.2 — deps: T16, T12
  - touch: `specs/20261117-legal-entities/release-log.md`
  - agent: owner (devops may prepare the commands)
  - done when: auth restarted healthy with the new `SERVICE_CLIENTS`; `mise run env:doctor -- --env production
    --resolve` green; logged (no secret in the log).

- [ ] T18: **[OWNER]** Release step 3 — the copy: announce the CRM-settings freeze; dry run, `--apply`, dry run; read the flags and sign off the IBAN print — refs: AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.5 — deps: T17, T15, T9
  - touch: `specs/20261117-legal-entities/release-log.md`
  - agent: owner (production credentials in the environment only)
  - done when: the last dry run reports both entities `present` (or `resolved`) and `mismatched` 0; the release
    log holds the three reports (counts and flags only), the owner's sign-off of every `ibanPrintChanged` (D2) and
    of every `incomplete`/`invalid` flag (D3), and the freeze announcement's date.

## Push 2 — letterhead-api

- [x] T19: letterhead-api engine — content version 2, optional `legalEntityVersion`, `entityData` parsed in both versions — refs: AC-5.2 — deps: none
  - touch: `letterhead-api/engine/src/content/**`
  - agent: backend-dev (Rust) · push 2
  - done when: `cargo test -p letterhead-engine content::` — v1 and v2 accepted; 0 and 3 → `unsupported_content_version`;
    `legalEntityVersion` accepted only in v2 (a v1 carrying it is refused as an unknown member, as today); v2
    with or without `entityData` accepted, v1's structural check unchanged; the golden corpus and pinning tests
    pass unchanged.

- [x] T20: letterhead-api engine — "mark missing" for the configurator preview: label in the missing look, segment kept, `⟦Label⟧` in the page text — refs: AC-5.3, AC-5.4 — deps: none
  - touch: `letterhead-api/engine/src/resolve/**`, `letterhead-api/engine/src/layout/frame/**`, `letterhead-api/engine/src/layout/mod.rs`, `letterhead-api/engine/src/output/text.rs`, `letterhead-api/engine/src/render.rs`, `letterhead-api/engine/src/sample/**`
  - agent: backend-dev (Rust) · push 2
  - Details: plan E3 (closed labels, both languages); a render option that only the supervisor's preview job sets.
  - done when: unit tests — with the option, an empty `{iban}` prints `⟦IBAN⟧` in the missing look, its
    conditional segment stays, and the page text holds `⟦IBAN⟧`; without it, AC-5.3's behaviour (prints nothing,
    segment dropped, `missingPlaceholders` lists it); the full golden corpus is byte-identical.

- [x] T21: letterhead-api — service token client and the registry cache (fresh 30 s, usable 60 s, sent-time stamp), env `SERVICE_CLIENT_ID`/`SECRET` — refs: AC-1.5, AC-3.3, AC-5.5 — deps: T5, T6
  - touch: `letterhead-api/api/src/registry/**`, `letterhead-api/api/src/env.rs`, `letterhead-api/api/src/main.rs`, `letterhead-api/api/Cargo.toml`, `letterhead-api/Cargo.lock`, `letterhead-api/api/tests/registry.rs`, `letterhead-api/README.md`, `compose.yaml`, `mise.toml`
  - agent: backend-dev (Rust) · push 2
  - Details: plan decision 7 and sequence "Consumer read" (single flight, 5 s timeout, no redirects, ≤ 64 KiB,
    401 → drop token and retry once; secret only in the supervisor); `registry::entity_data(details, language)`
    builds the job's `EntityData` (`address[lang]`, `contacts[lang]`, `ibanPrint`). Local defaults in
    `compose.yaml` and `mise.toml` `dev:letterhead`.
  - done when: `cargo test -p letterhead-api registry` with a fake clock and a fake auth — age 29 s used without a
    call, 31 s refreshed, refresh failing at 59 s uses the entry and logs `registry_stale_used`, at 61 s → 
    unavailable; property test: a document started at T+60.001 never uses an entry sent before T; the shared
    fixture parses; the secret appears in no log or `Debug` output; startup exits non-zero without either variable.

- [x] T22: letterhead-api — renders print the registry's issuer: v2, the version pin, 409 mismatch, 503 unavailable, `Legal-Entity-Version`, log fields — refs: AC-1.5, AC-5.1, AC-5.2, AC-5.3, AC-5.5 — deps: T19, T21
  - touch: `letterhead-api/api/src/routes/render.rs`, `letterhead-api/api/src/log.rs`, `letterhead-api/api/tests/render.rs`, `letterhead-api/api/tests/render_db.rs`
  - agent: backend-dev (Rust) · push 2
  - done when: route tests with a fake auth — v2 per entity × language prints the registry's legal name,
    `address[lang]` joined with ", ", VAT, `ibanPrint`, `contacts[lang]` (it and en addresses differ in print);
    v1 with `entityData` "EVIL SA" prints the registry's name and never "EVIL", logs `entity_data_ignored=true`;
    empty IBAN/contacts → AC-5.3; pin older → refresh, still different → 409 `legal_entity_version_mismatch` +
    `currentVersion`; registry down and entry 61 s old → 503 `legal_entities_unavailable` + `Retry-After: 5`, no
    worker job, no partial body; success answers carry `legalEntityVersion` / `Legal-Entity-Version`; a
    200-character legal name that overflows a footer → 422 `footer_overflow` (R9).

- [x] T23: letterhead-api — the configurator preview shows the registry's details (`mark missing`, `issuerDetails`, `legalEntityVersion`) — refs: AC-5.4 — deps: T20, T21
  - touch: `letterhead-api/api/src/routes/preview.rs`, `letterhead-api/api/src/pool/job.rs`, `letterhead-api/api/src/pool/wire.rs`, `letterhead-api/api/src/worker.rs`, `letterhead-api/api/tests/preview.rs`
  - agent: backend-dev (Rust) · push 2
  - done when: route tests — the preview's page text holds the registry's details in the preview language and
    the sample's body; an empty value → `⟦Label⟧` (E3); registry unavailable → still 200, every placeholder
    marked, `issuerDetails: "unavailable"`, `legalEntityVersion: null`; the mark option never reaches a
    `/v1/render/*` job (test on the wire format).

## Push 2 — crm-api

- [x] T24: crm-api — capture the issuer lines today's CRM prints for the MIG fixture profiles (golden, before the switch) — refs: AC-7.5 — deps: T9
  - touch: `crm-api/src/offers/issuerGolden.capture.test.ts`, `specs/20261117-legal-entities/fixtures/issuer-lines.golden.json`
  - agent: quality-engineer · push 2 (must be committed before T26 changes any code)
  - done when: the capture test, run on the pre-switch code, writes for every complete fixture profile the
    classic PDF's issuer text (header/footer/body/author) and the service request's `entityData` and
    `[EMITTENTE]`/`[INDIRIZZO]` body lines, in it and en; re-running it on the same code reproduces the file byte for byte. It runs only with
    `CAPTURE_ISSUER_GOLDEN=1` (skipped otherwise), so the switch tasks compare against the committed file, not a
    re-capture.

- [x] T25: crm-api — registry client with the cache rule, a fake for tests, and a contract test against real auth — refs: AC-1.5, AC-3.2, AC-3.3, AC-5.5 — deps: T5, T6
  - touch: `crm-api/src/lib/legalEntities.ts`, `crm-api/src/lib/legalEntities.test.ts`, `crm-api/src/lib/legalEntities.contract.test.ts`, `crm-api/src/test-support/fakeRegistry.ts`
  - agent: backend-dev · push 2
  - Details: plan decision 7 over `serviceTokens`; fail closed without a client (E14); `invalidate()` for the pin retry.
  - done when: the same clock cases as T21 (29/31/59/61 s, the sent-time property test); the shared fixture parses;
    the contract test (compose auth) reads both entities with a `legal-entities:read` token and gets 401 without it.

- [x] T26: crm-api — the issuer comes from the registry: wizard context per language, the refusals of E4 on every document path, `entity_profile_missing` gone from them — refs: AC-5.5, AC-6.2, AC-6.3, AC-7.3 — deps: T24, T25
  - touch: `crm-api/src/offers/generation.ts`, `crm-api/src/offers/offers.routes.ts`, `crm-api/src/offer-drafts/context.ts`, `crm-api/src/offer-drafts/offerDrafts.routes.ts`, `crm-api/src/offer-templates/offerTemplates.routes.ts`, `crm-api/src/test-support/world.ts`, `crm-api/src/offer-drafts/*.test.ts`, `crm-api/src/offer-templates/**/*.test.ts`, `crm-api/src/offers/offers.test.ts`, `crm-api/src/offers/offers.wizardGuards.test.ts`
  - agent: backend-dev · push 2
  - Details: read the registry before the deal transaction; `WizardContext.issuerLegalName` and
    `issuerAddressLines = address[language]`; context answer gains `issuerAddress {it, en}`, keeps
    `issuerAddressLines` (Italian) for an old crm-ui; a missing profile row no longer refuses (E4).
  - done when: tests — `complete: false` → 409 `legal_entity_incomplete` naming `missing` on generate,
    edit/revise, legacy draft prefill, both previews and try-preview, and no offer number used; registry down
    beyond 60 s → 503 `legal_entities_unavailable` (context too); a complete but out-of-rule entity generates
    (E13); no document route answers `entity_profile_missing`; a deal of an entity with no profile row generates;
    an English offer's body prints `address.en`.

- [x] T27: crm-api — the snapshot and the classic PDF print the registry's values; old offers untouched; the golden comparison — refs: AC-6.2, AC-6.4, AC-7.5 — deps: T26
  - touch: `crm-api/src/offers/generation.ts`, `crm-api/src/offers/contract.ts`, `crm-api/src/offers/contractPdf.ts`, `crm-api/src/offers/pdf.ts`, `crm-api/src/offers/contractPdf*.test.ts`, `crm-api/src/offers/generation.wizardSnapshot.test.ts`, `crm-api/src/offers/parity.test.ts`, `crm-api/src/offers/issuerGolden.test.ts`, `crm-api/src/offers/snapshotsUnchanged.test.ts`
  - agent: backend-dev · push 2
  - done when: tests — snapshot `issuer` from the registry values plus `legalEntityVersion`; the classic PDF prints
    legal name, `address[language]`, VAT and `ibanPrint` in every place it printed them (header, footer, body,
    author); `issuerGolden.test.ts` equals T24's golden for every complete fixture (contacts aside; the IBAN
    grouping difference listed exactly where `ibanPrintChanged` says); offers stored before the change keep the
    same PDF hash and snapshot JSON after the change and after a registry save.

- [x] T28: crm-api — the service path sends content v2 without `entityData`, pins `legalEntityVersion` and retries once — refs: AC-5.2, AC-6.2, AC-7.5 — deps: T27, T22
  - touch: `crm-api/src/offers/blocks.ts`, `crm-api/src/offers/blocks.test.ts`, `crm-api/src/offers/contentSchema.ts`, `crm-api/src/lib/letterheadClient.ts`, `crm-api/src/lib/letterheadClient.test.ts`, `crm-api/src/offers/generation.ts`, `crm-api/src/offers/generation.letterhead.test.ts`, `crm-api/src/offers/offers.letterhead.test.ts`, `crm-api/src/offers/letterheadContract.test.ts`, `crm-api/src/offer-drafts/offerDrafts.routes.ts`, `crm-api/src/offer-drafts/offerDrafts.preview.test.ts`, `crm-api/src/offer-templates/offerTemplates.routes.ts`, `crm-api/src/offer-templates/offerTemplates.tryPreview.test.ts`
  - agent: backend-dev · push 2
  - done when: the client's request schema has no `entityData` and `contentVersion: 2` with the version used;
    a fake service answering 409 mismatch once → invalidate, rebuild, one retry, success; twice → 503
    `layout_service_unavailable`; an old service answering `unsupported_content_version` → 503
    `layout_service_unavailable` (skew fails closed); letterhead-api's `legal_entities_unavailable` → 503
    `layout_service_unavailable`; the contract test against a real letterhead-api (compose) renders v2;
    `issuerGolden.test.ts` passes for the service path.

- [x] T29: crm-api — entity settings keep only the CRM's own values; the legacy keys are accepted and ignored; the defaults migration — refs: AC-6.1 — deps: none
  - touch: `crm-api/src/entity-profiles/entityProfiles.routes.ts`, `crm-api/src/entity-profiles/entityProfiles.retired.test.ts`, `crm-api/src/entity-profiles/entityProfiles.settings.test.ts`, `crm-api/src/lib/nulText.test.ts`, `crm-api/prisma/schema.prisma`, `crm-api/prisma/migrations/*`
  - agent: backend-dev · push 2
  - done when: `GET /entity-profiles` has no `legalName`, `addressLines`, `vatNumber`, `iban`; `PUT` with only
    terms and place creates and updates a row; the four legacy keys are accepted and not stored; any other
    unknown key → refused as today; the migration sets the two defaults and drops nothing; the letterhead upload
    routes still answer `entity_profile_missing` without a row (E4).

## Push 2 — crm-ui

- [x] T30: crm-ui — `useCanManageLegalEntity` and the Settings note in place of the four legal fields — refs: AC-6.1, AC-8.2 — deps: T5, T29
  - touch: `crm-ui/src/hooks/useCanManageLegalEntity.ts`, `crm-ui/src/hooks/useCanManageLegalEntity.test.tsx`, `crm-ui/src/components/LegalEntitySettingsNote.tsx`, `crm-ui/src/components/LegalEntitySettingsNote.test.tsx`, `crm-ui/src/components/EntityProfileForm.tsx`, `crm-ui/src/components/FormDialogs.refusal.test.tsx`, `crm-ui/src/pages/SettingsPage.tsx`, `crm-ui/src/pages/SettingsPage.service.test.tsx`, `crm-ui/src/lib/crmApi.ts`, `crm-ui/src/lib/types.ts`, `crm-ui/src/strings/settings.ts`
  - agent: frontend-dev · push 2
  - done when: Vitest — the form has no legal fields; the note links to `/admin/legal-entities?entity={entity}`
    for a manager of that entity and shows the sentence otherwise, and when `manageable` fails (E2); the hook calls
    auth once per session; `settings.notSet` removed; axe 0 violations on the Settings page; strings parity and
    `noHardcodedStrings` green.

- [x] T31: crm-ui — `LegalEntityNotice`, the refusal codes of E4, and the issuer address in the document's language — refs: AC-5.5, AC-6.2, AC-6.3, AC-8.2 — deps: T30, T26
  - touch: `crm-ui/src/components/offerWizard/LegalEntityNotice*`, `crm-ui/src/lib/offerErrors.ts`, `crm-ui/src/lib/errors.test.ts`, `crm-ui/src/components/offerWizard/useServicePreview.ts`, `crm-ui/src/components/offerWizard/useServicePreview.test.tsx`, `crm-ui/src/components/offerWizard/ServicePreview.tsx`, `crm-ui/src/components/offerWizard/ServicePreview*.test.tsx`, `crm-ui/src/components/offerWizard/DocumentPreview.tsx`, `crm-ui/src/components/offerWizard/DocumentPreview*.test.tsx`, `crm-ui/src/components/offerWizard/OfferWizard.tsx`, `crm-ui/src/pages/OfferWizardPage.tsx`, `crm-ui/src/pages/OfferWizardPage*.test.tsx`, `crm-ui/src/pages/DealSalesFlow.test.tsx`, `crm-ui/src/components/templateEditor/TryWizardView.tsx`, `crm-ui/src/components/templateEditor/TryWizardView.service.test.tsx`, `crm-ui/src/strings/offers.ts`, `crm-ui/src/strings/offerWizard.ts`, `crm-ui/src/lib/crmApi.ts`, `crm-ui/src/lib/types.ts`
  - agent: frontend-dev · push 2
  - done when: Vitest — generate/edit/revise refused 409 `legal_entity_incomplete` → danger notice naming the
    missing values, link for a manager, sentence otherwise; preview panes → polite warning; 503
    `legal_entities_unavailable` → notice with Retry; `entity_profile_missing` handled nowhere but the letterhead
    upload; the wizard reads `issuerAddress[language]` and falls back to `issuerAddressLines` when absent (old
    crm-api); `offers.errors.profileMissing` and `offerWizard.preview.profileMissing` gone (en and it); axe 0
    violations on the notices; strings parity green.

## Push 2 — letterheads-ui

- [x] T32: letterheads-ui — the preview says its details are the registry's, the legend of the missing look, the link, the unavailable state — refs: AC-5.4, AC-8.1, AC-8.2 — deps: T23, T5
  - touch: `letterheads-ui/src/components/PreviewPane.tsx`, `letterheads-ui/src/components/PreviewPane.test.tsx`, `letterheads-ui/src/components/PreviewPaneRequest.ts`, `letterheads-ui/src/hooks/useCanManageLegalEntity.ts`, `letterheads-ui/src/hooks/useCanManageLegalEntity.test.tsx`, `letterheads-ui/src/strings/preview.ts`, `letterheads-ui/src/lib/types.ts`, `letterheads-ui/src/test-support/fakeApi.ts`, `letterheads-ui/src/pages/ConfiguratorPage.save.test.tsx`
  - agent: frontend-dev · push 2
  - done when: Vitest — the old "sample company data" sentence is gone; the source line with a link for a
    manager, the sentence otherwise; the legend shows `⟦ ⟧`; `issuerDetails: "unavailable"` → warning with Try
    again in the preview slot, form and Save unaffected; axe 0 violations; strings parity green.

## Push 2 — admin-ui

- [x] T33: admin-ui — the Legal entities strings (en, it), the section label, the audit description (DR-8) — refs: AC-8.2 — deps: none
  - touch: `admin-ui/src/strings/legalEntities.ts`, `admin-ui/src/strings.ts`, `admin-ui/src/strings/nav.ts`, `admin-ui/src/strings/audit.ts`, `admin-ui/src/strings.test.tsx`
  - agent: frontend-dev · push 2
  - done when: every key of design.md "Copy keys" exists in en and it (`it: typeof en`); parity test green.

- [x] T34: admin-ui — registry API client and the pure mappings (status, problem sentence, value names, address problem target, merge on conflict) — refs: AC-1.2, AC-1.3, AC-2.6, AC-7.3 — deps: T33, T5
  - touch: `admin-ui/src/lib/legalEntit*`
  - agent: frontend-dev · push 2
  - done when: unit tests — `legalEntityStatus` (Complete / Incomplete / Needs correction / Not moved yet, E13);
    `addressProblemTarget` per design table (E5 line, `required` → Line 1, `too_many_lines` → Line 5);
    `problemSentence` per reason; `mergeOnConflict` (mine / theirs / both-changed flagged / address as one value);
    the client parses the shared fixture.

- [x] T35: admin-ui — sections by capability, the `/legal-entities` route with `entity`/`view`/`version`, index and hidden-section redirects — refs: AC-4.3 — deps: T34, T10
  - touch: `admin-ui/src/router.tsx`, `admin-ui/src/router.test.tsx`, `admin-ui/src/components/SectionNav.tsx`, `admin-ui/src/components/SectionNav.test.tsx`, `admin-ui/src/components/AdminShell.tsx`, `admin-ui/src/App.test.tsx`, `admin-ui/src/pages/LegalEntitiesPage.tsx`
  - agent: frontend-dev · push 2
  - Details: plan decision 5 and E7; `LegalEntitiesPage.tsx` created here as the route's minimal host (T36 fills it).
  - done when: router tests — an admin without the grant sees Roles/Departments/Users/Audit and no Legal entities;
    a manager-only person sees only Legal entities and `/` and `/roles` redirect to it after `manageable`
    resolves; `?entity=welld_de`, `?view=x`, `?version=abc` are replaced by defaults (value not rendered);
    `manageable` failing → Banner + Retry, no redirect; the section nav uses `wrap`.

- [x] T36: admin-ui — the page host: entity tabs with status marks, per-entity drafts, Details | History views, read-only panel, leave-the-page guard — refs: AC-1.1, AC-4.2, AC-4.3, AC-7.3, AC-8.1 — deps: T35
  - touch: `admin-ui/src/pages/LegalEntitiesPage*`, `admin-ui/src/components/LegalEntityPanel*`, `admin-ui/src/components/LegalEntityFacts*`, `admin-ui/src/lib/useEntityDrafts*`
  - agent: frontend-dev · push 2
  - Details: design S1, S4, S8 and the three-level keyboard model; tabs replace history entries; the guard only on
    leaving the page (router blocker, `beforeunload`).
  - done when: Vitest — both tabs in fixed order with Complete/Incomplete/Needs correction/Not moved yet and
    Read-only/Unsaved marks in their accessible names; switching entity or view keeps a draft and never prompts;
    leaving with a draft prompts and names the entities; a non-covered entity renders values as facts, no input,
    the info Banner; axe 0 violations on S1 and S4 states.

- [x] T37: admin-ui — the entity form: address line inputs, save, error summary and focus, no-op, 403, failure, moved values marked — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-2.1, AC-7.3, AC-8.1 — deps: T36, T11
  - touch: `admin-ui/src/components/LegalEntityForm*`, `admin-ui/src/components/AddressLinesField*`, `admin-ui/src/components/LegalEntityPanel*`
  - agent: frontend-dev · push 2
  - done when: Vitest — four line inputs per language (one per stored line beyond four for a moved address),
    blanks sent in order; a 422 shows the library `ErrorSummary`, marks each control (exact line) and focuses the
    first in page order; a 201 shows "Version n saved…" and reloads normalised values; 200 `created: false` shows
    the no-op note; 403 turns the panel read-only and drops the draft; 5xx keeps values and base; Save is
    `aria-disabled` with its reason; a moved entity's Banner and per-line marks (S3); axe 0 violations.

- [x] T38: admin-ui — two people editing: the conflict banner, reapply with "Use theirs", discard — refs: AC-2.6, AC-8.1 — deps: T37
  - touch: `admin-ui/src/components/ConflictBanner*`, `admin-ui/src/components/LegalEntityForm*`
  - agent: frontend-dev · push 2
  - done when: Vitest — a 409 keeps the typed values, reads the newer version and its author, shows both actions
    and disables Save; Reapply merges per value and flags both-changed values with "Use theirs", focus to the
    first flagged value; Discard loads version n; the other entity's draft is untouched; axe 0 violations.

- [x] T39: admin-ui — history, version view and restore (with the lifted `VersionTable`/`VersionBanner`) — refs: AC-2.2, AC-2.3, AC-2.4, AC-7.2, AC-8.1 — deps: T36, T11
  - touch: `admin-ui/src/components/LegalEntityHistory*`, `admin-ui/src/components/LegalEntityVersionView*`, `admin-ui/src/components/RestoreDialog*`, `admin-ui/src/components/LegalEntityPanel*`
  - agent: frontend-dev · push 2
  - done when: Vitest — rows newest first with who ("System" for version 1), when and what changed; no Restore on
    the current row; `restorable: false` → Restore `aria-disabled` with its reason; Open pushes `&version=n`, the
    heading takes focus, Back returns focus to the row's Open; the restore dialog names the new version and the
    values that change, handles 422/409/403/5xx as design S7; success focuses the entity heading; read-only
    entity shows Open only; axe 0 violations.

- [x] T40: admin-ui — FU-7 string gaps and FU-8's failing tests fixed, then the accessibility sweep of design.md's list (every screen state incl. S12 and the S5/S7 additions, dark and light, Italian once, 320 px) — refs: AC-8.1, AC-8.2, AC-9.6 — deps: T37, T38, T39, T51, T60, T61, T73
  - touch: `admin-ui/src/pages/LegalEntitiesPage.a11y.test.tsx`, `admin-ui/src/pages/LegalEntitiesPage.test.tsx`, `admin-ui/src/strings/legalEntities.ts`, `admin-ui/src/strings.test.tsx`, `admin-ui/src/lib/legalEntityMappings*`, `admin-ui/src/components/AddressLinesField*`, `admin-ui/src/components/ConflictBanner*`, `admin-ui/src/components/LegalEntityForm*`, `admin-ui/src/components/LegalEntityHistory*`, `admin-ui/src/components/LegalEntityVersionView*`
  - agent: frontend-dev for FU-7/FU-8 (copy from T51), then quality-engineer for the sweep · push 2
  - widened 2026-11-17 (owner): it now also fixes FU-7 (admin-ui string gaps, with the designer's copy from T51)
    and FU-8 (the 2 failing tests of `LegalEntitiesPage.test.tsx`), and checks FU-3 (320 px) on the real page.
    It runs after T60 and T61 so the sweep covers the new dialog and paging states.
  - done when: FU-8 — `LegalEntitiesPage.test.tsx` passes (the two T36 tests wait for `admin-legal-form`); FU-7 —
    every string of design.md's T51 "FU-7" item exists in en and it and is used by its component (the moved-value
    suffix for every moved reason, the 5th-line hint, "Not filled in. Enter …", the `conflict.applied` count phrase
    and the nothing-to-review sentence, no empty "(changed: )", `history.openLabel`/`restoreLabel`/`changedList`/
    `loading`/`failed`, `version.failed`), and `AddressLinesField` has a note slot so the conflict note is in the
    focused line's `aria-describedby`; FU-4's title as T51 decided; axe (WCAG 2.1 A/AA) reports 0 violations on
    S1–S8 and S12 in every listed state, dark and light; at 320 px the entity strip and the section nav wrap with no
    horizontal scroll (FU-3); the page in Italian has `lang="it"` and no English key; every control has a visible
    label; `noHardcodedStrings`, strings parity and the whole admin-ui suite green.

## End-to-end

- [x] T41: e2e fixtures — test users with the grant and an entity attribute, the registry seeded by the import, CRM helpers moved off the legal fields — refs: AC-4.3, AC-6.2 — deps: T9, T29, T8
  - touch: `shell/e2e/helpers/legalEntitiesFixtures.ts`, `shell/e2e/helpers/crmOfferFixtures.ts`, `shell/e2e/fixtures/crmOfferService.ts`, `shell/e2e/global-setup.ts`, `shell/playwright.config.ts`
  - agent: quality-engineer · push 2
  - done when: a smoke spec run shows the global setup leaves both entities at version ≥ 1 and complete
    (`legal-entities:import` then a registry save by the admin fixture), creates a welld_ch-conditioned manager and
    a no-grant user; `ensureEntityProfile` no longer sends legal keys; the issuer text helper reads the registry.

- [x] T42: e2e — the Legal entities page: reach by capability, edit, refusal, conflict, history and restore, keyboard only, axe — refs: AC-1.1, AC-2.3, AC-2.6, AC-3.1, AC-4.1, AC-4.2, AC-4.3, AC-8.1, AC-8.2 — deps: T41, T38, T39, T4
  - touch: `shell/e2e/legal-entities*.spec.ts`
  - agent: quality-engineer · push 2
  - done when: Playwright green — the welld_ch manager sees Admin with only Legal entities, welld_ch editable and
    welld_it read-only, `/admin/roles` redirects; a no-grant user sees no Admin tool and reads the details through
    `GET /legal-entities`; an admin edits the role editor's `legal-entity:manage` conditioned and unconditioned;
    two sessions → conflict → reapply; the design's keyboard-only path end to end; Italian once; `axeViolations`
    0 on each screen.

- [x] T43: e2e — CRM and the configurator use the registry: Settings note, refusal of an incomplete entity, issuer in classic and service offers, preview with real details — refs: AC-5.4, AC-6.1, AC-6.2, AC-6.3 — deps: T41, T28, T30, T31, T32, T23, T63, T64, T65, T66
  - touch: `shell/e2e/crm-legal-entities.spec.ts`, `shell/e2e/crm-offer-wizard.spec.ts`, `shell/e2e/crm-offer-wizard-pages.spec.ts`, `shell/e2e/crm-offer-wizard-revise.spec.ts`, `shell/e2e/letterheads.spec.ts`, `shell/e2e/fixtures/letterheads.ts`
  - agent: quality-engineer · push 2
  - done when: Playwright green — Settings shows the note (link for the manager, sentence for a `deal:financials`
    holder); after a registry save the next classic and service offer print the new legal name, the English
    address for an English offer and the grouped IBAN; an entity saved incomplete via the API is refused with the
    notice; the configurator preview shows the registry's values and `⟦Label⟧` for an empty contacts line.
    Added 2026-11-17: the classic Generate dialog shows the notice with the link for a manager (FU-2); an
    overflowing legal name's notice points at Legal entities (FU-1); the sample intro no longer calls the company
    details samples (FU-9).

## Push 2 — release plumbing

- [x] T44: Changesets for push 2 — crm-api, crm-ui, letterhead-api, letterheads-ui, admin-ui (minor each) and auth (minor: US-9 notices), naming release step 6 as the next step — refs: AC-4.3, AC-5.1, AC-5.4, AC-6.1, AC-6.2, AC-9.7 — deps: T13, T16, T23, T28, T29, T31, T32, T40, T58, T59, T60, T61, T62, T63, T64, T65, T66
  - touch: `.changeset/*`
  - agent: backend-dev · push 2
  - note (2026-11-17): T16 now runs at the end (G15), so this task follows it in the same release session; the dep on
    T16 stays (push-2 changesets must not be consumed by the push-1 cut).
  - done when: `changeset status --verbose` lists the six packages; `check-changeset.mjs` exits 0 for the push-2
    commits; the crm-api changeset says the CRM columns are dropped in the next release (step 6); the auth changeset
    names `LEGAL_ENTITY_NOTICE_EMAIL` and release step 7 (T71).

## QE, security, eval

- [x] T45: QE — the move rehearsed on compose end to end (dry run, apply, dry run, golden comparison) and the full AC run — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-4.1, AC-4.2, AC-4.3, AC-5.1, AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-6.1, AC-6.2, AC-6.3, AC-6.4, AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.5, AC-8.1, AC-8.2, AC-9.1, AC-9.2, AC-9.3, AC-9.4, AC-9.5, AC-9.6, AC-9.7, AC-9.8, AC-9.9, AC-9.10, AC-9.11, AC-9.12, AC-9.13, AC-9.14, AC-9.15, AC-9.16, AC-9.17 — deps: T40, T42, T43, T53, T54, T59, T62, T67, T68, T73, T74, T75, T76, D2, D3
  - touch: `specs/20261117-legal-entities/qe-report.md`
  - agent: quality-engineer
  - done when: `qe-report.md` maps every AC to passing evidence, records the MIG rehearsal (counts and flags,
    including a `mismatched` → `resolved` run and the post-switch dry run), checks the skew pairings of R5 (old
    letterhead-api + new crm-api; old crm-ui + new crm-api; new crm-ui + old crm-api), and gives PASS.
    Added 2026-11-17: the US-9 notice rehearsed on compose (notify-api stopped during a protected save, then
    started: save unaffected, retries, `notice_failed` then `notice_delivered`, one notice per recipient and channel,
    the notification centre in it and en, no value in any notice or record); the skew pairings of G15 (new admin-ui +
    auth without the check route → fail closed; new auth + old notify-api → retried); F2–F7 and FU-1–FU-10 confirmed
    closed or routed; the copy run (T54's tails) on the MIG fixture set.

- [x] T46: Security review, frontier tier (plan § Security) — refs: AC-2.7, AC-3.1, AC-3.2, AC-4.2, AC-5.2 — deps: T8, T9, T23, T28, T29, T39
  - touch: `specs/20261117-legal-entities/security-review.md`
  - agent: owasp-reviewer (frontier tier: financial data, R1)
  - done when: the review covers every surface the plan lists (incl. the derived `apps` entry, the import script's
    credentials, letterhead-api's token client and `entityData` discarded) and has no open high or critical finding.

- [ ] T47: Eval — LM-judge verdict on the feature — refs: AC-1.1, AC-2.4, AC-3.3, AC-4.3, AC-5.4, AC-6.3, AC-7.5, AC-8.1, AC-9.1, AC-9.7, AC-9.12, AC-9.14 — deps: T45, T46, T70
  - touch: `specs/20261117-legal-entities/eval-report.md`
  - agent: evaluator
  - done when: `eval-report.md` is fresh and passing (`/wellforge:eval 20261117-legal-entities`).

## Owner steps: the switch

- [ ] T48: **[OWNER]** Release steps 4–5 — pre-switch dry run, merge push 2, cut the release, push; the freeze ends when crm-api is live — refs: AC-5.1, AC-6.1, AC-6.2, AC-7.4 — deps: T18, T44, T45, T46, T14, T70
  - touch: `CHANGELOG.md`, `*/CHANGELOG.md`, `*/package.json`, `shell/src/lib/suiteVersion.generated.json`, `.changeset/*`, `specs/20261117-legal-entities/release-log.md`
  - agent: owner (RELEASING.md)
  - note (2026-11-17, G15): push 2 now also carries auth (the US-9 notice duty and dispatcher, T58/T59, and its
    additive migration); it follows T16–T18 in the same release session.
  - done when: the dry run just before the push reports `mismatched` 0; after the push every changed service
    (auth included) reports its new version and crm-api is live; auth logs that the notice dispatcher started;
    logged.

- [ ] T49: **[OWNER]** Release step 5 smoke and step 5b — compare issuer lines per entity with the day before; the post-switch dry run — refs: AC-3.3, AC-7.4, AC-7.5 — deps: T48
  - touch: `specs/20261117-legal-entities/release-log.md`
  - agent: owner
  - done when: per entity, a classic offer preview (and a service preview where the switch is on) prints the same
    issuer lines as the day before, apart from the contacts line and the signed-off IBAN grouping; the post-switch
    dry run reports `mismatched` 0; logged.

## Closing

- [ ] T50: All gates green; QE, security review and eval pass; spec status → done via `/wellforge:done` — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-4.1, AC-4.2, AC-4.3, AC-5.1, AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-6.1, AC-6.2, AC-6.3, AC-6.4, AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.5, AC-8.1, AC-8.2, AC-9.1, AC-9.2, AC-9.3, AC-9.4, AC-9.5, AC-9.6, AC-9.7, AC-9.8, AC-9.9, AC-9.10, AC-9.11, AC-9.12, AC-9.13, AC-9.14, AC-9.15, AC-9.16, AC-9.17 — deps: T14, T47, T49, T70, T71
  - touch: `specs/20261117-legal-entities/spec.md`
  - agent: orchestrator
  - done when: `/wellforge:done 20261117-legal-entities` accepts: every task checked, QE PASS, no open high in the
    security review or its re-review (T70), a fresh passing eval report, changesets present for auth, ui, shell,
    notify-api, crm-api, crm-ui, letterhead-api, letterheads-ui and admin-ui.

## AC coverage

Implementing and verifying tasks per AC. Nominal references are left out of the table: T13 and T44
(changesets), T14 (drift decision), T16 (release cut), T45 (QE, all ACs), T47 (eval), T50 (closing).

| AC | Tasks |
| --- | --- |
| AC-1.1 | T1, T5, T36, T37, T42 |
| AC-1.2 | T2, T8, T34, T37 |
| AC-1.3 | T2, T8, T34, T37 |
| AC-1.4 | T2, T8, T37 |
| AC-1.5 | T8, T21, T22, T25, T37, T52 |
| AC-2.1 | T2, T8, T37 |
| AC-2.2 | T7, T11, T39, T51, T52, T61 |
| AC-2.3 | T7, T11, T39, T42 |
| AC-2.4 | T2, T7, T8, T39 |
| AC-2.5 | T8, T62 |
| AC-2.6 | T8, T34, T38, T42 |
| AC-2.7 | T1, T8, T46, T53 |
| AC-3.1 | T5, T42, T46, T52 |
| AC-3.2 | T6, T12, T17, T25, T46, T53 |
| AC-3.3 | T21, T25, T49 |
| AC-3.4 | T5, T6 |
| AC-4.1 | T3, T42 |
| AC-4.2 | T4, T8, T36, T42, T46, T52 |
| AC-4.3 | T4, T5, T7, T35, T36, T41, T42, T52 |
| AC-5.1 | T22 |
| AC-5.2 | T19, T22, T28, T46 |
| AC-5.3 | T20, T22 |
| AC-5.4 | T20, T23, T32, T43, T65, T66 |
| AC-5.5 | T21, T22, T25, T26, T31, T64 |
| AC-6.1 | T29, T30, T43 |
| AC-6.2 | T26, T27, T28, T31, T41, T43, T64 |
| AC-6.3 | T26, T31, T43, T63 |
| AC-6.4 | T27 |
| AC-7.1 | T9, T18, T67 |
| AC-7.2 | T7, T9, T18, T39, T54 |
| AC-7.3 | T9, T18, T26, T34, T36, T37 |
| AC-7.4 | T9, T12, T18, T48, T49, T67 |
| AC-7.5 | T9, T12, T15, T18, T24, T27, T28, T49, T54 |
| AC-8.1 | T10, T11, T32, T36, T37, T38, T39, T40, T42, T60, T61, T62, T63 |
| AC-8.2 | T30, T31, T32, T33, T40, T42, T51, T60, T61, T63 |
| AC-9.1 | T51, T55, T60, T68 |
| AC-9.2 | T51, T60, T68 |
| AC-9.3 | T60, T68 |
| AC-9.4 | T51, T60 |
| AC-9.5 | T55, T60, T68 |
| AC-9.6 | T40, T51, T60, T68 |
| AC-9.7 | T58, T59, T68 |
| AC-9.8 | T58, T71 |
| AC-9.9 | T58, T59 |
| AC-9.10 | T58, T59, T67, T71 |
| AC-9.11 | T51, T54, T57, T59 |
| AC-9.12 | T51, T57, T59, T70 |
| AC-9.13 | T56, T57, T59, T68 |
| AC-9.14 | T56, T58, T59, T70 |
| AC-9.15 | T58, T59, T62 |
| AC-9.16 | T58 |
| AC-9.17 | T55, T58, T60, T68 |

All 52 ACs (35 + AC-9.1–AC-9.17, re-synced 2026-11-17) have at least one implementing task. Every task references at least one AC. Tasks whose refs are
nominal rather than implementing — flagged so nobody reads them as coverage: T13 and T44 (changesets), T14
(drift decision), T16 and T48 (release pushes; T48's pre-switch dry run does verify AC-7.4), T46 and T47
(review, eval). Scope added
without an AC, accepted by the owner in design.md and carried by its tasks: per-entity drafts and the leave
guard (T36), the "n / 120" counter and the extra inputs of a moved address (T37), the freshness sentence (T37),
the CRM 503 notice (T31), the unavailable-preview notice (T32), the restore dialog's change list (T39); and
from the plan amendment, `restorable` (T7, serving AC-2.4) and the `resolved` category with the post-switch dry
run (T9, T49, serving AC-7.4/AC-7.5).

## Overlap check

Effective graph = `deps:` ∪ `touch:` overlap (globs expanded against each other and against the tracked files).
Notation: "A → B" means A comes before B. Every overlap found, and what was done:

**Ordered by an explicit dep (genuinely ordered; the dep was declared, not inferred):**

- `auth/src/legalEntities/repo.ts` — T5, T7, T8: T5 → T7 → T8.
- `auth/src/index.ts` (route registry) — T5, T6, T7, T8: T5 → T6, T5 → T7 → T8. T6 has no dep with T7 or T8;
  all append an `app.route` line: **registry overlap, serializes T6 against T7 and T8**.
- `specs/20261117-legal-entities/fixtures/*` — T5 writes `legal-entities.json`, T9 writes
  `crm-entity-profiles.json`, T24 writes `issuer-lines.golden.json`: distinct files, no overlap; T9 → T24 (T24 reads T9's file).
- `crm-api/src/offers/generation.ts` — T26, T27, T28: T26 → T27 → T28 (one switch in three reviewable steps).
- `crm-api/src/offer-drafts/offerDrafts.routes.ts`, `crm-api/src/offer-templates/offerTemplates.routes.ts` and
  their tests (`crm-api/src/offer-drafts/*.test.ts`, `crm-api/src/offer-templates/**/*.test.ts`) — T26, T28:
  T26 → T27 → T28.
- `crm-ui/src/lib/crmApi.ts`, `crm-ui/src/lib/types.ts` — T30, T31: T30 → T31.
- `admin-ui/src/pages/LegalEntitiesPage*` — T35 creates the host, T36 fills it: T35 → T36. T40's
  `LegalEntitiesPage.a11y.test.tsx` matches the glob: T40 after T36 via T37/T38/T39.
- `admin-ui/src/components/LegalEntityForm*` — T37, T38: T37 → T38.
- `admin-ui/src/components/LegalEntityPanel*` — T36 creates it; T37 and T39 mount their views in it: T36 → T37,
  T36 → T39. T37 and T39 are not ordered by meaning: **mount-point overlap, serializes them** (whichever goes
  first; T39 rebases).
- `shell/e2e/fixtures/crmOfferService.ts`, `shell/e2e/helpers/crmOfferFixtures.ts` — T41 only (T43 uses them):
  no overlap. `shell/e2e/legal-entities*.spec.ts` (T42) vs `shell/e2e/crm-legal-entities.spec.ts` (T43): the
  glob does not match it (named apart on purpose).
- `.changeset/*` — T13, T44, and the release cuts T16, T48. **Dep added on T44: T16 → T44.** Without it, push-2
  changesets written before the push-1 cut would be consumed (and their packages bumped) by T16's release, which
  ships only push-1 code. Also T13 → T16 → T48 and T13 → T44 → T48.
- Release-cut globs (`CHANGELOG.md`, `*/CHANGELOG.md`, `*/package.json`, `shell/src/lib/suiteVersion.generated.json`)
  — T16, T48: T16 → T17 → T18 → T48.
- `specs/20261117-legal-entities/release-log.md` — T15, T16, T17, T18, T48, T49. **Dep added on T16: T15 → T16** (plan R2:
  the early IBAN check is "before push 1"); then T16 → T17 → T18 → T48 → T49.
- `specs/20261117-legal-entities/spec.md` — T14, T50: T14 → T50.

**Shared registries kept as separate tasks (they serialize the batches they meet):**

- `mise.toml` — T9 (`legal-entities:import`) and T21 (`dev:letterhead` env): no meaning order; serialized.
  T9 is push 1 and runs first in practice.
- `auth/src/index.ts` — see above (T6 serialized against T7 and T8).
- `operai-ui/src/index.ts` — T11 only (T10 changes existing exports' props, not the barrel). No overlap.
- `admin-ui/src/strings.ts`, `crm-ui/src/strings/*`, `letterheads-ui/src/strings/*` — one task each per app
  (T33; T30 `settings.ts` vs T31 `offers.ts`/`offerWizard.ts`: distinct files; T32): no overlap.
- `auth/src/authz/seed.ts`, `auth/prisma/schema.prisma`, `auth/prisma/migrations/*`, `crm-api/prisma/schema.prisma`,
  `crm-api/prisma/migrations/*` — one task each (T3; T1; T29): no overlap inside this spec. The migration
  directories are numbered series: any other open branch adding a migration to `auth` or `crm-api` must be
  merged in timestamp order with T1/T29.
- `compose.yaml` — T21 only.

**Checked, no overlap:** `auth/src/authz/authz.routes.ts` (T4 only), `auth/src/system/*` (T6 only), letterhead-api
engine dirs (T19 `content/**` vs T20 `resolve/**`, `layout/**`, `output/text.rs`, `render.rs`, `sample/**`),
letterhead-api api files (T21 `registry/**`, `env.rs`, `main.rs` vs T22 `routes/render.rs`, `log.rs` vs T23
`routes/preview.rs`, `pool/*`, `worker.rs`), `crm-api/src/lib/*` (T25 `legalEntities*` vs T28 `letterheadClient*`),
crm-api entity-profiles (T29 only).

**Push boundary:** no push-1 task (T1–T13) depends on a push-2 task; T24 (push 2) depends on T9 (push 1), which
is the allowed direction.

**Cross-spec overlap with specs/20261116-letterhead-service (plan R13).** Its open tasks: T36 (closing; touch
`specs/20261116-letterhead-service/spec.md`, `…/qe-report.md`, `…/security-review.md`, `…/eval-report.md`,
`letterhead-api/CHANGELOG.md`, `.changeset/*`) and T40 (owner deploy/measure; touch `…/spike.md`, and in its
prose the `domains` line of `.railway/railway.ts`).

- `.changeset/*` — its T36 vs our T13, T44, T16, T48: whichever release cut runs first consumes the other's
  pending changesets. Rule: our T16 (push 1) may ship its T36 changesets with it; our T48 waits for its T36 (gate).
- `letterhead-api/CHANGELOG.md` — its T36 (via the release cut) vs our T16/T48 (`*/CHANGELOG.md`): same rule.
- `specs/20261116-letterhead-service/spec.md` — its T36 (status → done) vs our T14 (D7 note): T14 should land
  before its T36, so its QE/eval stop testing AC-1.8's "same pages" for the issuer (and the D1-superseded ACs).
- Code areas its QE/eval fixes may still touch (`letterhead-api/**`, `letterheads-ui/**`,
  `crm-api/src/offers/blocks.ts`, `crm-api/src/lib/letterheadClient.ts`, the CRM preview routes,
  `crm-ui/src/components/offerWizard/*Service*`): our T19–T23, T26, T28, T31, T32 overlap them (the gate on 20261116/T36 was lifted by the owner on 2026-11-17).
- `.railway/railway.ts`: none of our tasks edits it; its T40's `domains` restore is unaffected.

## Parallel batches (effective graph)

Computed mechanically on deps ∪ `touch:` overlap (globs with `*` not crossing `/`, `**` crossing it), earliest
start, owner tasks included, ties broken by task number; within a batch no two tasks share an edge. The R13 gate
was lifted on 2026-11-17, so the gated batches (G1–G8) follow on from B1–B10 by deps alone.

| Batch | Tasks | Note |
| --- | --- | --- |
| B1 | T1, T2, T3, T10, T11, T14 [OWNER], T15 [OWNER], T29, T33 | T29 and T33 are push-2 code with no prerequisite: written now, merged with push 2 |
| B2 | T4, T9 | |
| B3 | T5, T24 | T24 must be committed before any crm-api code change (T26) |
| B4 | T6, T30, T34 | |
| B5 | T7, T12, T25, T35 | T7 waits for T6 only because both register a router in `auth/src/index.ts` |
| B6 | T8, T36 | T8 waits for T6 for the same reason (and for T7 by dep) |
| B7 | T13, T37, T41 | |
| B8 | T16 [OWNER], T38, T39 | T39 waits for T37 only on `LegalEntityPanel*` (mount point) |
| B9 | T17 [OWNER], T40, T42 | |
| B10 | T18 [OWNER] | the copy; push-1 work is complete here |
| — | *gate 20261116/T36 opens* | |
| G1 | T19, T20, T21, T26 | |
| G2 | T22, T23, T27, T31 | |
| G3 | T28, T32 | |
| G4 | T43, T44, T46 | T46 (security) runs alongside QE |
| G5 | T45 | |
| G6 | T47, T48 [OWNER] | |
| G7 | T49 [OWNER] | |
| G8 | T50 | |

Critical path: the R13 gate, then T21 → T22 → T28 → T43 → T45 → T48 → T49 → T50. All of push 1, the copy, and
most of crm-api, crm-ui Settings and admin-ui (B1–B10) fit before the gate opens. If the gate is slow, the
dispatcher may run G-batch tasks on a rebased branch only after confirming 20261116 has no open fix task on the
same files.

- [x] T72: crm-api — wait past letterhead-api's one-second forced-refresh window before the single pin retry — refs: AC-6.2, AC-5.5 — deps: T64
  - touch: `crm-api/src/offers/generation.ts`, `crm-api/src/offers/*.test.ts`
  - agent: backend-dev · push 2
  - added by the orchestrator 2026-11-17 (T64 report): letterhead-api now refreshes at most once per second per
    process, and a mismatching pin inside that second gets the 409 at once; crm-api's single retry in `withIssuerPin`
    could land in the same second and turn a legitimate save into a 503. Wait ≥ 1.1 s (bounded, cancellable) before
    the retry; nothing else changes.
  - done when: a test with a fake letterhead service that answers 409 for 1 s then 200 shows one retry after ≥ 1.1 s
    and a 200; the existing retry tests stay green; crm-api typecheck and suite green.

- [x] T73: `@operai/ui` ConfirmDialog — body scrolls with the footer always visible at 320 px, an aria-disabled Confirm with a described reason (`confirmDisabledReason`), an optional width; admin-ui's S12 and restore dialog adopt them as design S7/S12 say — refs: AC-9.1, AC-9.4, AC-9.6, AC-8.1 — deps: T60
  - touch: `operai-ui/src/components/ConfirmDialog*`, `operai-ui/src/components/Dialog*`, `operai-ui/src/styles/tokens.css`, `operai-ui/src/index.ts`, `operai-ui/docs/design-system.md`, `admin-ui/src/components/ProtectedChangeDialog*`, `admin-ui/src/components/RestoreDialog*`, `.changeset/*`
  - agent: frontend-dev · push 1 (library) + push 2 (admin-ui)
  - added by the orchestrator 2026-11-17 (T60 report, library gaps): opt-in props only, existing dialogs unchanged; a
    changeset bumps `@operai/ui` (push 1, ships with the shell).
  - done when: library tests show the footer in view with three long details at 320 px (layout asserted by
    classes/CSS, story added), Confirm `aria-disabled` + `aria-describedby` reason while the restore dialog reads or
    after a failed read (design S7), the same Cancel/Escape semantics; axe 0; ui:check steps green.
- [x] T74: auth — expose `Retry-After` over CORS so admin-ui can read the 429 wait — refs: AC-9.6, AC-8.1 — deps: T52
  - touch: `auth/src/index.ts`, `auth/src/auth/auth.mount.test.ts`
  - agent: backend-dev · push 1
  - added by the orchestrator 2026-11-17 (T60 report): the CORS middleware sets no `exposeHeaders`; `Retry-After` is
    not CORS-safelisted, so every 429 would read "a few minutes" cross-origin.
  - done when: a CORS request to a throttled registry route exposes `Retry-After` (`Access-Control-Expose-Headers`
    contains it); auth suite green.

- [x] T75: auth — `notices/duty.test.ts`'s committed "real transactions" group uses T53's local-host guard — refs: AC-2.7 — deps: T53, T58
  - touch: `auth/src/legalEntities/notices/duty.test.ts`
  - agent: backend-dev · push 2
  - added by the orchestrator 2026-11-17 (T59 report, F4 rule): the group checks only "registry empty"; it must
    also run only when `committedTransactionsSkipReason(DATABASE_URL)` is null (`testDb.ts`).
  - done when: the group skips with the one-line reason on a non-local host and runs on localhost; auth suite green.

- [x] T76: letterhead-api — a pin forces a registry refresh only when it is newer than the held version, within a per-process budget (security re-review N2) — refs: AC-5.5, AC-6.2 — deps: T64
  - touch: `letterhead-api/api/src/registry/**`, `letterhead-api/api/src/routes/render.rs`, `letterhead-api/api/tests/registry.rs`, `letterhead-api/api/tests/render.rs`
  - agent: backend-dev (Rust) · push 2
  - added by the orchestrator 2026-11-18 (security-review-2.md N2): F6's 1/s cap still allows 600 refreshes per
    10 min against auth's 300 per service; a stream of mismatching pins could exhaust it and turn renders into 503.
  - done when: a pin older than or equal to the held version gets the 409 with no registry call; a newer pin
    refreshes at most once per second and at most a fixed budget per 10 minutes (well under auth's allowance, e.g.
    100), beyond which it gets the 409 at once; tests prove both; fmt, clippy, api tests green.

- [x] D2: letterhead-api engine — the preview's text alternative keeps `⟦ ⟧` around a missing label that wraps onto a second line (QE T43 defect D-T43-1) — refs: AC-5.4 — deps: T20
  - touch: `letterhead-api/engine/src/output/text.rs`, `letterhead-api/engine/src/output/mod.rs`, `letterhead-api/engine/src/render.rs`, `letterhead-api/engine/src/layout/frame/tests.rs`
  - agent: backend-dev (Rust) · push 2
  - failing e2e: `shell/e2e/letterheads.spec.ts` "a missing label that wraps onto a second line keeps its brackets in
    English too (AC-5.4)" — footer line `{iban} {contacts}`, contacts empty, English: text reads "… Contacts / line"
    without brackets; Italian ("⟦Riga / contatti⟧") and `{contacts}` alone are fine.
  - done when: an engine test reproduces the English wrap and passes; real-document output unchanged; engine tests green.

- [x] D3: admin-ui — Confirm in the protected-change confirmation must save (QE T68 D-T68-1, high) — refs: AC-9.3, AC-9.1 — deps: T60, T73
  - touch: `admin-ui/src/components/LegalEntityForm*`, `admin-ui/src/components/ProtectedChangeDialog*`, `admin-ui/src/components/ProtectedChangeList*`, `admin-ui/src/components/LegalEntityPanel*`, `admin-ui/src/components/RestoreDialog*`
  - agent: frontend-dev · push 2
  - failing e2e: `shell/e2e/protected-legal-details.spec.ts` "keyboard only: Confirm saves…", "a newer version saved
    while the dialog is open…", `shell/e2e/legal-entities.spec.ts` "a welld_ch manager edits welld_ch…": Confirm does a
    native navigation to `/admin/legal-entities?`, no POST. Lead: `ProtectedChangeDialog` is mounted inside the form's
    `<form>` and `ConfirmDialog` renders its own `<form>` (nested forms; React warns).
  - also D-T68-2 (medium, AC-9.6): `ProtectedChangeList`'s `<ul aria-label>` replaces its content in the dialog's
    computed accessible description, which must hold each detail's Old and New values (design S12/S7).
  - done when: no nested `<form>` anywhere in the page (a unit test asserts it and that Confirm calls the save once);
    the computed accessible description of both dialogs contains each Old/New value (unit test with an
    accessible-description computation); admin-ui suite green; the three e2e journeys are re-run by T45.

## Follow-ups found during implementation (orchestrator, 2026-11-17)

- FU-1 (T31): crm-ui `letterhead.overflow.body` / `bodyAskAdmin` still say "Shorten the value in CRM Settings"; the
  overflowing values now live in the Legal entities registry — reword to point at the Legal entities page (link
  for managers, sentence otherwise, as `LegalEntityNotice`). For QE (T45) to confirm and route.
- FU-2 (T31): the classic `GenerateOfferDialog` and `OffersCard` show only the `offerFailure` sentence for
  `legal_entity_incomplete`, with no link for managers (AC-6.3 holds; consistency with the wizard's notice).
- FU-3 (T10): the `Tabs`/`TabNav` list already wrapped between tabs; `wrap` only breaks a single long label.
  QE to check 320 px reflow on the real page.
- FU-4 (T33): `toCorrect.title` copy was invented by frontend-dev ("These details need correction" / "Questi dati
  vanno corretti") — designer to confirm.
- FU-5 (T20): ADR candidate — how a layout draws the configurator's "missing" mark (runtime one-line template
  patch in `layout/mod.rs`; a future layout 2 must provide it).
- FU-6 (T12): `DOCUMENTED_CLIENT_SCOPES["crm-api"]` in auth omits `letterhead:render`, which production holds.
- FU-7 (T37, T38): admin-ui strings gaps in `strings/legalEntities.ts` — a "Kept as moved from the CRM" suffix for
  every moved reason (not only `too_many_lines`); the 5th-line hint of a moved address; a dedicated "Not filled
  in. Enter …" sentence; a count phrase for `conflict.applied` and an "applied, nothing to review" sentence; the
  empty "(changed: )" case. Plus an `AddressLinesField` note slot so the conflict note is in the focused line's
  `aria-describedby`. T39 adds: `history.openLabel` / `history.restoreLabel` (visible "Open"/"Restore"),
  `history.changedList(list)`, `history.loading`, `history.failed`, `version.failed`. Candidate owner: T40 (a11y
  sweep) with the designer for the copy.
- FU-8 (T37): `admin-ui/src/pages/LegalEntitiesPage.test.tsx` — 2 T36 tests wait for the facts view where the
  form now renders (fix: wait for `admin-legal-form`); the T37 agent's edit was refused by the permission
  classifier (outside its touch). Pending owner decision on assigning the file to T40.
- FU-9 (T23): the sample document's intro (`letterhead-api/engine/src/sample/mod.rs` ~L292, ~L330) still says the
  company's data are placeholders marked "(SAMPLE)" — false in the configurator preview now that it shows the
  registry's details (AC-5.4). Reword in it and en (engine-only, real documents unaffected).
- FU-10 (T32): letterheads-ui reads the shell's `getAuthBaseUrl` through a cast; declare it in
  `letterheads-ui/src/federation/remotes.d.ts` and export it from `src/federation/__stubs__/shellSession.ts`, then
  drop the cast.

## Re-sync 2026-11-17 — after the security review (US-9, F2–F7, follow-ups)

Source: spec US-9 (AC-9.1–AC-9.17), plan "Amendment 2026-11-17 after security review" (G1–G16), `design.md`'s
designer TODO, `security-review.md` (T46). Push marks as above; **push 1 now ships at the end** (G15), so a push-1
task here only has to precede T16. No new push-1 task depends on a push-2 task.

### Design

- [x] T51: design — the amendment after the security review: S12 protected-change confirmation, S7 restore additions, the 429 and history-paging states, the notice copy (in-app en/it, email en), and the copy owed by FU-1, FU-4, FU-7, FU-9 — refs: AC-9.1, AC-9.2, AC-9.4, AC-9.6, AC-9.11, AC-9.12, AC-9.13, AC-2.2, AC-8.2 — deps: none
  - touch: `specs/20261117-legal-entities/design.md`, `.forge/design/20261117-legal-entities/content/*` (git-ignored mockups)
  - agent: designer (the owner reviews the copy)
  - done when: every item of design.md's "TODO for the designer — amendment after the security review" is ticked
    and replaced by its section (states listed; en + it keys with their text; the English email's subject, body and
    button); "Also decided here" and "Scope creep" no longer say there is no confirmation; S12 has no acknowledge
    checkbox and Cancel is the initial focus; the notice copy holds no slot for any detail value except the two IBAN
    tails, and the longest case (three protected and four other names, a 200-character actor name) is stated to fit
    a 200-character title and a 2000-character body.

### Push 1 — auth (hardening, the check route, the copy)

- [x] T52: auth — a deleted person is refused everywhere in the registry (F2); save and restore throttled per person, the history paged (F3) — refs: AC-2.2, AC-3.1, AC-4.2, AC-4.3, AC-1.5 — deps: none
  - touch: `auth/src/legalEntities/coverage.ts`, `auth/src/legalEntities/coverage.test.ts`, `auth/src/legalEntities/write.routes.ts`, `auth/src/legalEntities/write.routes.test.ts`, `auth/src/legalEntities/history.routes.ts`, `auth/src/legalEntities/history.routes.test.ts`, `auth/src/legalEntities/read.routes.ts`, `auth/src/legalEntities/read.routes.test.ts`, `auth/src/legalEntities/repo.ts`, `auth/src/lib/env.ts`, `auth/src/index.ts`
  - agent: backend-dev · push 1
  - Details: plan G8 (`activeUserProfile` in `coverage.ts`, used by write `authorize`, the history/version guard,
    `manageable` and the person reads), G9 (`LEGAL_ENTITY_WRITE_RATE_LIMIT` 10, `LEGAL_ENTITY_CHECK_RATE_LIMIT` 60 —
    read here, used by T55 —, `LEGAL_ENTITY_RATE_WINDOW_MS` 600000; counted per user id after authorisation, before the
    body), G5 (history `limit`/`before`/`nextBefore`); `index.ts` logs the limits like the `/system` ones.
  - done when: route tests — a soft-deleted holder with a live (mocked) session → 403 `forbidden` on save, restore,
    history and version view, `manageable` → `{ entities: [] }`, `GET /legal-entities[/{entity}]` → 401; the 11th
    save-or-restore of one person within the window → 429 `too_many_requests` with `Retry-After` and nothing
    written, another person unaffected, limits taken from env; history pages of 50 newest first, `before` cursor,
    `nextBefore` null on the last page, the union of the pages = every version, `limit` 0/101/abc and `before` abc →
    422 `invalid_request` after the 403s with nothing echoed; `auth.mount.test.ts` and the whole auth suite green.

- [x] T53: auth — the committed-transaction test group runs only against a local database (F4); `DOCUMENTED_CLIENT_SCOPES["crm-api"]` lists `letterhead:render` (FU-6) — refs: AC-2.7, AC-3.2 — deps: T52
  - touch: `auth/src/legalEntities/write.routes.test.ts`, `auth/src/legalEntities/testDb.ts`, `auth/src/system/serviceClients.ts`, `auth/src/system/serviceClients.test.ts`
  - agent: backend-dev · push 1
  - Details: plan G10 F4; the host guard is a function in `testDb.ts` so T59's committed-transaction tests reuse it.
  - done when: unit test of the guard — `localhost`, `127.0.0.1`, `::1`, `host.docker.internal`, `postgres` → run;
    `x.railway.internal`, `x.proxy.rlwy.net` and any other host → the group is skipped with one line that names the
    reason and not the URL; the group still runs on compose; `testDb.ts`'s header names the exception;
    `DOCUMENTED_CLIENT_SCOPES["crm-api"]` includes `letterhead:render` and its test asserts it; auth suite green.

- [x] T54: auth — the copy names who last edited the CRM row and shows each IBAN's tail; one `ibanTail` rule shared with the notices (F5 items 2 and 3) — refs: AC-7.2, AC-7.5, AC-9.11 — deps: none
  - touch: `auth/src/legalEntities/ibanTail.ts`, `auth/src/legalEntities/ibanTail.test.ts`, `auth/src/legalEntities/import.ts`, `auth/src/legalEntities/import.test.ts`, `auth/scripts/import-crm-legal-details.ts`
  - agent: backend-dev · push 1
  - done when: `ibanTail` unit tests — "" → `none`; 8 characters → `set`; 9 → the last 4; a 34-character IBAN → the
    last 4; the import audit row's `source` carries `updatedBy` (a person id) and nothing else new; the report of
    the dry run and of the apply prints per entity `IBAN …1234` / `IBAN set` / `IBAN none`; the marker scan finds no
    full IBAN, legal name, VAT or address line of the fixtures in stdout; the rest of `import.test.ts` green.

- [x] T55: auth — `POST /legal-entities/{entity}/versions/check`: what a save would change, protected details listed, nothing written — refs: AC-9.1, AC-9.5, AC-9.17 — deps: T52
  - touch: `auth/src/legalEntities/check.routes.ts`, `auth/src/legalEntities/check.routes.test.ts`, `auth/src/legalEntities/write.routes.ts`, `auth/src/legalEntities/rules.ts`, `auth/src/legalEntities/rules.test.ts`, `auth/src/legalEntities/routerTable.test.ts`, `auth/src/auth/auth.mount.test.ts`, `auth/src/index.ts`
  - agent: backend-dev · push 1
  - Details: plan G1.7, G2 (`PROTECTED_FIELDS`, `protectedChanged` in `rules.ts`), G5 (contract), G12 (router
    rules); `authorize`, `readBody` and the refusal bodies are exported from `write.routes.ts`, not copied; its own
    limiter (T52's env).
  - done when: route tests — the refusal order of the save (401, 403, 404, 403, 413, 422 `invalid_request`, 422
    `invalid_legal_entity`, 409 `legal_entity_not_moved`, 409 `version_conflict` + `currentVersion`, 429); 200 with
    `outcome`, `changedFields` and `protectedChanges` against `baseVersion` in stored form (NFC/trim; the IBAN in
    print form; "" for empty); IBAN spacing/case-only, address-only and contacts-only → `protectedChanges: []`; a
    no-op → `outcome: "same"`; no version or audit row written and no advisory lock taken; a deleted user → 403;
    `routerTable.test.ts` accepts exactly three POSTs under `/legal-entities`; `auth.mount.test.ts` reaches the route;
    `rules.test.ts` covers `protectedChanged`; auth suite green.

### Push 1 — notify-api

- [x] T56: notify-api — idempotency keys on `/system/notifications` and `/system/emails`; per-template caller binding; `recipientId` addressing for a bound template; Resend `Idempotency-Key` — refs: AC-9.13, AC-9.14 — deps: none
  - touch: `notify-api/prisma/schema.prisma`, `notify-api/prisma/migrations/*`, `notify-api/src/system/notifications.*`, `notify-api/src/system/emails.*`, `notify-api/src/system/systemAuth.middleware*`, `notify-api/src/channels/email.channel*`, `notify-api/src/channels/emailDelivery.repo.ts`, `notify-api/src/channels/inApp.channel.ts`, `notify-api/src/notifications/notifications.repo*`, `notify-api/src/lib/resend.ts`, `notify-api/src/openapi/registry.ts`
  - agent: backend-dev · push 1
  - Details: plan G1.3–G1.5, G4 (notify-api migration: `callerSub`, `idempotencyKey`, partial unique index on
    `Notification`), G5 (contracts). The template `legal_entity_change` and its binding entry are T57; here the
    binding and `recipientId` mechanisms are tested with an injected template table.
  - done when: N-int — a repeated in-app call (same `sub` and key) → 200 with the stored row, no second SSE event,
    no push dispatch, no email; another `sub` with the same key → a new row; two concurrent calls → one row; a
    repeated email after `sent` → 200 with the same `deliveryId` and the fake Resend called once; after `failed` →
    called again; Resend receives `<sub>:<key>` as its idempotency key (or the task records that SDK 6.17.2 cannot
    pass it and how the raw header is sent instead); `to` and `recipientId` together or neither → 400; `recipientId`
    for a template that does not allow it → 400; a template bound to another caller → 403 `template_not_allowed`,
    nothing written; every existing test unchanged and green; the migration is additive.

- [x] T57: notify-api — the `legal_entity_change` email template: English, strict typed data, bound to `system:auth`, addressed by `recipientId` or `to` — refs: AC-9.11, AC-9.12, AC-9.13 — deps: T56, T51
  - touch: `notify-api/src/system/emailTemplates.ts`, `notify-api/src/system/emailTemplates.test.ts`, `notify-api/src/system/emails.schemas.ts`, `notify-api/src/system/emails.routes.ts`, `notify-api/src/system/emails.routes.test.ts`, `notify-api/src/channels/email.channel.ts`, `notify-api/src/system/emails.idempotency.test.ts` (added 2026-11-17: T56's "binds nothing yet" assertion must now expect the `legal_entity_change` entry)
  - agent: backend-dev · push 1
  - done when: template tests — renders T51's English copy with the entity label, the actor (escaped, controls and
    bidi stripped), save vs restore of version m, date, time and zone in Europe/Zurich for a CET and a CEST date, the
    version, the protected names, the IBAN Old/New tails (`none` / `set` / last 4), the other names and the absolute
    history link from `APP_BASE_URL` (`/admin/legal-entities?entity=<e>&view=history`); strict data — an extra member,
    a `last4` not matching `^[A-Z0-9]{4}$`, `iban` present without `"iban"` in `protectedChanged` → 400;
    `system:auth` may send it, `system:crm-api` → 403; with `recipientId`: inactive → `skipped`
    `recipient_inactive`, lookup failure → `failed` `contact_lookup_failed`, email group unset → `skipped`
    `not_configured`; no fixture value but the two tails appears in the subject or the HTML.

### Push 1 — configuration and runbook

- [x] T67: Config contract and runbook — the copy role for the copy window (F5 item 1), `LEGAL_ENTITY_NOTICE_EMAIL` and the registry rate limits in env-doctor and `.env.example`, the release at the end (G15) with step 7, e2e limits in compose — refs: AC-7.1, AC-7.4, AC-9.10 — deps: T52, T54
  - touch: `infra/README.md`, `tools/env-doctor/manifest.ts`, `tools/env-doctor/templates/production/auth.env`, `tools/env-doctor/check.test.ts`, `auth/.env.example`, `compose.yaml`
  - agent: devops · push 1 (docs and config only; the names are fixed by plan G4, so it needs no push-2 task)
  - done when: the runbook's step 3 creates a `SELECT`-only role on `entity_profile`'s legal columns, `updatedAt`
    and `updatedBy` in the `crm` database, sets `CRM_DATABASE_URL` to it by hand and drops it afterwards, and says the
    report shows IBAN tails (T54); the release section reads push 1 → steps 2–4 → push 2 → 5/5b → step 7 (set
    `LEGAL_ENTITY_NOTICE_EMAIL`, confirm a notice, only then grant managers), with notify-api in push 1 and auth in
    both pushes; env-doctor knows `LEGAL_ENTITY_NOTICE_EMAIL` (optional, must be an email when set) and the three
    rate-limit variables (optional; production must not set the write limit above 10 — a test fails a template that
    does); compose raises the write limit for the e2e stack only; `mise run env:doctor` passes locally.

- [x] T69: Changesets for the push-1 additions — notify-api (minor), auth (patch: F2–F5, FU-6, the check route) — refs: AC-9.13, AC-9.14, AC-4.2, AC-2.2 — deps: T52, T53, T54, T55, T56, T57
  - touch: `.changeset/*`
  - agent: backend-dev · push 1
  - done when: `pnpm exec changeset status --verbose` lists notify-api and auth with these bumps beside T13's;
    `node scripts/check-changeset.mjs --base=origin/main --head=HEAD` exits 0 for the push-1 commits; neither text
    names a push-2 change.

### Push 2 — auth (US-9 notices)

- [x] T58: auth — the notice duty: the `legal_entity_notice` table, recipients at the moment of storing, rows in the version's transaction, the no-recipient audit entry — refs: AC-9.7, AC-9.8, AC-9.9, AC-9.10, AC-9.14, AC-9.15, AC-9.16, AC-9.17 — deps: T52, T55
  - touch: `auth/prisma/schema.prisma`, `auth/prisma/migrations/*`, `auth/src/legalEntities/notices/recipients.ts`, `auth/src/legalEntities/notices/recipients.test.ts`, `auth/src/legalEntities/notices/duty.ts`, `auth/src/legalEntities/notices/duty.test.ts`, `auth/src/legalEntities/write.routes.ts`, `auth/src/lib/env.ts`
  - agent: backend-dev · push 2
  - Details: plan G1.1, G1.2, G2, G3, G4 (model, CHECKs, FK); `LEGAL_ENTITY_NOTICE_EMAIL` in `lib/env.ts` (optional,
    validated as an email). Rows are written and nothing is sent: the dispatcher is T59.
  - done when: A-int — a direct save changing the IBAN → per recipient of G3 one `in_app` and one `email` row, plus
    one `outside` email row when configured, in the version's transaction (a forced failure after the insert leaves
    no version, audit or notice row); the recipient cases of the plan's AC-9.8–9.10 rows pass (welld_ch-conditioned
    manager for welld_ch only; unconditioned holder; an administrator through a department without the grant; a
    soft-deleted holder or admin excluded; one row per channel for a person who is admin, manager and actor; the
    actor included; outside set/unset); a restore that is a protected change → rows; no row for the AC-9.17 cases
    (address/contacts-only, IBAN spacing/case-only, a restore with equal protected details, no-op, 422, 409, 403) nor
    for the import's first and repeated apply (AC-9.16); an injected empty recipient set →
    `legal_entity.notice_no_recipients`; no row or audit entry holds a sentinel value (AC-9.12); the CHECKs refuse an
    `outside` in-app row and an unknown status; auth suite green.

- [x] T59: auth — the notice dispatcher: kick and sweep, leases, retries for 24 h, idempotency keys, the content (in-app en/it, email data), outcomes in the audit log, started with the server — refs: AC-9.7, AC-9.9, AC-9.10, AC-9.11, AC-9.12, AC-9.13, AC-9.14, AC-9.15 — deps: T58, T56, T57, T54, T53, T51
  - touch: `auth/src/legalEntities/notices/dispatcher.ts`, `auth/src/legalEntities/notices/dispatcher.test.ts`, `auth/src/legalEntities/notices/content.ts`, `auth/src/legalEntities/notices/content.test.ts`, `auth/src/legalEntities/notices/copy.ts`, `auth/src/legalEntities/notices/copy.test.ts`, `auth/src/lib/notify.ts`, `auth/src/lib/notify.test.ts`, `auth/src/legalEntities/write.routes.ts`, `auth/src/index.ts`, `auth/src/legalEntities/write.routes.test.ts` (added 2026-11-17, T58 report: `wipeRegistry`/`emptyRegistry` must also delete `legal_entity_notice` rows, which the real-transactions group otherwise leaves as orphans)
  - agent: backend-dev · push 2
  - Details: plan G6 (schedule, reasons, leases, logs), G5 (both notify calls, `severity: "warning"`), G1.6 (copy of
    T51 in `copy.ts`, en/it), `ibanTail` (T54), the host guard of T53 for committed-transaction tests.
    `write.routes.ts` only gains the post-commit `kick`; `index.ts` starts the dispatcher unless `NODE_ENV=test`.
  - done when: A-int with an injected clock and a fake notify-api over HTTP — the plan's AC-9.7, 9.10, 9.11, 9.12,
    9.13, 9.14 and 9.15 rows pass: the kick hands over at once and a lost kick within one sweep; notify-api down →
    the save's answer byte-identical to the up case; one recipient's failure does not delay another's call; first
    retry at +1 min, the schedule, `given_up` at 24 h; a new dispatcher instance sends pending rows; a timeout after
    notify-api stored, then an idempotent 200 → one notification; two dispatchers on one database → one call per row;
    a recipient deleted after storing → `given_up` `recipient_deleted`, nothing sent; `skipped` retried; exactly one
    `notice_failed` per row, then `notice_delivered` or `notice_given_up`; content unit tests (tail boundaries, CET
    and CEST, save vs restore, the longest case within 200/2000, en/it parity); the sentinel scan over every request
    body, row, audit entry and log line; not started under `bun test`; auth suite green.

### Push 2 — admin-ui

- [x] T60: admin-ui — the protected-change confirmation on save (S12) and in the restore dialog (S7), and the 429 state — refs: AC-9.1, AC-9.2, AC-9.3, AC-9.4, AC-9.5, AC-9.6, AC-9.17, AC-8.1, AC-8.2 — deps: T51, T55
  - touch: `admin-ui/src/components/ProtectedChange*`, `admin-ui/src/components/LegalEntityForm*`, `admin-ui/src/components/RestoreDialog*`, `admin-ui/src/lib/legalEntitiesApi*`, `admin-ui/src/strings/legalEntities.ts`, `admin-ui/src/components/LegalEntityPanel.test.tsx`, `admin-ui/src/components/LegalEntityHistory.test.tsx`, `admin-ui/src/components/LegalEntityHistory.tsx` (added 2026-11-17: tests made stale by the check call and the in-dialog read failure; `onLoadFailed`/`restoreFailed` dead code)
  - agent: frontend-dev · push 2
  - Details: plan G7; design S12 and the S7 additions (T51); `ProtectedChangeDialog` and `ProtectedChangeList` on the
    library's `ConfirmDialog` (no acknowledge checkbox); Save → check → dialog → save.
  - done when: Vitest — the plan's AC-9.1–9.6 and AC-9.17 (UI) rows: the entity named, only the changing protected
    details, "Old"/"New" labels, "None" for an empty side, the grouped IBAN, Cancel focused; Cancel, Escape and the
    close control → no save request, values kept, focus back on Save; Confirm → one save request with the same body,
    its outcomes take the existing states, the next Save checks again; a check answering 422/409/403/5xx → the
    existing states, no dialog; a failed check → banner + Retry, nothing saved; the restore dialog lists Old
    (current) / New (version n), reads version n when the page does not hold it, no Confirm when it cannot; address-
    only and IBAN spacing-only saves → no dialog; 429 → T51's banner; axe 0 violations on every dialog state in en
    and it, dark and light; strings parity and `noHardcodedStrings` green.

- [x] T61: admin-ui — the history in pages: "Show older versions" with its loading and failure states (F3) — refs: AC-2.2, AC-8.1, AC-8.2 — deps: T52, T51, T60
  - touch: `admin-ui/src/components/LegalEntityHistory*`, `admin-ui/src/lib/legalEntitiesApi*`, `admin-ui/src/strings/legalEntities.ts`
  - agent: frontend-dev · push 2
  - done when: Vitest — the first page of 50; the button while `nextBefore` is not null; appending keeps the rows
    and moves focus to the first new row's Open; the last page hides the button; a failure keeps the rows and
    offers Retry; Open and Restore work on appended rows; axe 0 violations; parity green.

- [x] T62: admin-ui — the Audit page shows before and after of a legal entity change from `data.changes` (F7) — refs: AC-2.5, AC-9.15 — deps: none
  - touch: `admin-ui/src/pages/AuditPage.tsx`, `admin-ui/src/pages/AuditPage.test.tsx`
  - agent: frontend-dev · push 2
  - done when: Vitest — a `legal_entity.save` row with `data.changes` shows each changed field's before and after
    in the two panes; a row with `data.before`/`data.after` renders as today (existing tests unchanged); a
    `legal_entity.notice_failed` row shows its summary and invents no before/after; axe 0 violations.

### Push 2 — crm-ui, letterhead-api, letterheads-ui (follow-ups and F6)

- [x] T63: crm-ui — the overflow notice points at Legal entities (FU-1); the classic Generate dialog and the offers card show `LegalEntityNotice` for an incomplete entity (FU-2) — refs: AC-6.3, AC-8.1, AC-8.2 — deps: T51
  - touch: `crm-ui/src/strings/offerWizard.ts`, `crm-ui/src/components/offerWizard/LetterheadNotice*`, `crm-ui/src/components/offerWizard/LegalEntityNotice*`, `crm-ui/src/components/GenerateOfferDialog*`, `crm-ui/src/components/OffersCard*`, `crm-ui/src/components/offerWizard/ServicePreview*.test.tsx`, `crm-ui/src/pages/OfferWizardPage.generate.service.test.tsx`, `crm-ui/src/pages/DealSalesFlow.test.tsx` (added 2026-11-17: its AC-6.3 test asserted the one-line error FU-2 replaces)
  - agent: frontend-dev · push 2
  - done when: Vitest — `letterhead.overflow.body`/`bodyAskAdmin` say T51's copy (Legal entities, link for a
    manager of that entity, sentence otherwise; en and it); a `legal_entity_incomplete` refusal in the classic
    Generate dialog and on the offers card shows `LegalEntityNotice` with the link for a manager and the sentence
    otherwise; axe 0 violations; strings parity and `noHardcodedStrings` green.

- [x] T64: letterhead-api — forced refreshes coalesced: at most one per second per process; a mismatching pin answered 409 at once inside that second (F6) — refs: AC-5.5, AC-6.2 — deps: none
  - touch: `letterhead-api/api/src/routes/render.rs`, `letterhead-api/api/src/registry/cache.rs`, `letterhead-api/api/tests/render.rs`, `letterhead-api/api/tests/registry.rs`
  - agent: backend-dev (Rust) · push 2
  - done when: `cargo test -p letterhead-api` — 100 renders with a mismatching pin within one second → at most one
    registry call; a second mismatch within 1 s of a fetch → 409 `legal_entity_version_mismatch` + `currentVersion`
    without a call; after 1 s a mismatch refreshes again; a matching pin makes no call; the existing cache and render
    tests green.

- [x] T65: letterhead-api engine — the configurator sample's intro says the company details are the registry's real ones (FU-9) — refs: AC-5.4 — deps: T51
  - touch: `letterhead-api/engine/src/sample/**`, `letterhead-api/api/tests/preview.rs`
  - agent: backend-dev (Rust) · push 2
  - done when: the it and en intros carry T51's copy and no longer say the company data are placeholders marked
    "(SAMPLE)"; a preview test asserts the new sentence in both languages; the render golden corpus and pinning
    tests are byte-identical (real documents unaffected).

- [x] T66: letterheads-ui — `getAuthBaseUrl` declared in the federation types and exported by the shell stub; the cast dropped (FU-10) — refs: AC-5.4 — deps: none
  - touch: `letterheads-ui/src/federation/remotes.d.ts`, `letterheads-ui/src/federation/__stubs__/shellSession.ts`, `letterheads-ui/src/hooks/useCanManageLegalEntity.ts`, `letterheads-ui/src/hooks/useCanManageLegalEntity.test.tsx`
  - agent: frontend-dev · push 2
  - done when: no cast to reach `getAuthBaseUrl`; `tsc --noEmit` and the letterheads-ui suite green; the hook still
    fails closed when the export is missing at run time (test).

### End-to-end, review, owner

- [x] T68: e2e — protected details: confirm and cancel on save, the restore dialog's list, no dialog for an address-only change, the notice in the notification centre (it and en) — refs: AC-9.1, AC-9.2, AC-9.3, AC-9.5, AC-9.6, AC-9.7, AC-9.13, AC-9.17 — deps: T41, T57, T59, T60, T67
  - touch: `shell/e2e/protected-legal-details.spec.ts`, `shell/e2e/helpers/legalEntitiesFixtures.ts`, `shell/e2e/legal-entities.spec.ts` (added 2026-11-18, QE T43: make T42's history tests independent of the number of versions — version 1 may be on a later page — and restore `before.ibanPrint` in the refusal test)
  - agent: quality-engineer · push 2
  - done when: Playwright green — an admin changes the IBAN typed with spaces and lower case: the dialog shows Old
    and New grouped, Cancel is focused; Escape → nothing saved (the history unchanged); Confirm → saved, and within
    60 s the welld_ch manager and the actor see the notice in the notification centre (Italian when the shell is
    Italian), with the history link opening `view=history`; an address-only save shows no dialog and no notice;
    the restore dialog lists the protected differences; keyboard only; `axeViolations` 0 on the dialog.

- [x] T70: Security re-review, frontier tier — US-9 surfaces and the F2–F7 fixes (plan § Security amended) — refs: AC-9.12, AC-9.14, AC-4.2, AC-2.7 — deps: T52, T53, T54, T55, T56, T57, T58, T59, T60, T61, T62, T63, T64, T65, T66, T67
  - touch: `specs/20261117-legal-entities/security-review.md`
  - agent: owasp-reviewer (frontier tier: financial data, R1)
  - done when: a dated "Re-review" section in `security-review.md` covers every surface of the amended § Security
    (check route, notice duty and dispatcher, notify-api idempotency and template binding, `recipientId` scope,
    AC-9.12 on every record) and marks F2–F7 each fixed or not, with no open high or critical finding.

- [ ] T71: **[OWNER]** Release step 7 — set `LEGAL_ENTITY_NOTICE_EMAIL` (the address the owner gives, OQ-7), confirm the notice path in production, and only then allow `legal-entity:manage` for anyone but the `admin` role — refs: AC-9.8, AC-9.10 — deps: T49, T70
  - touch: `specs/20261117-legal-entities/release-log.md`
  - agent: owner (devops may prepare the commands)
  - done when: the release log says the variable is set (or deliberately unset), env-doctor production green, auth
    logs the dispatcher started with no `legal_entity_notice_overdue`, notify-api's email group is configured, the
    owner has received the outside mailbox's first notice or recorded why none was triggered, and the date from
    which managers may be granted (no address and no value in the log).

### Follow-ups FU-1…FU-10 — dispositions (plan G14)

FU-1 → T63 · FU-2 → T63 · FU-3 → T40 (320 px check) and T45 · FU-4 → T51 (copy), applied in T40 · FU-5 → no code,
ADR candidate 8 of the plan · FU-6 → T53 · FU-7 → T40 (widened) with T51's copy · FU-8 → T40 (widened) · FU-9 → T65 ·
FU-10 → T66.

### Coverage check (re-sync)

Every AC-9.x has at least one implementing task (table "AC coverage" above, rows AC-9.1–AC-9.17): AC-9.1 T55 T60 ·
9.2 T60 · 9.3 T60 · 9.4 T60 · 9.5 T55 T60 · 9.6 T60 T40 · 9.7 T58 T59 · 9.8 T58 · 9.9 T58 T59 · 9.10 T58 T59 ·
9.11 T54 T57 T59 · 9.12 T57 T59 · 9.13 T56 T57 T59 · 9.14 T56 T58 T59 · 9.15 T58 T59 · 9.16 T58 · 9.17 T55 T58 T60;
verified by T68 (e2e), T45 (QE), T70 (review). All 52 ACs covered; every new task refs at least one AC. Nominal refs
(not coverage): T69 (changesets), T70 (review), T71 (owner step).

### Overlap check (new tasks; deps ∪ `touch:`)

Ordered by an explicit dep:

- `auth/src/legalEntities/write.routes.ts` — T52, T55, T58, T59: T52 → T55 → T58 → T59 (one file, four reviewable
  steps; push-1 edits first so the push-1 cut cherry-picks cleanly).
- `auth/src/index.ts` — T52, T55, T59: T52 → T55 → T58 → T59.
- `auth/src/lib/env.ts` — T52, T58: T52 → T58.
- `auth/src/legalEntities/write.routes.test.ts` — T52, T53: T52 → T53. (T55, T58, T59 test in their own files.)
- `auth/src/legalEntities/testDb.ts` — T53 writes the host guard, T59 uses it: T53 → T59.
- `notify-api/src/system/emails.*`, `notify-api/src/channels/email.channel*` — T56, T57: T56 → T57.
- `admin-ui/src/strings/legalEntities.ts`, `admin-ui/src/lib/legalEntitiesApi*` — T60, T61 (and the widened T40):
  T60 → T61 → T40. `admin-ui/src/components/LegalEntityForm*` — T60, T40: T60 → T40.
  `admin-ui/src/components/LegalEntityHistory*` — T61, T40: T61 → T40.
- `.changeset/*` — T69, and the open T44, T16, T48: T69 → T16 → T44 → T48.
- `specs/20261117-legal-entities/release-log.md` — T71 and the open owner tasks: T49 → T71.
- `compose.yaml`, `infra/README.md`, `auth/.env.example` — T67 only among open tasks (T12, T21 done).

No overlap: `auth/prisma/*` (T58 only), `notify-api/prisma/*` (T56 only), `auth/src/legalEntities/import.ts` (T54
only), `rules.ts`, `routerTable.test.ts`, `auth.mount.test.ts` (T55 only), `lib/notify.ts` (T59 only),
`AuditPage*` (T62 only), crm-ui (T63 only), letterhead-api (T64 `api/src/routes/render.rs`, `api/src/registry/cache.rs`
vs T65 `engine/src/sample/**`, `api/tests/preview.rs`), letterheads-ui (T66 only), `security-review.md` (T70 only),
`design.md` (T51 only).

Push boundary: push-1 tasks T52–T57, T67, T69 depend only on push-1 tasks and on T51 (docs).

### Parallel batches (new tasks)

| Batch | Tasks | Note |
| --- | --- | --- |
| N1 | T51, T52, T54, T56, T62, T64, T66 | T51 (copy) gates T57, T59, T60, T63, T65 |
| N2 | T53, T55, T57, T63, T65, T67 | |
| N3 | T58, T60, T69 | |
| N4 | T59, T61 | |
| N5 | T68, T70 | the widened T40 runs here too (after T61) |

Then the existing tail: T43 (after T63–T66) → T45 → T47 and T16 → T17 → T18 → T44 → T48 → T49 → T71 → T50.
Critical path: T51 → T57 → T59 → T68 → T45 → T16 → T17 → T18 → T44 → T48 → T49 → T71 → T50.
- Orchestrator decisions on T51's design drift (2026-11-17, owner asked not to be interrupted; recorded for review):
  DR-14 — administrators: the `admin` role holds `legal-entity:manage` unconditioned by seed (T3), and department
  admins inherit the same role, so every effective administrator can open the history link; no design change.
  DR-17 — the push text on a lock screen may show the actor's name and the two IBAN tails: allowed by AC-9.12 and
  the owner's "push in English" reading; accepted. DR-13, DR-15, DR-16, DR-18 — as the design says; DR-18 goes to T63.
- FU-11 (T67): `legalEntityConfigProblems` (env-doctor) is checked only against the shipped template; wiring it into
  `tools/env-doctor/check.ts` `checkSuite` would apply it to deployed values. The copy role's SQL (runbook step 3a)
  is untested — T45 rehearses it on compose.
- FU-12 (T22, T65): `letterhead-api/api/tests/render.rs:680` (server start / wait for `/health`) failed once under
  parallel load in two separate runs and never on rerun — a start-up timeout or `free_port` race. QE (T45) to
  decide whether to widen the start-up wait or serialise the binary-spawning suites; CI has been green.
- Orchestrator decision (2026-11-18, T40 report): design S12 says both buttons are `aria-disabled` while the
  confirmation is busy; `@operai/ui` `ConfirmDialog` disables Confirm natively while `busy` (shared library
  behaviour for every dialog of the suite). Accepted as is: the busy state is short and announced, axe is clean;
  design.md S12 is read as "Confirm unavailable while busy". No library change.
- Security re-review (T70, 2026-11-18): PASS WITH NOTES, 0 medium+. N2 → T76. N1 (actor's display name is
  editable by its holder and appears in the notice) is an OWNER decision left open for the morning: options are
  making the name read-only for registry managers, or adding the actor's email to the notice. N3–N7 info, see
  security-review-2.md; N4 is checked at release step 7 (T71).
- FU-13 (QE T43): `shell/e2e/crm-offer-wizard-pages.spec.ts:380` needs ink in the page-number corner of the
  letterhead fixture `shell/e2e/fixtures/letterhead-a4.pdf`, which has none — pre-existing, unrelated to this
  feature. AC-6.3's e2e reaches an incomplete entity by a direct DB insert, because AC-1.2 makes the API refuse one;
  in production the only incomplete state is a moved version 1 (AC-7.3), which T45's move rehearsal covers.
