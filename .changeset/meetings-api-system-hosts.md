---
"@operai/meetings-api": minor
---

New service-only route `GET /system/meetings/hosts` (`?ids=` up to 100, or `?dealId=`): which deal each meeting is currently linked to, answering the link and nothing else, to the time-tracking service behind the new scope `meetings.hosts.read`. It needs the new variable `SERVICE_AUDIENCE`; without it the route answers 401 to everyone.
