---
"@operai/refund-ui": patch
---

Dates now render as `11.08.2026` everywhere in the Refund tool.

A single screen could previously show two formats at once: expense-line dates
printed the raw ISO `2026-08-11`, while the applied mileage rate's validity
went through the browser's locale and came out as `Jan 31, 2021`. Neither
reads naturally in Switzerland or Italy, so both are replaced by the numeric
`DD.MM.YYYY` used in both markets, and timestamps by `DD.MM.YYYY, HH:mm` on a
24-hour clock.

The format is fixed rather than locale-derived. These are dates on a shared
financial record — an employee in Italy and an accountant in Switzerland
discussing the same expense line should be reading the same characters — and
pinning it also makes screenshots and tests deterministic.

A latent off-by-one is fixed along the way: a date with no time component is
now formatted from its own characters instead of being parsed as UTC midnight,
which would have shown the previous day to any viewer west of UTC.
