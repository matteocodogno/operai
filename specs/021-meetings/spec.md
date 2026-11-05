---
id: 021
slug: meetings
status: in-progress
rigor: production
created: 2026-11-04
approved: 2026-11-04
---

# Meetings — record, transcribe, summarise and question meetings from anywhere in Operai

> **Positions and owner decisions.** The request left several choices open. Positions of
> this draft, confirmed or amended by the owner on 2026-11-04:
> 1. **Capture** is in the browser (microphone, plus the audio of a shared browser tab where
>    the browser allows it), an uploaded recording file, or pasted text. Meeting bots,
>    calendar integration and native apps are non-goals.
> 2. **Consent** is an explicit attestation by whoever records, recorded on the meeting, and
>    it is enough: there is no per-company "do not record" flag (owner decision).
>    Audio is short-lived; transcripts and summaries live until the meeting is deleted.
> 3. **Visibility** is by participation: the creator and the Operai participants. A creator
>    may opt a meeting in to "everyone who can open the host entity"; default off. This
>    ships in this release (owner decision).
> 4. **Access** is a gated tool (`meetings:access`, granted to every employee by default)
>    plus an ungated **My meetings** page so that a participant can always read what was
>    captured about them (ADR-0034, ADR-0045 shape). A participant without
>    `meetings:access` is read-only (owner decision).
> 5. **Hosts** are generic (app + entity type + entity id). Only the CRM deal exists today.
>    A host may opt in to being told about the lifecycle of meetings linked to its entities;
>    the CRM does, and logs a "meeting" activity on the deal (owner decision).
> 6. **Q&A** covers one meeting, cites transcript passages, and is private to the asker.
> 7. **Languages** are Italian and English only. **Limits** are as proposed (3 h, 500 MiB,
>    30 participants, 20 summaries, 30 AI requests per hour, 30 days of audio).
> 8. **A meeting whose creator is deactivated is frozen**, not orphaned (US-5).

## Amendments

2026-11-04, source: plan gate (plan.md § Proposed spec amendments), all four accepted by the
owner.

- **A1 (AC-2.8).** A meeting in `recording` reads as `interrupted` only when it has received
  neither audio nor keep-alive for 2 minutes, so a long pause is not an interruption.
- **A2 (AC-2.8, AC-2.9, AC-4.11).** The 30-second loss bound covers audio captured while
  connected. Audio captured while offline survives only as long as the tab does, because
  AC-4.11 forbids keeping audio on the device.
- **A3 (AC-11.8, AC-14.6, AC-14.7).** The `unlinked` and `deleted` host notices carry no title
  or date-time, so nothing with a title outlives a deletion (AC-4.6).
- **A4 (AC-5.8, AC-10.4).** A creator who no longer holds `meetings:access` can read the
  meeting and delete it or its recording, and nothing else.

2026-11-05, source: user decision on the provider change (plan.md § Amendment 2026-11-05
(provider change: Google Cloud), G-0 to G-17, Q1, Q2 and A5). The spec stays vendor-neutral; the
provider change itself needs no AC edit. Two amendments follow; the body below is already
updated.

- **A5 (AC-6.2, Domain language, Non-goals).** A long recording may be transcribed in parts,
  with speakers numbered separately in each part; speaker labels from different parts are
  merged by renaming. New term **transcript part**. (AC-6.2 and the matching non-goal are
  narrowed again by A7.)
- **A6 (Constraints, AC-4.1, AC-4.6, AC-4.9, new AC-4.12, O2, O3, new O13).** The owner
  **accepts** that the transcription processor may keep the transcription result of a
  recording for up to about 5 days (the documented retention of an asynchronous transcription
  result). The earlier hard constraint "the processor must not retain submitted content beyond
  the request" is narrowed to one bounded exception: the transcription result, within the EU
  or Switzerland, with no training use, and nothing else. Audio handed to the processor,
  summarising and answering keep the no-retention rule. What wellD's own side still guarantees
  is now AC-4.12. The consent notice must disclose the exception (AC-4.1), so its version
  bumps; attestations already recorded keep the version they were given under (AC-4.3). The
  contract confirmation is the tracked item O13.

2026-11-05 (later), source: user decision on the outcome of the real-provider spike (plan.md
§ T107 spike outcome, 2026-11-05; ADR-0067, ADR-0070). The spike found that the transcription
provider takes at most 20 minutes per request (so a long recording is transcribed in parts of
about 10 minutes), restarts speaker numbering in every part, and sometimes silently omits or
duplicates speech within a part; and that the chosen language model does not accept a forced
structured reply. The spec stays vendor-neutral; the body below is already updated.

- **A7 — approved by the user 2026-11-05, incl. AC-6.16 and the AC-6.7 failed outcome (AC-4.12, AC-6.2, AC-6.6, AC-6.7, AC-6.9, AC-6.10, new AC-6.11 to AC-6.17, AC-7.9,
  new AC-7.13, AC-9.6, new AC-9.9, Domain language, Constraints, Non-goals, O13, new O14).**
  (a) A part whose transcript is **detectably incomplete** (a gap of missing speech, or
  repeated speech) is transcribed again automatically, a bounded number of times; if a gap
  remains, the meeting is `ready` with its transcript **marked possibly incomplete**: a notice
  on the transcript, the affected time ranges, markers at those places, the same in the copy
  and download, and a label on every summary and answer built from it (AC-6.11, AC-6.12,
  AC-6.6, AC-7.13, AC-9.9). Speech returned twice appears once (AC-6.13).
  (b) **Speaker continuity across parts**: consecutive parts overlap, and a speaker label of a
  later part is joined to a label of the earlier part **only when the transcript text of the
  overlapping audio gives clear evidence**; otherwise the labels stay separate. This replaces
  A5's "never carried over". Continuity is never decided from voice characteristics (AC-6.14,
  AC-6.15, AC-6.17), and a wrongly joined label can be separated again by the creator
  (AC-6.16). The non-goal on matching speakers across parts is narrowed accordingly.
  (c) The transcript-parts notice of A5 changes its copy and its condition (AC-6.15).
  (d) **Structured replies from the AI**: a reply that does not have the structure the
  service requires is a failure, never partial text. No AC named a mechanism (forced or not),
  so only AC-7.9 and AC-9.6 gain one clause that states this outcome.

2026-11-05 (latest), source: user decision on the outcome of the T124 real-provider spike
(plan.md § H-3, T124 note). The spike found that the transcription provider is deterministic
(re-sending the same part returned a byte-identical result, 8 of 8 retries), so a retry costs
money for no gain; that repetition-only parts were retried although duplicate removal already
handles them; that AC-6.13 twice removed real speech when two different speakers said the same
8 words about 2 seconds apart; and that a repeated tail of a part whose words carry no times
was not removed. The spec stays vendor-neutral; the body below is already updated.

