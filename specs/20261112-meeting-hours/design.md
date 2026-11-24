---
spec: 20261112
status: draft
---

# Design: Meeting hours — the "From meeting" mark on automatic entries

Inputs read: `spec.md` (approved 2026-11-24, **re-approved the same day after the security review: US-1–US-5, 34 ACs, A4–A47**),
`plan.md` (architecture accepted by the owner; binding here: § API contracts "hours-ui — changed", D-P5), the ledger
`specs/20261112-time-tracking/ledger.md` (D54–D73), `.claude/context/glossary.md` § Time tracking,
`operai-ui/docs/{building-pages,design-system}.md`, `operai-ui/src/index.ts`, `specs/20261112-time-tracking/design.md` and
`specs/20261116-record-hours-in-place/design.md` (S1, S4, S7, S8 and their conventions), and the code the mark lands in:
`hours-ui/src/components/{EntryRow,EntryDayList,TableCellDialog,TableView,EntriesTable,DeleteEntryDialog}.tsx`,
`src/lib/{names,hoursApi.types}.ts`, `src/strings/{entries,names,table}.ts` (as built by T10), and, for the duration,
`meetings-ui/src/{components/meeting/DetailsCard,components/meeting/InterruptedPanel,components/meeting/StatusPanels,pages/MeetingPage,hooks/usePolling}.tsx`,
`operai-ui/src/lib/format.ts` and `meetings-api/src/meetings/view.ts`.

> **Amended 2026-11-24 (second pass, after the security review; ledger D63–D71, spec AC-2.3 changed, AC-3.8–AC-3.10 added).**
> Two changes, both small; the first rewrites what the mark means, the second adds no UI.
>
> 1. **The mark follows where the entry is recorded now, not where it came from** (AC-2.3 changed, D67, A47). An automatic
>    entry shows "From meeting" ("Da riunione") **exactly while it is recorded on a meeting** — a deleted meeting included, another
>    meeting included — in the List, in the entries of a table cell and in Everyone's hours. Moved to a project, a deal or other
>    work it shows no mark; moved back to a meeting the mark returns. This **reverses** the first design's "the mark follows
>    `origin` and nothing else" (D57, D62). Revised: F1, F2, F4, S1 (a new rule table and variants), S2, the component inventory,
>    accessibility, and G6, which this resolves. Placement, tone, wrapper, copy and the test ids are unchanged.
>    The delete confirmation's extra sentence (AC-2.7) is **deliberately not tied to the mark**: it keeps depending on `origin`
>    alone and so still shows for a moved entry (D70).
> 2. **A meeting's duration may change once, after its audio is processed** (AC-3.8–AC-3.10, D63, A42, A43): **no new UI and no
>    new copy.** Meetings shows a meeting's duration in exactly one place, the **Duration** line of the meeting's Details; it reads
>    whatever the meeting holds, so it shows the measured duration with nothing built. New: F5 and S5 (the existing line, its
>    states) and G7.
>
> The code T10 built encodes the first design's rule; § "What this changes in the built code" lists the lines and the tests.

Library in use: **`@operai/ui`** (`operai-ui/`) with Tailwind token utilities, consumed through the shell's Module Federation
singleton; hours-ui and meetings-ui are its remotes (`AGENTS.md`, ADR 20261031-shared-ui-library-consumed-as-source,
20261114-operai-ui-shared-singleton-provided-by-the-shell). Not Mantine. No `## Visual direction`: the project has a design
system and it wins.

**Scope of this design.** The feature is backend: Operai writes ordinary time entries. The UI changes in exactly one way
(AC-2.3, AC-4.3, plan D-P5): an automatic entry that is **recorded on a meeting** carries a **"From meeting" badge** wherever
entries are listed one by one. Everything else the person does with such an entry (see it in the table view and the List, edit it,
delete it) is behaviour that already exists and is **not redesigned**: the loading, empty and error states of every screen below
are unchanged and are not repeated except where the mark meets them. A meeting's corrected duration (AC-3.8–3.10) changes no
screen: it changes a value an existing screen already shows.

