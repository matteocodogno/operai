---
"@operai/refund-api": patch
---

A NUL (U+0000) in an id, query or text of any route is now a 400 `validation_failed` instead of a 500 (QE F1): ids and free text are refused at the schema, and a database error caused by a NUL that reaches Postgres anyway is answered 400 too (it was wrapped in a `DatabaseError` rendered as a plain 500 before the global handler could see it).