- **A8 — decided by the user 2026-11-05 (AC-6.7, AC-6.9, AC-6.10, AC-6.11, AC-6.12, AC-6.13,
  Domain language, Constraints, O13, O14, new O15).** (a) **Per-part retries are disabled for
  now (retry bound 0):** a part with a gap is not transcribed again; the gap is marked exactly
  as before (AC-6.12 notice, AC-7.13 and AC-9.9 caveats unchanged). A repetition never counts
  as "detectably incomplete". This supersedes the retry behaviour of A7(a); the user wants to
  move on and refine with production data (O15). (b) **Duplicate removal is same-speaker
  only:** two passages are the same speech only if they also carry the same speaker label, or
  one or both carry none (AC-6.13). (c) **A repeated tail of a part whose words have no times**
  is removed when its text matches the preceding text of the part by at least the repeat bound
  in consecutive words, still keeping any speech found in only one version (AC-6.13).

## Problem

wellD's consultants and salespeople hold many conversations that matter: discovery calls
with prospects, project syncs, 1:1s. They happen in a room or on Zoom, Teams or Google Meet.
What was said and agreed lives in personal notes, in memory, or in recordings each platform
keeps in its own cloud, outside Operai's permissions and possibly outside the EU. Taking
notes by hand costs attention during the call and is uneven afterwards; a colleague who
takes over a deal cannot see what the client said; nobody can ask "what did they say about
the budget?" without re-listening. The people recorded have no record that they were.
The conversation belongs next to the work it is about (today the CRM deal; later projects
and HR 1:1s), and also in one personal list.

## Domain language

New terms; see the glossary candidates returned with this spec.

- **meeting** — one conversation captured in Operai: metadata, one source, a transcript,
  any number of summaries, and each participant's private question-and-answer history.
- **creator** — the Operai user who created the meeting. Exactly one; always has access
  while their account is active.
- **participant** — a person who took part: an **Operai participant** (an active account) or
  an **external participant** (a name, optionally an organisation; never an account).
- **host** — an Operai app that lets users start and list meetings about its own records
  (today: CRM, entity type `deal`). **Host reference** = `{app, entity type, entity id}`.
  A meeting has at most one. **Standalone** = no host reference.
- **host notice** — the message a host that opted in receives when a meeting linked to one of
  its entities is linked, changed (title, date-time), relinked, unlinked or deleted. It
  carries the meeting id, the event and the creator id; the linked and changed notices also
  carry title and date-time, the unlinked and deleted notices never do. Never content.
- **source** — how the content got in: `recorded` (in the browser), `uploaded` (a file) or
  `text` (typed/pasted). Exactly one per meeting.
- **recording** — the audio of a `recorded` or `uploaded` meeting; **retained audio** is the
  copy still kept. Video images are never kept.
- **transcript** — the meeting as text, in **segments** (start time, **speaker label**, text).
- **transcript part** — a span of one recording that is transcribed as one unit and has its
  own speaker numbering. A short recording is one part; a long one may be several, and
  consecutive parts **overlap**: the same stretch of audio, at least the overlap bound
  (Constraints), is transcribed in both. Not a part of a meeting: a meeting has exactly one
  source (AC-3.5). (A5, A7)
- **gap** — a stretch of the recording in which there is speech but the transcript has none
  (speech the transcription silently omitted), at least the gap bound long. (A7)
- **possibly incomplete transcript** — a `ready` transcript that still has at least one gap
  after transcription (AC-6.11, AC-6.12; no automatic retry since A8). Never a claim that the
  other parts are complete. (A7, A8)
- **joined label** — a speaker label of a later transcript part that the overlap gave clear
  evidence for treating as the same speaker as a label of the earlier part, and so carries
  that label (AC-6.14). A label that is not joined is **separate**. (A7)
- **summary** — an AI-generated text produced from the transcript through a **template**.
- **template** — an ordered list of sections (heading + instruction) used to shape a
  summary: **built-in**, **shared** (company-wide) or **personal** (private to one user).
- **conversation** — one user's private question-and-answer history with one meeting.
- **consent attestation** — the creator's recorded confirmation, before audio is captured or
  uploaded, that the people in the meeting were told and agreed.
- **host-visible** — a creator's opt-in making a meeting readable to those who can open its
  host entity (and hold what the host requires).
- **frozen meeting** — a meeting whose creator's account is deactivated (US-5).
- **meeting activity** — the CRM activity of type `meeting` that a host notice creates on a
  deal (US-14).
- **meeting status** — `draft`, `recording`, `interrupted`, `processing`, `ready`, `failed`.

## Constraints

Binding rules that already exist in the suite or are imposed by the nature of the data;
this spec does not choose vendors or mechanisms.

- Data residency (`AGENTS.md`): audio, transcripts, summaries and conversations are stored in
  the EU. Every processing step on them (transcription, summarising, answering) happens in
  the EU or Switzerland (working assumption, see O3). Any third-party processor must
  contractually not use submitted content to train models, and must not retain it beyond the
  request: a hard constraint, with **one bounded exception accepted by the owner on 2026-11-05
  (A6)**: the transcription step may keep the **transcription result** of a recording (the
  text, not the audio) for up to about 5 days, still in the EU or Switzerland and still with
  no training use. Nothing else is excepted: the processor keeps no copy of the audio, and
  summarising and answering keep no prompt or answer. Audio handed to the transcription
  processor is held only in storage wellD controls (AC-4.12). A retention longer than about
  5 days, or any other retention, is not covered by the exception and returns to the owner
  (O13). Provider choice is the architect's, bounded by this.
- Copy exists in English and Italian (`it: typeof en` parity); dates and durations use the
  library formatters; ids and dates in API contracts are ISO 8601.
- Sign-in, tool access and live permission resolution follow ADR-0007 / ADR-0014; a failure of
  the authorization service never turns into an allow.
- Processing time (how long a recording takes to become a transcript, how long a summary
  takes) is a target the architect sets in plan.md; it is deliberately not an acceptance
  criterion of this spec.
- **Transcript quality bounds (A7).** The rules of AC-6.11 to AC-6.15 are decisions of this
  spec; the numbers below are bounds that the architect confirms or changes in plan.md, and
  the ACs hold with whatever values are confirmed. **Overlap bound:** consecutive transcript
  parts overlap by at least 30 seconds and at most 2 minutes. **Gap bound:** 20 seconds of
  speech in the audio with no transcript text. **Retry bound: 0 (A8)** - a part is
  transcribed once and never again automatically, because the provider returns the identical
  result for identical audio; raising the bound again is O15. **Repeat bound:** 8 consecutive words, and a time
  distance of 2 seconds. **Match bound:** 20 matched words. A stretch of non-speech sound
  (music, noise) is not speech for the gap bound.
- **Continuity evidence is text only (A7).** Whether two speaker labels of different parts are
  the same speaker is decided only from the text, the labels and the times that the
  transcription returned for the overlapping audio. Nothing derived from voice
  characteristics (voiceprints, voice embeddings, acoustic similarity) may be computed,
  stored or sent for this purpose: it would be biometric processing of personal data
  (GDPR art. 9) that this spec does not ask for. Where the evidence is not clear, labels stay
  separate: a false merge puts one person's words in another's mouth in the transcript and in
  every summary and answer built from it, while a false split costs one visible rename
  (ADR-0070).

## User stories

### US-1: Start a meeting, from a host or on its own
As a wellD employee with meetings access, I want to start a meeting from the record I am
working on (today a CRM deal) or from the Meetings tool, so that the meeting is filed where
it belongs without retyping context.

