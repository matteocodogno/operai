---
"@operai/auth": minor
"@operai/refund-api": minor
"@operai/estimai-api": minor
---

Second of three pushes that retire the shared notification token (specs/016,
ADR-0048/0049). Every notify-api caller now authenticates as itself with a scoped,
short-lived service credential and no longer reads `NOTIFY_INTERNAL_TOKEN`: `auth`
mints its own `emails.send` credential in process for invitation emails,
`refund-api` uses `notifications.push` for decisions and `emails.send` for the batch
email, and `estimai-api` uses `notifications.push` for collaborator changes. A caller
whose credential is missing or refused fails soft exactly as before. `notify-api` still
accepts the shared token until it is deleted from the deployed services.
