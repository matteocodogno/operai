---
"@operai/refund-ui": patch
---

Amounts are now a right-aligned column instead of values inside sentences.

Each figure previously sat inline after its label, in a row it shared with the
applied-rate detail, so its horizontal position moved with the length of
whatever preceded it and no two rows lined up. The money now sits in a fixed
right-hand column with tabular numerals, on the lines and on the totals card
alike, so the column can be read straight down and checked against the total.

An adjusted amount keeps its approved figure in the column and hangs the
"requested 180,00 · −26,00" note underneath, rather than appending a
parenthetical that would push every figure to a different position. The
applied-rate provenance stays on the descriptive side — it explains how an
amount was reached, it is not a figure anyone sums.
