---
"@operai/projects-ui": minor
---

The Team card of a project has a People section (the listed team, now "Edit people") and a Teams section: each attached team by its current name with its members, badged Deactivated or No access to Projects, and an Archived mark. "Edit teams" attaches teams found by a server-side search (at most 10) and removes them in one save. When teams or their members could not be loaded the card says so, or, for a person over their own limit, says "Too many requests" with the wait; Retry reloads in place.
