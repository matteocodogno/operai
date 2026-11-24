# Domain glossary

## Terms

### Hardware inventory (specs/20261006-hardware-inventory)
- **Asset**: one physical hardware unit owned by one entity, from registration until
  disposal; never a quantity (13 monitors are 13 assets). _Avoid:_ device (UI copy only),
  item, row.
- **Asset category**: the kind of asset, from a fixed list; for filtering and reporting
  only, never an input to depreciation. _Avoid:_ type, class.
- **Holder**: the Operai account an asset is currently assigned to, or the **Office** it is
  in, never both; an asset with no holder is company stock. Apart from an office, a party
  without an account is never a holder. _Avoid:_ assignee, owner (the entity owns the asset).
- **Office**: a wellD place that holds assets (CH - Agno, CH - Lugano, YoRoom - Milano at
  launch), managed by inventory managers, archived never deleted; its entity is information
  only, any asset may be in any office. Assigning to it is immediate. _Avoid:_ location
  (the free-text location/note), site.
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

### Service-to-service credentials (specs/20261013-notify-service-credentials)
- **Shared token**: the single static secret `auth`, `refund-api` and `estimai-api`
  used to present to the notification service's internal endpoints; retired by
  specs/20261013-notify-service-credentials (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired) and refused since. _Avoid:_ internal token, system token.
- **Service credential**: what a service client presents to the notification service:
  short-lived, issued by `auth` to that one client, carrying its identity and scopes.
  _Avoid:_ service token where the shared token could be meant.
- **Scope**: one named permission carried by a service credential: **push** (send an
  in-app notification) or **email** (send an email).
- **Caller**: a service that reaches the notification service's internal endpoints.
- **Transition**: the period in which the notification service accepted both the shared
  token and service credentials; it ended with specs/20261013-notify-service-credentials's third push.

### Meetings (specs/20261104-meetings)
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
- **Attachment**: a file or a link a person added to a meeting (agenda, slides, notes, a
  document), seen by everyone who can open the meeting and read by the AI as background, never
  as evidence of what was said. A file is deleted 29 days after it was added; a link is never
  opened by Operai. _Avoid:_ document (a file only), upload (the audio source).
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
  processor may keep, for about 5 days (specs/20261104-meetings A6).
- **Transient copy**: audio held in wellD-controlled EU/CH storage only for one
  transcription attempt (specs/20261104-meetings AC-4.12). _Avoid:_ staging file, temp upload.
- **Live mode** (specs/20261105-meetings-live): a per-recording-session switch on a `recorded` meeting that makes
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
### Access to the suite (specs/20261105-signup-gate)
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

### Activities (specs/20261110-activities)
- **Activity**: something that happened or must happen about a client relationship or a
  project, recorded by an Operai user; either pre-sales or operational. _Avoid:_ event,
  log entry, interaction.
- **Pre-sales activity**: an activity about a CRM company (optionally one of its contacts and
  deals): a note, call, meeting, email or task. _Avoid:_ CRM activity, sales activity.
- **Operational activity**: an activity about a project; only tasks. _Avoid:_ project
  activity, delivery task.
- **Task**: an activity someone must do, with exactly one assignee and an optional due date,
  open until done; pre-sales or operational. _Avoid:_ to-do, action item, ticket.
- **My tasks**: the tasks assigned to the caller or in which the caller takes part. The CRM
  shows only pre-sales ones; the project module shows both, pre-sales ones badged.
  _Avoid:_ inbox, my work.

### Projects hand-off (specs/20261103-projects-handoff)
- **To-start queue**: the won CRM deals that have no purchase order yet; computed live from
  the CRM on every read, never stored; seen by `sales` and admins only. _Avoid:_ backlog,
  inbox.
- **Purchase order (PO)**: the delivery-side record of one won deal — its deal, client
  company, dates, terms, Bexio order id, estimate link, referent and ops-manager. A project
  has zero or one; a PO is born only from a won deal, together with its project, and is never
  added later nor deleted. Not the offer PDF. _Avoid:_ contract (its earlier name), order.
- **A PO's deal**: the won deal a PO was made from; the PO keeps the deal's id and its
  estimate id.
- **Terms**: the type-specific delivery terms (deadline and max effort, SLA, hour package,
  positions, licence period). Required by type on a PO; optional on a hand-made project.