**Acceptance criteria:**
- AC-1.1: Given a user with `meetings:access` and `crm:access` viewing a deal, when they choose
  "Start meeting" on the deal page, then the new-meeting form opens with the title prefilled
  with the deal's title and the host reference set to that deal, shown as "Deal · <title>".
- AC-1.2: Given a user with `meetings:access` in the Meetings tool, when they create a meeting
  without choosing a host, then the meeting is standalone.
- AC-1.3: Given the form, when title (1-200 characters), format (`in_person` | `online`),
  meeting date-time, language (Italian or English) or source is missing or invalid,
  then nothing is created and the invalid fields are named. The date-time defaults to now and
  may be set in the past.
- AC-1.4: Given a user without `meetings:access`, then the "Start meeting" control is absent
  in every host, the tool is absent from navigation, and a create request is refused with 403.
- AC-1.5: Given a host reference to an entity that does not exist or that the caller cannot
  open, when a meeting is created, then it is refused with the same answer in both cases and
  nothing is created.
- AC-1.6: Given a host reference naming an app or entity type that is not a registered host,
  when a meeting is created, then it is refused with 422 and nothing is created.
- AC-1.7: Given a meeting, when its creator changes or removes the host reference, then the
  new entity must be one the creator can open (AC-1.5 applies), host-granted visibility
  (AC-5.5) follows the new reference on the next request, and the old and new hosts are told
  (AC-11.8).
- AC-1.8: Given a meeting, then only its creator can edit title, date-time, format and host
  reference; the language is fixed once processing has started.

### US-2: Record a meeting in the browser
As a meeting creator, I want to record in person or an online meeting from my own computer,
so that I need no bot, no platform recording and no extra software.

**Acceptance criteria:**
- AC-2.1: Given a `recorded` meeting, when the creator has not completed the consent
  attestation (US-4), then no audio capture is requested from the browser and no recording
  can start.
- AC-2.2: Given a completed attestation, when the creator starts recording, then the browser
  asks for the microphone, and on grant the status is `recording` and a visible indicator
  (text and icon, not colour alone) shows "Recording" with the elapsed time.
- AC-2.3: Given the microphone is denied or no input device exists, when the creator starts
  recording, then no recording starts, the meeting stays `draft`, the message says what to
  change, and uploading a file or pasting text is offered.
- AC-2.4: Given an `online` meeting, when the creator opens the capture options, then the
  screen lists what this browser can do (microphone only; microphone plus the audio of a
  shared browser tab) before recording. If the browser cannot capture the other participants'
  audio, the screen says so and recommends uploading a recording; microphone-only stays
  selectable with a warning that remote voices are captured only if played through speakers.
- AC-2.5: Given a recording that includes a shared tab, when the share ends or the tab has no
  audio, then the creator is told that the meeting audio is no longer captured, and the
  microphone keeps recording.
- AC-2.6: Given a recording, when the creator pauses, then the indicator reads "Paused",
  nothing is captured, and the transcript contains nothing from the paused time. Resuming
  continues the same recording.
- AC-2.7: Given a recording, when the creator stops it, then the status becomes `processing`
  only after all captured audio is saved; until then the screen shows save progress.
  Afterwards the creator may leave the page.
- AC-2.8: Given a recording interrupted by a closed tab, a browser crash or a lost
  connection, then at most the last 30 seconds of audio captured while connected are lost
  (audio captured while offline is covered by AC-2.9), and the next time the creator opens
  the meeting its status is `interrupted`, with the duration kept, offering "Process what was
  captured" or "Discard". A meeting in `recording` that has received neither audio nor a
  keep-alive for 2 minutes reads as `interrupted` (derived on read, never written by a
  sweep); a paused recording whose tab is still open is not interrupted, however long the
  pause.
- AC-2.9: Given a connection lost while the tab stays open, then recording continues, the
  indicator says audio is not yet saved and that it survives only while this tab stays open,
  and saving resumes automatically on reconnection. If the tab closes or crashes before
  reconnection, the audio captured while offline is lost (AC-4.11 forbids keeping it on the
  device); the creator is told how much when they next open the meeting.
- AC-2.10: Given a recording or unsaved audio, when the user navigates or closes the tab, then
  the browser asks for confirmation first.
- AC-2.11: Given a recording that reaches 3 hours, then it is warned 10 minutes before,
  and at 3 hours it stops by itself, is saved, and is processed. Only one device can record a
  given meeting at a time; a second attempt is refused with a message.

### US-3: Upload a recording, or paste text
As a meeting creator, I want to bring in a recording made elsewhere (a Zoom, Teams or Meet
cloud recording, a phone memo) or type up notes, so that I can use the tool when I could not
record in the browser or when people declined to be recorded.

**Acceptance criteria:**
- AC-3.1: Given a completed attestation, when the creator uploads an audio or video file of at
  most 500 MiB and 3 hours, then the meeting becomes `processing` and only its audio is used;
  no video image is kept.
- AC-3.2: Given a file that is of an unsupported type, over the size or duration limit, or
  without an audio track, then it is refused before processing with the reason named, and the
  meeting stays `draft`.
- AC-3.3: Given an upload that fails part-way, then the creator sees the failure and can
  retry; the meeting is never left in `processing` with an incomplete file.
- AC-3.4: Given a `text` meeting, when the creator pastes or types up to 200,000 characters,
  then it becomes the transcript with no timestamps, no consent attestation is asked, and
  summaries and questions work as for any other meeting.
- AC-3.5: Given a meeting, then it has exactly one source; recording a further part of the
  same conversation means creating another meeting.

### US-4: Consent, retention, deletion and residency
As a person who is recorded, and as wellD, I want recording to be a deliberate, informed act
with short-lived audio and real deletion, so that we respect GDPR and the Swiss nFADP and
our clients' trust.

**Acceptance criteria:**
- AC-4.1: Given a `recorded` or `uploaded` meeting, when the creator reaches the consent step,
  then a notice (English or Italian per the UI language) states that everyone present must
  have been told and agreed, that the audio is transcribed and summarised by AI processed in
  the EU or Switzerland, who will be able to read the result, how long audio is kept, that the
  transcription provider may keep the transcription result for up to about 5 days after
  processing (in the EU or Switzerland, with no training use; A6), and that
  a platform's own recording banner does not cover capture done by this tool. Proceeding
  requires an explicit tick. The attestation is the only consent control: no other check
  (such as a per-company "do not record" flag) blocks recording.
- AC-4.2: Given the consent step, then a short announcement text can be copied, for reading
  aloud or pasting into a meeting chat.
- AC-4.3: Given an attestation, then the meeting stores who gave it, when, and which version
  of the notice, and shows these in its details to everyone who can open the meeting.
- AC-4.4: Given retained audio, then it is irrecoverably deleted within 30 days (plus at most
  24 hours) of the moment its meeting left `processing`; the meeting shows "Audio kept until
  <date>", afterwards "Audio deleted". Transcript and summaries are unaffected. This holds
  for a frozen meeting too.
