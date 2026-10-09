# Operai design system

The suite's shared visual rules. The tokens and classes live in one stylesheet,
`shell/src/styles/tokens.css`, which the shell loads and every remote receives
(ADR-0006). There is no shared React component library: a remote writes its own
markup and uses the classes below.

This page covers what is standardised today. Anything not listed here is not
yet standardised; add it here, and to `tokens.css`, before using it in a second
app.

## Tokens

Colours, fonts and the light theme are defined in `tokens.css`. Use the custom
properties (`var(--text)`, `var(--acc)`) or the Tailwind utilities generated
from them (`text-text`, `bg-ink-mid`). Never write a hex value in a component.

| Token | Use |
|---|---|
| `--ink`, `--ink-soft`, `--ink-mid` | page, panel and control backgrounds |
| `--rule`, `--dim` | dividers and control borders |
| `--text`, `--soft`, `--muted` | primary, secondary and tertiary text |
| `--acc`, `--acc-hi`, `--acc-lo` | accent for text, links, focus rings and tints |
| `--acc-solid`, `--acc-solid-hi` | accent as a filled background under white text |
| `--grn`, `--org`, `--red` | success, warning, error |

`--acc` under white text is 4.3:1, below WCAG AA for small text. A filled accent
surface uses `--acc-solid` (5.0:1).

## Form controls

`input` and `select` get their base look (background, border, radius, focus
ring) from `tokens.css` with no class needed.

A single-line `<select>` draws the suite's own chevron, 10px from the right
edge, with 30px of right padding reserved for it. The rule is unlayered, so
padding utilities on the element do not move it. Two things break it:

- an inline `background:` shorthand on the select erases the chevron; set
  `backgroundColor` instead;
- do not add a chevron icon of your own next to a select.

A checkbox or radio is a 16px control drawn by `tokens.css`: outlined when
empty, filled with the solid accent and a white mark when checked (a dash for
an indeterminate checkbox). Use the plain `<input type="checkbox">` with a
`<label>`; no class is needed and padding or border utilities have no effect
on it. Margin utilities do.

## Cards

A card groups related content on a page: one section of a detail screen, a
filter bar, a composer.

```tsx
<section aria-labelledby="facts-heading" className="card">
  <h3 id="facts-heading" className="card-title">Details</h3>
  …
</section>
```

- `card` is a bordered, rounded panel on `--ink-soft`; `card-title` is its
  heading. Controls inside a card sit on `--ink`.
- A detail page is a column of cards, one per subject (details, invoice,
  ledger, history). Do not leave sections as bare headings on the page
  background.
- A card's own action goes in its title row, on the right, as a
  `btn-secondary btn-sm`. Page-level actions stay in the page header.
- Label and value pairs use a `<dl>` on an auto-filling grid
  (`repeat(auto-fill, minmax(170px, 1fr))`), not two wide columns.
- Do not nest cards.

## Buttons

Every button is `.btn` plus exactly one variant. The classes work the same on
`<button>`, `<a>` and a router `<Link>`.

```tsx
<button type="button" className="btn btn-primary">Register asset</button>
<Link to="/assets/new" className="btn btn-primary">Register asset</Link>
<button type="button" className="btn btn-ghost btn-sm">Cancel</button>
```

### Variants

| Class | Looks like | Use for |
|---|---|---|
| `btn-primary` | filled accent, white label | the one main action of a screen, dialog or card |
| `btn-secondary` | outlined, neutral | any other action that should read as a button |
| `btn-ghost` | no border, no fill | cancel, close, low-emphasis toolbar actions |
| `btn-danger` | red border and tint | destructive or irreversible actions |

### Modifiers

| Class | Effect |
|---|---|
| `btn-sm` | compact size, for table rows, banners and dense toolbars |
| `btn-icon` | 28px square for an icon-only button; it must have an `aria-label` |

### Rules

1. **One primary per view.** A screen, a dialog or a card has at most one
   `btn-primary`. If two actions compete, one of them is `btn-secondary`.
2. **Choose by meaning, not by colour.** Confirming something irreversible is
   `btn-danger` even when it is also the dialog's main action. A retry in a
   warning banner is `btn-secondary`, not an orange button.
3. **Do not restyle.** No colour, border or radius from utilities or inline
   styles on a `.btn`. Layout utilities are fine (`mt-3`, `self-start`,
   `w-full`). If a case does not fit, add a variant to `tokens.css` and to this
   page.
4. **A link that navigates stays a link.** Use `.btn` on a `<Link>` only when it
   is an action entry point ("Register asset"). Inline navigation ("Back to
   assets", a name in a table) is an underlined text link, not a button.
5. **Disabled states.** Use `disabled` when the control should leave the tab
   order. Use `aria-disabled="true"` when the user needs to reach it to learn
   why it is unavailable; the handler must then ignore the click. Both look the
   same.
6. **Busy states.** Set `aria-busy="true"` while the action runs and keep the
   label readable ("Saving…"). Do not swap the button for a spinner alone.
7. **Labels.** Sentence case, a verb first ("Register asset", "Close year").
   The text comes from the app's strings module, never a literal.

### Migration status

| App | Status |
|---|---|
| `inventory-ui` | migrated |
| `shell`, `estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui` | not migrated; they still style buttons one by one |

New code in any app uses the classes. Existing buttons are migrated app by app.
