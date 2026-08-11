---
id: 014
slug: motivo-autocomplete
status: in-progress
rigor: production
created: 2026-08-11
approved: 2026-08-11
---

# Motivo autocomplete from the employee's own past mileage lines

## Problem

Mileage is the most repetitive expense an employee files: the same client visit, the
same commute to the same office, the same airport run, claimed over and over across
months. Today every one of those lines is composed from scratch — the employee retypes
the same **motivo** free-text, re-enters the same distance, and re-picks the same entity,
with nothing carried over from the dozens of identical lines already in their own
history. The cost is not only keystrokes: retyping produces drifting descriptions of what
is objectively the same trip ("Milano-Lugano", "milano → lugano", "MI-LUG cliente"),
which makes an employee's own history hard to scan, and a hand-retyped distance is a
place for a typo to silently change a computed reimbursement amount now that
`specs/009-mileage-rate` derives the money directly from km. The employee already told
us what this trip is worth — repeatedly — and the app makes them say it again every time.

## Domain language

Extends `specs/007-refund-service`'s domain language (request / expense line / expense
type / entity / currency / requested amount) and `specs/009-mileage-rate`'s (computed
amount / effective rate / snapshot), both reused verbatim. New terms for this feature:

- **suggestion** — one proposed past trip offered to the employee while they type in the
  Motivo field of a `travel-km` line. A suggestion is not a stored record and is never
  itself editable, deletable, or manageable: it is a live, derived view over the
  employee's own past expense lines (compare `specs/009`'s derived effective rate,
  ADR-0013 lineage).
- **trip signature** — what makes two past lines "the same trip" for the purpose of
  collapsing them into one suggestion: their **normalised motivo**, their distance (km),
  and their entity, all three equal. Two lines that share a motivo but differ in distance
  or entity are different trips and stay separate suggestions (US-2).
- **normalised motivo** — a motivo reduced for comparison only: surrounding whitespace
  trimmed, runs of internal whitespace collapsed to a single space, and compared
  case-insensitively and accent-insensitively (so `"Milano  →  LUGANO "`, `"milano →
  lugano"` and `"Milano → Lugàno"` are one trip). Normalisation is never persisted and
  never shown — what the employee sees is always a real motivo exactly as they once typed
  it (AC-2.5).
- **suggestion window** — the stretch of history a suggestion may be drawn from: expense
  lines whose **expense date** falls within the last 24 months relative to today. Older
  lines are never proposed (AC-2.4).

## User stories

### US-1: Employee is offered past trips while typing a mileage line's motivo

As an employee filing a mileage expense, I want the app to propose trips I have already
claimed as I start typing the reason, so that I can pick a trip I take routinely instead
of retyping its description and distance from memory every single time.

**Acceptance criteria:**

- AC-1.1: Given the expense-line composer whose expense type is anything other than
  `travel-km` (including no type selected yet), when the employee types in the Motivo
  field, then no suggestions are shown and none are requested — this feature is entirely
  invisible outside `travel-km`.
- AC-1.2: Given the composer whose expense type is `travel-km`, when the employee has
  typed at least 2 non-whitespace characters into Motivo, then the suggestions matching
  that text (US-2) are presented beneath the Motivo field.
- AC-1.3: Given suggestions are showing, when the employee reduces the Motivo text below
  2 non-whitespace characters (including clearing it entirely, or leaving only
  whitespace), then no suggestions are shown and any open suggestion list closes.
- AC-1.4: Given the employee has typed at least 2 characters, when suggestions are
  matched, then a past trip matches if the typed text occurs **anywhere** within its
  normalised motivo — not only at the start — compared case-insensitively and
  accent-insensitively. Typing `lug` matches a past `"Milano → Lugano client visit"`.
- AC-1.5: Given more past trips match than can usefully be shown, when the suggestion
  list is presented, then at most 8 suggestions are shown at once.
- AC-1.6: Given the employee has typed at least 2 characters and no past trip matches,
  when the suggestions would be presented, then no list and no error/empty-state message
  appear — the field behaves as an ordinary text input.
- AC-1.7: Given a suggestion is presented, when the employee reads it, then it shows at
  minimum: the trip's motivo text, its distance in km, its entity, **how many past lines
  its trip signature groups** within the suggestion window, and that same group's **most
  recent expense date** — enough to tell two same-motivo trips of different distance or
  entity apart (US-2, AC-2.2) and to see why the list is ordered as it is. The count and
  the date shown are exactly the two ranking signals of AC-2.3, taken from the same group
  whose motivo text is displayed (AC-2.5); consequently a suggestion never shows a lower
  count than a suggestion listed below it.
