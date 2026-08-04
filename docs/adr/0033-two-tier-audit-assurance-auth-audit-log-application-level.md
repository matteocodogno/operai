# 0033 — The suite deliberately runs TWO tiers of audit assurance: database-level for financial/governance records, application-level only for `auth`'s `audit_log`

**Date:** 2026-08-04
**Status:** Accepted
**Deciders:** wellD (decided by the user at `specs/012-employee-address`'s plan gate, 2026-08-04)
**Project:** Operai

---

## Context

`specs/012-employee-address`'s US-5 (AC-5.2) originally required, as written, that every
address-change audit record be immutable — worded to match this suite's existing
strongest guarantee. `auth` already has an audit mechanism (`audit_log`, ADR-0007's
`withAudit`/`listAuditLog`), reused verbatim by this feature per the spec's Constraints
("does NOT introduce a new, dedicated self-auditing table"). The architect verified, by
grepping `auth`'s three existing migration files, that `audit_log` carries **no
database-level immutability** — no trigger, no rule, no revoked grants — and that its
immutability is by convention only: `audit.ts`'s module comment states "there is
deliberately no update/delete path … anywhere in this module," and `audit.routes.ts`
registers no mutating verb. Its Prisma-managed DB role nonetheless retains full
`UPDATE`/`DELETE` rights, and six existing call sites exercise them today, all as
ordinary test/fixture teardown (`authz/audit.test.ts`; `auth/auth.config.test.ts`, twice;
`invitations/invitations.routes.test.ts`; `admin/users.routes.test.ts`;
`scripts/e2e-invite-fixtures.ts`, which also hard-deletes users). This is a strictly
weaker tier than the suite's established financial/governance pattern — a database-level,
raising `BEFORE UPDATE/DELETE` trigger, first built for `RefundAuditEntry` (ADR-0018),
reused verbatim for `MileageRate` (ADR-0024) and `RefundSetting` (ADR-0027). `audit_log`
predates all three and never received it — and until this feature, it never held
anything more sensitive than authorization/admin-configuration changes. `specs/012`
extends its contents to **employee personal data** (a home address), which is what forces
the question this ADR resolves: does `audit_log` get raised to the same tier, or does the
suite formally accept — for this table specifically — a lower one?

## Decision

We will formally adopt, and document, a **two-tier audit-assurance model** for the
suite, rather than silently letting `audit_log` diverge from an unstated assumption of
uniformity:

- **Tier 1 — database-level immutability**, via a raising `BEFORE UPDATE/DELETE`
  trigger, for financial and governance records: `RefundAuditEntry` (ADR-0018),
  `MileageRate` (ADR-0024), `RefundSetting` (ADR-0027).
- **Tier 2 — application-level immutability only**, for `auth`'s `audit_log`: no
  mutating export from the audit module, no mutating route on the audit API, no
  production code path anywhere in `auth` updates or deletes an audit row —
  enforced by a new regression tripwire, `auth/src/authz/audit-immutability.contract.test.ts`.

`specs/012`'s AC-5.2 is amended to require Tier 2 explicitly, rather than the codebase
being changed to meet the AC as originally worded — a deliberate, load-bearing choice
(see Decision point 2).

1. **Tier 2's precise shape.** The application-level guarantee has three independently
   checkable parts. **(a) Module surface:** `audit.ts` exports exactly
   `["listAuditLog","withAudit"]` — no update/delete function exists to call.
   **(b) Production source:** a static scan of `auth/src/**/*.ts` (excluding
   `**/*.test.ts`, `src/test-setup.ts`, and the generated Prisma client) finds zero
   matches for a mutating `auditLog.*` call or a raw `UPDATE`/`DELETE`/`TRUNCATE` against
   `audit_log` — a **tripwire, not a proof**: a static regex cannot rule out an indirect
   mutation (e.g. a dynamic `db[model].delete(...)`), but it catches the failure mode
   actually worth defending against, someone adding a mutating call to a route or service
   module. **(c) API surface:** every mutating verb (`POST`/`PUT`/`PATCH`/`DELETE`) on
   `/admin/audit` and `/admin/audit/{id}` returns `404`, proven method-specific (not a
   broken path) by `GET` returning `200` in the same test. **Test and fixture teardown
   are expressly exempt** — the six existing `deleteMany` callers reset state between
   test runs and are not violations of this guarantee.
2. **The AC was amended to match the code, not the code changed to meet the AC — decided
   by the user, at the plan gate, 2026-08-04.** Presented with three options — (a) add
   ADR-0018's trigger to `audit_log`, raising it to Tier 1; (b) introduce a new sibling
   `employee_address_audit` table with its own trigger; (c) downgrade the AC to require
   application-level immutability only — the user chose (c). `audit_log` is reused
   **entirely unchanged**: no trigger, no FK change, no migration touching it, no rework
   of `listAuditLog()`'s `include: { actor }`, no rework of the six teardown paths. The
   specs/004/006 audit trail this table already carries is **not** retroactively
   hardened by this decision.
3. **The escalation path — the ADR-0018 trigger's non-obvious prerequisite, recorded in
   full so it is inherited, not rediscovered.** Raising `audit_log` to Tier 1 means
   adding ADR-0018's trigger verbatim, but `AuditLog.actorUserId` carries
   `ON DELETE SET NULL` to `User` — and **an FK-initiated `SET NULL` is itself an
   `UPDATE`**, which a `BEFORE UPDATE` trigger would abort. Left in place, this silently
   converts `SetNull` into `Restrict`: any user who has ever performed an audited action
   (which, after `auth` grows its own admin-management history, is most admins) would
   become physically undeletable — a correctness trap invisible until someone tries to
   hard-delete such a user and the transaction inexplicably fails. The fix is to drop the
   FK and keep `actorUserId` as a plain, unconstrained column — a precedent that already
   exists one model away (`User.deletedByUserId`: "deliberately NOT a FK relation, so a
   deleted actor never blocks referential integrity here") and in `RefundAuditEntry`
   itself (`actorUserId`/`actorEmail` as plain columns, never a live FK). Removing the FK
   means `listAuditLog()`'s `include: { actor }` would need to become a batched
   `user.findMany` lookup instead (response shape unchanged, so `AuditPage` would be
   unaffected) — and the six existing teardown paths listed in Context would each need
   rework to keep working under a live trigger. **Triggers for revisiting this decision:**
   a regulatory/DPA requirement for tamper-evident personal-data change history, or
   `audit_log` gaining financial-decision records of its own.
4. **This is a documented decision, not a scope note buried in one feature's risk
   register.** ADR-0018 states, in its own text, that its shape is "the reusable pattern
   for future financial/governance records in the suite." A future engineer who reads
   only ADR-0018 (which is exactly what `docs/adr/` and its CLAUDE.md mirror are for —
   the only artifacts read by someone not already inside `specs/012/`) will reasonably
   infer suite-wide uniformity and will then either wrongly harden `audit_log`
   (rediscovering the FK trap and six broken teardown paths from scratch) or, worse,
   wrongly rely on a database-level guarantee for `audit_log` that does not exist. This
   ADR is the artifact that prevents both outcomes.

## Options considered

### Option A — Formally document the two-tier posture as a standing architectural decision (chosen)

Described above: adopt Tier 2 for `audit_log`, keep Tier 1 exactly where it already is,
record the boundary and the escalation path in this ADR.

**Pros:**
- The status quo — previously *unexamined* — becomes *examined, deliberate, and scoped*
  to a table that now holds personal data, not an oversight discovered later
- The escalation path is fully pre-analysed: a future engineer who does need to raise
  `audit_log` to Tier 1 inherits the FK trap, its fix, and the exact list of affected
  teardown paths, instead of rediscovering all of it from scratch under time pressure
- Costs nothing to `auth`'s existing code, tests, or migrations — the entire "cost" of
  this option is the documentation itself
- Matches this repository's own established convention for exactly this shape of
  decision: ADR-0026 records a deliberate exception to an earlier convention (404→403),
  ADR-0029 amends an earlier ADR's Decision text outright — this suite already treats
  "we are deliberately doing something different from the established pattern, and here
  is why" as ADR-worthy, not merely a risk-register line

**Cons:**
- `audit_log`'s weaker guarantee is now formally accepted for a table that carries
  personal data, not just authorization-configuration changes — a genuinely more
  sensitive category of record than any Tier 2 has ever protected before this feature
- A future reader who encounters this ADR for the first time must reconcile it against
  ADR-0018's own "reusable pattern" language, which this ADR does not edit — the
  resolution lives here, not at the point where a reader would naturally start (ADR-0018
  itself)

### Option B — Raise `audit_log` to Tier 1: add ADR-0018's trigger (the plan's "Option A") (rejected)

Add the identical `BEFORE UPDATE/DELETE … RAISE EXCEPTION` trigger ADR-0018 established,
applied to `audit_log`.

**Pros:**
- Uniform assurance tier across every audit mechanism in the suite — no two-tier model to
  explain, no boundary to maintain
- Reuses a proven mechanism rather than inventing a new one

**Cons:**
- Requires dropping `AuditLog.actorUserId`'s FK (the `SET NULL`-vs-trigger trap, Decision
  point 3) — a non-trivial, correctness-critical schema change with no room for error
- Requires reworking `listAuditLog()`'s `include: { actor }` into a batched lookup, and
  rewriting all six existing test/fixture teardown paths
- Retroactively hardens the entire specs/004 + specs/006 authorization-change trail — a
  scope far beyond what this single feature's AC actually requires
- Rejected by the user explicitly at the plan gate: correct in principle, but the wrong
  scope and the wrong moment for this feature to force

### Option C — A new sibling `employee_address_audit` table with its own trigger (the plan's "Option B") (rejected)

Give address changes a dedicated, ADR-0024/ADR-0027-shaped self-auditing table instead of
reusing `audit_log`.

**Pros:**
- Would deliver Tier 1 assurance for address changes specifically, without touching
  `audit_log`'s existing FK/teardown surface at all

**Cons:**
- Directly contradicts the spec's own Constraint: "does NOT introduce a new, dedicated
  self-auditing table in the shape of ADR-0024 or ADR-0027" — the spec pre-forecloses
  this option
- Would fragment `auth`'s audit story into two mechanisms (one for authorization/admin
  changes, one for address changes) with no shared read path, for a feature the spec
  explicitly wants to reuse the existing mechanism
