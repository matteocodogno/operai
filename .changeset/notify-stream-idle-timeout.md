---
"@operai/notify-api": patch
---

Keep the notification stream open. The server closed every idle connection after
10 seconds, which is shorter than the stream's 15-second heartbeat, so the live
stream was dropped and reopened about every 12 seconds and the browser console
filled with `ERR_HTTP2_PROTOCOL_ERROR`. The idle timeout is now 60 seconds.
