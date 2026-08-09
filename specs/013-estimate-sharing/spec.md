---
id: 013
slug: estimate-sharing
status: done
rigor: production
created: 2026-08-07
approved: 2026-08-07
done: 2026-08-08
---

# Estimate sharing: invite registered EstimAI users to collaborate on an estimate

## Amendments

- This spec **supersedes, for this feature's scope, spec 001's accepted "last-write-wins,
  no conflict UX" Non-goal and its AC-4.1 framing**. Spec 001 fixed a single-writer world
  (one owner, at most editing from two of their own devices/tabs) and explicitly decided
  silent last-write-wins was acceptable there. This feature deliberately introduces
  multiple simultaneous writers to the same estimate document, which makes silent
  clobbering a real, foreseeable, and much more likely failure mode — see US-4. The
  supersession is scoped narrowly: spec 001's whole-document JSONB persistence model
  (ADR-0004) and single-PUT contract are unchanged; only the "no conflict detection"
  acceptance is revisited, and it now applies uniformly to every save (solo multi-tab
  included, AC-4.4), not only to true multi-collaborator saves — see US-4.
- This spec **narrows spec 001 AC-4.1** ("user B receives none of user A's data") to mean
  "any user who is neither the owner nor an explicitly granted collaborator." A
  collaborator seeing and, per their access level, editing another user's estimate is a
  deliberate, owner-granted exception introduced by this feature, not a violation of
  AC-4.1's privacy guarantee — see US-1/AC-1.6.

## Problem

