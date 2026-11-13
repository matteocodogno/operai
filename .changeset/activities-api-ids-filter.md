---
"@operai/activities-api": minor
---

`GET /activities` takes a fifth filter, `ids` (up to 50, comma-separated), for hours-api's time entries (specs/029):
it answers the activities among them that the caller still reads, as the existing activity view, newest first and
in one page. Each id's host is asked as the caller, as for every other read. An id that does not exist, that the
caller may not read or whose record the host no longer knows is left out, and the three answers are identical; a
host that cannot answer is the existing 503 `host_unavailable`.
