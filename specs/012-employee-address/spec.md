---
id: 012
slug: employee-address
status: in-progress
rigor: production
created: 2026-08-03
approved: 2026-08-03
---

# Employee address: admin-managed, autocomplete-assisted capture

## Problem

wellD does not currently record where an employee lives anywhere in Operai. There is no
field for it on any identity or admin surface, so today an admin who needs an employee's
home address has to ask them directly, off-system, every single time the need arises —
nothing is stored, nothing is centrally admin-manageable, and no change to it is ever
recorded. Typing a full street address by hand is also slow and error-prone (getting a
postal code or locality spelling exactly right unaided), so capturing it should be fast
and forgiving — suggestions should appear as an admin types, the way modern address
forms already work, rather than requiring painstaking manual entry as the only option.
An employee, meanwhile, has no way to check what address — if any — wellD holds on
their behalf without asking an admin directly.

## Domain language

Extends the suite's existing identity/admin vocabulary (`specs/004-auth-roles-permissions`,
`specs/006-user-invitations`) unchanged except where introduced below.

- **employee address** — a single, current home/mailing address recorded for a specific
  employee (an Operai user). At any moment an employee has AT MOST one stored address:
  either "no address on file" or exactly one current value — never multiple addresses
  (e.g. home vs. billing) and never a retained, browsable history of superseded values
  beyond whatever the audit trail (US-5) preserves.
- **structured address components** — the individual fields making up an address.
  Exactly four are REQUIRED before an address can be saved: country, city/locality,
  street, and house/building number (see AC-1.4). Postal code and any additional
  locality-specific component a country's addresses may carry (e.g. a state/region/
  canton) are OPTIONAL — captured when an address suggestion supplies them (US-2), but
  never required for a save to succeed.
- **formatted address** — the single, human-readable string representation of an
  employee's address, derived from its structured components, shown wherever an admin or
  the employee themselves views the address without reading every individual field.
- **address suggestion** — one candidate address offered by an external address-lookup
  service while an admin is typing, presented as a selectable shortcut that pre-fills the
  structured components, formatted address, and coordinates. Selecting a suggestion is
  always optional (US-2/US-3) — it never becomes the only way to enter an address.
- **address-suggestion service** — the external, third-party service consulted, live, as
  the admin types, to produce address suggestions. Referred to generically in this spec's
  behavior (the specific vendor is a Constraint, not an acceptance criterion — see
  Constraints).
- **coordinates** — the latitude/longitude pair an address suggestion carries, captured
  and stored alongside an address only when the admin selected that suggestion (US-2),
  for a plausible future distance/mileage use. No downstream use of coordinates is
  implemented by this feature (see Non-goals); they are never required for a save to
  succeed (US-3), and they go stale/are cleared if the address's text is subsequently
  hand-edited without a fresh suggestion selection (US-2).
- **self-view** — an employee's own, read-only capability to see their own stored address
  (US-6). Distinct from, and strictly narrower than, the admin capability (US-1/US-4)
  that is the only way to create, change, or clear it.

## User stories

### US-1: Admin views and updates an employee's address

As an admin, I want to see and set an employee's home address from wherever I already
manage that employee's profile, so that wellD has a reliable, current, centrally-managed
place to look it up instead of asking the employee off-system every time.

**Acceptance criteria:**
- AC-1.1: Given an authorized admin opens an employee's profile in the Admin tool's Users
  section, when the address section loads, then they see that employee's currently
  stored address in its formatted, human-readable form, or a clear "no address on file"
  indicator if none has ever been set.
- AC-1.2: Given an authorized admin enters or changes an employee's address and saves,
  when the save completes, then the new address is persisted and is exactly what is shown
  the next time that employee's profile is opened (e.g. after a reload).
- AC-1.3: Given an authorized admin clears an employee's previously-set address entirely
  and saves, when the save completes, then that employee's address reverts to "no address
  on file" — an intentional clear, distinct from a validation failure (mirrors specs/011
  AC-1.4's clear pattern).
- AC-1.4: Given an admin has typed or selected an address missing one or more of the four
  required structured components — country, city, street, or house/building number
  (Domain language) — and attempts to save, then the save is rejected with a clear
  message identifying exactly which of the four is missing; postal code and any
  region/state/canton component are never a reason a save is rejected, since both are
  optional (Domain language). An address, once any part of it is entered, must supply all
  four required components before it can be saved; it is never persisted half-filled.

### US-2: Fast, suggestion-assisted address entry

As an admin, I want address suggestions to appear as I type an employee's address, so
that I can enter it quickly and accurately without having to know or correctly type every
detail (exact postal code, locality spelling, etc.) myself.

**Acceptance criteria:**
- AC-2.1: Given an authorized admin is editing an employee's address field, when they
  type at least a few characters of a real-world street/place, then a list of matching
  address suggestions appears — updating live as they keep typing — with no page reload
  and no explicit "search" action required.
