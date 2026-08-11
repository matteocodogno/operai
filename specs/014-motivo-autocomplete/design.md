---
spec: 014
status: draft
---

# Design: Motivo autocomplete from the employee's own past mileage lines

Scope of this document: the **client-side interaction surface only**. `refund-api`'s
`GET /line-suggestions`, the grouping/ranking/capping, and the fold live in
`plan.md` + ADR-0041 and are treated here as given. This design layers ARIA combobox
behaviour onto the **one existing `<input id="composer-motivo">`** in
`refund-ui/src/components/ExpenseLineComposer.tsx`. It restructures nothing: no field is
added, moved, resized, or removed, and the composer's grid, labels, ids and `data-testid`s
are all preserved verbatim.

**The design's spine — one derived boolean.** Everything below follows from a single
expression evaluated on every render:

```ts
const matches = matchTripSuggestions(corpus, value, 8)      // pure, sub-ms, never debounced
const open = enabled && !disabled && focused && !suppressed
             && queryQualifies(value) && matches.length > 0
```

Every "no list" requirement collapses into one of its conjuncts, so none of them is an
error branch that can be forgotten or that can leak a message:

| Requirement | Conjunct that makes it true |
|---|---|
| AC-1.1 not `travel_km` → entirely invisible | `enabled` |
| AC-1.3 below 2 non-whitespace chars | `queryQualifies(value)` |
| AC-1.6 no match → **no list, no message** | `matches.length > 0` |
| AC-5.2 corpus fetch failed / timed out → silent | `corpus` stays `[]` ⇒ `matches.length > 0` is false |
| corpus still loading | same as above — identical rendering, by construction |
| AC-5.3 Escape dismisses | `!suppressed` |
| AC-5.5 blur / outside click | `focused` |
| AC-1.8 in-place row editing | structural — `ExpenseLineRow` is never touched |

There is no code path in this design that renders an empty-state, a spinner, a banner or a
toast for the suggestion feature. Adding one would be a spec violation (AC-1.6, AC-5.2),
not a nicety.

---

## Flows

### F1 — Compose a mileage line with suggestions (US-1, US-2)

