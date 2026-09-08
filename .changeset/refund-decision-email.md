---
"@operai/notify-api": minor
"@operai/refund-api": minor
---

An approve/reject decision on an expense request now also reaches the employee
by email, alongside the in-app notification they already received.

Two new notify-api templates — `refund_decision_approved` and
`refund_decision_rejected` — rather than one with an outcome flag: only the
approved variant carries money, so a split keeps each template's `data` shape
closed and fixed, and a rejection can never carry a figure. The approved mail
states the approved total per currency inline; the rejected mail carries no
amount and, deliberately, not the rejection motivation — that stays behind
sign-in in the app. Both link into the request rather than restating it, the
same posture the compiled-batch email already takes.

refund-api sends it from the decision path as a second, independent
best-effort channel: an email outage cannot suppress the in-app notification,
an in-app outage cannot suppress the email, and neither can fail or roll back
the decision itself. No new environment variable and no new secret — the
existing notify-api internal token and app base URL cover it.