- Rejected: forbidden by the spec's own Constraints, not merely architecturally
  disfavoured

### Option D — Leave the asymmetry as an unexamined plan-level risk note, write no ADR (rejected)

Record R1/R5 in `specs/012/plan.md`'s Risks table and stop there, without a standalone
architecture decision record.

**Pros:**
- Less to write; the analysis already exists inside the plan

**Cons:**
- `docs/adr/` and its CLAUDE.md mirror are the only artifacts a future engineer — or a
  future AI agent working in a different part of the codebase — is likely to read;
  `specs/012/plan.md` is discoverable only by someone already inside that feature's
  folder
- ADR-0018 declares itself the suite's reusable pattern in its own text; without a
  standalone ADR correcting the record, a future reader has no way to learn that
  `audit_log` is the deliberate exception, not an oversight waiting to be "fixed"
- Rejected: this is not "a decision to change nothing" that a risk note could adequately
  capture — it is a decision that makes a previously-unexamined status quo examined,
  deliberate, and permanently discoverable, which is precisely what an ADR is for

## Consequences

**Positive:**
- The suite's audit posture is now internally consistent and honestly documented: Tier 1
  is scoped precisely to financial/governance records (`RefundAuditEntry`,
  `MileageRate`, `RefundSetting`), Tier 2 is scoped precisely to `auth`'s
  authorization-and-now-personal-data trail (`audit_log`) — no future reader has to
  guess which tier a given table belongs to