- **Hand-made project**: a project created directly, not from a deal; it never has a PO, its
  creator is its project manager, and it may carry its type's terms.
- **Referent** (referente): the person at the client the delivery talks to — a CRM contact
  of the PO's company, optional; read live from the CRM, never copied onto the PO.
- **Ops-manager** (responsabile OPS): an entity-scoped role; a PO is assigned to one (or to
  an admin) at creation, who is notified and is the only one, besides an admin, who picks
  the project's project manager.
- **Awaiting a project manager**: a project made from a deal whose assigned ops-manager has
  not picked a project manager yet; it cannot become `active` until one is picked.

### CRM offer wizard (specs/20261115-crm-offer-wizard)
- **Offer template**: an entity's named starting point for an offer, in one language; its
  text declares what the wizard asks for. _Avoid:_ offer kind, model.
- **Template field**: a named value of a template the person fills in (label, hint, kind,
  default); **optional** when the text uses it only inside its own conditional text.
  _Avoid:_ placeholder (the markup that writes it), variable.
- **List field**: a template field taking any number of items, printed as bullets.
- **Repeatable table**: a template table whose rows the person adds and removes; each
  column is a field.
- **Optional block**: a passage of a template the person switches on or off. _Avoid:_
  clause (a block may be any passage), group.
- **Block choice**: a group of optional blocks of which exactly one is on.
- **Conditional text**: template text printed only when a field is filled in, or only when
  it is empty (the fallback).
- **Offer draft**: the wizard's saved work in progress on one deal, one per deal, shared
  with whoever may generate offers on it; no number, no PDF. Not crm-api's prefill payload
  of the old dialog. _Avoid:_ bozza offerta in the UI is fine; never "unsent offer" (that is
  a generated offer not yet marked sent).
- **Missing field**: a required template field still empty in an offer draft; an offer
  cannot be generated while one exists.
- **Hand-edited section**: a section whose text was rewritten for one offer; the wizard's
  fields no longer change it until it is restored.

- **Text annex**: an annex written in the template's own text, with the designation its
  author gives it (A, SLA, DPA); printed before the effort-detail annex.
- **Effort-detail annex**: the annex the CRM generates from the estimate (018's "Annex A");
  it takes the next free letter after the text annexes. _Avoid:_ "Annex A" for either.
- **Total row**: a labelled cost-table row summing the one-off and yearly lines since the
  previous total row, minus that stretch's discounts.
- **Option line**: a cost line the client may tick; priced and numbered, never counted in a
  total or in the offer's price. _Avoid:_ optional line (confused with optional block).

### Time tracking (specs/20261112-time-tracking)
- **Time entry**: one person's own declaration — or recorded for them from a meeting (an
  **Automatic entry**) — that they spent a duration, on one day, on one thing — a project, a deal, a meeting, or no entity (then with a category). Not an
  activity, but may point at one. _Avoid:_ timesheet row, worklog, booking.
- **Category** (time tracking): what a time entry on no entity is about (training, talk
  preparation, administration, …), from a list an admin manages. Not the inventory's
  **Asset category**. _Avoid:_ activity type.
- **Work type**: the optional kind of work of a time entry on a project or a deal, from one of
  two lists an admin manages (one for projects, one for deals). _Avoid:_ task type, service.
- **Contractual day**: 8 h 24 min, from 42 hours a week, Monday to Friday. Nothing checks a
  day against it in specs/20261112-time-tracking.
