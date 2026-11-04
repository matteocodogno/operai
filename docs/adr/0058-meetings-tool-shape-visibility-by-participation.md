# 0058 — Meetings is a seventh tool (`meetings-api` + `meetings-ui`) whose content is visible by participation, never by role, and whose self-scoped reads survive an `auth` outage

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04, D-1)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0006](0006-suite-frontend-module-federation.md), [ADR-0014](0014-refund-api-authorization-enforcing-resource-server.md), [ADR-0034](0034-shell-identity-scoped-non-tool-screens-account-route.md), [ADR-0045](0045-ungated-second-federated-entry-of-a-gated-remote.md), [ADR-0052](0052-crm-tool-shape-and-authorization.md), [ADR-0037](0037-denial-taxonomy-shared-records-403-vs-404.md)

---

## Context

Meetings (specs/021) records a meeting in the browser, takes an uploaded recording or pasted
text, transcribes it, summarises it from templates and answers questions about it. The content
is people's voices and conversations: a 1:1, a price discussion, a client in energy, finance or
healthcare. The owner decided that access to it is by participation (the creator and the
Operai participants), that a participant who does not hold the tool's grant must still be able
to read what was captured about them (AC-10.1, AC-10.4), that an administrator reading another
person's meeting is not a role privilege (AC-4.8), and that reading your own meetings must
keep working while `auth` is down (AC-10.6).

The suite's settled shape for a tool that owns data is a JWKS resource server plus a federated
remote (ADR-0006, ADR-0014, ADR-0052), with `auth` resolving permissions live on every
request and failing closed. That shape has no answer for the participant who holds no grant,
and its fail-closed rule would make a participant's own transcript unreadable during an `auth`
outage.

## Decision

1. **A new `meetings-api`** (Bun + Hono + Prisma 7, own DB `meetings`, port 8085, own EU
   bucket `MEETINGS_S3_*`) and **a new `meetings-ui`** (federated remote, port 5180). It is an
   authorization-enforcing resource server (ADR-0014), with three guard stacks attached per
   route, never `router.use("*")`:
   - `selfScoped`: a valid JWT only, plus an *optional* authz resolve that never refuses and
     marks the view `capabilities: "unavailable"` when `auth` cannot be reached. Used by every
     read of a meeting the caller may open, the caller's own conversation, and deleting a
     summary.
   - `capability(…)`: live `/authz/resolve`, fail closed (503), plus the named permission.
     Used by everything that creates, generates, asks or edits.
   - `eraser`: live resolve plus `meeting:erase`, on the erase search routes only, which
     return no content.
2. **Visibility is a record-level check in every route**, after the stack: the caller is the
   creator, or an Operai participant, or (only if the creator opted the meeting in) a
   host-visible reader. Anything else is a 404 byte-identical to a nonexistent id (AC-5.3).
   **No role ever grants reading content**: not `admin`, not `meeting:erase`.
3. **Only the host-visible class needs `auth` and the host**, and both fail closed. An `auth`
   outage therefore leaves creators and participants reading and removes only host-granted
   visibility.
4. **`meetings-ui` exposes four entries**: `./App` (gated, `/meetings/$`), `./MyMeetings`
   (UNGATED, the shell-owned `/my-meetings/$`, reached from a "My meetings" UserMenu link;
   ADR-0045 shape), `./HostMeetings` (the panel a host embeds, ADR-0060) and `./version`
   (ADR-0030). The meeting page is one component used by both router entries; its controls
   follow the server's `can` flags. Every deep link (notifications, the CRM activity, host
   panel rows) points at `/my-meetings/m/<id>`, because that route works for every visibility
   class.
5. **A creator who no longer holds `meetings:access`** keeps read access and may delete their
   meeting or its recording, nothing else (plan amendment A4). Deleting your own data must not
   depend on a grant.

## Failure shape

**A broad grant becoming a read key to personal content, and an availability dependency
becoming a lock on your own data.** Two mistakes with one cause: access decided by *what role
you hold* and *whether a remote authority answered*, instead of *your relationship to the
record*. The first lets a holder of a wide role (admin, eraser, "can open the host entity")
read what was said by and about other people; the second refuses a person their own record, or
a participant the record about them, because an authorization service is down or because they
hold no tool grant.

It recurs wherever records are *about people who are not necessarily the tool's users*:
review feedback, HR notes, 1:1 minutes, a retrospective. Check it in the mirror positions too.
**Read vs write**: reads of what is yours survive an outage, writes fail closed; do not let
"reads survive" leak into any action that creates or changes. **Gate vs data**: a gated screen
is not a gated API, and an ungated API without a gated screen is a different decision. Both
halves of ADR-0045 are required. **Inbound vs outbound visibility**: a role that is blocked
from reading must also be blocked from the derived outputs (lists, counts, search results,
notices), not only from the record route. **Create vs delete**: erasure must work for the
person it protects even when they no longer hold the grant. Recognise it by the question "if
this role were granted to everyone, or `auth` were down, who could read what?"

## Alternatives considered

- **Meetings inside crm-api.** Rejected: Meetings must serve other hosts (PM, HR) later and is
  not CRM data; AC-11.10 forbids it reading host data, which an in-CRM module would hold by
  construction.
- **One ungated entry that gates the create screens inside the remote.** Rejected: it puts an
  auth guard in a remote, against ADR-0006, and loses the sidebar and last-tool behaviour of
  `TOOLS`.
- **A shell-native My meetings screen.** Rejected for the reason ADR-0045 gives: tool business
  logic in the shell, against ADR-0009.
- **Every route behind live authz and fail closed, as refund-api does.** Rejected: an `auth`
  outage would make a participant's own transcript unreadable (AC-10.6) and would need
  `meetings:access` to read, contradicting AC-10.4.
- **Role-based read for `admin` or an auditor.** Rejected by the owner (AC-4.8); `meeting:erase`
  deliberately sees only title, date and creator.

## Consequences

**Positive:**
- A participant without the grant reads what was captured about them; an outage removes only
  host-granted visibility.
- Content has no privileged reader; the erase screen is incapable of leaking it.
- Deep links are stable across visibility classes.

**Negative / trade-offs:**
- Two route families with different failure postures. A route attached to the wrong stack is
  either fail-open on a mutation or fail-closed on a read. The action matrix test (AC-5.8,
  crm-api `matrix.test.ts` pattern) over the assembled route table is the guard.
- Denials follow ADR-0037's split: a refused action is 403 (with a code such as
  `creator_only`, `frozen`, `meetings_access_required`) only where the caller can open the
  meeting, and 404 otherwise, so every record route must run the visibility check before it
  decides how to refuse.
- A seventh service and remote to provision, deploy and monitor.

**Risks:**
- `selfScoped` drifting into fail-open on a write. Mitigation: it is a stack applied per route,
  the route table is matrix-tested, and the OWASP review lists this split explicitly.
- A creator's identity lookup failing makes creator controls 503 (fail closed) while reads
  continue (AC-5.11).

## Compliance notes

- GDPR / nFADP: voice and conversation data of identifiable people; visibility by participation
  limits the audience to people who were present or were deliberately granted access.
- Audit trail: a content-free `MeetingDeletion` entry; no read audit.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
