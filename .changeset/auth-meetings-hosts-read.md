---
"@operai/auth": minor
---

Add the service scope `meetings.hosts.read` and document the `hours-api` service client (specs/029, ADR-0089). `hours-api` holds only this scope: it asks meetings-api which deal a meeting is linked to, and everything else it asks of the other services is asked as the caller. The scope is a deliberate addition to the allowlist, so in production the `hours-api` entry of `SERVICE_CLIENTS` must be added only after this version of auth is live; an unknown scope stops auth at startup.
