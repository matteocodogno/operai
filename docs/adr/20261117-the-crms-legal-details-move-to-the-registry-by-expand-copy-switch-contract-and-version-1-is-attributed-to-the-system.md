# 20261117 — The CRM's legal details move to the registry by expand → copy under an announced settings freeze → switch → contract, an operator-run script in `auth` writes version 1 as the system, and nothing is overwritten

**Date:** 2026-11-17  
**Status:** Accepted — approved plan of specs/20261117-legal-entities (approved 2026-11-17); applies the pattern the owner accepted in ADR 20261110-activities-migration-write-pause; amendments D2 (IBAN print) and D3 (values the new rules refuse) accepted by the owner 2026-11-17. Plan ADR candidate ADR-4, recorded as a **new ADR** and not as an addendum to ADR 20261110 (see Decision, point 8).  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

The legal name, address, VAT number and IBAN of welld_it and welld_ch exist today only in `crm-api`'s `entity_profile` table. specs/20261117-legal-entities (US-7) requires that they move into the registry in `auth` with no retyping and with no document changing on the day of the release (AC-7.5): version 1 holds the CRM's values, is attributed to the system, is recorded in the audit log, and a second run changes nothing. Two entities are moved, edited by a handful of people through a CRM settings form. As in ADR 20261110-activities-migration-write-pause, a push to `main` redeploys every changed service in no guaranteed order, so the sequence of pushes is part of the design. Three things differ from that move: the receiving service (`auth`), not the sending one, runs the copy; the source is edited by people, and the plan announces a freeze instead of switching writes off in code; and the registry applies stricter rules than the CRM did (the CRM allowed 5 address lines of 200 characters, a VAT of 50 and an IBAN of 50 with no check), so the values to be moved can fail them.

## Decision

