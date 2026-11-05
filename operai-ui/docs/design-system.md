# Operai design system

The suite's shared visual and interaction rules. They are implemented once, in
`@operai/ui` (this package, ADR-0050):

- **tokens and component classes**: `src/styles/tokens.css`, which the shell
  loads and every remote receives as `shell/tokens.css` (ADR-0006);
- **React components**: `src/components/`, exported from `src/index.ts`;
- **showcase**: Storybook (`mise run ui:storybook`), every story in both themes
  and checked for accessibility.

To build a page, follow [building-pages.md](./building-pages.md). This page is
the reference it points to. A rule that is not here is not standardised yet: add
it here, to the library and to a story before using it in a second app.

## Principles

1. **One implementation.** A pattern used by two apps lives in the library. A
   remote never copies another remote's component (ADR-0006 forbids importing
   it; the library is the shared place).
2. **Copy belongs to the app.** Library components take every user-visible
   string as a prop, from the app's `strings.ts`. The library has no
   hardcoded copy and no i18n of its own.
3. **Meaning first, colour second.** A variant or tone is chosen by what it
   means (destructive, recoverable, success), never by the colour wanted. Colour
   is never the only signal: badges carry a glyph, errors carry text.
4. **Readable in both themes.** Small text meets WCAG AA (4.5:1) in dark and
   light. The tokens below say which colours may be text.
5. **No restyling.** No colour, border or radius from utilities or inline styles
   on a library component. Layout utilities (margin, width, flex) are fine. If a
   case does not fit, add a variant to the library.

## Styling — one dialect (ADR-0051)

Three layers, each with one job:

| Layer | Where | What goes there |
|---|---|---|
| **Tokens** | `tokens.css`, `:root` + light-theme blocks | every colour and font, as a CSS custom property (`--soft`, `--acc`, `--mono`) |
| **Component classes** | `tokens.css`, `@layer components` | a library component's own look (`.btn`, `.card`, `.badge-success`, `.dialog`) |
| **Utilities** | app code (`className`) | layout, spacing, type size, and token colours for page composition |

Rules:

- **Colours and fonts are token utilities**: `text-soft`, `bg-ink-mid`, `border-rule`,
  `border-l-acc`, `font-mono`. Transparency is an opacity modifier on a token:
  `bg-org/10`, `border-rule/50`, `bg-black/60` for a backdrop. Tailwind's default palette
  does not exist (`text-gray-500` generates nothing), so only tokens are colours.
- **Never `var(--…)` in TypeScript, never a colour value inline, never an arbitrary colour
  class** (`text-[#b47fff]`, `bg-[rgba(…)]`). A missing colour becomes a token in
  `tokens.css` (plain property + light-theme value + one `@theme inline` line). Lint enforces
  this in every app (`operai-ui/eslint/design-tokens.ts`).
