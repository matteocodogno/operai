# @operai/ui — decision log

Decisions taken while extracting the library and migrating refund-ui on the
branch `feat/operai-ui-library` (2026-10-31), without a review in between. Each
one says what was decided, why, and how to undo it if the review disagrees. The
architectural decision is ADR 20261031-shared-ui-library-consumed-as-source; this log is the detail under it.

## Structure and consumption

**D-01 — One package at the repo root, `operai-ui/`, named `@operai/ui`.**
Next to the apps, like every other package, and listed in `lerna.json` and in
`scripts/check-changeset.mjs` so Changesets versions it. Undo: rename the folder
and the alias paths in the consumers.

**D-02 — Consumed as source through a Vite alias, not installed.** See ADR 20261031-shared-ui-library-consumed-as-source
§ Options: `link:` gives two Reacts or a missing React on Vercel, `file:` goes
stale, a workspace is ruled out by AGENTS.md, Module Federation would make every
component an untyped runtime dependency. The cost is three config entries per
app (README § Adopting). Verified: refund-ui's production build has the same
two React share chunks as on `main` (no second React), and its 662 unit tests
run against the library through the alias.

**D-03 — The stylesheet moved, its federation contract did not.**
`shell/src/styles/tokens.css` is now a one-line `@import` of
`operai-ui/src/styles/tokens.css` (moved with `git mv`, history kept), so the
shell's `./tokens.css` export and every remote's `import 'shell/tokens.css'`
work unchanged. Verified in the built shell CSS: the Google Fonts `@import` is
still hoisted to the top of both sheets.

**D-04 — Components render library classes only.** No Tailwind utilities and no
inline colours inside `operai-ui/src/components`, so a component renders the
same in the shell's sheet, a remote's standalone build and Storybook. The
classes live in `tokens.css` under `@layer components`, like `.btn` and `.card`
already did; a layout utility on the element still wins.

**D-05 — No copy in the library.** Every label, title and `aria-label` is a
required prop. Apps keep their strings modules (and refund-ui's
`noHardcodedStrings` test keeps working); the library never needs i18n.

**D-06 — Apps keep thin adapters.** refund-ui's `ErrorBanner`,
`ConfirmDeleteModal`, `PermissionDenied`, `SkeletonListRows`, `ToastBanner` and
the badge components still exist, now as a few lines binding copy and test ids
to a library component. Call sites, behavioural tests and e2e test ids are
unchanged. The alternative — calling the library directly everywhere — is a
later, purely mechanical step.

**D-07 — Unprefixed class names** (`.badge`, `.banner`, `.dialog`, `.field`,
`.tab-link`, …), consistent with the existing `.btn` and `.card`. Checked: no app
used any of these names. If a collision ever appears, prefix the new ones
(`op-`).

## Tokens and visuals

**D-08 — New tone-as-text tokens: `--acc-text`, `--grn-text`, `--org-text`,
`--red-text`.** Measured: in the light theme `--grn`, `--org`, `--red` are
3.0–4.4:1 as small text, and `--acc` is 4.47:1 on `--ink` in the dark theme — all
below WCAG AA. The new tokens equal the base tone in dark (except accent, which
uses `--acc-hi`) and are darker in light (`#137044`, `#8f5408`, `#b02626`,
`#3d4ce0`), ≥ 4.6:1 on `--ink-soft` and on the tone's 10% tint. Base tones stay
for borders, tints and glyphs. Effect: badge labels, banner titles, field errors
and active tabs are darker in the light theme.

**D-09 — `--muted` is decorative only.** It measures 2.8–3.2:1 in both themes.
Library components use `--soft` for every readable secondary text; refund-ui's
readable `--muted` text moved to `--soft` (slightly brighter in dark).

**D-10 — Font theme keys fixed: `--font-mono`/`--font-disp`/`--font-body`.**
Tailwind v4 reads `--font-*`; the old `--font-family-*` keys were ignored, so
`font-mono` rendered the system monospace (INC-01). **This changes every app**:
about 80 `font-mono` uses now render in DM Mono, as intended. The hand-written
`.font-disp`/`.font-body` classes were then removed: they duplicated the generated
utilities, were unlayered (so they beat any utility) and fell back to `fantasy`/`serif`.
Undo: revert the three lines in the `@theme` block.

**D-11 — Banner: orange = recoverable, red = must fix.** `Banner tone="warning"`
(orange) for a failed load with Retry, as every app already did; `danger` (red)
for a failed action and for field errors. The body text is `--text` in every
tone (the old banners had orange text, below AA in light). Transient success is
a compact `Banner` with `autoDismissMs`, as refund-ui's `ToastBanner` did; whether
the suite should rather use the shell's `ToastHost` is left open (INC-19).

**D-12 — Badges are tinted (fill + glyph + tone-text label), not outlined.**
Five of six apps already tint; inventory's outlined badges are the exception
(INC-23). `muted` is the one outlined variant (a settled/voided state).

