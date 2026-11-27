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

The safety net that answers 400 when Postgres refuses a U+0000 now leaves one log line, `[nul] database refused U+0000 or invalid text` and the Prisma and SQLSTATE codes (`P2039/22021`), so a value built by the server with bad bytes is no longer blamed on the client without a trace (security review A09). The line carries only codes taken from the two closed sets the detector already knows: no message, value, argument, request or person. No wire contract changes.
