---
"@operai/hours-ui": minor
---

Add hours-ui (specs/029-time-tracking, ADR-0090): the Hours screens, a federated remote the shell mounts at `/hours`, open to every signed-in user whatever tools they can open. My hours lists a person's entries by day with each day's total, filtered by period, project, deal, category or work type, with totals grouped by project, deal, category or month and an Excel export. An entry is recorded, edited and deleted from one dialog; whether the person may book on the project, deal or meeting they picked is decided by the server, and the dialog says why in plain words when it refuses. A project, deal or meeting the viewer cannot read shows as "not visible to you" instead of a name. Holders of `time-entry:read-all` also get Everyone's hours at `/hours/all`: the same view, read-only, with a person filter. Copy is English and Italian.
