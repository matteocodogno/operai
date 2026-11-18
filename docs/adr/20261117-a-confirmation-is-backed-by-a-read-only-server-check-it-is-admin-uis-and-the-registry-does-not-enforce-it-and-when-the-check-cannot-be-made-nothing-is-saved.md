# 20261117 — A confirmation of a protected change is asked by admin-ui and backed by a read-only server check (`POST /legal-entities/{entity}/versions/check`); the registry does not enforce it, and when the check cannot be made nothing is saved

**Date:** 2026-11-17  
**Status:** Accepted — spec US-9 AC-9.1 to AC-9.6 and AC-9.17 and the Non-goal "a confirmation enforced by the registry itself" (owner decision 2026-11-17, OQ-13: accepted), approved with the plan amendment "after security review" (2026-11-17). Plan ADR candidate 7.  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

Security review F1 (medium): a manager can change the IBAN, legal name or VAT number of a legal entity with one click, and the change is printed on every document within 60 seconds (ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds). The owner's answer (US-9) is a confirmation that shows the old and new value before a protected change is stored, plus a notice afterwards (ADR 20261117-notices-of-a-protected-legal-entity-change-are-a-durable-duty-an-outbox-written-in-the-versions-transaction-sent-at-least-once-for-24-hours-with-outcomes-in-the-audit-log). The owner declined a recent sign-in, a second person's approval, a delay and a shorter session (spec Non-goals).

The page must ask only when the save would really change a protected detail "as they would be stored" (AC-9.1): typing the same IBAN with other spacing or case asks nothing (AC-9.5), and an address or contacts change asks nothing. What is stored is decided by the rules in `auth/src/legalEntities/rules.ts` (NFC, trim, IBAN without whitespace and in capitals, then `changedFields`); plan decision 10 keeps those rules in `auth` alone ("validation lives in auth only").

## Decision

We will have admin-ui ask `auth` what a save would change before it saves, through a read-only route that runs the save's own rules and authorisation, and show the confirmation only for the protected changes it returns. The registry does not require that a confirmation happened: a direct caller of `POST …/versions` is not asked and is covered by the notice only. If the check cannot be made, the page saves nothing.

(Plan, G1 point 7, G5, G7, G12; `auth/src/legalEntities/check.routes.ts`, `admin-ui/src/components/LegalEntityForm.tsx`, `ProtectedChangeDialog.tsx`, `ProtectedChangeList.tsx`, `RestoreDialog.tsx`, `admin-ui/src/lib/legalEntitiesApi.ts`; tasks T55, T60, T61, D3.)

