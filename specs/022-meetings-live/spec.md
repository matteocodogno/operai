---
id: 022
slug: meetings-live
status: approved
rigor: production
created: 2026-11-05
approved: 2026-11-05
---

# Meetings live mode — ask questions about what has been said so far, while the meeting is still being recorded

> **Positions and owner decisions.** The request ("poter avere anche la modalità live/real time
> in cui l'utente può fare delle domande live su quanto detto finora nel meeting") left the
> shape open. Positions of this draft, all confirmed by the owner on 2026-11-05 (see Open
> questions, now closed):
> 1. **Live mode is a switch on a browser recording**, off by default, chosen per recording
>    session. Uploaded and text meetings have nothing to be live about.
> 2. **Only the creator, on the recording tab, uses it.** Other participants see nothing live.
> 3. **The live text is provisional**: no speaker labels, shown only to the creator, and
>    replaced by the final transcript of specs/021 when it exists. It is never the record.
> 4. **Live questions are private AI requests**, counted in the existing hourly limit, kept
>    in the creator's conversation afterwards and marked as answered from provisional text.
> 5. **The recording always wins.** Any live failure leaves the recording, its saving and its
>    final processing exactly as they are in specs/021.

## Relation to specs/021

This spec extends the Meetings tool of `specs/021-meetings/spec.md`. Every 021 criterion
holds unchanged unless this spec says otherwise. It changes four things, listed here so the
two specs do not contradict each other once this one is approved:

- 021's non-goal "Live transcription or live summary during the meeting" is narrowed: live
  provisional text and live questions are in scope here; **live summaries and a saved live
  transcript stay out** (see Non-goals).
- AC-9.1 and AC-9.2 (questions only on a `ready` meeting, answered from the current
  transcript) get one exception: a **live question** on a meeting in `recording`, answered
  from the provisional text (US-3).
- AC-4.1 (the consent notice) gains a statement about live mode, and the notice version
  changes (US-1).
- AC-4.9 (startup refusal for a location outside the EU and Switzerland) is extended to
  whatever processes live audio and live text (US-6).

The transcript of specs/021 (AC-6.x) is unchanged: it is, and stays, the final transcript.

## Problem

A consultant or salesperson recording a discovery call or a project sync often needs a fact
from earlier in the same conversation while it is still going on: what budget the client
mentioned ten minutes ago, which date was agreed, whether a point was already covered. Today
Meetings produces a transcript only after the recording stops, so the answer exists only in
memory or in hand-written notes, which is the attention cost the tool was built to remove.
Asking after the meeting is too late to use the answer in the conversation. The person is
mid-call and cannot re-listen; a wrong recollection is repeated to the client.

## Domain language

New terms; see the glossary candidates returned with this spec. Terms of specs/021 (meeting,
recording session, chunk, transcript, segment, speaker label, conversation, AI request,
consent attestation, Operai participant, transcript part) are reused as defined there.

- **live mode** — a per-recording-session switch, on a `recorded` meeting, that makes the
  provisional transcript and live questions available while the recording is going on.
- **provisional transcript** (live text) — the text of what has been said so far, produced
  during the recording, without speaker labels, visible to the creator only, replaced by
  the final transcript. It is not a transcript in the sense of specs/021 (AC-6.1).
- **settled text** — the part of the provisional transcript that will no longer change. Only
  settled text is shown and only settled text is used to answer.
- **coverage point** — the moment of the recording, as mm:ss of recording time, up to which
  settled text exists. Shown to the creator and stated in every live answer.
- **live gap** — a stretch of recording time with no provisional text although audio was
  captured (live mode off, live unavailable, a piece that could not be transcribed live).
- **live question / live answer / live turn** — a question asked during the recording, the
  answer to it, and the pair as it appears in the creator's conversation. A live answer is
  based on provisional text only.
- **superseded** — the state of a live turn once the final transcript exists: it stays, but
  is no longer backed by any transcript on the screen.

## Constraints

Binding rules that already exist in the suite or follow from the nature of the data; this
spec does not choose vendors or mechanisms.

- Everything specs/021 states under Constraints applies to live processing: audio and text
  are processed only in the EU or Switzerland, a processor must contractually not use
  submitted content to train models and must not retain it beyond the request. specs/021
  accepts one bounded exception (A6, 2026-11-05): the **batch transcription** step may keep
  its transcription result for up to about 5 days. **That exception does not extend to live
  mode** (owner decision 2026-11-05, closed O7): live audio and live text are held to the
  strict rule, nothing retained after the request. If a processor cannot meet it, live mode
  is not offered and the rest of the tool is unaffected.
- Copy exists in English and Italian (`it: typeof en` parity); times use the library
  formatters; identifiers and dates in API contracts are ISO 8601.
- Authorization follows ADR-0007 / ADR-0014 and the visibility rule of ADR-0058: a failure of
  the authorization service never turns into an allow.
- The live latency figures in this spec are accepted by the owner (2026-11-05); the architect
  confirms feasibility in plan.md, and an infeasible figure is a spec amendment, not a silent
  miss.
- Database backups keep deleted content for the backup retention period: the open gap R7 of
  specs/021 applies to the provisional transcript as it does to the final one; this spec
  adds no new gap and does not close that one.

## User stories

### US-1: Turn on live mode for a recording
As a meeting creator, I want to switch live mode on when I start recording, after I have
confirmed consent, so that live text and questions exist only when I chose them and the
people in the room were told.

**Acceptance criteria:**
- AC-1.1: Given a `recorded` meeting in `draft` with a complete consent attestation (021 US-4)
  and live mode available, when the creator opens the capture options, then a "Live mode"
  switch is shown, **off by default**, with one sentence saying what it does (live text and
  questions while recording, processed in the EU or Switzerland, the text is provisional and
  is replaced by the final transcript).
- AC-1.2: Given live mode is off for the whole recording, then recording, saving, stopping and
  processing behave exactly as in specs/021, no live panel is shown, and no audio is sent to
  live processing.
- AC-1.3: Given a meeting whose attestation is not complete, then live mode cannot be turned
  on, no audio capture is requested (AC-2.1 of 021) and no audio is sent to live processing.
- AC-1.4: Given a meeting whose attestation was given under an earlier notice version that
  does not mention live mode, then recording without live mode needs nothing new; when the
  creator switches live mode on, the updated notice is shown first, and only ticking it turns
  live mode on. Ticking records a new attestation (who, when, which version), the earlier one
  is kept, and both are shown in the meeting's details (AC-4.3 of 021). Not ticking leaves
  live mode off and the recording unaffected.
- AC-1.5: Given the consent step (AC-4.1 of 021), then the notice also states that with live
  mode what is said is transcribed during the meeting and the creator can ask questions about
  it while it goes on, that this live text is provisional and is deleted once the final
  transcript exists or the recording is discarded, and who can read it (the creator only).
  The notice exists in English and Italian and carries a new version identifier. The
  attestation remains the only consent control.
- AC-1.6: Given an `uploaded` or `text` meeting, then live mode is never offered.
- AC-1.7: Given a meeting and a caller, then only the creator holding `meetings:access` can
  turn live mode on or off or use it, from the tab that is recording. Any other caller who can
  open the meeting is refused with 403 (AC-5.8 of 021); a caller who cannot open it receives
  the answer for a meeting that does not exist (AC-5.3 of 021).
- AC-1.8: Given a recording with live mode on, when the creator turns it off, then no further
  audio is sent to live processing, the live panel says live mode is off, the recording is
  unaffected, and the stretch until it is turned on again is a live gap. Turning it on again
  during the same recording session is allowed once the attestation covers live mode (AC-1.4)
  and resumes live text from that moment.
- AC-1.9: Given live mode is not available (not configured, or its processing cannot be
  verified), then the switch is disabled with the reason, and recording, uploading, text
  meetings and everything else of the tool work as in specs/021.

### US-2: See what has been said so far, marked as provisional
As a meeting creator recording with live mode on, I want to read the text of the conversation
as it goes, clearly marked as not final, so that I can check what the tool has heard without
mistaking it for the record.

**Acceptance criteria:**
- AC-2.1: Given a recording with live mode on, then a live panel shows the settled text in time
  order, each line with its approximate time (mm:ss of recording time) and **no speaker
  label**, under the heading "Live transcript (provisional)" with an icon and a standing
  notice "Provisional: the final transcript, with speakers, replaces this after you stop".
  The marking is text and icon, not colour alone.
- AC-2.2: Given text shown in the panel, then it is settled: a line, once shown, is never
  rewritten or removed while the recording goes on, so that a question is always answered from
  exactly what the creator can see.
- AC-2.3: Given the reference conditions (browser connected, live processing available,
  speech in the meeting language, a reference audio fixture), then speech appears in the panel
  within 20 seconds of being spoken at the 95th percentile, and the panel shows the coverage
  point ("Live text up to mm:ss of mm:ss recorded"), updated at most once per 10 seconds.
  (Bound accepted 2026-11-05; the architect confirms feasibility.)
- AC-2.4: Given the recording is paused, then no text is produced for the paused time, the
  panel shows "Paused", and the creator can still read the panel and ask a question about the
  text so far. Resuming continues the same panel.
- AC-2.5: Given a live gap, then the panel shows a marker "No live text from mm:ss to mm:ss"
  stating the reason (live mode off, live text unavailable, could not be transcribed live);
  the final transcript will cover that time.
- AC-2.6: Given a stretch with no speech, then the panel shows "No speech yet" at the start or
  nothing in the middle; silence is never shown as an error.
- AC-2.7: Given the panel, then it follows the newest line unless the creator has scrolled
  up, in which case it stays put and offers "Jump to latest"; with reduced motion preferred,
  following does not animate.
- AC-2.8: Given the provisional transcript, then it is not part of the meeting record: it is
  not searchable with the transcript search (AC-6.4 of 021), has no copy or download control
  (AC-6.6 of 021), is never used as input to a summary (AC-7.10 of 021), and is not shown in a
  host's panel.
- AC-2.9: Given a meeting in `recording`, when an Operai participant, a host-visible reader or
  the creator on another device opens it, then they see its status and elapsed time and nothing
  of the provisional transcript, and no request they can make returns any of it.

### US-3: Ask what has been said so far
As a meeting creator recording with live mode on, I want to ask a question in plain language
about what has been said until now and see where the answer comes from, so that I can use a
fact from earlier in the conversation while it is still going on.

**Acceptance criteria:**
- AC-3.1: Given a recording (running or paused) with live mode on and at least one line of
  settled text, when the creator sends a question (1-1,000 characters, English or Italian),
  then an answer in the language of the question appears in the live panel, labelled
  "AI-generated" and "Live answer", with "Based on the live text up to mm:ss", where mm:ss is
  the coverage point at the moment the question was accepted.
- AC-3.2: Given a live question, then the answer is based only on that meeting's settled text
  up to that coverage point: not the audio, not summaries, not other meetings, not host data,
  and not any other user's conversation.
- AC-3.3: Given a live answer, then it never attributes a statement to a named or labelled
  speaker; given a question that asks who said something, the answer says the live text has no
  speaker information.
- AC-3.4: Given a live answer, then it lists the supporting passages, each with the quoted
  excerpt and its approximate time, and selecting one scrolls the panel to that line and
  highlights it. Given a question the settled text does not answer, then the answer says it is
  not in the live text so far (up to mm:ss), never that the meeting does not contain it, and
  lists no passage.
- AC-3.5: Given no settled text yet, then the send control is disabled with the reason, and no
  AI request is made or counted.
- AC-3.6: Given a live question awaiting its answer, then at most that one is in flight: the
  send control is disabled with "Waiting for the answer" and the typed text is kept.
- AC-3.7: Given the reference conditions of AC-2.3 and a recording of up to 3 hours, then a
  live answer is complete within 20 seconds of sending at the 95th percentile; a question not
  answered within 60 seconds becomes failed (AC-3.11). (Bound accepted 2026-11-05.)
- AC-3.8: Given a follow-up live question, then it takes into account at least the previous 10
  turns of this conversation (AC-9.4 of 021).
- AC-3.9: Given a live question, then it is one AI request of the creator and is counted with
  summaries and ordinary questions in the same 30 per hour (AC-13.4 of 021). Beyond the limit
  it is refused with the time to retry, the typed text is kept, and live text and recording are
  unaffected. (Shared limit, accepted 2026-11-05.)
- AC-3.10: Given a live question, then it needs `meetings:access` resolved live: a creator who
  no longer holds it is refused with 403, and an authorization-service outage refuses it with
  503, never allows it (ADR-0014). The recording and the panel's text continue either way.
- AC-3.11: Given an AI outage or timeout, then the question stays in the panel marked failed
  with a retry action, no answer is invented, and the recording and live text are unaffected.
  Retrying counts as in AC-9.6 of 021.
- AC-3.12: Given speech in the meeting that addresses the AI ("ignore your instructions and
  …"), then answers still keep their format and scope and treat it as quoted content (AC-9.7
  of 021); anyone in the room can say it, so this is the live counterpart of a pasted text.
- AC-3.13: Given the connection is lost while the tab stays open, then the send control is
  disabled with "No connection", the typed question is kept, and it is enabled again on
  reconnection; a question already sent and not answered becomes failed with retry.
- AC-3.14: Given live turns, then they are part of the creator's private conversation with
  the meeting (AC-9.5 of 021): no other user, the participants and administrators included, can
  read them, and the creator's "Clear conversation" removes them too.

### US-4: The recording is never harmed by live mode
As a meeting creator, I want the recording to be safe whatever happens to live mode, so that
turning on a convenience never costs me the meeting.

**Acceptance criteria:**
- AC-4.1: Given any failure of live processing (the live service unavailable, slow, erroring or
  restarting, a live piece rejected), then the recording status, the "Recording" indicator and
  elapsed time, the saving of audio, pause, resume, stop and the final processing behave
  exactly as in specs/021, and the meeting's final transcript is the same as it would be with
  live mode off.
- AC-4.2: Given live processing is slow or has a backlog, then saving audio never waits for it
  and stopping never waits for live text to catch up: the save progress after stop and the
  moment the status becomes `processing` are those of AC-2.7 of 021.
- AC-4.3: Given live text becomes unavailable during a recording, then the panel says "Live text
  unavailable. The recording continues and the full transcript will be made after you stop",
  offers "Try again", retries by itself, and on recovery resumes live text and marks the live
  gap (AC-2.5); sending a question is disabled with the reason while unavailable.
- AC-4.4: Given the connection is lost while the tab stays open (AC-2.9 of 021), then the
  panel says live text is paused for lack of connection, and on reconnection live text covers
  the audio saved since, and any stretch that cannot be covered is a live gap. No text of
  audio captured while offline is produced before that audio is saved.
- AC-4.5: Given a tab closed or a browser crash, then AC-2.8 of 021 applies; the provisional
  transcript is not restored on any device, and a meeting that reads `interrupted` shows none.
- AC-4.6: Given the creator stops the recording, then live processing ends, the panel's
  question control is replaced by "Questions about the whole meeting are available when the
  transcript is ready", and a live question accepted before stopping is answered or becomes
  failed within 60 seconds; a failed one cannot be retried live and says to ask again when the
  transcript is ready. No question is accepted from provisional text while the meeting is
  `processing`.
- AC-4.7: Given a recording that reaches 3 hours, then live mode ends with the recording
  (AC-2.11 of 021).
- AC-4.8: Given a second device attempting to record the same meeting, then it is refused as
  in AC-2.11 of 021 and offers no live mode.
- AC-4.9: Given the authorization service becomes unavailable during a recording, then the
  recording and the panel's text continue and only the questions are refused (AC-3.10).
- AC-4.10: Given the creator's account is deactivated during a recording, then no further live
  question is accepted (AC-3.10), the meeting is frozen as in AC-5.11 of 021, and no request
  returns the provisional transcript any more.

### US-5: When the final transcript arrives
As a meeting creator, I want the final transcript to replace the live text cleanly and my live
questions to stay understandable, so that I know what to trust after the meeting.

**Acceptance criteria:**
- AC-5.1: Given a meeting that becomes `ready`, then its transcript is the final transcript
  only, with speaker labels and segments (AC-6.1, AC-6.2 of 021); no line of the provisional
  transcript appears in it, in its search, copy, download, summaries or questions, and the live
  panel is gone.
- AC-5.2: Given live turns, then they stay in the creator's conversation in time order among
  ordinary questions, each tagged "Live" with its coverage point, and each marked
  **superseded** once the final transcript exists: "Answered from the provisional live
  transcript, which has been replaced; it may differ from the final transcript".
- AC-5.3: Given a citation on a superseded live turn, then the quoted excerpt and its time stay
  with the turn, selecting it shows the excerpt in place marked "From the live transcript", and,
  once the final transcript exists, offers "Go to this time", which scrolls to and highlights the
  final segment that covers that time. It is never presented as a final segment and does not
  claim the final text matches.
- AC-5.4: Given a superseded live turn, then "Ask again" sends the same question as an ordinary
  question against the final transcript (AC-9.1 of 021) as a new AI request counted in the
  limit; the live turn is unchanged.
- AC-5.5: Given an ordinary question after the final transcript exists, then the turns it
  takes into account (AC-9.4 of 021) do not include live turns, whose answers came from a
  different, replaced source.
- AC-5.6: Given the final transcription fails (AC-6.9 of 021), then no provisional text is shown
  as a transcript or in any other form, the live turns stay, and retry is offered as in
  specs/021.
- AC-5.7: Given the final transcript has no speech (AC-6.7 of 021), then the live turns stay
  readable and asking is disabled as in specs/021.
- AC-5.8: Given an `interrupted` meeting, then no provisional text is shown for it (AC-4.5);
  when the creator chooses "Process what was captured", its live turns stay and become
  superseded once the transcript is `ready`, and when the creator chooses "Discard", the live
  turns of that recording are deleted with its audio.
- AC-5.9: Given a transcript edited by the creator (AC-6.3 of 021), then live turns are
  unaffected and are not labelled "based on an earlier version".

### US-6: Privacy, retention and residency of live processing
As a person who is recorded, and as wellD, I want live processing to be no looser than the
final processing, so that live mode does not open a way for conversations to be kept or sent
somewhere they should not be.

**Acceptance criteria:**
- AC-6.1: Given live audio and live text, then they are processed only in the EU or
  Switzerland by a processor that, contractually, retains nothing after the request and does
  not train on it; the bounded retention exception of specs/021 (A6, batch transcription
  result, about 5 days) does not apply to live mode.
- AC-6.2: Given the service is configured with a location for live processing outside the EU
  and Switzerland, then it refuses to start (extending AC-4.9 of 021).
- AC-6.3: Given live mode, then no additional copy of the audio is kept for it: the only
  retained audio is that of AC-4.4 of 021, and nothing of the audio or the provisional
  transcript is written to the browser's storage (AC-4.11 of 021).
- AC-6.4: Given the provisional transcript, then it is unreadable by anyone as soon as the
  meeting leaves `recording` (stop, discard, or reading `interrupted`), and irrecoverably
  deleted within 24 hours of that moment, or at once when the meeting is deleted; a live
  question accepted before stopping (AC-4.6) is the only reason it is read after that.
- AC-6.5: Given any request, then logs and error reports hold identifiers and sizes only, never
  provisional text, live questions, live answers or quoted excerpts (AC-4.10 of 021).
- AC-6.6: Given any role, administrator and `meeting:erase` holder included, then holding it
  never grants reading the provisional transcript or a live turn (AC-4.8 of 021).
- AC-6.7: Given a meeting deleted (AC-4.6 of 021), then its live turns, quoted excerpts and any
  provisional text are deleted with it; given "Delete recording" (AC-4.5 of 021), then live
  turns are unaffected.
- AC-6.8: Given live mode, then no notification, host notice or CRM activity carries or is
  created by live content, and no new host-notice event exists.

### US-7: Language and accessibility
As a user, I want live mode in my language and usable without a mouse or a flood of
announcements, so that it does not get in the way of a conversation.

**Acceptance criteria:**
- AC-7.1: Given the live UI and the consent notice, then every string exists in English and
  Italian, with the tests of parity and of no hard-coded copy of AC-13.1 of 021.
- AC-7.2: Given live mode, then live text is in the meeting's language (fixed once the
  recording started, AC-1.8 of 021) and is not translated; questions may be in English or
  Italian.
