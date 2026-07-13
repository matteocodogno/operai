---
id: 005
slug: notification-center
status: in-progress
rigor: production
created: 2026-07-13
approved: 2026-07-13
---

# Notification center

## Problem

Operai is becoming a multi-tool suite (EstimAI, Refund, Admin) hosted inside a single
shell (specs/003), but neither the shell nor any tool has any way to tell a signed-in
user "something happened" beyond that tool's own screen, at the moment it happens.
Long-running or asynchronous outcomes — an export finishing, an estimate shared with
you, an admin granting or revoking your access, a refund request needing your approval
— currently have no place to land: a user who isn't looking at the right screen at the
right moment simply never learns about them. Every tool that wants to inform a user
today has to invent its own ad hoc banner or has no mechanism at all. As the suite
grows past EstimAI into Refund and Admin, and cross-tool events become common (an
Admin change affecting what a user can do in EstimAI, a Refund approval affecting a
different user), wellD needs one consistent, suite-wide way for any tool to notify a
user — both a durable, reviewable history and an immediate, in-the-moment alert —
instead of every app rolling its own mechanism or having none.

## Domain language

Terms used throughout (to be reused in the plan, APIs, and UI copy):

- **notification** — a single message raised by a suite app for a specific recipient;
  has a title, a body/detail, a severity/type, an origin app, a created time, and a
  read/unread state, and may optionally carry a link/action.
- **recipient** — the signed-in user a notification is for. In v1 the recipient is
  always the same user whose action in the origin app triggered the notification (see
  Non-goals — no other-user/department/broadcast targeting yet).
- **origin app** — the suite app (EstimAI, Refund, Admin, or a future tool) that raised
  the notification.
- **severity/type** — a classification of a notification (e.g. informational, success,
  warning, error) that lets the recipient judge importance at a glance.
- **notification bell** — the icon button in the shell header, beside the theme
  switcher, that surfaces the unread count and opens the notification center.
- **notification center** — the surface (panel or page) listing a recipient's
  notifications, their read/unread state, and any action to mark them read.
- **toast** — a transient, self-dismissing alert shown immediately in whichever app the
  user currently has open, for notifications flagged as time-sensitive. Every toast is
  additive to a persisted notification — there is no toast that exists only as a toast
  (see US-5, Non-goals).
- **unread / read** — a notification's state. A notification is unread until the
  recipient opens the notification center, at which point every currently-unread
  notification transitions to read (see US-3).

## User stories

### US-1: The notification bell shows what's waiting for me

As a signed-in user, I want a notification bell next to the theme switcher that shows
how many unread notifications I have, so that I know something needs my attention
without having to open the notification center to check.

**Acceptance criteria:**
- AC-1.1: Given the shell header, when it renders, then a notification bell icon
  button is displayed beside the existing theme toggle, present regardless of which
  suite app is currently active.
- AC-1.2: Given the user has one or more unread notifications, when the bell renders,
  then an unread-count indicator (badge) is visible on the bell reflecting the number
  of unread notifications.
- AC-1.3: Given the user has zero unread notifications, when the bell renders, then no
  unread badge is shown.
- AC-1.4: Given the user has the suite open, when a new notification is raised for
  them, then the bell's unread badge updates to reflect the new count within
  approximately 2 seconds, without the user performing a manual refresh.
- AC-1.5: Given the user has the suite open in more than one tab or device at the same
  time, when a new notification is raised for them, then the unread badge updates in
  each of those open tabs/devices within approximately 2 seconds — near-real-time
  delivery over the Server-Sent Events push transport (see Constraints), not dependent
  on any of them being reloaded.
- AC-1.6: Given the unread count is larger than can be legibly displayed on a small
  badge, when the badge renders, then it shows the exact count for 1 through 9, and
  "9+" for any count of 10 or more (see Constraints).

### US-2: Open the notification center to review my notifications

As a signed-in user, I want to open a notification center from the bell, so that I can
see the notifications I've received, in order, with enough detail to understand each
one.

**Acceptance criteria:**
- AC-2.1: Given a signed-in user, when they activate the bell, then the notification
  center opens and displays their notifications.
- AC-2.2: Given the notification center shows a notification, then that entry displays
  at minimum: its title/summary, its body/detail (or a preview of it), a timestamp, its
  read/unread visual state, its severity/type, and its origin app.
- AC-2.3: Given multiple notifications exist, when the notification center renders
  them, then they are ordered most-recent-first.
- AC-2.4: Given a user who has never received a notification, when they open the
  notification center, then a clear, explicit empty state is shown — not a blank area,
  not an error.
- AC-2.5: Given a notification that carries a link/action (per AC-4.3), when the user
  activates that notification's entry, then they are taken to the linked destination;
  the notification is already read at this point, having transitioned when the center
  was opened (per AC-3.1).

