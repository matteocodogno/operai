---
"@operai/estimai-api": patch
---

A NUL (U+0000) in an estimate id, a collaborator id or any text of an estimate or a notice is now a 400 on every route, where seven `/estimates/{id}` routes (the estimate, its close and reopen, and the collaborators) and a save with a NUL in its name or notes answered 500. The schemas refuse it, and the routes keep the database's error as the cause so the safety net answers it as `validation_failed` too.
