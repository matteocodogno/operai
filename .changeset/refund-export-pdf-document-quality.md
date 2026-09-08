---
"@operai/refund-api": minor
"@operai/refund-ui": patch
---

The request archive PDF now reads like a document rather than a data dump.

Raw database values no longer reach the page: expense types, entities and the
status render as the same words the UI shows ("Travel — mileage (km)",
"WellD CH", "Approved"), sourced from a canonical label table both packages
assert against so the PDF and the screen can never disagree.

One locale throughout. Amounts, the mileage rate and every date now share a
single convention (206,50 CHF · 0,70 CHF/km · 31.01.2021) instead of mixing
comma decimals, dot decimals and ISO dates on one page, and the currency now
follows the amount as it does on screen. Timestamps are civil time in the
document's timezone with the zone named — 08.09.2026 08:45 (CEST) — rather
than raw ISO with milliseconds in UTC, which could file an evening export
under the wrong day.

The document also answers the first question a recipient asks: whether it
represents a liability or a settled one. A settlement line states "not yet
included in a monthly batch", "included in batch 2026-09 — compiled, not yet
paid", or "Paid on … — batch 2026-09". The header names the period and legal
entity, every page carries the reference and a page number, and receipts are
stated once rather than per line and again at the end.

Downloads are named refund_2026-08_camerini_CHF-206.50_<id>.pdf instead of
refund-request-<cuid>.pdf — sortable in a folder and quotable over the phone.