**Inspected first-hand, within limits.**
*First pass:* the dev shell answered on `:5173` but `auth` was down, so no authed page could be opened. I injected a fixture of
`EntryRow`'s markup (the library's own classes, the shell's compiled tokens) into the shell page and measured it at 375 and 320
px (the latter inside a 243 px row, a phone-width dialog's worst case), light and dark; nothing was written to the repo.
Findings are marked **(measured)**; they concern the badge and are untouched by the amendment. Everyone's hours was reasoned from
the code (the On cell is a `min-w-36` column: the badge is 84 px wide **(measured)**).
*Second pass:* the stack was up. I minted test sessions for one `@operai.test` user (no other write) and read the dev databases read-only. The dev `hours`
database holds **no automatic entry** (1 272 entries, all `origin: person`), so the new rule could not be seen live; it is
reasoned from the code, the view (`hours-api/src/entries/view.ts` keeps `on.type: "meeting"`, `visibility: "hidden"` for a deleted
meeting and returns `origin` straight from the row, so a moved entry stays `origin: meeting`) and the built tests. The only dev
meeting with a duration owned by a user I could open was deleted by an e2e cleanup while I looked, so the Duration line was read
from `DetailsCard`, `formatDuration` and the polling code, not from a live page. Findings from this pass are marked **(read)**.

---

## Flows

Five flows, all short: the screens and dialogs exist, the mark is the only new thing a person sees, and F5 is a note that nothing
new is needed.

### F1 See my automatic entries — AC-2.1, AC-2.3, AC-3.6, AC-4.2

Entry points (both existing; nothing is added to them):

| Entry point | Path | Where the mark is |
|---|---|---|
| **Table view** (My hours' default, a week or a month) | `/hours` → the meeting's row → the day's cell (a button when it holds hours) → `TableCellDialog` | on each entry row **inside the dialog** that is recorded on a meeting; **none on the grid cell or the row** (spec AC-2.3 asks for the mark only where entries are listed one by one) |
| **List** | `/hours?view=list` → `EntryDayList` | on each entry row that is recorded on a meeting |

1. The person opens My hours. Automatic entries arrive in the ordinary read, like any entry (AC-2.1, AC-2.2): they are in
   the cell's figure, the row, day and period totals and the List with no special case.
2. In the List, or in the dialog a cell opens, a row of an automatic entry that is on a meeting shows
   **[kind] [From meeting] name** (S1).
3. The mark is computed **on each read from two fields of the same view**: `origin` (which hours-api stores and never changes,
   `meeting` for an entry Operai recorded) and `on.type` (what the entry is recorded on **now**). It is there for an untouched
   entry, for one whose day, duration or note the person changed, for one the person moved to **another meeting**, and for one on a
   meeting since deleted (AC-3.6: the title is withheld, the mark stays). It is **not** there for an automatic entry the person
   moved to a project, a deal or other work (D67); that row reads like any entry of that kind. The table view shows a moved entry
   where it now belongs: in the grid row of its new target, whose cell dialog draws it without the mark.
4. **Late or missing arrival is silent** (AC-4.2, AC-2.6): if Meetings or the outbox is behind, the entry simply is not
   in the read yet and appears on a later one. Nothing polls, nothing says "pending" (no AC asks; G5). The same is true of a
   later resize: an untouched entry whose meeting's duration is corrected (AC-3.9) changes on the next read, silently (G7).

Exits: the ordinary ones of My hours (period change, Load more, Edit, Delete). No new error exit: the mark needs only two fields
the read already carries, so it does not depend on Meetings answering (AC-4.2).

### F2 Change an automatic entry — AC-2.3, AC-2.4

Entry point: **Edit** on its row, in the List or the cell dialog. The existing `EntryDialog` opens, filled; the person
changes day, duration, note or what it is on; the existing validations and refusals apply and a refused save changes nothing
(AC-2.4). After a save the list is read again and **the mark is decided by that read**, never by what the dialog held:

```
Edit, day / duration / note only (still on the meeting)     the row still reads   [Meeting] [From meeting] Weekly sync
Edit, "Recorded on" changed to a project                    the row now reads     [Project] Project Alpha           (no mark)
Edit, "Recorded on" changed to another meeting              the row now reads     [Meeting] [From meeting] Other call   (A47)
Edit, "Recorded on" changed back to a meeting               the mark is back
```

A change that moves the entry off the meeting leaves `[Project] Project Alpha` — the kind badge and the mark both follow what
the entry is on now. In a table cell's dialog a moved entry also leaves that cell (it belongs to another grid row now): the
existing "focus falls to the dialog's heading when the focused entry goes" rule applies, unchanged. The dialog itself is unchanged
(G2: it says nothing about the entry having been recorded by Operai, and nothing about the mark going or coming back).

### F3 Delete an automatic entry — AC-2.5, AC-2.7

Entry point: the trash button on its row. The existing `DeleteEntryDialog` opens (`ConfirmDialog tone="danger"`, focus on
Cancel, "<duration> on <name>, <date>. This can't be undone."). For `origin === 'meeting'` the body gains a **second
paragraph** (AC-2.7, D61, resolving G1): "Operai won't record it again from its meeting. You can still record hours
yourself." / "Operai non la registrerà di nuovo dalla riunione. Puoi comunque registrare le ore tu." **This does not depend on the
mark**: it shows for every automatic entry, including one the person moved to a project, a deal or other work, which shows no mark
(D70, A47: deleting it still means Operai will not record it again, so the sentence is true). An entry typed by hand (or an
`origin` that is absent) shows the dialog exactly as today. Success is the existing "Entry deleted." banner and the row gone; the
entry is never recorded again (backend, AC-2.5).

### F4 See them in Everyone's hours — AC-2.2, AC-2.3 (D-P5)

Entry point: `/hours/all` for holders of `time-entry:read-all`. The entries card lists every person's entries in the
read-only `EntriesTable`; the **On cell** of an automatic entry that is recorded on a meeting carries the mark (S2) — by the same
rule as S1, so an entry the person moved to a project shows `Project Alpha / Project` with no mark, **in Everyone's hours as in My
hours** (this is the case the security review raised, I8). No write control exists there (time-tracking AC-1.6) and none is
added. The totals, filters and the **export file are unchanged**: the file gains no column (D-P5, plan "the export file is
unchanged"), so the mark is a screen-only fact.

### F5 See the duration a meeting holds — AC-3.8, AC-3.9, AC-3.10 (Meetings; no new UI)

Entry point (existing): Meetings → a meeting → **Details** card → the **Duration** line. Nothing is added to the path.

1. A recorded or uploaded meeting holds a duration as soon as it is saved or confirmed (the **held duration**): the Details
   card shows it, `HH:MM:SS`.
2. Operai then processes the audio (status `processing`). If the **measured duration** differs from the held one by more than the
   larger of 30 s and 10 % (A42), the meeting's duration becomes the measured one (AC-3.8). The page is already polling while the
   meeting is `processing` (5 s, growing 1.5× to 30 s; the whole meeting is replaced on each poll), so the Duration line is
   replaced in place on the first poll after the correction. **No note, no earlier figure, no notification** (A26, A43; spec
   non-goal "Telling anyone that a meeting's duration was corrected").
3. Within the margin, or when the audio cannot be read: the line never changes (AC-3.10). An upload whose audio proves longer
   than 3 hours fails under specs/20261104-meetings AC-3.2: the Duration row **disappears** (the card leaves out a row with
   nothing to say) and the existing failed panel says "The audio is longer than the limit." / "L'audio supera la durata
   massima." — behaviour of today, not new.
4. The person's hours (hours-ui) follow on their own read (F1 step 4, AC-3.9); Meetings says nothing about it.

Exit: none new. Retry, Delete recording and every other action of the meeting page are as today.

---

## Screens & states

### S1 The entry row — `EntryRow` (the List's row and the cell dialog's row)

One component draws both (`EntryDayList.tsx`, `TableCellDialog.tsx`), so one change serves AC-2.3 in both views.

**When the mark shows (the one rule, D67).** `entry.origin === 'meeting' && entry.on.type === 'meeting'`. Nothing else decides
it. Both fields come from the view of the same read, so the row cannot disagree with the server, and `on.type` is `meeting` for a
meeting the viewer cannot read, one Meetings did not answer for and one since deleted (`visibility` says why the name is
withheld; it never changes the type).

| The entry | `origin` | `on.type` | Mark |
|---|---|---|---|
| Typed by hand, on anything | `person` (or absent) | any | no |
| Operai's, untouched, on its meeting | `meeting` | `meeting` | **yes** |
| Operai's; day, duration or note changed; still on a meeting | `meeting` | `meeting` | **yes** |
| Operai's; moved to **another** meeting | `meeting` | `meeting` | **yes** (A47: it is on a meeting; the word says it came from a meeting, not which, G8) |
| Operai's; moved to a project, a deal or other work | `meeting` | `project` / `deal` / `none` | **no** |
| …and then recorded on a meeting again | `meeting` | `meeting` | **yes**, again |
| Operai's; its meeting since deleted (kept because the person had changed it, AC-3.6) | `meeting` | `meeting`, `visibility: hidden` | **yes** |
| Operai's; Meetings did not answer | `meeting` | `meeting`, `visibility: unavailable` | **yes** |

**Where the mark sits.** On the first line of the row, **directly after the kind badge and before the name**, the two
badges in one tight cluster (6 px apart) so the mark reads as a qualifier of the kind; the name keeps the row's usual 12 px
gap after the cluster:

```
List and cell dialog, desktop
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Meeting] [From meeting]  Weekly sync                     1 h    [Edit]  [Delete] │
│ Counts for deal Acme renewal                                                      │
└──────────────────────────────────────────────────────────────────────────────────┘

The same entry after the person moved it to a project: no mark, no cluster
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Project]  Project Alpha                                  1 h    [Edit]  [Delete] │
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

Markup: the first-line container (`flex flex-wrap items-center gap-x-3 gap-y-1`) holds one child wrapper
`<span className="inline-flex flex-wrap items-center gap-1.5">` around the kind `Badge` and the mark **when the rule above holds**;
the name stays a sibling of the wrapper (it keeps its `min-w-0 break-words`). A row for which the rule does not hold renders the
kind badge alone, with **no wrapper**, exactly as a hand-made row does (the built code already does this; only its condition
changes). **(measured, first pass)**: at 375 px and at 320 px inside a 243 px row the cluster is 131–160 px wide, fits on one line
in English and Italian, and a 200-character name with no break wraps on its own lines under it; the document's scroll width stayed
under the viewport (370 of 375, 315 of 320) and no row overflowed. The row is `flex-wrap`, so no width can push the buttons out.

**Tone: `accent`, no glyph** (unchanged by the amendment). Reasoning, in the design system's own terms:

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

**States and variants of the row** (the mark is decided by the rule above; the name by `rowName(on)`):

| Variant | What the row shows |
|---|---|
| Untouched automatic entry on a meeting | `[Meeting] [From meeting] <title>`; Edit, Delete as any row |
| Changed by the person (day, duration, note), still on the meeting (AC-2.3) | identical: the mark stays |
| Moved to another meeting (A47) | `[Meeting] [From meeting] <other title>` |
| **Moved to a project** (AC-2.3, D67) | `[Project] Project Alpha` — no mark, no cluster |
| **Moved to a deal** | `[Deal] Brera` — no mark |
| **Moved to other work** | `[Other work]` with no name, the category on the meta line — no mark |
| Moved off a meeting and back onto one | the mark is back; nothing else on the row records the round trip |
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
and the dialog's title and description are unchanged: the mark appears one click in, on the entries. A moved entry changes which
grid row and cell holds its hours (the existing behaviour of any move), and the grid says nothing more about it.

### S2 Everyone's hours — `EntriesTable`'s On cell (read-only)

The table has no kind badge: the kind is the first piece of the second line ("Meeting · Development"). So the mark goes on the
**name line**, before the name, mirroring "the mark precedes the name" of S1:

```
Day         Person        On                           Details        Time
12.11.2026  Ada Lovelace  [From meeting] Weekly sync                  1 h
                          Meeting
12.11.2026  Ada Lovelace  Project Alpha                Activity: ...  2 h        (hand-made: unchanged)
                          Project · Development
12.11.2026  Ada Lovelace  Project Alpha                               1 h        (Operai's, moved to a project: NO mark)
                          Project
```

Markup: **when the S1 rule holds** (`origin === 'meeting'` and `on.type === 'meeting'`), the name `<p>` is wrapped with the badge in
`<div className="flex flex-wrap items-center gap-x-2 gap-y-1">`; otherwise the cell is exactly as today (a moved entry, a
hand-made one). The badge is **outside every `<p>`** of the cell, so `EntriesTable.test.tsx`'s `lines()` (the `<p>` texts of a cell)
keeps asserting the same lines. The Details cell, the Person cell, the columns, the caption and the order are unchanged; **no
column is added**. The 84 px badge fits the `min-w-36` On column, and the table already scrolls sideways inside its labelled region
on a phone (existing). The mark is in On (the third column), not in Details (the fourth), so it sits no further right than the
name it qualifies.

Because the rule needs `on.type === 'meeting'`, the mark in this table now **always sits above a second line that begins
"Meeting"**: it adds no fact a holder did not already see in the kind (this is what closes G6: a read-all holder no longer learns,
from the mark, that someone attended a meeting after they re-recorded the hours elsewhere).

States: all unchanged (permissions resolving, not a holder, `503 authz_unavailable`, load error, empty, filtered empty,
source down, names not visible, deal filter unavailable: S4 of the time-tracking design). The variants of S1's table apply to
the On cell as they do to the row (a hidden name reads `[From meeting] Not visible to you`, then "Meeting").

### S3 Entry dialog (edit) — unchanged; S4 delete confirmation — one paragraph for an automatic entry

`EntryDialog` and its "not visible" variant are as today (G2). `DeleteEntryDialog` keeps its title, buttons, focus and
first sentence; for `origin === 'meeting'` **only** (not for "origin is meeting and the entry is on a meeting"), a second `<p>`
after the existing one carries `strings.entry.delete.automaticNote` (AC-2.7, D61, D70). Same text colour and size as the first
sentence; no icon, no Banner. States (pending, error "Something went wrong. The entry was not deleted.") are unchanged. Screen
readers read it as part of the dialog's description, after the first sentence. **Two predicates, on purpose:** the mark asks
"is it from a meeting and on one?", the sentence asks "did Operai record it?". The built code already keeps them apart (the dialog
never reads `on.type` for this), and the change to the mark must not unify them: a moved entry has no mark and still gets the
sentence (the dialog's first sentence names its current target, e.g. "1 h on Project Alpha, 12.11.2026").

### S5 Meeting details — the Duration line (meetings-ui `DetailsCard`; existing, no change)

`DetailsCard` lists the meeting's facts as a `FactList` (`<dl>`); the **Duration** row is present iff `meeting.durationMs !== null`
and shows `formatDuration(durationMs, { style: 'clock' })` (`HH:MM:SS`, `font-mono`), label "Duration" / "Durata" (**read**).
This is the **only** place any Operai screen shows a meeting's duration: no list row, no host panel (CRM deal page, project page),
no transcript export, no screen of crm-ui, projects-ui, hours-ui or the shell reads `durationMs` (**read**, a grep of those apps and of
meetings-ui; hours-ui shows each entry's own rounded minutes, never the meeting's). The recorder's running time (`RecordingPanel`, the dock) and the saved time of an interrupted
recording (`InterruptedPanel`: "Saved audio: …", from `recording.durationMs`, falling back to the meeting's only for a meeting that is
not yet processed) are other figures and do not change (A43).

| State | The Duration row |
|---|---|
| No duration (typed or pasted meeting; upload with none) | absent (as today) |
| Held duration, within the margin of the measured one, or audio unreadable (AC-3.10) | shown, never changes |
| `processing`, held duration shown | shown; replaced in place by the measured one on the first poll after `prepare_audio` corrects it (F5 step 2), **no flash, no note** |
| Ready after a correction (AC-3.8) | the measured duration, with no mention of the earlier figure (A43) |
| Upload refused as longer than 3 hours (AC-3.10) | row absent; the failed panel's existing sentence says why |
| Poll fails (Meetings or network) | existing behaviour: the last good value stays and the page's existing polling error shows by its existing rule |

**Decision: no new screen state and no new copy.** AC-3.8's only UI clause is "so that Meetings shows the measured duration
wherever it shows the meeting's duration", which is a statement about the value, and the row already renders whatever the view
returns. Considered and **not** added (each would answer a question no AC asks, and the spec's non-goal forbids telling anyone a
duration was corrected, A26/A43): a "corrected" badge or note, the earlier figure, a tooltip "measured from the audio", a live
region on the Details card. Loading, empty and error states of the meeting page are unchanged.

**One dependency the plan must keep (G7).** The row updates without a reload only if the correction is written **before the
meeting leaves `processing`** (the page stops polling at the first read that is no longer `processing`). `prepare_audio` is the
first stage, so putting the correction in its own write (the plan's § Where meetings-api records a notice already has `prepare_audio` as a writer) satisfies this; a correction
applied at or after `ready` would leave an open page on the held figure until the next visit.

---

## Component inventory

Library in use: **`@operai/ui`** (from `AGENTS.md` and the live imports in `hours-ui/src/components/EntryRow.tsx` and
`meetings-ui/src/components/meeting/DetailsCard.tsx`).

| Element | Reuse | Path |
|---|---|---|
| The mark | `Badge tone="accent"`, children = `strings.entries.fromMeeting`, `data-testid={`hours-entry-${entry.id}-from-meeting`}` (`Badge` forwards `data-*`) — unchanged | `operai-ui/src/components/Badge.tsx` |
| **The rule** | one small predicate beside `names.ts` (e.g. `showsFromMeetingMark(entry)`: `origin === 'meeting' && on.type === 'meeting'`), called by both screens so the List/cell dialog and Everyone's hours cannot drift; a function, not a component (frontend-dev picks the file) | `hours-ui/src/lib/` |
| The row (List and cell dialog) | `EntryRow`, **edited**: the cluster wrapper and the mark, now behind the rule | `hours-ui/src/components/EntryRow.tsx` |
| Everyone's On cell | `EntriesTable`'s `On`, **edited**: the name-line wrapper and the mark, now behind the rule | `hours-ui/src/components/EntriesTable.tsx` |
| The List | `EntryDayList`, unchanged | `hours-ui/src/components/EntryDayList.tsx` |
| The cell's entries | `TableCellDialog`, unchanged (draws `EntryRow`) | `hours-ui/src/components/TableCellDialog.tsx` |
| Edit | `EntryDialog`, unchanged | `hours-ui/src/components/` |
| Delete | `DeleteEntryDialog`, a second paragraph for `origin === 'meeting'` (AC-2.7) — **unchanged by the amendment**, keyed on `origin` alone (D70) | `hours-ui/src/components/DeleteEntryDialog.tsx` |
| Table grid | `TableView`, unchanged: no mark on a cell | `hours-ui/src/components/TableView.tsx` |
| Meeting's Duration line | `DetailsCard` (`Card`, `FactList`, `formatDuration`), unchanged | `meetings-ui/src/components/meeting/DetailsCard.tsx` |
| Copy | `strings.entries.fromMeeting`, `strings.entry.delete.automaticNote` — **no new key** | `hours-ui/src/strings/{entries,entry}.ts` |
| Client type | `TimeEntryView.origin?: 'person' \| 'meeting'` (plan) — only its doc comment changes | `hours-ui/src/lib/hoursApi.types.ts` |

**NEW: none.** No new component, library export, token, icon, formatter or string. A `Badge` is the plan's choice and the design
system's own (metadata that is not a status). Reuse : NEW = 1 library component for the mark (+ `Card`, `FactList`, `formatDuration`
in the unchanged Meetings card) and 7 in-repo components (3 edited, 4 unchanged) : **0**; the amendment itself touches the
conditions of 2 of them and adds one predicate function.

Layout utilities only (`inline-flex`, `flex-wrap`, `gap-1.5`, `gap-x-2`): no colour, border or radius on a library component, no
`var(--…)` (ESLint `design-tokens` rules hold). Visibility rule for the code: the S1 rule; anything else, `origin` or `on` missing
included, renders no mark.

### What this changes in the built code (T10 encoded the first rule)

For frontend-dev and QE; a design pointer, not a task list.

- `EntryRow.tsx` and `EntriesTable.tsx`: the condition `entry.origin === 'meeting'` becomes the S1 rule; both doc comments that say
  the mark "keeps it after the person … moves it to other work" are rewritten. `hoursApi.types.ts`: the `origin` comment ("Nothing
  but the 'From meeting' mark reads it") is now untrue twice over: the mark also reads `on.type`, and `DeleteEntryDialog` reads
  `origin` alone.
- **Tests that assert the old rule and must be inverted or replaced** (they pass today and would pass a wrong build):
  `EntryRow.test.tsx` — its header comment, the "plain text" test that builds `automatic({ on: projectOn(…) })` (use a meeting
  target), and the whole `the mark follows origin, not what the entry is on now (AC-2.3, D57)` block (project, deal and other
  work become "no mark, kind badge alone, no wrapper"; the "edited entry" case stays); `EntriesTable.test.tsx` — "stays on an entry
  the person moved to a project, a deal or other work" and "marks an entry on other work".
- **To add:** a moved-to-another-meeting case and a moved-back case (mark present); a `TableView.fromMeeting.test.tsx` case that a
  moved entry's cell dialog shows no mark; one for the predicate itself (the table in S1). `DeleteEntryDialog.test.tsx` already
  pins D70 ("says it for an entry the person moved off the meeting too"): keep it and retitle it to cite AC-2.7/D70, not AC-2.3.
  The Italian tests (`*.it.test.tsx`) use meeting targets and stay valid.
- **e2e** (`shell/e2e/meeting-hours.spec.ts`, journey B asserts the unmoved case and stays valid): the rule is a pure function of two
  fields, so component tests carry it; if QE wants one browser journey, add a step to B or C: edit the creator's entry onto Other
  work → the mark is gone in the List and in the table view's dialog; edit it back onto the meeting → the mark returns; delete the
  moved one → the confirmation still has the second paragraph.
- **Meetings:** nothing to build. One cheap assurance for AC-3.8's UI clause, if QE wants it: a `MeetingPage` polling test where
  the second poll returns another `durationMs` and the Details row shows the new one.

---

## Copy

Two keys, `entries.fromMeeting` in `hours-ui/src/strings/entries.ts` and `entry.delete.automaticNote` in
`hours-ui/src/strings/entry.ts` (en catalog and complete `it`, parity and no-hardcoded-strings tests cover them, AC-4.3). Sentence
case; the mark has no punctuation. **The 2026-11-24 amendment adds no copy:** the mark and the delete sentence are unchanged, and
the Duration line keeps "Duration" / "Durata".

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
  Not visible to you". A moved entry reads "Project, Project Alpha": **the mark's absence is the whole signal and nothing announces
  it**, which is right: it follows the person's own Save, is visible in the row they land on, and a live announcement would add
  noise to a save that already has its existing "Entry saved" banner. QE should listen to the run once with VoiceOver and NVDA (the
  word run is the one risk; if it reads badly the fix is a visually hidden comma between the two badges, not a change of order).
- **Focus is unchanged.** The mark is not focusable and adds no tab stop, so a row that gains or loses it keeps the same tab order;
  the Edit / Delete order, `data-autofocus` on the first row's Edit in the cell dialog, the dialog's focus trap, focus return to
  the cell button and the "focus falls to the dialog's heading when the focused entry goes" rule (`TableCellDialog`) are as today —
  that rule is what meets a moved entry leaving a cell.
- Edit and Delete keep their names ("Edit 1 h on Weekly sync, 12.11.2026"); two rows told apart only by position is the existing
  behaviour. The mark is deliberately **not** added to those names (new copy no AC asks for), and a moved entry's names already say
  its new target.
- **Reflow and zoom:** no horizontal scroll at 320 px, the width a 400% zoom of a 1280 px window gives **(measured at 320 and
  375; zoom itself not run)**; the cluster wraps inside the row, the name uses the existing `min-w-0 break-words`. A row without
  the mark has no cluster and is the hand-made row.
- Reduced motion, live regions, headings: none involved.

### S2 Everyone's hours

- The mark is text inside the On cell, in the table's existing structure (`caption`, `scope` headers, no new column), so a
  cell is read "From meeting, Weekly sync, Meeting" in order and the headers still name the cells. A moved entry is read
  "Project Alpha, Project" as any entry.
- Keyboard: nothing interactive is added; the table's scroll region stays reachable as today (the library `DataTable`'s focusable
  region), the name link keeps its place and its own focus ring.
- A hidden name is read "From meeting, Not visible to you"; the mark never carries the meeting's title.

### S4 Delete confirmation (automatic entry)

- Unchanged by the amendment. The second paragraph is part of the dialog's description (read after the first sentence); focus
  stays on Cancel, and returns to Confirm on a failure (existing). For a moved entry the first sentence names its current target,
  so the paragraph is read in the same order whether or not the row showed a mark.

### S5 Meeting details — the Duration line

- The Details card is a `<dl>` (term "Duration", value `HH:MM:SS`), not a live region, and **stays one**. The replacement of the
  value at a poll is silent to a screen reader, as every other polled change of that card is; the page's own `role="status"`
  (the processing panel's stage line) is what announces progress, and the person reads Details when processing ends. A live
  region on the card would also announce every other polled fact (audio state) on every poll.
- No keyboard, focus or contrast change: the value keeps `font-mono` text on the card's existing surface, and the row appearing or
  disappearing (refused upload) moves no focusable element.

### Hotspots

1. The reading of badge + badge + name as one run (listen once; fix is a hidden comma).
2. Accent label contrast in both themes (measured 4.99 / 6.29; recheck if the tone is changed).
3. The On cell wrapper in Everyone's hours must keep the badge outside the `<p>` lines the existing tests read.
4. **The rule lives in one place**: if the List and Everyone's hours ever evaluate it separately, a moved entry would show the mark in
   one and not the other (the exact disagreement the review found); one predicate, tested once, called twice.

---

## AC coverage and scope

| Surface | ACs |
|---|---|
| S1, S2 (the mark, behind the S1 rule) | AC-2.3 (changed), AC-3.6 (the "no title" display), AC-4.3 |
| F1 / S1 (nothing new: the entries are the ordinary read) | AC-2.1, AC-2.2 |
| F2 (existing dialog) | AC-2.4 |
| F3 / S4 (existing dialog, one paragraph added) | AC-2.5, AC-2.7 (and D70: the sentence stays for a moved entry) |
| F5 / S5 (the existing Duration line; nothing added) | AC-3.8 (its one UI clause: Meetings shows the measured duration), AC-3.10 (an upload refused as too long loses its row) |

**ACs with no UI surface of their own:** AC-1.1–1.8 (backend: who gets an entry, when, how long, the rules), AC-2.6 (an
absence: no notification), AC-3.1–3.5 and 3.7 (backend; their only visible effect is a row changing on the next read), **AC-3.9**
(the same: an untouched entry takes the measured duration on the next read, G7), AC-4.1 (the view carries no title; the mark is a
fixed word), AC-4.2 (My hours already loads without Meetings), **AC-4.4 and AC-4.5** (what Operai keeps and applies about a deleted
meeting: nothing a screen shows), **AC-5.1–AC-5.4** (an operator's log line, and a notice refused for good: no screen; a bad notice
means a person simply gets no entry, which is the same silent absence as F1 step 4).

**UI present that no AC asks for:** none. The cluster wrapper is layout for AC-2.3. Not designed (scope creep, reported): a
mark on a table cell, row or day total; a filter or column "origin" (list, totals or export); a tooltip, legend or help text
explaining the mark or the rule; a "follows the meeting" indicator; a hint in the edit dialog; an arrival toast, "new" tag or live
refresh; an Undo for a deleted automatic entry; a bulk action (spec non-goal); **a "corrected" note, the earlier duration or a live
region for the meeting's corrected duration** (spec non-goal, A26/A43); a record of where a moved entry came from (spec non-goal).

---

## Gaps found in the spec and plan

Each is reported, none is designed in. Recommendations are mine; the owner decides.

**Resolved by the owner, 2026-11-24 (first pass):** G1 accepted — designed in as S4, spec AC-2.7 (ledger D61); G3 accepted — "Da riunione"
(D60); G4 accepted — AC-2.3 names Everyone's hours (D62), and the plan's tone line now follows this design. G2 and G5 stand as
recommended (nothing added).
**Resolved by the owner, 2026-11-24 (after the security review):** G6 — see below (D67). D70 (the delete sentence stays for a moved
entry) answers the open question the PO raised about AC-2.7.

1. **G1 — Deleting an automatic entry does not say it will not come back (AC-2.5).** *Resolved (D61, AC-2.7).* The confirmation said
   "This can't be undone", which is true of the entry and silent about the rule the person cannot see: Operai will not record this
   meeting's hours for them again, even if the meeting is later corrected. Designed in as a second paragraph for
   `origin === 'meeting'` (S4). *Amended by D70:* it also shows for an entry moved off the meeting — it is true, and the deletion
   still has that effect.
2. **G2 — The mark says where an entry is recorded and where it came from, not what Operai will do with it; a person cannot tell an entry
   that still follows its meeting from one that stopped.** Any saved change (a note included, A39) ends "following" (AC-3.5), the mark
   stays while the entry is on a meeting (AC-2.3), and the plan deliberately never returns `followsMeeting`. So a person who only adds
   a note will not know that a later move of the meeting leaves their entry on the old day; and nothing says "recorded by Operai".
   **Recommendation: do not add anything now.** A truthful hint ("Saving a change stops this entry following the meeting") needs
   `followsMeeting` in the view (a plan change) and an AC; with `origin` alone it would be wrong for every already-changed entry.
   Revisit if the go-live communication to employees (spec O3, HR) does not cover it. Note the amendment sharpens this slightly:
   an entry moved to a project and back onto a meeting shows the mark again though it no longer follows (any PATCH cleared it) — the mark
   was never a promise of following.
3. **G3 — Italian wording.** *Resolved (D60):* "Da riunione". Every Italian string of hours-ui and meetings-ui, the kind badge on the
   same row included, says "riunione".
4. **G4 — AC-2.3 did not list Everyone's hours; the plan added it.** *Resolved (D62):* AC-2.3 now names it. The plan's tone line
   (`accent`, wrapper placement) follows this design.
5. **G5 — Arrival is not live and is not signalled.** Entries show up on the next read; a person with My hours already open sees
   nothing until they change period, reload or come back; a late entry (AC-4.2, up to the 30-minute retry cadence) looks the same as
   no entry. This is consistent with AC-2.6 and costs a surprise at most. **Recommendation: no UI.** For the e2e of the plan (the
   recorder test, "after Stop both see a 30-minute entry"): navigate to / reload My hours after the notice is delivered, never
   expect a live update.
6. **G6 — The mark in Everyone's hours outlived the entry's move off the meeting (security review I8).** *Resolved by D67, which goes
   further than the design's alternative:* the design had named, as the alternative, "show the mark in Everyone's hours only while
   `on.type === 'meeting'`" (a table that would differ from AC-2.3); the owner instead changed AC-2.3 for every list, so one rule
   serves the List, a cell's entries and Everyone's hours (S1, S2). A read-all holder no longer learns from the mark that a person
   attended a meeting once the person recorded the hours elsewhere. What a holder can still read is what they could always read: the
   entries on a meeting, and that an entry on a meeting was recorded by Operai. The plan's note "accepted as AC-2.3 reads (D62)" is
   superseded.
7. **G7 — New, informational: an untouched entry can change once more after audio processing (AC-3.8, AC-3.9), and nothing says so.** For a
   recorded meeting the entries are created at Stop from the held duration (the sum of the pieces the browser reported); if processing
   then measures a materially different length (more than the larger of 30 s and 10 %), the untouched entries resize on a later read,
   with no mark, note or notice, and My hours does not refresh by itself (G5). Spec non-goal and A43 accept this. **Recommendation: no UI.**
   Two things to keep true: (a) *the plan must write the correction before the meeting leaves `processing`* (S5), else an open Meetings
   page shows the held figure until the next visit; (b) the e2e of AC-1.1 ("a 30-minute entry after Stop") assumes a short
   fake-microphone recording stays within the 30 s floor of the margin (I could not check the fixture's measured length) — a longer or odd fixture could resize the entry mid-test; the go-live
   communication to employees (O3) is the right place to say figures may settle once after a recording.
8. **G8 — New, low: "From meeting" and "its meeting" do not say *which* meeting once an entry has been moved.** The mark on an entry moved
   to another meeting (A47) reads as if Operai recorded it from that one, and the delete sentence on an entry moved to a project says "its
   meeting" while the row shows no meeting. Both are true (the entry was recorded from a meeting) and both were accepted (A47, D70). The view
   cannot name the source meeting: `sourceMeetingId` is never returned, by design (AC-4.1, plan § API contracts). **Recommendation: leave as
   is.** If it confuses in use, the fix is a wording change ("Operai won't record it again from the meeting it came from") or returning
   the source meeting's label with the usual visibility rule (a plan change, an AC).
9. **Not a gap, recorded:** the existing standing note "Some entries are on a project, deal or meeting you can't open" also
   appears for an entry on a deleted meeting (AC-3.6); its wording was written for access, not deletion. It is existing copy and
   still true enough ("can't open"); not changed.

### Drift found in the spec and the plan (for the caller; I edited neither)

- **plan.md still carries the first rule** (the architect is amending it in parallel; at the time of writing the file on disk was still unmodified and
  has nothing yet for AC-3.8–3.10 or AC-5.x): § Decisions D-P5 ("as AC-2.3 says *wherever* entries are listed", fine, but cites no
  condition); § API contracts › hours-ui — changed, which renders the badge "for `origin === 'meeting'` only" — it must read "for
  `origin === 'meeting'` and `on.type === 'meeting'`", while `DeleteEntryDialog` keeps `origin` alone (D70); § Test strategy, row AC-2.3 (the
  component test "show the mark for `origin: meeting`, … not for `person` or a missing `origin`" needs the moved cases; the I-H test "after a
  PATCH the view still says `origin: meeting`" stays correct and is **required**: the wire must keep `origin: meeting` for a moved entry, D70
  needs it); § Security "For the reviewer (design G6, low)", whose "accepted as AC-2.3 reads (D62)" is superseded by D67; and the amendment note
  that says the design's tone and Italian win — still true.
- **plan.md has no UI line for the duration** — correct, and this design adds none; but it should record the S5 dependency (the correction is
  written before the meeting leaves `processing`) so the plan's sequence in `prepare_audio` is not reordered.
- **spec.md header lags the ledger:** it says D63–D67 were "added after the security review" and the amendment note says "ledger D63–D71";
  the ledger now runs to D73 (D72 the shared credential check, D73 the glossary). No AC changes; a one-line header fix when the spec is next
  touched.
- **spec A43 vs the code, a nuance, not a conflict:** "in one place today, the Duration line" is right for the meeting's duration. The Details
  view's `durationMs` is `meeting.durationMs ?? recording.durationMs` (`meetings-api/src/meetings/view.ts`): for a recording not yet saved or
  processed the line can show the stored-chunk sum, which is another figure; after Stop it is the held duration. The spec's wording stands.
- **Spec, plan and ledger agree on the facts I relied on:** `origin` is stored and never changed (plan CHECK `time_entry_origin_shape`), and the
  view returns it for a moved entry (`hours-api/src/entries/view.ts`).