- AC-7.3: Given the live controls (switch, panel, question field, send, retry, citations, "Jump
  to latest", "Try again"), then every one is reachable and operable from the keyboard in a
  logical order, and the state changes of AC-7.4 are announced.
- AC-7.4: Given a screen reader, then the panel's text lines are not announced as they arrive;
  only these are announced, politely and briefly: live mode turned on or off, live text
  unavailable and restored, "Answer ready" or "Answer failed", and the rate-limit refusal. The
  same kind of announcement is made at most once per 30 seconds, so a flapping connection does
  not chatter. Focus never moves by itself.
- AC-7.5: Given the panel, then the answer text is reachable by moving to it with the keyboard,
  and the provisional marking, gaps and failures are conveyed in text, not colour alone.

## Non-goals

- **Live summaries.** Summaries stay after the fact on the final transcript; a summary made
  from text that will be replaced would mislead.
- **A saved or exportable live transcript.** The provisional transcript is not the record: no
  search, copy, download or reuse as a summary input (AC-2.8). The final transcript is the only
  one.
- **Speaker labels in live text.** Whoever said it is a property of the final transcript; live
  answers say so rather than guess (AC-3.3).
- **A live view or live questions for anyone but the creator**, including Operai participants
  and host-visible readers, and live use from a second device (owner decision 2026-11-05, O1,
  O2).
- **Live mode for uploaded recordings and pasted text.** There is no live moment.
- **Questions while the meeting is `processing`**, after the recording stops, from the
  provisional text (owner decision 2026-11-05, O9).
- **Showing a provisional transcript when the final one fails** (owner decision 2026-11-05,
  O10).
- **Showing text before it is settled** (rewriting interim guesses): fewer surprises and an
  answer that matches what the creator saw.
- **Proactive AI**: no suggestions, alerts, automatic notes, action items or answers the
  creator did not ask for during the meeting.
- **Voice input of questions and spoken answers.** Typed only; speaking to the tool would be
  recorded into the meeting.
- **Live captions as an accessibility service for attendees**, and live translation.
- **Questions across meetings** (the non-goal of 021 stands).
- **Languages other than Italian and English**, automatic language detection (021).
- **Changes to the final transcription, to speaker labels, or to the hourly limit's size.**
- **New notifications, host notices or CRM activities.**

## Open questions

None open. All ten were closed by the owner on 2026-11-05, each as recommended; the ACs above
are written to these decisions. (owner: user for all)

- [x] O1 Who can use live mode and from where — decided 2026-11-05: only the creator holding
  `meetings:access`, on the tab that is recording (AC-1.7, AC-2.9).
- [x] O2 Live view for other participants or host-visible readers — decided 2026-11-05: no;
  non-goal.
- [x] O3 Default and scope of the switch — decided 2026-11-05: off by default, per recording
  session, switchable on and off during the session (AC-1.1, AC-1.8).
- [x] O4 Latency bounds — decided 2026-11-05: as proposed (settled text within 20 s at p95,
  live answer within 20 s at p95 and 60 s as the failure point, coverage refreshed at most
  every 10 s; AC-2.3, AC-3.7). The architect confirms feasibility in plan.md; an infeasible
  figure is a spec amendment.
- [x] O5 Rate limit — decided 2026-11-05: a live question is one AI request in the shared 30
  per hour (AC-3.9). Known risk, accepted: a busy live session can use the hour's allowance
  and block summaries afterwards.
- [x] O6 Live turns after the final transcript — decided 2026-11-05: kept in the creator's
  conversation, marked superseded, quoted excerpts kept with an approximate "Go to this time",
  "Ask again" against the final transcript, and excluded from later question context (US-5).
- [x] O7 Retention exception for live — decided 2026-11-05: none. Live audio and text are held
  to the strict no-retention rule; specs/021's bounded 5-day batch exception (A6) does not
  apply (Constraints, AC-6.1).
- [x] O8 Consent — decided 2026-11-05: the notice names live mode and carries a new version;
  a draft whose consent was given under the old notice re-confirms only when live mode is
  switched on (AC-1.4, AC-1.5). The wording is still to be reviewed by the data-protection
  lead before release (no change to this spec expected).
- [x] O9 Questions during `processing` — decided 2026-11-05: not offered (AC-4.6, AC-6.4).
- [x] O10 Provisional text if the final transcription fails — decided 2026-11-05: not shown
  (AC-5.6).
