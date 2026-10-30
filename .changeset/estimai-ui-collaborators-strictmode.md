---
"@operai/estimai-ui": patch
---

The collaborators dialog no longer sticks on "Adding…" in development: its
mounted flag is set again after React StrictMode's remount, so add, level change,
remove and leave results are applied.
