---
"@operai/refund-ui": patch
---

The batch detail screen no longer prints "Paid on … by [object Object]" — the
paid and discarded stamp lines now name the person who closed the batch out.
The batch id chip is relabelled "Batch reference" and explains, on hover, that
it's the value quoted in the accounting email and on the compiled PDF.
