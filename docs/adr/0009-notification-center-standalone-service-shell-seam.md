# 0009 — Notification center as a standalone JWKS resource service and federated remote, with a shell-owned bell/SSE/toast seam

**Date:** 2026-07-13  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

Spec `specs/005-notification-center` requires a suite-wide way for any Operai app to notify
its signed-in user — a persistent, reviewable notification center plus an immediate,
in-the-moment toast — and requires this to work "regardless of which suite app is currently
active" (US-1, AC-1.1). The spec's own Constraint is explicit that "the notification center is
a separate app, not code inside the shell": its own backend (persistence + SSE push) and its
own federated frontend remote, mounted the way `estimai-ui`/`refund-ui`/`admin-ui` already are
(ADR-0006). At the same time, the bell button, the unread badge, and toast pop-ups must be
visible and live on **every** route — including `/estimai/*`, `/refund/*`, `/admin/*` — even
though `notify-ui` (the remote that owns the actual center page) is only mounted on `/notify`.
This creates a genuine tension: the spec forbids notification *logic* from living in the
shell, but the bell/badge/toast must be observable everywhere, which only shell-owned chrome
can guarantee without depending on a specific remote being mounted.

Additionally, the spec's Non-goals record a deliberate seam: v1's raise-capability only ever
targets the calling user (`recipient` is implicitly the JWT `sub`), but the Refund app's
future cross-user approval flows (a submission notifying an approver, an approval/rejection
notifying the original submitter) are named as the explicit driver for extending this
capability later — and the spec requires that extension to be additive, not a redesign.

## Decision

We will build the notification center as **two new independently-deployed components** plus a
**minimal, transport-only seam inside the shell** — mirroring ADR-0006's host/remote split and
extending `shell/session` the same way it already carries `apiFetch`/`usePermissions`.

1. **`notify-api`** — a new Bun + Hono + Prisma resource server, structurally a clone of
   `estimai-api`: env-validated at startup, Prisma via `src/lib/db.ts`, RFC 7807 Problem JSON
   errors, `@hono/zod-openapi` + Scalar, and `jwtMiddleware` copied verbatim from
   `estimai-api/src/auth/jwt.middleware.ts` (ADR-0005). It owns all notification persistence,
   the raise/list/mark-read REST endpoints, the stream-ticket mint (ADR-0008), and the SSE
   stream itself. It has its own logical database (`notify`, on the shared Postgres instance)
   and deploys to Railway EU, independent of every other service.
2. **`notify-ui`** — a new federated remote, structurally a clone of `admin-ui`: exposes
   `./App`, consumes `shell/session` and `shell/tokens.css`, has no auth guard and no chrome of
   its own, and runs its own inner TanStack Router with `basepath '/notify'` (ADR-0006's
   established remote shape). It owns the notification-center **page** — the list, per-item
   detail, ordering, empty state, the "was-unread" affordance, link/action follow, and the
   explicit "mark all read" control. It deploys as its own Vercel project.
