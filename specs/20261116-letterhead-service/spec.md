---
id: 20261116
slug: letterhead-service
status: in-progress
approved: 2026-11-16
rigor: production
created: 2026-11-16
---

# Letterhead service — one engine that lays out a whole document, for every tool

> **Origin.** The "next spec" recorded by specs/20261115-crm-offer-wizard (OA-4 and its last
> Non-goal): a separate Operai service that gives every tool the same letterhead, header,
> footer and page numbering, and retires the uploaded letterhead PDF. The owner (wellD)
> answered the interview on 2026-11-16; their decisions are marked *(owner)*. Choices made
> while writing, which the owner has not given, are marked *(proposed — to confirm)* and
> each has an entry under Open questions.
>
> **Scope (owner, 2026-11-16, O2).** One spec, delivered as one release, not split. In this spec: the service, its
> configurator, and the CRM offers as its first consumer (US-10). Not in this spec: Refund,
> EstimAI and Projects adopting it, each a follow-up spec in the owner's order (Refund batch
> PDF and request export, then EstimAI export, then Projects). The service's contract must
> not be CRM-specific, and US-9 proves it with a caller that is not the CRM.
>
> **What this changes in specs/20261115-crm-offer-wizard (once approved; recorded here only, that spec is not edited — owner, O15).** US-11's HTML
> pagination of the wizard's preview, AC-3.2's "page breaks approximate" and AC-11.12's
> locally drawn page number are replaced by the service's pages (AC-10.3), and AC-3.1's one
> second becomes two seconds (AC-10.4). US-12 (the issuer's name and address from the entity
> profile) is unchanged.

## Problem

Every tool that produces a PDF draws its own letterhead, header, footer and page numbers.
The CRM draws an uploaded one-page A4 letterhead PDF behind every page and prints "N/M" in a
fixed corner (`crm-api/src/offers/contractPdf.ts:906-914`), while its wizard preview is a
separate HTML pagination that only approximates the PDF's page breaks. Refund's batch PDF and
request export each draw a built-in letterhead and footer (`refund-api/src/batches/pdf.ts:311,438`,
`refund-api/src/requests/exportPdf.ts:344`), and EstimAI builds its PDF in the browser with its
own header (`estimai-ui/src/lib/pdfExport.ts:62-92`). A change to wellD's address or logo means
a new PDF upload or a code change in each tool, and no tool can show a preview that is
guaranteed to be the page the client will receive.

## Domain language

- **letterhead** — an entity's page frame, as configuration: margins, header and footer,
  logos, fonts, rules and page-number format. It replaces the uploaded one-page PDF that
  specs/20261102-crm-offer-document AC-2.1 calls the letterhead. One per legal entity
  (`welld_it`, `welld_ch`) is active at a time.
- **letterhead version** — one saved, immutable state of an entity's letterhead, numbered
  1, 2, 3 per entity.
- **page variant** — the header, footer and logos of one kind of page: the **default** variant
  for the pages in between, an optional **first-page variant**, an optional **last-page variant**.
- **placeholder** — a name in braces (`{legal_name}`, `{page}`) in a header or footer text,
  replaced when a document is rendered. The set of names is closed.
- **content blocks** — the document as structured data: heading, paragraph, list, table, image,
  page break, each with an optional **named style**, in a **content version** the service
  declares. Never markup, never code.
- **entity data** — the values the caller sends for the placeholders: legal name, address
  lines, VAT number, IBAN, contacts. The service keeps none.
- **caller** — a service that sends a render request: the CRM's backend first, any tool's
  backend later.
- **render request** — entity, optional letterhead version, content blocks and entity data.
- **preview** — the pages of a render request as images, with each page's text, from the same
  engine and the same pagination as the PDF.
- **sample document** — a built-in document of the service, with sample entity data marked as
  such, used by the configurator's preview.

## User stories and acceptance criteria

### US-1 A caller gets the preview pages and the PDF from one engine

As the backend of a tool, I want to send a document as blocks and get back its pages and its
PDF, so that what the person previewed is what the PDF contains.

- **AC-1.1** Given a valid render request, when the caller asks for the PDF, then the response
  is a PDF in A4 whose pages carry the entity's letterhead (AC-4.4) and whose body is the
  blocks in the order sent. *(owner)*
- **AC-1.2** Given the same request, when the caller asks for the preview, then the response
  holds the page count M and, for each page asked for (all by default), an image in A4
  proportions (210:297) and that page's text in reading order. A PDF is not needed to get a
  preview. *(owner)*
- **AC-1.3** Given one request rendered as preview and as PDF, then both have the same page
  count; for every page the text of the preview equals the text extracted from the PDF's page,
  except as the next paragraph allows for unprintable characters; and the page rasterised from
  the PDF and the preview image differ in no more than 0.5 % of their pixels. Text is compared
  with every run of whitespace normalised to one space; a pixel differs when no pixel within
  1 px of it in the other image is within 64/255 on every channel, the PDF being rasterised by
  an independent engine (pdfium) at the preview's scale. Unprintable characters: the preview's
  text is built from the request's text, while a character drawn as the replacement mark
  (`.notdef`, AC-7.6) may be missing from the text extracted from the PDF. Given an answer
  that reports a count N of unprintable characters (AC-7.6) greater than zero, a page's text
  of the PDF may therefore differ from the preview's, and only in this way: deleting characters
  from the preview's text, each of them a character the font it is set in does not hold, and
  then normalising whitespace as above, gives the PDF's text, with no character changed, added
  or reordered; and the fewest such deletions over all the pages of the document are no more
  than N. Given an answer that reports none (N is zero), the text of every page is equal, with
  no exception. The page count and the pixel comparison have no exception in either case.
  *(owner: preview and PDF cannot diverge; 0.5 % confirmed by the spike, O10; comparison
  defined by amendment A5; unprintable characters by amendment A6, orchestrator-proposed — owner
  to confirm)*
