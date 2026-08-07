# 0037 — Denial taxonomy for shared records: 403 when a relationship exists but the level is insufficient, 404 only when no relationship exists at all

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

ADR-0005 established, and the suite has followed uniformly since, that a not-owned record
returns `404 Not Found`, never `403 Forbidden`: "not yours" and "does not exist" must be
structurally indistinguishable, because a `403` on a single-owner resource leaks the
resource's existence to a stranger (an IDOR information disclosure). Until spec 013, that
rule was exhaustive for `estimai-api` — every estimate had exactly one relationship a caller
could have to it: owner, or nothing.

ADR-0036 introduces a third possible relationship: **collaborator**, at one of two levels
(`viewer`/`editor`). This breaks ADR-0005's binary assumption. A viewer attempting `PUT`, or
any collaborator attempting `DELETE` or collaborator management (AC-3.1/AC-3.3/AC-1.5),
already *knows* the estimate exists — they can open it, see its content, and use its
link-share/export features. Returning `404` to that caller would leak nothing (they already
have the information a 404 would be protecting), but it would be an active **lie**, and it
would make the UI unable to distinguish "this estimate is gone" from "you're not allowed to
do that" — two states requiring materially different user-facing recovery (reload the list,
vs. ask the owner to upgrade your access).

Prior art for narrowing the blanket 404 rule already exists in the suite: ADR-0026 introduced
a deliberate, documented 403 exception to ADR-0005/ADR-0014's "not yours = 404" convention
for `refund-api`'s self-approval denial, on the same reasoning — the caller demonstrably has
a relationship to the record (there, ownership; here, a collaborator grant), so 404 would be
dishonest rather than protective.

## Decision

We will narrow ADR-0005's blanket rule to a two-branch taxonomy, applied uniformly across
every `estimai-api` route touched by sharing:

1. **No relationship at all → 404.** Exactly AC-1.6, and exactly ADR-0005 unchanged: a
   stranger with no owner or collaborator relationship to the estimate learns nothing about
   its existence, whether probing `GET`, `PUT`, `DELETE`, or any `…/collaborators` route.
2. **A relationship exists but the level is insufficient for the action → 403**, with a
   stable `code` (`"insufficient_access"` for a viewer attempting a write; `"owner_only"` for
   any collaborator attempting deletion or collaborator management). The caller already knows
   the estimate exists — they can open it — so the 403 leaks nothing new, and it correctly
   distinguishes "gone" from "not allowed."
3. **This mirrors ADR-0014's existing split** (capability absent → 403 at the route level;
   record-level not-yours → 404) and applies the same shape to record-level *grants* instead
   of role-level *capabilities*. It is the second deliberate, documented narrowing of
   ADR-0005's original convention in the suite, after ADR-0026's self-approval 403 — but
   unlike ADR-0026 (where the exception applies to a single specific condition on a single
   action), this one applies structurally, across every route, as soon as any relationship
   to the record exists.
4. **Access is always evaluated before any other conflict is reported**, so a stranger's
   probe never elicits anything but 404 — never a 409 (which would itself confirm the record
   exists at some version) and never a 403 for lacking a level they were never granted. In
   the `PUT` handler specifically, evaluation order is `401 → 400 → 428 → 413 → 404/403 →
   409`: the CAS version conflict (ADR-0038) is checked only *after* access is confirmed.
5. **The distinction never requires a separate check-then-act step.** Reads resolve access
   via `resolveAccess()`; writes embed the access predicate directly inside the same
   `updateMany`/`deleteMany` statement that performs the mutation (ADR-0038), so there is no
   TOCTOU window between "check" and "act" — a caller's access can never change between the
   two, because there is no gap for it to change in.

