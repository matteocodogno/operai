# @operai/ui

## 0.11.1

### Patch Changes

- 4f4d8c1: A drawer slides in from the right and its header lines up with the suite's header; a board's lanes are all as tall as the tallest, so a card can be dropped on any lane after scrolling.

## 0.11.0

### Minor Changes

- d5b9ad8: A `Board` (cards in lanes, moved by dragging or with the keyboard) in its own entry, `@operai/ui/board`; its styles ship with the shell.

## 0.10.0

### Minor Changes

- 9726f97: The Google Places client and an `AddressAutocomplete` field move into the component library, shared by every tool through the shell: the app passes its key and its texts, and chooses addresses only or any place (a company, a town). refund-api accepts and returns a mileage trip's start and end (`fromAddress`, `toAddress`, migration `20261125160000_mileage_trip_addresses`), prints the route in the request PDF and fills From and To in the register extract (format 4). The tools start using the field in the next release, once this shell is live (ADR 20261114, deploy rule).

## 0.9.0

### Minor Changes

- f5273af: The sidebar lists the tools in alphabetical order and each person can pin the tools they want at the top (remembered in the browser); the library gains a `pin` icon.

## 0.8.0

### Minor Changes

- ffa3235: `DataTable` columns can be pinned: `pin: 'start' | 'end'` keeps that column (the row's name, a total) in view at
  the edge of the scroll region while the other columns scroll under it, from 48 rem up, with an opaque surface, a
  hairline on the edge that faces the scrolling columns, and scroll padding that follows the pinned columns' measured
  widths so a cell reached with Tab or Shift+Tab is never left under one. At most one column per edge; without `pin`
  nothing changes. Ships through the shell: the shell must be deployed with this library before hours-ui passes `pin`
  (a remote on an older shell gets an unpinned table: the prop is ignored, with no error).

### Patch Changes

- ffa3235: `ListRows` keeps a row by its own `key` instead of by its position. A row that is added or removed above
  another no longer remounts every row below it, so what a row holds (a message shown in it, an open menu) stays
  when the list is read again. A row with no key is kept by its position, as before.

## 0.7.0

### Minor Changes

- 2b3d2fe: The design system gains `ExportButton`, the download button of Inventory's year export as a
  shared component: busy without being disabled, a "preparing" then "ready" status, a message
  when the file has a caveat, and an alert with a retry when it fails.
- 2b3d2fe: `formatDuration` gains a `short` style ("2 h 30", "2 h", "30 min") for lists and totals of
  hours worked.
- 2b3d2fe: The design system gains `SearchPicker`, a field for picking a record out of a search the server
  answers (a project, a deal, a company): it waits for the typing to settle, drops answers to an
  older text, never reports free text, and says whether the list is searching, empty, not allowed
  or unavailable.
- 57ab20d: A task can now be marked "In progress", in the CRM and in Projects. Whoever can mark a task done can start it and stop it again; a task waiting on other tasks cannot be started until they are done. Done is still one click away from Open, and reopening a done task makes it open. The task lists' "Open" view includes tasks in progress (with an "In progress" badge), and a new "In progress" view shows only those. The task shows who started it and when.

## 0.6.0

### Minor Changes

- d4cb290: New `formatMonth` formatter: a month on its own as "March 2026" / "marzo 2026", from an API month (`YYYY-MM`), an ISO date or a Date. It ships with the shell, so the shell must be live with it before refund-ui shows month names in production.

## 0.5.0

### Minor Changes

- a07f57d: `ConfirmDialog` gets three opt-in props; without them every dialog looks and behaves as before. `scrollBody` caps the dialog at the screen's height and scrolls its body between the title and the footer, so Cancel and Confirm stay in view with a long body on a 320 px phone (`Dialog` takes the same `scrollBody`). `confirmDisabledReason` makes Confirm `aria-disabled` and described by a reason while it cannot be used yet (details still loading or unreadable), keeping it a focus stop while Cancel, Escape and × keep working. `size` sets the dialog's width, and `Dialog` gets a `wide` size (520 px).
- a07f57d: `Tabs` and `TabNav` take an optional `wrap` prop, so long labels with badges wrap onto more lines instead of scrolling sideways; without it they look as before. `ErrorSummary`, `VersionTable` and `VersionBanner` move into the library from the letterheads app, so other apps can show a list of form errors, a version history and a banner for the version being viewed.

## 0.4.0

### Minor Changes

- 4b6e43e: Add `PagePreview` and `useLatestResult` (specs/20261116-letterhead-service): `PagePreview` shows a document's rendered pages (states loading, ready, updating, failed and blocked; one `figure` per page with `img alt="Page N of M"` and a visually hidden `figcaption` holding the page text; a single tab stop with `aria-busy`; previous pages kept and unchanged images keep their DOM node), and `useLatestResult` keeps the answer to the latest input, and when the service answers busy (`LatestResultBusyError`, with `parseRetryAfter` for a `Retry-After` header) waits and asks again while the previous result stays on screen. `axe-core` joins the dev dependencies so the component's axe checks run in `pnpm test`.

## 0.3.0

### Minor Changes

- 33ebd92: CRM offer wizard (specs/20261115-crm-offer-wizard): an offer is now built step by step from a
  template that declares what it asks for, instead of editing a long contract text by hand.
  Pick a template for the deal's entity and language, fill in its fields, lists, tables and optional
  blocks, check the cost table and generate the PDF. The draft lives on the server, so it resumes
  after a reload or on another device; a missing or invalid answer blocks generation and says where.
  An unsent offer can be edited under the same reference and a sent one revised as the next `rN`; a
  legacy contract offer still opens the classic dialog. Administrators write wizard templates in
  Settings (self-describing markup with live problems) and try them on sample answers before
  saving; the seven standard templates are seeded per entity and language.

  - **crm-api:** a new migration (`20261115120000_offer_wizard`, apply it before the UI ships);
    template format `wizard` alongside the classic one, with supersession per entity and language;
    draft routes (create, resume, save with If-Match, discard) and generation from the stored draft;
    renderer support for several total rows and option lines in the cost table.
  - **crm-ui:** the offer wizard page, the deal page's offers card (draft row, Continue, Discard,
    Edit, New revision) and the template editor with its "Try the wizard" view.
  - **ui:** new paper tokens used by the offer document and wizard preview.
  - **shell:** patch only: it ships the library with the new tokens.

  The wizard's preview draws the entity's letterhead behind its first page (pdf.js in the browser, fetched
  from the CRM's own bucket), and the seeded templates name the issuer — legal name and address — from the
  entity profile instead of their text; seeds created earlier and never edited are upgraded once in place.

  The preview is laid out as real A4 pages inside the PDF's frame, with the letterhead behind every page and
  page breaks approximating the PDF's. Uploaded letterheads are bounded by decoded size before any parser
  runs, stored as the checked bytes, and refused (409 `letterhead_unusable`) when a stored one fails the bound.

### Patch Changes

- 0d8b9df: A banner with actions stays readable on a narrow screen: the actions drop below
  the message instead of squeezing it to a word per line.

## 0.2.0

### Minor Changes

- c30a110: Banner takes a `live` option (`assertive`, `polite` or `off`) so a warning that is not time-critical is no longer announced as an alert; the defaults are unchanged. In Meetings, the "transcript may be incomplete" notice and the refused-upload warning keep their look but are no longer alerts.
- 28872b4: The design system gains `Combobox` (suggestions while typing) and `Drawer` (a
  side panel for reference content). Admin's address and country fields and
  Inventory's holder and supplier pickers now share the one `Combobox`, which
  also keeps the highlighted suggestion in view in a long list. EstimAI's model
  reference opens in the library `Drawer`. Admin's user detail and mileage-rate
  pages read permissions from the shell instead of fetching them again. The
  suite's end-to-end tests look for the current Refund label instead of the old
  "Refund (Rimborsi)".
- ac951d9: `DataTable` supports sortable columns. A column marked `sortable`, on a table given `sort` and `onSortChange`, gets a header button and an `aria-sort` state. A first click sorts ascending (`firstSortDirection: 'desc'` for dates and amounts) and a second click reverses the order. The table still never sorts rows itself: the page does, on the server for a paginated list.
- 7f5c0af: A click outside a form dialog no longer closes it and throws away what was typed: `FormDialog` ignores the backdrop, and Cancel, × and Escape still close it. `Dialog` gains `dismissOnBackdrop` for the same behaviour, which the estimate's collaborators dialog and the refund reject dialog now use. In every dialog and drawer, a text selection that starts inside and is released outside no longer counts as a click on the backdrop.
- 28872b4: Every tool now shares one look for actions, text and page layout: buttons and
  dialogs come from the shared library with the same meaning-based styles
  (primary actions meet contrast everywhere, cancel is quiet, destructive is
  red), text uses one type scale with an 11px minimum, labels drop their "+"
  and arrow prefixes, each tool has the same title bar, tabs and page header on
  a common width scale, and every detail page has a "Back to …" link. EstimAI's
  shortcuts, health and About dialogs are now real modal dialogs.
- 28872b4: Tables, paging, forms and feedback now work the same in every tool: record
  lists are accessible data tables, long lists page the same way, every form
  marks required fields with an asterisk and explains errors next to the field
  (moving focus to the first one), amounts accept a comma or a dot, dates use
  the date picker, every save, invite and delete confirms where you acted,
  errors you can retry are orange and errors you must fix are red, EstimAI no
  longer uses browser alert boxes, and the page no longer scrolls behind an open
  dialog.
- 28872b4: The whole suite now speaks Italian as well as English: every tool has a
  complete Italian translation and follows the browser's language, chosen once
  for all tools. Dates read the same everywhere (31.10.2026), amounts show their
  currency code with the language's separators, statuses use one shared set of
  icons and colours so the same symbol always means the same thing, emoji and
  text symbols are replaced by real icons that render on every system, headings
  are in sentence case, loading and empty screens look the same in every tool,
  detail pages are organised in cards, and EstimAI's views are proper tabs.
- 4e06a46: Personal meeting notes: everyone who can open a meeting has their own notes on it, private to them (not the meeting's creator, not the AI, not the logs), written in a WYSIWYG editor (bold, italic, a heading, bulleted, numbered and check lists) and saved by themselves a moment after typing stops, when leaving the editor or the page; a save from a stale tab asks to reload instead of overwriting. The design system gains `RichTextEditor` in its own entry, `@operai/ui/rich-text` (TipTap, installed only by the apps that use it), and six formatting icons.
- c30a110: New design-system components for Meetings (specs/20261104-meetings): `FilePicker`, `ProgressBar`, `PersonPicker` and `SectionsEditor`, each with stories and tests, plus the `formatDuration` formatter, new icons and tokens. `crm-ui` and `meetings-ui` consume them. Additive: existing components are unchanged.
- 28872b4: One styling dialect across the suite (ADR 20261031-one-styling-dialect-token-utilities): colours and fonts are Tailwind
  utilities generated from the shared design tokens, never inline styles, and a
  lint rule keeps it that way. Hover and focus colours now apply where inline
  colours used to override them, date pickers follow the light theme, EstimAI's
  AI purple and tinted highlights follow the theme too, and each tool's
  standalone build uses the suite's real tokens instead of a stale copy.
- 28872b4: New shared design system `@operai/ui` (operai-ui/, ADR 20261031-shared-ui-library-consumed-as-source): the suite's tokens,
  themes and component classes move into it from the shell, together with React
  components (buttons, dialogs, banners, badges, fields, tables, page and tool
  layout, empty and loading states) and a Storybook. refund-ui is the first app
  built on it: its dialogs now share one focus and keyboard behaviour, its buttons
  follow the suite's variants, and its secondary text and status colours meet
  WCAG AA in both themes. Suite-wide, `font-mono` now renders DM Mono as intended,
  and the shell's Tailwind scan includes notify-ui.
- 47ef6e2: While a meeting is being recorded you can move anywhere in Operai: a recorder widget stays visible above every page, with the elapsed time, live sound levels for the voice coming in (microphone) and going out (shared tab), Pause, Resume, Stop and a way back to the meeting. Drag it, or move it with the arrow keys, around the edge of the window. Leaving the meeting no longer asks for confirmation; closing or reloading the tab still does. New library component `FloatingPanel`.
- 28872b4: The design system gains `Menu` (the header's logo and account menus, now with
  full keyboard support) and `CheckboxGroupField` (pick several options from a
  list), and `ConfirmDialog` can ask for an acknowledgement and hold fields.
  Refund's "Mark as paid" and Inventory's dispose, close-year and new-rule
  dialogs now share that confirmation; Admin's role and department checklists
  and Inventory's invoice linking share the checkbox group. Success messages
  dismiss themselves after the same time in every tool.
- 28872b4: Keyboard focus is now visible the same way in every tool: a 2px accent ring
  (`--focus-ring`, at least 5.2:1 in both themes) on every focusable element,
  from the shared tokens. It used to exist only in Inventory's standalone build,
  so inside the suite no tool had it.
- 48de67f: Tasks have a rich description with pictures and attachments (ADR 20261113-task-description-files-in-activities-api-bucket). In the CRM and in Projects a task's text is now formatted (bold, lists, check lists…); pictures can be chosen, pasted or dropped into it, and files (PDF, Office, text, CSV, pictures) attached under it. Files are uploaded when the task is saved, live in activities-api's own EU bucket and are shown to whoever can read the task. A task's existing plain text becomes its description.
- 4f8e70f: New `TaskRow` (a task in a list: state badge with glyph and text, meta lines, what it waits on, Mark done that stays reachable and described when blocked) and `PersonChips` (chosen people with labelled remove buttons), with stories and tests.
- bc428e8: New `Tooltip` component. It opens on hover and on keyboard focus, closes with Escape, and is linked to its trigger with `aria-describedby`.
- c4ba4c3: Pages use more of a wide screen: the default tool column grows from 64rem to 80rem and the wide one (the CRM pipeline) fills the width beside the sidebar; single forms stay at 40rem.

### Patch Changes

- 28872b4: Clicking Save or Cancel right after leaving a field with an error no longer
  loses the click, and a busy button keeps its full contrast. The Storybook now
  covers every component and shows generic example pages.
- 8380079: A `ConfirmDialog` with `fields` no longer closes on a backdrop click, so a typed reason is not thrown away (Escape, × and Cancel still close it), as the design system already required of every dialog holding input. In Refund, "Reject line" is now a `danger` button like the request-level Reject, and an empty reason moves focus to the field and is also flagged when leaving it after typing.
- 59e9b48: Dependency security update. better-auth moves to 1.7.18 everywhere, closing the advisory that let an OAuth state be used as a magic link to sign in as another user. The frontends move to vitest 4 and refreshed lockfiles, which clears the critical seroval and tinypool advisories. auth gains a migration adding three optional key columns that better-auth 1.7 expects on its signing-key table.
- c1a7b38: `FactList`: a long unbreakable value, such as a website URL, wraps inside its cell instead of overlapping the next column.
- 6e34649: The recorder widget no longer slides and resizes when it appears: `FloatingPanel` glides only when the person moves it (arrow keys or a drop), and a change of size is applied at once; the shell shows its loading fallback only when the widget takes longer than 400 ms to load.
- 28872b4: The font utilities `font-disp` and `font-body` are now defined once, by
  Tailwind from the theme tokens; the hand-written duplicates, which overrode
  every utility and fell back to `fantasy`/`serif`, are removed.
- a1c2b2c: The person picker's list closes when focus leaves the field, instead of staying open over the fields below it (only Escape, Tab or a choice closed it). A click inside the open list, on its scrollbar or its empty line, no longer counts as leaving the field.
- 28872b4: A confirmation opened on top of another dialog now closes on its own: Escape
  and Tab act on the topmost dialog only, so cancelling "Remove this
  collaborator?" no longer closes the collaborators dialog too. EstimAI's
  collaborators dialog now uses the shared dialog frame.
