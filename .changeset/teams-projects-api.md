---
"@operai/projects-api": minor
---

Teams on a project (step 2): `PUT /projects/{id}/teams` replaces the attached teams (at most 10, `If-Match`, `project:manage` for the entity; 422 `team_not_found` / `team_archived` for an added team, 503 `teams_unavailable`, 429 `rate_limited` with `retryAfterSeconds`), and `GET /attachable-teams[?q=]` searches active teams on the server (50 at most, 120 requests per caller per 10 minutes). Every `Project` now carries `teams` (live names and members, kept nowhere in projects-api), `onProject`, `onProjectComplete`, `teamsStatus` and `teamsRetryAfterSeconds`. The page always loads: when the team read fails or the person's own limit (120 page reads per 10 minutes, 2 400 for the service) refuses it, the teams and their members are marked as not loaded. A team gives presence on the project, never the capability to change it.
