---
"@operai/ui": patch
---

`ListRows` keeps a row by its own `key` instead of by its position. A row that is added or removed above
another no longer remounts every row below it, so what a row holds (a message shown in it, an open menu) stays
when the list is read again. A row with no key is kept by its position, as before.
