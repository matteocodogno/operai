# 0068 — The first default grant on the `employee` role: every employee holds `meetings:access`

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; the user explicitly accepted this departure from specs/004's posture at the plan gate on 2026-11-04, D-10, owner decision behind AC-10.8)
**Deciders:** wellD (accepted by the user at the plan approval gate)
**Project:** Operai
**Relates to:** [ADR-0007](0007-authz-hand-rolled-rbac-abac-epoch-claims.md), [ADR-0066](0066-user-directory-gate-meetings-access.md), [ADR-0058](0058-meetings-tool-shape-visibility-by-participation.md), [ADR-0045](0045-ungated-second-federated-entry-of-a-gated-remote.md), [ADR-0052](0052-crm-tool-shape-and-authorization.md)

---

## Context

specs/004 (ADR-0007) established that access to a tool is an `(appId, "access")` grant that an
admin assigns, and that the `employee` role carries no default grants. Every shipped tool
follows it: refund, inventory, CRM and the others reach a person only after an admin step.

Meetings differs in who it must serve. The owner decided (AC-10.8) that every employee holds
`meetings:access` and that `template:manage` and `meeting:erase` are held by `admin` only.
The plan's reason: every employee must be able to record a meeting without an admin step. The
visibility model already restricts content to participants, so a wide grant does not widen who
reads (ADR-0058). A participant without the grant stays read-only (AC-10.4).

## Decision

1. **`seedMeetingsGrants` grants `meetings:access` to the `employee` role.** This is the
   suite's **first default grant on `employee`**, an explicit departure from specs/004's
   "employees get no default grants", recorded here so it is a decision and not a surprise in
   a seed file.
2. **`admin` additionally gets `template:manage` and `meeting:erase`** (and `meetings:access`
   via `ALL_APP_IDS`). Nothing else in the seed grants either; a contract test over `auth`'s
   seed pins it (AC-10.8: `employee` holds `meetings:access`; `template:manage` and
   `meeting:erase` only on `admin`; no other rule mentions them).
3. **The consequence for the directory is accepted with it**: `meetings:access` is in
   `DIRECTORY_GATE_PERMISSIONS` (ADR-0066), so every employee can list the roster. The user
   accepted both together at the plan gate.
4. **The precedent is narrow.** A default `employee` grant is for a capability whose use is
   bounded by the record-level rules of the tool itself (here, participation) and which every
   employee needs the moment they work. It is not a template for granting a tool that reads
   shared business data (CRM, refund review, inventory).
5. Rollout includes the `auth` re-seed (plan § Rollout, step 1) before meetings-api and
   meetings-ui are deployed.

## Failure shape

**A capability that a feature's correctness assumes everyone holds, implemented as an opt-in
grant that someone must remember to give.** The gap shows up as people who cannot do the thing
the feature promises (a participant who cannot record, a creator who "does not have access"),
and also, in the other direction, as a default grant added in one file that silently widens
another gate: the roster, a list, a search, a notification fan-out.

Mirror positions. **Grant vs consequence:** adding a default grant changes the audience of
everything gated by that permission, so enumerate every gate that lists the permission (the
directory, ADR-0066; the sidebar `TOOLS` entry; creator controls) before adding it.
**Revoke vs grant:** a creator who later loses the grant must keep read, delete-own and
participant rights (plan amendment A4, ADR-0058); defaults make "everyone has it" so common
that revoked-grant paths go untested. **Seed vs live state:** a default in a seed is
documentation of a decision; it must be pinned by a test and applied by the re-seed, not
assumed. Recognise it when a spec says "everyone can" or "all employees": ask whether that is
a default grant, a ungated route (ADR-0034/0045) or a self-scoped read, which are three
different mechanisms with different blast radii.

## Alternatives considered

- **Admin-assigned access, as for every other tool (the specs/004 posture).** Rejected, the
  owner overruled it: every employee must be able to record a meeting without an admin step,
  and an unassigned employee would be unable to start or even create a meeting while still
  being recorded in other people's.
- **An ungated tool.** Rejected: loses the sidebar and last-tool behaviour of `TOOLS` and puts
  gating logic in the remote (ADR-0006, ADR-0058).
- **Only the ungated My meetings page for everyone, `meetings:access` by admin assignment.**
  Rejected for the same reason as the first option: creating is the point.

## Consequences

**Positive:**
- Zero-admin onboarding: any employee can create, record, upload, summarise and ask.
- The tool appears in the sidebar for everyone, consistent with AC-10.5.

**Negative / trade-offs:**
- The `employee` role's no-default-grants invariant no longer holds, and any test or document
  that states it must be updated.
- The directory is visible to every employee (ADR-0066).
- AI cost and the rate limit apply to everyone (30 AI requests per user per hour, R8).

**Risks:**
- A precedent for further default grants. Mitigation: point 4; each future default grant needs
  its own ADR naming the gates it touches.
- A re-seed that is skipped in a deploy leaves the tool invisible to employees; the rollout
  order puts it first.

## Compliance notes

- GDPR / nFADP: the grant widens who can *record* people, not who can *read* them; reading
  remains participation-based (ADR-0058). Consent is by attestation of the creator (AC-4.1).
- Audit trail: not required for the seed itself; the capture is recorded per meeting
  (consent user, time and notice version, AC-4.3).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