**D-13 — `textarea` gets the base form-control look** (added to the `input,
select` rule in `@layer base`). Unlayered and utility styles still override it,
so existing styled textareas do not change; unstyled ones now match inputs.

## Behaviour

**D-14 — One dialog behaviour for every dialog** (`useDialogBehavior`, taken
from inventory-ui's `FormModal`, the most complete copy): focus into the dialog,
Tab trapped over every enabled control **including ×**, focus returned to the
trigger on close, Escape/backdrop/× close **except while busy**. Changes in
refund-ui: × is now reachable by keyboard (the old traps skipped it); a dialog
can no longer be dismissed while its request runs; focus now returns to the
button that opened it. The focus-trap unit tests were updated to the new order
(× first).

**D-15 — Dialog button variants follow meaning.** Cancel is `ghost`; a
destructive confirm is `danger`; a positive confirmation (Approve, Mark as paid,
Compile) and an acknowledgement are `primary`. In refund-ui the green-outlined
Approve / Mark paid / Compile buttons became filled accent, and the accent-outlined
OK became filled accent. This is the most visible change of the migration;
undo per dialog by passing another `tone`. The full list of refund-ui buttons
whose look changed:

| Control | Before | After |
|---|---|---|
| Approve, Mark as paid, Compile (confirm) | green outline | `primary` |
| Submit request, "try again" new request | accent outline | `primary` |
| "+ Compile new batch", "New request" after a rejection | white on `--acc` (4.3:1, fails AA) | `primary` (`--acc-solid`) |
| Reject, Discard (confirm) | red outline | `danger` |
| Withdraw, Resend email, Add line, Preview, Edit line, Done | accent outline | `secondary` |
| PDF and archive export downloads | tinted text link | `secondary sm` |
| Delete request, delete line (trigger) | low-emphasis outline | `ghost` (the confirm dialog carries `danger`) |
| Attachment remove × | `--muted` glyph | `ghost` icon button |
| "Back to my requests" on New request | bordered pseudo-button | `.link` text link |

**D-16 — Three dialog components plus the frame.** `ConfirmDialog`
(`alertdialog`, focus on Cancel), `FormDialog` (`dialog`, focus on the first
field, Enter submits), `NoticeDialog` (`alertdialog`, one button, no ×), and
`Dialog` to compose anything else (refund-ui's reject and mark-paid dialogs are
composed from it). `NoticeDialog` was added when refund-ui's `GuardrailDialog`
(also in admin and inventory) did not fit the others.

**D-17 — `backdropTestId` on the dialogs.** The e2e suite targets
`reject-dialog-modal`, `mark-paid-dialog-modal`, `compile-batch-confirm-modal` on
the backdrop; the library's own convention is `${prefix}-backdrop`. Rather than
rename ids the e2e suite (which could not be run here) depends on, the dialogs
accept an override. Remove it once e2e moves to the new ids.

**D-18 — `Field` marks required with `*` + `aria-required`, no hidden text.** A
first version added visually-hidden "required" text; its test showed it fused
with the label ("Amountrequired") and screen readers would say "required" twice.
Removed.

**D-19 — `ToolLayout` renders a `<div>`, not a `<main>`.** The shell's layout
owns the page's one `<main>`; four remotes nested a second one (INC-29).
refund-ui no longer does.

**D-20 — `TabNav` is router-agnostic.** It takes links with
`className="tab-link"`; the active style keys on `aria-current="page"`, which
TanStack Router's `<Link>` sets. refund-ui dropped its `activeProps`.

## Storybook

**D-21 — Storybook 10 (react-vite) inside `operai-ui/`,** with the docs and
a11y addons; a11y violations fail a story (`a11y.test: 'error'`). Sections:
Introduction, Foundations (colours read at runtime from the CSS, so they cannot
drift; type), Components, Pages (list with all five states, detail, table —
fixture data modelled on Rimborsi and Inventory, no app code imported).

**D-22 — Storybook runs Tailwind through PostCSS (`@tailwindcss/postcss`),
like the shell and the apps.** A first version used the `@tailwindcss/vite`
plugin: it left `tokens.css`'s Google Fonts `@import url()` in the middle of the
sheet, so Vite warned ("@import statements must precede all other statements")
and the browser ignored it, rendering stories in system fonts. The PostCSS
pipeline hoists the import to the top, as in the apps' builds (verified in the
shell's, refund-ui's and Storybook's output, none of which warn).

**D-23 — Library tests use `@testing-library/jest-dom` and Vitest, with a
plugin-free `vitest.config.ts`** (as the apps do: Vitest 3 brings its own Vite 7
types, which clash with the Vite 8 plugins Storybook needs).

## Tooling and docs

**D-24 — `mise run ui:storybook` and `mise run ui:check`.** `ui:check` runs the
library's checks and then builds and tests every consumer (shell, refund-ui).
There is no CI job for it yet: add one when a second app is migrated.

**D-25 — The design-system doc moved into the library**
(`operai-ui/docs/design-system.md`, `git mv`), expanded to cover every component;
`docs/design-system.md` stays as a pointer because other files link to it.
`operai-ui/docs/building-pages.md` is the procedure AGENTS.md tells an agent to
load before building a page.

**D-26 — The audit is `docs/ui-inconsistencies.md`,** 33 findings with
evidence and, per finding, what this branch fixed.

## Styling dialect (ADR 20261031-one-styling-dialect-token-utilities), applied to all six frontends

**D-27 — Token utilities are the one dialect.** Inline `var(--…)` styles (refund, admin,
notify, inventory: ~850 token values) were converted to Tailwind token utilities, the dialect
the shell and estimai already used. A one-off AST codemod converted 790 properties (only on
intrinsic elements and router `Link`s, refusing any conversion that would fight an existing
class); the rest were converted by hand. Undo: not practical per app; the ADR lists the
alternatives and the trigger for per-remote prefixed sheets.

**D-28 — `@theme inline` and no default palette.** Utilities read `var(--soft)` directly,
so the `--color-*` copy and its three theme repeats were deleted; `--color-*: initial` removes
Tailwind's palette (checked: no app used it). Opacity modifiers replace hand-written
`color-mix()`; they mix in oklab instead of srgb, not visible at these strengths.

**D-29 — Lint, shared from the library.** `operai-ui/eslint/design-tokens.ts`, imported by
every `eslint.config.js` (Node 24 strips the types, so it stays TypeScript): no `var(--` in
any string, no colour literal or `colorScheme` in `style`, no arbitrary colour class.

**D-30 — `color-scheme` follows the theme** in `tokens.css`. Three date inputs (refund ×2,
admin ×1) forced `colorScheme: 'dark'`, which rendered a dark picker in the light theme; the
inline override is gone.

**D-31 — New token `--ai`** for EstimAI's AI purple (`#b47fff` dark, `#7d3fd6` light,
both ≥ 5.6:1), replacing ten `text-[#b47fff]` classes. estimai's hardcoded `rgba()` tints now
use token opacities and therefore follow the light theme, which they did not before.

