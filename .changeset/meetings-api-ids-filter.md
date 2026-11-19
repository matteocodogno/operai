---
"@operai/meetings-api": minor
---

`GET /meetings` accepts `ids` (at most 25, comma-separated): among those meetings, only the ones the caller created or was added to as an Operai participant come back, so a meeting readable only through its host and one that does not exist look the same. Time tracking uses it to check that a person may record hours on a meeting.