Concretely, per route: `GET`/`PUT` on an unrelated estimate → 404; `PUT` by a viewer → 403
`insufficient_access`; `DELETE`/collaborator-management by any collaborator → 403
`owner_only`; any `…/collaborators/*` route hit by an unrelated user → 404, identical in
every observable respect to a genuinely nonexistent estimate id (AC-5.2's removal case is
verified to produce a byte-identical 404 to AC-1.6's).

## Options considered

### Option A — 403 when a relationship exists but the level is insufficient; 404 only when none exists (chosen)

Described above.

**Pros:**
- Preserves ADR-0005's core guarantee exactly where it still applies (a true stranger) while
  giving a real, honest signal to a caller who already has *some* relationship to the record
- Directly reusable by every future app that adds record-level sharing (ADR-0036) — the
  taxonomy is defined generically ("relationship exists but insufficient" vs. "no
  relationship"), not tied to EstimAI's specific `viewer`/`editor` levels
- Matches user-facing reality: a collaborator's client can distinguish "reload, this
  estimate is gone" from "ask the owner for edit access" only if the server does
- Consistent with the suite's one existing precedent (ADR-0026) for narrowing the same rule,
  reducing the number of distinct denial conventions an engineer must hold in their head

**Cons:**
- ADR-0005's rule is no longer a single, universally-quotable sentence for `estimai-api` —
  a future contributor must know the narrowed version applies once a record has more than
  one possible relationship shape
- The evaluation-order discipline (access before conflict, always) is a manual invariant
  enforced by code review and tests, not by the type system — a future route added carelessly
  could reverse the order and reintroduce an existence leak via a 409

### Option B — Keep ADR-0005's blanket 404 for every denial, including insufficient-level (rejected)

Return 404 uniformly whenever a request is denied for any reason, exactly as before sharing
existed.

**Pros:**
- Zero new taxonomy to learn or test — the suite's single existing rule keeps applying
  unmodified everywhere
- No risk of accidentally leaking existence through a newly-introduced 403 branch

**Cons:**
- Actively dishonest for a collaborator who can already open the estimate: returning 404 to
  a viewer's blocked `PUT`, when they can `GET` the same id successfully moments later, is a
  lie a client cannot safely code against (it would have to guess whether "404" means "gone"
  or "you can't do that")
- Makes the UI structurally unable to distinguish "the estimate was deleted, go back to your
  list" from "you have view-only access, ask the owner" — two states this feature's UX
  requires distinguishing (AC-3.1's disabled-controls affordance depends on knowing *why*)
- Rejected: technically the simplest but functionally wrong once a caller can have a real,
  known relationship short of the required one

### Option C — 403 for every denial, including no relationship at all (rejected)

Drop ADR-0005's 404 convention entirely and return 403 for any caller lacking sufficient
access, whether or not they have any relationship to the record.

**Pros:**
- Semantically "correct" REST usage in the narrowest textbook sense — 403 always means
  "authenticated but not authorized," regardless of relationship

**Cons:**
- Directly reintroduces the IDOR existence leak ADR-0005 was written to close: a 403 on
  `GET /estimates/{id}` for a totally unrelated caller confirms an estimate with that id
  exists, just not for them
- Contradicts AC-1.6 explicitly, which requires a stranger's request be denied "not found,
  not merely forbidden," extending ADR-0005's pattern rather than replacing it
- Rejected: reopens a settled, deliberate security decision for no benefit

## Consequences

**Positive:**
- A stranger probing any `estimai-api` route learns nothing new about record existence —
  ADR-0005's core guarantee is fully preserved for the case it exists to protect
- A collaborator or owner blocked from a specific action gets an honest, actionable signal
  (403 with a stable `code`) instead of a misleading 404, letting the UI render the correct
  recovery affordance
- The pattern is documented generically enough that any future app adding record-level
  sharing (per ADR-0036) can reuse it directly, rather than re-deriving the same reasoning

**Negative / trade-offs:**
- The suite now carries two distinct, precedent-based narrowings of ADR-0005's original
  blanket rule (this one and ADR-0026's self-approval exception) — a future contributor must
  consult both, and neither is enforced by a shared abstraction
- Every route that could plausibly return either 403 or 404 must get its evaluation order
  right (access before any other check) by manual discipline; a reversed check silently
  reopens an existence leak through whichever check now runs first

**Risks:**
- **A future route reverses the evaluation order.** If a new `estimai-api` endpoint checks
  a non-access condition (e.g. a rate limit, a version conflict) before resolving access, a
  stranger's probe could elicit a response distinguishable from a genuine 404 (e.g. a 409
  confirming a version exists). Mitigation: the plan's test strategy includes an explicit
  CAS-predicate test asserting a viewer's *correctly*-versioned `PUT` still fails with 403,
  not a version-branch response, and the handler order is documented per-route in the API
  contract; any new route must be reviewed against this ordering rule.
- **`code` values drift in meaning over time.** `"insufficient_access"` and `"owner_only"`
  are currently the only two 403 codes in this taxonomy; a future feature adding a third
  access level or a third denial reason must extend the taxonomy deliberately rather than
  overload an existing code, or client-side error handling silently misclassifies denials.

## Compliance notes

- GDPR/nLPD impact: none beyond ADR-0005's original assessment — this decision only refines
  which HTTP status a denial uses, not what data is exposed; the 403 branch is specifically
  designed to expose *no more* than the caller already legitimately knows.
- Data residency: not applicable — no new data flow, only response-status logic inside
  `estimai-api`, already EU-region (CLAUDE.md).
- Audit trail: not required — denial responses are not persisted; this mirrors ADR-0026's
  choice not to add an audit row for a denied attempt (there, a structured log; here, no
  logging requirement is introduced by this decision at all, since a 403/404 is ordinary
  request handling, not a security-sensitive denial pattern warranting its own record).

This decision narrows ADR-0005 (JWT resource-server verification and its "not owned = 404"
IDOR-prevention rule, the baseline this ADR modifies) and is structurally modelled on
ADR-0014 (the capability-absent-403 / record-level-not-yours-404 split `refund-api` already
established, here extended from role-based capability denial to record-based grant denial).
It follows the precedent set by ADR-0026 (the suite's first deliberate, documented exception
to the same blanket rule), generalizing that one-condition exception into a structural rule
for any future record-sharing feature (ADR-0036). It depends on ADR-0038's CAS predicate to
guarantee the evaluation-order invariant (access before conflict) holds atomically on every
write, with no check-then-act gap.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