1. **The route.** `POST /legal-entities/{entity}/versions/check` takes exactly the save's body `{ baseVersion, details }` and answers `{ baseVersion, outcome: "change" | "same", changedFields, protectedChanges: [{ field, before, after }] }`, with `before` and `after` in their stored form (legal name and VAT trimmed and NFC, the IBAN in print form, `""` for empty). `protectedChanges` holds only `legalName`, `vatNumber` and `iban`, via `protectedChanged` in `rules.ts`, the same function the notice uses, so the page and the notice cannot disagree about what is protected.
2. **Same door as the save, nothing written.** The same authorisation (a deleted person and an uncovered entity are refused as in the save) and the same order of refusals: 401, 403, 404, 403, then its own per-person limiter (60 per 10 minutes, `LEGAL_ENTITY_CHECK_RATE_LIMIT`, counted after authorisation and before the body is read), 413, 422 `invalid_request`, 422 `invalid_legal_entity`, 409 `legal_entity_not_moved`, 409 `version_conflict` with `currentVersion`. One `SELECT` of the current version: no transaction, no advisory lock, no version row, no audit row, `Cache-Control: no-store`. The answer is advisory; the save re-checks `baseVersion` under the lock. A refusal echoes nothing the request sent; the 200 carries only values a manager can already read (AC-3.1) and the normalised form of what they typed.
3. **A refusal comes before the confirmation.** A 422, 409, 403 or 429 of the check takes the state of a save refused the same way, with no dialog (reading R-b); a confirmation is for a change that could be stored. A conflict or a lost grant after Confirm takes the existing conflict or lost states.
4. **The dialog.** `ProtectedChangeDialog` (on `ConfirmDialog`, no acknowledge checkbox, because with a field the library would not focus Cancel) lists each protected detail that changes with visible "Old" and "New" labels, "None" for an empty side, the legal name and VAT in full and the IBAN in groups of four. Cancel, Escape and the close control send nothing, keep every typed value and put focus back on Save. Confirm sends **one** save with the body that was checked (`open.sent`, `open.baseVersion`), not a re-read of the form. A confirmation is never remembered: every Save checks again (AC-9.3). The restore dialog lists the protected details that differ between the current version and version n, read from the two `LegalEntity` answers; if version n cannot be read, Confirm is unavailable with the reason and Retry.
5. **Fail closed.** A check that fails any way but a refusal (network, 5xx, 404 while services are updated one after the other, an answer this build cannot read) shows "could not check" with Retry and saves nothing: without the check the page cannot know whether to ask.
6. **The registry does not enforce it.** `POST …/versions` does not require a prior check, and there is no `confirmation_required` answer (spec Non-goal, OQ-13). The notice is the control for a caller who goes to the registry directly, and the check is a convenience of the page that happens to be an accurate one.
7. **Routing.** The route is registered with `router.on("POST", <exact path>)`, never a wildcard, and shares no pattern with a GET guard, so it cannot flip the app to another router (plan G12, D1); `routerTable.test.ts` accepts exactly three POSTs.

## Failure shape

**A decision that depends on a rule is taken in a second place that holds its own copy of the rule, or a prompt that only the well-behaved client sees is taken for a control.** The first fails by drift: two rule sets disagree, so the page asks about a change that is not one (spacing-only IBAN), or fails to ask about a real one, and nothing shows it until someone is annoyed or someone is defrauded. The second fails by mistaken coverage: the friction stops accidents and is bypassed by anyone who calls the API, so the team believes a protection exists that does not.

Where else this shape can appear, including the mirror-image positions:

- **Client and server.** Any client-side preview of a server rule (a price, a normalisation, a permission, a limit) should ask the server, with the same rules and the same authorisation, rather than mirror it; recognise it by a second implementation of a function the server already has. The mirror: a server that checks something the client's own prompt already told the person, and answers differently.
- **Dry run and real run.** A dry run must refuse in the same order, with the same checks, and the same normalisation as the action; if it diverges, the person is asked a question about a different change than the one stored. It must also not become an oracle: same authorisation, nothing echoed, its own limiter, nothing written.
- **Check and act.** The check can be stale by the time of the act (a newer version, a lost grant); the act must re-decide under its own guard, and the page must handle that refusal after the confirmation as well as before.
- **Unavailable check.** A guard that cannot be consulted must stop the action, not wave it through; "could not check, nothing saved" is the shape, and the reverse (save anyway, ask nobody) is the failure.
- **UI-only guards and direct callers.** Every UI-only confirmation (delete, publish, bulk change) is a convenience; say so in the record and cover the direct caller by something else (here a durable notice). A new confirmation that is meant to be a real control must be enforced by the server, with a different design.
- **Dialogs built on a shared library.** A confirmation is a surface where a defect can pass every unit test and still not work (see ADR 20261118-a-dialog-that-renders-its-own-form-is-mounted-beside-the-form-never-inside-it).

## Options considered

### Option A — admin-ui asks a read-only server check, the registry enforces nothing, a failed check saves nothing (chosen)

Described above.

**Pros:**
- One rule set, in `auth`; the page asks only about what would be stored, and "same IBAN, other spacing" asks nothing by construction
- The check answers with the stored form of both sides, so the dialog shows what will be in the history
- No change to the save's contract; old callers and the import are unaffected

