---
id: 006
slug: user-invitations
status: in-progress
rigor: production
created: 2026-07-13
approved: 2026-07-13
---

# User invitations, resend, and user deletion

## Problem

Operai has no self-service sign-up: sign-in is OAuth-only (Google/GitHub), and today a
person only becomes a real user the moment they first authenticate — there is no way for
an admin to bring a new colleague onto the suite ahead of that, nor to tell them it's
time to. The admin tool (specs/004) already lets an admin browse users and assign roles
and departments, but only for people who have already signed in at least once; an admin
cannot pre-authorize someone who has never touched Operai, cannot get their address in
front of them (there is no notification to a person who isn't a user yet), and has no way
to fix a broken or stale invite. Symmetrically, the admin tool has no way to remove a user
at all — whether one at a time or several at once — even though people leave wellD,
change roles, or were granted access by mistake. As the suite grows past EstimAI into
Refund and beyond, and holds financial/personnel-adjacent data, wellD needs a controlled,
auditable way to bring people in and take them out of the suite, not just manage the
access of people already present.

## Domain language

Terms used throughout (to be reused in the plan, APIs, and UI copy):

- **invitation** — a record created by an admin for a specific email address, carrying an
  optional set of roles/departments to grant once accepted, and an invite link. Not a
  `user` — a person the admin has never seen sign in has no `User` row yet (auth is
  OAuth-only; see Constraints).
- **invite link** — the unique, time-limited URL an invitation's email contains; following
  it and completing OAuth sign-in is how an invitation is accepted.
- **invitation state** — `pending` (sent, not yet acted on), `accepted` (the invited
  person signed in and was activated with the assigned access), `expired` (the link's
  validity window passed with no acceptance), or `revoked` (an admin cancelled it before
  acceptance). See US-1/US-3/US-4 for the transitions between these.
- **inviter** — the admin who created (or most recently resent) an invitation; recorded
  for audit.
- **activation** — the moment an invited person's first OAuth sign-in is matched to their
  pending invitation and they become a full user holding the invitation's assigned roles
  and departments (see US-2).
- **resend** — replacing a pending or expired invitation's link and expiry with a fresh
  one and re-sending the email, without creating a second, competing invitation for the
  same email.
- **revoke** — an admin cancelling a not-yet-completed invitation outright, invalidating
  its link immediately (see US-1).
- **user deletion** — an admin action that soft-deletes an existing user: their access to
  the suite is revoked immediately and synchronously, while their record and data
  footprint are retained (not physically removed) for audit and referential integrity
  (see US-5).
- **soft-deleted user** — a user whose record has been marked deleted rather than
  physically removed: they have no access and do not appear in user-facing lists, but
  their row and the data referencing them elsewhere in the suite still exist internally.
- **bulk deletion** — deleting more than one user in a single admin action, with the same
  guardrails applied to the set as to a single deletion (see US-6).

## User stories

### US-1: Invite a new person to Operai

As an admin, I want to invite a new person by email — optionally assigning them roles
and/or departments up front — so that they can join Operai already scoped to the access
they're expected to have, without me having to remember to configure them after their
first sign-in.

**Acceptance criteria:**
- AC-1.1: Given the admin tool's Users section, when an admin creates an invitation, they
  must supply an email address; supplying one or more roles and/or one or more
  departments at invite time is optional (an invitation may be created with no roles/
  departments assigned, matching the seed-role default a fresh sign-in would otherwise
  get — see specs/004 AC-6.3). Any roles/departments chosen are stored on the invitation
  itself, not applied to anything yet — there is no `User` row to apply them to until
  acceptance (see US-2).
- AC-1.2: Given an admin submits an invitation for an email that has no existing, ACTIVE
  `User` row and no other non-terminal (`pending`) invitation outstanding, when it is
  submitted, then a `pending` invitation is created, an email is sent to that address via
  Resend containing the invite link, and the invitation appears in the admin tool's list
  in the `pending` state.
- AC-1.3: Given an admin submits an invitation for an email that already belongs to an
  existing, ACTIVE `User` (someone who has already signed in at least once and has not
  been deleted), when it is submitted, then it is rejected with a clear explanation —
  inviting is for people who are not yet users; an admin who wants to change an existing
  user's roles/departments uses the existing user-editing flow (specs/004), not an
  invitation. This does NOT apply to a soft-deleted user's email — see AC-1.14.
- AC-1.4: Given an admin submits an invitation for an email that already has a `pending`
  invitation outstanding, when it is submitted, then it is rejected with a clear
  explanation pointing at the existing pending invitation (resending is the intended path
  — see US-3) rather than silently creating a second, competing invitation for the same
  address.
- AC-1.5: Given an email address that previously had an `expired` or `revoked`
  invitation, when an admin submits a new invitation for it, then it is accepted and
  creates a fresh, independent `pending` invitation (a dead invitation never blocks a
  later one for the same address), which may carry a different role/department
  assignment than the dead one did.
- AC-1.6: Given the admin tool's Users section, when an admin views it, then pending,
  accepted, expired, and revoked invitations are each visibly distinguishable by their
  state, and an admin can tell, for any given email, whether it corresponds to an active
  user, a pending invitation, or neither. A pending or expired invitation's assigned
  roles/departments are visible on it, so an admin can see what a person will receive
  before (or after) they accept.
- AC-1.7: Given an invitation is created, then the invitation record itself (not the
  email's raw contents) records who invited them (the inviter) and when (per Domain
  language), reviewable later the same way other authorization-relevant admin actions are
  reviewable (specs/004 US-5's audit trail).
- AC-1.8: Given a non-admin, when they attempt to create an invitation via the admin
  tool's screens or its underlying API, then it is denied and no invitation is created or
  email sent — consistent with every other admin-only action in specs/004.
- AC-1.9: Given a `pending` or `expired` invitation, when an admin revokes it, then its
  invite link is invalidated immediately — any subsequent attempt to use it gets AC-2.5's
  "no longer valid" experience, even if the attempt happens before the invitation would
  otherwise have expired — and the invitation transitions to `revoked`.
- AC-1.10: Given a `revoked` invitation, when an admin attempts to resend it, then the
  action is refused (per AC-3.4) — a revoked invitation is terminal, same as an accepted
  one; reviving access for that email requires creating a brand-new invitation (per
  AC-1.5), not resending the revoked one.
- AC-1.11: Given an invitation that is already `accepted`, when an admin attempts to
  revoke it, then the action is refused with a clear explanation — revocation only
  applies to invitations that haven't yet been completed (`pending`/`expired`), mirroring
  resend's own scope (AC-3.4); an admin who wants to remove an already-activated person's
  access uses user deletion (US-5), not invitation revocation.
- AC-1.12: Given a revoke action, then it is recorded the same way an initial invite or a
  resend is (AC-1.7/AC-3.5) — who revoked it and when — reviewable in the audit trail.
- AC-1.13: Given a non-admin, when they attempt to revoke an invitation via the admin
  tool's screens or its underlying API, then it is denied, consistent with AC-1.8.
- AC-1.14: Given an email address that belongs to a soft-deleted user (US-5/US-6), when
  an admin submits a new invitation for it, then it is accepted the same way as for any
  other non-active email (per AC-1.5/AC-1.2) — a soft-deleted account never blocks a
  fresh invitation for its email address.

### US-2: Accept an invitation and get activated

As a person who has been invited to Operai, I want to receive an email, follow its link,
and sign in, so that I land in Operai already holding the access my admin assigned me,
without any extra setup step on my part.

**Acceptance criteria:**
- AC-2.1: Given a `pending`, unexpired invitation's email, when the invited person opens
  it, then it is written in wellD's internal tone, offered in both Italian and English
  per the suite's i18n convention, and contains a single clear link/action to accept the
  invitation.
- AC-2.2: Given the invited person follows the invite link, when they have not yet
  authenticated, then they are taken through the existing OAuth sign-in flow (Google or
  GitHub — no new sign-in mechanism is introduced by this feature).
- AC-2.3: Given the invited person completes OAuth sign-in using the SAME email address
  the invitation was sent to, when that sign-in completes, then: the invitation
  transitions to `accepted`, the person is a real, signed-in Operai user, and they hold
  EXACTLY the roles and departments the invitation specified at invite time (AC-1.1) —
  no more, no fewer — or the default baseline role if the invitation specified none, per
  specs/004 AC-6.3. This is observable by opening the admin tool's user detail for that
  person immediately afterward and seeing precisely the assigned roles/departments
  already applied, with no separate admin step required after their first sign-in.
- AC-2.4: Given the invited person instead completes OAuth sign-in using a DIFFERENT
  email address than the one the invitation was sent to, when that sign-in completes,
  then the invitation is NOT accepted or affected in any way (it remains `pending` and
  usable by its actual intended email), and the person is signed in as an ordinary new
  or existing user under their own email's identity/roles — they do not receive the
  invitation's assigned access. The invite link they followed does not itself grant
  access to whoever clicks it; it only pairs with a matching OAuth identity.
- AC-2.5: Given an invited person follows an invite link that is `expired`, `revoked`, or
  already `accepted`, when they attempt to use it, then they see a clear, explicit
  message stating the link is no longer valid (with the specific reason where it is safe
  to disclose — e.g. "this invitation has expired" vs. "this invitation was already
  used"), and no activation occurs — even if they subsequently sign in via OAuth, that
  sign-in is treated as an ordinary sign-in, not an acceptance.
- AC-2.6: Given an invitation is accepted (AC-2.3), when an admin next views the Users
  section, then that email no longer appears among pending invitations and instead
  appears as an active user with the assigned roles/departments.

### US-3: Resend a pending or expired invitation

As an admin, I want to resend an invitation whose link has expired (or whose email the
invited person says they never got), so that I can get a working link back in front of
them without asking them to be re-invited from scratch and losing the roles/departments
I'd already assigned.

**Acceptance criteria:**
- AC-3.1: Given a `pending` or `expired` invitation, when an admin resends it, then a new
  invite link with a fresh 72-hour expiry (per AC-4.1) is generated for the SAME
  invitation record — the originally assigned roles/departments and the original
  invitation's identity are preserved, not re-entered.
- AC-3.2: Given an admin resends an invitation, then a new email is sent via Resend
  containing the new link, and the invitation's state becomes (or remains) `pending`.
- AC-3.3: Given an invitation is resent, when the invited person subsequently attempts to
  use the OLD link (from before the resend), then it no longer works — AC-2.5's "no
  longer valid" experience applies to it, even though the invitation itself is still
  live under its new link. There is at most one link that can activate a given pending
  invitation at any moment.
- AC-3.4: Given an invitation that is `accepted` or `revoked`, when an admin attempts to
  resend it, then the action is refused with a clear explanation — resend only applies to
  invitations that could still plausibly be completed (`pending`/`expired`); a completed
  or cancelled invitation does not come back to life this way (an admin who wants to
  bring that person back invites them again, per AC-1.5).
- AC-3.5: Given a resend, then it is recorded the same way an initial invite is (AC-1.7)
  — who resent it and when — reviewable in the audit trail.
- AC-3.6: Given a non-admin, when they attempt to resend an invitation, then it is
  denied, consistent with AC-1.8.

### US-4: Invitations expire

As wellD, we want an unaccepted invitation to stop working after a bounded period, so
that a stale invite link sent to the wrong place, or never acted on, cannot be used to
gain access indefinitely.

**Acceptance criteria:**
- AC-4.1: Given a `pending` invitation, then it expires automatically 72 hours after it
  was created — or, if it was subsequently resent (US-3), 72 hours after the most recent
  resend, not the original creation — with no admin action required to trigger the
  expiry.
- AC-4.2: Given a `pending` invitation whose 72-hour window has elapsed with no
  acceptance, when its expiry is reached, then it is observable in the admin tool's list
  as `expired` — not silently indistinguishable from `pending`.
- AC-4.3: Given an `expired` invitation, when its invite link is followed, then AC-2.5's
  "no longer valid" behavior applies — no activation occurs regardless of what OAuth
  identity subsequently signs in.
- AC-4.4: Given an `expired` invitation, when an admin acts on it, then their available
  actions are: resend it (US-3, generating a fresh link/expiry), revoke it (AC-1.9, e.g.
  to close out an invite that's no longer wanted), or leave it expired; an admin is not
  required to take any action.

### US-5: Delete (soft-delete) a user

As an admin, I want to delete a user, so that someone who has left wellD, changed roles
elsewhere, or was granted access by mistake no longer has any way into Operai — while
their record and any data referencing them are preserved for audit and integrity, not
physically destroyed.

**Acceptance criteria:**
- AC-5.1: Given an admin selects an existing user (other than themselves — see AC-5.6)
  and confirms deletion, when the deletion completes, then that person is soft-deleted:
  their user record is marked deleted rather than physically removed, and — synchronously,
  as part of the same delete request, not via a background job (see Constraints) — every
  one of their currently active sessions is revoked and they can no longer establish a
  new authenticated session.
- AC-5.2: Given a soft-deleted user, when they subsequently attempt to sign in again via
  OAuth using the exact same (verified) email address as before, then the sign-in is
  refused and no access is granted — a soft-deleted email is NOT silently resurrected
  back into an active account, and it is NOT treated as an ordinary new-user sign-in
  either; regaining access requires an admin to explicitly re-invite that email first
  (AC-1.14/AC-5.10).
- AC-5.3: Given a soft-deleted user, when an admin next views the Users list or searches
  for them, then they no longer appear — they are gone from every user-facing list, not
  merely disabled or greyed out.
- AC-5.4: Given a soft-deleted user, then their underlying record and their data
  footprint elsewhere in the suite are retained, not physically removed — this is what
  "soft" delete means here — preserving referential integrity for audit trails and any
  data that still references them (e.g. estimates, notifications, prior audit entries).
  This retention is an internal/compliance property, not a user-facing capability: there
  is no admin-facing way to browse or reactivate a soft-deleted user directly (see
  Non-goals — regaining access only happens via a fresh invitation, AC-5.10).
- AC-5.5: Given an admin attempts to delete the sole remaining user holding admin access
  (directly or via a department, mirroring the last-admin guard already applied to role/
  department changes — specs/004 AC-6.4), when the deletion is attempted, then it is
  refused with a clear explanation, and the user is not deleted.
- AC-5.6: Given an admin attempts to delete their OWN account, when the deletion is
  attempted, then it is refused — an admin can never delete their own account through
  this action, under any circumstance, independent of whether other admins remain in the
  system (this is a separate, absolute rule from the last-admin guard in AC-5.5, not a
  special case of it). The admin tool disables/omits the delete action for the caller's
  own row; the underlying API also refuses it if invoked directly.
- AC-5.7: Given a user deletion is confirmed, then it requires an explicit, distinct
  confirmation step (not a single accidental click) before it takes effect, given that
  regaining access afterward requires a fresh admin re-invitation (AC-5.10), not an
  automatic undo (see Non-goals).
- AC-5.8: Given a user deletion, then it is recorded the same way other admin actions on
  a user are (AC-1.7) — who deleted whom and when — reviewable in the audit trail; unlike
  a hard delete, the deleted user's own record still exists internally to be referenced
  by that audit entry.
- AC-5.9: Given a non-admin, when they attempt to delete a user via the admin tool's
  screens or its underlying API, then it is denied, consistent with AC-1.8.
- AC-5.10: Given a soft-deleted user's email is re-invited by an admin (AC-1.14) and that
  invitation is subsequently accepted (US-2), then a fresh, active account is established
  for that email holding exactly the newly-assigned roles/departments (per AC-2.3) — this
  is a new activation, not a resurrection of the soft-deleted record's prior roles,
  departments, or state.

### US-6: Bulk delete (soft-delete) users

As an admin, I want to select several users and delete them in one action, so that
routine cleanup (an offboarded team, a batch of mistaken invites-turned-users) doesn't
require repeating the single-delete flow one person at a time.

**Acceptance criteria:**
- AC-6.1: Given the Users list, when an admin selects more than one user and confirms
  bulk deletion, then every selected user for whom deletion is permitted (per US-5's
  guardrails) is soft-deleted, observable the same way a single deletion is (AC-5.1–5.4)
  for each of them.
- AC-6.2: Given a bulk selection that includes the sole remaining admin (per AC-5.5)
  and/or the acting admin's own account (per AC-5.6), when the batch is submitted, then
  those specific users are excluded from the deletion — the acting admin's own account is
  ALWAYS excluded if selected, with no exception — and every other selected user in the
  batch is still soft-deleted; a batch is not entirely blocked by one or more
  un-deletable members.
- AC-6.3: Given a bulk deletion completes, when it finishes, then the admin is shown
  which of the selected users were deleted and which (if any) were skipped and why (e.g.
  "skipped: last remaining admin", "skipped: cannot delete your own account") — never a
  silent partial result indistinguishable from full success.
- AC-6.4: Given a bulk deletion, then each soft-deleted user's removal is individually
  recorded in the audit trail exactly as a single deletion would be (AC-5.8), not
  collapsed into one undifferentiated batch entry that hides who was actually removed.
- AC-6.5: Given a non-admin, when they attempt a bulk deletion via the admin tool's
  screens or its underlying API, then it is denied, consistent with AC-1.8.

## Non-goals

- **Self-service sign-up.** There is still no way for an arbitrary person to create their
  own Operai account; every new user is either invited by an admin or, unchanged from
  today, signs in and receives the baseline `employee` role (specs/004 AC-6.3). This
  feature adds a way to pre-authorize and reach a specific person; it does not open
  registration.
- **Restoring or "undeleting" a soft-deleted user via an explicit admin action.** Even
  though deletion is implemented as a soft delete (their record and data are retained —
  AC-5.4), there is no admin-facing "undo"/"restore" button that reactivates the old
  account as-is. A soft-deleted person regains access only by being re-invited (AC-1.14)
  and accepting a fresh invitation (AC-5.10), which establishes a new activation with
  whatever roles/departments that new invitation assigns — never an automatic return of
  their prior state.
- **Changing who may invite, revoke, resend, or delete.** All of these are admin-only,
  reusing the exact admin gate specs/004 already established (AC-1.8/1.13/3.6/5.9/6.5) —
  no new, narrower permission (e.g. an "inviter" role distinct from full admin) is
  introduced by this feature. Everyone in the admin tool with the existing admin gate can
  do all of these; a role/permission split is a policy question, not a WHAT this feature
  ships.
- **The exact per-service mechanics of the delete cascade.** Precisely what notify-api,
  estimai-api, and any future service do, at the data level, with a deleted user's
  notifications, estimates, sessions/tokens, or audit references. This spec locks that
  the cascade is triggered synchronously and that the suite-facing outcome is immediate
  (AC-5.1–5.3), and that deletion itself is soft rather than physically destructive
  (AC-5.4) — but the concrete per-service marking/handling mechanics remain the
  architect's design (see Open questions).
- **Designing the email-delivery channel's internals.** This spec locks WHICH service
  sends invite/resend email — the existing notify-api, as a second delivery channel
  alongside its in-app/SSE channel (see Constraints) — and that Resend is the sending
  provider, but not that channel's internal schema, templates, or retry/bounce handling,
  which is the architect's/plan's job.
- **Any change to how a person signs in.** OAuth via Google/GitHub remains the only
  sign-in mechanism; this feature does not add password/email-link sign-in, only an
  invite/accept flow layered on top of the existing OAuth sign-in (US-2).
- **Editing an existing invitation's assigned roles/departments in place.** Once sent, an
  invitation's assigned roles/departments only change via resend (which preserves them
  unchanged, AC-3.1) or by revoking (AC-1.9) and creating a fresh invitation with a
  different assignment (AC-1.5). There is no in-place edit of a still-pending invitation's
  grants.
- **Bulk invite.** Only bulk *deletion* is in scope (US-6); inviting multiple people in
  one action is not requested and not specified here.
- **Rate-limiting or anti-abuse protection** on invitation creation/resend (e.g. an admin
  or a compromised admin account spamming invitations). An operational concern for the
  plan stage, not specified as a product requirement here.

## Constraints

*User-volunteered decisions, captured verbatim for the plan; not elaborated here.*

- **Email is sent via Resend.** This is the given provider for invite/resend emails; the
  plan is not free to choose a different email-sending provider for this feature.
- **Invite/resend email is delivered as a SECOND channel of the existing notify-api
  service (specs/005), NOT a new, separate service.** notify-api gains an email-delivery
  channel (via Resend) alongside its existing in-app/SSE channel. The detailed design of
  that channel (schema, templates, retry/bounce handling) is the architect's call (see
  Non-goals).
- **This is a wellD-internal tool**, so invite/resend emails follow the suite's existing
  i18n convention — Italian and English at minimum (CLAUDE.md "no hardcoded UI strings").
- **Invite creation, revocation, resend, and deletion (single and bulk) live in the
  existing admin section** (admin-ui, alongside the existing Users list/detail from
  specs/004) — this is an extension of that admin surface, not a new tool.
- **The last-admin guard already established for role/department changes (specs/004
  AC-6.4) extends to deletion** — deleting a user must not be able to leave the suite
  with zero effective admins (AC-5.5), reusing that existing guardrail's concept rather
  than introducing a different rule.
- **An invitation may carry role(s)/department(s) assigned at invite time**, stored on
  the invitation and applied automatically — exactly, no more/fewer — the moment the
  invited person accepts via their first matching OAuth sign-in (AC-1.1, AC-2.3).
- **Invitations expire 72 hours after creation**, or 72 hours after the most recent
  resend if the invitation was resent (AC-4.1) — this window is a decided product value,
  not left to the plan.
- **An admin can never delete their own account**, in either single or bulk deletion,
  under any circumstance — this is absolute and independent of whether other admins
  remain in the system (AC-5.6, AC-6.2); it is a separate rule from, and stricter than,
  the last-admin guard.
- **Revoking a not-yet-completed invitation ships in v1.** An admin can revoke a
  `pending` or `expired` invitation, immediately invalidating its link (AC-1.9); a
  revoked invitation is terminal like an accepted one — it cannot be resent (AC-1.10),
  only replaced by a brand-new invitation for that email (AC-1.5).
- **User deletion (single and bulk) is a SOFT delete with a SYNCHRONOUS cascade.** The
  deleted user's row and cross-service data footprint (notifications, estimates, audit
  references, etc.) are retained, not physically removed, for audit/referential
  integrity (AC-5.4); access revocation — sign-in refusal and session invalidation —
  happens synchronously as part of the same delete request, not via a background job
  (AC-5.1). The exact per-service cascade mechanics (what each service does with a
  deleted user's data) remain the architect's call (see Open questions).
- *Recommended direction for the architect (not binding), per approval-gate discussion:*
  match an OAuth-verified email against a pending invitation inside a better-auth
  `user.create` after-hook — alongside the existing baseline-role-assignment hook in
  `auth/src/auth/auth.config.ts` — applying the invitation's roles/departments and
  bumping the user's `perm_epoch` on activation; the invite link itself carries the
  invitation id for UX/tracking purposes only, never as an authorization mechanism in
  its own right. Final mechanism is the plan's call.

## Open questions

*The following were resolved by the user at the approval gate (folded into the stories
and Constraints above): whether an invitation assigns roles/departments at invite time
(yes — AC-1.1/AC-2.3/Constraints), the invitation expiry duration (72 hours — AC-4.1/
Constraints), the self-delete policy (blocked absolutely — AC-5.6/AC-6.2/Constraints),
whether `revoke` ships in v1 (yes — AC-1.9–AC-1.13/Constraints), the email delivery
architecture (notify-api's second channel, not a new service — Constraints), and
deletion's soft-vs-hard/synchronous-vs-async nature (soft + synchronous — AC-5.1–5.4,
AC-5.10, Constraints). The two items below remain open for the architect.*

- [ ] **OAuth invite-matching mechanics**: the exact mechanism by which a completed OAuth
  sign-in is matched against a pending invitation for the same email and triggers
  activation — the observable behavior is specified in US-2; the mechanism is the plan's
  call. See the recommended, non-binding direction under Constraints (a `user.create`
  after-hook keyed on verified email, applying roles/departments and bumping
  `perm_epoch`). — owner: architect.
- [ ] **Cross-service delete-cascade mechanics**: given that the cascade must be soft and
  synchronous (locked under Constraints), what concretely each other Operai service
  (notify-api, estimai-api, session/token stores, audit) does to mark or handle a
  soft-deleted user's data — e.g. a synchronous call fanned out from the admin API, each
  service checking a shared "deleted" flag on read, or another mechanism — remains the
  architect's design. — owner: architect.
