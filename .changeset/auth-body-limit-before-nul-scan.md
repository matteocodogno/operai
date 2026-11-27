---
"@operai/auth": patch
---

A request body over 256 KiB is refused with a 413 `request_too_large` before anything reads it (security review A04/A05). The NUL guard decodes the whole JSON body of every request, signed in or not, and Bun's own ceiling is about 128 MiB, so an anonymous caller could make auth hold several copies of that. The limit sits in front of the guard and answers without reading a byte when the declared length is over it; the biggest body any auth route legitimately takes (a role holding every permission of the suite) is about 7 KiB. The legal-entity writes keep their own 16 KiB cap. No wire contract changes for a legitimate request.