- AC-4.5: Given a meeting with retained audio, when the creator chooses "Delete recording"
  and confirms, then the audio is deleted at once and cannot be played or retried.
- AC-4.6: Given a meeting, when the creator or a holder of `meeting:erase` deletes it and
  confirms in a dialog stating it cannot be undone, then audio, transcript, summaries, every
  conversation and the participant list are deleted, and the host is told (AC-11.8).
  Afterwards the meeting is absent from every list and a link to it answers as not found.
  "Deleted" covers everything Operai and wellD's own storage hold (AC-4.12 included); the
  transcription provider's own bounded copy of a transcription result (Constraints, A6)
  expires on its own within the period accepted there and cannot be deleted on request.
  Only an entry saying who deleted which meeting id and when remains, with no content and no
  title.
- AC-4.7: Given a holder of `meeting:erase`, then they can find a meeting by title, creator
  or date from a screen showing only title, date and creator, and delete it, without being able
  to open its transcript, summaries or conversations.
- AC-4.8: Given any role, administrator included, then holding it never grants reading
  another person's meeting content; only participation, creator status and the opt-in of
  AC-5.5 do.
- AC-4.9: Given the service is configured with a storage location outside the EU (including
  the transient storage of AC-4.12), or a transcription or language-processing location
  outside the EU and Switzerland, then it refuses to start. It also refuses to start when a
  processor setting it can read shows retention or training use that the Constraints do not
  allow, or when such a setting cannot be read. Settings a processor does not expose are
  covered by the contract confirmation O13, not by this criterion.
- AC-4.10: Given any request, then logs and error reports hold identifiers and sizes only,
  never audio, transcript, summary, question or answer text.
- AC-4.11: Given a recording saved or abandoned, then nothing of the audio remains in the
  browser's storage on that device afterwards, and audio not yet saved is never written to
  that storage while the recording is going on either (AC-2.9).
- AC-4.12: Given audio handed to the transcription processor, then the only copy outside the
  retained audio of AC-4.4 is in storage that wellD controls, in the EU or Switzerland. It
  exists only while one transcription attempt runs and is deleted when that attempt ends,
  whether it succeeded or not; a copy left by a crashed attempt is deleted by the next attempt
  or at the latest within 1 day (plus at most 24 hours). When the creator or a holder of
  `meeting:erase` deletes the recording (AC-4.5) or the meeting (AC-4.6), that copy is deleted
  first; if it cannot be deleted, the action is refused and nothing is deleted. A transcription
  result written into that storage by an attempt still running at that moment is covered by
  the same 1-day bound. Any further transcription attempt of a part (the creator's retry,
  AC-6.9, or an automatic retry should the retry bound ever be raised, AC-6.11) is a
  transcription attempt like any other for this criterion. (A6, A7, A8)

### US-5: Participants, who can see what, and a frozen meeting
As a meeting creator, I want to say who took part and to control who can read the meeting,
so that sensitive conversations (a 1:1, a price discussion) stay with the right people.

**Acceptance criteria:**
- AC-5.1: Given a meeting, when its creator edits participants, then they can add up to 30:
  active Operai users (picked by live name, ADR-0039) and external participants (name 1-100
  characters, optional organisation up to 100). External participants are not accounts, are
  never notified and can see nothing.
- AC-5.2: Given a meeting, then it can be opened (transcript, summaries, participants,
  attestation, host link) by exactly: its creator; its Operai participants; and, only if
  host-visible (AC-5.5), users who can open the host entity, hold `meetings:access` and hold
  what the host requires for this (AC-5.6). Nobody else.
- AC-5.3: Given a meeting the caller may not open, when they request it by id, then the answer
  is identical to the one for a meeting that does not exist (not found).
- AC-5.4: Given a participant added, then they can open the meeting at once, including
  everything already in it; given a participant removed, then their next request is refused
  as not found (unless another rule still grants access).
- AC-5.5: Given a meeting with a host reference, when its creator turns on "Also visible to
  people who can open <host entity>" (default off; offered only if the host allows it), then
  those users gain the access of AC-5.2; turning it off removes it on the next request.
  A standalone meeting never offers it.
- AC-5.6: Given a CRM deal meeting that is host-visible, when a user holds `crm:access` and
  `meetings:access` but not `deal:financials` and is not a participant, then the meeting does
  not appear in the deal's list and cannot be opened (a meeting may contain prices, ADR-0054).
- AC-5.7: Given a user who loses access to the host entity, then host-granted visibility ends
  on their next request; access as creator or participant is unaffected.
- AC-5.8: Given the roles on one meeting, then: a creator holding `meetings:access` can do
  everything; a creator who no longer holds `meetings:access` can read the meeting and delete
  it or its recording (AC-4.5, AC-4.6), and nothing else (every other action is refused with
  403); an Operai participant or host-visible viewer holding `meetings:access` can read,
  generate and delete their own summaries, edit their own summaries and ask questions; an
  Operai participant without `meetings:access` can only read the transcript and the summaries
  and cannot generate a summary or ask a question (US-10); neither can edit the transcript,
  the participants, the link or the visibility, or delete the meeting. A refused action is 403
  where the caller can open the meeting.
- AC-5.9: Given an Operai participant added by someone else, then they receive an in-app
  notification (US-12).
- AC-5.10: Given a participant or creator whose account was deleted, then they are shown as
  deleted, never by a stale name.
- AC-5.11: Given a meeting whose creator's account is deactivated (the soft-delete of
  ADR-0012), then the meeting is frozen: its Operai participants and, if host-visible, its
  host-visible readers keep reading it; nobody can edit its title, date-time, format,
  language, transcript, speaker labels, participants, host reference or visibility, nor delete
  or relink it; the creator's controls are refused with 403 for everyone. Authors may still
  edit and delete their own summaries, and entitled users (AC-5.8) may still generate
  summaries and ask questions, since those do not change the meeting's record. The meeting
  shows "Frozen: its creator's account is deactivated".
- AC-5.12: Given a frozen meeting, then a holder of `meeting:erase` can delete it (AC-4.6),
  its audio still expires on schedule (AC-4.4), and its host activity (US-14) stays.
- AC-5.13: Given the creator's account is reactivated, then the meeting is no longer frozen
  and the creator's control returns on the next request.

### US-6: Read, correct and search the transcript
As anyone who can open a meeting, I want the transcript with times and speakers, so that I can
check what was actually said.

**Acceptance criteria:**
- AC-6.1: Given a `ready` meeting from a recording, then the transcript lists segments in time
  order, each with start time, speaker label and text. A `text` meeting shows its text with no
  times.
