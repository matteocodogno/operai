---
"@operai/auth": patch
"@operai/estimai-api": patch
"@operai/notify-api": patch
"@operai/refund-api": patch
"@operai/inventory-api": patch
"@operai/crm-api": patch
"@operai/meetings-api": patch
"@operai/projects-api": patch
"@operai/activities-api": patch
"@operai/accounting-api": patch
"@operai/hours-api": patch
---

A U+0000 in any input is a 400, never a 500. Postgres text (and the text inside jsonb) cannot hold it; every backend's global error handler now answers the database's refusal (Postgres 22021 / 22P05, Prisma P2039 / P2010) with a 400 `validation_failed` (hours-api: `invalid_request`) that names no value and none of the database's words, so a route nobody remembered is still not a 500. In auth a guard in front of the whole app refuses a NUL in the path, the query or a JSON body before any route runs (`GET /admin/users?q=%00`, `POST /admin/departments`, roles, invitations, legal entities, …). In projects-api the shared text helpers (`requiredText`, `optionalText`, a new `searchText`) refuse it, which covers `GET /projects?q=`, a project's name, a T&M position's profile, the Bexio order id and `GET /system/purchase-orders?dealIds=`.
