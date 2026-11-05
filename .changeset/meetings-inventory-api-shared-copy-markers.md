---
"@operai/inventory-api": patch
---

Mark the S3 residency allowlist and path-style addressing in `src/lib/s3Residency.ts` with `shared-copy` begin/end comments, so a CI check can fail when the copies across the backends drift. Comment-only: no behaviour change.
