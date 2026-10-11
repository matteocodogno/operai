# @operai/refund-ui

## 0.1.0

### Minor Changes

- 6338f88: Filing the same trip twice no longer means typing it twice: while composing a
  "Travel by car" line, the Motivo field now suggests trips the employee has
  already claimed in the last 24 months, and picking one (by mouse or keyboard)
  fills in the motivo, the distance and the entity in a single step, with the
  amount recomputed from the current rate. Suggestions are drawn only from the
  employee's own past lines, served by a new self-scoped `GET /line-suggestions`
  on refund-api; if that call fails, Motivo quietly stays an ordinary text field.
- fb42218: An approved expense request can now be exported as a single archive PDF —
  every expense line with its mileage-rate provenance, plus every receipt
  embedded in full. A PDF receipt is copied page-for-page; a JPEG or PNG is
  embedded as an image. An "Export PDF" button appears on an approved request
  for its owner and for accounting reviewers.

  This is the first time refund-api reads attachment bytes at all (ADR-0043).
  Receipts were previously reachable only through presigned URLs the browser
  followed itself, which is still how receipt downloads work — but an archive
  cannot embed a file it may not read. The exposure is bounded: a request whose
  receipts exceed the export budget is refused with a clear message rather than
  archived incompletely, and a receipt that cannot be embedded fails the whole
  export instead of producing a PDF with a silent gap in it. An archive that
  looks complete but isn't is worse than one that refuses to build.

  Drafts, submitted and rejected requests are not exportable — their figures are
  not yet final. Paid requests are, since paying one does not make it less
  worth archiving.

### Patch Changes

- 23d6ffd: Amounts are now a right-aligned column instead of values inside sentences.

  Each figure previously sat inline after its label, in a row it shared with the
  applied-rate detail, so its horizontal position moved with the length of
  whatever preceded it and no two rows lined up. The money now sits in a fixed
  right-hand column with tabular numerals, on the lines and on the totals card
  alike, so the column can be read straight down and checked against the total.

  An adjusted amount keeps its approved figure in the column and hangs the
  "requested 180,00 · −26,00" note underneath, rather than appending a
  parenthetical that would push every figure to a different position. The
  applied-rate provenance stays on the descriptive side — it explains how an
  amount was reached, it is not a figure anyone sums.

- 2b11a53: Status, entity and currency badges keep their label on one line instead of wrapping inside a
  narrow table column.
- 3089321: The batch detail screen no longer prints "Paid on … by [object Object]" — the
  paid and discarded stamp lines now name the person who closed the batch out.
  The batch id chip is relabelled "Batch reference" and explains, on hover, that
  it's the value quoted in the accounting email and on the compiled PDF.
- d733c7b: The CHF currency chip no longer reads "CHF CHF".

  `CurrencyBadge` renders a decorative symbol next to the ISO code, but the
  Swiss franc has no single-character sign in common use, so its symbol slot was
  filled with the literal string `CHF` — printing the code twice wherever the
  chip appears: the request page's per-currency subtotal cards, expense line
  rows, batch subtotals, and the mileage amount field. The symbol is now
  optional, and CHF renders its code once. EUR, USD and GBP are unchanged.

- ea73b72: The "Export PDF" control on an approved request now sits in the header row,
  right-aligned beside the title, instead of floating between the totals card
  and the expense-line list. It acts on the whole request, so it belongs next to
  the request's title rather than wedged between two body sections that it
  doesn't belong to either of.
- 926c7d9: The currency and entity chips are now neutral, so green means one thing again.

  Green was doing three jobs at once on a single expense row: marking the
  approved amount (where it carries a decision), and colouring the CHF chip and
  the WellD CH chip (where it carries nothing). A reader had to learn which of
  the three greens mattered. The currency chip also spent three more
  meaning-bearing colours — accent, orange, red — on EUR, USD and GBP.

  Both chips now render in one neutral tone. Nothing is lost: the ISO code and
  the flag-plus-entity-name were always what told the variants apart, and the
  suite's own chip convention already pairs several kinds with a single colour,
  distinguished by glyph and text. Green is left to mean "approved", and the
  accent to mean "interactive".

- cee00a3: The monthly-processing note is now a footnote rather than a banner.

  It was a bordered, accent-tinted panel with its own accent heading, sitting at
  the bottom of every approved request — the loudest element on the page, while
  saying the same standing sentence forever and asking nothing of the reader. It
  now reads as muted body text directly under the totals, which is where it
  belongs: it answers "when does this figure get paid", so it is a footnote to
  the total rather than an announcement of its own. Its "Monthly processing"
  heading is gone; at body weight the sentence introduces itself.

  The copy is untouched, so specs/007's AC-4.1 still holds — it requires the UI
  to state the monthly cadence, not to shout it.

