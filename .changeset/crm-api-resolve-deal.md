---
"@operai/crm-api": minor
---

Activity-host resolve learns deals (specs/029-time-tracking, AC-2.3): `POST /activity-host/v1/resolve` accepts `entityType: "deal"` and answers each deal `open` (any stage, with label, `/crm/deals/<id>` and `involved`: the deal's owner, plus its technical contact once an estimate is linked) or `missing`, so hours-api can ask as the caller who may book time on a deal. A caller without `crm:access` still gets `reader:false` and nothing about any deal; `related` stays a company-only member (a deal request carrying it is a 422). Companies answer exactly as before.
