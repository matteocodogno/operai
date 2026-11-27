---
"@operai/crm-api": patch
---

A `client.date` in an offer-wizard answer that is not a calendar date (`x`, `2026-13-45`, `2026-00-10`) is now the usual 422 `answers_invalid` on `PUT /deals/{id}/offer-draft`, where it answered a 500: the refinement called `toISOString()`, which throws on an Invalid Date, and zod 4 still runs it on a string the pattern refused. One `isCalendarDate` that never throws now serves the answers schema and the date-only fields.