- **AC-1.4** Given the same request sent twice, then both PDFs have the same page count, the
  same text on each page and the same position of every line, apart from the PDF's creation
  metadata.
- **AC-1.5** The service renders these blocks: heading (levels 1 to 3), paragraph (runs of
  text with bold, italic and underline), list (bulleted or numbered), table (a header row,
  cells that hold paragraphs or lists, relative column widths), image, page break. A fixture
  that uses each block type renders with every block present, once, in order. *(owner for the
  block types; runs, header row and column widths proposed — to confirm, O14)*
- **AC-1.6** Where a page breaks, then: no line is cut and no word is split (except as below); a heading is never
  the last thing on a page; a paragraph or list item of more than one line never leaves one line
  alone at the bottom or the top of a page; a table row is not split between pages unless it is
  taller than a page, and then continues on the next page without losing a line; a table's
  header row is repeated on each page the table continues on; a page-break block starts a new
  page and never produces an empty one. (These are the rules of specs/20261115-crm-offer-wizard
  AC-11.11, which the service must not lose.) A word wider than its line or its table cell is
  broken at the margin: it is the only case in which a word is split, and nothing is ever drawn
  outside the margins (AC-5.1). *(amendment A4)*
- **AC-1.7** A named style is chosen by name from the set the service defines. A request
  naming a style outside that set is refused (AC-3.6) and nothing is rendered.
- **AC-1.8** *(Superseded 2026-11-17 for the issuer's details only by specs/20261117-legal-entities, amendment D7.)* Every request states its content version. A version the service does not support is
  refused with `unsupported_content_version`; a request of a version the service supported
  before an upgrade renders after the upgrade with the same pages (AC-4.5). *(owner:
  versioned blocks)*
- **AC-1.9** The service's reply for a preview of a document of 10 pages arrives in under one
  second at the 95th percentile, measured on the deployed service with one caller at a time.
  *(confirmed by the spike, O10: 0.11 s locally; measured again on the deployed service)*
- **AC-1.10** The service's reply for the PDF of a document of 10 pages arrives in under three
  seconds at the 95th percentile, on the same measure. *(confirmed by the spike, O10: 0.05 s
  locally)*

### US-2 What a person writes is data, never code

As wellD, I want any text that reaches the service to be printed as text, so that a client's
name, a pasted paragraph or a malicious string can neither change a document's layout nor make
the service do anything.

- **AC-2.1** Given text in any block, any entity-data value or any template name that contains
  the engine's own syntax, then it is printed character for character and changes no layout,
  style, page setup or structure. The test set holds at least: `#set page(width: 1cm)`,
  `#read("/etc/hostname")`, `$x^2$`, `*a*`, `_a_`, a backtick-quoted run, `@label`, `<label>`,
  a lone backslash and a `{page}` written in a paragraph. *(owner)*
- **AC-2.2** Given the test set of AC-2.1, then the render opens no file other than the
  service's own fonts and templates, makes no network request and runs no program; the content
  of a file the service holds a secret in never appears in any output.
- **AC-2.3** An image block carries its bytes in the request. A block that names an address (a
  URL or a path) is refused as invalid content; the service never fetches anything on a
  caller's behalf. An image follows the format and size rules of AC-7.1 to AC-7.3.
- **AC-2.4** A `{name}` written in a paragraph, a cell or a heading of the content is printed
  as typed; only a header or footer text of a letterhead is read for placeholders (US-6).

### US-3 Who may call, limits, failures and what is kept

As the owner of the suite, I want rendering to be callable only by the suite's own services,
bounded, and free of any record of what was written, so that a document's content is never
stored or leaked by the service.

- **AC-3.1** A render request is accepted only with a service credential issued for rendering.
  A request with no credential, an invalid or expired one, one for another audience, one
  without the rendering permission, or a signed-in person's token, is refused with the same
  401 answer in every case. The service never accepts a person's token on the render route.
- **AC-3.2** The service writes, for each render and each refusal, one log line holding the
  caller's service identity, the entity, the outcome code, the page count and the duration, and
  nothing of the content or of the entity data.
- **AC-3.3** A request body larger than 20 MiB is refused with 413 `request_too_large`; content
  with more than 5 000 blocks, or a text of more than 200 000 characters in one block, is
  refused with 422 `content_too_large` naming the limit; a document that would run to more than
  300 pages is refused with 422 `too_many_pages`. Nothing partial is returned. *(limits
  confirmed by the spike, O10)*
- **AC-3.4** A render that is still running 30 seconds after it started is stopped, the
  caller gets 504 `render_timeout`, and the work does not go on in the background. *(30 s
  confirmed by the spike, O10)*
- **AC-3.5** Beyond a bound on renders running at once, the service answers 429 `busy` with a
  `Retry-After`; it does not queue without limit. One caller reaching the bound does not stop
  another caller's requests from being served.
- **AC-3.6** Given content the service cannot render (unknown block type or style, a missing
  required member, an image it refuses), then the answer is 422 `invalid_content` listing, for
  up to 20 problems, the path of the block and a reason code; an error answer never repeats any
  text from the request.
- **AC-3.7** After a render, whether it succeeded or not, the service holds nothing of the
  document: no content, entity data, PDF or image in its database, its object storage, its disk
  (temporary files included), its logs, its metrics or its traces. Verified by rendering a
  document with unique marker strings and then searching each of those places for them. *(owner)*
- **AC-3.8** Every render answer carries `Cache-Control: no-store`. The service runs in an EU
  region, and so does its object storage.

### US-4 One active letterhead per entity, with a history

As the person responsible for an entity's stationery, I want each change to be a new version
and every old version to stay available, so that a document made years ago can be laid out the
same way again.

- **AC-4.1** Each of `welld_it` and `welld_ch` has at most one active letterhead. Saving a
  letterhead creates the next version of that entity, numbered from 1, which is active at once;
  the previous version stays in the history. *(owner)*
- **AC-4.2** A person can restore an older version. Restoring creates a new version with the
  same configuration and logos as the older one, active at once; the older one and the history
  are unchanged. *(owner, O11)*
- **AC-4.3** A saved version is never changed: no route alters its configuration, texts, fonts
  or logos.
- **AC-4.4** A render request names the entity and may name a letterhead version. Without one it
  uses the entity's active version; with one it uses exactly that version, active or not. The
  answer states the version used. A version that does not exist is 404
  `letterhead_version_not_found`; an entity with no active letterhead is 409
  `letterhead_not_configured`. The service never falls back to a plain header, to another
  version or to another entity's letterhead. *(owner)*
- **AC-4.5** Given a document rendered with version n, when the same request is rendered later
  with version n — after newer versions exist and after the service has been upgraded — then
  the page count, the text of each page and the position of each line are the same as the first
  time. This holds for as long as the service exists: a change of the engine or of the templates
  that would alter the result of an existing version is shipped so that documents rendered with
  that version keep their earlier result, never silently. *(owner, O12)*
- **AC-4.6** No route deletes a letterhead version or the logos of one. A version, and its
  logos, stay for as long as the service exists. *(owner: a version in use is never deleted;
  the service does not know which documents use one, so none is deleted; no cap on the number
  of versions per entity, O12)*
- **AC-4.7** Every save and every restore is recorded with who did it (the account), when, the
  entity, the version number it created and the names of the settings that changed. The record
  is shown in the configurator's history and can be neither edited nor removed through the
  service. The record is immutable at the database level: an update or a delete of a record row
  is refused by the database itself, as for the suite's financial audit trails (ADR
  20260716-immutable-financial-audit-trail-refund), and a test proves both refusals. *(owner, O13)*
