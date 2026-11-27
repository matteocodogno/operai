---
"@operai/estimai-api": patch
"@operai/refund-api": patch
---

The log line of an unhandled error no longer writes the whole error and its `cause` chain, which can hold a Prisma or driver message with the query's arguments (an id, an email). It writes the error's own message and call frames and each cause by name and code only; a Prisma error itself has no message in it either.
