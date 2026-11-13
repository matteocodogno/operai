---
"@operai/admin-ui": minor
---

Add a Time lists section to Admin (specs/029-time-tracking, AC-3.3), shown only to holders of `time-list:manage`: the categories and the two work-type lists (project, deal) that people pick from when they record hours, read and changed through hours-api (retire and restore, never delete). The link is out of the tab strip until the permissions resolve and include `time-list:manage`; `/time-lists` without it shows the permission-denied state, a `503 authz_unavailable` shows the authorization-unavailable banner with Retry, and any other load failure a warning banner with Retry. Copy is English and Italian.