- **AC-4.8** A save states the version the person was looking at. When another version has been
  saved since, the save is refused with 409 and the person is told to reload; what the other
  person saved is not lost.
- **AC-4.9** An entity other than `welld_it` or `welld_ch` is refused with 422 `unknown_entity`.

### US-5 Page layout: margins, header, footer, first and last page, page numbers

As the person responsible for an entity's stationery, I want to set the margins, the header and
footer, the first page, the last page and the page number myself, so that the entity's
documents look as they should without a developer.

- **AC-5.1** A letterhead sets the top, bottom, left and right margins, each between 5 and 100
  mm; a save that leaves a body area narrower than 100 mm or lower than 150 mm is refused naming
  the margin. On every page, body content is drawn only inside the margins. *(owner: margins;
  bounds confirmed by the spike, O10)*
- **AC-5.2** A page variant has a header and a footer, each with a left, a centre and a right
  text of up to four lines. The header is drawn inside the top margin and the footer inside
  the bottom margin. A save in which a header or footer, with every placeholder replaced by a
  40-character value, does not fit its margin is refused naming which. Each line of a header or
  footer text has its own look, chosen from a closed set: size (6 to 14 pt), weight (regular or
  bold) and colour (a six-digit hexadecimal value); a value outside it is refused naming the
  line. Each header and each footer sets the vertical alignment of its three zones, top or
  bottom, so that a one-line zone can sit level with the last line of a longer one.
  *(owner: free text; zones kept, O8; four lines, line look and alignment by amendments A1–A3)*
- **AC-5.3** Given a render in which a placeholder's value makes a header or footer taller than
  its margin, then the render is refused with 422 `header_overflow` or `footer_overflow`; the
  header or footer is never drawn over the body or cut. (Long text first wraps inside its zone.)
- **AC-5.4** Given a first-page variant, then page 1 uses its header, footer and logos, which may
  be empty or different, and pages after the first use the default variant. Given none, page 1
  uses the default variant. *(owner)*
- **AC-5.5** Given a last-page variant, then the last page of a document of more than one page
  uses its header, footer and logos. It has to fit the same margins (AC-5.2), so enabling it
  never changes where a page breaks. A document of one page uses the first-page variant, never
  the last-page one. *(owner, O11)*
- **AC-5.6** A header and a footer can each have a horizontal rule — shown or not, with a
  thickness and a colour — drawn between its text and the body, across the width between the
  left and right margins. A colour that is not a six-digit hexadecimal value is refused.
  *(owner: separators)*