- **Automatic entry**: a time entry Operai records for a person on a Meetings meeting they
  created or took part in, once its duration is known (rounded to 30 minutes); the person's own
  from the moment it exists, and, until they change it, it follows the meeting
  (specs/20261112-meeting-hours). It stays an automatic entry when its person records it on something else;
  its "From meeting" mark shows only while it is recorded on a meeting (D67). _Avoid:_ suggested entry (the
  superseded design), proposal (ProposAI's word), draft entry.
- **Untouched**: said of an **Automatic entry** its person has not changed since Operai recorded it (no saved
  change of day, duration, note or what it is recorded on). Only an untouched entry follows its meeting.
  _Avoid:_ unedited, pristine.
- **Block** (meeting hours): the record that a person must never again get an **Automatic entry** on one meeting,
  because they deleted theirs or already had an entry of their own on it when its duration became known; dropped
  when the meeting is deleted (D66). Not the CRM offer wizard's **Block choice**. _Avoid:_ tombstone, ban.
- **Hours fact**: one of the three things about a meeting its **Automatic entries** are built from — when it
  started, how long it lasted, and which Operai users took part (creator included). A change of title, content or
  external participants is not an hours fact. _Avoid:_ meeting data.
- **Hours notice**: the message Meetings sends to Hours when a meeting's **Hours facts** change or the meeting is
  deleted; it names the meeting and a version and carries the facts as they are when it is sent, never a title
  or content. Not a **Host notice**. _Avoid:_ event, sync.
- **Held duration** / **Measured duration**: the duration a recorded or uploaded meeting holds before its audio is
  processed (the sum of the pieces the browser reported, or what an uploaded file says of itself) / the length
  of its audio as Operai measures it when processing it. The measured one replaces the held one when they differ
  materially (D63, A42). _Avoid:_ real length, actual duration, claimed duration.
- **Consumption**: the hours recorded on a project set against what its terms sold — the hour
  package, the max effort and estimated man-days, or the positions' planned man-days
  (specs/20261112-project-hours). _Avoid:_ burn, usage.
- **Man-day**: 8 hours, in every comparison with what was sold — not the **Contractual day**.
- **Package period**: for a yearly hour package, each 12 months from its start date; for a
  capacity package, from its start date to its expiry. Unused hours never carry over.
- **Alert**: a project task Operai creates when a project reaches a moment that needs a
  decision (a package threshold, an end date, a deadline, idle hours). _Avoid:_ warning,
  reminder, notification (a notification is how notify-api tells a person).

### Teams (specs/20261126-teams)
- **Team**: a named group of Operai users managed by administrators in Admin; it grants no
  permission and may be attached to many projects. Not a **department** (a department confers
  roles). _Avoid:_ group, squad, crew.
- **Archived team**: a team withdrawn from new use — no longer offered, kept with its members,
  restorable, never deleted.
- **On the project**: the project manager, an individually listed member, or an active member
  of an attached team who holds Projects access. _Avoid:_ assigned (hours/activities use
  `assignees` for the same set).
- **Project team**: the people on a project's Team card — individually listed people plus
  attached teams. _Avoid:_ staff.
- **Attached team**: a team a project manager has attached to one project; the project keeps
  only which team, never its name or members, which are read live from auth.
- **Counted member**: an active member of an attached team who holds Projects access; the only
  team members who are **on the project**. _Avoid:_ effective member.

## Relationships
- An **Offer draft** belongs to one deal and starts from one **Offer template**; generating
  it creates an offer whose snapshot holds the draft's answers, and removes the draft.
- A won deal feeds at most one PO, which is born with its own project; a project has zero
  or one PO, and a project created without one never gets one.
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
- A **Time entry** is on exactly one of a project, a deal, a meeting or no entity, and points
  at most at one **Activity**; one **Activity** may have any number of time entries.

## Open ambiguities
- Whether the `welld_ch` **Residual value** is kept until **Disposal** or written off the
  year after the **Schedule** ends (specs/20261006-hardware-inventory O4) — owner: accounting.
- **Letterhead**: the one-page A4 PDF in an entity profile, drawn behind every page of a generated offer
  (a profile without one gets a plain header) and behind every page of the wizard's preview (OA-3). _Avoid:_ header, template.
- **Issuer field**: a template field bound to the entity profile's legal name, supplied by the CRM and
  never asked of the person. _Avoid:_ supplier name field.
- **Issuer address field**: a template field bound to the entity profile's address lines, printed on one
  line joined by ", "; prints nothing when the profile has none.
- **Issuer**: the wellD entity making the offer; its legal name and address come from its entity profile,
  never from template text. _Avoid:_ supplier (the template's «Fornitore» is the defined contract term).
- **Supplied value**: a system value the CRM fills (reference, issuer name, issuer address, …) that the
  wizard never asks for; an empty supplied value prints nothing and is never a missing field.
- **Kept seed**: a seeded template edited by a person before the seed upgrade; left exactly as written.
- **Preview page**: one A4 page of the wizard's preview — a decorative box with the letterhead behind
  it, over which ONE continuous text flow runs inside the PDF's frame (120/110/71/71 pt); page breaks
  approximate the PDF's and the PDF is the authority. _Avoid:_ sheet, slide.
