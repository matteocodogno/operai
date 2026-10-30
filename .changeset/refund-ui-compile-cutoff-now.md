---
"@operai/refund-ui": patch
---

The compile-batch preview now defaults to the exact current instant (spec 008
AC-1.1). The cutoff field only holds minutes, so requests approved earlier in the
current minute used to be left out of the preview and the batch.
