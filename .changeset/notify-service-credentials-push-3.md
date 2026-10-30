---
"@operai/notify-api": minor
"@operai/inventory-api": patch
---

The shared notification token is retired. `notify-api`'s two internal routes,
`POST /system/emails` and `POST /system/notifications`, now accept only a scoped
service credential from the caller; the `X-Internal-Token` header is refused with
401 and the `NOTIFY_INTERNAL_TOKEN` setting is no longer read, so a deployment that
still has it set starts normally. `inventory-api`'s comments and example file no
longer mention the shared token.
