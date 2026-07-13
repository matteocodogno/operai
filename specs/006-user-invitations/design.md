---
spec: 006
status: draft
---

# Design: User invitations, resend, and user deletion

Component library in use: **Tailwind CSS 4** utility classes driven by the shared
`shell/tokens.css` `@theme` block (DM Sans / DM Mono / Syne, dark-ink palette + light
override) — confirmed by reading `admin-ui/src/**` (every existing screen is hand-built
markup + Tailwind utilities + a handful of local, hand-rolled patterns; no Mantine/MUI/
shadcn/headless kit anywhere) and `specs/004-auth-roles-permissions/design.md`, which this
document treats as the binding precedent for admin-ui's conventions. This feature extends
admin-ui (Users section) exactly as `specs/004` shipped it, plus one screen that is **not**
admin-ui at all: the invite-landing page (`GET /invite`), a Hono-JSX hosted page in `auth`,
styled to match `auth/src/signin/signin.routes.ts`'s existing card/token/CSP conventions
(ADR-0002 precedent — auth already hosts one unauthenticated entry page).

Two reuse categories from `specs/004`'s design.md apply again here, plus one new one this
feature introduces:
- **Reuse (shared)** — the same component instance/module, imported unchanged
  (`ConfirmDeleteModal`'s existing export, `shell/session`'s `useSession`/`apiFetch`, …).
- **Reuse (ported pattern)** — a new file that closely copies an existing component's
  markup/props/a11y contract (unavoidable across the Module Federation boundary, ADR-0006,
  for anything living in `shell`/`estimai-ui`; **within** admin-ui itself, e.g. the
  invitations table copying the Users table's L/E/P/Err shape, "ported pattern" just means
  "same in-repo convention, new file for a new screen").
- **Reuse (extended)** — genuinely new here: an existing admin-ui component gains an
  optional prop so a second/third call site can use it with different copy, without forking
  the whole component. Used once in this feature (`ConfirmDeleteModal`'s `body` override,
  below) and called out explicitly because it changes an existing component's contract —
  frontend-dev must confirm the extension is backward-compatible with `RolesPage`/
  `RoleEditor`/`DepartmentsPage`'s existing callers (default `body` = today's literal text).

---

## Flows

Each flow lists entry → steps → success/error exits, with US/AC references.