- AC-2.2: Given the admin selects one of the presented suggestions, when they do, then
  every one of the address's structured components (at minimum: street and house/
  building number, postal code, city/locality, and country) plus a single
  human-readable formatted address are populated automatically, with no further manual
  retyping needed for what the suggestion already provided.
- AC-2.3: Given an admin selects a suggestion and then further edits one or more of the
  populated fields by hand afterward, when they save, then the manually-edited values are
  exactly what is persisted — selecting a suggestion pre-fills the fields, it never locks
  them against further editing.
- AC-2.4: Given an admin is typing an address, when suggestions are returned, then
  addresses in Switzerland and Italy are ranked/prioritized first among the suggestions
  shown — reflecting wellD's two operating countries — but the admin can still ignore the
  suggestions and type, or scroll to and select, an address in ANY other country; the
  ranking bias never prevents a non-CH/IT address from being entered and saved (AC-1.2
  applies identically regardless of country; see also Non-goals on the absence of
  country-specific format validation).
- AC-2.5: Given an admin selects a suggestion (AC-2.2), then that suggestion's
  latitude/longitude coordinates are captured and stored alongside the address's
  structured components and formatted address.
- AC-2.6: Given an admin selects a suggestion (capturing coordinates, AC-2.5) and then
  edits the address's text or structured fields by hand afterward without selecting a
  fresh suggestion (AC-2.3), when they save, then the previously-captured coordinates are
  cleared/discarded rather than retained — stale coordinates that no longer match the
  edited text are never silently kept alongside it.

### US-3: Manual entry always works, with or without suggestions

As an admin, I want to be able to type an employee's address in by hand and have it save
correctly even when no suggestion appears or the suggestion feature isn't working, so
that a third-party lookup hiccup never stops me from recording an address.

