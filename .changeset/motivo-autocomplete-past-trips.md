---
"@operai/refund-api": minor
"@operai/refund-ui": minor
---

Filing the same trip twice no longer means typing it twice: while composing a
"Travel by car" line, the Motivo field now suggests trips the employee has
already claimed in the last 24 months, and picking one (by mouse or keyboard)
fills in the motivo, the distance and the entity in a single step, with the
amount recomputed from the current rate. Suggestions are drawn only from the
employee's own past lines, served by a new self-scoped `GET /line-suggestions`
on refund-api; if that call fails, Motivo quietly stays an ordinary text field.
