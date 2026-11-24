---
spec: 20261112
status: draft
---

# Design: Meeting hours — the "From meeting" mark on automatic entries

Inputs read: `spec.md` (approved 2026-11-24: US-1–US-4, 25 ACs, A4–A41), `plan.md` (architecture accepted by the owner;
binding here: § API contracts "hours-ui — changed", D-P5), `operai-ui/docs/{building-pages,design-system}.md`,
`operai-ui/src/index.ts`, `specs/20261112-time-tracking/design.md` and `specs/20261116-record-hours-in-place/design.md`
(S1, S4, S7, S8 and their conventions), and the code the mark lands in: `hours-ui/src/components/{EntryRow,EntryDayList,
TableCellDialog,TableView,EntriesTable,DeleteEntryDialog}.tsx`, `src/lib/{names,hoursApi.types}.ts`,
`src/strings/{entries,names,table}.ts`.

**Library in use: `@operai/ui`** (`operai-ui/`) with Tailwind token utilities, consumed through the shell's Module Federation
singleton; hours-ui is its remote (`AGENTS.md`, ADR 20261031-shared-ui-library-consumed-as-source, 20261114-operai-ui-shared-singleton-provided-by-the-shell). Not Mantine.
No `## Visual direction`: the project has a design system and it wins.

**Scope of this design.** The feature is backend: Operai writes ordinary time entries. The UI changes in exactly one way
(AC-2.3, AC-4.3, plan D-P5): an entry whose `origin` is `meeting` carries a **"From meeting" badge** wherever entries are
listed one by one. Everything else the person does with such an entry (see it in the table view and the List, edit it, delete
it) is behaviour that already exists and is **not redesigned**: the loading, empty and error states of every screen below are
unchanged and are not repeated except where the mark meets them.

**Inspected first-hand, within limits.** The dev shell answered on `:5173` but `auth` (`:3001`) was down, so no authed
page could be opened. I injected a fixture of `EntryRow`'s markup (the library's own classes, the shell's compiled
tokens) into the shell page and measured it at 375 and 320 px (the latter inside a 243 px row, a phone-width dialog's worst
case), light and dark; nothing was written to the repo. Findings are marked **(measured)**. Everyone's hours was reasoned from
the code, not measured (the On cell is a `min-w-36` column: the badge is 84 px wide **(measured)**).

---

## Flows

Four flows, all short: the screens and dialogs exist, the mark is the only new thing a person sees.

### F1 See my automatic entries — AC-2.1, AC-2.3, AC-3.6, AC-4.2

Entry points (both existing; nothing is added to them):

| Entry point | Path | Where the mark is |
|---|---|---|
| **Table view** (My hours' default, a week or a month) | `/hours` → the meeting's row → the day's cell (a button when it holds hours) → `TableCellDialog` | on each entry row **inside the dialog**; **none on the grid cell or the row** (spec AC-2.3 asks for the mark only where entries are listed one by one) |
| **List** | `/hours?view=list` → `EntryDayList` | on each entry row |

1. The person opens My hours. Automatic entries arrive in the ordinary read, like any entry (AC-2.1, AC-2.2): they are in
   the cell's figure, the row, day and period totals and the List with no special case.
2. In the List, or in the dialog a cell opens, the entry's row shows **[kind] [From meeting] name** (S1).
3. The mark follows `origin`, which hours-api stores and never changes, so it is there for an untouched entry, for one
   the person changed (AC-2.3), for one now recorded on a project, a deal or other work, and for one on a meeting since
   deleted (AC-3.6: the title is withheld, the mark stays).
4. **Late or missing arrival is silent** (AC-4.2, AC-2.6): if Meetings or the outbox is behind, the entry simply is not
   in the read yet and appears on a later one. Nothing polls, nothing says "pending" (no AC asks; G5).

Exits: the ordinary ones of My hours (period change, Load more, Edit, Delete). No new error exit: the mark needs only a field
hours-api already stored, so it does not depend on Meetings answering (AC-4.2).

### F2 Change an automatic entry — AC-2.3, AC-2.4

Entry point: **Edit** on its row, in the List or the cell dialog. The existing `EntryDialog` opens, filled; the person
changes day, duration, note or what it is on; the existing validations and refusals apply and a refused save changes nothing
(AC-2.4). After a save the list is read again and the row **still carries the mark** (AC-2.3). A change that moves the entry
off the meeting leaves `[Project] [From meeting] Project Alpha`: the kind badge follows what it is on now, the mark follows
where it came from. The dialog itself is unchanged (G2: it says nothing about the entry having been recorded by Operai).

### F3 Delete an automatic entry — AC-2.5, AC-2.7

Entry point: the trash button on its row. The existing `DeleteEntryDialog` opens (`ConfirmDialog tone="danger"`, focus on
Cancel, "<duration> on <name>, <date>. This can't be undone."). For `origin === 'meeting'` the body gains a **second
paragraph** (AC-2.7, D61, resolving G1): "Operai won't record it again from its meeting. You can still record hours
yourself." / "Operai non la registrerà di nuovo dalla riunione. Puoi comunque registrare le ore tu." An entry typed by hand
(or an `origin` that is absent) shows the dialog exactly as today. Success is the existing "Entry deleted." banner and the
row gone; the entry is never recorded again (backend, AC-2.5).

### F4 See them in Everyone's hours — AC-2.2, AC-2.3 (D-P5)

Entry point: `/hours/all` for holders of `time-entry:read-all`. The entries card lists every person's entries in the
read-only `EntriesTable`; an automatic entry's **On cell** carries the mark (S2). No write control exists there (time-tracking
AC-1.6) and none is added. The totals, filters and the **export file are unchanged**: the file gains no column (D-P5, plan
"the export file is unchanged"), so the mark is a screen-only fact.