**Entry:** `/refund/requests/:id` on a `draft` request → `ExpenseLineComposer` is mounted
(`RequestDetailPage`'s `request-detail-draft` branch).

| # | Step | Observable outcome | Refs |
|---|---|---|---|
| 1 | Composer mounts. `MotivoSuggestField` renders with `enabled=false`. | Motivo is an ordinary text input: no `role="combobox"`, no ARIA, no network call. | AC-1.1 |
| 2 | Employee picks Expense type ≠ `travel_km`. | Unchanged from step 1. The existing `composer-km-status` polite line announces the km field's absence, exactly as today. | AC-1.1 |
| 3 | Employee picks **Travel by car** (`travel_km`). | `enabled=true`. Currency `<select>` disappears, `MileageAmountField` replaces Amount, km appears — all existing specs/009 behaviour. Motivo gains combobox roles with `aria-expanded="false"`. **Still no network call** (corpus fetch is lazy, plan D6). | AC-1.1, specs/009 |
| 4 | Employee types the 1st non-whitespace character. | Nothing. `queryQualifies` false. | AC-1.2, AC-1.3 |
| 5 | Employee types the 2nd non-whitespace character. | After 150 ms the single corpus fetch fires. Until it resolves: **nothing rendered** — no spinner, no skeleton (see S3). | AC-1.2, plan D2/D6 |
| 6 | Corpus resolves. | The listbox appears beneath the field with 1–8 options in server order; `aria-expanded="true"`; the polite live region announces the count. | AC-1.2, AC-1.5, AC-1.7, AC-2.3 |
| 7 | Employee keeps typing (narrowing). | Synchronous re-filter, zero network. Highlight resets to none. List closes the moment `matches.length === 0`, silently. | AC-1.4, AC-1.6 |
| 8 | Employee deletes back below 2 non-whitespace chars (or clears, or leaves only spaces). | List closes. Typed text untouched. | AC-1.3 |

**Success exit:** → F2 (pick), or → the employee ignores the list entirely and adds a
hand-typed line exactly as before (AC-5.1).
**Silent exits (all render identically, none is an error):** no match (AC-1.6); corpus
fetch failed/timed out (AC-5.2); corpus still in flight.

### F2 — Pick a suggestion (US-3)

**Entry:** the listbox is open (F1 step 6) with at least one option.

| # | Step | Observable outcome | Refs |
|---|---|---|---|
| 1 | Employee clicks an option, **or** highlights it with ArrowDown/ArrowUp and presses Enter. | — | AC-5.3 |
| 2 | Three draft fields are overwritten **in one `setDraft`**: `motivo` ← the suggestion's verbatim motivo, `km` ← `String(suggestion.km)`, `entity` ← the suggestion's entity. | The three controls visibly change together in a single React commit — never one field at a time. | AC-3.1, AC-3.4 |
| 3 | `date`, `amount` and `currency` are **not written**. | The Date input keeps whatever the employee had (today by default). No amount/currency control exists for this type to fill. | AC-3.2, AC-3.3 |
| 4 | The list closes and is **suppressed** until the next keystroke. | It does not immediately re-open on the motivo it just wrote (see "The re-open trap"). | AC-3.5 |
| 5 | Focus stays in the Motivo input; the caret is placed at the end of the inserted text. | Typing continues to append, never replace. Keyboard users are never stranded. | AC-5.6 |
| 6 | The composer's existing polite status line announces the multi-field change. | See "Making the multi-field change perceivable". | AC-5.6 |
| 7 | `MileageAmountField` — already a pure function of `(entity, date, km)` — re-derives on its own: "Calculating…" then the new `km × rate = amount` breakdown. **No new wiring.** | AC-3.5 |
| 8 | Employee edits Motivo, km or Entity. | Ordinary edits. No control is `readOnly`/`disabled`; no "picked" state is stored anywhere. | AC-3.6 |
| 9 | Nothing has been saved. | The line exists only after "+ Add expense line". | AC-3.7 |

**Success exit:** "+ Add expense line" → on success the composer resets (`emptyLineDraft()`),
`corpusEpoch` is bumped, and the just-claimed trip is suggestible on the next threshold
crossing (plan D6, AC-2.6).
**Error exit:** the add fails → the existing `composer-error` `role="alert"` shows, draft
intact. Untouched by this feature.

### F3 — The autocomplete stays out of the way (US-5)

| Trigger | Outcome | Refs |
|---|---|---|
| Novel motivo, nothing matches | List never appears; no message anywhere; typed text never altered or completed in place. | AC-1.6, AC-5.1 |
| Corpus fetch 4xx/5xx/network/5 s timeout | Identical to the above. Exception is swallowed inside `MotivoSuggestField`; it never reaches `ExpenseLineComposer`'s `error` state. | AC-5.2 |
| Escape while open | Closes, keeps typed text byte-identical, `active = -1`, sets `suppressed`. Next keystroke clears `suppressed` and re-opens. | AC-5.3 |
| Enter with nothing highlighted | Not intercepted at all — today's implicit form submission runs. | AC-5.4 |
| Tab / blur / pointerdown outside | Closes, text unchanged, never selects. Re-focusing the field re-opens if the query still qualifies. | AC-5.5 |
| Screen reader | Standard combobox semantics + polite count announcement; fully operable without a pointer. | AC-5.6 |

### F4 — Own history only (US-4) — **no UI surface**

AC-4.1, AC-4.2, AC-4.3 and AC-4.4 are satisfied structurally by plan D1/D4 and ADR-0041:
the endpoint is parameterless and self-scoped, and the typed query never leaves the page.
This design adds **no** UI affordance that could widen, address, or persist anything —
notably no "search other people's trips" control, no history panel, no local cache. Flagged
here so a reviewer does not read their absence from the screen inventory as an omission.

**AC coverage check.** Every AC with a UI surface appears in F1–F3 and in the state
inventory. ACs with no UI surface: AC-2.1–2.5 (server grouping/ranking — the UI only
renders the order it receives and never re-sorts), AC-4.1–4.4. AC-1.8 has no *new* UI by
design. **No UI is proposed here that no AC asks for** — the two candidates considered and
rejected are recorded under "Scope, drift and open concerns".

---

## Screens & states

One screen is touched: **`RequestDetailPage`, `draft` variant → `ExpenseLineComposer`**.
Twelve states, each independently testable.

| # | State | Trigger | Rendering | Refs |
|---|---|---|---|---|
| **S1** | **Invisible** | `type` is `''` or any of the other 11 types | Motivo is byte-identical to today: `<input type="text" required>` with `id`/`data-testid` `composer-motivo`. **No** `role`, `aria-expanded`, `aria-controls`, `aria-autocomplete`, `aria-activedescendant`, **no** `autoComplete="off"`, no `<ul>`, no live region content. No fetch is ever issued. | AC-1.1 |
| **S2** | **Closed / below threshold** | `travel_km`; `value` has <2 non-whitespace chars (incl. `''` and `'   '`) | Combobox roles present, `aria-expanded="false"`, no `aria-activedescendant`, no `<ul>` in the DOM, live region empty. No fetch. | AC-1.2, AC-1.3 |
| **S3** | **Corpus pending** | threshold just crossed; debounce running or request in flight | **Renders exactly as S2.** No spinner, no skeleton, no "Searching…". Deliberate: see the note below. | plan D1/D6 |
| **S4** | **Open with results** | corpus non-empty and ≥1 match | `<ul role="listbox">` with 1–8 `<li role="option">` in server order; `aria-expanded="true"`; live region = "N suggestions available". | AC-1.2, AC-1.5, AC-1.7, AC-2.3 |
| **S5** | **Open, one highlighted** | ArrowDown/ArrowUp from S4 | `aria-activedescendant` = the active option's id; that option has `aria-selected="true"`, the accent tint + left accent bar, and is scrolled into view. All others `aria-selected="false"`. | AC-5.3, AC-5.6 |
| **S6** | **No match** | corpus non-empty, 0 matches | **Nothing.** No `<ul>`, no `role="status"`/`role="alert"` node, no caption, live region emptied. `aria-expanded="false"`. Input fully editable. | AC-1.6 |
| **S7** | **Corpus unavailable** | fetch rejected: network, 400, 403, 503, or the 5 s abort | **Renders identically to S6.** No banner, no toast, no error text, no retry affordance, no console-visible user surface. The line still composes, adds and submits. | AC-5.2 |
| **S8** | **Dismissed** | Escape pressed while open | Closed with qualifying text still in the field; `active = -1`; `suppressed = true`. The next `onChange` from the input clears `suppressed` and the list re-opens. | AC-5.3 |
| **S9** | **Just picked** | click or Enter-on-highlight | Closed and `suppressed`; Motivo/km/Entity carry the picked values; Date unchanged; `MileageAmountField` transitions Calculating→Computed; polite status announced; caret at end of Motivo. Nothing saved. | AC-3.1–3.7 |
| **S10** | **Blurred** | Tab, click on another control, or pointerdown outside the wrapper | Closed, typed text unchanged, **never** selected. `suppressed` is *not* set, so re-focusing re-opens. | AC-5.5 |
| **S11** | **Submitting** | `disabled` (the composer's `submitting`) | Input disabled as today; list forced closed; no fetch. | existing |
| **S12** | **In-place row edit** | `ExpenseLineRow` edit mode on a saved `travel_km` line, `id`/`testid` `row-{lineId}-motivo` | Plain input. No combobox, no listbox, no fetch — `ExpenseLineRow.tsx` is not modified at all. | AC-1.8 |

**S3/S6/S7 render identically, and that identity is the design.** Plan D1: "an empty corpus
is indistinguishable from *no trips match*, which AC-1.6 already specifies as no list, no
message." A loading indicator would be the *only* thing able to distinguish them — and it
would then need a suppression branch on failure, which AC-5.2 forbids. So there is no
loading state to get wrong. QE should treat the absence of loading feedback as **the
specified behaviour**, and test S3, S6 and S7 as three distinct causes with one identical
rendering.

### The suggestion row

Five facts (AC-1.7) in two lines, each line with one job. Target row height ≈ 54 px.

```
┌────────────────────────────────────────────────────────────────┐
│ Milano → Lugano cliente ACME sede nuova…            ← line 1    │  var(--text), text-sm
│ 62 km   🇨🇭 WellD CH                 Used 14× · last 28 Jul 2026│  ← line 2
└────────────────────────────────────────────────────────────────┘   var(--soft), text-[11px]
   └── the facts that get FILLED ──┘        └── why it ranks here ──┘
```

- **Line 1 — identity.** The motivo, verbatim as originally typed (AC-2.5 — never the
  folded/lower-cased form). `var(--text)`, `text-sm`, single line, truncated with
  `overflow-hidden text-ellipsis whitespace-nowrap`, plus `title={suggestion.motivo}` so a
  pointer user can reveal the full text. CSS truncation does not affect the accessible name
  (see Accessibility), so screen-reader users always get the whole string.
- **Line 2, left — the fill set.** `{km} km` then `<EntityBadge entity={…}/>`, reused
  as-is. These are exactly the two facts (besides motivo) that a pick will write into the
  form, so they sit on the left where the eye lands first, and they are what tells two
  same-motivo trips apart (AC-2.2).
- **Line 2, right — the ranking rationale.** `Used 14× · last 28 Jul 2026`, right-aligned
  into a consistent column. Three deliberate devices stop this reading as decoration:
  1. **One phrase, not two loose numbers.** "Used 14× · last 28 Jul 2026" is a sentence
     about frequency and recency — literally the two signals of AC-2.3, in that order.
  2. **A right-aligned column.** Down the list the counts form a visibly non-increasing
     ladder, which is AC-1.7's "never shows a lower count than a suggestion listed below
     it" made *visible*. That ladder is the list's explanation of its own order.
  3. **Subordinate colour.** `var(--soft)`, one step down from the motivo's `var(--text)` —
     present and readable, never competing with the identity line.
- **Row height is fixed at one line of motivo** (rather than a 2-line clamp) so the
  max-height/scroll maths is predictable and the count ladder stays aligned. km is a strong
  disambiguator for motivos that truncate at the same point.
- **No matched-substring highlighting** (plan D9). If it is ever added, it MUST be built by
  splitting the motivo into an array of plain strings and `<mark>` elements rendered as
  React text children — **never `dangerouslySetInnerHTML`**. Motivo is user-controlled free
  text; the whole render path in this design is React text children precisely so no
  injection surface exists (plan Security §5).

**Date format:** `formatDate(suggestion.lastUsedOn)` from `refund-ui/src/lib/dates.ts`,
reused as-is → "28 Jul 2026". The wire value is ISO date-only per the contract; localised
display is a UI concern (CLAUDE.md). This is the same helper already applied to a date-only
value in this app (`ExpenseLineRow`'s `appliedRate.validFrom`), so behaviour is consistent
— including its one known quirk (a date-only string parses as UTC midnight, so a viewer in
a negative-UTC-offset locale sees the previous day). wellD operates in Europe/Rome and
Europe/Zurich; accepted, pre-existing, and explicitly not re-litigated here.

### Visual specification

All colour via shell-provided CSS custom properties, applied in the composer's existing
idiom (inline `style={{}}` + Tailwind utilities). Works in both the dark and light token
sets shipped by `shell/src/styles/tokens.css`.

| Element | Spec |
|---|---|
| Wrapper | `<div className="relative">` — rendered in **both** the `enabled` and `!enabled` branches so the `<input>` DOM node (and its focus, selection and IME state) survives an expense-type change. |
| Input | Unchanged classes/styles from today: `text-sm px-2.5 py-1.5 border rounded`, `borderColor: var(--rule)`, `color: var(--text)`, `backgroundColor: var(--ink)`. |
| Listbox | `absolute z-10 mt-1 border rounded-md shadow-lg overflow-y-auto`, `backgroundColor: var(--ink-mid)`, `borderColor: var(--rule)`, `overscrollBehavior: 'contain'`. `--ink-mid` reads as an elevated surface above the composer's `--ink-soft` form in **both** themes. |
| Option (idle) | `px-3 py-2 cursor-pointer`, `borderLeft: 3px solid transparent`. |
| Option (active) | `backgroundColor: var(--acc-lo)` **and** `borderLeft: 3px solid var(--acc)`. Two signals, so the active option is never conveyed by colour alone (WCAG 1.4.1), and the transparent-to-accent border swap causes no layout shift. |
| Option (hover) | `backgroundColor: color-mix(in srgb, var(--acc) 6%, transparent)` — **visual only**. Hover deliberately does *not* set `active` (see Interaction). |
| Motivo text | `var(--text)`, `text-sm`. |
| Metadata line | `var(--soft)`, `text-[11px]`. |
| Motion | **None.** No flash, no slide, no fade — nothing to gate behind `prefers-reduced-motion`, and no new CSS file/keyframes in a project that has neither (CLAUDE.md: no external CSS files without a proper module setup). |

**Contrast, verified against the real token values.** Metadata uses `var(--soft)`
(#8888aa dark / #60608a light) on `var(--ink-mid)` → **4.97:1** dark, **4.88:1** light —
both pass WCAG AA for normal text. It deliberately does **not** use `var(--muted)`, which
measures ≈2.6:1 on these surfaces. See the a11y hotspot note about `--muted`'s existing use
elsewhere in this composer.

---

## Component inventory

**Library in use: none.** `refund-ui` has no component library — verified from
`refund-ui/package.json` (deps: `react`, `react-dom`, `@tanstack/react-router`,
`better-auth`; no Mantine/MUI/Chakra/Ant/shadcn). Styling is **Tailwind CSS 4** utilities
plus the Operai design-system CSS custom properties consumed at runtime from the federated
`shell/tokens.css` (`refund-ui/src/index.css` imports Tailwind only and defines no palette
of its own). Components are hand-rolled and local to `src/components/`. Fonts DM Sans /
DM Mono / Syne via `var(--body)` / `var(--mono)` / `var(--disp)`.

| Element needed | Decision | Notes |
|---|---|---|
| Entity chip on a suggestion row | **REUSE as-is** — `components/EntityBadge.tsx` | Already glyph+text+colour, already sourced from `strings.badges.entity`, already never colour-alone. Zero change. |
| Date on a suggestion row | **REUSE as-is** — `lib/dates.ts` → `formatDate` | Existing precedent for a date-only value in this app. |
| Recomputed mileage amount after a pick | **REUSE as-is, untouched** — `components/MileageAmountField.tsx` | Already a pure function of `(entity, date, km)` props; the pick changes two of them and it re-derives itself. **No new wiring, no new prop** (AC-3.5). Its debounce/token/derived-idle model is also the interaction precedent this design mirrors. |
| Active-option highlight token | **REUSE as-is** — `var(--acc-lo)` | A first-class, theme-aware token already defined for exactly this; no `color-mix` needed. |
| Copy | **EXTEND** — `src/strings.ts` | New `components.motivoSuggest` namespace + one key in `pages.requestDetail.composer`. |
| The composer form | **EXTEND** — `components/ExpenseLineComposer.tsx` | Swap the raw Motivo `<input>` for `<MotivoSuggestField>` (same `id`, same `data-testid`, same `required`/`disabled`), add an `onPick` handler that writes `{motivo, km, entity}` in one `setDraft`, bump `corpusEpoch` on a successful add, and reuse the existing polite status line for the pick announcement. No field added, moved or removed. |
| In-place line editing | **UNTOUCHED** — `components/ExpenseLineRow.tsx` | AC-1.8 is satisfied by not touching it. Explicitly listed so nobody "completes" the feature by adding it there. |
| The combobox itself | **NEW (1)** — `components/MotivoSuggestField.tsx` | See justification below. |
| Suggestion row markup | **NOT a new component** | A co-located, non-exported render function inside `MotivoSuggestField.tsx`. One consumer, ~15 lines of JSX; a separate file would be ceremony. Keeps the plan's file list exact. |

**Deliberately NOT used** — each of these would be a spec violation, listed so the absence
is legible as a decision:

| Existing component | Why not |
|---|---|
| `ErrorBanner` | AC-5.2 forbids any error surface for this feature. |
| `ToastBanner` | AC-5.2 forbids a toast. |
| `SkeletonListRows` | AC-1.6/plan D1 — there is no loading state to show (S3). |
| `PermissionDenied` | A 403 on the corpus fetch degrades silently (AC-5.2); the composer's own permission story is unchanged. |
| `GuardrailDialog` / `ConfirmDeleteModal` | A pick is reversible by editing (AC-3.6) and saves nothing (AC-3.7). No confirmation. |
| `CurrencyBadge` | `travel_km` has no employee-selectable currency (specs/009 AC-1.6, AC-3.3). The suggestion row shows entity, never currency. |
| `SubmitValidationSummary` | The feature introduces no validation. |

**Ratio: 4 reused as-is · 2 extended · 1 untouched-and-load-bearing · 1 NEW.**

### Why `MotivoSuggestField` is genuinely NEW

The suite already has an ARIA combobox: **`admin-ui/src/components/Combobox.tsx`**
(specs/012, ADR-0032 — the Google Places street/country fields). It is the correct prior
art and this design mirrors its ARIA and keyboard contract closely. It cannot be *reused*
as code, for three reasons:

1. **No shared package exists.** The monorepo is deliberately mixed pnpm/Bun with per-app
   installs and no workspace linking (CLAUDE.md); `admin-ui` and `refund-ui` are separate
   federated remotes with separate `package.json`s. Cross-importing is not possible, and
   exposing a UI primitive over Module Federation for one consumer would be a new
   shell↔remote seam (ADR-0030's rule territory) for no benefit.
2. **The option shape does not fit.** `ComboboxOption` is `{id, label, secondaryLabel?}` —
   three strings. A trip suggestion is five typed facts including a rendered `EntityBadge`
   and a right-aligned metadata column. Generalising it would mean a `ReactNode` escape
   hatch, i.e. giving up the abstraction that made it shared.
3. **Different, AC-driven behaviour.** Three of this feature's ACs demand semantics
   `admin-ui`'s component does not have (AC-5.4's "Enter with nothing highlighted behaves
   exactly as today", the corpus-lifecycle ownership, and the pick-suppression rule). Those
   are documented as deliberate divergences below.

The mitigation for having two comboboxes in the suite: this one is written **against the
same ARIA contract**, with the divergences enumerated explicitly rather than drifting.

---

## Interaction and keyboard

### Keyboard contract (AC-5.3, AC-5.4, AC-5.5)

| Key | Open, `active >= 0` | Open, `active === -1` | Closed |
|---|---|---|---|
| **ArrowDown** | `preventDefault`; `active = min(active + 1, n - 1)` (clamp, no wrap) | `preventDefault`; `active = 0` | `preventDefault` and open **iff** the query qualifies and there is ≥1 match and `!disabled`; then `active = -1`. Otherwise no-op. |
| **ArrowUp** | `preventDefault`; `active = active - 1` (down to `-1`, i.e. back to "nothing highlighted") | `preventDefault`; **no-op** | no-op |
| **Enter** | **`preventDefault()`** → pick (F2). The form MUST NOT submit. | **No `preventDefault`, no state change** — today's implicit submission runs untouched | unchanged |
| **Escape** | `preventDefault`; close, keep text byte-identical, `active = -1`, `suppressed = true` | same | no-op (never swallow Escape when there is no popup) |
| **Home / End** | `preventDefault`; `active = 0` / `n - 1` | same | no-op |
| **Tab** | close, `active = -1`, **never picks**; no `preventDefault` so focus moves on normally | same | — |
| any printable key | via `onChange`: `active = -1`, `suppressed = false` | same | — |

**Initial highlight on open is *nothing* (`active = -1`)** — AC-5.4 requires that a
just-opened list not arm the Enter key. Opening never auto-highlights, in any path
(threshold crossing, corpus arrival, re-focus, ArrowDown-to-open).

**The highlight resets to `-1` on every query change.** After narrowing, the option at
index 2 is a *different trip*; preserving the index would silently re-aim Enter at
something the employee never looked at. Given that km drives money, a wrong-line pick is
the expensive failure here, so the highlight is always deliberately re-established.

### The sharpest trap: Enter must not submit the form

The composer is a `<form>` whose submit adds the line. Getting the Enter branch wrong
fails in a way that is **silent and financially wrong**, so it is worth stating exactly:

> If the draft is already complete (motivo typed, km typed, entity chosen, date defaulted
> to today) and Enter on a highlighted suggestion does **not** call `preventDefault()`,
> the browser fires implicit form submission **in the same event**. React's `setDraft`
> from the pick has not flushed, so `handleSubmit` reads the **pre-pick** draft and posts a
> line with the *old* km and entity under the *new* motivo — a wrong reimbursement amount,
> added with no error and no visible sign that anything went wrong.

Therefore:

- `preventDefault()` is called on **exactly one** branch: `Enter && open && active >= 0`.
- It is **not** called when `active === -1` — that branch must be byte-identical to today
  (AC-5.4), including that the list is not closed by it. If the submit succeeds, the
  composer resets `motivo` to `''`, `queryQualifies` goes false and the list closes as a
  *derived* consequence — no imperative close needed.
- The composer's existing `if (!canAdd) return` guard is a second line of defence, **not**
  the mechanism. It does not protect the complete-draft case above.
- An option is a `<li role="option">`, never a `<button>`. A `<button>` inside a `<form>`
  defaults to `type="submit"` — the same failure by a different route.
- AC-5.3 and AC-5.4 must be tested as a **pair**, both asserting on `onAdd`.

### The re-open trap (a gap in spec and plan — resolved here)

After a pick, `value` holds a complete past motivo, which qualifies (≥2 chars) and matches
itself in the corpus — so the derived `open` would immediately become true again and the
list would pop back up on top of the field it just filled, contradicting AC-3.5's "the
suggestion list closes".

**Resolution:** one `suppressed` flag serves both Escape and pick.

- Set `suppressed = true` on **pick** and on **Escape**.
- Clear it **only** in the input's own `onChange` handler — i.e. only when the *employee*
  types. It must **not** be cleared by a `value` prop change, because the pick itself
  changes `value` and would instantly un-suppress.
- Blur (S10) does **not** set `suppressed`: re-focusing the field re-opens the list, so an
  accidental click-away is recoverable without having to type. AC-5.5 requires only that
  focus-away closes it.

### Pointer and touch

- **Click/tap picks; hover does not highlight.** Each option gets
  `onMouseDown={(e) => e.preventDefault()}` (the `admin-ui` precedent) so the input never
  blurs before the click lands — on touch, the compatibility `mousedown` is cancelable and
  the subsequent `click` still fires, so the option is not unmounted out from under the tap.
- **Deliberate divergence from `admin-ui/Combobox`:** that component sets
  `active = index` on `onMouseEnter`. This one does **not**. An incidental mouse position
  over the list would otherwise silently arm Enter, breaking AC-5.4's guarantee that Enter
  with nothing highlighted behaves exactly as today. Hover gets its own subtle background;
  `aria-activedescendant` tracks the **keyboard** only.
- **Closing on an outside pointer** uses two independent mechanisms, both required:
  `onBlur` on the input guarded by `!wrapperRef.current?.contains(e.relatedTarget)` (so
  moving focus *within* the wrapper never closes), **and** a `document`-level `pointerdown`
  listener, added only while `open`, that closes when the target is outside the wrapper.
  The second exists because a pointerdown on a non-focusable region does not reliably blur
  in jsdom, which is the environment the plan's AC-5.5 test runs in. The listener is
  removed on close and on unmount.
- **Target size:** rows are full-width and ≈54 px tall — comfortably above WCAG 2.2 AA
  2.5.8 (24×24 CSS px).
- **Virtual keyboards:** the popup renders directly beneath the field, above the keyboard
  in the common case. Accepted without further mitigation; the `block: 'nearest'` scroll
  behaviour below keeps the active option reachable.

### Corpus lifecycle (client side)

Owned entirely by `MotivoSuggestField`; `ExpenseLineComposer` never sees it.

- **Lazy:** the fetch is issued only when `enabled && !disabled && queryQualifies(value)`
  first becomes true, and at most once per `corpusEpoch` (plan D6). Selecting `travel_km`
  and changing one's mind costs nothing.
- **Debounce 150 ms** on the fetch only. **Matching is never debounced** — it is a
  synchronous filter over ≤200 in-memory objects, re-run every keystroke (plan D2).
- **Both guards:** a monotonic `requestTokenRef` (the `MileageAmountField` precedent) drops
  stale resolutions, and an `AbortController` releases the socket on unmount, on `enabled`
  going false, and on epoch invalidation. A `setTimeout(5000)` calling `abort()` is the
  "does not answer in reasonable time" of AC-5.2.
- **One `.catch()` swallows everything** and sets the corpus to `[]`. It must not also
  swallow a developer error into a permanently broken silent state — the catch sets state
  and returns; it never wraps render logic (plan Security §5).
- **Memory only.** A component ref/state that dies with the composer. Never
  `localStorage`/`sessionStorage`/IndexedDB (ADR-0041 §4, ADR-0001's posture).
- **Type switched away and back:** the corpus stays in memory (it is already in page
  memory; discarding it buys no privacy and costs a request). Only the in-flight request is
  aborted.
- **`corpusEpoch` bump on a successful add** re-arms the lazy fetch, so the trip just
  claimed is suggestible immediately (AC-2.6's stated benefit).

### Component contract

Extends the plan's `MotivoSuggestFieldProps` with two props the existing input needs and
the plan's list omits:

```ts
type MotivoSuggestFieldProps = {
  id: string          // 'composer-motivo' — also used as data-testid and as the
                      // prefix for '-listbox', '-option-{i}', '-live'
  value: string
  onChange: (motivo: string) => void
  onPick: (s: TripSuggestion) => void
  enabled: boolean    // true only when the composer's expense type is travel_km
  disabled: boolean   // the composer's `submitting`
  required?: boolean  // ADDED — the existing input carries `required`; must be preserved
  corpusEpoch: number
}
```

`data-testid={id}` keeps `composer-motivo` addressable exactly as today. Derived ids:
`composer-motivo-listbox`, `composer-motivo-option-{index}`, `composer-motivo-live`.

---

## After a pick — making the multi-field change perceivable

Three controls change at once and a fourth (the amount) re-derives a beat later. The
employee's attention is on the Motivo field and the list; km and Entity are elsewhere in
the grid. Since a wrong km silently changes money — the spec's own problem statement — the
change must register, not just happen.

**What does the work, using only what already exists:**

1. **One atomic commit.** All three fields are written in a single `setDraft`, so they
   change in one React commit rather than sequentially — no visible cascade.
2. **The list closing is itself the acknowledgement.** The popup that was covering the area
   disappears at the same instant the fields fill, revealing them.
3. **`MileageAmountField`'s existing live-derivation language.** "Calculating…" → the new
   `62 km × 0.72 CHF/km = 44.64 CHF` breakdown, in the same grid, is the app's established
   vocabulary for "a value just re-derived". It is the most legible confirmation available
   and it costs nothing to obtain (AC-3.5).
4. **The caret is placed at the end of the inserted motivo**, so the field visibly settles
   into an edited state and further typing appends.
5. **The composer's existing polite status line** (`<p aria-live="polite"
   data-testid="composer-km-status" className="sr-only">`) carries the announcement for
   non-visual users, for whom devices 1–4 are otherwise entirely silent:
   *"Filled from a past trip: Milano → Lugano cliente ACME, 62 km, WellD CH. The date is
   unchanged."* Naming the untouched date is deliberate — it is the one field a picker might
   assume was filled (AC-3.2). Reusing the existing region rather than adding a second
   polite region avoids two live regions in one form competing. No collision is possible: a
   pick never changes the expense type, so it never races the km-field-added/removed
   message. Its `data-testid` is unchanged so specs/009's tests keep passing.

**Explicitly not designed** (see "Scope, drift and open concerns"): a visible transient
"Filled from a past trip" caption, and any flash/ring animation on the km and Entity
controls. Both are motion or chrome that **no AC asks for**.

**Still fully editable (AC-3.6), structurally.** The pick writes three plain draft strings
and nothing else. No `readOnly`, no `disabled`, no "picked" marker is stored anywhere — the
component does not retain the picked suggestion at all, so there is no state that *could*
lock the fields. **Nothing is saved (AC-3.7):** `onPick` never calls `onAdd`, never issues
a request; the line exists only after the employee presses "+ Add expense line".

---

## Accessibility

Target: WCAG 2.2 AA, WAI-ARIA 1.2 **combobox with listbox popup**. The contract below is
literal enough to implement and to test without interpretation (AC-5.6).

### Roles and ARIA — when `enabled`

On the `<input type="text">` (the same element as today):

| Attribute | Value |
|---|---|
| `role` | `"combobox"` |
| `aria-expanded` | `open` (boolean, always rendered) |
| `aria-controls` | `"composer-motivo-listbox"` |
| `aria-autocomplete` | `"list"` |
| `aria-activedescendant` | the active option's id, or **omitted** when `active === -1` |
| `autoComplete` | `"off"` — suppresses the browser's native history dropdown competing with ours |
| `required` | preserved from today |

`aria-haspopup` is omitted — it is implicit for `role="combobox"`.

On the popup: `<ul role="listbox" id="composer-motivo-listbox" aria-label={…listboxLabel}>`.
Each option: `<li role="option" id="composer-motivo-option-{index}" aria-selected={index === active}>`.

### Roles and ARIA — when `!enabled` (AC-1.1)

**None of the above is rendered.** No `role`, no `aria-*`, and no `autoComplete="off"` —
the last one specifically so the other eleven expense types keep today's native
browser-history behaviour byte-for-byte. The `<div className="relative">` wrapper and the
`<input>` are rendered in both branches as **one JSX node**, so React preserves the DOM
node, its focus, its caret position and any IME composition across an expense-type change.

### Option accessible name

Each `<li role="option">` carries an explicit `aria-label` built from one strings function,
rather than relying on its content:

> `"Milano → Lugano cliente ACME, 62 km, WellD CH, used 14 times, last used 28 Jul 2026"`

Rationale: content-derived naming would concatenate the layout ("62 km WellD CH Used 14× ·
last 28 Jul 2026"), and `×` and `·` are read inconsistently across screen readers. An
explicit label makes AC-1.7's "all five facts are exposed" a **single assertion** for QE,
and it is immune to the CSS truncation on line 1 — the full motivo is always announced even
when it is visually ellipsised. The trade-off (label and visible text must be kept in step)
is handled by both coming from `strings.ts` and being asserted in the same component test.

### Live region

- One **always-mounted** `<p id="composer-motivo-live" aria-live="polite" class="sr-only">`
  inside the wrapper. It must never be conditionally rendered — a region mounted at the
  same time as its content is not reliably announced.
- Content: `strings.components.motivoSuggest.available(n)` when `open && n >= 1` →
  *"8 suggestions available"* / *"1 suggestion available"*.
- **Empty string in every other state** — including no-match, corpus-failed and
  below-threshold. An announcement of "no suggestions" would be exactly the empty-state
  message AC-1.6 forbids, in the audio channel. This mirrors `admin-ui/Combobox`'s own
  documented `liveRegionText=''` escape ("never used for a state the caller wants to stay
  silent about").
- It announces the **count only, never the option text** — `aria-activedescendant` already
  makes the screen reader announce the active option, and duplicating it is the classic
  double-announcement bug.
- Because it is `polite`, rapid count changes while typing yield to the typing echo.

### Focus management

- **DOM focus never leaves the `<input>`** — not on ArrowDown, not on hover, not on click,
  not on pick. The highlight moves via `aria-activedescendant` only. This is what makes
  "keep typing while the list is open" work at all.
- After a pick, focus is explicitly returned/kept on the input and the caret set to the end
  of the inserted text.
- The list is **never** in the tab order: `<ul>` and `<li>` carry no `tabIndex`. Tab from
  the Motivo field goes to the next form control, closing the list without selecting.
- **Focus visibility (2.4.7/2.4.11)** is carried by the input's own focus ring, which never
  moves. The active-option accent tint + left bar is a *supplementary* highlight, not the
  focus indicator.
- **Scroll-into-view:** `aria-activedescendant` does **not** scroll the popup. When `active`
  changes via the keyboard the component must call
  `optionEl.scrollIntoView({ block: 'nearest' })`, or ArrowDown past the 5th visible row
  moves an invisible highlight. (Noted as an observation only: `admin-ui/Combobox` appears
  to have the same latent gap; fixing it there is out of scope for this feature.)

### Other

- **Colour is never the only signal.** The active option pairs the `--acc-lo` tint with a
  `--acc` left bar; `EntityBadge` already pairs colour with glyph+text.
- **Contrast** is specified and verified in the Visual specification above (metadata at
  4.97:1 dark / 4.88:1 light).
- **A11y hotspot, pre-existing and out of scope:** `var(--muted)` — used today for
  `composer-km-help` and elsewhere in `refund-ui` — measures ≈2.6–2.7:1 on `--ink-soft`
  and `--ink-mid`, below AA. This feature introduces **no** new `--muted` text (it uses
  `--soft`), but the debt is recorded here rather than silently propagated.
- **No motion** is introduced, so there is nothing to gate on `prefers-reduced-motion`.
- **Keyboard-only operability (2.1.1) end to end:** open → navigate → pick → edit → add is
  achievable with Tab, arrows, Enter and Escape alone, with no keyboard trap (2.1.2) —
  Escape and Tab both always release the popup.

---

## Copy — every new string, with its key path

Namespace `components.motivoSuggest` (plan's choice), plus one key on the existing composer
namespace. English, under `strings.ts`'s existing namespaced key-path convention, typed by
the exported `Strings` type (AC-5.7 as amended 2026-08-11). **No user-facing string
literal appears inline in any component this feature touches.**

```ts
// refund-ui/src/strings.ts — inside `en.components`
motivoSuggest: {
  /** Accessible name of the suggestion popup (AC-5.6). */
  listboxLabel: 'Past trips matching what you typed',

  /**
   * sr-only polite announcement of the available count (AC-5.6).
   * Called ONLY when count >= 1 — every other state announces '' (AC-1.6).
   */
  available: (count: number) =>
    `${count} suggestion${count === 1 ? '' : 's'} available`,

  /** Visible distance on a suggestion row (AC-1.7). */
  km: (km: number) => `${km} km`,

  /**
   * Visible ranking rationale on a suggestion row — AC-2.3's two signals,
   * in ranking order (AC-1.7).
   */
  usage: (count: number, lastUsed: string) =>
    `Used ${count}× · last ${lastUsed}`,

  /**
   * The option's explicit accessible name — all five AC-1.7 facts, in a form
   * that reads correctly aloud (no '×'/'·' glyphs).
   */
  optionLabel: (motivo: string, km: number, entity: string, count: number, lastUsed: string) =>
    `${motivo}, ${km} km, ${entity}, used ${count} ${count === 1 ? 'time' : 'times'}, last used ${lastUsed}`,
},
```

```ts
// refund-ui/src/strings.ts — inside `en.pages.requestDetail.composer`
/**
 * Announced on the composer's existing polite status line after a pick
 * (AC-3.1/3.2/5.6). Naming the untouched date is deliberate.
 */
suggestionApplied: (motivo: string, km: number, entity: string) =>
  `Filled from a past trip: ${motivo}, ${km} km, ${entity}. The date is unchanged.`,
```

**Six new keys total.** Entity labels come from the existing `strings.badges.entity` via
`EntityBadge` (and are passed into `optionLabel`/`suggestionApplied` by the caller, never
re-spelt). Dates come from `formatDate`.

**No empty-state, error, retry, loading or "no results" string exists — by design.** Adding
one is a spec violation (AC-1.6, AC-5.2), not an oversight, and the QE check for AC-1.6/5.2
should assert the *absence* of any such node.

---

## Responsive and overflow

The composer's grid is `repeat(auto-fit, minmax(160px, 1fr))` with a 12 px gap, inside a
`<form className="… p-4">` on `RequestDetailPage`. No ancestor sets `overflow: hidden` or a
`transform` (verified), so an absolutely-positioned popup is neither clipped nor
containing-block-shifted.

| Concern | Design |
|---|---|
| **Popup width** | `left: 0; top: 100%; width: max(100%, 20rem); max-width: calc(100vw - 1.5rem)`. |
| **Wide viewport** | `auto-fit` yields 4–6 columns, so the Motivo cell is ~165 px and the 20 rem popup overhangs to the right — into the page's own side gutter, which exists precisely because the viewport is wide. No horizontal page scroll. |
| **Narrow viewport (<~480 px)** | `auto-fit` collapses to a single column, the Motivo cell is full width, and `max(100%, 20rem)` resolves to 100% — the popup matches the field exactly, no overhang, no scroll. |
| **The risk self-cancels** | The only configuration that produces overhang is the only one with gutter space to absorb it. **Named fallback if visual review disagrees:** flip the anchor to `right: 0` when the field sits in the grid's last column. Not built — it needs `getBoundingClientRect` measurement, which is disproportionate to the risk. |
| **Popup height** | `max-height: min(18rem, 50vh); overflow-y: auto; overscroll-behavior: contain`. At ~54 px per row that is ~5 of the maximum 8 options visible, the rest scrolled. `overscroll-behavior: contain` stops a wheel/trackpad scroll at the list's end from chaining to the page. |
| **Keyboard + scroll** | `scrollIntoView({ block: 'nearest' })` on every `active` change (see Accessibility). |
| **Long motivo** | Single-line ellipsis + `title` attribute; full text always in the `aria-label`. |
| **Stacking** | `z-10` on the popup, matching `admin-ui/Combobox`. The composer contains no other positioned/stacked element, and the popup is a sibling of the grid cells, not of a modal. |
| **Layout shift** | None — the popup is `absolute`, so its appearance never moves the km/Entity/Amount controls. |

---

## Scope, drift and open concerns

Flagged rather than silently designed around, per the drift rule. **None of these blocks
task derivation.**

1. **Plan gap — the re-open-after-pick trap.** Neither spec nor plan says what stops the
   list re-opening on the motivo a pick just wrote (`plan.md`'s keyboard section clears
   `dismissed` on "the next value change", which the pick itself triggers). Resolved above
   by extending `suppressed` to picks and clearing it **only** from the input's own
   `onChange`. Tasks must carry this or AC-3.5 fails in a way that is obvious in a browser
   but easy to miss in a unit test that asserts only on the draft values.
2. **Deliberate divergence from `admin-ui/Combobox` — arrow semantics.** `admin-ui` wraps
   (`% options.length`) and ArrowUp from nothing jumps to the last option. `plan.md`'s table
   specifies clamping and ArrowUp-from-nothing as a no-op. This design follows the **plan**
   (approved, and QE will test against it). Consequence: the suite now has two comboboxes
   with different arrow semantics. Low severity, worth a decision at some point — not
   worth reopening an approved plan for.
3. **Deliberate divergence from `admin-ui/Combobox` — hover does not set the highlight.**
   Justified by AC-5.4, which `admin-ui`'s component never had to satisfy: an incidental
   mouse position must not silently arm Enter. Testable, documented, intentional.
4. **Plan's prop list is missing `required`.** The existing `composer-motivo` input carries
   `required`; `MotivoSuggestFieldProps` as written in `plan.md` cannot express it. Added
   above. Purely additive.
5. **Scope creep considered and NOT designed (two items).**
   (a) A **visible** "Filled from a past trip — check the distance" caption under Motivo
   after a pick. It would strengthen the perceivability of the multi-field change for
   sighted users, but no AC asks for it and it is new persistent chrome. Recorded as a PO
   decision, not a designer one. The sr-only announcement **is** designed, because AC-5.6
   makes non-visual perceivability a requirement rather than an enhancement.
   (b) Making the Motivo grid cell full-width (`grid-column: 1 / -1`) to give the popup
   room. Rejected: it would change the composer's layout for all twelve expense types, and
   the brief is to layer a combobox onto the existing input, not restructure the form.
6. **Matched-substring highlighting stays out** (plan D9). If it is ever revisited, the
   binding constraint is recorded in "The suggestion row": React text children only, never
   `dangerouslySetInnerHTML`.
7. **`formatDate` on a date-only value** renders in the viewer's local timezone, so a
   negative-UTC-offset viewer would see the previous day for `lastUsedOn`. Pre-existing
   app-wide behaviour (`appliedRate.validFrom` already does this), wellD is Europe-only.
   Accepted, not fixed here.
8. **`var(--muted)` contrast debt** (≈2.6:1) exists today in this very composer
   (`composer-km-help`). This feature does not add to it — new copy uses `var(--soft)`
   (4.9:1). Recorded as an observation for a future a11y pass, not as this feature's work.
9. **`aria-label` on options overrides visible content.** A known, accepted trade-off: it
   buys an unambiguous, testable five-fact announcement immune to CSS truncation, at the
   cost of a sync obligation between two strings that both live in `strings.ts` and are
   asserted in the same test.
