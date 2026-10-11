# @operai/auth

## 0.2.0

### Minor Changes

- 621604b: Admins can now record and update an employee's home address from the Admin
  tool's Users section — with live, suggestion-assisted entry (Google Places,
  biased toward Switzerland and Italy) or fully manual typing, either way. Every
  change is captured in the existing audit trail. Employees gain a new "My
  profile" page (reachable from the account menu) where they can see their own
  address, read-only.
- 2b11a53: New Inventory tool (specs/015): a hardware register with assets, employee-confirmed
  assignment, a depreciation ledger with fiscal-year close, and invoice files.

  `inventory-api` and `inventory-ui` are new. The shell mounts the gated `/inventory` route
  and an ungated `/devices` route (a "My devices" screen for every signed-in user). `auth`
  gains the inventory permission catalog, a scoped service-token endpoint and a capability-gated
  user directory. `notify-api` accepts the scoped service JWT on `/system/notifications` and a new
  `inventory` origin app, which `notify-ui` renders. New environment variables must be set before
  deploying: see `infra/README.md` § `inventory-api` service.

  `auth GET /authz/resolve` now returns no permissions for a soft-deleted user, so a removed
  user loses access to `refund-api` and `inventory-api` within 30 seconds instead of keeping it
  until their token expires.

### Patch Changes

- cc1e678: A refused Google sign-in now says what went wrong instead of showing a 404.

  Better Auth's default OAuth error destination redirects to the service's origin
  root, and `auth` registers no `GET /` — so a user whose session was refused
  landed on the RFC 7807 handler and saw raw Problem JSON
  (`{"status":404,"detail":"GET / does not exist"}`), with the real reason only in
  a query string. OAuth failures are now routed to the hosted sign-in page, which
  renders the reason as a sentence next to the provider buttons. The
  `unable_to_create_session` code — a deactivated account — is spelled out as such
  rather than falling through to a generic "please try again", which could never
  have worked.

  Refusals are also logged now: `session.create.before` emits a structured
  `auth.session_denied` event carrying a distinct reason per branch
  (`soft_deleted_no_pending_invitation`, `soft_deleted_email_unverified`,
  `user_row_missing`) and the user id. Previously every branch produced the same
  opaque client-side code and no server-side trace at all, making a deliberately
  refused user indistinguishable from a broken OAuth configuration. The user id is
  logged rather than the email, to keep personal data out of log retention.

## 0.1.1

### Patch Changes

- bdf998c: Bind backends to IPv6 (::) on Railway (when RAILWAY_PRIVATE_DOMAIN is set) so private networking (\*.railway.internal) can reach them. Enables moving cross-service call URLs (AUTH_JWKS_URL / AUTH_BASE_URL / NOTIFY_INTERNAL_URL) to internal DNS and shared/reference variables (Layer 2), reducing the env-var sprawl. Local dev unchanged (keeps Bun default IPv4).
