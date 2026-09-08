---
"@operai/refund-api": patch
---

The refund review queue now lists requests newest-submitted-first.

It was ordered oldest-first (FIFO), which pushed the most recent submissions
to the bottom, under every already-approved request still waiting to be
batched. Accounting works the queue from the newest end, so that ordering is
now reversed. Submitted and approved-not-yet-batched rows remain interleaved
by submission date rather than grouped, as before — the per-row status badge
distinguishes them.