- AC-1.8: Given an existing, already-saved `travel-km` line is being edited in place (in
  its own line row rather than in the composer), when the employee types in that line's
  Motivo field, then no suggestions are requested and none are shown — the field behaves
  exactly as it does today. This feature exists only on the composer used to add a new
  line.

### US-2: The trips I claim most often come first, and identical trips appear once

As an employee, I want my routine trips at the top of the list and each distinct trip
listed only once, so that the suggestion I want is the first thing I see rather than
buried under fifty copies of itself.

**Acceptance criteria:**

- AC-2.1: Given the employee has multiple past `travel-km` lines sharing one trip
  signature (equal normalised motivo, equal km, equal entity), when suggestions are
  presented, then those lines collapse into exactly **one** suggestion.
- AC-2.2: Given two past `travel-km` lines whose normalised motivo is equal but whose km
  or entity differ, when suggestions are presented, then they appear as two **separate**
  suggestions — differing distance or entity means a different trip, never a merge.
- AC-2.3: Given several suggestions match the typed text, when they are ordered, then
  they are sorted by how many past lines each trip signature groups, descending; ties are
  broken by the group's most recent expense date, descending.
- AC-2.4: Given a past `travel-km` line whose expense date is more than 24 months before
  today, when suggestions are matched, then that line is excluded — it neither appears as
  a suggestion nor contributes to any group's count or ordering (AC-2.3).
- AC-2.5: Given a trip signature grouping several past lines whose motivo text differs
  only by casing, accents, or whitespace, when its suggestion is displayed, then the text
  shown is the motivo of the group's **most recent** line, exactly as originally typed —
  never a normalised, lower-cased, or accent-stripped rendering.
- AC-2.6: Given the employee has past `travel-km` lines across requests in any status —
  including lines in a request still in `draft`, and including `submitted`, `approved`,
  `rejected` and `paid` — when suggestions are matched, then lines of every status are
  eligible (see Constraints: accepted trade-off).

### US-3: Picking a suggestion fills in the trip's stable facts

As an employee, I want clicking a proposed trip to fill in everything about that trip
that doesn't change between claims, so that all I have left to do is confirm the date and
add the line.

**Acceptance criteria:**

- AC-3.1: Given a suggestion is presented, when the employee picks it, then the line's
  Motivo, distance (km), and entity are set to that suggestion's values.
- AC-3.2: Given a suggestion is picked, when the fields are filled, then the line's
  **expense date is left untouched** — it keeps whatever the employee had set (by default
  today). A new claim is for a new date; the suggestion never carries a past date forward.
- AC-3.3: Given a suggestion is picked on a `travel-km` line, when the fields are filled,
  then **no amount and no currency field is filled, shown, or introduced** — the amount
  remains the derived `km × effective rate` figure and the currency remains
  entity-designated, exactly as `specs/009-mileage-rate` (AC-1.1/AC-1.6) established.
- AC-3.4: Given the employee has already typed a motivo, entered a distance, or chosen an
  entity, when they pick a suggestion, then those three fields are **overwritten** by the
  suggestion's values — picking is an explicit deliberate act, not a fill-the-blanks
  merge whose result depends on typing order.
- AC-3.5: Given a suggestion is picked, when the fields are filled, then the suggestion
  list closes and the line's computed amount re-derives from the newly filled km and
  entity against the employee's current expense date, per `specs/009` (AC-1.2/AC-1.3).
- AC-3.6: Given a suggestion has just been picked, when the employee then edits the
  Motivo, distance, or entity, then those edits apply normally — a picked suggestion
  produces ordinary editable field values, never a locked or read-only line.
- AC-3.7: Given a suggestion is picked, when the fields are filled, then the line is
  **not** saved or added — the employee still has to add the line explicitly, exactly as
  for a hand-typed one.

### US-4: An employee is only ever shown their own history

As wellD, we want an employee's suggestions to be drawn exclusively from their own past
lines, so that free-text that routinely names clients, sites, and destinations is never
exposed to a colleague through an autocomplete.

**Acceptance criteria:**

- AC-4.1: Given any employee composing a `travel-km` line, when suggestions are
  presented, then every suggestion derives exclusively from expense lines on that same
  employee's own requests — no other employee's line ever appears.
- AC-4.2: Given a user who additionally holds accounting review capability over other
  employees' requests, when they compose their own `travel-km` line, then their
  suggestions are still drawn only from their own past lines — a review capability grants
  no additional suggestion reach (contrast `specs/007`'s review surfaces, which
  deliberately do span other employees).