---

## Screens & states

### S1 The entry row — `EntryRow` (the List's row and the cell dialog's row)

One component draws both (`EntryDayList.tsx:67`, `TableCellDialog.tsx:81-83`), so one change serves AC-2.3 in both views.

**Where the mark sits.** On the first line of the row, **directly after the kind badge and before the name**, the two
badges in one tight cluster (6 px apart) so the mark reads as a qualifier of the kind; the name keeps the row's usual 12 px
gap after the cluster:

```
List and cell dialog, desktop
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Meeting] [From meeting]  Weekly sync                     1 h    [Edit]  [Delete] │
│ Counts for deal Acme renewal                                                      │
└──────────────────────────────────────────────────────────────────────────────────┘

Phone (320–375 px): the cluster stays on one line, the name wraps under it, and the
duration and buttons already drop to their own line below ~40 rem (existing behaviour,
not caused by the mark)
┌────────────────────────────────┐
│ [Meeting] [From meeting]       │
│ Weekly sync                    │
│        1 h [Edit] [Delete]     │
└────────────────────────────────┘
```

Markup change, layout utilities only: the line `flex flex-wrap items-center gap-x-3 gap-y-1` (`EntryRow.tsx:90`) gets one
child wrapper `<span className="inline-flex flex-wrap items-center gap-1.5">` around the kind `Badge` and, when
`entry.origin === 'meeting'`, the mark; the name stays a sibling of the wrapper (it keeps its `min-w-0 break-words`). A row that
is not automatic renders the wrapper with the kind badge only: visually unchanged. **(measured)**: at 375 px and at 320 px
inside a 243 px row the cluster is 131–160 px wide, fits on one line in English and Italian, and a 200-character name with no
break wraps on its own lines under it; the document's scroll width stayed under the viewport (370 of 375, 315 of 320) and no
row overflowed. The row is `flex-wrap`, so no width can push the buttons out.

**Tone: `accent`, no glyph.** Reasoning, in the design system's own terms:

