---
"@operai/refund-ui": patch
---

An approved amount is now shown once, unless accounting changed it.

The line rows and the totals card both printed "Requested X / Approved X"
unconditionally, so a typical request showed six numbers for three distinct
values and the reader had to compare each pair to find the one that differed.
An unadjusted amount now shows a single figure; an adjusted one reads
"154,00 CHF (requested 180,00, −26,00)", which is the fact a review screen is
scanned for.

Only the presentation changes — both values remain on the wire and in the API
contract — and the rule lives in one shared helper, so a line and its totals
card can never disagree about whether an amount moved. specs/007's AC-3.2 is
amended to match: its stated purpose ("see exactly where, if anywhere, an
amount was adjusted") is what motivated the change; showing both figures
everywhere worked against it.