- **A domain value that picks a colour maps to complete class strings**:
  `{ approved: 'text-grn bg-grn/10' }`, never `{ approved: 'var(--grn)' }` and never
  `` `text-${tone}` `` (the shell's Tailwind scan only sees complete class names).
- **Inline `style` is for runtime values only**: a computed width, a position, a transform.
- **Router active states are classes**: `activeProps={{ className: 'text-acc border-acc' }}`
  with the inactive colours in `inactiveProps`, so the two never compete.
- **The colour scheme follows the theme** (`color-scheme` in `tokens.css`); never set
  `colorScheme` on an element.

Utilities read the custom properties directly (`@theme inline`): `.text-soft` is
`color: var(--soft)`, so the light theme only redefines `--soft`.

## Tokens

Colours, fonts and the light theme are defined in `tokens.css`. Components and
pages use the Tailwind utilities generated from them (`text-text`, `bg-ink-mid`,
see § Styling); only the library's component classes read the custom properties
directly. Never write a hex value in a component.

### Colour

| Token | Use | As text? |
|---|---|---|
| `--ink` | page background | — |
| `--ink-soft` | panels: cards, dialogs, list rows, tool header | — |
| `--ink-mid` | controls: inputs, selects, secondary buttons | — |
| `--rule`, `--dim` | dividers and borders; `--dim` is the stronger one | — |
| `--text` | primary text | yes |
| `--soft` | secondary text: labels, descriptions, meta, hints | yes |
| `--muted` | decorative only: separators, disabled marks | **no** — 2.8–3.2:1 |
| `--acc`, `--acc-hi`, `--acc-lo` | accent: active-tab border, tints | no (`--acc` is 4.47:1) |
| `--focus-ring` | the keyboard focus outline (= `--acc-hi`, ≥ 5.2:1 on every surface) | — |
| `--acc-solid`, `--acc-solid-hi` | filled accent under white text (primary button) | — |
| `--acc-text` | accent as text: links, active tab | yes |
| `--grn`, `--org`, `--red` | success, warning, danger: borders, tints, glyphs | no (light theme < 4.5:1) |
| `--grn-text`, `--org-text`, `--red-text` | the same tones as text: badge labels, banner titles, field errors | yes |
| `--ai` | EstimAI's AI accent: AI-assisted figures | yes (6.8:1 dark, 5.6:1 light) |

`--acc` under white text is 4.3:1, below AA: a filled accent surface uses
`--acc-solid` (5.0:1). The `*-text` tokens were added with the library: they
equal the base tone in the dark theme and are darker in the light theme
(≥ 4.6:1 on `--ink-soft` and on the tone's own 10% tint).

### Type

| Token | Family | Use |
|---|---|---|
| `--disp` / `font-disp` | Syne 700/800 | tool, page, card and dialog titles |
| `--body` / `font-body` | DM Sans 300/400/500 | everything else |
| `--mono` / `font-mono` | DM Mono 400/500 | figures: amounts, ids, dates in tables, table headers, numeric inputs |

The type scale is Tailwind's steps plus one, `text-2xs`. **Arbitrary sizes
(`text-[13px]`) are a lint error** (INC-06); 11px is the floor.

| Class | Size | Use | Component |
|---|---|---|---|
| `text-2xs` | 11px | captions, badges, table headers, tags | `Badge`, `DataTable` header, `FactList` term |
| `text-xs` | 12px | labels, hints, secondary text | `.field-label`, `.list-row-meta` |
| `text-sm` | 14px | body text, controls | — |
| `text-base` | 16px | empty/denied state titles | `StatePanel` |
| `text-lg` | 18px | page titles (h2) | `PageHeader` |
| `text-xl` | 20px | tool titles (h1) | `ToolLayout` |
| `text-2xl` | 24px | rare display figures | — |

Titles use `--disp` (Syne); body and labels `--body`; figures, table headers and
fact terms `--mono`. Buttons are 13px (12px `sm`) inside `.btn`: a component's
own size, not a page choice.

`font-mono` resolves to DM Mono since the library fixed the theme keys
(`--font-mono`, not `--font-family-mono`, INC-01).

### Themes

Dark is the default. `data-theme="light"` on `<html>` (the shell's theme toggle)
or the system preference switches to light; `data-theme="dark"` forces dark.
Check every new component in both (Storybook's _Theme_ toolbar).

## Layout

### Tool frame — `ToolLayout`, `TabNav`

A tool remote renders `ToolLayout`: the tool title (h1), its `TabNav`, and the
routed page in one of three columns (INC-12):

| `width` | Column | Use |
|---|---|---|
| `narrow` | 40rem | a single form or profile (`/account`) |
| `default` | 64rem | lists and detail pages (every tool) |
| `wide` | 90rem | data-dense workspaces (EstimAI's estimate editor) |

The shell owns everything around it — header,
sidebar, session, the page's one `<main>` — so a remote never renders chrome or
a `<main>` of its own (ADR-0006; INC-29).

Tabs are links with `className={tabLinkClassName}`. TanStack Router's `<Link>`
sets `aria-current="page"` on the active one, which is what the style keys on. A
tab the user may not open is left out of the DOM, never disabled; whether they may
is read from ONE place, `usePermissions()` from `shell/session` (INC-32). A section
pinned to the far end goes in `TabNav`'s `end` slot.

**`TabNav` or `Tabs`?** (INC-30, INC-32) `TabNav` is navigation: each tab is a
page with its own URL. `Tabs` switches views of the SAME page without navigating
(a real `tablist`: one tab stop, arrow keys, Home/End, `aria-selected`; pair each
panel with `tabPanelProps(idPrefix, id)`). Both look the same. Never style plain
buttons as tabs.

### Page header — `PageHeader`

Every page starts with `PageHeader`: an optional back link, the title (h2, with
`titleId` for the page's `<section aria-labelledby>`), an optional `status` badge
beside the title (outside the heading, so not part of its accessible name), an
optional one-line description, and the page-level actions on the right (at most
one `primary`). A page that moves focus to its heading passes `headingRef` and
`focusableHeading`.

**Back links** (INC-13): every detail page has one, in the `back` slot, in every
state: an accent underlined text link, sentence case, the arrow hidden from screen
readers:

```tsx
back={
  <Link to="/requests" className="link" data-testid="request-detail-back">
    <Icon name="arrow-left" /> {t.backLink}
  </Link>
}
```

### Cards — `Card`, `FactList`

A card groups related content: one section of a detail screen, a filter bar, a
composer.

- `Card` is a bordered, rounded panel on `--ink-soft` with an optional title
  (h3) and an `action` on the right of the title row (`secondary`, `sm`).
  Controls inside a card sit on `--ink`/`--ink-mid`.
- A detail page is a column of cards, one per subject (details, lines,
  attachments, history). Do not leave sections as bare headings on the page.
- Label/value pairs use `FactList` (a `<dl>` on an auto-filling
  `minmax(170px, 1fr)` grid), not two wide columns.
- Do not nest cards.

## Actions

### Buttons — `Button`, `buttonClassName`

Every button is `.btn` plus exactly one variant. `Button` renders it on a
`<button>` (default `type="button"`); `buttonClassName()` gives the same classes
to a router `<Link>`.

| Variant | Looks like | Use for |
|---|---|---|
| `primary` | filled accent, white label | the one main action of a screen, dialog or card |
| `secondary` | outlined, neutral | any other action that should read as a button |
| `ghost` | no border, no fill | cancel, close, low-emphasis toolbar actions |
| `danger` | red border and tint | destructive or irreversible actions |

| Modifier | Effect |
|---|---|
| `size="sm"` (`btn-sm`) | compact, for table rows, banners and dense toolbars |
| `iconOnly` (`btn-icon`) | 28px square for an icon-only button; it must have an `aria-label` |
| `busy` | `aria-busy`, a spinner, clicks ignored; keep the label readable ("Saving…") |

Rules:

1. **One primary per view.** A screen, a dialog or a card has at most one
   `primary`. If two actions compete, one of them is `secondary`.
2. **Choose by meaning.** Confirming something irreversible is `danger` even when
   it is the dialog's main action. A positive confirmation (Approve, Mark as
   paid, Compile) is `primary`. A retry in a banner is `secondary`. Cancel is
   always `ghost`.
3. **Do not restyle** (principle 5).
4. **A link that navigates stays a link.** `buttonClassName` on a `<Link>` only
   for an action entry point ("+ New request"). Inline navigation ("← Back to
   requests", a name in a table) is a `.link` text link.
5. **Disabled.** `disabled` when the control should leave the tab order;
   `aria-disabled="true"` when the user must reach it to learn why it is
   unavailable (the handler then ignores the click). Both look the same.
6. **Labels.** Sentence case, a verb first ("Register asset", "Close year",
   "New request"), from the app's strings module. **No glyph prefixes** in a
   label ("+ New request", "↑ Import JSON"): the variant says it is an action
   (INC-11). Glyphs belong in badges, where they are the non-colour signal.

## Dialogs — `ConfirmDialog`, `FormDialog`, `NoticeDialog`, `Dialog`, `Drawer`

| Component | Role | Use |
|---|---|---|
| `ConfirmDialog` | `alertdialog` | confirm one action; focus on Cancel; `tone` `danger` (default) or `primary`; `acknowledgeLabel` for an act that cannot be undone and moves money or closes books (Confirm stays disabled until the sentence is ticked); `fields` when the act needs input (a date, a reason) |
| `FormDialog` | `dialog` | a short form; focus on the first field; Enter submits |
| `NoticeDialog` | `alertdialog` | one acknowledgement, nothing to decide (a guardrail, a conflict) |
| `Dialog` | either | the frame, for anything else — compose `.dialog-body`, `Field`, `Button`s and `.dialog-footer` |
| `Drawer` | `dialog` | reference content read next to the page (help, glossary), as a panel from the right edge; focus on its heading; never a form or a confirmation |

Every dialog, through `useDialogBehavior`:

- is modal and labelled by its title, described by its body or description;
- traps Tab over every enabled control (the × included) and returns focus to the
  element that opened it;
- closes on Escape, the backdrop and × — **except while busy**, when it cannot
  be dismissed and its controls are disabled. A dialog holding typed input
  (every `FormDialog`, or `Dialog` with `dismissOnBackdrop={false}`) ignores the
  backdrop: a stray click must not throw the input away. A click whose press
  started inside the dialog (a text selection released outside) never closes
  anything;
- keeps its content on failure: the request error is shown inline
  (`role="alert"`) above the footer and every typed value stays.
- **stacks**: a dialog opened on top of another (a "Remove this collaborator?"
  confirm over the collaborators dialog) takes the keyboard. Escape and Tab
  act on the topmost dialog only, then on the one underneath once it closes.
  Render the nested dialog anywhere (inside the outer one or beside it).
- locks the page's scroll while any dialog is open (INC-21), restoring it when
  the last one closes.
- focuses its heading instead of a field when `initialFocus="title"` (a dialog
  that is mostly text).

The button that opens a dialog or a drawer is a plain button with
`aria-haspopup="dialog"`, never a toggle (`aria-pressed`): while the dialog is
open nothing behind it can be pressed.

Never use `window.confirm()` or `window.alert()` (INC-18). The app owns the open
state: mount the dialog to open it, unmount it to close.

## Menus — `Menu`

A button that opens a short list of actions or links (the header's logo and
account menus). Opening moves focus to the first item; ↑/↓ move between items
(wrapping), Home/End jump to the ends, Escape closes and returns focus to the
trigger; Tab, a click outside or choosing an item closes it. An action is a
`MenuItem`; a link is the router's `<Link role="menuitem" className="menu-item">`.
`header` holds context that is not an item (who is signed in; a second line in
`.menu-header-secondary`). Not for choosing a value (a `select`, `Combobox`) or
for moving between a tool's pages (`TabNav`).

## Forms — `Field`

`input`, `select` and `textarea` get their base look from `tokens.css` with no
class. Wrap each control in `Field`, which wires label, hint and error:

```tsx
<Field label={t.amount} hint={t.amountHint} error={errors.amount} required>
  {(control) => <input {...control} inputMode="decimal" value={amount} onChange={…} />}
</Field>
```

- Label above the control; hint and error under it; the error in `--red-text`
  and the control marked `aria-invalid` and described by the error.
- **Required (INC-16):** a `*` (aria-hidden) and `aria-required`, which screen
  readers read as "required". One convention suite-wide: mark the required
  fields, never write "(required)" or "(optional)" in a label.
- Validate on submit and on blur of a touched field; a submit that fails
  validation moves focus to the first invalid field. A library `Button` pressed with
  the mouse while a text field has focus does not take focus, so a blur error
  cannot push the button away from under the pointer and swallow the click. A disabled submit is only
  for "nothing typed yet", never the sole explanation of an error.
- An error that is not about one field (503, network, conflict) is a
  `.form-error` paragraph with `role="alert"` above the form's buttons.
- Submit on the right, Cancel (`ghost`) to its left.

**Sizes (INC-17).** A control inside a `Field` is the form size (14px, 6×10px
padding); a bare control (a toolbar filter, an input in a dense table row) is
compact (12px). Both come from `tokens.css`: never restyle a control's padding,
font size or background per app.

**Amounts and dates (INC-17).** `MoneyInput` for an amount: a text field with
the decimal keypad (never `type="number"`, which rejects the comma the suite
displays and silently rounds), parsed with `parseDecimal(text, decimals)` into
integer minor units (cents by default, micros with 6), exactly, never through a
float. `DateInput` for a calendar date (`YYYY-MM-DD`). Both show figures in DM
Mono.

**Several choices from a list — `CheckboxGroupField`.** Roles, departments, items
to link: a `<fieldset>` whose legend names the group, one labelled checkbox per line,
`selected` and `onToggle(id, checked)` owned by the caller, `disabled` in flight,
`emptyState` when there is nothing to pick. When a Card title already names the group,
`hideLabel` keeps the legend for screen readers only; inside a dialog `scroll` caps the
list's height. One choice among several is `RadioGroupField`; a single yes/no is a
checkbox in a `Field`.

**Suggestions while typing — `Combobox`.** For picking a person, a supplier, an
address or a country by typing (a `<select>` when the list is short and fixed). The
caller owns the text, the options and when the popup opens, and says why a list is
empty through `emptyState` ("Searching…", "No people match.", a rate-limit line) and
what is announced through `liveRegionText` (the result count). Keyboard: ↓/↑, Home/End,
Enter picks, Escape closes, Tab leaves without picking. Inside a `Field`, pass the control
props as `id`, `ariaInvalid`, `ariaDescribedBy`, `ariaRequired`. A row after the options
(an attribution) is an `<li className="combobox-footer">` passed as `footer`.

A single-line `<select>` draws the suite's chevron, 10px from the right edge,
with 30px of right padding reserved for it (unlayered rule: padding utilities
do not move it). An inline `background:` shorthand erases the chevron — set
`backgroundColor` — and never add a chevron icon of your own.

A checkbox or radio is a 16px control drawn by `tokens.css`: outlined when
empty, filled with the solid accent and a white mark when checked (a dash when
indeterminate). Use the plain `<input type="checkbox">` with a `<label>`.

## Data — `DataTable`, `ListRows`, `Badge`

- **`DataTable`** for rows with comparable columns: sr-only caption, `scope` on
  every header, `rowHeader` for the row's name (focusable for "focus the row just
  added"), `numeric` columns right-aligned in DM Mono with tabular figures, a
  keyboard-scrollable region when wide. It never formats, sorts or paginates;
  the cell text carries its own currency.
- **Sorting:** mark a column `sortable` and give the table `sort` + `onSortChange`.
  The header becomes a button and the `th` carries `aria-sort`; a first click
  sorts ascending (`firstSortDirection: 'desc'` for dates and amounts), a second
  reverses. The page sorts, on the **server** for a paginated list, so the order
  covers every page, and goes back to page 1. Only offer a column the server can
  order by (a name resolved from another service is not one).
- **Which one (INC-14):** a list of records with comparable columns is a
  `DataTable`; a list where each row opens one record and shows a status, a meta
  line and a figure is `ListRows`. Never a raw `<table>` or a stack of hand-styled
  divs. The one exception is an **editing grid** (EstimAI's activity and summary
  tables: inline inputs, drag to reorder, computed totals), which is a tool of
  its own, not a data table. Nothing sorts a paginated list client-side.
- **Row hover:** `DataTable interactiveRows` tints the row; a list row's border
  strengthens. Never `hover:opacity-*` on a row.
- **`ListRows`** for a list where each row opens one record (`<Link
  className={listRowClassName}>`): a status, one or two meta lines, a figure.
  More than about three comparable columns → `DataTable`.
- **Paging (INC-15) follows the API:** an offset endpoint that reports a total
  uses `Pagination` (Previous / Next, "Page 2 of 5 — showing 26–50 of 112"); a
  cursor endpoint uses `LoadMore`. A list whose endpoint returns everything is
  fine while the data is bounded by the person (their own requests, estimates);
  a list that grows with the organisation must page.
- **Statuses: `StatusBadge` and the status dictionary (INC-23).** Every domain
  status maps to ONE meaning, in one module per app (`approved → 'active'`), and
  the meaning fixes the tone and the icon, so an icon means the same thing in
  every tool. Pass the domain label as the child.

| Meaning | Tone | Icon | For |
|---|---|---|---|
| `draft` | neutral | pencil | not submitted or started yet |
| `pending` | accent | clock | waiting for someone else: submitted, invited, ordered, compiled |
| `active` | success | check | accepted and in effect: approved, accepted, assigned, rate in effect |
| `settled` | success | check-circle | finished for good: paid, receipt confirmed, year closed |
| `stored` | neutral | box | kept, not in use: in stock |
| `attention` | warning | wrench | needs someone, nothing failed: in repair |
| `failed` | danger | x-circle | ended badly: rejected, declined |
| `missing` | danger | help | lost or stolen |
| `voided` | muted | ban | no longer counts: discarded, cancelled, revoked, expired, disposed |
| `info` | accent | info | a neutral fact worth a badge: a system role |

- **`Badge`** for metadata that is not a status (an entity, a currency, an access
  level): `neutral` (or `accent` for emphasis), an `Icon` as glyph only when it adds
  meaning. Never an emoji (flag emoji do not render on Windows) and never a Unicode
  glyph as an icon.

## Feedback — `Banner`, `StatePanel`, `SkeletonRows`, `Spinner`, `VisuallyHidden`

Loading and empty states have one shape each (INC-22): loading is `SkeletonRows`
with a polite `VisuallyHidden live` line (a route-level wait in the shell is a
`Spinner`); empty is a `StatePanel` with a title and a body, never a lone line of
text.

A page shows exactly one state at a time:

| State | Render |
|---|---|
| loading | `SkeletonRows` (aria-hidden) + `<VisuallyHidden live>` "Loading …" |
| load failed | `Banner tone="warning"` with Retry (and the 503 "authorization service unavailable" title where it applies, ADR-0014) |
| forbidden | `StatePanel role="alert" focusOnMount` |
| empty | `StatePanel` (no action if the page header already has it) |
| loaded | the content |

`Banner` tones:

| Tone | Role | Use |
|---|---|---|
| `warning` | `alert` | a recoverable failure the user can retry (orange) |
| `danger` | `alert` | an action failed and needs the user (red) |
| `success` | `status` | a confirmation; `compact` + `autoDismiss` for a transient save |
| `info` | `status` | a neutral notice |

A `warning` or `danger` that is not time-critical (a persistent, non-dismissible
notice; a refusal the person reads in place) keeps its tone and takes `live="polite"`
(`status`) or `live="off"` (static `role="note"`, pair it with an `aria-label`).
`alert` is only for what must be heard at once. Defaults are unchanged.

**Error colour (INC-20).** Orange says "try again": a failed load or a failed
"load more", which the same control retries — `Banner tone="warning"` or the
warning text in `LoadMore`. Red says "something you must fix": a field error, a
failed save or decision shown next to its form or button (`.field-error`,
`.form-error`, `Banner tone="danger"`). Orange is never error text by itself, and
text is never the bare `text-org`/`text-red` (light-theme contrast): use the
components or `text-org-text`/`text-red-text`.

**Success feedback (INC-19).** Feedback on the person's own action appears where
they acted: a compact `Banner tone="success"` with `autoDismiss` (`CONFIRMATION_DISMISS_MS`,
3s for the whole suite, `role="status"`) above or beside the form or list they changed, or a polite live
region when the change itself is visible. After an action that navigates away,
the destination says it (refund's review queue confirmation). The shell's
`ToastHost` (top right) is reserved for notifications that arrive from elsewhere
(another person, the system, via notify-api); a tool never uses it for its own
action feedback. Every create, save, invite and delete confirms in one of these
ways; silence is not feedback.

## Icons — `Icon` (INC-31)

One inline-SVG set in `currentColor` on a 24px grid (Storybook: Foundations →
Icons). Rules:

- **No Unicode glyphs or emoji as icons** anywhere (×, ←, ✓, ⚠, ▶, 💬, 🇮🇹…): they
  render differently per OS, some not at all. Typographic punctuation in copy
  (—, ·) is fine.
- An icon next to text that says the same is decorative (no `label`); an
  icon-only control names itself (`<Button iconOnly aria-label={t.close}><Icon
  name="close" /></Button>`); an icon that carries meaning alone takes `label`.
- One meaning per icon: the status icons belong to the status dictionary; do not
  reuse `clock` or `ban` for something else.
- A shape that is missing is added to `Icon.tsx`, drawn on the same grid.

## Copy and languages (INC-24, INC-25, INC-28)

- **Every user-visible string** — text, labels, `aria-label`s, titles,
  placeholders, errors, badge labels, document titles — comes from the app's
  strings module; the library takes copy as props.
- **One catalog per language, Italian complete.** `const en = {…}` (a function for
  a sentence with a value in it), `const it: typeof en = {…}`, exported as
  `strings = selectStrings({ en, it })`. Each app tests
  `catalogGaps(en, it)` is `[]` and scans every `.tsx` for hardcoded copy.
- **The language is resolved once for the whole suite**: the shell sets
  `<html lang>` from `resolveLocale()` (the browser's preferred languages,
  English fallback) before rendering, and every remote's `selectStrings` reads it.
  No app detects the language on its own.
- **Sentence case** for headings, labels, buttons, tabs, dialog titles and column
  headers, in both languages ("Release summary", not "Release Summary").
- Product names stay as they are: Operai, EstimAI, Rimborsi.

## Formatting (INC-26, INC-27)

Display only; APIs keep ISO 8601 and integer minor units (ADR-0025).

| What | Function | en | it |
|---|---|---|---|
| a date | `formatDate` | 31.10.2026 | 31.10.2026 |
| a date and time | `formatDateTime` | 31.10.2026 14:05 | 31.10.2026 14:05 |
| a date in prose | `formatDateLong` | 31 October 2026 | 31 ottobre 2026 |
| a recent moment | `formatRelative` | 3 hours ago | 3 ore fa |
| an amount | `formatMoney(cents, 'EUR')` | EUR 12,345.50 | 12.345,50 EUR |
| an amount, currency shown elsewhere | `formatAmount(cents)` | 12,345.50 | 12.345,50 |
| any other number | `formatNumber(n, options)` | 30% | 30% |

Numeric dates are day.month.year in both languages (wellD works in Italy and
Switzerland). Italian groups thousands from five digits up (CLDR: 1234,50 but
12.345,50). A negative value has a real minus sign. Figures show in DM Mono.
Never format a date, an amount or a number by hand, and never with
`toLocaleString()`.

## Accessibility checklist (every component and page)

- Landmarks: the shell owns `<main>`; a tool has one h1 (the tool title, from
  `ToolLayout`), each page one h2 (`PageHeader`), cards h3; never skip a level
  (INC-30). A workspace without the tool frame still has an h1 (visually hidden
  if needed).
- A page or state that replaces the content takes focus on its heading through
  the library: `PageHeader focusableHeading`, `StatePanel focusOnMount`,
  `useFocusOnMount` — not a hand-written `tabIndex={-1}` + effect.
- Focus is always visible: `tokens.css` draws a 2px `--focus-ring` outline on every
  keyboard-focused element (text fields show focus with their accent border instead).
  Do not remove it; a component that draws its own indicator replaces it with
  `focus-visible:outline-none` plus a visible `focus-visible:ring-*` of at least 3:1, never a
  tinted ring like `ring-acc/50` (under 2:1 on dark ink). Focus moves deliberately: into an
  opened dialog, back to its trigger, to the heading of a state that replaces the page.
- Anything announced without moving focus goes in a polite live region
  (`VisuallyHidden live`) or a `role="alert"` for errors.
- Icons are `aria-hidden` unless they are the only content (then `label`); the
  text carries the meaning.
- Motion stops under `prefers-reduced-motion`.

## Migration status

| App | Status |
|---|---|
| `shell`, `estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui`, `inventory-ui` | on `@operai/ui`: frames, pages, buttons, dialogs, forms, data, feedback, statuses, icons, copy (en + it) and formatting |

Documented exceptions: estimai's editing grids and workspace header, refund's motivo
autocomplete (specs/014 rules out the library `Combobox`'s empty states).

New code in any app uses the library. Existing screens are migrated app by app;
`docs/ui-inconsistencies.md` lists what each migration fixes.