- **AC-5.7** The page number is written with the placeholders `{page}` and `{pages}` in any
  header or footer text, so its format ("Pagina {page} di {pages}", "{page}/{pages}") and its
  position (the zone it is in) are the letterhead's. On every page `{pages}` is the document's
  total page count, equal to the PDF's, and `{page}` is the page's own number. *(owner)*
- **AC-5.8** A letterhead version holds every header and footer text in Italian and in English;
  layout, margins, rules, logos and fonts are shared by both languages. A render request names
  the document's language (`it` or `en`) and the service prints that language's texts: the same
  request in `en` prints "Page 2 of 5" where `it` prints "Pagina 2 di 5", with the same page
  breaks. A request with no language or another one is 422 `unsupported_language`. A save in
  which a text is filled in one language and empty in the other is refused naming the text and
  the language. *(owner, O3: texts per language; the save rule proposed — to confirm)*
- **AC-5.9** The look of each block type is part of the letterhead version and is set in the
  configurator from a closed set of options, never by writing a template or engine code: for
  each heading level its size (8 to 24 pt), weight (regular or bold) and colour; the body
  text's size (8 to 14 pt) and line spacing (1.0 to 2.0); the table's header-row background
  colour, whether cell borders are drawn, and their colour; the list marker (bullet or dash for
  bulleted lists). A value outside its bounds, or a colour that is not a six-digit hexadecimal
  value, is refused naming the option. A document rendered with a version prints the block
  types with that version's look, and the named styles of AC-1.7 are defined on top of it.
  *(owner, O14: the configurator sets the blocks' look; the option set and bounds proposed — to
  confirm in the plan)*

### US-6 Placeholders and the entity's data

As the person responsible for an entity's stationery, I want the header and footer to name the
entity through placeholders, so that a change of address is made once, by the tool that holds it.

- **AC-6.1** The placeholders form a closed set: `{legal_name}`, `{address}`, `{vat}`, `{iban}`,
  `{contacts}`, `{page}`, `{pages}` (the final set, O8). A header or footer text that uses any
  other name is refused at save, naming the placeholder and the text it is in. The configurator
  lists the set. *(owner)*
- **AC-6.2** A way to write a literal brace in a header or footer text exists and is shown in the
  configurator; a text that uses it prints the brace and is not read as a placeholder.
- **AC-6.3** *(Superseded 2026-11-17 by specs/20261117-legal-entities, amendment D1.)* The values of the placeholders are sent by the caller with the render request;
  the service looks nothing up, keeps nothing (AC-3.7) and a letterhead holds placeholders,
  never values. A request with no entity data at all is valid. In this spec the CRM sends the
  values of its entity profile (US-10). *(owner; the single source of the values across tools is
  deferred to the Refund follow-up spec, O1)*