### US-3: Opening the center marks my notifications as read

As a signed-in user, I want opening the notification center to mark my currently-unread
notifications as read, so that my unread count reflects only genuinely new activity
without me having to act on each item individually.

**Acceptance criteria:**
- AC-3.1: Given the user has one or more unread notifications, when they open the
  notification center, then every notification unread at that moment transitions to
  read, and the bell's unread badge clears to zero immediately.
- AC-3.2: Given notifications that were unread at the moment the user navigated to the
  notification center, when they are displayed for the remainder of that single
  viewing session on the page, then they keep a distinguishing "was unread" visual
  affordance — conveyed by more than color alone — separate from the badge, so the
  user can still tell what was new versus what they had already seen before this
  navigation, even though none of it counts toward the unread badge anymore.
- AC-3.3: Given the user leaves the notification center and later returns to it — a
  fresh navigation to the page, or a reload of the suite — when notifications are
  displayed again, then no "was unread" affordance remains from the prior viewing
  session: every notification already marked read (per AC-3.1) is shown simply as
  read, and only notifications received since then appear unread. Each navigation to
  the notification center starts a fresh viewing session; there is no intermediate
  "closed but still open" state that could carry the affordance forward.
- AC-3.4: Given the notification center, when the user invokes an explicit "mark all as
  read" affordance, then it succeeds; because opening the center already marks
  everything read (AC-3.1), invoking it while nothing is unread is a harmless no-op —
  the affordance is kept for a user who wants to explicitly confirm/clear the "was
  unread" affordance from AC-3.2 without waiting for a fresh open/reload.

### US-4: Any suite app can raise a notification for its user

As an app author (EstimAI, Refund, Admin, or a future Operai tool), I want a
suite-wide capability to raise a notification for the signed-in user, so that my app
can inform its user of something relevant without building its own notification
storage or UI.

**Acceptance criteria:**
- AC-4.1: Given a signed-in user inside any suite app, when that app raises a
  notification, then the notification carries at minimum a title/summary and a
  body/detail, and it appears in that user's notification center. The recipient is
  always the same user whose action triggered the raise — the capability does not
  accept an explicit "who this is for" target in v1 (see Non-goals).
- AC-4.2: Given an app raises a notification, then the app can specify a severity/type
  (e.g. informational, success, warning, error), and that severity is visually
  distinguishable to the recipient in the notification center (per AC-2.2).
- AC-4.3: Given an app raises a notification, then the app can optionally attach a
  link/action (e.g. "open this estimate") that the recipient can follow directly from
  the notification (per AC-2.5).
- AC-4.4: Given an app raises a notification, then the notification's origin app is
  recorded and visible to the recipient in the center (per AC-2.2), so a user can tell
  which tool a notification came from.
- AC-4.5: Given an app attempts to raise a notification missing the minimum required
  content (no title, or no body), when the attempt is made, then it is rejected and
  reported back to the raising app, rather than silently producing a blank or
  incomplete entry in the recipient's center.

### US-5: Time-sensitive notifications surface immediately as a toast

As a signed-in user, I want certain notifications to appear immediately as a transient
toast in whatever app I currently have open, so that I notice time-sensitive
information right away instead of only discovering it later in the notification
center.

**Acceptance criteria:**
- AC-5.1: Given an app raises a notification and flags it as toast-worthy, when the
  user currently has the suite open, then a transient toast appears in the app the
  user is currently viewing, without the user having to open the notification center.
- AC-5.2: Given a toast is shown, when the user takes no action on it, then it
  disappears on its own after a short period, with no action required from the user.
- AC-5.3: Given a toast is shown, when the user dismisses it before it would
  auto-dismiss, then it disappears immediately and does not reappear.
- AC-5.4: Given a notification is flagged toast-worthy and a toast is shown for it,
  then the same notification is also retained in the notification center, in the same
  read/unread state it would have had without the toast — so a user who misses or
  dismisses the toast can still find it later. This is definitive for v1: the
  toast-worthy flag only ever decides whether a persisted notification *additionally*
  pops a transient toast; there is no toast-only notification that skips the
  notification center (see Non-goals).
- AC-5.5: Given an app raises a notification that is not flagged toast-worthy, when it
  is raised, then no toast appears for it anywhere in the suite — it lands in the
  notification center only, so routine/background notifications do not interrupt the
  user's current work.
- AC-5.6: Given a notification was raised while the user did not have the suite open,
  when the user later opens the suite, then no toast is shown for that
  already-past notification — toasts are shown only for notifications raised while the
  suite is live — but the notification is present, in its correct read/unread state,
  in the notification center.

### US-6: My notifications are mine, and they're still there next time

As a signed-in user, I want my notifications tied to my account and available whenever
and wherever I sign back in, so that reloading the page or switching devices doesn't
lose them, and no one else ever sees notifications meant for me.