**Cons:**
- One more request per save (a round trip before the save, 60 checks per 10 minutes per person)
- A direct caller is not asked; the confirmation protects against mistakes and hurried clicks, not against a stolen session (that is the notice's job, and N4's limits apply)
- A check outage stops saves from the page (during a deploy with services updated one after the other, "could not check" appears until `auth` has the route; it is in the first push so the second push's admin-ui finds it, plan G15)

### Option B — A client copy of NFC, trim and IBAN normalisation (rejected)

**Pros:**
- No round trip

**Cons:**
- Two rule sets that can drift; a drift would ask for a spacing-only IBAN change (breaking AC-9.5) or skip a real one. Contradicts plan decision 10.

### Option C — The save itself refuses with `confirmation_required` until the caller repeats with a confirmation flag (rejected)

**Pros:**
- Enforced for every caller

**Cons:**
- That is "a confirmation enforced by the registry", an owner Non-goal (OQ-13); the owner chose the page's step plus the notice

### Option D — Ask on every save, whatever changed (rejected)

**Pros:**
- No check needed

**Cons:**
- Contradicts AC-9.5 and AC-9.17 ("so the signal stays rare"); a prompt on every save is clicked through

### Option E — Save when the check fails, so the page keeps working (rejected)

**Pros:**
- Availability

**Cons:**
- Without the check the page cannot know whether to ask, and the confirmation could be skipped by an outage

## Evidence

- Server: `auth/src/legalEntities/check.routes.test.ts` (`protectedChanges` against `baseVersion`, stored forms, only protected fields, `outcome`; no version, audit or notice row from a check), `routerTable.test.ts`, `auth.mount.test.ts`.
- Page: `admin-ui/src/components/LegalEntityForm.protected.test.tsx`, `ProtectedChangeDialog.test.tsx`, `lib/legalEntitiesApi.test.ts`; e2e `shell/e2e/protected-legal-details.spec.ts` (13 pass, including Confirm saves with the keyboard, a newer version saved while the dialog is open, refusal before the dialog, conflict after it, Cancel/Escape/close store nothing) per specs/20261117-legal-entities/qe-report.md AC-9.1 to AC-9.6; skew D: the check is asked first.
- Security re-review (security-review-2.md, T70): the check route sound (authorisation chain, own limiter, one SELECT, no echo); admin-ui "a check that fails any other way says so and saves nothing; Confirm sends the very body that was checked".

## Consequences

**Positive:**
- A person who changes a payment detail sees the old and new value, stored as stored, before it goes live
- Rule changes in `rules.ts` reach the page without a client release
- The same function decides what the notice announces

**Negative / trade-offs:**
- The confirmation can be bypassed by a direct API call; this is recorded, owner-accepted, and must not be described as enforcement in docs or in the UI copy
- A third surface that depends on `protectedChanged` (check, notice, restore dialog's own comparison of two versions): the restore dialog compares the two stored versions in the page, not through the check, because both versions are already read

**Risks:**
- **Skew.** Admin-ui from the second push needs the check route from the first; `auth` serves it before (plan G15). A 404 during a rollout is "could not check", never a silent save.
- **The check as load or oracle** (R22): same authorisation, own limiter, writes nothing, answers only what a manager can read.
- **A new protected field** must be added to `PROTECTED_FIELDS`; the check, the notice and the dialogs follow from it, but the copy (designer) and the notify-api template's closed lists (ADR 20261117-notify-api-system-routes-protect-against-repeats-by-a-caller-scoped-idempotency-key-and-bind-a-template-to-its-caller-with-closed-typed-data) must be extended too.

## Escalation triggers

This decision is revisited when any of these happens:

- the owner wants the registry to enforce a confirmation, a recent sign-in, a second approval or a delay (spec Non-goals are owner decisions of 2026-11-17);
- a second tool edits legal details and needs the same question: the check is the registry's, so it is reused, not copied;
- the rules in `rules.ts` gain a rule the dialog cannot show (a derived field).

## Compliance notes

- GDPR / data-protection impact: low. The check's answer holds the values of the entity's own details, which any manager can already read (AC-3.1); nothing is stored, logged or put in a URL, and drafts stay in memory.
- Data residency: no change.
- Audit trail: a check writes none (AC-9.2); the save and its audit are unchanged, and a confirmation is not recorded as a fact (it is a step of the page).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
