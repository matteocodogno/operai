---
"@operai/auth": minor
"@operai/estimai-api": minor
"@operai/crm-api": minor
"@operai/crm-ui": minor
"@operai/notify-api": minor
"@operai/notify-ui": patch
"@operai/projects-api": minor
"@operai/projects-ui": minor
---

Projects hand-off (specs/022-projects-handoff, ADR-0060 to 0063): a won deal reaches OPS "in series".
Sales (and admins) see a to-start queue of the CRM's won deals that no project has taken, read live
(a reopened deal leaves it, a re-won one returns), and turn one into a new project with its purchase
order (PO): type, dates and terms, an optional referent among the company's CRM contacts, and the
ops-manager the PO is assigned to. The project starts without a project manager; the ops-manager is
notified and picks one (an admin may in their place), and `planned` to `active` is refused until then.
"Contract" is retired: a project has 0..1 terms and 0..1 purchase order, a PO is born only from a won
deal, and a hand-made project may be of any type and carry terms but never a PO. A fixed-price PO from
a deal with an estimate copies the estimate's man-days once, and they cannot be edited. The PO shows its
deal, a "no longer won" notice, the estimate link and the referent's name, job title, email and phone,
read live from the CRM and never stored; the CRM deal page shows its project and the PO's Bexio order id,
read-only.
- **auth:** the `projects` catalog gains `purchase-order:bexio` (was `contract:bexio`),
  `purchase-order:receive` and `handoff:take`; new `ops-manager` system role; `sales` gains
  `handoff:take`. New `GET /authz/users/holders`, gated on `handoff:take`, lists the holders of
  `purchase-order:receive` for an entity as `{ id, name, unconditioned }` (ADR-0063 amends ADR-0047). New
  service scopes `crm.deals.read`, `crm.contacts.read`, `estimai.estimates.read` and
  `projects.purchase-orders.read`; a `SERVICE_CLIENTS` entry still carrying the retired contracts scope
  refuses to start.
- **estimai-api:** its first `/system/*` route, `GET /system/estimates/{id}/summary`, returns only
  `{ id, name, manDays }` to a service credential with `estimai.estimates.read`; new optional
  `SERVICE_AUDIENCE`.
- **crm-api:** new `GET /system/deals` (`crm.deals.read`, no amounts) and `GET /system/contacts`
  (`crm.contacts.read`, minimal shape per mode) for projects-api; the deal read gains `delivery` and
  `deliveryKnown`, read from projects-api's `GET /system/purchase-orders`; `SERVICE_CLIENT_ID` /
  `SERVICE_CLIENT_SECRET` are now required with either `NOTIFY_INTERNAL_URL` or the new optional
  `PROJECTS_INTERNAL_URL`.
- **crm-ui:** a read-only "Delivery" card on the deal page.
- **notify-api:** `system:projects-api` may raise `projects` notifications.
- **notify-ui:** the notification centre labels the `projects` origin "Projects" / "Progetti".
- **projects-api:** one new migration on top of the Projects module's own (it refuses to run if a
  `contract` row or a `saas` project exists); the take (`POST /queue/{dealId}/project`) behind
  `handoff:take`, with ops-manager candidates from auth, referent contacts from the CRM and a best-effort
  notification; `GET /queue`, the terms and purchase-order routes, the referent and the project-manager
  pick, hand-made projects with optional terms, and `GET /system/purchase-orders`; `GET /scope` gains
  `take` and `oversees`; new `ESTIMAI_INTERNAL_URL`, `NOTIFY_INTERNAL_URL` and `SERVICE_AUDIENCE`.
- **projects-ui:** the queue (sales only), "New project" from a deal with the ops-manager and referent
  pickers, the purchase-order and terms cards, the awaiting notice with "Pick project manager", the
  list's "Awaiting project manager" state and filter, and hand-made creation with optional terms.
