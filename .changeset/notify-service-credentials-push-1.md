---
"@operai/auth": minor
"@operai/notify-api": minor
---

First of three pushes that retire the shared notification token (specs/016,
ADR-0048/0049). `notify-api` now accepts a scoped service credential on both
internal routes (`/system/notifications` with `notifications.push`,
`/system/emails` with `emails.send`), logs which caller made each accepted call,
and treats `NOTIFY_INTERNAL_TOKEN` as optional. `auth` knows the `emails.send`
scope, reserves the client id `auth` and can mint its own credential in process.
`SERVICE_AUDIENCE` is now required in both services. No caller changes yet: every
caller still sends the shared token and it still works.
