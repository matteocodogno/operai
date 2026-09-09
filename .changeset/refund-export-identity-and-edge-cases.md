---
"@operai/refund-api": minor
---

The archive PDF now names its people, carries a letterhead, and handles
requests that are not uniform.

Employee, decider and exporter render as "Luigi Gambardella
(luigi.gambardella@welld.ch)" rather than a bare address — a document a human
files should lead with the human. The decider's name is captured at decision
time, so an archived PDF never changes because that person's record later did.

The page identifies its issuer: legal name, registered seat and tax identifier
for the entity the request belongs to.

A request whose lines straddle entities, currencies or months no longer gets a
header that quietly implies uniformity. The period widens to "August to
September 2026", the entity says "Multiple — see each line", and the totals are
one row per currency under a "Totals per currency" heading, never summed across
them.

Rejected requests are exportable, and their document carries the rejection
motivation above the figures — it is the whole content of that document and the
one a disputing employee needs. It also shows no approved figure anywhere: a
reviewer can set per-line approved totals before rejecting, and those leftovers
were rendering as approved amounts on a refused claim.

The settlement line no longer repeats the status word directly above it.