- **AC-6.4** Given a placeholder whose value the request does not carry, or carries empty or only
  spaces, then it prints nothing; the text around it is printed as written; a line left with
  no text is not drawn and takes no height; the answer lists the names of the placeholders that
  were used and had no value; and the render is not refused. *(owner, O8; consistent with
  specs/20261115-crm-offer-wizard's rule that a blank CRM-supplied value prints nothing)*
- **AC-6.5** `{address}` prints the address lines in their order on one line, separated by a
  comma and a space, each line as sent; an address of no lines prints nothing.
- **AC-6.6** A header or footer text can hold a **conditional segment**: text in square brackets
  around one or more placeholders, such as `[VAT: {vat}]`. Given a render in which every
  placeholder inside the segment has a value, the segment prints without its brackets ("VAT:
  CHE-123.456.789"); given one of them without a value (AC-6.4), the whole segment prints
  nothing, label included, and the rest of the text prints as written. A segment that holds no
  placeholder, or a segment inside another, is refused at save naming the text. A literal
  square bracket is written as AC-6.2 writes a literal brace. *(owner, O8)*

### US-7 Logos and fonts

As the person responsible for an entity's stationery, I want to put the entity's logo in the
header and choose its fonts, so that documents carry the entity's identity.

- **AC-7.1** A logo is accepted when its bytes are a PNG, a JPEG or an SVG; the file's name and
  declared type are not trusted. Any other file is refused with a reason code. *(owner)*
- **AC-7.2** An SVG that contains a script, an event-handler attribute, a `foreignObject`, an
  entity or document-type declaration, or a reference to anything outside the file (a web
  address, a file path, a stylesheet import, an external `use`) is refused with a reason code.
  A clean SVG is accepted and, when rendered, makes no network request and opens no file.
  *(owner)*
- **AC-7.3** A logo file is at most 2 MiB. A raster logo whose decoded size is more than 25
  megapixels is refused, whatever size its header claims; an SVG of more than 10 000 elements is
  refused. *(owner: a size limit; figures confirmed by the spike, O10)*
- **AC-7.4** Each page variant can show a logo at the left, centre or right of its header, with
  a height between 5 and 40 mm; its width follows its proportions. Logos are stored in the
  service's own object storage in an EU region, never in another tool's. They are part of the
  letterhead version (AC-4.3). *(owner)*
- **AC-7.5** The letterhead's fonts are chosen from a closed list bundled with the service; a
  name outside it is refused. The service never fetches a font when it renders. Every font of
  the list prints Italian, French and German letters with accents, "€", "CHF" and the
  typographic apostrophe. The list holds the suite's fonts (DM Sans, DM Mono, Syne) and wellD's
  brand fonts (Ubuntu, Noto Serif), each with a licence that allows embedding in a PDF; a font whose licence does not allow it is
  not on the list. *(owner, O7)*
- **AC-7.6** A character that the chosen font does not hold prints a visible replacement mark,
  the render is not refused, and the answer states how many such characters there were, never
  which. *(owner, O11)*
- **AC-7.7** Each page variant can have a background image (PNG, JPEG or SVG, under the same
  rules and limits as a logo, AC-7.1 to AC-7.3) drawn under everything else across the whole
  page, so that artwork the other settings cannot draw (a coloured band, a watermark, a shape)
  is reproduced. Body text drawn over it stays inside the margins (AC-5.1); the background never
  moves a page break. *(owner, O4: today's letterheads carry artwork beyond logo and texts)*

### US-8 The configurator: a form, and a preview made by the service

As the person responsible for an entity's stationery, I want a screen where I edit a
letterhead and see it on a sample document before I save, so that I never publish a
letterhead I have not seen.

- **AC-8.1** A new tool, **Letterheads**, is reachable at `/letterheads` in the suite for people
  who hold its own access permission; a signed-in person who does not hold it does not see it
  in the suite and is refused at the route. *(owner)*
- **AC-8.2** Changing a letterhead needs a second, dedicated permission. A holder of access
  only can see the active letterhead, its history and its preview, and cannot save or restore;
  the service refuses the attempt with 403, whatever the screen shows. The permission is
  entity-scoped: a holder changes only the letterhead of their own entity, and a change to
  another entity's is refused with 403 `out_of_scope` and changes nothing; an administrator
  (unconditioned grant) changes both. Every holder of the access permission sees the
  letterheads, histories and previews of both entities. *(owner, O9)*
- **AC-8.3** The form edits, for the chosen entity: the margins, the fonts, the header and footer
  texts, the rules, the logos, the first-page and last-page variants and the page-number format
  as of US-5 to US-7, the blocks' look of AC-5.9, with the header and footer texts in Italian and in English (AC-5.8) and a
  switch that shows the preview in either language. Each control has a visible label; every control can be reached and used
  with the keyboard alone; a refused value is shown next to its control, named in the error and
  announced to assistive technology, and focus moves to the first one on a refused save.
  *(owner: accessible)*
- **AC-8.4** Next to the form the screen shows the preview of the sample document, rendered by
  the service with the values in the form, saved or not. After an edit it updates without a
  save: within 2 seconds of the last edit in 95 % of edits. The sample document runs to at least
  three pages and uses every block type, so the first page, the last page and a page in between
  can each be seen. *(owner; 2 s confirmed by the spike, O10)*
- **AC-8.5** *(Superseded 2026-11-17 by specs/20261117-legal-entities, amendment D1.)* The sample's entity data is visibly marked as a sample and is not the data of a
  real company; the preview never reads the CRM or any other tool.
- **AC-8.6** While a newer preview is being made, the previous one stays on screen, marked as
  being updated; an answer that arrives after a newer one was asked for is discarded; when the
  service fails or refuses, a message says so, the form stays usable and saving is not blocked
  by it. Each page image has a text alternative "Page N of M" and the page's text is available
  to assistive technology.
- **AC-8.7** The history lists every version with its number, who saved it, when, and the names
  of what changed; a version can be opened in the preview, and restored (AC-4.2) after a
  confirmation.
- **AC-8.8** Leaving the screen with an unsaved change asks for confirmation. All copy exists
  in English and in Italian with the same keys; dates use the suite's format; the sample
  document's language follows the person's. *(owner: bilingual)*
- **AC-8.9** The permission catalog seeds both permissions (access to Letterheads and changing a
  letterhead) to the `admin` role only, unconditioned; no other role holds either after the
  seed. An administrator grants them to other roles in the Admin tool, and a grant conditioned
  on the entity gives the scope of AC-8.2. *(owner, O9)*

### US-9 A tool other than the CRM can render

As the owner of the suite, I want the service not to be built around the CRM's offer, so that
Refund, EstimAI and Projects can adopt it without changing the service.

- **AC-9.1** Given a caller other than crm-api that holds the rendering credential, when it
  sends a request for a document of another kind — a title, a table of expense lines with totals
  and a paragraph, for entity `welld_ch` — then it receives the PDF and the preview of AC-1.1
  and AC-1.2. Verified by a test caller, with no change to the service for it.
- **AC-9.2** Neither a request nor an answer holds a name that belongs to one caller's domain
  (deal, offer, request, estimate).
- **AC-9.3** Adding a caller needs a credential for it and no change to the service's code.

### US-10 CRM offers use the service *(first consumer; owner, O2)*

As a person who prepares offers, I want my offer's letterhead, header, footer and page numbers
to come from the entity's configured letterhead, so that the preview I see and the PDF I
send are the same pages.

- **AC-10.1** Given the CRM has been switched over, when an offer is generated, edited before it
  is sent, or revised, then crm-api obtains the offer's pages from the service: the entity's
  active letterhead, the header, footer, margins and page numbers come from it, and crm-api
  draws none of them. The deal PDFs the person chose are still appended by crm-api after the
  rendered pages and are not numbered, as today (`contractPdf.ts:906-914`: "N/M" counts the
  rendered pages only).
- **AC-10.2** The offer records the letterhead version it was made with.
- **AC-10.3** The wizard's preview shows the page images and page count that the service returns
  for the draft, in place of the HTML pagination and the letterhead drawn in the browser. The
  preview's page count and the text of each of its pages equal those of the PDF the draft would
  generate (AC-1.3), and "N/M" on each page is the PDF's own.
- **AC-10.4** The preview follows the draft within 2 seconds of a change in 95 % of changes
  (replacing the one second of specs/20261115-crm-offer-wizard AC-3.1, which a render by
  another service cannot promise; *confirmed by the spike, O10*), keeps the previous pages on
  screen until the new ones arrive, and is never blank. A missing field is drawn on the preview
  in a highlighted style with its label (as specs/20261115-crm-offer-wizard AC-3.3 says); a
  generated PDF never contains one, because generation is refused while a field is missing
  (AC-3.5 of that spec).
- **AC-10.5** The wizard offers each preview page's text, as the service returns it, as the text
  alternative of the page for assistive technology. Selecting and copying text in the preview is
  not offered; a missing field is reached through the Preview step's list of missing fields
  (specs/20261115-crm-offer-wizard AC-3.4). *(owner, O6)*
- **AC-10.6** Given the service cannot be reached, answers an error, answers `busy` or times out
  when an offer is generated, then no offer is created, no offer number is consumed, no PDF is
  stored, the draft is as it was, and the person is told in their language that the layout
  service is unavailable and may try again.
- **AC-10.7** Given the same failure while the preview is being made, then the wizard stays
  usable: the last pages stay, a notice says the preview could not be updated, nothing blocks
  typing or saving the draft, and no dialog is raised.
- **AC-10.8** Given an entity with no active letterhead in the service, then the preview and
  the generation say so (`letterhead_not_configured`), point a person with access to
  Letterheads to the configurator, and produce no PDF with a plain or other header.
- **AC-10.9** Offers generated before the switch keep their reference, snapshot and stored PDF,
  byte for byte, and can still be downloaded; none is regenerated. An unsent offer that is
  edited, and a new revision of a sent offer, are generated after the switch with the entity's
  active letterhead, as AC-12.4 of specs/20261115-crm-offer-wizard already says of the legal
  name. *(owner: issued offers unchanged)*
- **AC-10.10** *(Superseded 2026-11-17 by specs/20261117-legal-entities, amendment D1.)* crm-api sends, with each render, the legal name, the address lines, the VAT
  number and the IBAN of the entity's profile at that moment; the place of issue, which is part
  of the offer's content, is unchanged. The profile's rule that an empty legal name refuses
  generation (specs/20261115-crm-offer-wizard AC-12.7) is unchanged; any other blank value
  prints nothing.
- **AC-10.11** Uploading a letterhead PDF is retired: CRM Settings no longer offers it, the
  routes that start, confirm or read an upload are refused, and `letterhead_unusable` can no
  longer be answered. *(owner)*
- **AC-10.12** The switch is enabled only when both entities have an active letterhead in the
  service: a release step checks it and refuses to enable the switch otherwise. Until the
  switch, the CRM behaves as today. At the switch the uploaded letterhead PDFs are deleted from
  the CRM's storage and the entity profile no longer holds a reference to one; offers already
  issued are unchanged and their stored PDFs still open, because none reads the letterhead
  object. *(owner, O5: deleted at the switch, no rollback to the uploaded letterhead)*
- **AC-10.13** Every new CRM message and label exists in English and in Italian with the same
  keys.
- **AC-10.14** Given the switch is on, when a person uses "Try the wizard" in the offer template
  editor (specs/20261115-crm-offer-wizard AC-8.5), then its preview shows the pages the service
  returns for the template being edited, unsaved, with the sample answers and the entity's
  profile values, made by the same conversion as an offer's draft; no deal is needed. It follows
  changes, keeps the previous pages and reports failures and `letterhead_not_configured` as
  AC-10.4, AC-10.7 and AC-10.8 say. *(owner, 2026-11-16, design gap G1)*

## Constraints

Recorded from the owner's answers of 2026-11-16 *(owner)*; the plan decides how.

- A separate service lays out the WHOLE document — content, header, footer, logos and "page N of
  M" — and produces both the preview pages (images; a PDF is not required for the preview) and
  the final PDF from the same engine, so that preview and PDF cannot diverge.
- Rust, with Typst embedded as a library.
- An ADR is needed to add Rust to the Bun monorepo. A short Typst spike comes BEFORE the plan:
  a real offer as blocks, a different first page, a footer "N/M", and the preview latency. The
  numbers marked "to confirm" in this spec are settled by it.
- Callers send the content as versioned structured blocks (heading, paragraph, list, table,
  image, page break, named styles); the document is rendered by templates wellD writes; a
  user's text is always data, never markup or code of the engine.
- The renderer is stateless: it stores no produced document and logs no content. Callers store
  their PDFs in their own EU storage.
- The entity data for the placeholders (legal name, address, VAT, IBAN, contacts) is sent by the
  caller with the content.
- One active letterhead per legal entity (`welld_it`, `welld_ch`), with a version history; a
  generated document records the letterhead version it used; managed by the holders of a
  dedicated permission. The first page, and optionally the last, can differ.
- A new federated tool (for example `/letterheads`) with its own access permission.
- Logos: PNG, JPEG or SVG (an SVG without scripts or external resources), with a size limit;
  fonts from a closed bundled list; logos in the service's own EU storage.
- Order of consumers: CRM offers; then the Refund batch PDF and request export; then the EstimAI
  export (client-side jsPDF today); then Projects (future documents).

## Non-goals

- Refund's batch PDF and request export, EstimAI's export and Projects' documents moving to the
  service: each is its own follow-up spec (O2). Only the service's contract is proven for them
  (US-9).
- Regenerating, or changing in any way, an offer issued before the switch (AC-10.9).
- The service storing produced documents, offering a document history or a re-download of one:
  callers store theirs (AC-3.7).
- The service merging or appending PDFs, such as the deal PDFs of an offer: the caller does.
- The service being asked for a person's token or looking up an entity's data: the caller sends
  it (AC-6.3).
- A visual editor for documents; a person using the configurator never writes a template or
  engine code: the blocks' look is set only through the options of AC-5.9.
- Per-document letterheads, a letterhead per department, or more than one active letterhead per
  entity.
- Fonts, logos or colours beyond the closed list, the three logo formats and a hexadecimal
  colour; embedded or uploaded fonts.
- Deleting a letterhead version, or pruning the history (AC-4.6).
- Changing the CRM's offer templates, their markup, their cost-table rules or the entity
  profile's other fields.
- Any change to refund-api, estimai-api, estimai-ui or projects-api.

## Open questions

- [x] **O1** *Resolved 2026-11-16 (owner): deferred to the Refund follow-up spec, which cannot start without it; in this spec the CRM sends its entity profile's values (AC-6.3).* The single source of the entity data across tools. Today only crm-api's entity
  profile holds the issuer's legal name and address (specs/20261115-crm-offer-wizard US-12), and
  the VAT number and IBAN (`crm-api/prisma/schema.prisma:250-256`). Refund, EstimAI and Projects
  must get the same values from somewhere, or the point of placeholders — one address change
  applies everywhere — is lost; the service keeps none (AC-6.3). Who owns the values, and where
  do the other tools read them? Not blocking for CRM-only delivery, blocking for the first
  follow-up spec. — owner: Matteo Codogno (product owner)
- [x] **O2** *Resolved 2026-11-16 (owner): service, configurator and CRM offers in this spec, as ONE spec and one release (the split was declined); Refund, EstimAI and Projects are follow-ups.* Scope. Confirm that the service, the configurator and CRM offers are in this
  spec, and that Refund, EstimAI and Projects are follow-ups. The spec has more than 70
  acceptance criteria; a split into the service and its configurator (US-1 to US-9) and the CRM
  adoption (US-10) is proposed in the return note. — owner: Matteo Codogno
- [x] **O3** *Resolved 2026-11-16 (owner): texts per language, Italian and English (AC-5.8).* Language of the texts. A header or footer text is free text in one language, but
  offers are written in Italian and in English ("Pagina 2 di 5", "Page 2 of 5"). Proposed: a
  letterhead holds its texts per language (Italian, English), a render request names the
  language, and a language without texts is refused. Without it an English offer prints an
  Italian footer. Blocking for the plan. — owner: Matteo Codogno
- [x] **O4** *Resolved 2026-11-16 (owner): yes, today's letterheads carry artwork beyond logo and texts → a background image per page variant (AC-7.7); the spike reproduces one of them.* Can the configured model (margins, logos, header and footer texts, rules, page
  numbers) reproduce the two uploaded letterheads of today, or do they carry artwork it cannot
  draw? wellD supplies the logo files and fonts of both entities; the spike checks one. —
  owner: Matteo Codogno
- [x] **O5** *Resolved 2026-11-16 (owner): deleted at the switch, references removed, no rollback to the uploaded letterhead (AC-10.12).* The uploaded letterhead PDFs in the CRM's bucket, and the profile columns that
  point at them, are unused after the switch. Keep them, and for how long, or delete them at a
  later date? They are not deleted at the switch (AC-10.12). — owner: Matteo Codogno
- [x] **O6** *Resolved 2026-11-16 (owner): accepted as proposed (AC-10.5).* A preview made of images is not selectable, searchable or copyable, which the
  wizard's preview is today (specs/20261115-crm-offer-wizard AC-11.1, AC-11.12), and a
  highlighted missing field is not a link. Proposed: the page's text is given to assistive
  technology (AC-10.5) and the Preview step's list of missing fields stays the way to reach a
  field (AC-3.4 of that spec). Accepted? — owner: Matteo Codogno
- [x] **O7** *Resolved 2026-11-16 (owner): the suite's fonts plus wellD's brand fonts whose licence allows PDF embedding (AC-7.5). Brand fonts (wellD brand guidelines, 2026-11-16): Ubuntu (headings, titles, labels; Ubuntu Font Licence 1.0) and Noto Serif (body; SIL OFL 1.1), both allowing PDF embedding; the plan pins the exact files and versions. The reference letterheads for the spike are the brand templates `Carta_Intestata_WellD_IT_new.docx` and `Carta_Intestata_WellD_CH_new.docx`.* Which fonts are on the closed list (brand fonts, Latin coverage, licences allowing
  embedding in a PDF)? — owner: Matteo Codogno
- [x] **O8** *Resolved 2026-11-16 (owner): conditional segments (AC-6.6); the placeholder set of AC-6.1 and the left/centre/right zones are kept as written.* The final set of placeholders, in particular `{contacts}`; the zones (left, centre,
  right) proposed for header and footer texts; and the dangling label that "prints nothing" leaves
  ("VAT: " when no VAT is sent). Proposed: a way to write a segment that prints only when its
  placeholder has a value. — owner: Matteo Codogno
- [x] **O9** *Resolved 2026-11-16 (owner): entity-scoped, an administrator manages both (AC-8.2); the seed grants access and manage to `admin` only, other roles are granted by an administrator in the Admin tool (AC-8.9).* Is the dedicated permission scoped to an entity, as the CRM's `deal:manage` is (a
  person changes the letterhead of their own entity only; an administrator both)? Which roles
  receive the access permission? — owner: Matteo Codogno
- [x] **O10** *Resolved 2026-11-16 (owner): the spike measures them on a real offer and the plan records the final values; a figure the spike cannot reach is reported to the owner before the plan.* The figures marked "to confirm" (latency targets, request and page limits, timeout,
  logo limits, margin bounds, the 0.5 % pixel tolerance, the wizard's two seconds) are
  proposals, to be settled by the spike. — owner: architect, in the spike
- [x] **O11** *Resolved 2026-11-16 (owner): all three confirmed.* Defaults chosen while writing, to confirm: restoring creates a new version
  (AC-4.2); a one-page document uses the first-page variant (AC-5.5); a character the font lacks
  prints a mark and is reported, not refused (AC-7.6). — owner: Matteo Codogno
- [x] **O12** *Resolved 2026-11-16 (owner): always, for as long as the service exists; no cap on versions (AC-4.5, AC-4.6).* How long must a stored version reproduce its layout across service upgrades
  (AC-4.5), and is a bound on the number of versions per entity wanted, given that none is
  deleted (AC-4.6)? — owner: Matteo Codogno, with the architect
- [x] **O13** *Resolved 2026-11-16 (owner): immutable at the database level (AC-4.7).* The assurance of the change record (AC-4.7): database-level immutable like the
  financial trails, or application-level like `auth`'s audit log (ADR
  20260804-two-tier-audit-assurance-auth-audit-log-application-level)? — owner: architect, in
  the plan
- [x] **O14** *Resolved 2026-11-16 (owner): templates are written by wellD's developers and shipped with the service; the configurator also sets the look of the block types from a closed set of options, never as code (AC-5.9). Inline runs, header row, column widths and caller images are kept as written.* Content model details assumed here: inline bold, italic and underline in
  paragraphs, a table header row and relative column widths, images sent by callers, and
  templates written by wellD's developers and shipped with the service (a person using the
  configurator does not write them). The owner said "templates wellD writes"; confirm who writes
  them and where. — owner: Matteo Codogno