- AC-4.3: Given any caller with any combination of capabilities, when the mechanism
  backing suggestions is exercised directly rather than through the composer, then it
  never returns motivo text, distance, or entity originating from another user's expense
  line.
- AC-4.4: Given suggestions are requested and presented, when the interaction completes,
  then no new store, log, or record of motivo text is created — suggestions are derived
  from the existing expense lines and nothing about the typing or the picking is
  persisted.

### US-5: The autocomplete never gets in the way

As an employee, I want the suggestions to stay out of my way when they can't help me, so
that a brand-new trip, a keyboard-only workflow, or a backend hiccup never makes filing an
expense harder than it was before this feature existed.

**Acceptance criteria:**

- AC-5.1: Given the employee is typing a motivo they have never used before, when no
  suggestion matches or they simply ignore the list, then they can complete and add the
  line exactly as before — suggestions never alter, autocomplete-in-place, or block the
  text being typed.
- AC-5.2: Given the mechanism backing suggestions fails, errors, or does not answer in
  reasonable time, when the employee is typing a motivo, then no error message, banner, or
  toast is surfaced and no list appears — the field degrades silently to an ordinary text
  input and composing, adding, and submitting the line are entirely unaffected.
- AC-5.3: Given the suggestion list is open, when the employee presses the Down or Up
  arrow key, then the highlighted suggestion moves accordingly; when they press Enter with
  a suggestion highlighted, then that suggestion is picked (US-3) and the containing form
  is **not** submitted; when they press Escape, then the list closes and the text they had
  typed remains exactly as typed.
- AC-5.4: Given the suggestion list is open with no suggestion highlighted, when the
  employee presses Enter, then no suggestion is picked and the keypress behaves exactly as
  it does today with no list open.
- AC-5.5: Given the suggestion list is open, when the employee moves focus away from the
  Motivo field or clicks outside the list, then the list closes and the typed text is left
  unchanged.
- AC-5.6: Given an employee using a screen reader, when suggestions appear, change count,
  or are highlighted, then the field exposes standard combobox semantics and the presence
  and highlighted state of suggestions are announced — the feature is fully operable
  without a pointer.
- AC-5.7: Given any user-facing text this feature adds — suggestion labels, the grouped
  count and most-recent date shown on a suggestion (AC-1.7), and every accessibility label
  or screen-reader announcement (AC-5.6) — when it is displayed, then it is read from the
  app's centralised copy module, in English, under that module's existing namespaced
  key-path convention and conforming to the string type that module exports. Objectively
  checkable as: this feature's components introduce no user-facing string literal inline,
  and every string this feature adds is reachable through a key path on that module and is
  typed against its exported type — so adding a second locale later remains a mechanical
  addition of a parallel dictionary rather than a rewrite of this feature.

## Non-goals

- **Autocomplete on the other eleven expense types.** Only `travel-km` is in scope
  (AC-1.1). The suggestion mechanism should be shaped so that widening to further types is
  a filtering change rather than a redesign, but no other type gains this behaviour now.
- **Motivo autocomplete on the in-place line-editing surface** (AC-1.8) — the pain this
  feature addresses is *composing* a new line from scratch, whereas a line that already
  exists already carries its km and entity, so autofill has little left to give. A
  deliberate deferral decided by the user (2026-08-11), not an oversight: extending it to
  the edit surface later would additionally have to settle whether the line being edited
  excludes itself from its own suggestions.
- **Suggesting from any other employee's lines**, including a team's or a department's
  shared history, and including for accounting users (US-4). Motivo text is personal
  free-text naming clients and destinations.
- **Filling the expense date from a suggestion** (AC-3.2) — a new claim is a new date.
- **Filling or introducing an amount or currency field on a `travel-km` line** (AC-3.3) —
  `specs/009-mileage-rate` made both derived for this type; this feature does not reopen
  that.
- **Introducing an i18n library, a locale seam or switch, or Italian copy** — neither for
  this feature nor for `refund-ui` generally (AC-5.7). `specs/007-refund-service` decided
  at its Gate 2 that the app ships English-only-but-i18n-ready copy, and translating this
  feature's handful of new strings on its own would produce a mixed-language UI — worse
  than either consistent option. The app-wide bilingual rollout is deferred to its own
  future spec, not forgotten.
- **Fuzzy, typo-tolerant, phonetic, or semantic/embedding-based matching.** Matching is
  plain normalised substring (AC-1.4); a misspelt past motivo simply won't be found by a
  correctly-spelt query.
