---
"@operai/activities-api": patch
---

A host that lists a project's assignees may answer `assignees: null` ("could not find out"): assigning a task on it is refused with 503 `host_unavailable`, while listing, opening, completing and an unchanged resent assignee are unaffected.
