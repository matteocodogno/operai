# @operai/notify-api

## 0.2.0

### Minor Changes

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

- ceb22d1: An approve/reject decision on an expense request now also reaches the employee
  by email, alongside the in-app notification they already received.

  Two new notify-api templates — `refund_decision_approved` and
  `refund_decision_rejected` — rather than one with an outcome flag: only the
  approved variant carries money, so a split keeps each template's `data` shape
  closed and fixed, and a rejection can never carry a figure. The approved mail
  states the approved total per currency inline; the rejected mail carries no
  amount and, deliberately, not the rejection motivation — that stays behind
  sign-in in the app. Both link into the request rather than restating it, the
  same posture the compiled-batch email already takes.

  refund-api sends it from the decision path as a second, independent
  best-effort channel: an email outage cannot suppress the in-app notification,
  an in-app outage cannot suppress the email, and neither can fail or roll back
  the decision itself. No new environment variable and no new secret — the
  existing notify-api internal token and app base URL cover it.

## 0.1.1

### Patch Changes

- bdf998c: Bind backends to IPv6 (::) on Railway (when RAILWAY_PRIVATE_DOMAIN is set) so private networking (\*.railway.internal) can reach them. Enables moving cross-service call URLs (AUTH_JWKS_URL / AUTH_BASE_URL / NOTIFY_INTERNAL_URL) to internal DNS and shared/reference variables (Layer 2), reducing the env-var sprawl. Local dev unchanged (keeps Bun default IPv4).
