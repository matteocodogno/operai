# 20261117 — A layout draws the configurator's "missing" mark through a runtime patch of one line of its pinned template (the label only in the drawing, the `⟦ ⟧` only in the page's text), and a layout that cannot be marked is refused the mode, not drawn without the look

**Date:** 2026-11-17  
**Status:** Accepted — owner-approved plan of specs/20261117-legal-entities (approved 2026-11-17): AC-5.4 (an empty value is shown in the configurator as its label in the `missing` look, with its conditional segment kept), plan E3 and design decision DR-4 (the look is words, glyphs and colour, never colour alone). Follow-up FU-5 of tasks.md (raised at T20), recorded as plan ADR candidate 8 by the amendment "after security review" (approved 2026-11-17). The defect D2 (a label that wraps) refined the text side.  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

The letterhead configurator preview now shows the registry's real details (ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds). When a detail is empty, a document prints nothing and drops a conditional segment around it (letterhead AC-6.4, AC-6.6). The designer who builds a letterhead must instead see what is not filled in, so in the preview only, an empty placeholder is drawn as its label (a closed list in `it` and `en`: Ragione sociale, Indirizzo, Partita IVA, IBAN, Riga contatti / Legal name, Address, VAT number, IBAN, Contacts line) in a `missing` look, and the segment stays (AC-5.4). The look must have a text alternative (DR-4, plan E3): the preview's page text holds `⟦Label⟧`.

Three constraints meet:

- A letterhead version pins its layout, template included, and a document made later must give the same pages (ADR 20261116-a-letterhead-version-pins-its-layout-and-old-layouts-stay-compiled-in; golden corpus in CI). Editing layout 1's `main.typ` for the preview would change the bytes of the template that every saved version uses. T20's done-when says the full golden corpus is byte-identical, and plan E3 says the non-marking output stays byte-identical.
- No bundled font has `⟦` or `⟧` (U+27E6, U+27E7). A drawing that includes them would draw a missing glyph, and the engine counts unprintable characters (`unprintable_characters`).
- The preview's picture and its text come from the same compile (ADR 20261116-the-preview-is-the-pdfs-own-compile-as-palette-png-pages-and-the-crm-wizard-reaches-it-through-crm-api), so the mark is drawn by Typst, not added by the browser.

## Decision

We will draw the mark by patching one line of the layout's template in memory, only when the preview asks for "mark missing": the engine replaces the single line that draws a frame line (`MARKING_FROM`, `par(safe(s, zone-width, c => c))` in layout 1) with a version that draws each part in its own look and puts a part that stands for a missing value (`"m": true`) in the missing look, building a second compiled state beside the normal one. The drawing holds the bare label; the page's text (not the drawing) adds `⟦` and `⟧` around each label drawn in the mark's ink. If a layout's template does not contain that line exactly once, it has no marking state and the mode is refused with an internal error, never silently drawn unmarked.

(`letterhead-api/engine/src/layout/mod.rs` (`MARKING_FROM`, `MARKING_TO`, `Layout::marking`), `resolve/mod.rs` (`Part::Missing`), `layout/frame/mod.rs` (`{ "t": label, "m": true }`), `output/text.rs` (`page_text_marking`, `MARK_INK`), `render.rs` (`RenderOptions::mark_missing`); tasks T20, T23, D2.)

