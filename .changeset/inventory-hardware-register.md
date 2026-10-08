---
"@operai/auth": minor
"@operai/notify-api": minor
"@operai/notify-ui": patch
"@operai/shell": minor
"@operai/inventory-api": minor
"@operai/inventory-ui": minor
---

New Inventory tool (specs/015): a hardware register with assets, employee-confirmed
assignment, a depreciation ledger with fiscal-year close, and invoice files.

`inventory-api` and `inventory-ui` are new. The shell mounts the gated `/inventory` route
and an ungated `/devices` route (a "My devices" screen for every signed-in user). `auth`
gains the inventory permission catalog, a scoped service-token endpoint and a capability-gated
user directory. `notify-api` accepts the scoped service JWT on `/system/notifications` and a new
`inventory` origin app, which `notify-ui` renders. New environment variables must be set before
deploying: see `infra/README.md` § `inventory-api` service.
