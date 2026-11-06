# Domain glossary

## Terms

### Hardware inventory (specs/015)
- **Asset**: one physical hardware unit owned by one entity, from registration until
  disposal; never a quantity (13 monitors are 13 assets). _Avoid:_ device (UI copy only),
  item, row.
- **Asset category**: the kind of asset, from a fixed list; for filtering and reporting
  only, never an input to depreciation. _Avoid:_ type, class.
- **Holder**: the Operai account an asset is currently assigned to; an asset with no
  holder is company stock. A party without an account is never a holder. _Avoid:_
  assignee, owner (the entity owns the asset).
- **Asset status**: exactly one of `ordered`, `in_stock`, `assigned`, `in_repair`, `lost`,
  `disposed`. `lost` (lost or stolen) is still on the books; only `disposed` is not.
- **Assignment**: the act of giving an asset to a holder; `pending` until the employee
  confirms receipt, then `confirmed`, `declined` or `cancelled`. Never expires.
  _Avoid:_ handover.
- **Depreciation rule**: the per-entity parameters (useful life, first-year share,
  low-value threshold, residual value) that turn a purchase price into a schedule;
  applies to assets purchased on or after its effective date and is never edited.
- **Schedule**: one asset's yearly depreciation amounts, from its purchase year until it
  reaches its residual value. _Avoid:_ plan, amortisation table.
- **Book value**: purchase price minus all depreciation booked so far, at a given date;
  zero from disposal onward.
- **Residual value**: the book value a schedule stops at (CHF 1.00 for `welld_ch`, zero
  for `welld_it`). _Avoid:_ memo value, pro-memoria.
- **Disposal**: the accounting act that takes an asset off the books, with a reason
  (`ceded_to_employee`, `sold`, `scrapped`, `returned_to_vendor`, `lost`); irreversible.
  _Avoid:_ cession, write-off (both are reasons or effects, not the act).
- **Fiscal year**: the calendar year, per entity; `open` or `closed`. A closed year is
  frozen and never reopened.
- **Roll-forward**: the per-entity, per-fiscal-year statement: opening book value −
  disposals + purchases − depreciation = closing book value.
- **Inventory manager**: the capability to register, assign, take back, repair and mark
  assets lost; sees purchase prices, not book values.
- **Hardware accountant**: the capability to see schedules and book values, maintain
  depreciation rules, dispose of assets and close fiscal years.

### Service-to-service credentials (specs/016)
- **Shared token**: the single static secret `auth`, `refund-api` and `estimai-api`
  used to present to the notification service's internal endpoints; retired by
  specs/016 (ADR-0049) and refused since. _Avoid:_ internal token, system token.
- **Service credential**: what a service client presents to the notification service:
  short-lived, issued by `auth` to that one client, carrying its identity and scopes.
  _Avoid:_ service token where the shared token could be meant.
- **Scope**: one named permission carried by a service credential: **push** (send an
  in-app notification) or **email** (send an email).
- **Caller**: a service that reaches the notification service's internal endpoints.
- **Transition**: the period in which the notification service accepted both the shared
  token and service credentials; it ended with specs/016's third push.

### Meetings (specs/021)
- **Meeting**: one conversation captured in Operai, with one source, a transcript,
  summaries and per-user conversations. _Avoid:_ call, session, recording (the recording
  is only its audio).
- **Host / host reference**: an Operai app that lets users start and list meetings about
  its own records; the `{app, entity type, entity id}` link from a meeting to such a
  record. _Avoid:_ parent, context, linked entity.
- **Standalone meeting**: a meeting with no host reference.
- **Source**: how a meeting's content arrived — `recorded`, `uploaded` or `text`; exactly
  one per meeting. _Avoid:_ input, channel.
- **Transcript / segment / speaker label**: the meeting as text, split into timed segments,
  each with a best-effort speaker label. _Avoid:_ notes, minutes (a template output).
- **Summary**: an AI-generated text produced from the transcript through a template; a
  meeting has several. _Avoid:_ minutes, report.
- **Summary template**: ordered sections (heading + instruction); built-in, shared or
  personal. _Avoid:_ prompt, format.
- **Conversation**: one user's private question-and-answer history with one meeting.
  _Avoid:_ chat, thread.
- **Consent attestation**: the recorded confirmation, before audio is captured or uploaded,
  that the people in the meeting were told and agreed.