- *Meaning first* (principle 3): the mark is metadata, not a status, so it is a `Badge`, not a `StatusBadge`. The dictionary
  has no "recorded by Operai" status, and `info` (the dictionary's only neutral-fact status) draws an "i" icon that reads as
  help. Not `success`, `warning`, `danger` (nothing is right, wrong or at risk) and not `muted` (it means "voided").
- `neutral` would put two grey chips side by side ("Meeting" "From meeting") that look like two kinds; the mark exists to make
  these rows distinguishable from the ones the person typed. The design system allows `accent` "for emphasis", and hours-ui
  already uses `accent` for the "Today" badge in the table header.
- *Which colours may be text:* a badge label uses the `--acc-text` token (the library's `.badge-accent`), which the
  design system lists as text-safe; `--muted` is not used. **(measured)** with the compiled tokens, label over the badge's own
  tint on a list card: **4.99:1 light, 6.29:1 dark** (the neutral kind badge: 4.6 and 4.78). Both clear 4.5:1.
- No glyph: the label carries the meaning, so colour is never the only signal; the design system asks for a glyph only
  "when it adds meaning", and any icon would either reuse a status icon (one meaning per icon) or need a new shape in
  `Icon.tsx` for no gain.
- If the owner wants it quieter, `neutral` is a one-word swap and the cluster placement still separates the two chips.

**States and variants of the row** (the mark is independent of the name: mark from `origin`, name from `rowName(on)`):

| Variant | What the row shows |
|---|---|
| Untouched automatic entry on a meeting | `[Meeting] [From meeting] <title>`; Edit, Delete as any row |
| Changed by the person (AC-2.3) | identical: the mark stays |
| Changed and now on a project, deal or other work | `[Project] [From meeting] Project Alpha` (`[Other work] [From meeting]` with no name, then the category on the meta line) |
| Meeting deleted, entry kept because the person had changed it (AC-3.6) | `[Meeting] [From meeting] Not visible to you`: the placeholder is the existing one for a meeting the viewer cannot read (`names.hidden`), no link, **no title is ever sent or shown** (AC-4.1); the existing "entries without a visible name" note appears by the existing rule (`hasHiddenName`) |
| Meetings did not answer (AC-4.2) | `[Meeting] [From meeting] Name unavailable`; the existing unavailable banner; the mark does not need Meetings |
| Hand-made entry (`origin: person`) or an older hours-api that omits `origin` | no mark, no error: absent reads as `person` (plan § Deploy order, step 3) |
| Row with a 200-character name | as measured above |

**Loading, empty, error: unchanged.** My hours' skeleton and polite "Loading your hours…", the empty and filtered-empty
`StatePanel`s, the list error `Banner` with Retry, "Load more" and its states, and the table view's own loading, empty and
error (record-hours-in-place S7) are as today. The cell dialog is never drawn empty (the page closes it), so it has no
empty state either.

**The table grid is not marked.** A grid cell is a sum, and one cell can hold an automatic entry and a hand-made one on the
same meeting and day (nothing stops a person recording by hand on a meeting that already has theirs); a mark on a cell, a
row or a day total would be wrong for the mixed case and for every total. The cell button, its `aria-label`, the row label
and the dialog's title and description are unchanged: the mark appears one click in, on the entries.

### S2 Everyone's hours — `EntriesTable`'s On cell (read-only)

The table has no kind badge: the kind is the first piece of the second line ("Meeting · Development"). So the mark goes on the
**name line**, before the name, mirroring "the mark precedes the name" of S1:

```
Day         Person        On                           Details        Time
12.11.2026  Ada Lovelace  [From meeting] Weekly sync                  1 h
                          Meeting
12.11.2026  Ada Lovelace  Project Alpha                Activity: ...  2 h        (hand-made: unchanged)
                          Project · Development
```

Markup: when `entry.origin === 'meeting'`, the name `<p>` (or nothing, for other work, which has no name) is wrapped with the
badge in `<div className="flex flex-wrap items-center gap-x-2 gap-y-1">`; otherwise the cell is exactly as today. The badge
is **outside every `<p>`** of the cell, so `EntriesTable.test.tsx`'s `lines()` (the `<p>` texts of a cell) keeps asserting the
same lines. The Details cell, the Person cell, the columns, the caption and the order are unchanged; **no column is added**.
The 84 px badge fits the `min-w-36` On column, and the table already scrolls sideways inside its labelled region on a phone
(existing). The mark is in On (the third column), not in Details (the fourth), so it sits no further right than the name it qualifies.

States: all unchanged (permissions resolving, not a holder, `503 authz_unavailable`, load error, empty, filtered empty,
source down, names not visible, deal filter unavailable: S4 of the time-tracking design). The variants of S1's table apply to
the On cell as they do to the row (a hidden name reads `[From meeting] Not visible to you`, then "Meeting").

### S3 Entry dialog (edit) — unchanged; S4 delete confirmation — one paragraph for an automatic entry

`EntryDialog` and its "not visible" variant are as today (G2). `DeleteEntryDialog` keeps its title, buttons, focus and
first sentence; for `origin === 'meeting'` only, a second `<p>` after the existing one carries
`strings.entry.delete.automaticNote` (AC-2.7, D61). Same text colour and size as the first sentence; no icon, no Banner.
States (pending, error "Something went wrong. The entry was not deleted.") are unchanged. Screen readers read it as part
of the dialog's description, after the first sentence.

---

## Component inventory

Library in use: **`@operai/ui`** (from `AGENTS.md` and the live imports in `hours-ui/src/components/EntryRow.tsx`).

| Element | Reuse | Path |
|---|---|---|
| The mark | `Badge tone="accent"`, children = `strings.entries.fromMeeting`, `data-testid={`hours-entry-${entry.id}-from-meeting`}` (`Badge` forwards `data-*`) | `operai-ui/src/components/Badge.tsx` |
| The row (List and cell dialog) | `EntryRow`, **edited**: the cluster wrapper and the mark | `hours-ui/src/components/EntryRow.tsx` |
| Everyone's On cell | `EntriesTable`'s `On`, **edited**: the name-line wrapper and the mark | `hours-ui/src/components/EntriesTable.tsx` |
| The List | `EntryDayList`, unchanged | `hours-ui/src/components/EntryDayList.tsx` |
| The cell's entries | `TableCellDialog`, unchanged (draws `EntryRow`) | `hours-ui/src/components/TableCellDialog.tsx` |
| Edit | `EntryDialog`, unchanged | `hours-ui/src/components/` |
| Delete | `DeleteEntryDialog`, **edited**: a second paragraph for `origin === 'meeting'` (AC-2.7) | `hours-ui/src/components/DeleteEntryDialog.tsx` |
| Table grid | `TableView`, unchanged: no mark on a cell | `hours-ui/src/components/TableView.tsx` |
| Copy | `strings.entries` catalog, one new key | `hours-ui/src/strings/entries.ts` |
| Client type | `TimeEntryView.origin?: 'person' \| 'meeting'` (plan) | `hours-ui/src/lib/hoursApi.types.ts:42-57` |

**NEW: none.** No new component, library export, token, icon or formatter. A `Badge` is the plan's choice and the design
system's own (metadata that is not a status). Reuse : NEW = 1 library component and 6 in-repo components (3 edited, 3
unchanged) : 0.

Layout utilities only (`inline-flex`, `flex-wrap`, `gap-1.5`, `gap-x-2`): no colour, border or radius on a library component, no
`var(--…)` (ESLint `design-tokens` rules hold). Visibility rule for the code: `entry.origin === 'meeting'`; anything else,
including `undefined`, renders no mark.

---

## Copy

Two keys, `entries.fromMeeting` in `hours-ui/src/strings/entries.ts` and `entry.delete.automaticNote` in `hours-ui/src/strings/entry.ts` (en catalog and complete `it`, parity and no-hardcoded-
strings tests cover them, AC-4.3). Sentence case; the mark has no punctuation.

| Key | en | it |
|---|---|---|
| `entries.fromMeeting` | From meeting | Da riunione |
| `entry.delete.automaticNote` (in `src/strings/entry.ts`, beside `delete.body`) | Operai won't record it again from its meeting. You can still record hours yourself. | Operai non la registrerà di nuovo dalla riunione. Puoi comunque registrare le ore tu. |

("la": an entry is "la registrazione" in hours-ui's Italian, `src/strings/entry.ts:334-335`.)

**Italian differs from the starting point ("Dal meeting") on purpose (G3, accepted by the owner as D60):** hours-ui and meetings-ui write the common noun
"riunione" everywhere in Italian (`Riunione` is the kind badge of the very same row, `una riunione non visibile a te`, `Apri la
riunione`); only the product name Meetings stays as it is. "Dal meeting" next to a "Riunione" badge would name one thing twice.

Not new, deliberately: no `aria-label`, `title` or tooltip on the badge; the Edit and Delete `aria-label`s, the cell button's
label and every dialog sentence are unchanged; durations are shown by the existing `Duration`
(`formatDuration`), dates by `formatDate` (AC-4.3 needs nothing else).

---

## Accessibility

### S1 The entry row (List and cell dialog)

- **The mark is text**, a `<span>` with the words "From meeting" / "Da riunione"; the tint is extra, never the carrier. Label
  contrast **(measured)** 4.99:1 light, 6.29:1 dark on the card with the badge's own tint (≥ 4.5:1 both themes).
- **How it is heard.** DOM order is kind badge, mark, name, meta lines, note, duration, Edit, Delete. A screen reader reads the
  first line as a run: "Meeting, From meeting, Weekly sync" (the badges are inline spans, as the kind badge already is: "Project
  Project Alpha"). Nothing is overridden: no `aria-label`, `aria-describedby`, `role` or `title` on the badge (an
  `aria-label` would replace its text; a `title` is not reliably read). A row on a hidden meeting reads "Meeting, From meeting,
  Not visible to you". QE should listen to it once with VoiceOver and NVDA (the word run is the one risk; if it reads badly the
  fix is a visually hidden comma between the two badges, not a change of order).
- **Focus is unchanged.** The mark is not focusable and adds no tab stop; the Edit / Delete order, `data-autofocus` on the
  first row's Edit in the cell dialog, the dialog's focus trap, focus return to the cell button and the "focus falls to the
  dialog's heading when the focused entry goes" rule (`TableCellDialog`) are as today.
- Edit and Delete keep their names ("Edit 1 h on Weekly sync, 12.11.2026"); two rows told apart only by position is the existing
  behaviour. The mark is deliberately **not** added to those names (new copy no AC asks for).
- **Reflow and zoom:** no horizontal scroll at 320 px, the width a 400% zoom of a 1280 px window gives **(measured at 320 and
  375; zoom itself not run)**; the cluster wraps inside the row, the name uses the existing `min-w-0 break-words`.
- Reduced motion, live regions, headings: none involved.

### S2 Everyone's hours

- The mark is text inside the On cell, in the table's existing structure (`caption`, `scope` headers, no new column), so a
  cell is read "From meeting, Weekly sync, Meeting" in order and the headers still name the cells.
- Keyboard: nothing interactive is added; the table's scroll region stays reachable as today (the library `DataTable`'s focusable
  region), the name link keeps its place and its own focus ring.
