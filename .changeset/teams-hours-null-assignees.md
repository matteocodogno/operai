---
"@operai/hours-api": patch
---

A project the host answers with `assignees: null` (an attached team's members could not be read) refuses a booking as 503 `host_unavailable` instead of reading as a malformed answer; the project's label still resolves.
