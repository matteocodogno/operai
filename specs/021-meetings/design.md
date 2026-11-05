---
spec: 021
status: draft
---

# Design: Meetings — record, transcribe, summarise and question meetings

Sources read: `spec.md` (approved, amendments A1-A4), `plan.md` (approved), `operai-ui/docs/building-pages.md`,
`operai-ui/docs/design-system.md`, `operai-ui/src/index.ts`, `operai-ui/src/pages/*`, `crm-ui` deal page and
its components (`LoadState`, `PersonPicker`, `ParticipantsField`, `SectionsEditor`, `AttachmentsCard`),
`inventory-ui` `MyDevices` + `MyDevicesPage` (ungated-entry precedent), `docs/ui-inconsistencies.md`
(INC numbers cited below), `shell/src/lib/session.ts` (`usePermissions`, `navigateSuite`).
Headless run: no visual companion, no browser inspection; every layout decision is expressed in library
components and token utilities only (ADR-0051). No colour is invented.

Visual direction: not applicable. Meetings is a new tool inside an existing design system (`@operai/ui`), so the
system wins and there is no `## Visual direction` section.

## Conventions used throughout

- **Library**: `@operai/ui` (ADR-0050) on Vite + React + Tailwind 4 + TanStack Router. Not Mantine.
- **Frame**: `./App` renders `ToolLayout` "Meetings" (`width="default"`) with a `TabNav`
  (Meetings, Templates, Erase; Erase only for `meeting:erase` holders per `usePermissions().permissions`, a UI hint
  only, the server decides). `./MyMeetings` renders `ToolLayout` "My meetings" with no `TabNav` (the
  `MyDevices` precedent: no inner capability hook for gating, no `/scope` call, one small router for list + detail).
  `./HostMeetings` renders no frame, only a `Card`.
- **Page skeleton** (building-pages § 1): every page is `<section aria-labelledby>` + `PageHeader` (h2, `back` on every
  detail page in every state) + exactly one state at a time, checked in this order: 403, loading, failed, empty, loaded.
- **Page states vocabulary** (thin meetings-ui adapters on library components, copy bound to `strings.ts`, same shape
  as `crm-ui/src/components/LoadState.tsx`; not a copy of crm-ui logic): `Loading` (`VisuallyHidden live` +
  `SkeletonRows`), `LoadFailure` (403 → `PermissionDenied` `StatePanel role="alert" focusOnMount`; 503 → `Banner
  tone="warning"` titled "Authorization service unavailable" + Retry; other → `Banner tone="warning"` with the Problem
  `detail` + Retry), `Saved` (compact `Banner tone="success" autoDismiss`), `StaleWriteBanner` (`Banner tone="danger"`
  with Reload) for 409/428.
- **Dates and numbers**: `formatDate`, `formatDateTime`, `formatRelative`, `formatNumber` only. Durations through
  the NEW library formatter `formatDuration` (see § Component inventory). Never `toLocaleString`.
- **Statuses** through `StatusBadge` with ONE map in `meetings-ui/src/lib/statusMeanings.ts` (plan): meeting
  `draft→draft`, `recording→pending`, `interrupted→attention`, `processing→pending`, `ready→settled`, `failed→failed`;
  summary `generating→pending`, `ready→settled`, `failed→failed`. A flag that is not a status ("Edited", "AI-generated",
  "Based on an earlier version", role, source, language) is a `Badge`.
- **Deep links** (plan): notifications, the CRM activity and the host panel all point at `/my-meetings/m/<id>`; the
  gated tool's own lists link to `/meetings/m/<id>`. Both render the same `MeetingPage` component, which takes a
  `listPath` prop for its back link ("Back to meetings" / "Back to my meetings").
- **Controls follow the server's `can` flags** and `capabilities: 'resolved' | 'unavailable'`, never `usePermissions()`
  (which is used only for navigation hints: the tool entry, the "New meeting" entry point in My meetings, `Erase` tab,
  the shared-template radio, and the deal panel's "Start meeting").
- **Routes** (`./App`, base `/meetings`): `/` list, `/new`, `/m/$id`, `/templates`, `/templates/new`,
  `/templates/$id`, `/templates/$id/edit`, `/erase`, `*` not found. (`./MyMeetings`, base `/my-meetings`): `/`, `/m/$id`,
  `*` not found. List filters, page and the meeting page's tab live in the URL search string (`?q&role&status&host&page`,
  `?tab=summaries|transcript|ask`) so back/forward and shared links work; search text is URL state only on the client
  (the API never logs query strings, AC-4.10).

---

## Flows

Entry points: (a) CRM deal page → "Meetings" card; (b) Meetings tool; (c) My meetings; (d) a notification or CRM
activity link. Success exits are named; error exits are in § Screens & states.

### F1. Start a meeting from a deal (US-1, AC-1.1, AC-1.4, AC-1.5, AC-1.6, AC-11.2, AC-11.3, AC-11.6)
1. Deal page → Meetings card (`./HostMeetings` via `HostExtension`) → **Start meeting** (only if `usePermissions()` has
   `meetings`; absent otherwise, AC-1.4). The link is a real `<a href>` (middle-click works) whose click calls
   `navigateSuite('/meetings/new?hostApp=crm&hostType=deal&hostId=<id>')`.
2. **New meeting** page loads the host entity from `GET /hosts/crm/deal/:id` (resolved as the caller). Loading → skeleton
   for the "Linked to" line. Success → title prefilled with the deal's title; "Linked to: Deal · <title>" shown read-only.
3. User fills the form → **Create meeting** → 201 → navigate to the meeting page (draft) with `Saved` "Meeting created"
   and, if the response has `hostNotice.state = failed`, the host-notice banner (F11).
- Exit: `422 host_entity_not_found` or `host_not_registered` → page-level `StatePanel` (identical copy for missing and
  closed, AC-1.5): "We can't find that item, or you can't open it", actions "Start a standalone meeting" (secondary,
  clears the host and shows the normal form) and the back link.
- Exit: `503 host_unavailable` → `Banner tone="warning"` "We can't check the {entity} right now" + Retry + "Start without
  linking" (secondary); a standalone meeting can always be started (AC-11.6).
- Exit: `403` → `PermissionDenied`.

### F1b. Link an existing meeting from the host panel (US-1 AC-1.7, US-11 AC-11.8, US-14 AC-14.1, AC-14.7; plan G2)
1. Deal page → Meetings card → **Link an existing meeting** (secondary `sm`, same visibility condition as Start meeting: `usePermissions()` has `meetings`; absent otherwise).
2. A dialog "Link an existing meeting" opens and loads `GET /hosts/crm/deal/:id/linkable-meetings` (the caller's own meetings as creator, not frozen, not already on this deal; so it also moves a
   meeting linked to another deal). Title search, a radio list of rows (title, date, current host: "Standalone" / "Deal · other" / "CRM · deal"), `Pagination` beyond 25.
3. Pick one → **Link meeting** (primary) → `PATCH /meetings/:id { host }` (the host entity is resolved as the caller, like starting) → dialog closes, the panel list refreshes, `Saved` "Meeting linked" in
   the card, focus on the new row. If the response has `hostNotice.state = failed`, the card shows a compact warning with the host's `noticeFailed` sentence and **Try again**.
4. A meeting that is currently on another record shows its current host in the row, and a line under the list reads "It will be moved from {current host} to this {entity}".
- Exit: `422 host_entity_not_found` / `host_not_registered` → inline form error "You can't link to this item" (same words for missing and closed, AC-1.5); `503 host_unavailable` → inline "We can't check this
  {entity} right now. Try again." (never linked unverified, AC-11.6); `403` on the list → `PermissionDenied` in the dialog.
- Unlink is not here: it stays on the meeting page (Edit details → Remove link).

### F2. Start a standalone meeting (US-1, AC-1.2, AC-1.3, AC-10.5, AC-10.7)
Meetings tool or My meetings (holder) → **New meeting** (primary, header) → same form without a host line → create → meeting
page. Missing/invalid fields: `422` names every invalid field (`field` + `errors[]`) → field errors under each `Field`, an
error summary `Banner tone="danger"` takes focus, and `focusFirstInvalid` moves to the first bad field (design-system §
Forms). Date-time defaults to now and may be in the past (no future/past validation).

### F3. Consent attestation (US-4, AC-4.1, AC-4.2, AC-4.3, AC-2.1)
On the meeting page, `draft` + source `recorded`/`uploaded` + `can.capture`: the **Consent** card is the only thing offered.
No capture control, no `getUserMedia`, no file picker is rendered until `consent` is set (AC-2.1). Read the notice →
(optional) **Copy announcement** → tick the confirmation → **Continue** → `POST consent { noticeVersion }`. Afterwards the
Consent card collapses to a one-line fact ("Confirmed by <name> on <date>, notice <version>") and the capture card
appears. `409 notice_outdated` → `Banner tone="warning"` "The consent notice has changed. Reload the page to read it
again." + Reload. `text` meetings never show this card (AC-3.4).
The notice lists **six statements** in this order (AC-4.1; notice version `2026-11-05`, the same string in en and it): (1) everyone present has been told and agreed; (2) AI transcription and summary, processed in the EU or Switzerland; (3) who can read the result; (4) audio kept 30 days, transcript and summaries stay until the meeting is deleted; (5) the transcription provider may keep the written transcription for about 5 days after processing, in the EU or Switzerland, never for training, and deleting the meeting does not remove that copy (A6, AC-4.1, AC-4.12); (6) a Zoom, Teams or Meet recording banner does not cover this tool. Statements render as a list, not prose. Any change to a statement or to the announcement bumps the version, so an attestation given on the previous notice is answered `409 notice_outdated`.

### F4. Record in the browser (US-2, AC-2.2 to AC-2.11, AC-13.3)
1. Capture card (after F3): for `online` meetings a "What to record" radio group built from `capabilities.ts`
   (AC-2.4): "Microphone only" and, only where the browser supports it (Chromium), "Microphone and the audio of a shared
   browser tab". Where tab audio is unsupported the card says so and recommends uploading a recording; "Microphone
   only" stays selectable with the warning that remote voices are captured only if played through speakers. For
   `in_person`: microphone only, no radio.
2. **Start recording** (primary). Browser asks for the microphone (and, for the tab option, shows its own picker; hint text
   above the button: "Choose the tab with your meeting and tick Share tab audio"). Grant → `recording/start` →
   status `recording`; the page switches to the **Recording** panel. Denied / no device → Banner (danger, `role=alert`)
   naming what to change, meeting stays `draft`, and the alternatives are offered (F6, F7): **Upload a recording instead** and **Paste text instead**, which switch the source (F7b) (AC-2.3).