- AC-6.2: Given distinct voices, then segments carry distinct labels ("Speaker 1", "Speaker
  2", …), best effort; where voices cannot be told apart, one label. The creator can rename a
  label to a participant's name or free text, applied to all its segments. A long recording is
  transcribed in overlapping parts (**transcript parts**), and the transcription numbers
  speakers separately in each part. A label of a later part is **joined** to a label of the
  earlier part only when the overlap between the two parts gives clear evidence that they are
  the same speaker (AC-6.14); a joined label is the earlier label, so it reads as one speaker
  everywhere the transcript is shown, copied or downloaded. Every other label of a later part
  stays **separate** (AC-6.15): it takes a number that no earlier label uses, so one person can
  carry different labels in different parts. Separate labels can be merged by renaming them to
  the same name. The decision to join uses only the text, the labels and the times returned
  for the overlapping audio, never voice characteristics (AC-6.17). (A5, A7)
- AC-6.3: Given the creator editing a segment's text, then the text is saved, the segment is
  marked "edited", and a concurrent edit by someone else is refused with a prompt to reload
  (ADR-0038 posture).
- AC-6.4: Given the transcript, when a viewer searches a text, then matches are highlighted,
  ignoring case and accents, with their count.
- AC-6.5: Given retained audio, when a viewer selects a segment's time, then audio plays from
  that point; once audio is deleted the control is absent.
- AC-6.6: Given the transcript, then any viewer can copy it or download it as plain text with
  times and speaker names. For a transcript marked possibly incomplete (AC-6.12), the copy and
  the download begin with the notice and carry each gap marker at the same place as on screen.
  (A7)
- AC-6.7: Given a recording with no speech detected (an empty transcript, and no stretch of the
  audio that contains speech for at least the gap bound), then the status is `ready`, a "No
  speech detected" message is shown, and generating summaries and asking questions are
  disabled. Given a recording whose transcript is empty although its audio does contain such
  a stretch, then (the part having been transcribed once, retry bound 0, AC-6.11) the status
  is `failed` with the plain-language reason that speech was detected but could not be
  transcribed, and AC-6.9 applies: the message "No speech detected" is never shown for it.
  (A7, A8)
- AC-6.8: Given a transcript edited after a summary was made, then that summary is labelled
  "Based on an earlier version of the transcript"; nothing is regenerated automatically.
- AC-6.9: Given transcription fails, then the status is `failed` with a plain-language reason,
  no partial transcript is shown, and the creator can retry while audio is retained; after
  audio deletion no retry is offered. A transcript with gaps is not a failure (AC-6.12); a part
  that cannot be transcribed at all (the request itself fails) is, as before, a failure of the
  whole transcription. (A7)
- AC-6.10: Given a `processing` meeting, then the screen shows the stage (uploading,
  transcribing) and never blocks other pages. (A7, A8)
- AC-6.11: Given a recording transcribed in parts, when the transcription of a part comes back
  **detectably incomplete** (it has a gap; a repetition, AC-6.13, never counts as incomplete),
  then, the retry bound being 0 (Constraints), that part is **not** transcribed again: the
  result of the first attempt is kept as returned, the gap is handled under AC-6.12, and no
  automatic transcription request beyond one per part is made. The meeting stays `processing`
  (stage transcribing) until every part is settled. (A7, A8)
- AC-6.12: Given a part that has a gap, then the meeting becomes `ready` and its transcript is **marked possibly incomplete**: (a) a notice above the
  transcript reads "This transcript may be incomplete. Speech may be missing between
  hh:mm:ss and hh:mm:ss" for every affected range of the meeting's time, and says that the
  missing speech is not in the transcript and cannot be recovered from it; (b) a marker
  "Possible gap hh:mm:ss–hh:mm:ss" sits in the transcript between the segments it falls
  between; (c) while audio is retained, selecting a range plays the audio from its start
  (as AC-6.5), and once the audio is deleted that control is absent. A range is never
  narrower than the gap detected, is expressed in the meeting's time (the part's offset
  included), and ranges that touch or overlap, across a part boundary too, are one range. The
  notice is shown to everyone who can open the meeting, cannot be dismissed, is not removed by
  editing the transcript (AC-6.3), and is deleted with the meeting (AC-4.6). A transcript with
  no notice is not a statement that nothing was missed: a gap shorter than the gap bound is not
  detected. (A7)
- AC-6.13: Given speech that the transcription returns twice, within one part or in the
  overlap between two consecutive parts, then it appears once in the transcript. Two passages
  are the same speech only when one has at least the repeat bound of consecutive words that
  match the other's (ignoring case, accents and punctuation) and their times overlap, or the
  later starts no more than the repeat bound's time distance after the earlier ends, **and**
  they carry the same speaker label, or one or both carry no label (passages with two
  different labels are never the same speech, however identical their words and close their
  times; in the overlap of two parts a joined label, AC-6.14, counts as the same label); the
  first is kept. Where the words of a part carry no times, a **repeated tail** of that part is
  removed when its text matches the part's preceding text by at least the repeat bound in
  consecutive words (ignoring case, accents and punctuation) and the passages satisfy the
  speaker condition above; any speech found in only one of the two versions is kept. A phrase that a speaker really says twice, with more than that distance between the
  two, is never removed, and a repetition that does not meet this evidence is left as
  returned (the creator can still edit it, AC-6.3). In the overlap of two parts, every passage
  found in only one of the two versions is kept, so that no speech present in either version
  is dropped. A repetition in a part is removed under this rule, is never a reason to
  transcribe the part again, and does not by itself mark the transcript possibly incomplete.
  (A7, A8)
- AC-6.14: Given two consecutive parts and a label L2 of the later part, then L2 is joined to a
  label L1 of the earlier part when all of the following hold, over the passages of the
  overlap that are found in both parts' transcripts (matched as in AC-6.13): (a) the passages
  that the later part attributes to L2 total at least the match bound in words; (b) the earlier
  part attributes all of them to the same L1; (c) no other label of the later part has any
  matched passage attributed to L1 by the earlier part. A joined label keeps L1's number and
  name. Joining chains from part to part, each link established only between consecutive
  parts: a label of part 3 joins a label of part 2 (and so, through it, part 1) only by the
  overlap of parts 2 and 3. (A7)
- AC-6.15: Given a label of a later part for which the evidence of AC-6.14 is not clear (no
  speech in the overlap, fewer matched words than the match bound, a matched passage attributed
  to a different label, two later labels matching the same earlier one, or the overlap affected
  by a gap), then the label stays separate. A label is never joined by position, number, order
  of appearance or as a default. When the transcript has more than one part and at least one
  label of a later part is separate, a non-blocking notice says that the recording was
  transcribed in {n} parts, that speakers could not always be matched between parts, that one
  person can therefore appear under two labels, and that renaming them to the same name merges
  them. The notice never says that separate labels are different people and never says that
  speakers are numbered separately in every part. When every label of every later part is
  joined, or the transcript has one part, this notice is not shown. (A5, A7)
- AC-6.16: Given a joined label, then the transcript shows that it was matched automatically
  across parts and which parts it covers, a rename still applies to all its segments, and the
  creator can "Separate by part", which gives each part's segments their own label again
  (each keeping the name the joined label had at that moment, until renamed). Separating
  cannot be undone by later processing, is refused with 403 to anyone but the creator, and is
  unavailable on a frozen meeting (AC-5.11), as a rename is. (A7)
- AC-6.17: Given the decision of AC-6.14 and AC-6.15, then it is computed only from the text,
  the labels and the times that the transcription returned for the overlapping audio: with the
  same returned text, labels and times, the joins are the same whatever the audio. No voice
  characteristic (voiceprint, embedding, acoustic similarity) is computed, stored or sent for
  this purpose. (A7)

