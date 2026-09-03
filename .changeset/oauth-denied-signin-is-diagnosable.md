---
"@operai/auth": patch
---

A refused Google sign-in now says what went wrong instead of showing a 404.

Better Auth's default OAuth error destination redirects to the service's origin
root, and `auth` registers no `GET /` — so a user whose session was refused
landed on the RFC 7807 handler and saw raw Problem JSON
(`{"status":404,"detail":"GET / does not exist"}`), with the real reason only in
a query string. OAuth failures are now routed to the hosted sign-in page, which
renders the reason as a sentence next to the provider buttons. The
`unable_to_create_session` code — a deactivated account — is spelled out as such
rather than falling through to a generic "please try again", which could never
have worked.

Refusals are also logged now: `session.create.before` emits a structured
`auth.session_denied` event carrying a distinct reason per branch
(`soft_deleted_no_pending_invitation`, `soft_deleted_email_unverified`,
`user_row_missing`) and the user id. Previously every branch produced the same
opaque client-side code and no server-side trace at all, making a deliberately
refused user indistinguishable from a broken OAuth configuration. The user id is
logged rather than the email, to keep personal data out of log retention.