3. Recording panel: indicator "Recording" with `mic` icon and elapsed time; **Pause** (secondary) and **Stop and save**
   (primary). Pause → indicator "Paused" (`pause` icon), the Pause button becomes **Resume** (primary) and Stop becomes secondary
   (one primary at a time). Heartbeats continue invisibly.
4. Tab share ends / has no audio → `Banner tone="warning"` (alert) "The meeting audio is no longer being captured. Your
   microphone is still recording." (AC-2.5).
5. Connection lost → recording continues; `Banner tone="warning"` (alert, once) "Audio is not yet saved. It survives only
   while this tab stays open." plus a persistent indicator line "Audio not yet saved (about {n} s waiting)" until chunks drain;
   on reconnection a polite "Connection restored. Saving audio." (AC-2.9).
6. At 2 h 50 min: `Banner tone="warning"` (alert) "This recording stops by itself in 10 minutes (limit 3 hours)". At 3 h: it stops,
   saves, and the polite announcement "The recording reached 3 hours, was stopped and is being saved" is made (AC-2.11).
7. **Stop and save** → "Saving audio: 3 of 5" `ProgressBar` (determinate) + polite announcements at each 25 percent → `recording/stop`
   ok → status `processing` → the panel is replaced by the Processing panel (F9). The user may leave the page after that.
- Leaving mid-recording (AC-2.10): native `beforeunload` for tab close/reload; in-app navigation is blocked by the shell
  (`registerNavigationBlocker`, see § Shell and CRM touchpoints). Confirming stops and saves, then leaves.
- A second device (`409 recording_elsewhere`): `Banner tone="danger"` "This meeting is already being recorded on another
  device." The creator who opens a live meeting from another tab sees the "recorded elsewhere" state (below).
- Microphone lost mid-recording (device unplugged, permission revoked): not in an AC, but unhandled it is silent loss, so:
  the recorder goes to "Paused" with `Banner tone="danger"` "The microphone stopped. Reconnect it and choose Resume, or stop
  and save what was captured."; Resume re-acquires the device; Stop saves normally.

### F5. Interrupted recording (US-2, AC-2.8, AC-2.9, A1, A2)
Creator opens a meeting whose derived status is `interrupted` (closed tab, crash, 2 minutes with neither chunk nor
heartbeat). The page shows the **Interrupted** panel: `Banner tone="warning"` "Recording interrupted. {formatDuration}
was saved." plus, for the creator only: when `recording.lostMs` is a number above 0, "At least {n} of audio captured while offline was lost." (a lower bound); when `lostMs` is null (the server never received a
captured length) the fallback sentence "Audio captured while offline before the tab closed is lost."; `lostMs = 0` shows nothing (AC-2.9). Two actions:
**Process what was captured** (primary, `recording/process`) and **Discard** (danger → `ConfirmDialog tone="danger"`:
"Discard the captured audio? The meeting returns to draft and the audio is deleted now. This can't be undone." →
`recording/discard`). `409 audio_deleted` (chunks expired) → inline "The captured audio was deleted after 30 days and can't
be processed", only Discard stays. A meeting with no saved audio (`durationMs` 0) shows only Discard. Non-creators see an
info banner "This recording was interrupted. Its creator can choose to process what was captured." and no actions.