- **Any surface for managing suggestions** — no editing, deleting, hiding, pinning, or
  blacklisting a proposed trip, and no "saved trips"/templates/favourites feature. A
  suggestion is a derived view of real past lines, never a stored object.
- **Suggesting a whole request, or adding several lines at once.** A pick fills exactly
  one line being composed (AC-3.7).
- **Any change to how expense lines are stored, validated, or priced**, to the twelve-type
  catalogue, to mileage-rate resolution or snapshotting (`specs/009`), or to any
  accounting review, batch, or audit surface (`specs/007`, `specs/008`).
- **Cross-entity or cross-currency normalisation of suggested trips.** Entity is part of
  the trip signature (AC-2.2); the same route claimed under two entities stays two
  suggestions and no conversion is ever performed.
- **Persisting suggestions client-side across sessions** (offline cache, local storage).
  Nothing about the employee's motivo history is written to the browser by this feature.

## Constraints

*Facts already established by the codebase and prior specs, captured for the plan, not
elaborated here.*

- **`travel-km` lines carry no employee-entered amount or currency.**
  `specs/009-mileage-rate` (AC-1.1/AC-1.6) replaced both for this type: the amount is the
  derived `km × effective rate`, and the currency is entity-designated (WellD CH → CHF,
  WellD Italia → EUR). In the composer the currency control is **absent, not disabled**,
  and for `travel-km` both `currency` and the requested amount are server-derived and
  omitted from the line payload entirely. **Consequently the fill set for a picked
  suggestion is exactly motivo + km + entity** — filling currency independently is not
  possible for this type and would contradict `specs/009`.
- `motivo` is an existing, always-present free-text field on every expense line
  (`specs/007`); this feature adds no field and changes no line schema.
- The employee-facing line composer is an existing component with an existing Motivo text
  input; this feature layers combobox behaviour onto that input rather than introducing a
  new form.
- The line draft carries distance and amount as user-typed **strings**, converted at the
  API boundary — a picked suggestion's numeric distance must land in that draft in the
  same shape a hand-typed one does.
- `refund-api` is an authorization-enforcing resource server (ADR-0014): it resolves the
  caller's live permissions on every request and fails **closed** (503) if the
  authorization service is unavailable. Note the tension with AC-5.2's silent degradation:
  the *client* must degrade silently, which is not the same as the server failing open.
- The suite's standing posture for an optional enrichment that cannot be delivered is
  silent graceful degradation, never a blocked or erroring primary flow (ADR-0032).
- Derived, computed-on-read state is the suite's established pattern in preference to
  stored or scheduled state (ADR-0013, and `specs/009`'s effective-rate resolution).
- **User-facing copy is centralised in one module with no hardcoded UI strings, and ships
  ENGLISH ONLY.** `specs/007-refund-service` made this call at its Gate 2, deliberately
  keeping that module i18n-*ready* rather than bilingual: every string sits under a stable
  namespaced key path and the module's string type is exported, so a second locale is a
  mechanical addition rather than a rewrite. There is no i18n library and no Italian copy
  anywhere in `refund-ui` today.
- **Drift resolution (decided by the user at the plan gate, 2026-08-11):** AC-5.7
  originally demanded this feature's copy "in both Italian and English". That contradicts
  the `specs/007` Gate-2 precedent above and is not satisfiable — shipping Italian for this
  feature's handful of strings alone would yield a mixed-language UI, and doing it properly
  is an app-wide effort. AC-5.7 now requires centralised, namespaced, typed **English**
  copy that stays i18n-ready. Scope is unchanged, so this amendment does not reopen
  approval; the app-wide bilingual rollout is explicitly deferred as a separate concern
  (see Non-goals).
- Expense-line data is personal data under the suite's EU data-residency rules — it stays
  in the EU region and is not logged beyond standard access logs.
- **Accepted trade-off (decided by the user, 2026-08-11):** the suggestion corpus includes
  lines belonging to requests still in `draft` (AC-2.6), not only lines that ever reached
  `submitted`. The known cost is that half-typed, abandoned, or mistaken draft lines can
  surface as suggestions; the benefit is that a trip becomes reusable immediately, before
  the month's request is ever submitted.

## Open questions

- None outstanding. The three architect-owned questions this spec carried — the transport
  and computation shape for suggestions, the debounce interval and out-of-order response
  handling, and the query/indexing strategy for the normalised accent-insensitive
  substring match — were all resolved by `specs/014-motivo-autocomplete/plan.md`, approved
  2026-08-11.
