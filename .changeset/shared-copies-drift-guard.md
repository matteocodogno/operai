---
"@operai/inventory-api": patch
"@operai/refund-api": patch
"@operai/estimai-api": patch
---

Mark the service-token client's shared region in `src/lib/serviceToken.ts` with
`shared-copy` begin/end comments so a CI check can fail when the three copies drift.
Comment-only: no behaviour change.