### F6. Upload a recording (US-3, AC-3.1, AC-3.2, AC-3.3)
After F3 (source `uploaded`): the **Upload** card. **Choose file** (`FilePicker`, NEW library) → client pre-check of type and
size and duration (`loadedmetadata`) → problems named on the field: "This file type isn't supported", "The file is larger
than 500 MiB", "The recording is longer than 3 hours", "The file has no audio track" (AC-3.2). **Upload and process**
(primary) → `ProgressBar` with percentage text and **Cancel upload** (ghost) → `upload/confirm` → `processing`.
Failure part-way (XHR error) → `Banner tone="danger"` "The upload failed. Nothing was processed." + **Try again**; the
meeting stays `draft` (AC-3.3). `422 upload_rejected {reason}` → the reason names itself on the field and the file is cleared.
**Cancel upload** → `Banner tone="info"` "cancelled" + **Try again**.
**Upload refused after the file was decoded (AC-3.2, A5/A6 era):** the server can refuse a file only once it has decoded it (today `too_long`, a duration over 3 hours the browser could not read). The meeting stays `draft` with `failure.code` set and the Upload card opens with a `Banner tone="warning"` with the polite live-region choice (`role="status"`, not an alert) titled "The last file you uploaded was removed" and a body naming the reason ("It was longer than 3 hours. Choose a shorter recording to try again."); an unknown code reads "It could not be accepted. Choose another file to try again.". There is **no Retry action**: the same file would be refused again, so the next step is simply to choose another file in the picker below. The banner disappears as soon as a new upload is minted (the page's copy of the meeting is only refreshed at confirm, so the card drops it locally), and it is not shown to anyone without `can.capture` or before consent.
A page reload loses the selected `File` (browsers cannot keep it); the card is simply empty again.

### F7. Paste text (US-3, AC-3.4)
Source `text`: the **Text** card (no consent). A `textarea` Field "Meeting text" with a live count "12,345 of 200,000
characters"; **Save text** (primary) → `PUT text` → `ready` → page shows the Transcript tab (passages, no times). Over the
limit → field error naming 200,000; empty → field error. The text cannot be replaced after saving (edits are per passage,
F8).

### F7b. Switching the source while still a draft (US-3 AC-3.5, AC-2.3; plan G1)
Only while `can.changeSource` (creator control, `draft`, no audio, chunk or text yet; consent alone does not lock). Offered in Edit details and as the denial / unsupported-browser alternatives in F4.
- recorded ↔ uploaded: the attestation is kept; no new consent step.
- to `text`: the attestation is cleared (text meetings carry none) and the dialog says so ("Pasting text needs no consent confirmation, so the confirmation is removed."); the Consent fact disappears.
- from `text` back to recorded/uploaded: consent is requested again (F3).
- `can.changeSource` false → Source is read-only text; a `409 source_locked` (state changed meanwhile) shows inline and refetches the meeting.
- Language is editable only while `can.changeLanguage`; otherwise read-only text "The language is fixed once processing has started" (AC-1.8).

### F8. Read, search, correct the transcript (US-6, AC-6.1 to AC-6.9)
Transcript tab: audio control (when audio is kept), search, Copy, Download text, speakers strip (creator: Rename), segment
list. Selecting a segment's time button plays the audio from there. The creator (not frozen) edits a segment inline
(Edit icon button → textarea → Save/Cancel, `If-Match`); `409/428` → `StaleWriteBanner` and Reload. After an edit the
segment shows an "Edited" badge and summaries made earlier show "Based on an earlier version of the transcript" (F10).
No speech: the tab shows `StatePanel` "No speech detected"; Summaries and Ask show their controls `aria-disabled` with the
same reason (AC-6.7). Speech that was detected but could not be transcribed is NOT this state: it is a `failed` meeting (F9), and
"No speech detected" is never shown for it.

**Transcript completeness, joins and caveats (A7, A8; spec AC-6.2, 6.6, 6.12, 6.15, 6.16, 7.13, 9.9; plan H-7).** A `ready`
transcript can carry three extra things, all on the Transcript tab: (1) a **possibly-incomplete notice** above the list with the
affected time ranges, plus a **gap marker** between the segments each range falls between, each with a Play control while audio is
kept; (2) a **parts notice** only when some later-part label stayed separate; (3) a **joined** note on each speaker label matched
automatically across parts, with **Separate by part** for the creator. The notice and markers are also the first lines and the
inline lines of Copy and Download text. Summaries and answers built from such a transcript carry a service-written label (see the
Summaries and Ask tabs); an answer's label leads back to the notice: **answer label -> Transcript tab -> notice focused**. No
automatic retry exists (A8), so the user is never shown "retrying"; the gap is simply marked.

### F9. Processing, failure, retry (US-6, AC-6.9, AC-6.10, AC-12.2)
`processing` shows the **Processing** panel: stage "Uploading" / "Saving audio" (client-side, while this tab is doing it),
"Preparing the audio", "Transcribing" (server `stage`), a `Spinner`, and "You can leave this page. We'll notify you when it's
ready." No ETA is shown (targets are budgets, not ACs). Polling is `GET /meetings/:id` every 5 s backing off to 30 s,
paused while the tab is hidden; sidebar navigation is never blocked. `failed` shows `Banner tone="danger"` with the
plain-language reason from `failure.code` and, while `can.retryProcessing`, **Try again** (primary). After audio deletion no
retry exists and the banner says why ("The audio was deleted, so this can't be processed again"); Delete meeting remains.
Failure reasons include `speech_not_transcribed` (AC-6.7, A7/A8): "Speech was detected in the recording but could not be
transcribed." (it: "Nella registrazione è stato rilevato del parlato, ma non è stato possibile trascriverlo."), with the same
**Try again** rule as every other reason (AC-6.9). A transcript with gaps is not a failure (it is `ready` with the notice), and
while any part is unsettled the meeting stays `processing` at stage "Transcribing" (AC-6.10/6.11).

### F10. Summaries (US-7, US-8, AC-7.1 to AC-7.12)
Summaries tab → **Generate summary** (primary) → `FormDialog`: template (grouped select), output language (radio, default
UI language), a read-only preview of the chosen template's sections → submit → the dialog closes, a `generating` summary card
appears first in the list and takes focus on its heading; polite "Generating summary…". The user may leave; on return the
card shows its current state. `ready` → polite "Summary ready". Per summary: **Copy as text**, **Regenerate** (new card, old
kept), and a "More" `Menu` with **Edit** and **Delete** (confirm). `failed` → inline `Banner tone="danger"` compact with
**Try again**. Stale → badge "Based on an earlier version of the transcript". The 21st is refused (the button is
`aria-disabled` at 20 with "20 of 20 summaries"; a server `409 summary_limit` shows the same text inline). Rate limit
`429` → inline error with the time to retry (AC-13.4).

### F11. Host notice failures (US-11 AC-11.9, US-14 AC-14.8, AC-14.10)
Creator only, never blocking: `Banner tone="warning"` (not dismissible) at the top of the meeting page. For event `linked` the text is the host's `labels.<lang>.noticeFailed` sentence, whole, in the UI language
(plan G7; for the CRM exactly AC-14.8: "The deal's activity could not be added"); for `changed` the generic meetings-ui sentence "The linked record could not be updated". Both with **Try again**
(`POST host-notice/retry`; busy; success → banner disappears, `Saved`). Not offered on a frozen meeting
(`can.retryHostNotice` false, AC-14.10).

### F12. Ask the meeting (US-9, AC-9.1 to AC-9.8)
Ask tab: heading, a privacy line ("Only you can see your questions and the answers"), the conversation (oldest first), the
composer. Send → in-flight `Spinner` turn "Thinking…" (≤ 60 s) → answer card labelled "AI-generated" with **Sources**. Selecting a
source switches to the Transcript tab, scrolls to, highlights and focuses the segment, and shows a **Back to the answer** link
that returns focus to the source button. "The meeting doesn't contain this" answers show no sources. When the transcript is marked
possibly incomplete, each answer also carries the label "Based on a transcript that may be incomplete" as a link: it switches to the
Transcript tab and focuses the notice (AC-9.9; keyboard path in the Accessibility section). Failure → the turn stays,
marked failed, with **Try again**; `429` → composer error with the time to retry. **Clear conversation** (ghost) → confirm.

### F13. Participants and who can read (US-5, AC-5.1 to AC-5.10)
Creator: **Edit participants** → `FormDialog` (large) → add Operai people from the directory and external people
(name, optional organisation), remove, **Save** (`PUT`, full replace). Then the **People and access** card shows the result and
the host-visible checkbox (when `hostVisibleOffered`). Turning it ON asks for confirmation (`ConfirmDialog tone="primary"`,
it widens the readership); turning it OFF applies directly with a polite confirmation.

### F14. Delete recording / delete meeting / erase (US-4, AC-4.5 to AC-4.8, AC-5.12)
- Delete recording (creator, audio kept): `ConfirmDialog tone="danger"`.
- Delete meeting (creator, or `meeting:erase` from the erase screen): `ConfirmDialog tone="danger"` with
  `acknowledgeLabel`; on success navigate to the list with `Saved` "Meeting deleted".
- Erase screen: search by title, creator, dates → rows with title, date, creator only → **Delete** (danger) per row → the same
  dialog naming title, date and creator.

### F15. My meetings, always reachable (US-10, AC-10.1 to AC-10.7)
Header user menu → My meetings (shell link) → list. A participant without `meetings:access` opens a meeting and reads transcript
and summaries only; every create/summarise/ask/edit control is absent (not disabled). `capabilities: 'unavailable'` (auth down)
hides capability controls and shows the authorization banner while reading still works (AC-10.6).

### F16. Frozen meeting (US-5, AC-5.11 to AC-5.13)
Everyone sees `Banner tone="info"` with `lock` icon: "Frozen: its creator's account is deactivated". Creator controls are absent
for everyone (`can.*` false). Authors still edit/delete their own summaries; entitled users still generate and ask. An erase
holder deletes it from the erase screen. Reactivation removes the banner on the next load.

### F17. Templates (US-8, AC-8.1 to AC-8.7)
Templates page: three groups (Personal, Shared, Built-in). Open one → read view; **Duplicate** (all kinds), **Edit/Delete**
where permitted. **New template** → editor page: name, scope (Personal; Shared only for `template:manage`), general instructions,
1 to 15 sections. Deleting or editing never changes existing summaries (stated in the delete dialog).

---

## Screens & states

State legend: **L** loading, **E** empty, **F** failed (retryable), **403**, **404**, **503**. "n/a" means the state cannot occur
for that screen. Server-driven states use the codes in plan.md § API contracts. Every `403` is `PermissionDenied`
(`StatePanel role="alert" focusOnMount`). Every `404` on a record is the identical `StatePanel`: title "Meeting not found",
body "It may have been deleted, or you may not have access to it." (the same words for "does not exist" and "not visible",
AC-5.3; nothing hints at which).

### S1. Meetings list (`/meetings`, `/my-meetings`) — AC-10.1, 10.2, 10.3, 10.5, 10.7
- `PageHeader` h2 "Meetings" / "My meetings"; actions: **New meeting** (primary, a `<Link className={buttonClassName(…)}>` in
  `./App`; in `./MyMeetings` an `<a>` that calls `navigateSuite('/meetings/new')`, shown only if `usePermissions()` has `meetings`).
  In `./App` the Templates tab is the `TabNav`; no secondary header action.
- Filters `Card` (title visually hidden): search by title (`type="search"`, debounced 300 ms, Enter searches now), Role
  (All, Creator, Participant), Status (All, Draft, Recording, Interrupted, Processing, Ready, Failed), Host app (All + `GET /hosts`
  labels), **Clear filters** (ghost, only when a filter is set). Changing a filter returns to page 1.
- `DataTable` caption "Meetings", columns: Title (`rowHeader`, `.link` to the meeting), Date (`formatDateTime`), Format, Host,
  Status (`StatusBadge`), Role (`Badge` neutral: Creator / Participant). Rows newest first (server order, no sortable columns).
  Host cell: "Deal · <title>" as a `.link` (via `navigateSuite`) when `state=open`; plain "CRM · deal" when `closed` or
  `unavailable`; "No longer available" (`text-soft`) when `missing`; "Standalone" when none (AC-10.3).
- `Pagination` (25 per page, offset with total; status line "Page 2 of 5 — showing 26-50 of 112" is the polite live region).
- States: **L** `Loading` ("Loading meetings…"). **F** warning `Banner` + Retry. **503** n/a for the list (self-scoped reads
  survive an auth outage); host-label failure degrades silently to "CRM · deal". **E-none**: `StatePanel` "No meetings yet" /
  "Meetings you create or take part in appear here." (the header already carries New meeting; no duplicate action). **E-filtered** (any of search, Role, Status, Host app set and the result empty):
  `StatePanel` "No meetings match" / "No meeting matches the filters you set. Change or clear them to see more." + **Clear filters** (secondary `Button`) in its action slot. **Clear filters** resets every filter and the search text, returns to page 1 and moves focus to the search field (the first filter, always present), never to `<body>` (the button that held focus is unmounted). The same action is also the ghost button in the filters card. **403** n/a. **404** n/a.

### S2. New meeting (`/meetings/new`) — AC-1.1, 1.2, 1.3, 1.5, 1.6, 11.6
- `PageHeader` "New meeting", back link "Back to meetings". One `Card` "Details" with `Field`s: Title (required, max 200),
  Format (`RadioGroupField`: In person, Online), Date and time (`DateTimeInput`, default now, required), Language
  (`RadioGroupField`: English, Italian; hint "The transcript is not translated"), Source (`RadioGroupField`: Record in the
  browser, Upload a recording, Paste text; each with a one-line hint, the first two note "asks you to confirm consent").
  Optional read-only "Linked to" fact when a host is set (never editable here).
  Footer: **Cancel** (ghost, left) and **Create meeting** (primary, right).
- A page, not a dialog: six fields plus a host line exceed "≤ 5 fields" (building-pages § 3).
- States: **L** (host lookup only) skeleton for the "Linked to" line while the form is already usable for a standalone meeting;
  **F** host `503` → warning banner (see F1); **host not found** → `StatePanel` (see F1); **422** field errors; **403**
  `PermissionDenied`; **404/E** n/a.

### S3. Meeting page (`/meetings/m/$id`, `/my-meetings/m/$id`) — the main screen
`PageHeader`: title = meeting title (h2, `focusableHeading` on arrival), `status` = `StatusBadge` (derived status), `description`
= "Format · date · Deal · <title>" (host link as in S1), `back` = list link. `actions` (creator, `can.edit`): **Edit details**
(secondary, `aria-haspopup="dialog"`); **Delete meeting** (danger, when `can.deleteMeeting`). A creator who lost `meetings:access`
(A4) sees only Delete meeting (and Delete recording in its card). At most one primary per view: whichever primary the active
panel offers (Start recording, Process what was captured, Try again, Generate summary); the header itself carries none.

Order of content (one column of `Card`s, h3 titles):
1. **Banners** (only those that apply, each its own `Banner`): authorization unavailable (`capabilities: 'unavailable'`, warning,
   Retry re-fetches the meeting), frozen (info, `lock`), host notice failed (warning, Try again), creator identity unknown
   (`frozen: null`, warning "We can't check whether the creator's account is active. Editing is unavailable for now." + Retry),
   stale-write (danger + Reload), `Saved`.
2. **Status panel** by derived status (S3a below).
3. **Details** card: `FactList` — Date and time, Format, Language, Source (Recorded / Uploaded / Text), Creator (live name; "Deleted
   user" when `status=deleted`, AC-5.10), Host ("Deal · <title>" link, "CRM · deal", "No longer available", or "Standalone"),
   Duration, Audio ("Audio kept until <date>" / "Audio deleted" / absent for `none`, AC-4.4), Consent ("Confirmed by <name> on
   <date>, notice <version>", AC-4.3; absent for `text`), Your access ("Creator" / "Participant" / "Because you can open <host
   label>"). Card `action`: none.
4. **People and access** card: participant list (Operai: name; "Deleted user" muted when deleted; External: name, organisation,
   `Badge` "External"; the creator first with `Badge` "Creator"), count "n of 30", **Edit participants** (card action, creator).
   Under it, for the creator when `hostVisibleOffered`: checkbox "Also visible to people who can open Deal · <title>" with the hint taken from the host's `labels.<lang>.visibilityHint`
   (a whole phrase per language, e.g. "and can see deal financials" / "e possono vedere i dati economici dell'opportunità"), so no host wording lives in meetings-ui. Host `missing`: checkbox is replaced by
   the sentence "Host-granted visibility ended because it is no longer available". A standalone meeting never shows it.
5. **Content tabs** (only when `ready`, S3b).
6. **Recording** card (creator, audio kept): "Audio kept until <date>" + **Delete recording** (danger, `sm`).

#### S3a. Status panels (one visible at a time, replaces card 5 until `ready`)
| Status | Who | Panel |
|---|---|---|
| `draft`, source recorded/uploaded, no consent | creator, `can.capture` | **Consent** card (F3) |
| `draft`, recorded, consent given | creator | **Capture options** + Start recording (F4); browser not capable (no `MediaRecorder`/`getUserMedia`, insecure context) → warning banner recommending upload, with **Upload a recording instead** / **Paste text instead** (F7b) |
| `draft`, uploaded, consent given | creator | **Upload** card (F6) |
| `draft`, text | creator | **Text** card (F7) |
| `draft`, creator without `can.capture` (not creator, or frozen, or no access) | others | `StatePanel` "Nothing captured yet" / "The creator hasn't added the content yet." |
| `recording`, live on this tab | creator | **Recording** panel (F4) |
| `recording`, live elsewhere | creator | `Banner tone="info"` "This meeting is being recorded in another tab or on another device. If that tab was closed, the status changes to Interrupted after about 2 minutes." + Refresh |
| `recording` | others | `StatePanel` "Recording in progress" / "The transcript appears when the recording is finished." (polling) |
| `interrupted` | creator / others | **Interrupted** panel (F5) |
| `processing` | everyone | **Processing** panel (F9) |
| `failed` | everyone | failure banner (F9) |
| `ready`, `noSpeech` | everyone | tabs render; Transcript shows "No speech detected" |
| `ready` | everyone | tabs (S3b) |

#### S3b. Tabs (`Tabs`, one page, `?tab=`) — Summaries · Transcript · Ask the meeting
Default tab: Summaries when the meeting has at least one, otherwise Transcript. A text meeting shows "Passages" in the Transcript
tab. The Ask tab is rendered only when `can.ask` or the caller already has conversation turns (AC-9.5: history stays readable
after a grant is removed); otherwise it is absent, not disabled (AC-10.4). Panels use `tabPanelProps`.

**Why tabs, not a stack of cards:** a 3-hour transcript is thousands of lines; a stack would bury summaries and Ask below it. The
cost is that citations cross tabs, which is solved by the focus/return pattern in F12.

**Transcript tab**
- Toolbar: search `Field` (`type="search"`, label "Search the transcript"), live count "{n} matches" (polite), **Copy** and
  **Download text** (secondary `sm`, `copy`/`download` icons) → `[hh:mm:ss] Name: text` lines (AC-6.6). For a possibly-incomplete transcript the
  text begins with the notice sentence, a blank line, then the lines, with `[Possible gap hh:mm:ss–hh:mm:ss]` on its own line at the same place
  as the marker on screen. Joined labels are already one name, so nothing else changes. Copy/Download report through the polite status line.
- Audio control (only `audio.state = 'kept'`): native `<audio controls>` with an `aria-label`, URL minted on first use and
  re-minted on a media `error`; a line "Audio kept until <date>". Absent once deleted (AC-6.5).
- **Possibly-incomplete notice (AC-6.12 a, c; plan H-7):** when the transcript has one or more gap ranges (`gaps.length > 0`, derived from the
  service's list, merged across part boundaries by the service), a `Banner tone="warning"` sits above the list, below the toolbar, before
  the parts notice. Text: "This transcript may be incomplete. Speech may be missing between hh:mm:ss and hh:mm:ss[, and between …]. The
  missing speech is not in the transcript and cannot be recovered from it." Under it, while audio is kept, a list ("Ranges where speech may
  be missing") with one item per range: the range in `font-mono text-xs` and a ghost `sm` **Play** button (`play` icon) that plays from the
  range start (same audio handle as a segment time button; absent once the audio is deleted, AC-6.5). It has no dismiss control, shows for
  everyone who can open the meeting, and is not removed by editing a segment. It is an anchor (`id`, `tabIndex={-1}`) for the answer label.
  **Decision (accessibility): the notice is a persistent condition of the page, not an event. It is NOT an assertive live region** — it must
  not interrupt a screen-reader user on arrival, and it must not be re-announced when the tab is re-opened; it is plain, reachable content
  read in document order, and the only time it takes focus is when a user asks
  for it (the answer label, below). The same applies to the parts notice. **As built:** the library `Banner` has an opt-in live-region choice (assertive, polite, off; defaults unchanged); the notice uses "off", so it renders as a plain `role="note"` named by an `aria-label` ("Transcript may be incomplete" / "La trascrizione potrebbe essere incompleta") instead of an alert.
- **Gap markers (AC-6.12 b):** between the segments a range falls between (before the first segment starting at or after the range start; after the
  last when none does) a non-list row: dashed `border-rule` top border, `alert` icon, text "Possible gap hh:mm:ss–hh:mm:ss" in
  `font-mono text-xs text-soft` (the icon is decoration, the words carry the meaning), and the same ghost **Play** button as the notice
  while audio is kept. A marker is not a list item: like a part divider it sits BETWEEN `<ol>`s, so the list is split there and the next list
  keeps the preceding label (WCAG 1.3.1). Markers are not editable and not searchable.
- **Multi-part transcript (AC-6.2, AC-6.15; plan G-3, H-7):** a transcript with `parts.length > 1` shows a divider "Part {n} · hh:mm:ss" before the
  first segment of every part after the first, chosen by the segment's own `part` (with overlapping parts, time cannot say which part a segment
  belongs to). Segments are one `<ol>` per run between dividers and markers; the divider is `role="separator"` with the same text as its
  `aria-label`, in `font-mono text-xs text-soft` over a `border-rule` top border, and the list after it takes that text as its `aria-label` (the
  first list keeps "Transcript", or "Passages" for text meetings). The **parts notice** is an info `Banner` above the list and is shown ONLY when
  `parts.length > 1` AND at least one later-part label stayed separate (`separateLabels`): "This recording was transcribed in {n} parts. Speakers
  could not always be matched between parts, so one person can appear under two labels. Rename them to the same name to merge them." It never
  says the labels are different people and never says speakers are "numbered separately"; when every later label is joined, or there is one
  part, it is absent (dividers stay). Not dismissible, not blocking, no live region. Merging separate labels is the existing Rename (no new control).
- **Joined labels (AC-6.2, AC-6.16):** in the speakers strip (see below) a label that covers several parts shows a `users` icon and the note
  "Matched automatically across parts 1–3" (`soft` text, parts collapsed to runs: "1–3", "1, 3"), so the join is never silent. A label that is
  separate and belongs to one part of a multi-part transcript shows a muted "(Part n)" suffix. A joined label reads as the earlier label everywhere
  (list, copy, download); Rename still applies to all its segments.
- Speakers strip: a labelled `<ul>` ("Speakers", `tabIndex={-1}` so it can take focus), shown to the creator (any label) and to other viewers only
  when at least one label is joined (so they can read the join note). Per label: name, the join note or "(Part n)" suffix, for the creator (not
  frozen) **Rename** (ghost icon button, `pencil`, `aria-label` "Rename {name}") → `FormDialog` (choose a participant or enter free text; "Back to
  Speaker n" option) applied to all segments (AC-6.2), and, for a joined label only, **Separate by part** (secondary `sm`,
  `aria-haspopup="dialog"`, `aria-label` "Separate by part: {name}") → `ConfirmDialog tone="primary"` (not danger: nothing is lost) titled
  "Separate by part?", body "Each part’s speech gets its own label. They keep the name “{name}” until you rename them. This cannot be undone.",
  **Separate** / Cancel, busy "Separating…". After success the transcript is read again (segments of later parts now carry other keys) and focus
  moves to the speakers strip, because the opener no longer exists. Failure keeps the dialog open with the mapped message; `409 not_joined` /
  `not_ready` means the page is out of date: the dialog closes and the stale-write banner offers Reload. Non-creators and frozen meetings never see
  either button (the API answers 403 / 409 regardless, AC-6.16).
- Segment list `<ol>`: per row a time `Button` (ghost `sm`, `font-mono`, `aria-label` "Play from {spoken duration}"; text meeting: no
  time), the speaker label, the text (search hits wrapped in `Highlight`), an "Edited" `Badge`, and for the creator an Edit icon
  button (`aria-label` "Edit segment at {time}"). Inline edit: `textarea` + **Save** / **Cancel**, hint "Summaries made earlier will
  be marked as based on an earlier version", `If-Match`.
- The cited segment gets `bg-acc/10` + `border-l-acc` + `aria-current="true"` and a visually hidden "Cited passage" prefix, not colour alone.
- States: **L** `Loading` (the transcript is fetched when the tab first opens, then cached); **F** warning banner + Retry; **E** `noSpeech`
  `StatePanel` "No speech detected"; **403/404** n/a (inherited from the page); **503** n/a (selfScoped).
- Performance note for implementation: a 3-hour transcript can be thousands of rows; render all rows first, measure, and window only
  if needed. Search counts and highlights are computed over the data, never over the DOM.

**Summaries tab**
- Toolbar: "n of 20 summaries" and **Generate summary** (primary) when `can.summarise`; `aria-disabled` with the reason when the
  meeting has no speech or has 20 summaries (the user must reach it to learn why). Absent for read-only participants.
- Newest first, one `Card` per summary (title = template name; h3): badges row — "AI-generated" (`sparkle`), language, "Edited"
  if edited, "Based on an earlier version of the transcript" if `stale`, and, when the transcript was possibly incomplete (AC-7.13), a warning `Badge`
  with the `alert` icon "Based on a transcript that may be incomplete" (service-written, ready summaries only) followed by a `text-xs text-soft` line
  "Speech may be missing between: hh:mm:ss–hh:mm:ss, …"; both are part of Copy as text (AC-7.11); a regenerated summary carries them too; meta line "by <author> · <formatDateTime>"; body = sections
  in order, each an h4 heading + plain text (`whitespace-pre-line`, never Markdown); a `notDiscussed` section renders its server text
  in `text-soft` (for an incomplete transcript the service writes "Not found in the transcript, which may be incomplete" there; the UI shows the
  text as given and never composes it). Actions row: **Copy as text** (secondary `sm`), **Regenerate** (secondary `sm`, when `can.summarise`), `Menu`
  "More actions" with **Edit** and **Delete**. Each control's visibility comes from the summary's own `can: { edit, delete, retry }` (plan G4) and is never re-derived in the UI: Edit if `can.edit`, Delete if `can.delete`, **Try again** on a failed summary if
  `can.retry`; Copy always; Regenerate follows the meeting's `can.summarise`. An empty "More actions" menu is not rendered.
- `generating`: `StatusBadge` + `Spinner`, "Generating…", no text. `failed`: compact danger `Banner` + **Try again**, **Delete** stays.
- Inline edit (author or creator, entitled): headings read-only, each body a `textarea`, **Save** / **Cancel**, focus to the first
  textarea on open and back to the card heading on close; `409/428` → `StaleWriteBanner`.
- Generate dialog (`FormDialog`, size md): `Field` Template as a native `<select>` with `<optgroup>`s in the AC-8.5 order
  (Recommended for <host entity>, Personal, Shared, Built-in), `RadioGroupField` Output language, a read-only `<ol>` preview of the
  template's section headings (`aria-live="polite"`). Errors inline in `.form-error`: `summary_limit`, `no_speech`, `not_ready`,
  `ai_rate_limited` (time to retry via `formatDateTime`), `503` "Permissions can't be checked right now".
- States: **L** `Loading`; **F** banner + Retry; **E** `StatePanel` "No summaries yet" / "Generate one from a template to get started."
  (the toolbar carries the action; read-only participants get "No summaries yet."); **403/404/503** n/a.

**Ask tab**
- Conversation `<ol>` oldest first, in a scrollable region labelled "Your conversation with this meeting". Each turn: the question
  (`text-text`, labelled "You"), then the answer: "AI-generated" badge, plain text, **Sources** list of buttons "00:12:34 · Speaker 2" (text
  meeting: "Passage 3"). When the answer's `possiblyIncomplete` is set, a `link` with the `alert` icon "Based on a transcript that may be incomplete" sits beside the
  "AI-generated" badge (AC-9.9; it activates the Transcript tab and focuses the notice, F12); a `notInMeeting` answer shows the service's sentence
  (which already says the transcript may be incomplete) with that label, and no sources. `failed` → compact danger `Banner` + **Try again**. `pending`
  older than 2 minutes reads failed (server).
- Composer (only `can.ask`): `Field` + `textarea` "Your question" (1-1,000, live count), **Ask** (primary); Ctrl/Cmd+Enter sends, Enter inserts
  a newline (stated in the hint, so no keyboard trap or accidental send). While in flight the composer is busy, the question text stays.
  `aria-disabled` with the no-speech reason when `noSpeech`.
- **Clear conversation** (ghost, when there are turns) → `ConfirmDialog tone="danger"`: "Clear your conversation? Only you can see it;
  this removes it for you and can't be undone."
- States: **L** `Loading`; **F** banner + Retry; **E** `StatePanel` "Ask this meeting a question" / "Answers use only this meeting's
  transcript and show where they come from." (composer visible below); **403** n/a; **503** from asking → inline composer error.

#### S3c. Dialogs on the meeting page
| Dialog | Component | Notes |
|---|---|---|
| Edit details | `FormDialog` | title, date and time, format; language only while `can.changeLanguage` (else read-only text with the reason, AC-1.8); source only while `can.changeSource` (F7b, with the clears-consent note when choosing text); **Remove link** checkbox when a host is set (linking and relinking happen from the host panel, F1b). `409 language_locked`/`source_locked` inline. |
| Edit participants | `FormDialog` size lg | see S4 |
| Rename speaker | `FormDialog` | participant select or free text, 1-100 |
| Separate by part | `ConfirmDialog tone="primary"` | creator only, joined labels only, irreversible; see the speakers strip (AC-6.16) |
| Generate summary | `FormDialog` | see Summaries tab |
| Confirm host-visible on | `ConfirmDialog tone="primary"` | "Everyone who can open Deal · <title> and sees its sensitive details will be able to read this meeting, including the transcript." |
| Delete summary / Clear conversation / Delete recording / Discard captured audio | `ConfirmDialog tone="danger"` | each states what stays ("The transcript and summaries stay") |
| Delete meeting | `ConfirmDialog tone="danger"` + `acknowledgeLabel` | lists what is deleted: audio, transcript, summaries, every person's questions, the participant list, and the entry on the linked record; "This can't be undone." (AC-4.6). Acknowledge is used because the loss also hits other people's copies. |
- `503 storage_unavailable` on any delete → inline dialog error "Nothing was deleted. Try again." (the dialog stays).

### S4. Edit participants dialog — AC-5.1, 5.4, 5.9
`FormDialog` size lg, title "Edit participants", description "People you add can read everything in this meeting, including what is
already there. Operai people are notified." Content: **Add an Operai person** (`PersonPicker`, NEW library, `clearOnSelect`, excludes already chosen
ids; directory without `appId` narrowing because a participant needs no tool grant), **Add an external person** (Name required 1-100 + Organisation
optional ≤ 100 + **Add** secondary button), then the current list, each row with a **Remove** icon button (`aria-label` "Remove {name}"). Counter
"n of 30"; at 30 both adders are `aria-disabled` with the limit text. Errors: `participant_not_active {index}` names that person inline;
`too_many_participants`; `identity_unavailable 503` → form error "We can't verify people right now. Try again."; directory `429` → picker message
with seconds; directory `403` is not expected (every employee holds the gate) but renders "You can't pick people". Focus after Remove moves to the next
Remove button, else the Operai picker.

### S5. Recording panel details — AC-2.2, 2.5, 2.6, 2.9, 2.11, 13.3
- A single `Card` "Recording". Top row: indicator `Badge` (accent + `mic` icon + "Recording" text, or neutral + `pause` + "Paused"), elapsed time
  (`font-mono`, `role="timer"`, `aria-label` "Elapsed time", not announced), save status line ("All audio saved" / "Saving…" / "Audio not yet saved
  (about {n} s waiting)"). Controls: Pause/Resume + Stop and save. Connection/tab-share/limit banners stack below.
- After **Stop and save**: controls disabled, `ProgressBar` "Saving audio: {n} of {m}"; a `409 chunks_missing` keeps retrying the missing chunks
  with the same bar and an error line if it stalls ("Some audio could not be saved. Keep this tab open while we retry.").
- Session errors: `session_inactive`, `404` (meeting deleted by an eraser while recording) → recorder stops, in-memory audio is dropped, `StatePanel`
  "This meeting is no longer available" (404 copy) with the back link.
- Nothing about the recording is written to IndexedDB, localStorage, sessionStorage or CacheStorage (AC-4.11); a design consequence is that offline audio
  survives only while the tab is open, which the indicator says in words (A2).

### S6. Host panel inside the CRM deal page (`./HostMeetings`) — AC-11.2, 11.3, 11.6, 11.7
- `Card` titled "Meetings", `action` slot holds **Start meeting** (secondary `sm`, an `<a>` + `navigateSuite`) and **Link an existing meeting** (secondary `sm`, `aria-haspopup="dialog"`), both only when `usePermissions()` has `meetings`.
  Placed by crm-ui between `AttachmentsCard` and `ActivityTimeline`. Company page unchanged (AC-11.7).
- `ListRows` (rows are `<a className={listRowClassName} href="/my-meetings/m/<id>">`): left, title and meta line "<formatDate> · <creator>";
  right, `StatusBadge` and "{n} summaries" in `font-mono`. `Pagination` only when `total > 25`.
- States: **L** `Loading` (rows) inside the card; **E** `StatePanel` "No meetings yet" / "Meetings started from this deal appear here." with
  action **Start meeting** for holders (AC-11.2); **F** meetings-api failure or `503` → card keeps its title and shows `Banner tone="warning"` "Meetings are
  unavailable right now" + Retry; the rest of the deal page is unaffected (AC-11.6); `hostReadersUnavailable: true` → compact info `Banner` "Some meetings
  can't be shown right now. Meetings you created or took part in are listed." and **no count of hidden meetings anywhere**; **403/404** n/a.
- **Link dialog (F1b).** `Dialog` size md; search `Field` (title, debounced), a radio group of rows, `Pagination` (offset), footer Cancel (ghost) + **Link meeting** (primary; enabled once a row is chosen; `busy` during the PATCH, when the
  dialog cannot be dismissed). Errors from the PATCH stay inline in `.form-error`. Focus: first the search field; on success to the new row; on cancel back to the **Link an existing meeting** button.
  States: **L** `Loading` rows; **E** `StatePanel` "No meetings to link" / "Only meetings you created, that aren't frozen and aren't already on this {entity}, can be linked." (Cancel closes); **F** compact warning `Banner` + Retry;
  **403** `PermissionDenied` inside the dialog; **503** the authorization banner + Retry (the list route makes no host call, so a host outage only shows at link time, as in F1b); **404** on link (meeting deleted meanwhile) → inline
  "That meeting is no longer available" and the list refreshes.
- **Extension fallbacks** (owned by crm-ui, its own copy; `HostExtension` renders them on import failure, 5 s timeout, missing export or render
  throw): while loading the remote, the `loading` node (card + skeleton); on failure, the `fallback` node (card + `Banner tone="info"` "Meetings are unavailable.
  Reload the page to try again."). No retry button, because a failed module import is cached.

### S7. Templates list (`/meetings/templates`) — AC-8.1 to AC-8.5
- `PageHeader` "Templates", description "Templates shape the sections of a summary", **New template** (primary link). Three `Card`s in the AC-8.5 order:
  Personal, Shared, Built-in; each a `DataTable` (caption per card): Name (`rowHeader` link), Sections (count, numeric), Type (`Badge`: Personal, Shared,
  Built-in), Updated (`formatDate`, absent for built-in). Built-in names show in the UI language.
- States: **L** `Loading`; **F** banner + Retry; **E** per card: personal "You have no personal templates" (body offers duplicating a built-in one),
  shared "No shared templates"; built-in is never empty; **403** (no `meetings:access`) `PermissionDenied`; **404/503** `503` → authorization banner.

### S8. Template view and editor (`/templates/$id`, `/templates/new`, `/templates/$id/edit`)
- **View**: `PageHeader` title = name, `status` = type `Badge`, back "Back to templates"; actions: **Duplicate** (primary for built-in and others' shared; secondary
  otherwise), **Edit** (secondary, when permitted), **Delete** (danger, when permitted). Cards: "Details" (`FactList`: type, general instructions) and "Sections" (ordered
  list of heading + instruction). Built-in or not-editable: `Banner tone="info"` "Built-in templates can't be edited. Duplicate it to make your own." / "Only template
  managers can edit shared templates."
- **Duplicate**: built-in → `FormDialog` with an Output-language radio (the copy is written in that language, AC-8.4); other kinds duplicate directly and open the
  copy's editor with `Saved` "Copy created. Rename it and adjust the sections."
- **Editor**: `Card` "Details" — Name (required, ≤ 80), Scope (`RadioGroupField` Personal / Shared; Shared offered only with `template:manage`; fixed and shown as
  a fact when editing), General instructions (`textarea` ≤ 2,000, count). `Card` "Sections" — `SectionsEditor` (NEW library): 1-15 rows each Heading (≤ 80) and
  Instruction (≤ 500), Move up / Move down / Remove icon buttons, **Add section**, row numbers; errors per row and for the list ("Add 1 to 15 sections").
  Footer: Cancel (ghost) + Save (primary). `PATCH` requires `If-Match` (plan G8): `409 version_conflict` / `428` → `StaleWriteBanner` (danger, "This template changed since you opened it") with **Reload**, which refetches the template and replaces the form values with the fresh ones
  (the user is told their unsaved edits were discarded); `409 template_name_taken` → Name field error; a `403` on a shared template → `PermissionDenied`; validation on submit with
  focus to the first invalid field.
- **Delete** → `ConfirmDialog tone="danger"`: "Delete this template? Summaries already made from it are not changed."
- States: **L**, **F** (retry), **404** (identical not-found `StatePanel`, "Template not found"), **403**, **503** authorization banner; saving shows `busy`.

### S9. Erase (`/meetings/erase`, `meeting:erase` only) — AC-4.7, 4.8, 5.12
- `PageHeader` "Erase meetings"; `Banner tone="info"` always visible: "You can find and delete meetings here. You can't read their content." Filters `Card`: Title,
  Creator (`PersonPicker`, optional), From, To (`DateInput`). `DataTable` caption "Meetings that can be erased": Title, Date, Creator, and a **Delete** (danger `sm`) action
  cell. No title link, no transcript link. `Pagination`.
- Delete → `ConfirmDialog tone="danger"` + `acknowledgeLabel`, body names title, date and creator. Success → row removed, polite "Meeting deleted", focus to the table
  caption. Idempotence: a row already gone (`404`) is treated as success.
- States: **L**, **F** retry, **E** "No meetings match", **403** `PermissionDenied` (also hides the tab), **404** n/a, **503** `Banner` authorization unavailable.

### S10. Not found for the remotes
`*` inside either router → page-level `StatePanel` "Page not found" with a link back to the list (as `crm-ui`'s `NotFoundPage`).

### S11. Cross-cutting error mapping (one function, `lib/errors.ts`, problem `code` to a strings key)
`consent_required`, `not_draft`, `recording_elsewhere`, `wrong_source`, `session_inactive`, `duration_limit`, `chunk_missing`, `chunks_missing`, `upload_incomplete`,
`upload_rejected` (+ `reason`), `unsupported_type`, `too_large`, `audio_deleted`, `audio_unavailable`, `not_failed`, `not_ready`, `no_speech`, `summary_limit`, `ai_rate_limited`,
`language_locked`, `source_locked`, `host_visible_unavailable`, `host_not_registered`, `host_entity_not_found`, `host_unavailable`, `participant_not_active`, `too_many_participants`,
`identity_unavailable`, `storage_unavailable`, `template_name_taken`, `builtin_readonly`, `creator_only`, `frozen`, `meetings_access_required`, `author_only`, `version_conflict`,
`precondition_required`, `notice_outdated`, `consent_not_applicable`. Unknown codes fall back to the Problem `detail`. A `403` with `frozen`/`creator_only`/`meetings_access_required`
shows an inline message (these can occur if state changed under the user) and refetches the meeting so `can` flags catch up.

---

## Component inventory

Library in use: **`@operai/ui`** (`operai-ui/`, ADR-0050) with Tailwind token utilities (ADR-0051); source: `AGENTS.md`, `operai-ui/src/index.ts`. State/data helpers
mirror crm-ui's `LoadState` as thin app adapters (copy bound to strings), not a copied component.

### REUSE (library, existing)
| Element | Component |
|---|---|
| Tool frame, tabs-as-pages | `ToolLayout`, `TabNav`, `tabLinkClassName` |
| In-page views on the meeting page | `Tabs`, `tabPanelProps` |
| Page header, back link | `PageHeader` + `.link` + `Icon arrow-left` |
| Detail sections, filters, composer | `Card`, `FactList` |
| Meeting list, erase list, template lists | `DataTable`, `Pagination` |
| Deal panel list | `ListRows`, `listRowClassName`, `listRowMetaClassName` |
| Statuses / flags | `StatusBadge`, `Badge` |
| All feedback | `Banner`, `StatePanel`, `SkeletonRows`, `Spinner`, `VisuallyHidden live` |
| Buttons, link-as-button | `Button`, `buttonClassName` |
| Forms | `Field`, `RadioGroupField`, `CheckboxGroupField` (not needed), `DateTimeInput`, `DateInput`, `focusFirstInvalid` |
| Dialogs | `FormDialog`, `ConfirmDialog`, `NoticeDialog` (not needed), `Dialog` |
| Per-summary menu | `Menu`, `MenuItem` |
| Picker base | `Combobox` (inside the new `PersonPicker`) |
| Icons | `Icon` (existing: `sparkle`, `copy`, `download`, `upload`, `trash`, `search`, `refresh`, `lock`, `users`, `message`, `pencil`, `arrow-up`, `arrow-down`, `plus`, `close`, `alert`, `info`, `external`) |
| Formatting, i18n | `formatDate`, `formatDateTime`, `formatRelative`, `formatNumber`, `selectStrings`, `catalogGaps`, `useFocusOnMount`, `cx` |

### NEW — library (`operai-ui`, each with a story and a test; a second app can use them)
| New component | Why nothing fits | Used by |
|---|---|---|
| **`ProgressBar`** (determinate with value/label, and indeterminate; `role="progressbar"`, text alternative as a prop) | Library has `Spinner` and `Skeleton` only; the plan already expects it | upload progress, "Saving audio n of m"; refund/crm file uploads can adopt |
| **`formatDuration(ms, { style: 'clock' \| 'spoken' })`** in `lib/format.ts` (clock `hh:mm:ss`; spoken uses `Intl.DurationFormat` with a fallback) | The only formatters are date/money/number; AGENTS forbids hand formatting | timer, segment times, citations, aria-labels, duration facts |
| **`Icon` additions: `mic`, `pause`, `play`, `stop`** | Recording controls and the recording indicator need glyphs; the rule forbids Unicode icons | recording UI; also the shell sidebar entry for the tool (`mic`) |
| **`FilePicker`** (visually hidden `<input type="file">` + `Button` + selected-file line with name and size + clear + `Field` wiring, `accept`) | The pattern is hand-written in four apps (`crm-ui` Attachments/Letterhead, `refund-ui` AttachmentList, `inventory-ui` InvoiceFilePanel) and not in the library; this is the fifth | upload; the four existing copies migrate in a separate change |
| **`PersonPicker`** (a `Combobox` over an injected `load(): Promise<Person[]>`, client-side filter by name or email, `exclude`, `clearOnSelect`, rate-limit message, all copy as props) | `crm-ui/src/components/PersonPicker.tsx` is a second implementation; library components can't call app APIs, so the loader is injected | participants, erase creator filter; crm-ui migrates in the same change to avoid a third copy |
| **`SectionsEditor`** (ordered `{heading, body}` rows, move up/down, remove, add, min/max, per-row errors, `renderRowExtra` slot) | `crm-ui/src/components/SectionsEditor.tsx` is the same shape but carries an offer-specific "costs section"; the generic part moves to the library, crm keeps its marker through the slot | template editor; crm offer templates adopt later |

### NEW — meetings-ui only (domain-specific, no second consumer; all built from library pieces)
| Component | Justification |
|---|---|
| `MeetingPage` + `StatusPanels` | The screen itself; shared by `./App` and `./MyMeetings` |
| `ConsentCard` | Versioned consent notice and announcement; meeting-specific legal copy |
| `RecordingPanel` + `capture/*` | MediaRecorder controller, mixing, chunk uploader; no other tool records audio |
| `UploadCard`, `TextCard`, `ProcessingPanel`, `InterruptedPanel` | Capture and processing states of one domain object |
| `TranscriptView`, `SegmentRow`, `Highlight`, `AudioControl`, `SpeakerRenameDialog`, `SeparateSpeakerDialog` (a `ConfirmDialog` wrapper that calls the API and maps its errors), `exportText` (pure text/marker/range helpers, not a component) | Transcript rendering; `Highlight` is a `<mark className="bg-acc/20 text-text">` wrapper (the browser's default yellow `mark` is not a token) |
| `SummariesPanel`, `SummaryCard`, `SummaryEditor`, `GenerateSummaryDialog` | Domain content; plain-text rendering rule (ADR-0067) |
| `AskPanel`, `Turn`, `Composer`, `Sources` | Domain content |
| `ParticipantsCard`, `EditParticipantsDialog`, `ExternalParticipantForm` | Domain model |
| `TemplatesPage`, `TemplateViewPage`, `TemplateEditorPage` | Domain screens (built on the library `SectionsEditor`) |
| `ErasePage` | Domain screen |
| `HostMeetings` | The federated panel (`./HostMeetings`) |
| `LoadState` adapters (`Loading`, `LoadFailure`, `Saved`, `StaleWriteBanner`, `PermissionDenied`) | Copy-binding adapters on `Banner`/`StatePanel`, same as every other tool |

**Ratio:** about 34 library pieces reused, 6 NEW library additions (counting the four icons as one), 11 groups of meetings-ui-only components. Nothing duplicates an existing component
under another name; the two "NEW" library items that overlap crm-ui (`PersonPicker`, `SectionsEditor`) are extractions, not parallel inventions.

---

## Accessibility

Applies to every screen: one h1 (tool title from `ToolLayout`), one h2 per page (`PageHeader`), h3 for cards, h4 for summary section headings; never skip a level.
A page that replaces content (404, denied, not found) takes focus on its heading (`StatePanel focusOnMount`). Every icon-only button has an `aria-label`. Focus ring is the
library's. Dialogs use the library's focus trap and return focus to the opener; the opener has `aria-haspopup="dialog"`.

### Recording (AC-13.3, AC-2.2, AC-2.9)
- Keyboard: Start, Pause/Resume and Stop are native `<button>`s in DOM order Start/Pause → Stop. Space/Enter activate. No global shortcuts (they collide with screen readers).
- Focus: on Start, focus moves to Pause; Pause and Resume are the same element (label changes) so focus is not lost; on Stop focus moves to the "Saving audio" status
  container (`tabIndex={-1}`); when processing begins, to the Processing panel heading.
- Live regions: one polite `role="status"` region announces "Recording started", "Recording paused", "Recording resumed", "Saving audio: 3 of 5", "Recording saved, processing
  started", "Connection restored, saving audio". Time-critical items use `Banner` (`role="alert"`): mic denied, tab share ended, offline (once), 10-minute warning, microphone lost.
  The elapsed timer is `role="timer"` (not live) so it does not chatter every second.
- Not colour alone: the indicator is icon + text + elapsed time; Paused is a different icon and word.
- No animation is needed for the indicator, so `prefers-reduced-motion` has nothing to turn off; the progress bar's indeterminate mode stops under reduced motion.
- `beforeunload` is the browser's own dialog; the in-app blocker's dialog is the shell's `ConfirmDialog` with focus on the safe choice (stay).

### Meeting page, tabs and dialogs
- `Tabs`: one tab stop, arrows/Home/End; changing tab by a citation sets the tab and moves focus to the target segment (`tabIndex={-1}`), and "Back to the answer" restores focus to
  the source button that was activated.
- Processing and generation: polite live region on state change ("Transcript ready", "Summary ready", "Summary failed"); never a focus steal.
- `aria-disabled` (not `disabled`) for Generate/Ask when no speech or at the limit, with the reason in `aria-describedby`; hidden entirely for controls the caller may never use.
- Transcript completeness and parts (A7/A8): **the possibly-incomplete notice is a persistent condition, not an alert.** It is not an assertive live region and not a
  `status` that announces itself: a screen-reader user meets it in document order when they reach the Transcript tab, and it is never re-announced on re-open or on
  polling. It is `tabIndex={-1}` so it can be focused programmatically, and it does so only when the user asked for it (the answer label). It is not dismissible, so there is
  no close control and no state to lose. The parts notice is plain static text with the same rules. Colour is never the only cue: the notice says "may be incomplete", each marker
  says "Possible gap" with the `alert` icon as decoration only, and each part divider says "Part 2 · 01:00:12".
- Gap markers and dividers are not list items: the list is split into one `<ol>` per run, a divider is `role="separator"` with an accessible name, and each list after it carries the same
  name, so a screen-reader user can jump list by list. A marker is a plain row whose text is its name; its Play button is a native `<button>` in DOM order after the text, with `aria-label` "Play from {spoken
  duration}" (the range start, same label pattern as a segment time) and the visible word "Play". The notice's range list uses the same buttons, in a labelled `<ul>` ("Ranges where speech may be missing"). Both are absent
  when the audio is deleted (no disabled placeholders).
- Answer label to notice: the label on an answer is an `<a>` (reads as a link, "Based on a transcript that may be incomplete"). Activating it switches to the Transcript tab (tab change by keyboard or pointer) and moves focus to the notice
  (`tabIndex={-1}`), scrolled to its start; one focus move, no live announcement. Focus lands on content the user chose to go to, so it reads the notice text; there is no "back to the answer" link for this path (the citation path keeps its own).
- Joined note and Separate by part: the join note is text next to the label (not a tooltip). The **Separate by part** button names the label ("Separate by part: {name}") because several can be on screen; the dialog uses the library focus trap with
  Cancel as the first focusable control and returns focus to the opener on cancel; on success the opener is gone, so focus goes to the speakers list (`tabIndex={-1}`, labelled "Speakers") and the changed labels are read from it. A failure message
  is `.form-error role="alert"` inside the dialog, which stays open.
- Speech detected but not transcribed: the `failed` banner is the existing danger `Banner` (alert is right: it is an outcome the user must act on), with **Try again** while `can.retryProcessing`.
- Consent: the six statements are a list; the tick box keeps its visible label; the saving state and copy confirmation are polite `role="status"`; a failed save is `role="alert"`.
- Refused upload banner: `Banner tone="warning"` with the live-region choice "polite" (`role="status"`, not an alert, nothing is lost by reading it late); it sits above the file picker so keyboard order is notice → picker → Upload.
- Filtered-empty list: **Clear filters** moves focus to the search field (see S1).
- Search: label "Search the transcript"; the match count is a polite live region; highlights are `<mark>` with a token tint plus the count (not colour alone).
- Segment time buttons: `aria-label` "Play from 12 minutes 34 seconds" (spoken duration), visible text `00:12:34` in mono; the audio element has an `aria-label`.
- Edit inline: focus to the textarea on open; on Save, to the row's edit button; on Cancel, to the same; a stale-write banner takes focus.
- Participant dialog: Remove buttons are labelled with the person's name; after removal focus goes to the next Remove button or the picker; the count is polite.
- Delete confirmations: `ConfirmDialog` focuses Cancel; destructive ones state consequences in the body; `acknowledgeLabel` checkbox before Confirm for Delete meeting.
- Contrast: all text is `text-text`/`text-soft`/`*-text` tokens; `--muted` is never text; "Not discussed" is `text-soft`.
- Axe pass on the capture page, the meeting page (ready) and the list is a test requirement (plan AC-13.3). Both themes checked in Storybook for the new library pieces.

### Lists and forms
- `DataTable` with sr-only caption, `scope`, `rowHeader` link; `Pagination` nav landmark with a polite status; filter changes announce the result count through that status.
- Forms: `Field` wiring, `required` via `aria-required`, submit failure moves focus to the first invalid field; non-field errors are `.form-error role="alert"`.

### Deal panel (a federated component inside another app's page)
- Link dialog: native radio group labelled "Meetings you can link", arrow keys move the choice, Link meeting is `aria-disabled` until one is chosen with the reason in `aria-describedby`; the result count is a polite status; focus returns to the opener on cancel and to the new row on success.
- Card title is an h3 under the deal page's h2; rows are links with descriptive text (title first); the empty state and the unavailable banner are announced politely/assertively respectively;
  the fallback in crm-ui has the same heading so the page outline does not change when the remote fails.

---

## Shell and CRM touchpoints (UI only)
- **Shell**: `TOOLS` entry "Meetings" with sidebar icon `mic`; UserMenu link "My meetings"; `/my-meetings/$` ungated; navigation-blocker dialog (generic copy owned by the shell: title "Leave this
  page?", body = the message meetings-ui registers, "Leave" / "Stay", `ConfirmDialog tone="primary"` with focus on Stay). The message meetings-ui registers: "A recording is in progress. If you leave, it
  stops and is saved, then processed."
- **notify-ui and ToastHost** show the Italian variant under `<html lang="it">` (ADR-0065); no new screen.
- **crm-ui**: Meetings card on the deal page (S6); `ActivityItem` renders `activity.meeting` as an "Open meeting" `.link` (body is null, AC-14.2); a reader without access lands on the meeting
  not-found state (AC-14.4) which, by design, reveals nothing.

---

## Copy keys plan (en + it)

`meetings-ui/src/strings.ts`: `const en = {…}`, `const it: typeof en = {…}`, `export const strings = selectStrings({ en, it })`; parity test (`catalogGaps(en, it)` is `[]`) and the
no-hard-coded-copy scan over every `.tsx`. Sentence case. Sentences with values are functions. The library gets every label as a prop.

| Group | Contents (examples) |
|---|---|
| `common` | retry, reload, cancel, close, save, edit, delete, copy, copied, back, loading, none, dismiss, you, deletedUser, ai ("AI-generated"), authUnavailable {heading, body}, staleWrite {title, body}, loadErrorTitle |
| `nav` | toolTitle, myMeetings, tabs {meetings, templates, erase}, userMenuLink |
| `list` | heading, myHeading, newMeeting, caption, columns, filters {search, role, status, hostApp, clear, any}, host {standalone, noLongerAvailable, open(label,title), plain(app,entity)}, empty {none, filtered}, pagination status(page,total,…) |
| `status` | meeting {draft, recording, interrupted, processing, ready, failed}, summary {generating, ready, failed}, roles {creator, participant, hostReader} |
| `form` | heading, fields {title, format, startsAt, language, source}, format {in_person, online}, language {en, it}, source {recorded, uploaded, text} + hints, submit, hostLine(label), hostNotFound {title, body, standalone}, hostUnavailable {…}, errors |
| `detail` | facts {date, format, language, source, creator, host, duration, audio, consent, access}, audio {keptUntil(date), deleted}, consentLine(name,date,version), access {creator, participant, viaHost(label)}, frozen, creatorUnknown, notFound {title, body}, recordingElsewhere, recordingInProgress |
| `consent` | version (constant `2026-11-05`, bumped on any text change), title, intro, statements[6] (told and agreed; AI transcription and summary in the EU or Switzerland; who can read; audio kept 30 days; the provider's bounded copy of the transcription, about 5 days; platform banner does not cover this tool), announcementTitle, announcementHint, announcementText, copyAnnouncement, copied, copyFailed, confirmLabel, continue, busy, outdated {message, reload} |
| `capture` | options {title, micOnly, micAndTab, tabHint, unsupportedTab, micOnlyWarning, uploadRecommended}, start, pause, resume, stop, indicator {recording, paused}, elapsed, save {allSaved, saving, notSaved(seconds), progress(n,m)}, denied {title, body}, noDevice, tabEnded, offline, restored, limitWarning, autoStopped, elsewhere, micLost, unsupportedBrowser, leaveMessage, announcements {started, paused, resumed, stopped, saved} |
| `upload` | title, hint(limits), choose, problems {unsupported_type, too_large, too_long, no_audio, empty}, rejectedUnknown, refused {title, reasons {too_long}, unknownReason}, submit, cancel, cancelled, failed, retry, finishing, size, announcements |
| `text` | title, label, count(n,max), errors {empty, tooLong}, save |
| `processing` | stages {uploading, saving, preparing, transcribing}, leaveNote, failure {audio_unreadable, provider_unavailable, provider_rejected, too_long, audioDeleted}, retry, interrupted {title, body(duration), lostOffline(duration), lostOfflineUnknown, process, discard, discardConfirm, expired, observer} |
| `transcript` | tab, parts {banner(n), divider(n, start)}, incomplete {notice(ranges), rangesLabel, marker(from,to), play}, joined {note(parts), part(n), separate, separateLabel(name)}, separate {title, body(name), confirm, busy, notJoined},  passages, search, matches(n), copy, download, noSpeech, speaker(n), rename, renameForm, playFrom(spoken), edit, editedBadge, editHint, citedPassage, filename |
| `summaries` | tab, incomplete {label, ranges(ranges)}, count(n,max), generate, empty, limit, generating, failedRetry, staleBadge, editedBadge, byline(author,when), notDiscussedFallback, regenerate, more, editAction, deleteAction, deleteConfirm, dialog {title, template, language, groups {recommended(entity), personal, shared, builtin}, preview, submit}, copySummary |
| `ask` | tab, incompleteLabel, privacy, empty, composer {label, hint, send, count}, thinking, answerLabel, sources, passage(n), notInMeeting, failed, clear, clearConfirm, rateLimited(retryAt) |
| `people` | title, edit, dialog {title, description, addOperai, addExternal, name, organisation, add, remove(name), count(n,max), limit, errors}, external, creatorBadge, visibility {label(hostLabel), hint, confirmTitle, confirmBody, ended} |
| `delete` | recording {title, body, confirm}, meeting {title, body(list), acknowledge, confirm}, saved, storageFailed |
| `templates` | heading, new, groups {personal, shared, builtin}, columns, types, empty, view {…, builtinReadOnly, sharedReadOnly}, duplicate {…}, editor {fields, sections {…limits}, errors}, deleteConfirm, saved |
| `erase` | heading, notice, filters, columns, delete, confirm(title,date,creator), deleted |
| `host` | panel {title, start, link, linkDialog {title, search, submit, moveNote(from,entity), empty {title, body}, errors}, empty {title, body}, rowMeta(date,creator), summaries(n), unavailable, readersUnavailable, loading}, notice {changedFailed, retry}; `linkedFailed` and `visibilityHint` are NOT in the catalog, they come from `GET /hosts` labels |
| `errors` | the S11 code to message map |
| `a11y` | liveRegion announcements not shown elsewhere |

Quoted ACs that must read exactly (en / it):
| Key | en | it |
|---|---|---|
| indicator.recording | Recording | In registrazione |
| indicator.paused | Paused | In pausa |
| save.notSaved | Audio not yet saved. It survives only while this tab stays open. | Audio non ancora salvato. Resta disponibile solo finché questa scheda rimane aperta. |
| audio.keptUntil(d) | Audio kept until {d} | Audio conservato fino al {d} |
| audio.deleted | Audio deleted | Audio eliminato |
| frozen | Frozen: its creator's account is deactivated | Bloccata: l'account di chi l'ha creata è disattivato |
| noSpeech | No speech detected | Nessun parlato rilevato |
| staleBadge | Based on an earlier version of the transcript | Basata su una versione precedente della trascrizione |
| ai | AI-generated | Generato dall'IA |
| noLongerAvailable | No longer available | Non più disponibile |
| host.open | Deal · {title} | Opportunità · {title} |
| host.plain | CRM · deal | CRM · opportunità |
| interrupted.process / discard | Process what was captured / Discard | Elabora quanto registrato / Scarta |
| host label `noticeFailed` (from `GET /hosts`, CRM) | The deal's activity could not be added | Non è stato possibile aggiungere l'attività all'opportunità |
| host label `visibilityHint` (from `GET /hosts`, CRM) | and can see deal financials | e possono vedere i dati economici dell'opportunità |
| notice.retry | Try again | Riprova |
| people.visibility.label(host) | Also visible to people who can open {host} | Visibile anche a chi può aprire {host} |

Consent notice and announcement drafts (legal wording belongs to the data-protection lead, O3; any wording change bumps `consent.version`):
- en announcement: "This meeting is being recorded. The audio will be transcribed and summarised by AI, processed in the EU or Switzerland, and the result will be available to me and to the participants.
  If anyone objects, please say so now and I will stop the recording."
- it announcement: "Questa riunione viene registrata. L'audio sarà trascritto e riassunto da un'IA, elaborata nell'UE o in Svizzera, e il risultato sarà disponibile a me e ai partecipanti.
  Se qualcuno non è d'accordo, lo dica ora e interromperò la registrazione."
- Statement 5 (provider copy, A6): "The transcription provider may keep the written transcription for about 5 days after processing, in the EU or Switzerland and never for training. Deleting the meeting does not remove that copy: it expires on its own."
- Statement 6 (platform banner): "A recording banner shown by Zoom, Teams or Meet does not cover recording made with this tool."
- Parts copy (en / it): "Part {n} · {start}" / "Parte {n} · {start}"; the banner text is quoted in S3b.
- Refused upload (en / it): title "The last file you uploaded was removed" / "L'ultimo file caricato è stato rimosso"; reason `too_long` "It was longer than 3 hours. Choose a shorter recording to try again." / "Durava più di 3 ore. Scegli una registrazione più breve per riprovare."
Notification texts (AC-12.5) are owned by meetings-api's catalog (en + it with the notify `it` variant), not by meetings-ui.

---

## AC coverage

UI surface per spec requirement (all 14 user stories). ACs whose observable outcome is backend-only or an absence, so no screen is designed:
AC-4.9, AC-4.10 (startup refusal, logging), AC-11.1, AC-11.4 (registry; the screens render any host from `/hosts` data), AC-11.7 (the company page has no panel), AC-11.10, AC-12.3, AC-12.4
(no email), AC-13.2 (language choice is the form field; no translation step), AC-5.12/5.13 (behaviour of S9 and the banner), AC-14.2 to AC-14.6, AC-14.9, AC-14.11 (CRM reconciliation; AC-1.7, AC-14.1 and AC-14.7 "later link / relink" have the F1b surface; UI otherwise only renders
the "Open meeting" link and the creator-facing failure banner). AC-4.8 (no role reads content) is shown only as the erase screen's notice.

A7/A8 surfaces: AC-6.2/6.15 (parts notice rule, joined and "(Part n)" labels), AC-6.6 (copy/download with notice and markers), AC-6.7 (`speech_not_transcribed` failure reason, never "No speech detected"), AC-6.12 (notice, ranges, markers, Play),
AC-6.16 (joined note, Separate by part), AC-7.13 (summary badge + ranges), AC-9.9 (answer label + link to the notice). AC-6.11/6.13/6.14/6.17 and the text of "Not found in the transcript, which may be incomplete" are service behaviour, shown as given.

UI added that no AC asks for (small, droppable, flagged; the host-panel link dialog is not in this list, it is the surface AC-1.7, AC-11.8 "later" and AC-14.1 "or later linked" require): (1) a confirmation before turning host-visible ON (consequential widening of readership, design-system rule for consequential
decisions); (2) the "Your access" fact (explains why a host reader can see the meeting); (3) the "Back to the answer" link after a citation jump (focus return); (4) the "recording elsewhere" and
"microphone lost" states (necessary failure paths); (5) "Clear filters"; (6) the confirmation before Separate by part (AC-6.16 does not ask for one; it is irreversible); (7) the muted "(Part n)" suffix on a separate label (helps tell two labels of one person apart). Not designed because no AC asks (report only): a microphone level meter, previous/next match buttons in search, drag-and-drop
upload, an unsaved-changes guard on the template editor, extra disclaimer lines beside "AI-generated".

---

## Sync 2026-11-05 (eval round 3)

design.md was brought in line with spec amendments A5/A6, plan § Amendment 2026-11-05 (G-3, G-11) and the built meetings-ui. Changed: F3 and the `consent` copy keys (six statements, notice `2026-11-05`), F6 (refused-upload warning, cancel), F8/S3b (multi-part transcript), S1 (filtered-empty focus), a11y notes, copy plan. No new NEW component: the banner, divider and refused notice are `Banner`, a `role="separator"` element and `StatePanel`/`Button` from the library and existing meetings-ui files (`ConsentCard`, `TranscriptView`, `UploadCard`).
Divergences found, reported rather than designed around: (a) plan G-11 specifies the `parts` contract but no field carrying a refused upload on a draft meeting; the code reads `meeting.failure.code` on a `draft` for it (`too_long` only), which the spec's AC-3.2 allows but no plan section states; (b) the Upload card's client problem `empty` ("The file is empty") has no AC; (c) plan G-3 asks for a divider only; the code also names each later part's `<ol>` and exposes the divider as `role="separator"` (an accessibility addition, consistent with AC-13.1).

## Sync 2026-11-05 (A7/A8, T122/T123, QE defect D2)

design.md was brought in line with spec A7/A8 (AC-6.2, 6.6, 6.7, 6.12, 6.15, 6.16, 7.13, 9.9), plan § Amendment #2 H-6/H-7 and the built meetings-ui (`TranscriptView`, `SeparateSpeakerDialog`, `exportText`, `SummaryCard`, `Turn`, strings). Changed: F8/F9/F12, S3b Transcript, Summaries and Ask tabs, S3c dialogs, the accessibility section (the A5 "transcript parts" line is replaced), component inventory (two meetings-ui files), copy plan, AC coverage. No new library component: `Banner`, `ConfirmDialog`, `Button`, `Badge`, `Icon` (`alert`, `play`, `users`).
Divergences found, reported rather than designed around: (a) resolved as built: the possibly-incomplete notice needed a non-assertive banner, and the library `Banner` gained an opt-in live-region choice (575e5bd; defaults unchanged); the notice uses "off" (`role="note"` with an `aria-label`) and the refused-upload warning "polite" (`role="status"`) (a2a3656); (b) `strings.transcript.separate.notJoined` ("These labels are already separate.") is unused dead copy, not a defect: a `409 not_joined` closes the dialog and shows the stale-write banner; (c) AC-6.16 asks for no confirmation, the build adds one (kept, flagged above); (d) the answer label is an `<a href="#meetings-transcript-incomplete">` that also switches tabs, so the hash is only a fallback; (e) the summary label is a static badge, no link to the notice, as AC-7.13 asks for the label and ranges only.

## Gaps found in the spec or plan — resolved

All nine were decided on 2026-11-04 and folded into `plan.md` § "Amendments 2026-11-04 (design stage)". The ACs are unchanged. Where each lands in this design:

| Gap | Resolution (plan) | Design |
|---|---|---|
| G1 source lock | locks only on audio/chunk/text; text clears the attestation; `can.changeSource`, `can.changeLanguage` | F7b, F4 step 2, S3 Edit details |
| G2 link later / relink | host panel "Link an existing meeting" via `GET /hosts/:app/:type/:id/linkable-meetings` + `PATCH host`; unlink stays on the meeting page | F1b, S6 (action + link dialog states) |
| G3 offline loss | `capturedMs` + creator-only `recording.lostMs` (lower bound or null) | F5 |
| G4 per-summary flags | summary `can: { edit, delete, retry }` | Summaries tab |
| G5 UI permission hints | `apps` and `{resource, action}` pairs are hints only | Conventions, S9 |
| G6 visibility hint | `labels.<lang>.visibilityHint` from `GET /hosts` | S3 People and access, copy plan |
| G7 notice failed copy | `labels.<lang>.noticeFailed` whole sentence from `GET /hosts` | F11, copy plan |
| G8 template concurrency | `PATCH /templates/:id` requires `If-Match` | S8 editor conflict state |
| G9 directory without `appId` | participant picker unfiltered | S4 |

Remaining note for implementation: the registry carries only the `linked` failure sentence, so the `changed` one is a meetings-ui string; add `noticeChangedFailed` to the host labels if a host-specific one is wanted.

## Self-critique (one pass)

Checklist: missing states, unjustified or duplicate NEW components, flow/AC mismatches, accessibility as prose.
- Fixed: Template list had no explicit 404/503 handling; S7/S8 now state them. The Ask tab's `503` path (asking while auth is down) was only implied; stated in S3b. `ProgressBar`, `formatDuration` and the four icons were
  not tied to a consuming AC; each is now tied to F4/F6.
- Fixed: `PersonPicker` and `SectionsEditor` initially looked like duplicates of crm-ui components; reworded as extractions with an explicit migration decision rather than new parallel components.
- Revision after the plan amendments: F1b and the link dialog (S6) added with all states; F4/F5/F7b/F11, S3, S8 and the summaries/people sections updated to G1-G8; the gaps section is now a resolution table. One check in that pass found
  the old "Gap G" pointers still in the text; all removed.
- Kept: the Italian copy beyond the AC-quoted strings is left to the implementation catalog under the parity test; the `changed` notice sentence is generic (see the note above).
