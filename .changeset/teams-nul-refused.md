---
"@operai/auth": patch
"@operai/projects-api": patch
---

A U+0000 in a text id or in a team's name or description is now a 400 `validation_failed` (no echo in `detail`) instead of a 500 from Postgres: auth's `/admin/teams` routes (name, description, team and user ids) and projects-api's shared `IdSchema` (`GET /projects?teamId=` and `?projectManagerId=`, `PUT /projects/{id}/teams`, every route taking an id). The host-resolve routes now use the same schema.
