---
"@operai/projects-api": patch
"@operai/crm-api": patch
"@operai/activities-api": patch
"@operai/meetings-api": patch
"@operai/hours-api": patch
---

Inner deadlines now fit inside their callers' (specs/20261126-teams R13). The host routes of projects-api and crm-api (`/activity-host/v1/resolve`, `/meeting-host/v1/resolve`) wait at most 500 ms for a permission check they have not cached, then answer the usual 503 `authz_unavailable`; the check is single flight per person, is not aborted, and fills its 30 s cache for the retry. hours-api waits 6 s, not 2 s, for activities-api's lists and the meetings list, which ask a host themselves; activities-api waits at most 800 ms for the names on a list, and meetings-api's list makes no permission call (it never read the answer) and waits at most 800 ms for its creators' names. A name not known in time reads as unknown and is known on the next load. No wire contract changes.
