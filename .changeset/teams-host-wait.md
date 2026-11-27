---
"@operai/projects-api": patch
---

The activity-host and meeting-host resolves wait at most 800 ms for a team read (counted once per call), so a slow auth costs one project's assignees instead of the whole batch; a slower read is not aborted and still fills the cache.