We will move the details in four steps, each a separate push or operator action, and we will let the consumers switch only when the copy's report shows both entities present and zero mismatched: **expand** (auth only, the registry answers `version: 0`), **copy** (an operator-run, dry-run-by-default script in `auth` reads the CRM's `entity_profile` read-only and inserts version 1 of each entity, attributed to the system, with an audit row), **switch** (crm-api, crm-ui, letterhead-api, letterheads-ui and admin-ui together, correct in whatever order they come up), **contract** (a later release drops the CRM's four columns). The script never overwrites a version.

(Plan, Key decisions 9, 10 and 11; Release order; Sequences "Copy (script)".)

1. **Expand (push 1).** `auth` only: migration (table and triggers, ADR 20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database), `ADMIN_CATALOG` and seed, routes, the scope, the derived `apps` entry, the import script. No consumer reads the registry; `GET /legal-entities` answers `version: 0` for both. Then credentials, as environment only (`crm-api` scope extended, a new `letterhead-api` client), after push 1 is live, because `auth` refuses to start with a scope it does not know.
2. **Copy (operator).** Announce that CRM entity settings are not edited until the switch is live. Run `bun run scripts/import-crm-legal-details.ts` as a dry run, then `--apply`, then the dry run again. `CRM_DATABASE_URL` and `DATABASE_URL` come from the environment only (the L4 rule of ADR 20261110), the CRM connection is read-only (`default_transaction_read_only = on`), and the script prints no value. Per entity, under the entity's advisory lock: a version exists, then compare version 1 with the CRM row under the mapping (differs: **mismatched**, never overwritten; same: **present**); no version, then with `--apply` insert version 1 and its audit row in one transaction. The report counts found, inserted, already present and mismatched, plus incomplete, invalid and `ibanPrintChanged` flags; the owner reads the flags (D2, D3) before the switch.
3. **Mapping.** CRM's own print rule first (`oneLine` in `crm-api/src/offers/blocks.ts`: a line break and the blanks around it become one space, then trim: what the CRM printed); legal name; address lines without blank ones into **both** `address.it` and `address.en`; VAT; IBAN with all whitespace removed and upper-cased; contacts empty. No CRM row: version 1 with empty values (AC-7.3). Values over today's limits or failing the IBAN check digits are kept as they are and reported as `invalid` (D3); the page marks the entity until someone saves it correct.
4. **Attribution.** Version 1: `action: import`, `createdByUserId: null` (the system, shown as "system"), `changedFields` = all non-empty fields; audit action `legal_entity.import` with actor null, naming the source (`crm.entity_profile` and its `updatedAt`), the values after, `missing`, `invalid`, `ibanPrintChanged`. A CHECK ties `import` to version 1 and to a null creator.
5. **Pre-switch check.** A dry run just before push 2 must show present 2, mismatched 0: nobody edited the CRM legal fields since the copy. A mismatch is resolved by a registry save through the API by an administrator before going on; the script does not repair it.
6. **Switch (push 2).** Order-independent by construction: content v2 fails closed against an old `letterhead-api` (ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds); crm-api accepts and ignores the four legacy keys from an old crm-ui; crm-ui reads `issuerAddress` and falls back to `issuerAddressLines` from an old crm-api; admin-ui only calls `auth`, already live. The freeze ends when crm-api is live. Smoke per entity: preview an offer (classic and, where the switch is on, the service) and compare the issuer lines with the day before (AC-7.5). In crm-api, `entity_profile."legalName"` and `"addressLines"` get defaults (`''`, `{}`) so a profile row can be created by a PUT that no longer carries them; nothing is dropped.
7. **Contract (a later release, never in the switch push).** A crm-api migration drops `legalName`, `addressLines`, `vatNumber` and `iban` from `entity_profile`; the `issuerAddressLines` compatibility field and the legacy-key tolerance are removed; the script stays as history. Before the contract, reverting push 2 brings back CRM-sourced issuers (the columns are intact). Registry saves made after the switch are not in the CRM, and the runbook says so.
8. **New ADR, not an addendum to ADR 20261110.** An amendment in this repo changes or adds to the decision of the ADR it amends (ADR 20261116-letterhead-versions-assets-and-change-record-are-immutable-in-the-database has an "Amendment" section for its own TRUNCATE gap; ADR 20261110 carries its own L4 amendment). This decision changes nothing in ADR 20261110: it applies the pattern its Consequences call "reusable for the next one-off move", and AGENTS.md records as the suite's rule for moves, to a different move whose differences are decisions of their own (receiver-run script, announced freeze with detection instead of a code flag, stricter destination rules, attribution to the system, a pre-switch re-check). It carries its own failure shape and its own rejected options. ADR 20261110 is not edited; this ADR cites it.

## Failure shape

**A value is declared moved while its source can still change, and the destination applies rules the source never had, so the moved value is not what the world last saw.** Two silent losses follow. An edit made at the source between the copy and the switch is dropped, because the destination is already authoritative and nothing compares them. And a value the new rules refuse is either rejected by the move (so the record is not moved at all), or "fixed" by it (so documents print something nobody wrote). Neither shows as an error: the move reports success.

Where else this shape appears:

- **Copy and compare, again.** A re-run must compare an existing destination row with the source and report a difference; it must never overwrite (a "refresh" that wins silently destroys whatever was saved in the destination since). The mirror: a destination edited after the copy and a source that still says something else is not a drift to fix, it is the destination's value.
- **A freeze that is an announcement.** Without a flag that refuses writes, the freeze holds only until someone forgets it; the witness is the check just before the switch. Recognise it by asking, for every move, "what refuses a write on the source right now, and what would show it?". The window between that check and the switch is the part the announcement alone covers.
- **Write that goes nowhere.** After the switch, an old client may still PUT the legacy fields; the plan accepts and ignores them (a person editing a value that no longer exists). Any compatibility tolerance for an old caller is a write that is dropped silently: bound it in time, and remove it at the contract step.
- **Undo.** After the switch, new saves exist only in the registry. Reverting the switch brings back the CRM's older values, and a document made after the revert would print them. An undo is only as good as the writes made since; write down which data it loses.
- **Dependency inversion of the copy.** A copy run by the sender, the receiver, or a standing service connection each give a different credential posture. A temporary route, a push to a write-scoped endpoint, or a migration that reads another service's database leaves a standing capability or a standing credential behind (see Options).
- **Stricter rules at the destination.** Any move into a store with validation: decide before the move whether the invalid values move as they are, are refused, or are repaired, and report them. Here: moved as they are and reported.
- **Drop in the switch push.** The old columns are the undo. Dropping them in the same deploy as the switch removes the fallback before anyone has compared the output (the rule of ADR 20261110).

## Options considered

### Option A — Expand → copy by an operator-run script in `auth` → switch gated by the report → contract later; version 1 attributed to the system (chosen)

**Pros:**
- No new dependency between services: the script reads the CRM database read-only, once, under the operator's own environment
- Dry-run by default, re-runnable, never overwrites: a second run inserts nothing (AC-7.4) and mismatches are reported
- The report is the witness; the owner reads the flags before documents change
- The CRM columns stay until a later push, so reverting the switch is a working undo
- Values the new rules refuse are moved verbatim and marked, so no document changes on release day (AC-7.5)

**Cons:**
- The CRM settings freeze is an announcement, not a code refusal: an edit in the window is caught by the pre-switch dry run, not prevented
- The operator needs the CRM database credentials for the window of the copy
- Three pushes or steps in order (expand, switch, contract), plus an operator action; the contract is easy to forget

### Option B — A temporary crm-api system route, an `auth`-side self-minted credential and an automatic import loop (rejected)

**Pros:**
- No operator credential for the CRM database

**Cons:**
- A new `auth` → crm-api dependency and a second self-minted scope amending ADR 20261013-auth-mints-own-service-credential-in-process; an import that runs whenever both happen to be up, with no owner look at the flags before documents change

### Option C — crm-api pushes to a write-scoped `auth` endpoint (rejected)

**Pros:**
- crm-api holds its own data

**Cons:**
- A standing service capability to rewrite legal details, the exact payment-redirection fraud surface of the plan's Security section (R1)

### Option D — A Prisma migration in `auth` that reads the CRM database (rejected)

**Pros:**
- Runs automatically at deploy

**Cons:**
- The migration would carry another service's credentials on every deploy

### Option E — An addendum to ADR 20261110-activities-migration-write-pause (rejected)

**Pros:**
- One document for "how we move records"

**Cons:**
- That ADR's decision is about activities, a write pause in code and a per-table count; adding a different move, a different freeze and a different risk list to it would blur which rule applies to which. This repo amends an ADR when the decision it records changes, not when its pattern is reused (decision, point 8)

### Option F — Drop the CRM columns in the switch push, or no freeze at all (rejected)

**Pros:**
- Fewer steps

**Cons:**
- Drops the undo; a CRM edit between copy and switch would be lost with nothing to detect it

## Evidence

- Planned, not yet run (plan, Test strategy, MIG; AC-7.1 to AC-7.5): the move rehearsed on compose with a CRM `entity_profile` fixture set (complete; missing VAT; no row; 5 address lines; IBAN with spaces and lower case; IBAN with bad check digits; a value with a line break): dry run, apply, re-run (inserted 0, present 2, mismatched 0, no new audit row; a CRM value changed after the copy reported mismatched, registry untouched); golden comparison of the issuer lines of a classic offer and of a service render before (CRM source) and after (registry source); and the production dry run of release step 3 as a release gate, not CI, with the owner signing off `ibanPrintChanged` (D2).
- Pattern: ADR 20261110-activities-migration-write-pause (dry-run default, found / inserted / present / mismatched, contract in a later push, credentials in the environment only).

## Consequences

**Positive:**
- No document changes on the day of the release, or the owner has signed off exactly which one does (IBAN print)
- The registry starts with a version 1 that names its origin, and the move can be re-checked at any time before the contract
- Reverting the switch before the contract is a working undo

**Negative / trade-offs:**
- CRM entity settings are frozen for the announced window; saving legal fields meanwhile is the thing the pre-switch check exists to catch
- The old `entity_profile` columns stay, unread, until the contract release
- The script is one-off code that stays in the repository as history

**Risks:**
- **An edit after the pre-switch dry run and before crm-api is live is not detected.** The announcement and a short window are the only controls; the plan accepts this (R4). Mitigation: keep step 4 and push 2 close together; compare issuer lines in the smoke test.
- **The script's own stop rule is stated loosely.** The plan says it "refuses to run once every entity has a version" (Release order, step 6), while steps 3 and 4 run dry runs after the apply. Read together, the refusal can only apply once the CRM columns are gone (after the contract). To settle when the script is written, so the pre-switch dry run is not refused.
- **CRM values break the new limits (R3)** and the page shows them as invalid until saved; consumers print them as before. D3.
- **IBAN prints in another form than the CRM's text (R2).** D2: groups of four. Early check before push 1: read both IBANs in the production CRM settings; the owner signs off `ibanPrintChanged`.
- **Credentials for the CRM database (R14):** environment only, read-only session, never logged; reviewed as ADR 20261110's L4.
- **A mismatch found:** the switch does not happen; an administrator resolves it with a registry save (a new version through the API), and the script never repairs it.
- **Registry saves after the switch are not in the CRM.** The runbook says so; reverting the switch push loses them.

## Escalation triggers

This decision is revisited when any of these happens:

- a move needs a code-enforced write refusal (many editors, or a source edited by a service, not by a person): use ADR 20261110's maintenance flag, and this ADR does not apply;
- a third legal entity or a second source of legal details is added;
- the dry run in production reports a mismatch that the owner cannot attribute;
- the contract release is delayed past the next release train: the unread columns and the legacy-key tolerance become a standing silent-drop path.

## Compliance notes

- GDPR / data-protection impact: low. The details are a company's; the contacts line, empty after the move, may later name a person. The report and the audit row print or store legal values only as the plan states (the report prints no value, the audit row holds the values after for the import), and no dump or file is written.
- Data residency: compliant provided both databases are in an EU region and the operator's connection to them is the one the deploy uses.
- Audit trail: required (AC-7.2). One `legal_entity.import` audit row per entity, actor null, written with version 1 in one transaction; the printed report is kept with the release notes as the record that the move was accounted for.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
