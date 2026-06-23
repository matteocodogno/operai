---
id: 002
slug: ui-auth-integration
status: in-progress
created: 2026-06-06
approved: 2026-06-06
---

# Auth integration in estimai-ui

## Problem

EstimAI has no notion of who is using it: anyone with the URL gets the full app,
and the UI cannot make authenticated calls to any backend. The Operai auth service
now exists and issues user identities, but estimai-ui is not connected to it. Until
the UI can establish a signed-in user and attach their credentials to outgoing
requests, no server-backed feature (starting with estimate persistence, spec 001)
can ship.

## User stories

### US-1: Sign-in is required to use EstimAI
As wellD, we want EstimAI accessible only to signed-in users, so that the tool and
the client-sensitive data in it are not open to anyone with the URL.

**Acceptance criteria:**
- AC-1.1: Given an unauthenticated visitor, when they open any EstimAI page, then
  they are redirected to the sign-in/up page and see none of the app's content.
- AC-1.2: Given a visitor redirected from a specific page, when they complete
  sign-in, then they land on the page they originally requested.
- AC-1.3: Given a visitor who opened the sign-in page directly (no prior page),
  when they complete sign-in, then they land on the EstimAI home page.

### US-2: Sign in with Google or GitHub
As a consultant, I want to sign in with my Google or GitHub account, so that I can
access EstimAI without managing another password.

**Acceptance criteria:**
- AC-2.1: Given the sign-in/up page, when it is displayed, then both Google and
  GitHub sign-in options are offered.
- AC-2.2: Given a user completes the OAuth flow with either provider, when they
  return to EstimAI, then they are signed in and their session persists across a
  page reload.
- AC-2.3: Given a user abandons or fails the OAuth flow, when they return to
  EstimAI, then they remain signed out, see an understandable message, and can
  retry.

### US-3: Authenticated API requests
As a signed-in consultant, I want every request the app makes to Operai backend
services to carry my identity, so that server-backed features work for my account
without me doing anything.

**Acceptance criteria:**
- AC-3.1: Given a signed-in user, when the app makes any request to an Operai
  backend service, then the request carries the user's token (observable in the
  request headers).
- AC-3.2: Given a signed-in user, when their token is inspected by a backend
  service, then it identifies the correct user (verified against the auth
  service's own session/token endpoints, without waiting for estimai-api).

### US-4: Expired or invalid sessions send me back to sign-in
As a consultant whose session has expired, I want to be sent to the sign-in page
and returned to where I was, so that an expired session costs me a login and
nothing more.

**Acceptance criteria:**
- AC-4.1: Given a request that is rejected as unauthenticated (401), when the
  rejection occurs, then the user is redirected to the sign-in/up page.
- AC-4.2: Given a user redirected by AC-4.1, when they sign in again, then they
  return to the page they were on before the redirect.
- AC-4.3: Given the redirect to sign-in, when it happens, then unsaved in-browser
  estimate data is not lost — after re-login the user finds their work as they
  left it.

### US-5: Visible identity and sign-out
As a signed-in consultant, I want to see who I'm signed in as and be able to sign
out, so that I can verify my account and safely use shared machines.

**Acceptance criteria:**
- AC-5.1: Given a signed-in user, when any app page is shown, then the header
  shows their name and/or avatar.
- AC-5.2: Given the user chooses sign out, when it completes, then their session
  is ended and any attempt to use the app redirects to the sign-in page.

## Constraints

Captured from the feature request and scope decisions, verbatim intent:

- Every time a request gets a 401, the user is redirected to the sign-in/up page.
- After login the user is redirected to the previous page, or to the EstimAI home
  page if there is none.
- The JWT is stored client-side and an interceptor attaches the token to future
  requests.
- The sign-in/up page is hosted by the auth service, not by estimai-ui; EstimAI
  redirects there and users return after OAuth completes. Building that hosted
  page (work landing in the auth service) is in scope of this feature.
- Sign-in methods are exactly those the auth service provides today: Google and
  GitHub OAuth (no email/password).

## Non-goals

- **Estimate persistence** — covered by spec 001; this feature only establishes
  the authenticated channel it needs.
- **Additional sign-in methods** — email/password, magic links, or further OAuth
  providers are out of scope.
- **Roles and permissions** — every signed-in user has identical access; no
  admin/viewer distinction.
- **Account management** — profile editing, account deletion, linking multiple
  providers are out of scope.
- **estimai-api integration** — "done" is verified against the auth service's own
  endpoints; wiring real estimate calls happens with spec 001 implementation.

## Open questions

None. Resolved during drafting:

- ~~Conflict with spec 001 (anonymous local mode)~~ — login wall confirmed as
  mandatory; spec 001 amended accordingly on 2026-06-06 (anonymous-mode AC
  removed, import retargeted to first sign-in).
- ~~Who builds the hosted sign-in page~~ — in scope of this feature, as work
  landing in the auth service (see Constraints).