3. **A deliberately narrow shell-owned seam**, because three things must work regardless of
   which remote is mounted and cannot wait for `notify-ui` to load:
   - **`shell/src/components/Bell.tsx`** — an icon button in `Header.tsx` beside
     `ThemeToggle`, present on every route; shows the "9+"-capped unread badge; navigates to
     `/notify` on activation.
   - **The raise-capability seam in `shell/session`** (`shell/src/lib/notifications.ts`,
     exposed the same way `apiFetch` already is): `raiseNotification(input)`, the SSE
     connection manager (one `EventSource` per tab, authenticated per ADR-0008, opened lazily
     on first use), `useUnreadCount()`, `resetUnreadCount()`, and `getNotifyBaseUrl()`. This
     is transport and session glue only — no notification business logic (list ordering,
     read-state rules, empty-state copy) lives here; the shell renders exactly what
     `notify-api` decides via the pushed event payload (e.g. whether an event is
     toast-worthy is a server-decided flag the shell merely obeys).
   - **`shell/src/components/ToastHost.tsx`** — a chrome-level overlay mounted once in
     `ShellLayout.tsx`, subscribed to the SSE manager's toast stream, rendering over whichever
     remote is currently mounted.

   These three are the **only** shell-side additions (spec Constraint 4). `/notify` is added
   as an always-available catch-all route mounting `notify/App`, but deliberately **not**
   added to the permission-gated `TOOLS`/sidebar list (ADR-0007's app-access model) — every
   signed-in user has notifications regardless of which apps they can access, and the spec's
   non-goals explicitly forbid re-gating notification visibility by app-access.

4. **The raise-capability's request shape reserves an inert `recipient` field.** v1's
   `POST /notifications` request body has no `recipient` field at all in the wire contract
   that matters today (the server derives `recipientId` from the JWT `sub` unconditionally,
   ignoring anything else); the seam is designed so that adding an optional `recipient`
   (a `sub`, and later possibly a group) is purely additive — existing callers (EstimAI raising
   for itself) do not change, and a future Refund caller can pass a target `recipient` without
   any breaking change to `raiseNotification`'s signature or `notify-api`'s existing behaviour
   for callers that omit it. This is the concrete mechanism satisfying the spec's named
   forward-compatibility requirement for Refund's cross-user notifications.

## Options considered

### Option A — Standalone service + remote, with a narrow shell-owned transport seam (chosen)

Described above: `notify-api` + `notify-ui` as independent deployables; only the bell, the
raise-capability/SSE/toast transport glue, and the toast host live in the shell.

**Pros:**
- Matches the spec's hard constraint verbatim: notification business logic and persistence
  live in the new service/remote, not the shell — the shell stays a thin, reusable chrome
  layer exactly as ADR-0006 established
- The bell/badge/toast are guaranteed visible and live on every route without depending on
  `notify-ui` being mounted, satisfying AC-1.1/1.4/1.5/5.1 which explicitly require this to
  work "regardless of which suite app is currently active"
- `notify-api` and `notify-ui` deploy, version, and scale independently of the shell and of
  every other tool — consistent with ADR-0006's independent-deployability goal and with the
  precedent already set by `estimai-api`/`estimai-ui` and `admin-ui`
- The raise-capability's reserved, currently-inert `recipient` field means the Refund app's
  named future cross-user requirement is a additive extension, not a breaking redesign, of
  this feature's public contract

**Cons:**
- The federation graph gains a third dimension: the shell now also holds a **live SSE
  connection** and a **transient toast host**, not just a session cache — more shell-side
  runtime state than ADR-0006 originally introduced (which was JWT + permissions caching
  only)
- Drawing the line between "transport glue" (shell) and "notification logic" (notify-ui) is a
  judgment call that must be actively maintained — it would be easy, under future feature
  pressure, to let notification-specific business logic creep into `shell/session` (see
  Consequences)
- Two new deployables (a new Railway EU service, a new Vercel project, a new logical
  database) add operational surface: a new domain, new CSP/CORS entries, new environment
  variables across multiple services (spec 005 Risk R9)

### Option B — Notification center built entirely inside the shell (rejected)

Add the bell, the center page, and all persistence/SSE logic directly to the shell
application, with no new service and no new remote.

**Pros:**
- No new deployable, no new federation remote, no new CSP/CORS origin to add — the simplest
  possible topology
- The bell-everywhere requirement (AC-1.1) is trivially satisfied since everything already
  lives in the one thing that's always mounted

**Cons:**
- Directly violates the spec's explicit constraint that the notification center is "a
  separate app, not code inside the shell" — this option was foreclosed by the spec approval
  gate, not just architecturally disfavoured
- Couples the shell's release cadence to notification-feature changes, defeating the
  independent-deployability property ADR-0006 exists to provide; every notification schema or
  UI tweak would require a shell redeploy
- The shell would need its own Prisma/Postgres persistence layer and SSE push mechanism,
  duplicating infrastructure `estimai-api`/`notify-api`'s pattern already provides, rather
  than reusing it
- Rejected: forecloses by the spec constraint, and architecturally regresses the suite's
  established separation of concerns

### Option C — Notification center fully inside `notify-ui`, with no shell seam at all (rejected)

Have `notify-ui` own everything, including the bell button and toast rendering, injected into
the header only when `notify-ui` happens to be mounted.

**Pros:**
- Maximal separation: zero notification-specific code in the shell, cleanest possible reading
  of "the shell contributes only chrome"

**Cons:**
- Cannot satisfy AC-1.1/1.4/1.5 as written: the bell must be visible and live while the user
  is on `/estimai/*` or `/refund/*`, but `notify-ui` (the remote that would own the bell in
  this option) is only mounted on `/notify` — the bell would disappear the instant the user
  navigates to any other tool
- A toast raised while the user is inside EstimAI could not render at all, since nothing
  belonging to `notify-ui` would be present in the DOM outside of `/notify` — directly
  violates AC-5.1 ("a transient toast appears in the app the user is currently viewing")
- Rejected: architecturally cleaner in isolation, but fails multiple hard acceptance criteria
  that require suite-wide, remote-independent visibility

### Option D — Every app maintains its own local notification UI/polling, no shared service (rejected)

Each tool (EstimAI, Refund, Admin) implements its own ad hoc banner/polling mechanism, as
happens today per the spec's Problem statement.

**Pros:**
- No new service, no federation change, no shell change — zero incremental architecture

**Cons:**
- This is precisely the status quo the spec was written to replace: "every tool that wants to
  inform a user today has to invent its own ad hoc banner or has no mechanism at all"
- No durable cross-tool notification history, no consistent unread badge, no near-real-time
  delivery guarantee (AC-1.4/1.5) — none of the spec's user stories are met
- Rejected: does not satisfy the spec at all; recorded only for completeness

## Consequences

**Positive:**
- Any current or future Operai tool (EstimAI today; Refund, ReviewAI, RetroAI, ProposAI later)
  gets suite-wide notification capability by calling `raiseNotification()` — no tool builds
  its own storage, delivery, or UI for this
- The bell, unread badge, and toast host work identically regardless of which remote is
  mounted, because they are shell-chrome, not remote content — satisfying the spec's hardest
  cross-cutting requirement without duplicating chrome into every remote
- `notify-api` and `notify-ui` inherit the suite's established independent-deployability
  property (ADR-0006): either can ship without a shell or sibling-remote rebuild
- The reserved `recipient` field means Refund's already-named cross-user notification need is
  a forward-compatible, additive change to this feature's contract, not a future breaking
  change or a parallel mechanism

**Negative / trade-offs:**
- The shell now carries live, always-on runtime state (an open SSE connection, a toast queue)
  in addition to the session/permission caches ADR-0006 already introduced — more moving
  parts inside a component whose whole purpose was to stay a thin chrome layer
- The transport-glue-vs-business-logic boundary inside `shell/session` requires ongoing
  discipline: it would be easy, under time pressure, to let notification-specific rendering or
  business rules leak into shell code instead of `notify-ui`, quietly re-violating the spec's
  Constraint 4
- Two more independently deployed services (Railway EU app, Vercel project, logical database)
  mean two more sets of environment variables, CSP/CORS entries, and deploy pipelines to keep
  correctly wired across environments (spec 005 Risk R9)

**Risks:**
- **Scope creep into the shell.** Because the SSE manager and toast host already live in
  `shell/session`, future feature requests ("can the toast also show an inline action button
  with app-specific behavior?") will be tempting to implement there instead of in `notify-ui`.
  Mitigation: this ADR and the spec explicitly scope the shell to transport/chrome only; any
  notification behavior beyond "render what `notify-api` says, react to SSE events" belongs in
  `notify-ui` or `notify-api`.
- **`/notify` non-gating drift.** `/notify` is intentionally not permission-gated by
  ADR-0007's app-access model; a future contributor unfamiliar with this ADR could "fix" that
  inconsistency by mistake, breaking US-6 (every signed-in user has notifications regardless
  of app access). Mitigation: this ADR and the spec's Non-goals section both document the
  intentional divergence; the admin-only `tools.ts` catalog should carry a comment pointing
  here.
- **Recipient-seam misuse before Refund needs it.** An app could be tempted to try passing a
  `recipient` early, before the seam is actually implemented server-side, and silently have it
  ignored (v1 hard-ignores any client-sent recipient — see spec API contract). Mitigation:
  `notify-api`'s OpenAPI schema documents the field as reserved/no-op in v1; the Refund spec
  that eventually activates it must update this contract explicitly, not assume silent
  pass-through.
- **Shell SSE connection lifecycle bugs.** A connection leaked across sign-out, or not
  re-established after a user switch on the same device, would either leave a stale
  authenticated stream open or silently stop delivering notifications. Mitigation: the SSE
  manager is wired into the existing `signOut()` wrapper in `session.ts` (which already clears
  the JWT and permission caches), closing and re-establishing the connection on every
  identity change; covered by AC-6.3's test (integration + e2e).

## Compliance notes

- GDPR/nLPD impact: low-to-medium — notification bodies may reference client names or
  estimate identifiers (per the spec's data-residency note), so `notify-api`'s database and
  logs are treated with the same care as `estimai-api`'s: bodies persist only in the EU-hosted
  Postgres database, never in application logs (method + path + status only, mirroring
  `estimai-api`'s logger posture)
- Data residency: `notify-api` deploys to Railway EU (`europe-west4`), consistent with the
  suite's existing data-residency rule; `notify-ui` is purely client-side chrome and
  transmits no notification data except to `notify-api`
- Audit trail: not required for this decision; notification read/unread transitions are
  ordinary application state, not an authorization- or compliance-relevant audit event (unlike
  ADR-0007's `audit_log`, which remains the suite's only mandated audit trail)

This decision builds directly on ADR-0005 (JWT resource-server verification via remote
JWKS — `notify-api`'s REST endpoints reuse the pattern verbatim), ADR-0006 (Module
Federation — `notify-ui` is composed exactly like `estimai-ui`/`refund-ui`/`admin-ui`, and the
shell/session extension here follows the same `apiFetch`/`usePermissions` precedent), and
ADR-0008 (SSE stream authentication — the shell's connection manager is the client half of
that ticket-based handshake).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
