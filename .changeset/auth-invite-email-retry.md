---
"@operai/auth": patch
---

Invitation emails now retry once with a fresh service credential when notify-api answers 401, instead of reporting the send as failed straight away. A second 401 or any other failure is still the best-effort outcome; the invitation is never rolled back.