**D-32 — Remotes' standalone stylesheets import the library tokens** instead of copies
(estimai's was a 270-line copy). This supersedes the ADR 20260709-suite-frontend-module-federation addendum's "keep the copy in sync".

**D-33 — String-scan tests recognise utility-class lists.** refund-ui and estimai-ui's
`noHardcodedStrings` tests allowlisted each `className` string verbatim, so any restyle broke
them; a literal made only of utility classes is now recognised as styling by shape.

**D-34 — Fixed along the way:** inventory-ui's `a11y.test.tsx` still read the tokens from
`shell/src/styles/tokens.css`, a one-line `@import` since the library extraction (and expected
double-quoted `[data-theme="light"]`, which the library's Prettier run had changed). It now
reads `operai-ui/src/styles/tokens.css`. That test was failing on this branch since the first
commit and was not caught because inventory-ui's suite was not run then.

**To review:**
- admin-ui `MileageRatesPage` had `backgroundColor: 'var(--bg)'`; `--bg` is not a token, so
  the input has always been transparent. Converted to `bg-transparent` (same look); decide
  whether `bg-ink` was meant.
- inventory-ui's supplier field (EditAssetDialog, RegisterAssetPage) overrode the Combobox's
  own classes with Tailwind important modifiers (`border-rule!`), hiding the red invalid
  border. Since removed: the field shows the invalid border like every other (D-56).
- admin-ui and inventory-ui tab links now style inactive tabs through `inactiveProps`; hover
  now works on inactive tabs only, exactly as before.

**D-35 — One keyboard focus ring for the whole suite (INC-04).** inventory-ui's
`:focus-visible` ring lived in its standalone `index.css`, which never loads in the shell, so
no app had a consistent ring in production. It now lives in the library's `@layer base`:
2px `var(--focus-ring)` (a new token, `= --acc-hi`), offset 2px, on every focusable element
except text fields (unchanged: accent border + glow) and `tabindex="-1"` programmatic
targets (unchanged: browser behaviour). `.btn`, `.link`, tabs, list rows and table cells use
the same token. Checked before moving it: every `focus-visible:ring-*` in the apps already
pairs with `outline-none`, so no element gets two indicators; elements with `outline-none`
keep opting out. **Visible change:** links, buttons without `.btn`, and custom controls in
shell, estimai, refund, admin and notify now show the accent ring under keyboard focus
instead of the browser's default (or nothing).

## Buttons, type, frames and back links (INC-06 – INC-13), all six frontends

**D-36 — Every app consumes `@operai/ui`.** shell, estimai, admin, notify and inventory got
the same wiring as refund-ui (Vite alias + `dedupe`, Vitest alias, tsconfig `paths`). The
migration was done per app by parallel agents against one written brief, then verified
together: lint, unit tests and builds of all seven packages.

**D-37 — Type scale: Tailwind's steps plus `text-2xs` (11px), arbitrary sizes banned.**
≈190 `text-[Npx]` values mapped by a fixed table (9–11px → 2xs, 12 → xs, 13–15 → sm, …).
11px is the floor, so 9–10px text grew: estimai's SummaryTable headers now wrap (no longer
`nowrap`), its metric figure is 20px (was 22) and a profile figure 18px (was 19).

**D-38 — One button vocabulary everywhere.** Every action is `Button` / `buttonClassName`;
one primary per view. Notable re-variants: admin row deletes, Revoke and Remove member are now
`danger` (were neutral); "New department" is primary; empty states no longer repeat the
header's primary action (admin Roles and Invitations); estimai's editor tabs are underline
tabs, no longer filled with `--acc`. Custom controls kept by rule are listed in INC-07.

**D-39 — Labels lose their glyphs** ("+ New request" → "New request", "↓ PDF" → "Export PDF",
"▶ Expand all" → "Expand all"); dialog titles sentence case. e2e selectors in
`estimai-persistence`, `estimate-sharing` and `refund-headline` were updated with them.

**D-40 — Frames on the width scale.** `ToolLayout` gained `width` (narrow 40rem, default
64rem, wide 90rem) and title `titleId`/`titleRef`/`focusableTitle`/`titleTestId`;
`PageHeader` gained `status` (a badge beside, not inside, the heading). Visible: inventory
and refund columns go from `max-w-5xl` to 64rem, `/devices` and estimai's list from 48rem to
64rem, `/account` is 40rem with the tool title "My profile" as its h1, notify's page h2 reads
"Inbox" under the "Notifications" tool title (e2e selects that name). **Exception:** estimai's
estimate editor keeps its own sticky workspace header (editable name, full-bleed metrics and
tab bars, sideways-scrolling tables) — wrapping it would stack a second title bar and box the
full-bleed bars; it has no `<main>` any more, and no h1, as before.

**D-41 — Back links on every detail page,** in every state, via `PageHeader`'s `back`
(`.link`, arrow `aria-hidden`). New where there was none: refund's request, review and batch
detail (normal state), admin's role editor; estimai's "☰ My Estimates" button became the
"← Back to estimates" link.

**D-42 — Small library additions from the migration:** `StatePanel headingLevel={1}` (the
shell's no-access screen), `TabNav end` (admin's Audit tab pinned right, replacing an
arbitrary-selector workaround), `NoticeDialog`-based guardrails in three apps.

**Library gaps found, not yet closed:**
- No drawer (estimai's HelpDrawer; closed by D-57), no in-page tab/toggle-chip component (estimai's editor
  tabs, release filters), no confirm-with-acknowledgement option (inventory's
  IrreversibleActionDialog, refund's MarkPaidDialog compose it from `Dialog`), no
  phase-change focus in `Dialog`, no test id for `Banner`'s title.

**To review visually** (no browser run of the assembled suite was possible): estimai's
summary table with wrapped headers, the 64rem columns, `/account` at 40rem, the Register
asset form's button order (Cancel left of Register, right-aligned).

**D-43 — Dialogs stack.** Every library dialog used to listen for Escape and Tab on
`window` on its own, so with a confirmation open over a dialog one Escape closed both, and
the outer trap counted the inner dialog's buttons as its own. `useDialogBehavior` now keeps a
module-level stack of open dialogs (bottom to top) and only the topmost one handles the
keyboard; a dialog that mounts in the same commit as one nested inside it is placed below it
(React runs the child's effects first). Tests: Escape closes inner then outer, Tab stays in the
inner one, same-commit mounting (verified to fail with the ordering removed). estimai's
CollaboratorsDialog, the one dialog kept local because of this, now uses the library `Dialog`
(new `dialogTestId`, and `initialFocus="title"` for its member branch); its hand-written
trap and Escape bookkeeping are gone, its 32 tests unchanged.

## Data, forms and feedback (INC-14 – INC-21), all six frontends

**D-44 — Paging follows the API.** Offset endpoints with a total get `Pagination`
(admin users, invitations, audit); cursor endpoints get `LoadMore` (inventory assets). One
pattern for everything would have meant changing the APIs; the person-bounded lists
(requests, estimates, notifications) do not page.

**D-45 — Two control sizes, from the library.** A control in a `Field` is the form size
(14px); a bare control in a toolbar or a dense table row stays compact (12px). Apps no longer
restyle controls. `MoneyInput` (text + decimal keypad, never `type="number"`) and
`parseDecimal` (exact, comma or dot, refuses an extra decimal) for amounts — refund's parser
is now stricter (`10.005` is refused, not rounded); admin's mileage rate is checked at micro
precision. `DateInput`/`DateTimeInput` for dates.

**D-46 — Required = asterisk.** One convention: `*` + `aria-required`, no "(required)"/
"(optional)" text (inventory's suffixes removed). Validation on blur of a touched field and on
submit; a failed submit focuses the first invalid field; a disabled submit means only "nothing
typed yet" — several buttons that used to stay disabled while a value was invalid now explain
the error instead (refund Add line, admin Invite, inventory Assign, estimai Add collaborator),
and refund's line editor no longer drops an invalid edit on Done.

**D-47 — Feedback where the person acted.** Every create/save/invite/delete confirms
(compact success Banner, a live region, or the destination after navigation). The shell's
`ToastHost` stays for notifications from elsewhere (ADR 20260713-notification-center-standalone-service-shell-seam keeps that seam narrow).
Orange = retryable failure, red = failed action or field error.

**D-48 — Dialogs lock page scroll** while any is open, restored when the last closes.

## Language, format, icons and structure (INC-22 – INC-33), all six frontends

**D-49 — Italian everywhere, resolved once.** Every app has complete `en` and `it`
catalogs (`const it: typeof en`), a parity test and a scan for hardcoded copy. The shell sets
`<html lang>` from the browser's preferred languages before anything renders (a first import
in `main.tsx`, because each strings module picks its catalog when it is evaluated); every
remote's `selectStrings` reads it. Tests and Playwright run in English, so English assertions
stand. Product names stay (Operai, EstimAI, Rimborsi); admin is "Amministrazione", inventory
"Inventario" in Italian. **Not translated, by decision:** client documents (estimai's PDF/XLSX
exports, refund-api's PDFs) and user data (estimai's templates).

**D-50 — Formatting.** Numeric dates dd.mm.yyyy in both languages (what refund and
inventory already showed; unambiguous in Italy and Switzerland); amounts with the currency
code and the language's separators (English "EUR 1,234.50", Italian "1234,50 EUR" — CLDR
groups Italian thousands from five digits); a real minus sign. **Visible change:** refund and
inventory amounts read "EUR 45.50" in English instead of "45,50 €"; date-times lose their
comma. e2e expectations updated in the refund and inventory specs.

**D-51 — One status dictionary, one icon set.** Ten meanings (draft, pending, active,
settled, stored, attention, failed, missing, voided, info), each with a fixed tone and icon;
every app maps its domain statuses in one module. Icons are inline SVG in the library (about
50 shapes, one meaning each; `pencil` is the draft status, so the estimai "Editor" access level
uses `edit`). Emoji and Unicode glyphs as icons are gone, flags from entity badges too.
Badge borders are gone (inventory's outlined badges become tinted ones); inventory's
"border ≥ 3:1" a11y tests went with them, text contrast stays tested.

**D-52 — Headings and focus.** h1 tool, h2 page, h3 card; focus on mount through the
library. estimai's editor gets a visually hidden h1 ("EstimAI — {estimate}") and its view
switch becomes a real tablist (`Tabs`, new in the library). admin's section tabs read
`usePermissions()`; two admin pages still fetched `getMe()` for page-level checks (closed by D-58).

**D-53 — Cards and rows.** Detail pages are columns of `Card`s with `FactList`
(admin user/department/role, refund request/batch, inventory asset/year, estimai profiles);
row lists are `ListRows`, a row with its own actions uses `list-row is-interactive`.

**Library additions from these batches:** `Pagination`, `LoadMore`, `MoneyInput`,
`DateInput`, `DateTimeInput`, `parseDecimal`, `RadioGroupField`, `focusFirstInvalid`, `Icon`,
`StatusBadge`/`STATUS`, `Tabs`/`tabPanelProps`, `selectStrings`/`catalogGaps`/`resolveLocale`,
the formatters, `useFocusOnMount`; new props on `Field` (id, errorTestId, errorRole), `Banner`
(actions, dismissible, titleTestId, ref), `DataTable` (renderDetail, labelledBy), `Card`
(titleTestId), `StatePanel` (levels 1–4), `ToolLayout` (width, title props), `PageHeader`
(status), `TabNav` (end). Fixed: the Banner auto-dismiss timer restarted on re-render.

**Still to do:** inventory empty states inside cards at h4, the visual review and e2e run on
the assembled suite. (The combobox, the drawer and admin's page checks were closed by
D-56 – D-58.)

**D-54 — Storybook is the complete reference, with generic pages.** Introduction,
Foundations (colours with measured contrast, type, spacing and widths, themes, focus, icons,
the status dictionary, formatting, languages), one Components entry per exported component
(Docs page with generated props, a Playground, one story per variant or state), and Pages: a
fictional "Catalogue" tool with no reference to any app of the suite — navigation, item list
(loaded, loading, error, empty, forbidden), card list with load more, item detail, create and
edit form, deletion flow (success and failure), quick create in a dialog, settings, and a
states gallery. 189 entries, every story checked with axe in both themes.

**D-55 — Buttons keep a typing field focused on mouse press, and busy keeps contrast.**
Found while building the pages: with blur validation, pressing Save right after leaving an
invalid field showed the error on mousedown, the error pushed the button down and the click
was lost. A library `Button` pressed with the mouse while a text field has focus now does not
take focus (the click still runs; a submit still validates and focuses the first invalid
field). Trade-off: a dialog opened that way returns focus to the field, not the button. And a
busy button is no longer dimmed to 70% (that put a primary label under 4.5:1).

**D-56 — One `Combobox` in the library.** admin-ui (address, country) and inventory-ui
(holder, supplier) carried the same component and the same tests; both now import it from
`@operai/ui`, and the tests moved with it. It renders library classes only (`.combobox*`;
`.combobox-footer` for a row the app adds, like admin's Google attribution), takes the
`Field` control props, and now keeps the highlighted option scrolled into view, which
`aria-activedescendant` does not do (a long holder list needed it). inventory's unused
`inputClassName`/`inputStyle` props were dropped. refund-ui's `MotivoSuggestField` stays its
own: specs/20260811-motivo-autocomplete wants no empty, loading or error line in its popup and the combobox role only
on `travel_km` lines; reconsider if a third plain autocomplete appears.

**D-57 — `Drawer`: a modal panel from the right, for reference content.** Built on
`useDialogBehavior` like `Dialog` (heading takes focus, Tab trapped, Escape/backdrop/×,
scroll lock, nested-dialog stack); only the shape differs. estimai's HelpDrawer is its first
use and loses its own portal, Escape listener and frame. Its trigger was a toggle
(`aria-pressed`), which a modal cannot be — nothing behind it is pressable while it is open —
so it is now a plain button with `aria-haspopup="dialog"`. A non-modal side panel (page stays
usable) is a different component; none is needed today.

**D-58 — Permissions come from `usePermissions()` only.** admin's user detail (address
section, `admin` role) and mileage-rate page (`rate:manage`, `settings:read`/`manage`) read
the shell's cached `/authz/me` instead of fetching it again; `adminApi.getMe()` is removed.
Behaviour is the same: the shell's tool guard has loaded the permissions before admin
renders, and a failed load resolves to no grants, so the sections still fail closed. A
permission change now reaches these pages when the shell revalidates (on navigation), as it
already did for the tabs.

## Second sweep for shared components

**D-59 — `ConfirmDialog` takes an acknowledgement and fields.** refund's `MarkPaidDialog`
(mark a batch paid) and inventory's `IrreversibleActionDialog` (dispose, close a fiscal year,
new depreciation rule) were the same dialog built twice on `Dialog`: a consequence, an
optional form slot, a checkbox whose label is the whole sentence, Confirm disabled until it is
ticked, Cancel focused for a pure confirm. That is now `ConfirmDialog`'s `acknowledgeLabel`
and `fields`; both apps keep a thin adapter for their copy and test ids. A ConfirmDialog is
now always a `<form>`, so Enter in a field confirms (only when Confirm is enabled). A pure
confirm is `sm`, one with fields `md` (inventory's close-year dialog became narrower).
refund's `RejectDialog` (a required reason) and `ApproveDialog` stay app-side: one use each.

**D-60 — `Menu` for the header's menus.** The shell's `LogoMenu` and `UserMenu` repeated the
same open/close effect and the same hand-written list, and declared `role="menu"` without the
keyboard a menu promises. The library `Menu` follows the WAI-ARIA menu button: focus to the
first item on open, ↑/↓ wrapping, Home/End, Escape back to the trigger, Tab or a click
outside closes. Its items share one style (body font, 13px): the account menu's items were in
DM Mono and the logo menu's were not; the account email line is `--soft` (it was `--muted`,
which is not for text a person must read). Only the shell uses it today; it is in the library
because a menu is a design-system primitive with keyboard rules apps should not rewrite.

**D-61 — One confirmation time.** Success banners dismissed themselves after 3 s, with the
number written in four apps (`CONFIRMATION_AUTO_DISMISS_MS` in refund, `SUCCESS_DISMISS_MS`
in admin, `3000` literals in estimai and inventory; one Storybook page used 4 s). `Banner`'s
`autoDismissMs` became `autoDismiss` (boolean) and the delay is the library's
`CONFIRMATION_DISMISS_MS`, exported for tests.

**D-62 — `CheckboxGroupField`.** admin (invite: roles and departments; user detail: direct
roles and departments; department detail: roles) and inventory (link the other assets of an
invoice) each wrote a fieldset of labelled checkboxes by hand, with three spacings and two
legend styles. The library component takes options, the selected ids and `onToggle(id,
checked)`, keeps the legend (visible, or `hideLabel` under a Card title), disables the group
in flight (user detail now does too while saving) and shows `emptyState`. admin's local
`CheckboxFieldset` is gone. RoleEditor's fieldsets (permission rows with conditions) are a
form layout, not a list of choices, and stay as they are.

**D-63 — What stays in the apps after the sweep.** Same-named files across apps are adapters,
not copies: `ErrorBanner`, `GuardrailDialog`, `PermissionDenied`, `ConfirmDeleteModal`,
`SkeletonListRows`, `NotFoundPage`, admin's `SuccessBanner` and refund's `ToastBanner` bind
the app's strings and the e2e test ids to a library component (ADR 20261031-shared-ui-library-consumed-as-source), and stay app-side
so copy stays in each strings module. `EntityBadge`/`CurrencyBadge` (refund, inventory) map
domain values to `Badge`; the library holds no domain values. estimai's `FormulaPopover` and
`WarningBadge` tooltip are single-app; they move to the library if a second app needs a
popover.

**D-64 — `Tooltip` (2026-11-01).** The CRM became the second app that needs one: its
"Proceed without estimate" action (specs/20261101-crm-sales-flow) needs a sentence its label cannot hold. The
library's `Tooltip` opens on hover and on keyboard focus, closes with Escape (WCAG 1.4.13),
and links to its trigger through `aria-describedby`, which the caller spreads from a render
argument. It is positioned in CSS under the trigger, with no portal, so it can be clipped
by an ancestor with `overflow: hidden`. estimai's `WarningBadge` keeps its own portal
tooltip, which shows an icon and a title, until it is migrated.

## Width scale, widened (2026-11-13)

**D-65 — `default` is 80rem and `wide` is the full width.** On a wide screen the 64rem
`default` column left almost half of the space beside the sidebar empty, and every tool's
lists used it. The owner chose to widen the scale itself rather than switch list pages to
`wide` route by route (which also makes the column jump between a list and its record) or
drop the limit everywhere (very long lines in forms, transcripts and notes). `default` goes
from 64rem to 80rem; `wide` goes from 90rem to no limit (the 24px gutter stays); `narrow`
stays 40rem. One change in `tokens.css`, no app touched. A block of running text that
needs a reading measure inside a wider column sets its own `max-w-*`.

## Lifted from letterheads-ui (2026-11-17)

**D-66 — `ErrorSummary`, `VersionTable` and `VersionBanner` (specs/20261117-legal-entities, plan E9).** The
legal-entities page in admin-ui is the second app that needs a refused-save summary and a version history, so
the three letterheads-ui patterns (`ErrorSummary.tsx`, the table of `HistoryPanel.tsx`, the banner of
`HistoryPanelVersion.tsx`) are built in the library, presentational and without copy: `{ title, hint, items,
onGo }`, `{ caption, rows, labels, canRestore, onOpen, onRestore }`, `{ title, children, badge, onBack,
onRestore, restoreBlockedReason }`. The fetching hook, `strings`, the `Problem` type and `RestoreDialog` (it owns
an API call; its confirmation is `ConfirmDialog`) stay in the apps. Two behaviours are new against the originals:
a version that cannot be restored keeps an `aria-disabled`, described Restore instead of hiding it, and
`ErrorSummary` renders nothing for an empty list. The test ids are derived from one `testId` prop, not the
letterheads names.

letterheads-ui is **not** migrated in this change: it keeps its own copies, because specs/20261116-letterhead-service
may still fix them in its QE/eval. **Follow-up (open):** once that spec is done, replace letterheads-ui's
`ErrorSummary.tsx`, the table in `HistoryPanel.tsx` and the banner in `HistoryPanelVersion.tsx` with thin adapters
over these three (binding its strings and its e2e test ids), and delete the copies.
**D-67 — `SearchPicker` for a server-side search (2026-11-13, specs/20261112-time-tracking).** hours-ui is the
third app that picks a record out of a search the server answers, with five uses (project,
deal and meeting in the entry dialog, project and deal in the filters); crm-ui and
projects-ui each already carry a near-identical `CompanyPicker`. The library's `SearchPicker`
is that component with its rules written down and tested: one `search` call per settled text
(250 ms), the request in flight aborted when the text changes, the list closes or the picker
unmounts, a late answer to an older text discarded even when the app's `search` ignores the
signal, "picked, never typed", and a polite announcement of each state. It differs from the
two copies on purpose: it asks again on every open and says "searching" until that answer
arrives (they showed the cached list, which can be one permission or one booking out of
date); it follows `value` when the app changes it (they read it once, so a "Clear filters"
left the old name in the field); it keeps `forbidden` and `unavailable` apart (a 403 and an
unreachable service are different sentences, and neither is "no match"); and it announces
searching, no match and the failures as well as the count. `PersonPicker` could not be
stretched to it (it loads a whole list once and filters in the browser) and `Combobox` stays
the dumb primitive (D-56), with one fix made for this use: Escape with the popup open now stops
there (`Combobox` consumes it), where before it also closed the `Dialog` around the field
(`useDialogBehavior` listens on the window), so the first Escape closes the list and the next
the dialog. The two `CompanyPicker`s are not migrated here; they move when their screens are
next touched. Undo: an app keeps its own picker; nothing else depends on it.

**D-68 — `ExportButton` for a download (2026-11-13, specs/20261112-time-tracking).** inventory-ui's
`ExportYearButton` is "Export XLSX" on the fiscal-year page; hours-ui needs the same control
in two views, so by the library rule it moves in. The library's `ExportButton` is that
button with the app-specific parts passed in: `build` returns the file (`data`, `fileName`,
and an optional `readyMessage` for a caveat such as "names are missing"), `mimeType` defaults
to XLSX, the three sentences are props, and `resetKey` replaces the year's status that the old
button tied to by hand. Kept from the original: `aria-busy`, never `disabled` (it would drop
keyboard focus), a second click ignored (also within one tick, with a ref, since a click can
land before React shows the busy state), a polite "preparing" then "ready", an inline alert on
failure with the button usable again. Changed on purpose: the status is cleared when `resetKey`
changes and does not return if the key does; a file that finishes after the key changed is
still handed over (the person asked for it) and says nothing, and does not swallow the next
click; the anchor is attached to the page for the click (some browsers ignore a detached
one) and the object URL is revoked after 30 s instead of at once (a browser reads it
asynchronously, and an early revoke can cancel the download). A failure has one fixed
sentence; an app that must say why routes that to its own banner and rejects. inventory-ui is
not migrated here; it moves when its year page is next touched. Undo: an app keeps its own
button; nothing else depends on it.

## Pinned table columns (2026-11-19, specs/20261116-record-hours-in-place)

**D-69 — `DataTableColumn.pin?: 'start' | 'end'` (D27 of that spec, plan R12).** My hours' month is a table of 30 or 31
day columns that scrolls on every ordinary window, and on its first scroll the row's name and its total left the
screen. `pin` keeps one column at each edge of the scroll region while the others scroll under it. Rules:

- **At most one column per edge; the first wins, a later one is ignored** (not an error: a column list that
  is built from data should not throw while rendering). Meant for the first and the last column; a pinned column in the
  middle works (it sticks once the columns before it have scrolled past) but nothing in the library asks for it.
- **From 48 rem up only.** Every rule that makes a cell stick sits in one `@media (min-width: 48rem)` block of
  `tokens.css` (a unit test reads the file and fails if one leaves it). Below it the table scrolls whole, as before:
  two sticky columns would leave a phone no room for the days.
- **No `pin`, no change.** The markup of a table without a pin is byte-for-byte what it was (a snapshot test holds
  it); a pinned one adds `is-pinned-start` / `is-pinned-end` to that column's cells and `has-pin-start` /
  `has-pin-end` to the region.
- **The surface is the one the table sits on**, not a fixed colour: `--ink-soft` inside a `.card`, `.dialog`,
  `.drawer` or `.floating-panel` (the card's, as the design asks), `--ink` on the page. A fixed `--ink-soft`
  would draw a lighter stripe on a table that sits directly on the page, which is where most of the library's
  tables are. The row-hover tint (`interactiveRows`) is repeated on the pinned cells, which would otherwise hide it.
- **The edge hairline is an inset `box-shadow`**, on the edge that faces the scrolling columns (`:dir(rtl)` flips it,
  `inset-inline-*` places the cell). The table has collapsed borders and a sticky cell does not carry its own; the
  row hairlines are drawn by the table and continue across the pinned cells (checked in Chromium, both themes).
- **A focused cell is never left under a pinned column (WCAG 2.4.11).** The browser does not know a sticky cell covers
  the cells under it, so the region reserves the pinned column's width as `scroll-padding-inline-start` / `-end`
  plus 8 px (a cell's padding, which clears the focus ring), and the browser honours it when Tab, Shift+Tab or
  `focus()` scrolls a cell into view. The width is the **measured** one: `DataTable` observes the pinned header cells
  (`ResizeObserver`, one measure where it does not exist) and writes `--data-table-pin-start` / `-end` on the region
  as an element style, not as state, so a resize does not re-render the table. Measured in Chromium: a button 40 px
  under the pin is scrolled clear with the padding and left there without it, at both edges.
- **Known edge, kept:** the reserved padding makes the browser treat a *pinned* cell as obscured too, so
  moving keyboard focus onto a control inside a pinned cell scrolls the region (by an arbitrary amount, toward that
  cell's natural place). A mouse click does not (checked), and the month's pinned cells hold text only, so no one
  reaches it today. Not fixable in CSS: `scroll-margin` on the focused element was tried instead and Chrome ignored
  it for focus scrolling, and a `focusin` handler would run before the browser's scroll. Revisit if a pinned column
  ever holds a control (a row-actions menu at the end, say).
- **Compatibility** (README § Versioning). Adding a prop that only the library implements: a remote that passes `pin`
  to a shell whose library predates it gets an unpinned table, with no error. The shell deploys first, hours-ui uses
  it after.
- **Not verified:** Firefox and Safari (only Chromium was available). The CSS is standard (`position: sticky`,
  `scroll-padding`, `:dir()`); the collapsed-border and `scroll-padding`-on-focus behaviour are the two things to look at.

Undo: remove the prop, the `is-pinned-*` / `has-pin-*` classes and the block under "Pinned columns" in `tokens.css`;
an app that passes `pin` then shows an unpinned table.

## Not done (deliberately)

- **refund-ui's detail pages keep their own `<h2 class="page-title">`**
  (they move focus to the heading). `PageHeader` gained `headingRef` and
  `focusableHeading` afterwards, so they can switch in a follow-up.
- **e2e not run.** It needs the whole stack with secrets (`mise run dev`). Unit
  tests, lint, type-check and production builds of the library, the shell and
  refund-ui pass; every e2e `data-testid` was kept. Run
  `cd shell && pnpm e2e refund self-approval-control` before merging.