### US-7: Summaries from templates
As anyone who can open a meeting, I want AI summaries in the shape I need, and several of
them, so that one conversation can serve the sales note, the minutes and the action list.

**Acceptance criteria:**
- AC-7.1: Given a `ready` meeting with speech and a caller allowed by AC-5.8, when they pick a
  template and an output language (English or Italian, default the UI language) and generate,
  then a summary appears as `generating` and later `ready`.
- AC-7.2: Given a `ready` summary, then it contains the template's sections in order, each
  under its heading; a section with nothing in the transcript reads "Not discussed"
  (localised). It is labelled "AI-generated" with template name, language, author and time.
- AC-7.3: Given a meeting, then it can hold up to 20 summaries, including several from the
  same template; the 21st is refused with a message.
- AC-7.4: Given a summary, when the user chooses "Regenerate", then a new summary is made
  with the same template and language and the earlier one is kept.
- AC-7.5: Given a summary, then it keeps the template as it was when generated; later edits or
  deletion of the template change nothing in it.
- AC-7.6: Given generation in progress, then the user may leave the page; on return the summary
  shows its current state, and it notifies the author when done (US-12).
- AC-7.7: Given a `ready` summary, then its author or the meeting's creator can edit its text;
  it is then marked "edited"; regenerating never alters it; a concurrent edit is refused with a
  prompt to reload.
- AC-7.8: Given a summary, then its author or the meeting's creator can delete it after
  confirming.
- AC-7.9: Given an outage or timeout of the AI processing, or a reply that does not have the
  structure the summary requires, then the summary is `failed` with a retry action, no partial
  text is ever shown as `ready`, and transcript, other summaries and questions stay usable. (A7)
- AC-7.10: Given generation, then it uses only that meeting's transcript and the chosen
  template: no other meeting, no host record data, and no capability to act on anything.
- AC-7.11: Given a summary, then everyone who can open the meeting can read it, and any viewer
  can copy it as text.
