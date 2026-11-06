---
"@operai/meetings-api": minor
"@operai/meetings-ui": minor
---

Meetings no longer trusts a transcript to be complete, and says so when it may not be (specs/021 A7, plan amendment 2). Long recordings are transcribed in overlapping parts that are stitched back together; each part is checked for completeness (gaps, early end) and a failed part is retried on its own before the whole transcript is marked possibly incomplete. Speaker labels from different parts are joined by text only, never by audio, and a "Separate by part" action splits a joined speaker back into one per part (names are copied across). Summaries and answers written from a possibly incomplete transcript carry a service-written caveat that the model cannot drop or alter. Claude on Vertex now runs with one unforced tool, and the evals gain channels for completeness and caveats.
- **meetings-api:** the transcript endpoint returns part ends, segment parts, gaps, the default speaker index and the possibly-incomplete notice; new `POST transcript/speakers/:key/separate`; a summary keeps a snapshot of the gaps it was written with.
- **meetings-ui:** shows the possibly-incomplete notice and the caveats on summaries and answers, and offers "Separate by part" on joined speakers.
