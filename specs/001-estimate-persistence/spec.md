---
id: 001
slug: estimate-persistence
status: draft
created: 2026-06-06
---

# Estimate persistence API

## Problem

EstimAI estimates live only in the browser's localStorage: they are lost when the
browser data is cleared, invisible from any other device, and cannot outlive the
machine they were created on. Consultants build estimates that are commercially
relevant for weeks or months and need them reliably available wherever they log in.
Now that Operai has an authentication service, estimates can be tied to a user
account and stored centrally.

## User stories

### US-1: Save an estimate to my account
As a logged-in consultant, I want to save my estimate to my account, so that it
survives browser data loss and is available from any device.

**Acceptance criteria:**
- AC-1.1: Given a logged-in user with an open estimate, when they save it, then the
  full estimate (project metadata, model parameters, releases, epics, activities) is
  persisted and a subsequent fetch returns content identical to what was saved.
- AC-1.2: Given a previously saved estimate, when the user saves it again after
  edits, then the stored version reflects the edits and no duplicate estimate is
  created.
- AC-1.3: Given a save request that fails (e.g. network down), when the failure
  occurs, then the user sees an error message and their in-browser estimate data
  is not lost.

### US-2: List and reopen my estimates
As a logged-in consultant, I want to see all my saved estimates and reopen any of
them, so that I can resume or revisit past estimation work.

**Acceptance criteria:**
- AC-2.1: Given a logged-in user with saved estimates, when they open the estimates
  list, then every estimate they saved is shown with at least its name and last
  modified date.
- AC-2.2: Given the estimates list, when the user opens one, then the editor loads
  with exactly the persisted content and all computed values (PERT, Expected,
  Elapsed, …) match what the estimation model produces for that content.
- AC-2.3: Given a logged-in user with no saved estimates, when they open the list,
  then an empty state is shown (no error).

### US-3: Delete an estimate
As a logged-in consultant, I want to delete a saved estimate, so that obsolete or
mistaken estimates don't clutter my workspace.

**Acceptance criteria:**
- AC-3.1: Given a saved estimate, when the user deletes it and confirms, then it no
  longer appears in their list and fetching it directly reports it as gone.
- AC-3.2: Given the delete action, when the user is asked to confirm, then declining
  leaves the estimate untouched.

### US-4: My estimates are private
As a logged-in consultant, I want my estimates to be visible only to me, so that
client-sensitive effort and pricing data is not exposed to other users.

**Acceptance criteria:**
- AC-4.1: Given estimates saved by user A, when user B requests user A's estimate
  list or a specific estimate of user A by its identifier, then user B receives
  none of user A's data and the attempt is rejected.
- AC-4.2: Given an unauthenticated request to any persistence operation, when it is
  received, then it is rejected and no data is returned or modified.

### US-5: One-time import of local estimates
As a consultant who used EstimAI before accounts existed, I want my locally stored
estimates offered for upload to my account at my first sign-in, so that no existing
work is lost in the transition.

**Acceptance criteria:**
- AC-5.1: Given a user signs in on a browser that has localStorage estimates not
  yet in their account, when the session starts, then they are offered an import of
  those estimates and can accept or decline.
- AC-5.2: Given the user accepts the import, when it completes, then each local
  estimate appears in their account list with content identical to the local
  version.
- AC-5.3: Given the user declines the import, when they continue, then their local
  estimates remain untouched and the offer is not repeated on every page load
  within the same session.
- AC-5.4: Given an import that partially fails, when it finishes, then the user is
  told which estimates were imported and which were not, and no local estimate is
  removed.

## Constraints

- Estimate data must be stored in an EU region; no estimate data may be logged by
  the hosting provider beyond standard access logs (Operai data residency rules).
- Authentication is provided by the existing Operai auth service (RS256 JWT with
  JWKS verification); this feature does not introduce its own auth.
- EstimAI requires sign-in to use at all (login wall, spec 002) — there are no
  anonymous users; every estimate operation happens for a signed-in user.

## Non-goals

- **Granular release/activity endpoints** — estimates are persisted as whole
  documents in this iteration; sub-resource CRUD (the fuller contract sketched in
  AGENTS.md) is a future spec.
- **Server-backed sharing** — the existing lz-string URL sharing stays as-is;
  persisted share links are a future spec.
- **Server-rendered XLSX export** — export remains client-side.
- **Collaboration / multi-user editing** — single owner per estimate, no
  concurrent-edit handling beyond last-write-wins.
- **Preserving anonymous local mode** — the login wall introduced by spec 002
  removes anonymous use; localStorage matters here only as the source for the
  one-time import (US-5).

## Open questions

- [ ] Conflict handling: is last-write-wins acceptable when the same estimate is
  edited from two devices/tabs, or do we need a stale-write warning? — owner: Matteo
- [ ] Limits: maximum number of estimates per user and maximum estimate size —
  needed, or unlimited for the internal tool? — owner: Matteo