- The escalation path is fully pre-analysed and immediately actionable the moment a
  regulatory or product trigger actually requires raising `audit_log` to Tier 1 — no
  rediscovery cost
- Zero implementation cost to land: this feature's only change to the audit area is the
  additive `GET /admin/audit` filter (AC-5.3); everything else about `audit_log` is
  reused byte-for-byte

**Negative / trade-offs:**
- `audit_log` now protects personal data (a home address) with a strictly weaker
  guarantee than the suite's financial/governance tables — a real, accepted asymmetry,
  not a technical limitation that will be fixed later by default
- No tamper-evidence exists for `audit_log`: a code change, a Prisma console session, or
  direct database access can silently alter or erase an employee's address-change
  history, indistinguishable after the fact from a record that was never altered
- **The GDPR-erasure tension is genuinely inverted, not merely accepted.** With no
  database-level guard, a subject-erasure request *can* be honoured by redacting or
  removing the `data.before`/`data.after` payloads of the affected `audit_log` rows — a
  real operational **benefit** over Tier 1, where ADR-0018 makes those values
  permanently unremovable by design. The residual problem is procedural, not technical:
  no redaction runbook exists yet, so an ad hoc redaction — authorised or not — is
  equally invisible to this table's own history, which is the flip side of the same
  missing guard.