- AC-7.12: Given a transcript containing sentences that address the AI ("ignore your
  instructions and …"), then the summary still follows the template and treats them as
  quoted content.
- AC-7.13: Given a summary generated from a transcript marked possibly incomplete (AC-6.12),
  then it carries, written by the service and not by the AI, the label "Based on a transcript
  that may be incomplete" with the affected ranges, and a section with nothing in the
  transcript reads "Not found in the transcript, which may be incomplete" (localised) in place
  of "Not discussed". The label and the wording are part of the text a viewer copies
  (AC-7.11), and a regenerated summary carries them too. (A7)

### US-8: Summary templates
As a user, I want ready-made templates and the ability to define my own, so that a discovery
call, a 1:1 and general minutes each get the right sections.

**Acceptance criteria:**
- AC-8.1: Given the tool, then these built-in templates exist, with name, sections and
  instructions in English and Italian, and cannot be edited or deleted: "Meeting minutes",
  "Sales discovery call", "1:1", "Action items". "Sales discovery call" is recommended for CRM
  deals; the others for any host.
- AC-8.2: Given a user with `meetings:access`, then they can create, edit and delete personal
  templates visible to them alone: name (1-80 characters, unique among their own), 1-15
  sections each with a heading (1-80) and an instruction (up to 500), optional general
  instructions (up to 2,000).
- AC-8.3: Given a holder of `template:manage`, then they can create, edit and delete shared
  templates (same fields, name unique across shared templates, case-insensitively), usable by
  every `meetings:access` holder; others cannot edit them (403).
- AC-8.4: Given any built-in or shared template, then a user can duplicate it into a personal
  one and change it.
- AC-8.5: Given the template picker, then it lists recommended templates for the meeting's
  host first, then personal, shared and built-in, each marked as such.
- AC-8.6: Given an output language, then built-in headings appear in that language; personal
  and shared headings appear as written, with the content written in the chosen language.
- AC-8.7: Given a template deleted or edited, then existing summaries are unchanged (AC-7.5).

### US-9: Ask the meeting
As anyone who can open a meeting, I want to ask it questions in plain language and see where
the answer comes from, so that I do not re-listen to find one fact.

**Acceptance criteria:**
- AC-9.1: Given a `ready` meeting with speech and a caller allowed by AC-5.8, when they send
  a question (1-1,000 characters, English or Italian), then an answer in the language of the
  question appears, labelled "AI-generated".
- AC-9.2: Given a question, then the answer is based only on that meeting's current
  transcript: not its summaries, not other meetings, not host data.
- AC-9.3: Given an answer, then it lists the transcript passages that support it, each with
  time and speaker, and selecting one scrolls to and highlights that segment (for a `text`
  meeting, the passage). Given a question the transcript does not answer, then the answer
  says the meeting does not contain it and lists no passage.
- AC-9.4: Given a conversation, then a follow-up question takes into account at least the
  previous 10 turns.
- AC-9.5: Given a user's conversation with a meeting, then it is kept and shown again when
  they return; no other user, the creator included, can read it; the user can clear it.
- AC-9.6: Given an AI outage or timeout, or a reply that does not have the structure an answer
  requires, then the question stays in the conversation marked failed with a retry action, and
  no answer is invented and no partial answer is shown. (A7)
- AC-9.7: Given a transcript containing sentences that address the AI, then answers still
  keep their format and scope.
- AC-9.8: Given the AI request limit of AC-13.4, when exceeded, then the request is refused
  with a message saying when to retry.
- AC-9.9: Given a meeting whose transcript is marked possibly incomplete (AC-6.12), then every
  answer carries, written by the service and not by the AI, the label "Based on a transcript
  that may be incomplete" with a link to the notice, and an answer that the meeting does not
  contain what was asked (AC-9.3) also says that the transcript may be incomplete, so that
  "not in the meeting" is never presented as certain. (A7)

### US-10: My meetings, and who reaches the tool
As an employee, I want one page with every meeting I created or took part in, reachable even
if I do not use the tool, so that I can always read what was recorded about me and find my
own.

**Acceptance criteria:**
- AC-10.1: Given any signed-in user with no grants, then "My meetings" is reachable from the
  user menu and lists the meetings where they are creator or Operai participant, and only
  those, whatever their roles (an administrator sees only their own).
- AC-10.2: Given the list, then each row shows title, date, format, host, status and the
  caller's role (creator or participant); it is newest first, paginated 25 per page, searchable
  by title (case-insensitive substring) and filterable by role, status and host app.
- AC-10.3: Given a row's host, then it reads "Deal · <title>" with a link if the caller can
  open that entity, and otherwise only the app and type ("CRM · deal"); a host that no longer
  exists reads "No longer available".
- AC-10.4: Given a user without `meetings:access` who is a participant, then they can open the
  meeting and read transcript and summaries; every control to create, summarise, ask or edit
  is absent and the server refuses those actions with 403. The Meetings tool is absent from
  their navigation. Given such a user who is the creator, the same holds except that they can
  also delete the meeting and its recording (AC-5.8).
- AC-10.5: Given a user with `meetings:access`, then the tool appears in navigation and opens
  the same list with "New meeting" and "Templates".
- AC-10.6: Given the authorization service is unavailable, then My meetings still lists and
  opens meetings where the caller is creator or participant, while every action that needs a
  capability check is refused with 503, never allowed.
- AC-10.7: Given a user with no meetings, then the page says so and, if they hold
  `meetings:access`, offers "New meeting".
- AC-10.8: Given the default grants, then every employee holds `meetings:access`, and
  `template:manage` and `meeting:erase` are held by the admin role only. Nothing else in the
  seed grants either.

### US-11: Host integration contract
As the owner of an Operai app, I want to show a "Start meeting" entry and a list of the
meetings about my records, and optionally to be told when one is created, changed or removed,
so that meetings appear where my users work, without the Meetings tool knowing my domain.

**Acceptance criteria:**
- AC-11.1: Given the set of registered hosts, then in this release it contains exactly the CRM
  with entity type `deal`; each entry states how the host decides that a user can open the
  entity, what the host requires for host-visible meetings (CRM: `deal:financials`), and
  whether it receives host notices (CRM: yes).
- AC-11.2: Given a CRM deal page, then it has a "Meetings" section listing the meetings linked
  to exactly that deal that the viewer may open, newest first, with title, date, status,
  number of summaries and creator. If there are none, an empty state shows "Start meeting"
  when the viewer holds `meetings:access`. No count or name of meetings the viewer may not
  open is ever shown.
- AC-11.3: Given a meeting started from the deal, when it is created, then it appears in the
  deal's list and in My meetings.
- AC-11.4: Given a registered test host with another app and entity type, then create, list,
  open, visibility, summaries and questions behave exactly as for the CRM, with no change to
  the meeting screens. A test host that opted in receives host notices (AC-11.8); one that did
  not opt in receives none.
- AC-11.5: Given a host entity that no longer exists or can no longer be resolved, then its
  meetings stay in My meetings for creator and participants with "No longer available", and
  host-granted visibility ends.
- AC-11.6: Given the Meetings service is down, then the deal page still loads and its Meetings
  section says it is unavailable. Given the host cannot confirm that the caller may open the
  entity, then starting a host-linked meeting is refused with a retry message (never allowed
  unverified) and a standalone meeting can still be started.
- AC-11.7: Given a deal's company, then in this release the company page does not roll up its
  deals' meetings.
- AC-11.8: Given a host that opted in, then it is sent one host notice when a meeting is
  linked to one of its entities (at creation or later), when the title or date-time of a
  linked meeting changes, when the meeting is relinked (the old entity gets an "unlinked"
  notice and the new one a "linked" notice), when the link is removed, and when the meeting is
  deleted. The "linked" and "changed" notices carry meeting id, title, date-time, event and
  creator id. The "unlinked" and "deleted" notices carry only meeting id, event and creator id:
  no title and no date-time, so that nothing with a title outlives a deletion (AC-4.6). No
  notice ever carries transcript, summary, question, answer, participant or attestation data.
- AC-11.9: Given a host notice that cannot be delivered, then the meeting action that caused it
  is never refused or rolled back; the failure is shown to the creator without blocking
  (non-blocking notice with a "Try again" action) and is not silent.
- AC-11.10: Given the host reacts to a notice, then what it does is its own business (US-14
  for the CRM); the Meetings tool never reads host data back.

### US-12: Notifications
As a participant or requester, I want to be told when something concerns me, so that I do not
poll the page.

**Acceptance criteria:**
- AC-12.1: Given a participant added (AC-5.9), then they receive an in-app notification that
  links to the meeting and states that it was recorded or transcribed with AI.
- AC-12.2: Given a transcription or summary the user asked for, when it finishes or fails,
  then that user gets an in-app notification linking to the meeting. Notifications carry the
  meeting title and the outcome, and never transcript, summary or answer text.
- AC-12.3: Given the notification service fails, then no meeting action fails or rolls back.
- AC-12.4: Given this release, then no email is sent, and other participants are not notified
  when a summary is created.
- AC-12.5: Given a notification, then its text exists in English and Italian.

### US-13: Language, limits and accessibility
As a user, I want the tool in my language, within sensible limits, usable without a mouse.

**Acceptance criteria:**
- AC-13.1: Given the UI, then every string exists in English and Italian, with a test of
  parity and of no hard-coded copy, as in the other tools.
- AC-13.2: Given the meeting languages, then they are Italian and English; the creator chooses
  one for transcription and the transcript is not translated.
- AC-13.3: Given the recording controls, then start, pause, resume and stop work from the
  keyboard and the state change is announced to a screen reader.
- AC-13.4: Given a user, then they can make at most 30 AI requests (summaries plus questions)
  per hour; beyond that the request is refused with the time to retry.

### US-14: A meeting started from a deal appears in the deal's activity
As a salesperson, I want a meeting about a deal to show up in the deal's history, so that the
history of the relationship in the CRM is complete without logging the meeting twice.

**Acceptance criteria:**
- AC-14.1: Given a meeting linked to a CRM deal, when it is created with that link (or later
  linked to it), then the CRM gets one activity of type `meeting` on the deal's company,
  referencing the deal, shown in the deal's and the company's timelines (specs/017 AC-4.5).
- AC-14.2: Given that activity, then its subject is the meeting title, its occurred-at moment
  is the meeting's date-time, and its body is a link to the meeting and nothing else. It never
  contains transcript, summary, question, answer, participant or attestation content, because
  the people who read an activity may not have access to the meeting.
- AC-14.3: Given that activity, then it is attributed to the meeting's creator as author, so
  the authorship rule of specs/017 AC-4.2 applies as for any activity (only the creator can
  edit or delete it by hand) and the creator's name is shown by live Operai name.
- AC-14.4: Given a reader of the activity without access to the meeting, when they follow the
  link, then they get "not found" (AC-5.3); the activity still shows title and date.
- AC-14.5: Given the meeting's title or date-time changes, then the activity's subject and
  occurred-at follow it (the "changed" notice carries them).
- AC-14.6: Given the meeting is deleted (by the creator or a holder of `meeting:erase`), then
  its activity, found by the meeting id in the "deleted" notice (which carries no title or
  date-time), is removed from the CRM, so no title or link outlives the meeting (AC-4.6).
  Deleting the meeting is never blocked by the activity; if the removal fails it is retried
  until it succeeds.
- AC-14.7: Given the link is removed, then the activity, found by the meeting id in the
  "unlinked" notice, is removed; given the meeting is relinked to another deal, then the
  activity is removed from the old deal and created on the new one (from the "linked" notice,
  which carries title and date-time), in the new deal's company.
- AC-14.8: Given the activity cannot be created (the CRM is unavailable, or the creator no
  longer holds `crm:access`), then the meeting is still created or linked, the creator sees a
  non-blocking notice "The deal's activity could not be added" with a "Try again" action, and
  nothing is retried silently without the creator knowing (best effort, because blocking a
  recording on the CRM would lose a meeting).
- AC-14.9: Given a meeting linked to a deal, then there is never more than one meeting activity
  for it, however many times a notice is delivered or retried.
- AC-14.10: Given a frozen meeting (AC-5.11), then its activity stays as it is, and a
  creator-less retry is not offered.
- AC-14.11: Given a standalone meeting or a host other than the CRM, then no CRM activity is
  created.

## Non-goals

- **Meeting bots, calendar integration, Zoom/Teams/Meet apps.** A bot joins as a visible
  attendee, needs per-platform approval and admin consent, and shifts the consent problem;
  a later spec. Platform is also not a field: the tool records audio, not a platform.
- **Native desktop/mobile apps and system-wide audio capture.** Browser only.
- **Live transcription or live summary during the meeting.** Everything is after the fact.
- **Questions or search across meetings (a deal's meetings, all mine).** It changes the
  privacy question (mixing meetings with different participants); one meeting per question.
- **Storing video**, transcribing images or shared screens.
- **Languages other than Italian and English** (German, French, Swiss German), translation,
  automatic language detection and mixed-language meetings. Owner decision, 2026-11-04.
- **Sending a meeting outward:** share links, emailing summaries, PDF export, access for
  non-participants. Copy and download as text only.
- **Writing meeting content to the host, or host data to the AI.** The only write-back is the
  content-free host notice (AC-11.8) and, for the CRM, the activity of US-14. There are no
  tasks created from action items, no summary pushed to the deal, and no deal data fed to
  summaries or answers.
- **A per-company "do not record" flag.** The consent attestation is enough (owner decision,
  2026-11-04).
- **Linking external participants to CRM contacts.** Contact erasure (specs/017 AC-2.4) would
  have to reach meetings; plain names keep the two erasure paths separate.
- **Multi-part meetings (one meeting made of several recordings) and recordings over 3
  hours.** Not to be confused with the transcript parts of AC-6.2, which split one recording.
- **Matching the same speaker across transcript parts by voice.** Continuity across parts is
  established only from the transcript text of the overlapping audio (AC-6.14); anything based
  on voice characteristics (voiceprints, embeddings, acoustic similarity) would be biometric
  processing of personal data (GDPR art. 9) and is excluded (A5, A7). Where the evidence is
  not clear the labels stay separate and the creator merges them by renaming.
- **Guaranteeing a complete transcript.** Only a gap of at least the gap bound is detected;
  scattered shorter omissions are not, so the absence of the notice (AC-6.12) is not a promise
  (A7).
- **Re-transcribing a whole meeting on demand to fill a gap.** It would discard the creator's
  edits and renames and make every summary and answer stale; the creator's retry (AC-6.9) is
  for failures only. Missing speech is recovered by listening while audio is retained (A7).
- **Telling hosts, notifications or lists that a transcript may be incomplete.** The notice
  lives on the meeting screens, in copies and downloads, and on summaries and answers; host
  notices stay content-free (AC-11.8) (A7).
- **Recovering audio captured offline after the tab is gone.** It would require keeping audio
  on the device, which AC-4.11 forbids (A2).
- **Transcript version history, a read-access log, AI cost reporting.**
- **Project-management and HR 1:1 screens.** Those apps do not exist; this spec only
  guarantees the host contract (US-11) does not need to change when they arrive.
- **Admins reading others' meetings.** Deliberately absent (AC-4.8).
- **Reassigning a frozen meeting to a new creator.** Deleting or waiting for reactivation are
  the only exits (AC-5.12, AC-5.13).

## Open questions

O2 and O3 are accepted as tracked risks by the owner (2026-11-04): the work proceeds on the
working assumptions below, which the plan may rely on. O13 was added on 2026-11-05 (A6), O14
on 2026-11-05 (A7), O15 on 2026-11-05 (A8).

- [ ] O2 (accepted-as-risk) Retention beyond audio: working assumption is that transcripts and
  summaries are kept until their meeting is deleted, with no maximum life; how long the
  content-free deletion entry (AC-4.6) is kept is not decided. Since A6, the transcription
  provider's bounded copy of a transcription result (up to about 5 days) is outside "until
  the meeting is deleted": a deletion cannot reach it. — owner: data-protection lead
- [ ] O3 (accepted-as-risk) Which wellD entity is controller of the data, and which provider
  contracts qualify. Working assumptions: transcription and AI providers must process in the
  EU or Switzerland, with contractual no-training and no-retention except the bounded
  transcription-result exception (a hard constraint, see Constraints, A6); storage is in the
  EU. — owner: data-protection lead
- [ ] O13 (accepted-as-risk, go-live sign-off, A6) Contract confirmation for the providers
  chosen on 2026-11-05. (a) wellD's use of the cloud provider is under its Master Agreement
  with data-processing terms, not its online terms of service, so that no content is held for
  abuse monitoring or human review; (b) the provider confirms in writing that the
  transcription result is kept no longer than about 5 days and is not used for training; since
  A7 this holds for every further transcription of a part too (none is automatic while the
  retry bound is 0, A8; the creator's retry, AC-6.9, yields a further result), each yielding a
  transcription result under the same bound; (c) the language-model vendor's commercial terms,
  accepted by enabling its models through the cloud provider, do not make that vendor a
  processor of meeting content or let it retain it. The owner's acceptance of the 5-day
  exception is conditional on (b): a longer or wider retention returns to the owner. The
  consent notice bump of AC-4.1 ships with the release that makes this change.
  — owner: user (owner) and data-protection lead
- [ ] O14 (A7) The gap detector (AC-6.11), the repetition rule (AC-6.13) and the join evidence
  (AC-6.14) were designed from a spike on synthetic audio only. Before go-live the architect
  measures, on recordings made for the purpose with a consent attestation (AC-4.1), how often
  non-speech sound is wrongly treated as a gap (needless retries, a false notice), how often a
  real gap is missed, and how often a join is wrong, and confirms or changes the bounds of
  Constraints. A false join found at that point is a defect, not a tuning matter; a join rate
  that is low only costs renames. — owner: architect
- [ ] O15 (A8) Per-part automatic retry is disabled (retry bound 0) because the provider
  returns the identical result for identical audio. Once production data exists, revisit a
  retry that sends **different** audio (for example the part re-cut around the gap), and
  decide whether it earns its cost; until then a gap is marked, not retried. The same review
  checks the same-speaker rule of AC-6.13 (real speech wrongly kept as a duplicate when
  speaker labels differ for one person) and the repeated-tail rule for parts without word
  times. — owner: user and architect

Closed by the owner on 2026-11-04 (recorded in the body): O1 languages (US-13, non-goals);
O4 default grants (AC-10.8); O5 read-only participants (AC-5.8, AC-10.4); O6 limits accepted;
O7 frozen meeting (AC-5.11 to AC-5.13); O8 CRM meeting activity (US-14); O9 attestation is
enough (AC-4.1); O10 uploaded video reduced to audio (AC-3.1); O11 host-visible ships
(AC-5.5, AC-5.6); O12 processing-time target is set by the architect in plan.md
(Constraints).

Closed by the owner on 2026-11-05: plan Q1, the 5-day transcription-result retention is
accepted (Constraints, A6); plan A5, the transcript-parts clarification (AC-6.2); spike
decisions D3 and D4 (A7): automatic retry of a detectably incomplete part, speaker continuity
from overlap text only, and a structured AI reply that is offered but not forced, where an
invalid reply is a failure.
