---
"@operai/refund-ui": patch
---

The CHF currency chip no longer reads "CHF CHF".

`CurrencyBadge` renders a decorative symbol next to the ISO code, but the
Swiss franc has no single-character sign in common use, so its symbol slot was
filled with the literal string `CHF` — printing the code twice wherever the
chip appears: the request page's per-currency subtotal cards, expense line
rows, batch subtotals, and the mileage amount field. The symbol is now
optional, and CHF renders its code once. EUR, USD and GBP are unchanged.