- A hidden name is read "From meeting, Not visible to you"; the mark never carries the meeting's title.

### Hotspots

1. The reading of badge + badge + name as one run (listen once; fix is a hidden comma).
2. Accent label contrast in both themes (measured 4.99 / 6.29; recheck if the tone is changed).
3. The On cell wrapper in Everyone's hours must keep the badge outside the `<p>` lines the existing tests read.

---

## AC coverage and scope

| Surface | ACs |
|---|---|
| S1, S2 (the mark) | AC-2.3, AC-3.6 (the "no title" display), AC-4.3 |
| F1 / S1 (nothing new: the entries are the ordinary read) | AC-2.1, AC-2.2 |
| F2 (existing dialog) | AC-2.4 |
| F3 / S4 (existing dialog, one paragraph added) | AC-2.5, AC-2.7 |

**ACs with no UI surface of their own:** AC-1.1–1.8 (backend: who gets an entry, when, how long, the rules), AC-2.6 (an
absence: no notification), AC-3.1–3.5 and 3.7 (backend; their only visible effect is a row changing on the next read),
AC-4.1 (the view carries no title; the mark is a fixed word), AC-4.2 (My hours already loads without Meetings).

**UI present that no AC asks for:** none. The cluster wrapper is layout for AC-2.3. Not designed (scope creep, reported): a
mark on a table cell, row or day total; a filter or column "origin" (list, totals or export); a tooltip, legend or help text
explaining the mark; a "follows the meeting" indicator; a hint in the edit dialog; an
arrival toast, "new" tag or live refresh; an Undo for a deleted automatic entry; a bulk action (spec non-goal).

