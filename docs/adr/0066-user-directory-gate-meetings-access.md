# 0066 — The user directory's third consumer: `meetings:access` opens `GET /authz/users/directory` for the participant picker, which makes the directory visible to every employee

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; the user explicitly accepted this widening at the plan gate on 2026-11-04, D-10 / R12). Data-protection lead sign-off is still open.
**Deciders:** wellD (accepted by the user at the plan approval gate)
**Project:** Operai
**Relates to:** [ADR-0047](0047-user-directory-endpoint-capability-gated.md), [ADR-0053](0053-user-directory-gate-widened-to-deal-manage.md), [ADR-0055](0055-app-access-check-by-user-id-and-directory-app-filter.md), [ADR-0039](0039-live-identity-resolution-by-id-fail-soft.md), [ADR-0068](0068-default-employee-grant-meetings-access.md), [ADR-0035](0035-third-party-app-access-decision-endpoint-forwarded-jwt.md)

---

## Context

Choosing the participants of a meeting (up to 30 Operai users, AC-5.1) means picking colleagues
by name. ADR-0047 made `auth GET /authz/users/directory` (active `{id, name, email, entity}`,
both entities, name-sorted, no pagination, rate-limited, on the forwarded caller JWT) acceptable
only behind an allowlist, `DIRECTORY_GATE_PERMISSIONS`, of permissions whose holders have a
business need to pick a person, and named a second consuming app or a user count that makes an
unpaginated list unreasonable as its escalation trigger. ADR-0053 added `deal:manage`
(deliberately not `crm:access`), and ADR-0055 added an optional `?appId=` narrowing.

Meetings is the third consumer. The need is real for everyone who creates a meeting, and
creating a meeting is `meetings:access`, which, by the owner decision behind ADR-0068, **every
employee holds by default**. Gating on a narrower permission would let a creator add only
themselves.

## Decision

1. **We add the `meetings` catalog's `meetings:access` to `DIRECTORY_GATE_PERMISSIONS`.**
   Endpoint shape, population, rate limit, no query parameters and `Cache-Control: no-store`
   are unchanged; `meetings-ui` calls it directly through `shell/session`'s `apiFetch`;
   `meetings-api` keeps no copy.
2. **Consequence stated plainly: with ADR-0068, the directory (name, email, entity of every
   active user) becomes visible to every employee.** This is the user's explicit decision at
   the plan gate, recorded here as accepted, not an accident of the seed. It is flagged for
   the data-protection lead (plan R12).
3. **Participants are re-validated server-side.** `PUT /meetings/:id/participants` checks every
   `userId` as active through `auth POST /authz/users/identities` (fail closed, 503
   `identity_unavailable`; 422 `participant_not_active { index }`), so the picker's list is a
   convenience and not the authority.
4. Each further consumer is still added deliberately, by ADR. The `?appId=` filter of ADR-0055
   can narrow the list to holders of `(appId, "access")` where a consumer needs that.

## Failure shape

**A gate that is defined by a permission whose population is set somewhere else, so changing
who holds the permission silently changes who can enumerate people.** The directory's audience
is "holders of any gate permission". Add a permission with a default grant to everyone, or
widen a role, and the directory's audience becomes everyone, with no change to the endpoint
and no review of the endpoint. The mistake is treating "the gate list" and "the population of
each gate permission" as independent.

Mirror positions. **Widening by gate vs widening by grant:** adding a permission to the gate
(this ADR) and adding a holder to a permission already in the gate (ADR-0068 in reverse, or any
new default grant) are the same event for the roster's audience; both need an ADR and a
reviewer who knows the other half. **Read vs write:** the picker reads a fact endpoint, so
the write that stores a chosen person must re-check them (point 3) rather than trust the list.
**Fact vs decision endpoint:** a roster is a fact endpoint, a lookup that answers eligible/not
is a decision endpoint (ADR-0035); using the roster where a decision would do is the widening.
Recognise it whenever a new tool wants "pick a person": ask who will be able to call the
roster once the feature's own default grants are applied, not who needs it.

## Alternatives considered

- **A name-only typeahead endpoint.** Rejected: a new fact endpoint with search, which
  ADR-0047 rejected; it would still disclose who works at wellD to every holder.
- **Emailing participants by address.** Rejected: people pick colleagues by name (the reason
  ADR-0047 rejected the exact-email decision endpoint of ADR-0035), and notices go in-app only
  (AC-12.4).
- **A Meetings-local roster cached in meetings-api.** Rejected: a second copy of personal data
  that goes stale (ADR-0039).

## Consequences

**Positive:**
- Participant picking works by live name for every creator; the picker has no second copy of
  the roster to keep or erase.

**Negative / trade-offs:**
- Every employee can list every active user with their email and entity. That is the same data
  the inventory manager (ADR-0047) and sales (ADR-0053) already see, now for the whole company.
- ADR-0047's "narrow exception" framing no longer describes the endpoint; its escalation
  trigger (a second consumer or a user count that makes an unpaginated list unreasonable) is
  met twice over. The no-pagination decision is not revisited here.
- Tests in `auth/src/auth/directory.routes.test.ts` must pin both that `meetings:access`
  opens the gate and that the gate list contains exactly the intended permissions.

**Risks:**
- The roster is an enumeration surface for any employee account that is compromised. Mitigation
  is unchanged: the existing rate limit and `no-store`. Sign-off by the data-protection lead
  is outstanding (R12).
- Any later change to who holds `meetings:access` changes the directory's audience (see Failure
  shape).

## Compliance notes

- GDPR / nFADP: employee name, work email and entity become visible to all employees through
  one endpoint; internal-purpose disclosure, accepted by the user at the plan gate; data-
  protection lead sign-off pending.
- Audit trail: not required for reads.

## Amended 2026-11-04 (design stage)

Meetings calls `GET /authz/users/directory` **without** ADR-0055's `appId` filter (G9). The
participant picker offers every active user, because a participant need not hold
`meetings:access` and must still be able to read the meeting (AC-10.4, AC-5.1). The `?appId=`
narrowing remains available to other consumers; this consumer deliberately does not use it,
and the audience of the endpoint is unchanged by this note. Source: plan.md § Amendments
2026-11-04 (design stage), G9.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
