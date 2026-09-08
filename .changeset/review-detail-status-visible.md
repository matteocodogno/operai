---
"@operai/refund-ui": patch
---

The review detail now states a request's status instead of implying it.

An approved request said so nowhere: you could only tell from the absence of
the Approve and Reject buttons and the presence of the monthly-processing
note. Absence is not a signal. The page now carries a status badge beside its
title — agreeing with the badge the queue already shows on every row — and a
decision stamp naming who decided the request and when: "Approved on
22.08.2026 by chiara.rossi@welld.ch".

Rejected requests get the same stamp. Their motivation block already said
*why*, never *who* or *when*. A paid request shows both its approval stamp and
its existing payout line, since those are two events by two different people
and neither stands in for the other.
