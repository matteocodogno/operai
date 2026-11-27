---
"@operai/projects-api": patch
---

`GET /companies?q=` and `GET /queue?q=` refuse a NUL character with 400 `validation_failed` instead of forwarding it to crm-api and answering 503 `crm_unavailable`.