---

## Gaps found in the spec and plan

Each is reported, none is designed in. Recommendations are mine; the owner decides.

**Resolved by the owner, 2026-11-24:** G1 accepted — designed in as S4, spec AC-2.7 (ledger D61); G3 accepted — "Da riunione"
(D60); G4 accepted — AC-2.3 names Everyone's hours (D62), and the plan's tone line now follows this design. G2, G5 and G6 stand
as recommended (nothing added; G6 goes to the owasp pass).

1. **G1 — Deleting an automatic entry does not say it will not come back (AC-2.5).** The confirmation says "This can't be
   undone", which is true of the entry and silent about the rule the person cannot see: Operai will not record this meeting's hours
   for them again, even if the meeting is later corrected. No AC asks for copy; the code path is trivial (the dialog already
   receives the `TimeEntryView`, and `origin` exists). **Recommendation: add one sentence to the confirmation body for
   `origin === 'meeting'` and say so in AC-2.5 (one clause: "the confirmation says so"), with a test.** Proposed copy, if accepted,
   as a second paragraph after the existing sentence (key `entry.delete.automaticNote`): en "Operai won't record it again from
   its meeting. You can still record hours yourself." / it "Operai non lo registrerà di nuovo dalla riunione. Puoi comunque
   registrarle tu." True per plan (a hand-made POST on the meeting is unchanged and is `origin: person`). If declined, nothing
   else changes: the dialog is as today.