1. **Only the preview sets the mode.** `RenderOptions::mark_missing` is set by the supervisor's preview job; `Job::encode` refuses `mark_missing` for any output but a preview (`DecodeError`), so no `/v1/render/*` job can carry it (T23's wire test). A document never carries `⟦ ⟧` unless its own text does, and letterhead AC-1.3 (preview text = PDF text for one request) holds for every render route.
2. **The patch is a string replacement on the pinned template.** `Layout::marking` builds the second `Shared` state lazily (`OnceLock`) from `template.replace(MARKING_FROM, MARKING_TO)`, only when `matches(MARKING_FROM).count() == 1`. Layout 1's `main.typ` is not edited (its history has one commit, the service's), and the normal path never reads the patched state.
3. **What the patched line draws.** Each part of the line is a run in the line's own look; a part marked `"m"` is wrapped in a highlight (`fill ffe58a`, edges tuned to the line) with the text in the ink `3a2a00` (`--paper-mark` and `--paper-mark-ink` of the design system), so the mark is words (the label), glyphs (the highlight box and the label's own text) and colour. The text is the same text; the highlight adds a box and no glyph.
4. **The label is data from the resolver, not from the template.** `resolve` produces `Part::Missing(label)` for an empty placeholder in marking mode and keeps the conditional segment around it; the placeholder is still listed in `missingPlaceholders`. The closed label list lives in the engine (`label`), in both languages.
5. **The brackets are the text alternative and live in the text only.** `page_text_marking` reads the page's text runs and, for each run or run of a broken line whose fill is the mark's ink and that together say one of the closed labels, inserts `⟦` before and `⟧` after. A run that is whitespace in the mark's ink is part of the label being read (a label that wraps onto a second line keeps its brackets, in both languages: defect D2, `a_missing_label_that_wraps_keeps_its_brackets_in_both_languages`). A user's own `⟦ ⟧` and a run in another ink are not touched.
6. **What a layout 2 must provide.** A layout is a template, a Typst version and fonts (ADR 20261116-a-letterhead-version-pins-its-layout-and-old-layouts-stay-compiled-in). A layout that the configurator preview can show must be markable, so it must provide: a frame-line draw that the engine can patch (today the engine knows one patch, `MARKING_FROM` to `MARKING_TO`, so the template must contain that line exactly once; how a layout 2 whose line differs supplies its own is not decided here and is for that layout's ADR); a patched line that reads the same `parts` data (`t`, `m`, `pg`), draws a missing part in the ink `3a2a00` over a `ffe58a` highlight (the page text finds the label by that ink), draws the bare label and never `⟦ ⟧`, breaks a label like any text, and leaves normal output untouched; and its own tests of the same cases as layout 1's (`frame/tests.rs`: an empty IBAN is drawn and read as its label and its segment stays; a wrapped label keeps its brackets; adjacent labels are marked one by one; a user's own marks are not; unprintable characters 0). Until it does, `Layout::marking` is `None` and the preview of a configuration on that layout fails visibly with `LayoutError::Internal { detail: "mark missing" }`, rather than showing a preview that looks complete.

## Failure shape

**A preview that is supposed to show what the real output hides draws something different from what the real output would draw, without anyone seeing the difference, or a debugging aid changes the output it is meant to help with.** Here the two ways to fail are: the aid alters real documents (an edit of a pinned template, a flag that leaks into a render route, a glyph the fonts lack) or the aid silently disappears when the template changes (the patch no longer applies and the preview draws no mark, so an empty value looks like a deliberate omission). Both are silent: the PDF is plausible, the preview is plausible.

Where else this shape can appear, including the mirror-image positions:

- **Preview and document.** Any mode that exists only for one output (a draft watermark, a debug overlay, a test highlight, a redaction marker) must be unable to reach the other output: set by one route, refused by the other at the wire, with a test that the other never carries it. The mirror: the document's behaviour must not depend on the preview's state (the same compile path, not a second implementation).
- **Patch and patched.** A string-replace patch of a pinned artefact is only as good as its anchor: it must apply exactly once and fail loudly when it does not (zero matches: a layout that no longer draws; two: an ambiguous patch). Recognise it by any code that edits text it does not own.
- **Drawing and text alternative.** A visual cue needs a text cue, and the two live in different layers (the drawing cannot hold a glyph its fonts lack); keep each in the layer that can carry it, and keep the link between them (here the ink) explicit and tested. The same applies to any new cue (an error underline, a diff colour).
- **Read and write of a closed list.** The labels are a closed list in two languages: a third language or a new placeholder needs the list, the drawing, the text matcher and the tests extended together, or a label is drawn and not bracketed.
- **Old layout and new layout.** A newer layout inherits every cross-cutting feature of the engine only if it provides it (marking, overflow detection, the fit check); a feature added to the engine around layout 1 must be listed here or in the layout's contract, or layout 2 will lack it and nobody will have said so.
- **Colour alone.** A cue in colour only (DR-4) fails for people who cannot see it and for the text alternative; pair it with words and glyphs.

## Options considered

### Option A — Runtime one-line patch of the pinned template, label in the drawing, brackets in the text, a layout without the line refused (chosen)

Described above.

**Pros:**
- Layout 1's template and the golden corpus are untouched; real documents are byte-identical
- The preview is drawn by the same compile as the PDF with one line replaced
- Nothing is typeset that no font holds
- A missing anchor fails loudly

**Cons:**
- A string replacement is coupled to the template's wording: a change of that line in a layout breaks marking for it (caught: the mode is refused, and a test covers layout 1)
- The page text and the drawing differ in this mode only (`⟦ ⟧` appear in the text, not the glyphs), and the link between them is an ink colour
- A layout 2 must provide the same, or extend the engine; this is a cost on every new layout

### Option B — Edit layout 1's `main.typ` to carry the marking mode (rejected)

**Pros:**
- No patch step; one template

**Cons:**
- Changes the bytes of the template pinned by every saved version and puts a preview-only branch in every document's code path; against ADR 20261116-a-letterhead-version-pins-its-layout-and-old-layouts-stay-compiled-in

### Option C — Put `⟦` and `⟧` in the drawing (rejected)

**Pros:**
- The drawing and the text agree

**Cons:**
- No bundled font has the two glyphs; the page would hold unprintable characters and draw a fallback or a missing glyph

### Option D — Draw the mark in the browser over the preview image (rejected)

**Pros:**
- No engine change

**Cons:**
- The browser does not know where the label is on the page, nor how it wraps; the text alternative would have no source, and the preview would no longer be the PDF's own compile

### Option E — A separate layout for the preview (rejected)

**Pros:**
- No patch

**Cons:**
- A second layout to keep in step with the first; the preview would no longer show the layout a save would record

## Evidence

- Engine tests: `layout/frame/tests.rs` (`an_empty_iban_is_drawn_and_read_as_its_label_and_its_segment_stays`: bare label drawn, no `⟦ ⟧` in the drawing's text, 0 unprintable characters; `a_missing_label_that_wraps_keeps_its_brackets_in_both_languages`), `render.rs` `mark_missing_tests` (a registry-unavailable preview marks every placeholder in both languages; adjacent and broken labels are marked one by one and a user's own marks are not), `resolve/tests.rs` (the missing list is the same with the option), `output/render_tests.rs`.
- API tests: `letterhead-api/api/tests/preview.rs` (21 pass; the page text holds the registry's details and `⟦Label⟧` for an empty value) and the wire test that the option never reaches a render job.
- e2e `shell/e2e/letterheads.spec.ts` (4, including the D2 wrap journey) per specs/20261117-legal-entities/qe-report.md AC-5.4. The golden corpus is unchanged (T20 done-when).

## Consequences

**Positive:**
- A designer sees what an empty detail would print, in the picture and in the text alternative
- Real documents and old versions are byte-identical
- The need for a layout 2 to provide the mark is written down before layout 2 exists

**Negative / trade-offs:**
- The preview of a layout that cannot mark fails, which blocks the configurator for that layout until it does
- The ink colour is a contract between the template and the text matcher: changing it in one without the other drops the brackets, and only the tests catch it
- The closed label list is engine code; a new placeholder needs the label in two languages

**Risks:**
- **A refactor of layout 1's frame-line line** stops the patch from applying: `Layout::marking` returns `None`, the preview of every configuration fails with `Internal "mark missing"`. Layout 1's template is pinned and not expected to change; a test and the preview e2e would catch it.
- **A label wrapping in a way the matcher does not join** loses its brackets (D2 was one such case; the matcher joins runs in the mark's ink, including whitespace runs).
- **The sample document's text** said its company data were "(SAMPLE)" placeholders, which became false in the preview; FU-9 (T65) rewords the sample, engine-only.

## Escalation triggers

This decision is revisited when any of these happens:

- layout 2 is added: it must meet point 6, and this ADR gains a line for how it does (own patch, own template branch, or a shared mechanism);
- a second preview-only mode is wanted (a diff view, a redaction marker): decide whether patches compose or the layout gets a first-class "preview" input;
- a bundled font gains `⟦ ⟧`, which would let the drawing and the text agree;
- a third language or another placeholder is added to the closed label list.

## Compliance notes

- GDPR / data-protection impact: none. The mark draws a label (a fixed word), not a value, and exists only in the configurator preview.
- Data residency: no change.
- Audit trail: not required.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
