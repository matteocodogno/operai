---
"@operai/admin-ui": patch
---

The Admin tool's Audit tab now names the person behind each change: the Actor
column shows the actor's full name, with their user id still shown underneath
for correlation. A hard-deleted actor keeps its existing "Deleted user"
fallback, so the cell is never blank.
