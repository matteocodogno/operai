---
id: 016
slug: notify-service-credentials
status: done
rigor: production
created: 2026-10-13
approved: 2026-10-13
done: 2026-10-30
---

# Every notify caller authenticates as itself; the shared token is retired

## Problem

Three services (`auth`, `refund-api`, `estimai-api`) reach the notification service's
internal endpoints with one static secret they all share. The secret never expires, says
nothing about which service is calling, and is all-or-nothing: whoever holds it can both
push an in-app notification to any user and send email from wellD's domain. A leak from
any one of the three exposes all of it, and rotating the secret means changing four
services at the same moment. A fourth caller (`inventory-api`, specs/015) was deliberately
given its own short-lived, limited credential instead, so the suite now runs two
mechanisms side by side, and the email endpoint only understands the old one. ADR-0040
committed to stopping the reuse and ADR-0044 named this migration as the follow-up; this
feature is that follow-up, done as planned hardening with no incident behind it.

## Domain language

Reuses `auth`'s existing terms (AGENTS.md § Identity & authorization): **service client**
is unchanged. Terms this feature adds or sharpens:

- **shared token** — the single static secret all three legacy callers present today.
  _Avoid:_ internal token, system token.
- **service credential** — what a service client presents to the notification service:
  short-lived, issued by `auth` to that one client, carrying that client's identity and
  its scopes. _Avoid:_ service token when the shared token could be meant.
- **scope** — one named permission carried by a service credential. This feature has two:
  **push** (send an in-app notification to a user) and **email** (send an email).
- **caller** — a service that reaches the notification service's internal endpoints:
  `auth`, `refund-api`, `estimai-api`, `inventory-api`.
- **transition** — the period in which the notification service accepts both the shared
  token and service credentials. It ends when the shared token is retired.

## User stories

### US-1: Each caller presents its own credential

As the person responsible for the suite's security, I want every caller to authenticate
to the notification service as its own service client, so that a call can be attributed
to one service and one service's credential can be revoked without touching the others.

**Acceptance criteria:**
- AC-1.1: Given `refund-api` approving or rejecting a request, when it pushes the decision
  notification, then the call carries `refund-api`'s own service credential and no shared
  token.
- AC-1.2: Given `refund-api` sending a batch email, then the call carries `refund-api`'s
  own service credential and no shared token.
- AC-1.3: Given `estimai-api` granting or removing a collaborator, when it pushes the
  notification, then the call carries `estimai-api`'s own service credential and no
  shared token.
- AC-1.4: Given `auth` sending or resending an invitation email, then the call carries a
  service credential identifying `auth` and no shared token.
- AC-1.5: Given any accepted internal call, then the notification service's log line for
  it names the calling service client, and contains neither the credential nor any
  notification or email content.
- AC-1.6: Given one service client's secret is removed from `auth`'s configuration, when
  that service next asks for a credential, then it is refused, and the other callers
  keep working.

### US-2: A credential only does what its service needs

As the person responsible for the suite's security, I want each service client limited to
the scopes its service uses, so that a leaked credential cannot send email unless that
service sends email.

**Acceptance criteria:**
- AC-2.1: Given the configured service clients, then `estimai-api` and `inventory-api`
  hold the push scope only, `auth` holds the email scope only, and `refund-api` holds
  both.
- AC-2.2: Given a credential without the email scope, when it is presented to the email
  endpoint, then the call is refused and no email is sent.
- AC-2.3: Given a credential without the push scope, when it is presented to the push
  endpoint, then the call is refused and no notification is stored or delivered.
- AC-2.4: Given a signed-in user's own token, when it is presented to either internal
  endpoint, then the call is refused.
- AC-2.5: Given an expired credential, or one issued for a different audience, when it is
  presented to either internal endpoint, then the call is refused.
- AC-2.6: Given a service client configured with a scope name that is not one of the two
  known scopes, when `auth` starts, then it refuses to start and names the client.

### US-3: The email endpoint accepts service credentials

As a caller that sends email, I want the email endpoint to accept my service credential,
so that I no longer need the shared token for anything.

**Acceptance criteria:**
- AC-3.1: Given a valid credential carrying the email scope, when it is presented to the
  email endpoint with a valid request, then the email is sent exactly as it is today
  (same templates, same response).
- AC-3.2: Given the transition, when the shared token is presented to the email endpoint,
  then it is still accepted.

