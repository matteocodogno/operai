---
"@operai/shell": patch
---

Serve the SPA document with `Cache-Control: no-store`. CSP rides on a response
header and a `304 Not Modified` does not carry it, so a browser holding a
cached copy kept enforcing a stale policy — which left receipt uploads blocked
for two days after the CSP fix was live and correct. `max-age=0,
must-revalidate` is not sufficient; it still permits the 304.