An estimate in EstimAI today can only ever be seen and worked on by the single Operai
user who created it (spec 001: every query is scoped to the caller, and anyone else is
treated as if the estimate doesn't exist). In practice, estimates are built and refined
collaboratively inside wellD — a lead consultant drafts the activity breakdown, a
delivery manager tunes parameters, a second consultant sanity-checks numbers before a
client call — but today that only happens by someone re-typing or re-importing the whole
thing into their own copy, which immediately diverges from the original and loses any
further updates. The estimate's creator has no way to let a specific trusted colleague
who already uses EstimAI actually open and work on *their* estimate, rather than a stale
snapshot of it.

## Domain language

Terms used throughout (to be reused in the plan, APIs, and UI copy). These extend, and do
not replace, spec 001's existing `estimate`/`release`/`activity`/`epic` vocabulary.

- **owner** — the Operai user who created the estimate (spec 001, unchanged); the only
  person who may add, change, or remove its collaborators, or delete the estimate itself.
- **collaborator** — a *different*, already-registered Operai user who holds EstimAI app
  access (specs/004's `access` grant) and has been explicitly granted access to one
  specific estimate by its owner. A collaborator is never the estimate's owner.
- **collaborator share** (or just **share**, as a verb: "the owner shares the estimate
  with someone") — the owner's act of granting a specific registered EstimAI user an
  access level on one of their estimates. This is a NEW, distinct mechanism from the
  estimate toolbar's existing **link share** (below) — see US-8.
- **link share** — the estimate toolbar's already-shipped "Share" feature
  (`estimai-ui/src/lib/shareUrl.ts`, `SharedEstimatePage`): an unauthenticated,
  account-free, read-only URL that lz-string-encodes a point-in-time snapshot of the
  estimate. It requires no Operai account on either end, is not persisted server-side,
  and is unaffected by this feature (US-8).
- **access level** — what a collaborator may do with a shared estimate: `viewer` (open
  it, see every computed value, use the existing link-share/export features on it, but
  never change its content) or `editor` (everything a viewer can do, plus the same
  content-editing capabilities as the owner — releases, epics, activities, parameters,
  name — with the sole exceptions of managing collaborators and deleting the estimate,
  which stay owner-only).
- **shared estimate** — from a collaborator's point of view, an estimate they didn't
  create but have been granted `viewer` or `editor` access to; it appears in their own
  estimates list (US-2), distinguished from estimates they own.
- **edit conflict** — the situation where a save to a persisted estimate would silently
  overwrite a change someone else (the owner or another editor) made since the saving
  user last loaded or successfully saved that estimate (US-4).
- **orphaned estimate** — a shared estimate whose owner's Operai account has since been
  soft-deleted (specs/006, ADR-0012); the estimate and its collaborator grants survive,
  but every owner-only capability on it becomes permanently unavailable (US-10).

## User stories

### US-1: Owner shares an estimate with a registered EstimAI user

As the owner of an estimate, I want to grant a specific existing Operai colleague access
to it, so that they can view or work on my actual estimate rather than a copy.

**Acceptance criteria:**
- AC-1.1: Given an estimate owned by the current user, when they open its collaborator
  management UI and enter another user's exact Operai email address plus an access level
  (`viewer` or `editor`), then, if that email belongs to an active, registered Operai
  user who holds EstimAI app access, that user is added as a collaborator with the
  chosen access level and appears in the estimate's collaborator list.
- AC-1.2: Given an email address that does not belong to any active Operai user, OR
  belongs to a user who does not hold EstimAI app access, when the owner attempts to add
  them as a collaborator, then the attempt is rejected with ONE fixed, generic error
  message, and no invitation/signup email is sent to that address — sharing only ever
  connects two already-provisioned Operai users (see Non-goals). This is a testable
  anti-enumeration property, not merely a copy choice: the response (message text, HTTP
  status, and timing characteristics) must be identical regardless of WHICH of the two
  reasons applies — an owner (or anyone inspecting network traffic) must not be able to
  distinguish "no such Operai account" from "account exists but lacks EstimAI access" by
  any observable difference in the response. This is confirmed, decided behavior (not
  open) — see AC-1.3 for the one case that IS deliberately distinguished (already a
  collaborator).
- AC-1.3: Given an email address that already belongs to a collaborator on that estimate,
  when the owner attempts to add it again, then the attempt is rejected with a message
  explaining they're already a collaborator, no duplicate entry is created, and the owner
  is pointed at changing the existing collaborator's access level instead (US-5).
- AC-1.4: Given the owner's own email address, when they attempt to add themselves as a
  collaborator on their own estimate, then the attempt is rejected — an owner is never
  also listed as their own collaborator.
- AC-1.5: Given a user who is a collaborator (viewer or editor) on an estimate but not
  its owner, when they attempt to add another collaborator to it (via the UI or the
  underlying API directly), then the action is denied — only the owner may add
  collaborators; a collaborator can never re-share.
- AC-1.6: Given a user who is neither the owner nor a collaborator on a given estimate,
  when they attempt to open it directly (e.g. a guessed or stale URL) or call its API,
  then the request is denied the same way an entirely unrelated user's estimate is today
  — not found, not merely forbidden — extending spec 001 AC-4.1/ADR-0005's "not owned =
  404" pattern to "not owned AND not a collaborator" (see Amendments).

### US-2: Collaborators see shared estimates in their own list, clearly distinguished

As a collaborator, I want estimates shared with me to show up where I already look for my
own estimates, so that I don't need a separate place to find them.

**Acceptance criteria:**
- AC-2.1: Given a user who is a collaborator on one or more estimates they did not
  create, when they open their estimates list, then those estimates appear in the same
  list as their own, each row showing at minimum the owner's identity and the viewer's
  own access level (`viewer`/`editor`) on it.
- AC-2.2: Given a list containing both estimates a user owns and estimates shared with
  them, then the two are visually distinguishable at a glance (e.g. owned rows carry no
  "shared" indicator; shared rows do).
- AC-2.3: Given a user with zero owned estimates but one or more shared with them, when
  they open their list, then it is NOT shown as the "no estimates yet" empty state (spec
  001 AC-2.3) — having estimates shared with them counts as having estimates to show.

### US-3: Access level governs what a collaborator can do

As the owner, I want a collaborator's ability to change my estimate to match the access
level I granted them, so I can let some people just look and let others actually work on
it.

**Acceptance criteria:**
- AC-3.1: Given a collaborator with `viewer` access, when they open the shared estimate,
  then they see identical computed values (PERT, Expected, Elapsed, Summary, etc.) to the
  owner, and can use the existing link-share feature and XLSX/PDF export on it exactly as
  the owner could — but every control to add, edit, or delete a release, epic, activity,
  or parameter is disabled or absent, and an edit attempt made directly against the
  underlying API is refused.
- AC-3.2: Given a collaborator with `editor` access, when they open the shared estimate,
  then they have the same content-editing capabilities as the owner (releases, epics,
  activities, parameters, name), with the exceptions in AC-3.3.
- AC-3.3: Given any collaborator (viewer or editor), when they attempt to delete the
  estimate itself or to add/change/remove another collaborator's access, then the action
  is refused regardless of their own access level — only the owner may delete the
  estimate or manage its collaborators (AC-1.5).

### US-4: Concurrent edits are detected, never silently discarded

As anyone editing a shared estimate, I want to be warned if my save would overwrite a
change someone else just made, so that work isn't silently lost the moment more than one
person can touch the same estimate.

**Acceptance criteria:**
- AC-4.1: Given an estimate that has been modified (by the owner or any editor) since the
  currently-saving user last loaded or last successfully saved it, when that user attempts
  to save, then the save is refused, no data is overwritten, and the user is shown a clear
  conflict message — never a silent overwrite and never a silently dropped save.
- AC-4.2: Given a save refused per AC-4.1, when the user is shown the conflict, then they
  are offered a way to reload the current, latest version of the estimate, and their own
  unsaved changes remain visible/available to them in their own editor session until they
  choose to reload — the conflict detection itself never discards their in-progress edits.
- AC-4.3: Given two users attempt to save the same estimate at effectively the same
  instant, when the server processes both, then exactly one save succeeds and the other
  receives AC-4.1's conflict response — never a silent partial merge and never both
  requests "succeeding" with one clobbering the other.
- AC-4.4: Given a solo owner editing the same estimate from two browser tabs or devices
  (no other collaborator involved), when the second tab attempts to save after the first
  tab already saved, then the same conflict detection applies (AC-4.1) — see Amendments;
  this deliberately supersedes spec 001's prior single-writer last-write-wins acceptance.

### US-5: Owner manages and revokes collaborator access

As the owner, I want to change or remove a collaborator's access at any time, so access
always reflects who should currently be able to see or work on the estimate.

**Acceptance criteria:**
- AC-5.1: Given an existing collaborator, when the owner changes their access level
  (`viewer` ↔ `editor`), then the change is saved and takes effect on that collaborator's
  next request to the estimate (list, open, or save) — a collaborator downgraded to
  `viewer` can no longer save changes from that point forward; one upgraded to `editor`
  can save from that point forward.
- AC-5.2: Given an existing collaborator, when the owner removes them, then that user
  loses access: their next request for that estimate (list, open, save) is refused the
  same way an unrelated user's would be (AC-1.6), and the estimate no longer appears in
  their estimates list.
- AC-5.3: Given a collaborator who has the estimate open in their browser at the moment
  their access is revoked or downgraded, then no live/forced disconnection is required —
  enforcement happens on their next request (their next attempted save fails per
  AC-5.2/AC-3.1), not a real-time kick out of an open editor.
- AC-5.4: Given the owner's own account, then it is never itself listed among, or
  manageable as, a collaborator on their own estimate (mirrors AC-1.4).

### US-6: A collaborator can remove themselves

As a collaborator, I want to remove myself from an estimate I no longer want to be part
of, so that I don't have to ask the owner to do it for me.

**Acceptance criteria:**
- AC-6.1: Given a user who is a collaborator (viewer or editor, not owner) on an
  estimate, when they choose to leave it, then their own access is removed immediately,
  the estimate disappears from their own estimates list, and the owner's collaborator
  list no longer includes them.
- AC-6.2: Given a user who is the owner of an estimate, then no "leave" action is offered
  to them for their own estimate — an owner leaves by deleting the estimate (spec 001
  US-3), not by removing themselves as a collaborator.

### US-7: Collaborators are notified of being granted or removed access

As a collaborator, I want to be told when I've been given access to (or removed from)
someone's estimate, so I discover shared work without polling my estimates list.

**Acceptance criteria:**
- AC-7.1: Given the owner adds a new collaborator (US-1), when the grant is saved, then
  that collaborator receives an in-app notification via the suite's existing notification
  center (ADR-0009), identifying the estimate and the granted access level.
- AC-7.2: Given the owner removes a collaborator (US-5, owner-initiated — not the
  collaborator leaving themselves under US-6, which needs no notification since they
  initiated it), when the removal is saved, then that former collaborator receives an
  in-app notification identifying which estimate they lost access to.
- AC-7.3: Given any other activity on a shared estimate — content edits, saves, exports,
  or an access-level change between viewer and editor — then no notification is sent for
  it; only the collaborator-grant (AC-7.1) and owner-initiated-removal (AC-7.2) events
  raise one (see Non-goals on activity feeds).

### US-8: The existing read-only link share stays untouched and distinct

> **SUPERSEDED 2026-08-09 — this story no longer describes the product.** The
> anonymous link share it protects was removed entirely at the user's direction:
> the toolbar "Share link" button, `shareUrl.ts`, `SharedEstimatePage`, the
> `/share` route, `QrModal`, the client PDF's "Scan to view online" QR, and the
> `lz-string`/`qrcode` dependencies are all gone. Account-based collaboration
> (US-1–US-7, US-9, US-10) is now the *only* way to share an estimate.
>
> AC-8.1 and AC-8.2 below are therefore **no longer satisfiable and are not
> expected to hold** — they are retained verbatim as the record of what was true
> when this spec shipped, not as live requirements. T24's regression guard was
> deleted with `SharedEstimatePage.test.tsx`; the assertions that replaced it
> (in `EstimatorApp.test.tsx` and `router.test.tsx`) now prove the *absence* of
> any link-share affordance or `/share` route.
>
> Consequence accepted at removal time: an estimate can no longer be shown to
> anyone without an Operai account and EstimAI app access (AC-1.2), so there is
> no longer a client-facing read-only view.

As any user, I want the existing "Share" link (no account required) to keep working
exactly as it does today, so quick, disposable read-only sharing outside the
collaboration model still works.

**Acceptance criteria:**
- AC-8.1: Given the existing link-share feature (`shareUrl.ts`, `SharedEstimatePage`),
  when this feature ships, then its behavior, entry point, and lack of any account/
  collaborator requirement are unchanged — it remains a separate, one-off, read-only
  export mechanism, never folded into or replaced by collaborator management.
- AC-8.2: Given a user viewing an estimate via a link-share URL (`/share#data=...`), then
  they see no collaborator-related UI (no collaborator list, no access-level indicator
  beyond the existing plain-text `author` field) — the two sharing mechanisms stay
  visually and functionally distinct, so a recipient can't mistake "I have a link" for
  "I'm a collaborator."

### US-9: Estimate deletion clears collaborator access

As the owner, when I delete an estimate, I want every collaborator's access to end with
it, so no dangling access remains to something that no longer exists.

**Acceptance criteria:**
- AC-9.1: Given an estimate with one or more collaborators, when the owner deletes it
  (spec 001 US-3), then all of its collaborator grants are deleted along with it, and it
  disappears from every former collaborator's estimates list — their next list/open
  request no longer shows or serves it.

### US-10: An estimate survives its owner's account deletion, knowingly orphaned

As a collaborator on a shared estimate, I want the estimate and my access to it to keep
working even if the owner ever leaves wellD, so a colleague's departure doesn't destroy
or freeze work I'm actively contributing to — while accepting that no one can perform the
owner-only actions on it anymore afterward.

**Acceptance criteria:**
- AC-10.1: Given an estimate owner's Operai account is soft-deleted (specs/006 US-5,
  ADR-0012), when the deletion completes, then the estimate itself and every existing
  collaborator grant on it remain fully intact — neither the estimate nor any
  collaborator record is deleted, modified, or otherwise affected by the owner's account
  status change.
- AC-10.2: Given an estimate whose owner account is soft-deleted, when an editor
  collaborator opens it, then they retain exactly the same editor capabilities as before
  (US-3, AC-3.2) — they can continue viewing and saving changes without interruption.
- AC-10.3: Given an estimate whose owner account is soft-deleted, when a viewer
  collaborator opens it, then they retain exactly the same viewer capabilities as before
  (AC-3.1).
- AC-10.4: Given an estimate whose owner account is soft-deleted, then every owner-only
  operation on it — adding, changing, or removing a collaborator (US-1/US-5) and deleting
  the estimate itself (spec 001 US-3) — becomes permanently unavailable to every
  remaining user, including every existing collaborator regardless of their own access
  level: the estimate is knowingly and permanently orphaned, with no path in this feature
  to reassign, reclaim, or otherwise restore those owner-only capabilities (see Non-goals
  for the two alternatives considered and rejected).
- AC-10.5: Given an estimate whose owner account is soft-deleted, when any remaining
  collaborator views a place the owner's identity is normally shown (the estimate's row
  in a list, its collaborator management panel, etc.), then the UI renders a clear,
  non-crashing placeholder in place of that identity (e.g. "Former wellD member" or
  equivalent — exact copy is a plan/UI detail) — never an error, a blank field, a raw
  identifier, or stale/misleading identity information implying the account is still
  active.

## Non-goals

- **Real-time collaborative editing** (live cursors, simultaneous character-level sync).
  This feature detects conflicting saves and refuses silent overwrites (US-4); it does
  not merge changes live or show who else is currently in the estimate.
- **Ownership transfer.** An estimate's owner is fixed at creation (spec 001); this
  feature only adds collaborators around that fixed owner, it never reassigns who the
  owner is — including when that owner's account is later deleted, which results in a
  knowingly orphaned estimate rather than a reassignment (US-10).
- **Admin-mediated reassignment of an orphaned estimate's ownership.** Considered and
  rejected for v1: orphaning (US-10) is the accepted terminal state; no admin-tool
  workflow to hand an orphaned estimate's ownership to someone else is introduced here.
- **Automatic successor-promotion of a collaborator to owner.** Considered and rejected
  for v1: an editor collaborator never automatically becomes the owner when the original
  owner's account is deleted — the estimate simply loses its owner-only capabilities
  (AC-10.4) rather than silently handing them to someone who wasn't explicitly chosen.
- **A user-directory/search UI for picking collaborators.** Collaborators are added by
  typing the exact, already-known email address (AC-1.1); this feature introduces no new
  way to browse or discover Operai's user list, which stays admin-only (specs/004/006).
- **Inviting someone who isn't yet an Operai user, or who lacks EstimAI access.** That is
  specs/006's admin invitation flow and specs/004's app-access grant, respectively; this
  feature only connects two already-provisioned users (AC-1.2) — it is not a second,
  parallel invitation system.
- **Per-release or per-activity granular permissions.** Access is whole-estimate only
  (`viewer`/`editor`, US-3); an owner cannot grant access to just one release.
- **Comments/annotations, in-estimate chat, or a change/edit history log.** This feature
  governs who can see/edit an estimate, not discussion of or audit trail over individual
  changes made within it (see AC-7.3 — only grant/removal events notify).
- **More than two access levels.** `viewer` and `editor` are the only two, matching
  "look" versus "work on it" — no `commenter` or other intermediate level.
- **Changing the existing read-only link share.** It remains a separate, unauthenticated,
  account-free mechanism, untouched by this feature (US-8).
- **Real-time forced disconnection on revocation.** Enforcement is next-request, not a
  live kick (AC-5.3) — acceptable because estimate editing has no live multi-cursor
  presence channel to begin with, and none is introduced by this feature.
- **Re-sharing by a collaborator.** Only the owner may add, change, or remove
  collaborators (AC-1.5); a collaborator's access never lets them extend access to anyone
  else.
- **A cap on the number of collaborators per estimate.** Not requested; mirrors spec
  001's existing no-count-quota stance for estimates themselves.

## Constraints

*Facts already established by the codebase/domain, captured verbatim for the plan, not
elaborated here.*

- Estimates are persisted as whole JSONB documents via `estimai-api`, with every existing
  query scoped to the caller's `sub` and a not-owned record returning 404 (spec 001,
  ADR-0004, ADR-0005). This feature requires that scoping to widen from "owner only" to
  "owner OR an explicitly granted collaborator" — see Amendments and AC-1.6.
