---
"@operai/auth": minor
---

Teams, admin side (step 1): `GET/POST /admin/teams`, `GET/PATCH /admin/teams/{id}`, `POST /admin/teams/{id}/archive` and `/restore`, and `DELETE` answering 405 `not_deletable`. Admin-only (a department-conferred admin is refused). Writes of a team's own fields carry the version they were read at as `baseVersion` in the body (409 `version_conflict` + `currentVersion` when stale, since auth's CORS exposes no ETag). A name already taken, ignoring case and archived teams included, answers 409 `team_name_taken` with `existingName`. One audit row per successful change, no permission epoch bump: a team grants nothing.