- [x] **O15** *Resolved 2026-11-16 (owner): recorded in this spec only; specs/20261115-crm-offer-wizard and its ADRs are not edited.* The CRM's earlier decisions for the preview (the paginated HTML preview and the
  browser-drawn letterhead, ADR 20261115-paginated-preview-one-flow-float-rail and ADR
  20261115-letterhead-preview-pdfjs-main-thread-in-the-remote) are replaced by AC-10.3, and the
  wizard's one-second preview by two seconds (AC-10.4). Is the amendment of
  specs/20261115-crm-offer-wizard recorded in that spec, or only in this one? — owner: Matteo
  Codogno

## Amendments

- **2026-11-16 — after the Typst spike (owner approved A1–A5).** The spike that the Constraints
  place before the plan is recorded in `spike.md`. Its findings changed this spec:
  A1 a header or footer zone holds up to four lines (AC-5.2; the brand footer has four);
  A2 each header/footer line has its own size, weight and colour from a closed set (AC-5.2);
  A3 header and footer set their zones' vertical alignment, top or bottom (AC-5.2);
  A4 a word wider than its line or cell is broken at the margin, never drawn outside it (AC-1.6);
  A5 AC-1.3's text and pixel comparisons are defined (whitespace normalised; 1 px, 64/255
  tolerant metric against pdfium). The figures marked "to confirm" (O10) are confirmed as
  written; AC-1.9 and AC-1.10 are measured again on the deployed service.
- **2026-11-16 — after the design stage (owner approved).** Design gap G1: the template editor's
  "Try the wizard" preview, which drew the uploaded letterhead in the browser, uses the service's
  pages after the switch (new AC-10.14). Gaps G2–G10 are plan precisions, recorded in plan.md.
- **2026-11-17 — A6 (orchestrator-proposed during an unattended run; owner to confirm).**
  Implementation found that pdfium cannot extract a character drawn as `.notdef`, so AC-1.3's
  equal text cannot hold on a page with a character the font does not hold (AC-7.6): on
  "漢字 😀 ⨌ ᚠ" the PDF yields "字 ⨌ ᚠ" and the preview, built from the source text, "漢字 😀 ⨌ ᚠ".
  AC-1.3 now allows, only when the answer reports unprintable characters, a PDF text that is the
  preview's text with characters left out, each one a character the font lacks, at most as many
  as reported, never changed, added or reordered; equality stays required everywhere else, and
  the page count and pixel comparison are unchanged. Not owner-approved; the scope is unchanged.