- The suite's authorization services today only ever resolve a CALLER's own effective
  permissions (`auth GET /authz/me`, `GET /authz/resolve` — ADR-0007/ADR-0014); there is
  no existing way for `estimai-api` to look up a THIRD party's EstimAI app-access status
  by email in order to validate AC-1.1/AC-1.2. Building that lookup is new work for the
  plan stage, not elaborated further here.
- EstimAI app access itself (specs/004's `access` action) is unaffected by this feature
  and continues to gate the whole app at the shell boundary (ADR-0007 US-7): if a
  collaborator's EstimAI app access is later revoked entirely, they lose the ability to
  reach EstimAI (and therefore any shared estimate) through that existing mechanism,
  without this feature needing its own duplicate enforcement of that boundary. Their
  underlying collaborator grant record is not automatically deleted by this — only an
  explicit owner removal (US-5) or estimate deletion (US-9) removes it.
- User soft-deletion (specs/006, ADR-0012) already retains a deleted user's data
  footprint elsewhere in the suite rather than physically removing it (specs/006 AC-5.4);
  US-10 applies that exact established posture to estimate ownership specifically —
  no new deletion-cascade mechanism is introduced by this feature.
- Notifications reuse the suite's existing notification center (`notify-api`, ADR-0009)
  and its established cross-user "system"-triggered push pattern (ADR-0017) for the
  grant/removal events in US-7; no new email delivery channel is required for v1 — an
  in-app notification is sufficient, since sharing only ever happens between two already
  signed-in wellD colleagues.
- Data residency is unaffected: collaborator records are new data owned by `estimai-api`,
  which already deploys to an EU region (CLAUDE.md data residency rules, spec 001).

## Open questions

None — all resolved at spec approval (2026-08-07):

- ~~Error disclosure level (AC-1.2)~~ — **fully generic**, confirmed; AC-1.2 now states
  the anti-enumeration property explicitly (response must not vary by cause).
- ~~Owner account deletion while collaborators remain~~ — **the estimate and all
  collaborator grants survive untouched; owner-only operations become permanently
  unavailable (knowing orphaning)**, confirmed; see new US-10 and the two rejected
  alternatives recorded under Non-goals (admin-mediated reassignment,
  successor-promotion).
- ~~Collaborator count cap~~ — **no cap**, confirmed; see Non-goals.