### F1 — Admin invites a new person (US-1: AC-1.1–1.8, AC-1.14)
Entry: **Screen U1 (Users list)** → "+ Invite user".
1. **Modal N1 (Invite user)** opens: Email (required, `type="email"`), "Roles" checkbox
   fieldset (optional, ported from `UserDetail.tsx`'s "Direct roles" fieldset), "Departments"
   checkbox fieldset (optional, ported from the same screen's "Departments" fieldset) — both
   fieldsets pre-populated from the same `adminApi.listRoles()`/`listDepartments()` catalogs
   Screen U1 already needs for its own use elsewhere in admin-ui (AC-1.1: roles/departments
   are optional, stored on the invitation, not applied to anyone yet).
2. Client-side validation: email required + basic format check (`type="email"` +
   `pattern`/`required`) before the request is even sent — never a network round-trip for an
   empty or obviously malformed address.
3. Submit → `POST /admin/invitations {email, roleIds, departmentIds}`.
   - **201, `emailDelivery:"sent"`** → modal closes; Screen U1's Invitations tab (see F1a)
     shows the new `pending` row; a brief inline confirmation ("Invitation sent to
     alice@welld.ch") is announced via the existing `aria-live="polite"` convention (mirrors
     `Pagination`'s status-announcement pattern) rather than a toast that could be missed.
   - **201, `emailDelivery:"failed"`** (Resend/network failure — plan.md "Resend + i18n +
     failure") → modal ALSO closes (the invitation itself was created successfully — this is
     not a form error) but the new row in the Invitations list carries a persistent, inline
     "Email failed" indicator next to its Resend action (see Screen U2) — never a toast that
     could vanish before the admin notices (AC-1.2's "an email is sent" partially failed and
     must stay discoverable until acted on).
   - **409, active user exists (AC-1.3)** → inline field error under Email: "This email
     already belongs to an existing user — use their user page to change roles or
     departments instead," modal stays open, email field keeps focus. No user-detail deep
     link (the response contract, plan.md, does not return a target user id — see Gaps #1).
   - **409, live pending invitation exists (AC-1.4)** → inline field error under Email:
     "An invitation is already pending for this email — resend it from the Invitations tab
     instead of creating a new one," modal stays open. No deep link, same reason as above.
   - **422, unknown role/department id** (stale catalog — defensive; the UI only ever offers
     ids from a freshly-loaded catalog, so this should be unreachable in practice) → a
     general error banner inside the modal (mirrors `CreateRoleModal`'s `generalError`
     convention), modal stays open, selections preserved.
4. Re-submitting for the same email after a `revoked`/`expired` invitation (AC-1.5) or a
   soft-deleted user's email (AC-1.14) is not a special case in the UI at all — the modal has
   no memory of prior invitations; the 409s above only fire for a genuinely live blocker.

### F1a — Admin manages the Invitations list: resend / revoke (US-3: AC-3.1–3.6; US-1's
revoke: AC-1.9–1.13; US-4's display: AC-4.2, AC-4.4)
Entry: **Screen U1 (Users list)** → "Invitations" tab → **Screen U2 (Invitations list)**.
1. Paginated, searchable (`?q=` on email, same input pattern as the Users list) table with a
   status filter (All / Pending / Accepted / Expired / Revoked — `GET
   /admin/invitations?status=`, effective status per plan.md). Each row shows email, state
   (see `InvitationStatusBadge`), assigned roles/departments (AC-1.6 — "visible on it"),
   inviter, and expiry.
2. **Resend** (pending/expired only, AC-3.4 hides it entirely for accepted/revoked — see
   Screen U2 below for why omission over disabled-and-explained is the right call here) →
   `POST /admin/invitations/{id}/resend` → row updates in place: new expiry, `pending` state,
   button shows "Resending…" while in flight, then a `aria-live="polite"` confirmation ("New
   link sent to alice@welld.ch, expires in 72 hours"). No confirmation dialog — resend isn't
   destructive (AC-3.3's old-link invalidation is a side effect the admin already intends by
   clicking Resend, not a separate consequential choice requiring interruption).
   - Error (network/5xx) → inline row-level error text below the row, button re-enabled.
3. **Revoke** (pending/expired only) → **Dialog N2 (destructive confirm, extended
   `ConfirmDeleteModal`)** with revoke-specific body copy ("Revoke the invitation to
   alice@welld.ch? Its link stops working immediately. This can't be undone — inviting them
   again requires sending a brand-new invitation.") → confirm → `POST
   /admin/invitations/{id}/revoke` → row updates to `revoked` in place, Resend/Revoke actions
   disappear from that row (AC-1.10/1.11 — terminal).
   - Error 422 (AC-1.10/1.11's race — invitation became accepted/revoked between page-load and
     click) → inline error inside the dialog (mirrors `ConfirmDeleteModal`'s existing
     `errorMessage` slot), dialog stays open so the admin sees why the action didn't apply,
     "Cancel" closes it back to the (now-refreshed) row.
4. Accepted/revoked rows show state + timestamp only, no actions — never a disabled button
   needing a tooltip, because there is genuinely nothing left to do (mirrors `AuditPage`'s
   "immutability enforced by omission, not a disabled control" reasoning).

### F2 — Invitation acceptance becomes visible in admin-ui (US-2: AC-2.6)
No dedicated screen — this is a cross-reference, not new UI. Once an invitee accepts
(entirely outside admin-ui, at `GET /invite` + OAuth — see F4 below), the next time an admin
loads Screen U2 the email is gone from the `pending` filter and gone from the Invitations tab
entirely under its own row (it now shows `accepted`, keeps read-only history); the next load
of Screen U1's Active-users tab shows them as a real user with exactly the invitation's
assigned roles/departments already applied (AC-2.3) — no separate admin action needed. This
flow exists purely so AC-2.6 has an explicit trace in this document; there is no new
component or interaction here.

### F3 — Admin deletes a single user (US-5: AC-5.1–5.10)
Entry: **Screen U1 (Users list)** row action, or **Screen U3 (User detail)** header button.
1. Every row except the caller's own carries a "Delete" action (Screen U1) / every detail page
   except the caller's own carries a "Delete user" button (Screen U3). The caller's own row/
   page instead shows the same button **disabled**, with `title`/`aria-disabled` +
   visually-hidden explanatory text — see Screen U1/U3 below for why this is a deliberate
   refinement over the plan's literal "omits delete" wording (AC-5.6).
2. Click → **Dialog N2** with single-user body copy ("Delete alice@welld.ch? They will
   immediately lose all access to Operai — every active session ends and they can no longer
   sign in. Their record and data are retained for audit, but there is no undo: regaining
   access requires a brand-new invitation.") — deliberately NOT the shared "permanently
   deleted, cannot be undone" wording `ConfirmDeleteModal` uses for role/department delete,
   since this is a soft delete (AC-5.4) and that copy would misstate what actually happens.
3. Confirm → `DELETE /admin/users/{id}` → **200** → the row disappears from Screen U1's list
   (re-fetch; AC-5.3) or, from Screen U3, navigate back to Screen U1 (mirrors `RoleEditor`'s
   delete-then-navigate-to-list pattern).
   - **422, self-delete (AC-5.6)** — should be unreachable via the UI (the button is disabled
     for the caller's own row/page), but if the underlying API is hit directly or the UI state
     is stale, the dialog surfaces the server's `422` inline exactly like the guardrail path
     below rather than assuming it can't happen.
   - **422, last-admin guard (AC-5.5)** — reuses the exact `GuardrailDialog` pattern/copy
     style already established for role/department last-admin blocks (`UserDetail.tsx`'s
     `LAST_ADMIN_MESSAGE`), adapted to deletion: "This is the last administrator — deleting
     this user would leave nobody able to manage access. Assign another admin first." Shown
     via `GuardrailDialog` (reused unchanged) in place of Dialog N2's own inline error, since
     this is the same "genuinely blocked, nothing to retry" shape `GuardrailDialog` already
     models for AC-6.4 in specs/004.

### F4 — Admin bulk-deletes users (US-6: AC-6.1–6.5)
Entry: **Screen U1 (Users list)** → select ≥1 row via the new checkbox column → the
**bulk action bar** appears.
1. Each row (except the caller's own — see F3's disabled-checkbox note in Screen U1) gets a
   checkbox; the header cell gets a "select all on this page" checkbox with a true
   indeterminate state when some-but-not-all rows on the page are checked. Selection persists
   only within the current page (no cross-page selection state — this feature's ACs describe
   "the Users list," not a cross-page batch, and cross-page selection carries its own set of
   surprises, e.g. "select all" meaning different things across a paginated result, that no
   AC asks this design to solve).
2. Bulk action bar (`role="region" aria-label="Bulk actions"`, `aria-live="polite"` announcing
   the live count — "3 users selected") shows "Delete selected (3)".
3. Click → **Dialog N2** with bulk body copy: "Delete 3 selected users? [scrollable list of
   the 3 emails]. Anyone in this selection who is the last remaining administrator, or your
   own account, is automatically skipped — everyone else in the batch is still deleted."
   Naming the count up front (AC-5.7's "distinct confirmation step") and pre-warning about the
   skip behavior (AC-6.2/6.3) so the partial-success result in the next step is never a
   surprise.
4. Confirm → `POST /admin/users/delete {userIds}` → **200** `{deleted, skipped[{userId,
   reason}]}` → **Panel N3 (bulk delete result)** renders above the table, persistent (not a
   toast — AC-6.3: "never a silent partial result indistinguishable from full success"):
   "Deleted 2 of 3 users." + a `<ul>` — one `<li>` per skipped user, its email and exact
   reason ("skipped: last remaining admin" / "skipped: cannot delete your own account" —
   copy sourced from the response, not re-derived client-side, so the two stay in lock-step).
   The list re-fetches underneath (deleted rows gone, AC-5.3); Panel N3 stays visible until
   the admin dismisses it or navigates away — it never auto-dismisses, since a vanished
   partial-success report is exactly the AC-6.3 failure mode this exists to prevent.
   - Note: the acting admin's own id can never appear in `userIds` in practice, since its
     checkbox is disabled client-side (F3) — the "skipped: cannot delete your own account"
     reason is designed for defense-in-depth (a stale selection re-submitted, or the API
     called directly), not the everyday path.

### F5 — Invitee follows the invite link (US-2: AC-2.1–2.5)
Entry: the invite email's link → **Screen I1 (Invite landing page)**, hosted by `auth`, NOT
admin-ui — this flow happens entirely pre-authentication, outside the suite shell.
1. `GET /invite?id&token` renders one of five states (mirrors `GET /invite/state`'s
   `state` field from plan.md's API contract):
   - **`pending` (valid, live)** → "You've been invited to Operai" + the invitation's email
     shown verbatim ("This invitation was sent to **alice@welld.ch** — continue with a Google
     or GitHub account using that same address.") + the two provider buttons, ported
     verbatim from `auth/src/signin/signin.routes.ts`'s existing card/button/CSP pattern,
     wired to the same `POST /auth/sign-in/social` call with a `callbackURL` back to
     `UI_HOME_URL` (AC-2.2 — "the existing OAuth sign-in flow, no new mechanism"). Showing the
     expected email up front is this design's one addition beyond the bare minimum the ACs
     require — it is the only mitigation available for the mismatch case flagged in Gaps #2
     below, since no AC specifies a post-sign-in mismatch warning and the plan wires no
     callback state for it.
   - **`expired`** → "This invitation has expired" + a line explaining what to do ("Ask your
     admin to resend it").
   - **`revoked`** → "This invitation is no longer valid" (deliberately vaguer than
     "expired" — AC-2.5 says "with the specific reason where it is safe to disclose"; telling
     an anonymous link-holder their invite was actively revoked, versus merely timed out,
     discloses an admin's decision that a generic "no longer valid" doesn't. Flagged as a
     copy judgment call for QE/PO to confirm, not a deviation from AC-2.5's wording — "no
     longer valid" IS the AC's own literal phrase for this family of states).
   - **`accepted`** → "This invitation has already been used" (distinct copy from
     `expired`/`revoked` per AC-2.5's own example: "expired" vs "already used").
   - **`invalid`** (bad id/token, including a stale pre-resend token per AC-3.3) → the same
     "This invitation is no longer valid" copy as `revoked` — no enumeration signal
     distinguishing "wrong token" from "revoked" from "doesn't exist" (plan.md: "no
     enumeration beyond holder-of-link").
2. Every non-`pending` state renders its message inside a `role="alert"` region with the
   heading receiving focus on mount (same technique `PermissionDenied.tsx` already uses for
   admin-ui's own "nothing to show" states) so a screen-reader user lands directly on the
   explanation rather than having to discover it.
3. After OAuth completes with the SAME email (AC-2.3): no further UI on this page — the
   provider redirect takes the invitee straight into the app (`UI_HOME_URL`) already holding
   the assigned access; there is nothing left for `GET /invite` itself to show, since the
   accept happens inside the `user.create.after` hook, not on this page.
4. After OAuth completes with a DIFFERENT email (AC-2.4): also no further UI on this specific
   page — the person is simply signed in as themselves, under their own identity, and lands
   in the app normally. See Gaps #2 for why this case has no error surface anywhere.

---

## Screens & states

Legend: **L**oading, **E**mpty, **P**opulated, **Err**or (RFC 7807), **G**uardrail-blocked.

### Screen U1 — Users list (MODIFIED — existing `admin-ui/src/pages/UsersPage.tsx`)
- **Purpose:** browse active users; entry point to invite, delete (single/bulk), and switch
  to the Invitations tab.
- **New key elements** (existing search/table/pagination unchanged):
  - **UsersSubNav** — a two-item tab strip ("Active users" | "Invitations") above the
    existing search input, real `<a>`s via `<Link>` with `aria-current="page"` on the active
    tab (ported convention from `SectionNav.tsx`, scoped to a `<nav aria-label="Users
    section views">` — a different landmark label from both `SectionNav`'s "Admin sections"
    and the shell's own "Tool navigation," same reasoning `SectionNav`'s own doc comment
    gives for why two differently-labelled nav landmarks at different levels isn't a
    duplicate-landmark problem).
  - **"+ Invite user"** button next to the existing heading (same placement/style as
    `RolesPage`'s "+ New role").
  - **Checkbox column** (leftmost): a header "select all on this page" checkbox (indeterminate
    when partially selected) + one checkbox per row, `aria-label="Select {name or email}"`.
    The caller's own row's checkbox is **disabled** (see below) — it can never be selected,
    so it can never need the server's defense-in-depth skip either.
  - **Delete action per row**, disabled for the caller's own row. Distinguishing "self" is a
    plain client-side comparison against `shell/session`'s existing `useSession()` (already
    federated, Reuse (shared) — no new endpoint needed) — `session.user.id === row.id`.
    Deliberately **disabled-with-explanation** (`aria-disabled="true"` + `title="You can't
    delete your own account"` + visually-hidden text), NOT omitted, even though the plan's
    architecture notes say "the caller's own row omits delete" — this is a refinement, not a
    contradiction: `RolesPage`'s System-role Delete button already establishes exactly this
    convention ("disabled + explained" for an action that's sometimes possible, just not for
    this particular row) and is more accessible than silent omission, which would leave a
    keyboard/screen-reader user with no explanation for why one row's row-actions column
    looks shorter than every other row's. `AuditPage`'s omission-not-disabled convention is
    the wrong analogy here — that's for an action that's NEVER possible on that screen at
    all (delete is genuinely impossible for every OTHER row's delete-ability, self-delete is
    the one row where it's impossible).
  - **Bulk action bar** — appears only once ≥1 row is checked, described in F4.
- **L/E/P/Err:** unchanged from the existing screen.

### Screen U2 — Invitations list (NEW — `admin-ui/src/pages/InvitationsPage.tsx`, route
`/users/invitations`)
- **Purpose:** browse/manage invitations by state (AC-1.6); resend/revoke.
- **Routing note:** registered as a flat sibling of `usersRoute`/`userDetailRoute` in
  `router.tsx` (same flat-children shape every other route already uses) — `/users/
  invitations` as a literal path segment and `/users/$id` as a dynamic one are both
  registered under the same parent, so TanStack Router must resolve the static segment in
  preference to the dynamic one (standard router precedence, same as every other router
  family) — flag for frontend-dev to add a `router.test.tsx` case asserting `/users/
  invitations` does NOT match `userDetailRoute` with `id="invitations"`, since that would be
  a silent, easy-to-miss regression if route registration order ever changes.
- **Key elements:** UsersSubNav (shared with Screen U1, "Invitations" tab active), search
  input (`?q=` on email, same pattern as Screen U1), a status `<select>` filter (All /
  Pending / Accepted / Expired / Revoked), paginated table:
  - Email
  - **State** — `InvitationStatusBadge` (see Component inventory), never color-only.
  - Roles / Departments assigned — comma-joined names, or "— none —" (AC-1.1's "may be
    created with no roles/departments"); plain text, no new chip component (keeps this
    screen's visual weight proportionate — these are read-only labels, not interactive
    filters).
  - Invited by (inviter's name/email — AC-1.7).
  - Expires — relative + absolute, e.g. "Expires in 18h (16 Jul, 14:32)" for `pending`;
    "Expired 3h ago" for `expired`; "Accepted 16 Jul, 09:12" for `accepted`; "Revoked 15 Jul,
    09:40" for `revoked` — never a bare countdown number alone (AC-4.2's "not silently
    indistinguishable from pending" is satisfied by both the badge AND this column
    independently restating the state in words).
  - Actions — Resend + Revoke for `pending`/`expired` rows only; nothing for `accepted`/
    `revoked` rows (see F1a step 4's reasoning).
- **L:** `SkeletonListRows` (reused unchanged).
- **E:** "No invitations yet." + the same "+ Invite user" affordance repeated here (never a
  dead end, mirrors `RolesPage`'s empty-state convention) — distinct copy from a
  search/filter-scoped empty result ("No invitations match your search/filter.").
- **P:** table + Pagination (reused unchanged component).
- **Err:** `ErrorBanner` + Retry (reused unchanged).

### Modal N1 — Invite user (NEW — `admin-ui/src/components/InviteUserModal.tsx`)
- Structurally: `CreateRoleModal`'s dialog shell (backdrop, `role="dialog"` — not
  `alertdialog`, since inviting isn't destructive — header/`<form>`/footer, Escape=Cancel,
  Tab-trap, default focus on Email) **plus** the two checkbox fieldsets ported from
  `UserDetail.tsx`'s "Direct roles"/"Departments" sections (same `<fieldset><legend>` +
  per-option `<label><input type="checkbox">` shape — reused as a *pattern*, not a shared
  component, matching how `UserDetail.tsx` itself already renders the same shape twice
  inline rather than through an extracted subcomponent; frontend-dev may choose to extract a
  shared `RoleDepartmentFieldset` once it exists in three render sites instead of two, but
  that is an implementation-efficiency call, not a UX requirement this document imposes).
- Submit disabled until the email field has a non-empty, well-formed value (roles/departments
  are always optional — AC-1.1).
- Field-level error region under Email (`aria-invalid` + `aria-describedby`, mirrors
  `CreateRoleModal`'s `nameError` pattern) carries both client-side format errors and the
  409s from F1 above — one error slot, not two competing ones.

### Dialog N2 — Destructive confirm (Reuse, extended — `ConfirmDeleteModal` gains an
optional `body` prop)
- `ConfirmDeleteModal` currently hardcodes its body paragraph
  ("`&lsquo;{displayName}&rsquo; will be permanently deleted. This cannot be undone.`") —
  accurate for a hard role/department delete, but wrong on two counts for every consumer this
  feature adds: (a) user deletion is a **soft** delete (AC-5.4 — data retained, only access is
  cut), and (b) bulk deletion needs to name a **count and a list**, not one item's name. This
  design adds one optional prop, `body?: ReactNode`, defaulting to today's exact literal text
  when omitted — so `RolesPage`/`RoleEditor`/`DepartmentsPage`'s existing call sites are
  byte-for-byte unaffected — and every new call site in this feature (single-user delete,
  bulk delete, invitation revoke) supplies its own accurate copy (F1a/F3/F4 above). Everything
  else about the component — `role="alertdialog"`, focus trap, Cancel-default-focus,
  Escape=Cancel, idle/deleting/error states — is unchanged and reused exactly as-is.
- **Minor a11y debt inherited, not introduced, by reuse — worth fixing while this file is
  already being touched:** the existing "Deleting…" spinner uses a bare `animate-spin` with no
  `motion-reduce:` guard. Since this prop addition already requires editing
  `ConfirmDeleteModal.tsx`, this is the natural moment to add `motion-reduce:animate-none`
  (the same posture `shell/src/components/ToastHost.tsx` already documents and applies
  elsewhere in the suite) rather than letting three new call sites (this feature) inherit a
  motion-sensitivity gap that predates this feature.

### Panel N3 — Bulk delete result (NEW — no precedent in-repo)
- Renders directly above Screen U1's table after a bulk-delete response, persists until
  dismissed (no auto-timeout — this is the opposite of a toast, deliberately, per AC-6.3).
  `role="status"` (polite — the admin caused this, it isn't an unprompted interruption) with a
  heading ("Bulk delete result") and two parts:
  - A one-line summary ("Deleted 2 of 3 selected users.").
  - A `<ul>` of skipped users only (not a redundant re-listing of the successes) — one `<li>`
    per skip, its email + the server's own reason string verbatim, so the UI never
    paraphrases or drifts from what the API actually decided. Genuinely new: nothing in-repo
    persists a multi-item *action result* the way `AuditPage`'s table persists *history* —
    those are different jobs (one is "what did I just do and what got skipped," the other is
    "what happened historically, read-only").
  - A dismiss "×" (`aria-label="Dismiss"`, mirrors `ErrorBanner`'s existing dismiss
    affordance) — the ONLY way this panel disappears before the admin navigates away.

### Screen U3 — User detail (MODIFIED — existing `admin-ui/src/pages/UserDetail.tsx`)
- Gains a "Delete user" button in the header area, same disabled-for-self treatment as Screen
  U1's row action (same `useSession()` comparison, same `aria-disabled`+`title`+sr-only-text
  convention — one rule, applied consistently in both places it appears). Confirms via Dialog
  N2's single-user copy; on success, navigates to Screen U1 (mirrors `RoleEditor`'s existing
  delete-then-navigate pattern for role deletion).

### InvitationStatusBadge (NEW, small — `admin-ui/src/components/InvitationStatusBadge.tsx`)
- Four variants (pending/accepted/expired/revoked), each glyph + text + color — never color
  alone — same convention `SystemBadge`/`WarningBadge` already establish in this repo
  (`SystemBadge`'s doc comment: "colour is never the only signal"). Suggested glyphs: ⏳
  Pending (`--acc`), ✓ Accepted (`--grn`), ⌛ Expired (`--org`, same amber as every other
  "needs attention" signal in admin-ui), ⊘ Revoked (`--red`).

### Screen I1 — Invite landing page (NEW — `auth/src/invite/`, hosted, unauthenticated,
NOT admin-ui)
- Described in full in F5 above. Visually: same card-on-dark-ink layout, `--acc`-accented
  provider buttons, and per-request-nonce CSP as `auth/src/signin/signin.routes.ts` — this is
  a sibling hosted page, not a new visual language (ADR-0002's precedent: "auth hosts
  unauthenticated entry pages"). Bilingual (IT+EN) copy is required here (AC-2.1's
  constraint carries over structurally to this page's own text, even though AC-2.1 is
  literally about the email) **only in the sense that an anonymous invitee has no known
  locale preference the same way the email doesn't** — flagged as a design decision for
  PO/architect to confirm scope on, since no AC explicitly requires the LANDING PAGE itself
  (as opposed to the email) to be bilingual; this design recommends mirroring the email's
  "single bilingual message" approach for consistency, but does not treat it as AC-locked the
  way the email text is.

---

## Component inventory

| Element | Reuse / NEW | Source pattern (path) |
|---|---|---|
| UsersSubNav (Active users / Invitations tabs) | **NEW**, small | Ported convention from `SectionNav.tsx` (real `<a>`/`<Link>`, `aria-current`, own `<nav aria-label>`) |
| Screen U1 checkbox column + header select-all | **NEW** | No multi-row-select precedent anywhere in the repo — genuinely new interaction |
| Bulk action bar | **NEW** | No precedent; smallest reasonable shape (`role="region"`, live count, one button) |
| Screen U1 per-row Delete / Screen U3 Delete button, disabled-for-self | **NEW**, small | Ported convention from `RolesPage.tsx`'s System-role disabled-Delete-button (`aria-disabled` + `title` + sr-only text) |
| Caller-identity check (self-row/self-page) | **Reuse (shared)** | `shell/session`'s `useSession()` — already federated, no new endpoint |
| Screen U2 (Invitations list) | **NEW** | Ported L/E/P/Err + table-with-`<th scope="col">` shape from `UsersPage.tsx`/`AuditPage.tsx`; status filter `<select>` is new but trivial (same shape as `UserDetail.tsx`'s entity select) |
| `/users/invitations` route | **NEW**, structural | Flat sibling registration in `router.tsx`, same shape as every existing route; static-vs-dynamic-segment precedence flagged in Screen U2 |
| InvitationStatusBadge | **NEW**, small | Glyph+text+color convention ported from `SystemBadge.tsx` |
| Modal N1 (Invite user) | **NEW** | Dialog shell ported from `CreateRoleModal.tsx`; roles/departments fieldsets ported from `UserDetail.tsx`'s existing inline checkbox fieldsets |
| Resend action (per invitation row) | **NEW**, small | In-flight/disabled-button convention ported from `DepartmentDetail.tsx`'s per-member Remove button ("Removing…" while in flight) |
| Dialog N2 (destructive confirm) | **Reuse (extended)** | `ConfirmDeleteModal.tsx` — adds an optional `body` prop (default preserves every existing caller's exact copy); reused 3× in this feature (user delete, bulk delete, invitation revoke) with feature-specific copy each time |
| GuardrailDialog (last-admin block on delete) | **Reuse (shared)**, unchanged | `GuardrailDialog.tsx` — same acknowledge-only shape already used for the AC-6.4 last-admin block on role/department edits |
| Panel N3 (bulk delete result) | **NEW** | No precedent — `AuditPage`'s table is read-only history, not an action-result report; dismiss affordance ported from `ErrorBanner.tsx`'s existing "×" |
| `ErrorBanner` / `SkeletonListRows` / `Pagination` (Screen U2) | **Reuse (shared)**, unchanged | Already-shared admin-ui components |
| Screen I1 (Invite landing page) | **NEW**, hosted in `auth` | Card/token/CSP/provider-button shell ported from `auth/src/signin/signin.routes.ts` (ADR-0002 precedent: auth already hosts one unauthenticated entry page) |

**Ratio:** ~6 pieces reused unchanged or via a small, backward-compatible extension
(`ConfirmDeleteModal` extended, `GuardrailDialog`/`ErrorBanner`/`SkeletonListRows`/
`Pagination` reused verbatim, `useSession` reused verbatim) : **~10 NEW files/elements**
(UsersSubNav, checkbox column, bulk action bar, disabled-self-delete convention,
`InvitationsPage`, the new route, `InvitationStatusBadge`, `InviteUserModal`, the Resend
action, `BulkDeleteResultPanel`, plus Screen I1 in a different service entirely). This is a
lower NEW-heavy ratio than specs/004's ~9:20 (that feature stood up a brand-new remote from
nothing; this one extends an already-conventioned Users section), and every NEW entry above
cites the in-repo pattern it borrows its shape from rather than inventing a new visual
idiom.

---

## Accessibility

- **Invite form (Modal N1):** every field has an explicit `<label htmlFor>` (Email) or
  `<fieldset><legend>` (Roles, Departments) — no placeholder-as-label. The Email field's
  error region is wired via `aria-invalid`/`aria-describedby` exactly like
  `CreateRoleModal.tsx`'s existing `nameError` contract, so a client-side format error and a
  server 409 both land in the same, already-associated slot. Submit stays disabled (not
  hidden) until the email is non-empty and well-formed, so a screen-reader user tabbing to it
  gets a consistent, explorable control rather than one that appears/disappears.
- **Invitations table (Screen U2) states, not color alone:** `InvitationStatusBadge` pairs a
  glyph with text; the Expires column independently restates the state in words per row
  (never relying on the badge's color to be the sole distinguishing signal — mirrors the
  existing `SystemBadge`/`WarningBadge` convention already established for exactly this
  reason). Every per-row action button carries a full, disambiguating accessible name —
  `aria-label="Resend invitation to alice@welld.ch"` / `"Revoke invitation to
  alice@welld.ch"` — since a screen-reader user navigating a list of "Resend"/"Revoke"
  buttons by role, out of table context, needs the row's identity restated on the control
  itself, not just visually adjacent to it.
- **Bulk-select (Screen U1):** each row checkbox has `aria-label="Select {name or email}"`;
  the header checkbox is a true tri-state control (`indeterminate` DOM property set
  imperatively, since HTML has no declarative `aria-checked="mixed"` equivalent for a native
  checkbox's indeterminate visual — the accessible name still announces "Select all," and the
  indeterminate state is exposed to AT via the checkbox's own `indeterminate` property, which
  most screen readers surface as "partially checked"). The bulk action bar is a
  `role="region" aria-label="Bulk actions"` landmark with an `aria-live="polite"` count
  (mirrors `Pagination`'s existing live-region convention for "Showing X–Y of N") so the
  count updates are announced as selections change, not just visually.
- **Bulk-delete partial-success result (Panel N3):** a persistent `role="status"` region, not
  a toast — critical per AC-6.3's "never a silent partial result indistinguishable from full
  success." Skipped users render as a real `<ul>`/`<li>` list (one item, one reason, per
  entry) so AT users can navigate the report item-by-item instead of having a single run-on
  paragraph read to them. It only disappears on an explicit dismiss click, never a timeout.
- **Confirm/guardrail dialogs (Dialog N2, `GuardrailDialog`):** unchanged `role="alertdialog"`
  contract from specs/004 — full Tab focus trap, Escape triggers the safe action, default
  focus on Cancel/OK, backdrop click matches Escape. The `body`-override extension changes
  only the copy inside `aria-describedby`, never the dialog's structure or keyboard contract.
- **Reduced motion:** `ConfirmDeleteModal`'s spinner gains `motion-reduce:animate-none`
  while this feature already touches the file (see Dialog N2 above) — the one motion-bearing
  element this feature's new call sites exercise.
- **Invite landing page (Screen I1, auth-hosted):** every error state (`expired`/`revoked`/
  `accepted`/`invalid`) renders inside a `role="alert"` region with the heading receiving
  focus on mount (same technique `admin-ui`'s `PermissionDenied.tsx` already uses) so a
  screen-reader user lands on the explanation immediately, without depending on visual
  scanning of an unfamiliar, pre-authentication page. The `pending` state's provider buttons
  are real `<button>`s, matching `signin.routes.ts`'s existing pattern exactly (no new
  interaction model introduced for OAuth on this page).

---

## Gaps, scope notes & drift (report to PO/architect — not designed around)

1. **409 error responses (AC-1.3/AC-1.4) carry no target id to deep-link to.** Plan.md's
   `POST /admin/invitations` contract documents `409` with a `detail` string but no
   structured field identifying the conflicting user/invitation id, so Modal N1's inline
   error text can only describe the conflict in words ("use their user page instead" /
   "resend it from the Invitations tab instead") — it cannot jump the admin straight to the
   conflicting record. Low-cost enhancement if the architect wants to add a `conflictId`
   (or similar) to the 409 Problem body; not designed around here since it's not in the
   plan's contract.
2. **No UI surface exists — and, per the plan's own callback mechanics, none CAN exist — for
   AC-2.4's "wrong account" case** (an invitee follows the invite link but completes OAuth
   under a different email). The plan's `user.create.after`/`session.create.before` hooks
   apply access purely via a verified-email match with no invitation-context carried through
   the OAuth callback, so there is no observable moment at which the app could say "you
   signed in with the wrong account for this invitation." This design's only mitigation is
   showing the *expected* email on Screen I1 BEFORE sign-in (F5 step 1), which reduces but
   cannot eliminate the case where an invitee has multiple Google/GitHub identities and picks
   the wrong one anyway. Flagging as a genuine UX gap inherent to the plan's chosen mechanism,
   not something a screen can fix without a plan-level change (e.g. threading the invitation
   id through `callbackURL` and checking it post-sign-in) — routed to architect/PO to decide
   whether it's worth closing in a later iteration.
3. **Screen I1's bilingual-copy scope is a design inference, not an AC-locked requirement.**
   AC-2.1 locks the EMAIL as bilingual; this design recommends (but does not treat as
   required) mirroring that on the landing page itself, since an anonymous pre-auth visitor
   has the same "no known locale" property the email does. Flagging so PO can confirm or
   explicitly scope it down to English-only if that's preferred for v1 (the rest of admin-ui
   is English-only today regardless — see note 4).
4. **admin-ui's own new copy (Modal N1, Screen U2, Dialog N2, Panel N3) is English-only,**
   consistent with every existing admin-ui string (no i18n infrastructure exists anywhere in
   admin-ui or estimai-ui today, despite CLAUDE.md's stated "i18n from day one" convention) —
   this is not new drift introduced by this feature, just a pre-existing gap this design
   does not attempt to fix in isolation. The ONE place this feature's ACs actually lock
   bilingual text is the invite email (notify-api's template, out of this document's scope)
   and, per note 3 above, arguably the landing page.
5. **No AC asks for a unified "search across users and invitations by email" view** (AC-1.6's
   "an admin can tell, for any given email, whether it corresponds to an active user, a
   pending invitation, or neither" is satisfied by the SAME `?q=` search existing
   independently on both tabs — an admin checks one tab, then the other). A single merged
   view was considered and deliberately not designed: it would be scope creep beyond what any
   AC asks for, and the two-tab structure already mirrors the Roles/Departments precedent of
   keeping related-but-distinct entities in separate lists.
6. **Bulk selection does not persist across pagination** (F4 note) — selecting on page 1,
   then navigating to page 2, loses the page-1 selection. No AC specifies cross-page bulk
   selection, and inventing "select all across every page" semantics for a destructive action
   is exactly the kind of surprising behavior this design avoids introducing without a
   product decision behind it. Flagged so it's a conscious, not accidental, scope boundary.

---

## Summary for the record

- **Flow count:** 6 (F1 invite, F1a manage invitations/resend/revoke, F2 acceptance
  cross-reference [no new UI], F3 single delete, F4 bulk delete, F5 invite-landing states).
- **Screens/dialogs/components:** Screen U1 (modified), Screen U2 (new), Screen U3
  (modified), Modal N1 (new), Dialog N2 (existing component extended), Panel N3 (new),
  `InvitationStatusBadge` (new), `GuardrailDialog` (reused unchanged), UsersSubNav (new),
  plus Screen I1 hosted in `auth` (new, not admin-ui).
- **Reuse/NEW ratio:** ~6 reused-or-extended : ~10 new (see Component inventory) — lower
  NEW-share than specs/004's 9:20 baseline, because this feature extends an
  already-conventioned Users section rather than standing up a new remote.
- **Top a11y hotspots:** the bulk-select checkbox column's tri-state header control, the
  persistent (non-toast) partial-success result panel and its per-item skip reasons, the
  disabled-vs-omitted decision on self-delete (resolved toward disabled-with-explanation,
  a deliberate refinement of the plan's "omits" wording), and the invite landing page's
  focus-on-mount error states (pre-authentication, so no existing shell chrome/focus
  management applies there at all).
- **Drift/gaps to route to PO/architect:** (1) 409 responses carry no conflict id to deep-link
  to, (2) AC-2.4's "wrong account" case has no UI surface and, per the plan's own hook
  mechanics, cannot get one without a plan-level change, (3) Screen I1's bilingual scope is
  this design's inference, not an AC-locked requirement, (4) admin-ui's English-only copy is
  a pre-existing gap this feature inherits rather than introduces, (5) no unified
  user-vs-invitation search view was built (deliberately, not a gap), (6) bulk selection
  doesn't persist across pages (deliberately, not a gap). No scope creep found in the other
  direction — every screen/element above traces to at least one US-1–US-6 AC.