### US-4: Nothing breaks while services are redeployed one at a time

As the person deploying the suite, I want to roll this out service by service, so that no
notification or email is lost because two services were briefly on different versions.

**Acceptance criteria:**
- AC-4.1: Given the notification service on the new version and a caller still on the old
  one, when that caller pushes a notification or sends an email with the shared token,
  then it succeeds.
- AC-4.2: Given a caller on the new version and its service client not yet configured in
  `auth`, when it starts, then it refuses to start with a message naming the missing
  setting, instead of starting and failing on its first send.
- AC-4.3: Given a caller on the new version, when `auth` is unreachable or refuses to
  issue a credential, then the business action that triggered the send still completes
  and the failure is recorded the same way a failed send is recorded today (a push is
  dropped and logged; an email is reported as failed and can be resent).
- AC-4.4: Given the documented rollout order is followed, then at every step each caller
  holds a credential the notification service accepts.

### US-5: The shared token is retired

As the person responsible for the suite's security, I want the shared token gone once
every caller has moved, so that there is one mechanism left and no long-lived secret that
can send email.

**Acceptance criteria:**
- AC-5.1: Given the final version of the notification service, when the shared token is
  presented to either internal endpoint, then the call is refused.
- AC-5.2: Given the final version of any service, then the shared token is not a setting
  it reads, requires or documents, and a deployment that still has it set starts
  normally.
- AC-5.3: Given the environment contract check, then it no longer knows the shared token,
  and it fails when a caller's service client id or secret does not match an entry in
  `auth`'s configured service clients, or when a caller needs a scope its client lacks.
- AC-5.4: Given the end-to-end suite run locally, then invitations, refund decisions,
  batch emails, collaborator changes and asset assignments all produce their
  notification or email with no shared token configured anywhere.
- AC-5.5: Given production after the last rollout step, then the shared token is deleted
  from every service's settings and the suite's health checks pass.

### US-6: The rollout is written down

As the person deploying the suite, I want the steps and their order in the infrastructure
notes, so that the secrets I have to create and the point of no return are clear before I
start.

**Acceptance criteria:**
- AC-6.1: Given the infrastructure notes, then they list, in order: the settings a person
  must create for each service client, which service is deployed at each step, how to
  confirm a caller is using its own credential before moving on, and the step after
  which the shared token stops working.
- AC-6.2: Given the notes' confirmation step, then it relies on the caller identity in the
  notification service's log (AC-1.5), not on reading any secret.

## Non-goals

- **Changing what is sent.** Notification and email content, templates, recipients and
  the best-effort delivery rule stay exactly as they are.
- **Rotating the shared token before the migration.** There is no suspected leak; the
  token is retired at the end, not rotated at the start.
- **Service credentials for calls other than to the notification service.** Calls between
  other services (permission resolution, identity lookups) keep forwarding the user's
  token as they do today.
- **Changing how users authenticate**, or the audience of user tokens.
- **A management screen for service clients.** They stay deployment configuration.
- **Per-recipient or per-template limits on the email scope.** A client with the email
  scope can use every existing template; narrowing that is a later decision.
- **Automatic rotation of service client secrets.** Rotation stays a manual, per-client
  operation; this feature only makes it possible without touching the other callers.

## Constraints

Decisions taken with the user on 2026-10-13, recorded as given:

- Planned hardening, not an incident response: the shared token keeps working through the
  transition and is removed last.
- One scope per capability (push, email), assigned per service as in AC-2.1.
- The feature ends only when the shared token is gone everywhere, production included.
- Services deploy independently on Railway, so the rollout must be safe with any two
  services on different versions (US-4).

From existing decisions:

- ADR-0044 is the mechanism to extend, not replace: per-client entries in `auth`'s
  service-client configuration, a short-lived credential with an audience distinct from
  the one user tokens carry.
- `notify-api` stays a single production instance (ADR-0008); nothing here may depend on
  running more than one.
- Secrets are set by a person; no script or agent reads or prints them.

## Open questions

Accepted as open at approval (2026-10-13, by the user): the plan resolves it.

- [x] How `auth` obtains the credential for its own invitation emails, given it is also
  the issuer (issue it internally, or call its own endpoint like any other client). Both
  satisfy AC-1.4; the choice is architectural. — owner: architect, at the plan stage.
  Resolved 2026-10-13 in the plan (§ Architecture 2, ADR-0048): `auth` issues it
  internally.