- **Operai participant / external participant**: a participant with an Operai account / a
  participant who is only a name. _Avoid:_ attendee, guest.
- **Host-visible**: the creator's opt-in that makes a meeting readable to those who can
  open its host entity.
- **Host notice**: the content-free message an opted-in host receives when a meeting
  linked to its entity is created, changed, relinked, unlinked or deleted. _Avoid:_
  webhook, callback.
- **Frozen meeting**: a meeting whose creator's account is deactivated; still readable by
  participants, not editable, deletable only by a `meeting:erase` holder. _Avoid:_
  orphaned, archived.
- **Meeting activity**: the CRM activity of type `meeting` that a meeting linked to a deal
  creates on the deal. _Avoid:_ meeting log.
- **Host registry**: the list of hosts meetings-api accepts (app + entity type, whether it
  receives host notices); data in meetings-api, `crm/deal` only in production.
- **Host extension** (host panel): the Meetings-owned panel a host page embeds through the
  shell to start and list meetings for its entity.
- **Recording session**: one continuous browser capture of a recorded meeting, uploaded as
  a sequence of chunks.
- **Chunk**: one ~10 s slice of a recording session's audio, uploaded on its own.
- **Transcript part**: a span of one recording transcribed as one unit, with its own speaker
  numbering; labels from different parts are merged only by renaming. _Avoid:_ chunk (that is
  the ~10 s upload slice).
- **Transcription result**: the text output of transcribing a recording; the one item a
  processor may keep, for about 5 days (specs/021 A6).
- **Transient copy**: audio held in wellD-controlled EU/CH storage only for one
  transcription attempt (specs/021 AC-4.12). _Avoid:_ staging file, temp upload.
- **Live mode** (specs/022): a per-recording-session switch on a `recorded` meeting that makes
  provisional text and live questions available to the creator.
- **Provisional transcript** (live text): unlabelled, creator-only text produced during
  recording and replaced by the final transcript. _Avoid:_ transcript (that is the final one).
- **Settled text**: the part of the provisional transcript that will no longer change; only it
  is shown and used to answer.
- **Coverage point**: the recording time (mm:ss) up to which settled text exists; stated in
  every live answer.
- **Live gap**: a stretch of recording time captured but with no live text.
- **Live turn**: a question asked and answered during recording, from provisional text only.
- **Superseded**: the state of a live turn once the final transcript exists.
- **Passage**: the citation unit of a `text`-source meeting (the counterpart of a segment).
- **Processing stage**: one step of turning a source into a transcript (upload check,
  audio extraction, transcription).
- **Deletion entry**: the content-free "who deleted what, when" record a real deletion
  leaves behind.
- **AI request**: one summary generation or one question to a meeting — the unit of the
  per-user hourly limit.
### Access to the suite (specs/023)
- **Allowed domain**: an email domain whose holders may become Operai users at all —
  `welld.ch` and `welld.it`; matched exactly and case-insensitively, subdomains excluded.
  _Avoid:_ whitelist, company domain.
- **Access request**: the record created when a person with an allowed-domain email signs
  in without a live pending invitation; grants nothing, never a user, at most one per
  email. State `pending`, `approved` or `rejected`. _Avoid:_ sign-up, registration,
  pending user.
- **Waiting list**: the access requests in state `pending`. _Avoid:_ queue, backlog.
- **Approve** (an access request): creates an invitation for the requester through the
  invitation flow; it never creates a user by itself.

## Relationships
- An **Asset** belongs to exactly one entity for its whole life and has at most one
  **Holder** and at most one `pending` **Assignment** at a time.
- An **Asset** has exactly one **Schedule**, produced by the one **Depreciation rule** in
  force for its entity on its purchase date.
- A **Roll-forward** belongs to one entity and one **Fiscal year**; each line is the sum
  of that year's per-asset figures.
- A **Meeting** has exactly one **Source**, at most one **Host reference**, one
  **Transcript**, up to 20 **Summaries** (each snapshotting its **Summary template**) and
  one private **Conversation** per user who asked.
- An **Access request** that is approved leads to exactly one invitation; the person
  becomes a user only by accepting it.

## Open ambiguities
- Whether the `welld_ch` **Residual value** is kept until **Disposal** or written off the
  year after the **Schedule** ends (specs/015 O4) — owner: accounting.