**Acceptance criteria:**
- AC-3.1: Given the address-suggestion service returns no matching suggestions for what
  the admin has typed (an unusual address, a typo, or a locality it doesn't recognize),
  when this happens, then the admin can still fill in every structured field by hand and
  save successfully — no suggestion ever having appeared is never itself a reason a save
  is refused.
- AC-3.2: Given the address-suggestion service is unavailable, times out, or is
  rate-limited at the moment the admin is typing, when this happens, then the admin sees
  no broken or stuck-loading state on the address field — it remains fully editable by
  hand, and saving a manually-completed address proceeds exactly as in AC-1.2, with no
  error surfaced that treats the suggestion feature's unavailability as a reason the save
  itself is blocked.
- AC-3.3: Given an admin who never interacts with the suggestion list at all (types the
  whole address by hand from the first keystroke through save), when they save, then it
  is accepted on exactly the same terms as one entered via a selected suggestion
  (AC-1.2/AC-1.4) — using suggestions is always optional, never a required step to
  produce a savable address.
- AC-3.4: Given an admin manually types and saves an address without ever selecting a
  suggestion (AC-3.3), when the save completes, then it succeeds WITHOUT any coordinates
  recorded for that address — coordinates are only ever captured when a suggestion is
  selected (AC-2.5); their absence is never a reason a manually-entered address is
  rejected.

### US-4: Only an authorized admin may view or change an employee's address through the admin surface

As wellD, we want an employee's home address visible and editable, through the admin
surface, only to admins authorized to manage employee profiles, enforced by the server
and not merely hidden in the UI, so that this personal data isn't exposed to or alterable
by anyone who has no business seeing or changing it.

**Acceptance criteria:**
- AC-4.1: Given a user who lacks the existing admin user-management capability that
  already governs editing users, roles, and departments (specs/004/006) — no new,
  dedicated capability is introduced for this feature (see Constraints) — when they
  attempt to view or change any employee's address — including their OWN — through the
  Admin tool's screens or its underlying admin API directly, then the attempt is denied
  by the server; a UI-only hidden field is not sufficient (mirrors specs/009 AC-4.6 /
  specs/011 AC-3.1's posture). An employee's own read-only view of their own address
  (US-6) is a separate, narrower capability, entirely unaffected by this gate.
- AC-4.2: Given a user who lacks that capability, when they view the Admin tool's
  employee profile screen, then the address section is not shown to them at all — a
  denied capability is invisible, not merely disabled (mirrors specs/011 AC-3.2).

### US-5: Address changes are auditable

As wellD, we want every change to an employee's stored address recorded immutably at the
application level — no code path in `auth` updates or deletes an audit record once
written — with who changed it, when, and its old and new value, so that a change to this
personal data is always traceable to a specific actor and moment. This reuses the
existing audit mechanism already present in the `auth` service (see Constraints) rather
than introducing a new, feature-specific audit table; it is a narrower guarantee than the
suite's database-level-immutable financial/governance records (see Constraints, and the
asymmetry noted there).

**Acceptance criteria:**
- AC-5.1: Given an authorized admin sets, changes, or clears an employee's address, when
  the change is saved, then an audit record is created capturing the actor, the
  timestamp, the affected employee, the old value (or "no address on file" if there was
  none), and the new value (or "no address on file" if cleared).
- AC-5.2: Given a recorded address-change audit record, then it is immutable at the
  APPLICATION level, via `auth`'s existing audit-writing facility (see Constraints) — no
  production (non-test) route, service, or repository code path in `auth` updates or
  deletes an audit record once written, and the audit API surface exposes no update/
  delete verb for it. This is an APPLICATION-level guarantee only, not a database-level
  one (see Constraints for why it was downgraded); it explicitly EXCLUDES test-only
  teardown code (`deleteMany` calls in `*.test.ts` files and `scripts/e2e-*` fixtures),
  which resets state between test runs and is not itself a violation of this guarantee.
- AC-5.3: Given an authorized admin, when they open the audit history for an employee's
  address, then they see the chronological list of every change made to it (who, when,
  old value, new value).
- AC-5.4: Given an admin submits a save whose address is identical to the employee's
  currently stored address (a no-op), then no new audit record is created — audit history
  reflects actual value transitions only (mirrors specs/011 AC-5.4).

### US-6: Employee views their own stored address, read-only

As an employee, I want to see the address wellD has on file for me, so that I can verify
what personal data is being held about me without having to ask an admin — the same
transparency GDPR already gives me as the data subject over my own personal data.

**Acceptance criteria:**
- AC-6.1: Given a signed-in employee, when they open the suite's existing view of their
  own profile, then they see their own currently-stored address in its formatted,
  human-readable form, or a clear "no address on file" indicator if none has been set —
  mirroring AC-1.1's display, scoped to themselves.
- AC-6.2: Given a signed-in employee viewing their own address, then no input field,
  autocomplete/suggestion interaction, or save action is offered anywhere on that view —
  it is read-only in its entirety. The suggestion-assisted typing experience (US-2/US-3)
  exists solely on the admin edit surface (US-1); the employee's own view never offers an
  address input, a suggestion list, or any way to submit a change.
- AC-6.3: Given a signed-in employee, when they attempt to change their own address —
  whether through any UI affordance or by calling the underlying update API directly —
  then the action is denied by the server; read-only is enforced server-side, not merely
  by omitting an edit control from the UI.
- AC-6.4: Given a signed-in employee, when they attempt to view another employee's
  address (not their own) — through any UI surface or the underlying API directly — then
  access is denied; the self-view capability extends only to an employee's own record,
  never to a colleague's.

## Non-goals

- **More than one address per employee.** Exactly one current address, as defined in
  Domain language — no separate home/billing/shipping addresses, and no admin-browsable
  history of prior addresses beyond whatever the audit trail (US-5) preserves.
- **Any employee-facing way to edit, or request a change to, their own address.** The
  employee's own view (US-6) is strictly read-only — no edit control, no change-request/
  approval workflow, no in-app way to propose a correction. Every change to an employee's
  address is made by an admin (US-1); an employee who spots an error on their own
  read-only view must ask an admin to correct it, exactly as for any other admin-managed
  profile attribute today.
- **Using the stored address or its coordinates to compute or drive anything else in the
  suite** — e.g. a mileage-from-home distance calculation, tax jurisdiction, or entity
  assignment. This feature only captures, stores, displays, and lets an admin edit the
  address (and, when resolved via a selected suggestion, its coordinates — US-2);
  consuming either for any other purpose is a separate, future feature.
- **Verifying the address is a real, deliverable postal address** (e.g. carrier/postal-
  service validation). A selected or typed address is a UX convenience and a stored
  record, never a guaranteed-deliverable certification.
- **Displaying the address (or its coordinates) on a map or any other geographic
  visualization.**
- **Bulk-editing multiple employees' addresses in a single action.**
- **Importing or syncing addresses from any external HR/payroll system.**
- **Country-specific address-format validation** (e.g. per-country postal-code pattern
  checks) beyond the four-field completeness rule in US-1 (AC-1.4: country, city,
  street, house/building number) — no such rules are specified here. This is
  independent of the suggestion list's CH/IT-first ranking (US-2, AC-2.4), which is a
  ranking preference only and never a validation restriction — a non-CH/IT address is
  neither rejected nor held to any different completeness standard, and no country is
  ever required to additionally supply a postal code or region/state/canton beyond the
  four required fields.
- **Any change to how or where an employee's other profile attributes** (entity,
  department, job title) are managed — this feature only adds address alongside them.

## Constraints

*Facts/decisions supplied by the calling brief, the approval-gate discussion, and the
suite's existing established posture; captured verbatim for the plan, not elaborated
here.*