**Acceptance criteria:**
- AC-6.1: Given a signed-in user has received notifications, when they reload the
  suite on the same device, or sign in on a different device, then their notification
  list and each notification's read/unread state are unchanged from before.
- AC-6.2: Given two different signed-in users, when each opens their own notification
  center, then neither sees any notification raised for the other — notifications are
  scoped strictly to their intended recipient.
- AC-6.3: Given a user signs out and a different user signs in on the same device,
  when the second user opens the notification center, then they see only their own
  notifications, never any left over from the first user's session.

## Non-goals

- **Designing the notification service's internals** — its exact data schema, API
  endpoints, SSE wiring, and the internal shape of its federated remote — is an
  architecture decision, not a product one (the confirmed high-level shape — a separate
  app with its own backend and its own remote, mounted like the other suite apps, using
  SSE — is recorded under Constraints; the detailed design is the plan's job).
- **Notification targeting beyond the current signed-in user (v1).** An app may only
  raise a notification for the user whose own action triggered it — there is no
  addressing a different named user, a department, or a broadcast to "everyone with
  access to app X" in this feature (AC-4.1). This is a deliberate seam, not an
  oversight: the Refund domain has inherently cross-user cases (an expense
  reimbursement submission needing a different user's approval, an approval/rejection
  needing to reach back to the original submitter) that will require notifying someone
  other than the acting user. That is explicitly future work for the Refund app's own
  spec, expected to extend this feature's raise-capability with a recipient/audience
  parameter rather than replace it.
- **Native OS/mobile push notifications and email digests.** v1 is in-suite only: the
  bell, the notification center, and in-app toasts. No notification leaves the browser
  tab.
- **Per-user notification preferences** — muting by type/app/severity, digest
  scheduling, channel choice. v1 has no preference model; every raised notification
  simply follows the rules in US-5.
- **Toast-only, non-persisted notifications.** Every notification always lands in the
  notification center; "toast-worthy" is strictly an additional, transient presentation
  of a persisted notification, never a substitute for it (AC-5.4).
- **Admin-authored broadcast/system-wide announcements** not triggered by a specific
  app event (e.g. "system maintenance tonight" composed directly by an admin). v1
  notifications are always raised by an app on behalf of an event.
- **Permanently deleting or dismissing notifications from history.** v1 only supports
  read/unread; dismissing a toast (AC-5.3) ends its transient on-screen display, it
  does not remove the underlying notification from the center.
- **Retention/archival policy or any cap on how long notifications are kept.** Not
  specified by this feature; no expiry is required.
- **Rate-limiting or anti-spam protection** against a misbehaving app raising excessive
  notifications for a user. An operational/abuse-prevention concern for the plan
  stage, not a product requirement captured here.
- **Re-gating notification visibility by current app-access permissions** (ADR-0007).
  A notification already delivered to a recipient is not retroactively hidden if that
  recipient later loses access to the origin app; notifications are scoped to their
  recipient only (AC-6.2), not re-checked against current permissions.
- **Any change to the shell's existing chrome** (logo, About control, avatar/menu,
  theme toggle, sidebar, footer) beyond adding the notification bell. Those remain
  exactly as specified in specs/003.

## Constraints

_Decisions confirmed by the user at the spec approval gate; recorded verbatim for the
plan, not elaborated here._

- **v1 audience is the current signed-in user only.** No other-recipient, department,
  or broadcast addressing (see Non-goals). The Refund app's cross-user approval flows
  are the explicit, named driver for extending this later — the raise-capability
  should be designed so that seam is easy to grow, not redesigned from scratch.
- **Every notification always persists to the notification center; toast is strictly
  additive.** There is no toast-only, ephemeral notification variant (AC-5.4, Non-goals).
- **Delivery is near-real-time.** New notifications must reach the bell/badge (and any
  toast) within approximately 2 seconds, across all of a signed-in user's
  simultaneously open tabs/devices, without a manual refresh (AC-1.4, AC-1.5). This
  confirms a backend exists that persists per-user notifications and pushes updates to
  connected clients, rather than the client polling on a long interval.
- **The notification center is a separate app, not code inside the shell.** It is a
  dedicated backend service (its own persistence + SSE stream) plus its own federated
  frontend remote, mounted by the shell like the other remotes (ADR-0006). The shell
  contributes only the bell button in its header plus the shared capability seam that
  lets any app raise a notification; the notification-center page and all notification
  logic live in the new remote/service. The exact schema, endpoints, SSE wiring, and MF
  remote shape are still the architect's to design.
- **The near-real-time push transport is Server-Sent Events** (not WebSocket).
- **The unread badge caps at "9+"** — it shows the exact count for 1 through 9, and
  "9+" for any count of 10 or more.

## Open questions

None — all resolved at the spec approval gate.