**Risks:**
- **Tamper / no forensic proof of trail integrity.** Tracked as **R1** in
  `specs/012/plan.md`: accepted by decision, not omission. Mitigation:
  `audit-immutability.contract.test.ts` is the regression tripwire that catches any
  future production code path that starts mutating `audit_log`; the two-tier posture
  recorded here prevents a future engineer from assuming a database guarantee that does
  not exist.
- **No documented redaction procedure for GDPR erasure requests.** Tracked as **R5**:
  the missing guard makes both an *authorised* redaction (no record of who redacted what,
  when, why) and an *unauthorised* one equally invisible. Mitigation: a short
  audit-redaction runbook in `infra/README.md` — who may perform it, that it targets a
  specific enumerated `audit_log.id` set, and that the act itself is recorded
  out-of-band (ticket / DPA log), since the trail cannot record its own redaction.
  Flagged to the owasp reviewer explicitly as a process gap with a technical enabler, not
  a code defect.
- **A future engineer applies Option B's escalation partially.** E.g. adding the trigger
  without first dropping the `actorUserId` FK — silently converting `SetNull` into
  `Restrict` and making any user with audit history undeletable, with no application-level
  symptom until a hard-delete is attempted. Mitigation: this ADR's Decision point 3 is
  written to be followed as a complete checklist, not a summary — trigger, FK removal,
  `listAuditLog()` rework, and all six teardown paths together, in one change.

## Compliance notes

- GDPR / data-protection impact: **medium** — `audit_log` now carries a home address's
  before/after values, a category of personal data materially more sensitive than the
  authorization-configuration changes it previously recorded, protected by an
  application-level guarantee only. The absence of database-level tamper-evidence is a
  genuine, named compliance-review trigger (escalated to the frontier-tier owasp review
  for specs/012) — but the same absence is also what makes a subject-erasure request
  technically honourable at all, which Tier 1's design would not permit.
- Data residency: unaffected — `audit_log` lives in `auth`'s existing EU-region
  PostgreSQL database, unchanged by this decision.
- Audit trail: **this ADR is the audit-assurance-tier decision.** It does not create,
  modify, or migrate `audit_log` in any way; it formally records, for the first time,
  which tier the suite's *existing* mechanism belongs to, and why that is correct rather
  than an oversight.

This decision **clarifies the scope of, without amending,** ADR-0018 (and its verbatim
reuses, ADR-0024 and ADR-0027): those ADRs' own "reusable pattern for future
financial/governance records" language is, from this ADR forward, understood to be
precisely scoped to financial/governance records — never silently assumed to extend to
`auth`'s `audit_log`, which this ADR establishes as Tier 2 by deliberate, dated decision.
Unlike ADR-0029's amendment of ADR-0021, this ADR does **not** edit ADR-0018/0024/0027's
own text or add a forward-pointer note to them — the boundary is recorded here, the same
place a future reader would need to look to learn why `audit_log` diverges, discoverable
via this ADR's own entry in `docs/adr/` and its CLAUDE.md mirror. It follows this
repository's established convention — set by ADR-0026 (a documented exception to an
earlier convention) and ADR-0029 (an outright amendment) — of naming a decision's
relationship to prior ADRs explicitly rather than leaving it implicit.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
