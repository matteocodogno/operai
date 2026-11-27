---
"@operai/notify-api": patch
---

A NUL (U+0000) in a notification cursor, a push device id or endpoint, or any text of a notification or an email now answers 400 on every route, where `GET /notifications?cursor=` and `DELETE /push/devices/{id}` (and a notification, device or system call carrying one in its text) answered 500. The schemas refuse it, and the routes keep the database's error as the cause so the safety net answers it as `validation_failed` too.
