# Release log — specs/20261117-legal-entities

Counts, categories and names only: no value, connection string, address or secret is written here (infra/README.md §
Legal entities rollout). Release session of 2026-11-18, run by the orchestrator on the owner's instruction, owner
sign-offs noted where given.

## Step 0 — preconditions

- QE PASS (T45, deltas §15–§16), security re-review closed (T70, deltas incl. D9), eval round 4 PASS 80.0.
- Freeze of the CRM's entity settings: announced by the owner before Step 3 (2026-11-18), ended when crm-api 0.6.0 was live.
- Early check R2 (T15): both entities hold **no IBAN** in the production CRM (`IBAN none`); there is no print to compare.
  The owner confirmed this is expected (2026-11-18). `ibanPrintChanged` 0 on every run.

## Step 1 — push 1 (T16): operai 0.6.0

- Squash of the push-1 tasks on `main`, then the release commit `62b372d5` (tags `operai@0.6.0`, `@operai/auth@0.6.0`,
  `@operai/notify-api@0.5.0`, `@operai/ui@0.5.0`, `@operai/shell@0.3.1`, and the apps already pending on main).
- Gates before the push: env-doctor (production template), shared-copies, react-skew, ui:check, `railway config plan`
  no drift; auth 1263/0, notify-api 664/0 on the push-1 tree.
- Live: auth `/health` 0.6.0 (migration `20261117100000_legal_entities` applied in preDeploy), notify-api 0.5.0,
  `version.json` 0.6.0, `railway config plan` no drift.

## Step 2 — credentials (T17)

- Shared variable `LETTERHEAD_SERVICE_CLIENT_SECRET` created by the owner in the dashboard.
- auth `SERVICE_CLIENTS`: `crm-api` scope += `legal-entities:read`; new `letterhead-api` entry (reference to the shared
  variable, scope `legal-entities:read` only). Existing entries unchanged. auth redeployed healthy.
- letterhead-api: `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` (reference) set.
- `env:doctor --env production --live`: the legal-entities links green. Its only errors are meetings-api's three
  `SET-ME` template placeholders, unrelated to this release (the deployed values are real).

## Step 3 — copy (T18)

- 3a: role `legal_copy_ro` created; limits proved (`count` 2; `offerTermsEn`, `letterheadKey`, `UPDATE`, `deal_offer` all
  `permission denied`). Password rotated before each run, only its SCRAM verifier sent; never stored or shown.
- Dry run 1: `found 2 | would insert 2 | present 0 | resolved 0 | mismatched 0`; flags `incomplete 0 | invalid 0 |
  ibanPrintChanged 0`; welld_it, welld_ch `IBAN none`; ACCOUNTED FOR. CRM session read only (no `crm_not_read_only`).
- `--apply`: `found 2 | inserted 2 | mismatched 0`; same flags; ACCOUNTED FOR.
- Dry run 2: `found 2 | would insert 0 | present 2 | resolved 0 | mismatched 0`; same flags and IBAN lines.

## Step 4 — pre-switch check

- Dry run just before push 2: `present 2 | mismatched 0`, IBAN lines unchanged.

## Step 5 — push 2 (T44, T48): operai 0.7.0

- Squash of the push-2 tasks on `main`, then the release commit `e7dbcc97` (tags `operai@0.7.0`, `@operai/auth@0.7.0`,
  `@operai/crm-api@0.6.0`, `@operai/crm-ui@0.6.0`, `@operai/letterhead-api@0.2.0`, `@operai/letterheads-ui@0.3.0`,
  `@operai/admin-ui@0.3.0`).
- Gates before the push: env-doctor, shared-copies, react-skew, `railway config plan` no drift; crm-api 2277/0,
  admin-ui 1100/1100, letterheads-ui 539/539 on the push-2 tree.
- Live: auth 0.7.0 (notice migrations applied; "notice dispatcher started"), crm-api 0.6.0 (migration
  `20261117120000_legal_details_moved` applied), letterhead-api up, `version.json` 0.7.0.

## Step 5b — post-switch dry run (T49, part)

- `found 2 | present 2 | resolved 0 | mismatched 0`; flags 0; IBAN lines unchanged.
- **Open (owner):** the issuer-line comparison with the day before, per entity, on a classic offer preview.

## Step 3b — copy role

- copy role dropped; `SELECT count(*) FROM pg_roles WHERE rolname = 'legal_copy_ro'` → 0.

## Step 7 (T71) — open (owner)

- `LEGAL_ENTITY_NOTICE_EMAIL`: not set yet; the owner sets it in the dashboard. Until Step 7 is done, only the `admin`
  role holds `legal-entity:manage`.

## T87 — not run

- R-D9a is decided (a malformed author email counts as no address on record), so the count is informational only.
