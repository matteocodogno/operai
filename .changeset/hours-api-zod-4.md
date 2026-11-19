---
'@operai/hours-api': patch
---

hours-api takes the dependency versions every backend moved to: zod 4.6.7 and `@hono/zod-openapi` 1.6.3 (GHSA-mrhx-c7xc-m3w5), `@scalar/hono-api-reference` 0.12.17 and hono 4.13.16 with `@hono/node-server` pinned to 2.1.6. A request body sent with a Content-Type other than JSON now answers a 415 Problem (`Unsupported Media Type`) instead of 400 `invalid_request`; malformed JSON and a missing body are still 400 `invalid_request`, and zod's own wording of some messages changes.