- **Address autocomplete is provided via Google Maps**, per the calling brief — captured
  verbatim; the plan is not free to substitute a different autocomplete/geocoding vendor
  without revisiting this constraint.
- **Address suggestions are biased toward Switzerland and Italy** (wellD's two operating
  countries), per the approval-gate decision — captured verbatim as a ranking preference
  only; an address in any other country must remain fully enterable and savable (AC-2.4).
- **wellD operates under an EU data-residency posture** (CLAUDE.md "Data residency"). An
  employee's home address (and any captured coordinates) is personal data under
  GDPR/nLPD and must be persisted in an EU-region datastore, wherever in the suite's
  services it ultimately lives.
- **The employee address lives in the existing `auth` service's User profile** — new
  fields alongside the entity/department/job-title attributes `auth` already records
  (specs/004, specs/006) — per the approval-gate decision, captured verbatim. It is NOT
  `refund-api`-owned data. This is a deliberate DEPARTURE from ADR-0023's precedent
  (which kept refund-specific mileage-rate data OUT of `auth`): a home address is judged
  to be an identity/profile attribute of the person, not refund-domain data, unlike a
  mileage rate — the architect should treat this departure as a likely new ADR. A direct
  consequence: admin read/write of the address is gated by the EXISTING admin
  user-management capability that already governs editing users/roles/departments
  (specs/004/006) — no new catalog permission is introduced by this feature (AC-4.1).
  `auth`'s PostgreSQL database must satisfy the EU-residency constraint already recorded
  above — no new datastore or region is introduced.
- **The admin surface for viewing/editing an employee's address is the existing Admin
  tool's Users section** (specs/004, specs/006) — this feature extends that existing
  surface; it is not a new tool or a new top-level admin screen.
- **The employee's own read-only view (US-6) is decided to exist**, per the approval-gate
  decision — exactly where in the suite it's surfaced (e.g. an account/profile area) is
  left to the plan; what is not open is that it exists, is read-only, and is scoped to
  self only (US-6).
- **Address changes reuse the existing audit mechanism already present in the `auth`
  service** (`audit_log`, written via the same facility that already records
  authorization/admin changes) — per the approval-gate decision, captured verbatim. This
  feature does NOT introduce a new, dedicated self-auditing table in the shape of
  ADR-0024 (mileage rate) or ADR-0027 (refund settings), and `audit_log` itself is left
  unchanged by this feature.
  **Drift resolution (2026-08-04):** the architect verified `audit_log` across all three
  existing `auth` migrations and found NO database-level immutability — no trigger, no
  rule, no revoked grants — and five test/fixture files call `db.auditLog.deleteMany(...)`
  today as ordinary test teardown. This meant AC-5.2 as originally written (a
  database-level guarantee) could not be satisfied by the mechanism this spec constrains
  the plan to reuse — precisely the drift condition this bullet originally flagged.
  Offered a choice between (a) adding a database-level trigger/rule to `audit_log`, (b)
  introducing a new sibling audit table, or (c) downgrading the requirement, the user
  chose **(c): AC-5.2 is downgraded to an application-level immutability guarantee only**
  (see AC-5.2's current text). `audit_log` is NOT modified by this feature, no trigger is
  added, and no new table is introduced — the existing facility is reused exactly as-is.
- **Resulting asymmetry (risk, accepted 2026-08-04):** the suite's financial/governance
  records — `refund_audit_entry`, `mileage_rate`, `refund_setting` (ADR-0018, ADR-0024,
  ADR-0027) — are immutable at the DATABASE level; this feature's personal-data
  address-change audit trail (`audit_log`) is not, per the drift resolution above. This
  is a deliberately accepted, narrower guarantee for a personal-data audit record than
  for the suite's financial/governance ones, not an oversight. Hardening `audit_log` to
  database-level immutability (a trigger/rule, mirroring ADR-0024/ADR-0027) remains
  available as a later, separate change and is not precluded by this decision.
- **An address's minimum required structured components are exactly four**: country,
  city, street, and house/building number (Domain language, AC-1.4) — per the
  approval-gate decision, captured verbatim. Postal code and any region/state/canton
  component are OPTIONAL, captured only when a selected suggestion supplies them (US-2),
  and are never a reason a save is rejected.
- **This is a wellD-internal tool.** Any user-facing copy this feature adds (e.g. "no
  address on file", validation messages) follows the suite's existing i18n convention —
  Italian and English at minimum (CLAUDE.md "no hardcoded UI strings").

## Open questions

None — all resolved at the approval gate on 2026-08-03 (see Constraints for the
decisions). The one drift that subsequently emerged during planning (AC-5.2's
database-level immutability guarantee vs. `audit_log`'s actual capabilities) was
resolved by the user on 2026-08-04 — see the Constraints "Drift resolution" bullet.