2. **G2 — The mark says where an entry came from, not what Operai will do with it; a person cannot tell an entry that still
   follows its meeting from one that stopped.** Any saved change (a note included, A39) ends "following" (AC-3.5), the mark stays
   (AC-2.3), and the plan deliberately never returns `followsMeeting`. So a person who only adds a note will not know that a
   later move of the meeting leaves their entry on the old day; and nothing says "recorded by Operai". **Recommendation: do not
   add anything now.** A truthful hint ("Saving a change stops this entry following the meeting") needs `followsMeeting` in the
   view (a plan change) and an AC; with `origin` alone it would be wrong for every already-changed entry. Revisit if the
   go-live communication to employees (spec O3, HR) does not cover it. The "From meeting" wording is the owner's; a longer one
   that says who recorded it ("Recorded from meeting") is possible in the same badge, but it still says nothing about following.
3. **G3 — Italian wording: "Dal meeting" departs from the catalog.** Recommend **"Da riunione"** (see § Copy): every Italian string
   of hours-ui and meetings-ui, the kind badge on the same row included, says "riunione". Needs the owner's yes; the English is
   as specified.
4. **G4 — AC-2.3 does not list Everyone's hours; the plan adds it.** AC-2.3 names "the List, the entries of a table view cell"
   in a parenthesis; plan D-P5 shows the mark in Everyone's hours "as AC-2.3 says *wherever* entries are listed one by one". It
   is a fair reading and it is designed (S2), but the plan's test table cites AC-2.3 for `EntriesTable`. **Recommendation: add
   "Everyone's hours" to AC-2.3's parenthesis** (a one-word spec amendment, through the main loop; I did not edit the spec). Also
   the plan's `<Badge tone="neutral">` line is superseded by this design (`accent`, wrapper placement), as the plan itself leaves
   the choice to the design pass: update that line when the plan is next touched.
5. **G5 — Arrival is not live and is not signalled.** Entries show up on the next read; a person with My hours already open sees
   nothing until they change period, reload or come back; a late entry (AC-4.2, up to the 30-minute retry cadence) looks the same as
   no entry. This is consistent with AC-2.6 and costs a surprise at most. **Recommendation: no UI.** For the e2e of the plan (the
   recorder test, "after Stop both see a 30-minute entry"): navigate to / reload My hours after the notice is delivered, never
   expect a live update.
6. **G6 — For the owasp pass (low): the mark in Everyone's hours outlives the entry's move off the meeting.** A read-all holder
   sees `[From meeting]` on an entry the person has since re-recorded on a project, so learns the person took part in a meeting
   that day for about that long, which the person's change did not state. AC-4.1 promises "nothing new about meetings".
   Attendance, not content; the holder already sees every hour, and an untouched entry shows "Meeting" anyway. **Recommendation:
   accept as AC-2.3 reads** (the mark is a fact about the entry), and let the security reviewer note it; the alternative is
   showing the mark in Everyone's hours only while `on.type === 'meeting'`, a one-line condition that makes that table differ from
   AC-2.3.
7. **Not a gap, recorded:** the existing standing note "Some entries are on a project, deal or meeting you can't open" also
   appears for an entry on a deleted meeting (AC-3.6); its wording was written for access, not deletion. It is existing copy and
   still true enough ("can't open"); not changed.
