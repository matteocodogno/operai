---
"@operai/crm-api": minor
"@operai/crm-ui": minor
---

Meetings on CRM deals (specs/021-meetings, US-14, ADR-0059/0060):
- **crm-ui:** the deal page embeds a Meetings panel, so you can start a meeting about a deal and list the ones already linked. If Meetings is unavailable the page shows its own fallback and keeps working. The company page does not roll up its deals' meetings in this release.
- **crm-api:** a deal's meetings appear in its activity timeline as a "meeting" activity, kept in step when the meeting is linked, changed, relinked, unlinked or deleted. The activity carries no meeting content, and nothing with a title outlives a deletion. New routes: service-authenticated `POST /system/meeting-host/v1/notices` and `POST /meeting-host/v1/resolve`, which tells meetings-api whether the caller may open a deal. A migration adds `activity.meetingId` and a content-free ordering table, so duplicated or reordered notices are harmless.
- **Operators:** crm-api needs `SERVICE_AUDIENCE` (the same value as notify-api's, different from `AUTH_AUDIENCE`). Without it the notice route answers 401 and the rest of the service is unaffected.
