---
"@operai/notify-api": minor
"@operai/notify-ui": minor
---

Bilingual system notifications (specs/021-meetings, ADR-0065):
- **notify-api:** `POST /system/notifications` accepts an optional Italian rendering of the title and body (`it`). A notification without it renders exactly as before. A migration adds the column. Email notices stay English.
- **notify-ui:** the bell and the notification center show the Italian text when the interface language is Italian and the notification carries it, and fall back to the original otherwise. `meetings` is a new origin.