- 7f29ff7: The request archive PDF now reads like a document rather than a data dump.

  Raw database values no longer reach the page: expense types, entities and the
  status render as the same words the UI shows ("Travel — mileage (km)",
  "WellD CH", "Approved"), sourced from a canonical label table both packages
  assert against so the PDF and the screen can never disagree.

  One locale throughout. Amounts, the mileage rate and every date now share a
  single convention (206,50 CHF · 0,70 CHF/km · 31.01.2021) instead of mixing
  comma decimals, dot decimals and ISO dates on one page, and the currency now
  follows the amount as it does on screen. Timestamps are civil time in the
  document's timezone with the zone named — 08.09.2026 08:45 (CEST) — rather
  than raw ISO with milliseconds in UTC, which could file an evening export
  under the wrong day.

  The document also answers the first question a recipient asks: whether it
  represents a liability or a settled one. A settlement line states "not yet
  included in a monthly batch", "included in batch 2026-09 — compiled, not yet
  paid", or "Paid on … — batch 2026-09". The header names the period and legal
  entity, every page carries the reference and a page number, and receipts are
  stated once rather than per line and again at the end.

  Downloads are named refund*2026-08_camerini_CHF-206.50*<id>.pdf instead of
  refund-request-<cuid>.pdf — sortable in a folder and quotable over the phone.

- 2b11a53: The "New request" button now uses the suite's shared primary button style, so it has the same
  rounded corners as the other primary buttons.
- c0b6b5b: Dates now render as `11.08.2026` everywhere in the Refund tool.

  A single screen could previously show two formats at once: expense-line dates
  printed the raw ISO `2026-08-11`, while the applied mileage rate's validity
  went through the browser's locale and came out as `Jan 31, 2021`. Neither
  reads naturally in Switzerland or Italy, so both are replaced by the numeric
  `DD.MM.YYYY` used in both markets, and timestamps by `DD.MM.YYYY, HH:mm` on a
  24-hour clock.

  The format is fixed rather than locale-derived. These are dates on a shared
  financial record — an employee in Italy and an accountant in Switzerland
  discussing the same expense line should be reading the same characters — and
  pinning it also makes screenshots and tests deterministic.

  A latent off-by-one is fixed along the way: a date with no time component is
  now formatted from its own characters instead of being parsed as UTC midnight,
  which would have shown the previous day to any viewer west of UTC.

- 42e5f0d: The review detail now states a request's status instead of implying it.

  An approved request said so nowhere: you could only tell from the absence of
  the Approve and Reject buttons and the presence of the monthly-processing
  note. Absence is not a signal. The page now carries a status badge beside its
  title — agreeing with the badge the queue already shows on every row — and a
  decision stamp naming who decided the request and when: "Approved on
  22.08.2026 by chiara.rossi@welld.ch".

  Rejected requests get the same stamp. Their motivation block already said
  _why_, never _who_ or _when_. A paid request shows both its approval stamp and
  its existing payout line, since those are two events by two different people
  and neither stands in for the other.

- 3aecb6f: An approved amount is now shown once, unless accounting changed it.

  The line rows and the totals card both printed "Requested X / Approved X"
  unconditionally, so a typical request showed six numbers for three distinct
  values and the reader had to compare each pair to find the one that differed.
  An unadjusted amount now shows a single figure; an adjusted one reads
  "154,00 CHF (requested 180,00, −26,00)", which is the fact a review screen is
  scanned for.

  Only the presentation changes — both values remain on the wire and in the API
  contract — and the rule lives in one shared helper, so a line and its totals
  card can never disagree about whether an amount moved. specs/007's AC-3.2 is
  amended to match: its stated purpose ("see exactly where, if anywhere, an
  amount was adjusted") is what motivated the change; showing both figures
  everywhere worked against it.

## 0.0.1

### Patch Changes

- 6a13795: The shell footer/About dialog was showing `@operai/shell`'s own package
  version (`0.0.0`) instead of the Operai suite's umbrella version — the two
  are different numbers, and only the umbrella one is meaningful to a user.
  The footer now reads the umbrella version from a committed, generated file
  (`shell/src/lib/suiteVersion.generated.json`, kept in sync by
  `scripts/version.mjs` at release time) instead of `shell`'s own
  `package.json`.

  The About dialog additionally gains a "Components" section listing each
  mounted remote's own version (EstimAI, Refund, Admin, Notify), each exposed
  via a small new federated `./version` module. A remote whose version can't be
  resolved — unreachable, cold-starting, or (going forward, since every app
  deploys independently) simply predating this change — degrades to a muted
  "—" rather than blocking the dialog or throwing.

- 98adacd: Surface the real cause when a receipt upload fails instead of collapsing every
  failure into "Upload failed. Try again.". An opaque `fetch` rejection (the
  signature of a storage bucket missing its CORS rule) now reads differently from
  an API Problem response, and the raw error is logged to the console.
