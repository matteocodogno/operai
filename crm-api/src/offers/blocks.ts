/**
 * An offer as content version 2 of the layout service (specs/20261116-letterhead-service US-10; AC-10.3, AC-10.4,
 * AC-10.14; plan § API contracts, amendments G1, G5 and 2026-11-17 item 3; specs/20261117-legal-entities T28: AC-5.2,
 * AC-6.2, plan decisions 6 and 8).
 *
 * `draftToBlocks` is the one conversion that the wizard's preview, the template editor's "Try the wizard" and the
 * generation of the PDF all go through, so the draft previewed and the draft generated give the same pages
 * (AC-10.3). It does no layout: the service draws the letterhead, the margins, the header, the footer and the page
 * numbers, and breaks the pages. This file only says what the document contains, in the order the renderer
 * (`contractPdf.ts`) printed it:
 *
 *   the salutation and the client, the contacts, the place and date, the title, the index (with an effort annex),
 *   the opening, the numbered sections (the cost table in the one that carries it), the acceptance block, the
 *   list of annexes, each text annex from a new page, and the effort-detail annex from a new page.
 *
 * Everything that has a rule is READ from the offer engine, never recomputed here: the text of every section and
 * the missing values from `resolveOffer`, the numbering of sections, sub-headings and annexes from `numberOffer`,
 * the positions and totals of the cost table from `computeCosts`, the fixed words from `words`, the figures from
 * `format`. A stored (contract) snapshot goes through the same document shape (`snapshotToBlocks`), so an offer
 * generated with a legacy template is converted by the same code.
 *
 * Rules kept here:
 *
 *   missing     a value the person still owes is a run in the `missing` style with the template's label (AC-10.4).
 *               The service highlights it; a generated PDF never has one, because generation refuses an incomplete
 *               draft before it gets here. A cost figure that is not there yet is a `missing` run "–".
 *   pending     the offer's reference before it is assigned (U+E002 label U+E003) is the label in italics, never a
 *               `missing` run: nothing is owed. With `reference` given (an edit keeps its reference, generation has
 *               it) the engine prints the reference itself.
 *   absent      an optional member that is absent is OMITTED (`style`, `bold`, `ordered`, `align`, `header`,
 *               `widthRatio`); `null` is never sent (amendment 2026-11-17, item 3c).
 *   issuer      the issuer's legal name, address, VAT number and IBAN are NOT in the content: the service reads them from
 *               the legal entities registry itself (decision 6; `entityData` is no longer sent, and the content is
 *               version 2 so that an old service, which would print no issuer, refuses it instead). The content names
 *               the version of the registry's details the caller used, `legalEntityVersion`: the service answers 409
 *               `legal_entity_version_mismatch` when it prints another, and the caller rebuilds and retries once
 *               (decision 8: one document, one version of the details; `withIssuerPin` in generation.ts).
 *   deal PDFs   the PDFs appended to the offer are neither drawn nor listed (G5): they are appended by crm-api
 *               after the rendered pages, unnumbered, so the "Allegati:" list names the annexes of the document only.
 *   text        the characters the offer engine already limited are kept as they are, with one exception: the ballot
 *               box of an `option` line (U+25A1), which no bundled font holds, is "[ ]" with a no-break space.
 *
 * What the content model cannot say, and what is done about it:
 *
 *   - an ordered list whose markers are not 1., 2., 3. …, a list with a nested list, and any nested list are
 *     written as paragraphs that start with their marker as written ("a. text") and are indented by no-break
 *     spaces, so no clause reference of a contract ("see 2.b") changes. A flat bulleted list, and a flat list
 *     numbered from 1, are `list` blocks.
 *   - the index of an offer with the effort-detail annex lists its entries without page numbers: the pages are
 *     the service's, and the CRM does not know them when it converts (AC-10.3).
 *   - a cell cannot span columns: a total row of the cost table has its label in the item column.
 *
 * Pure: no I/O, no clock, no database, no environment.
 */

import type { ContractSnapshot, OfferCosts, OfferLanguage } from "./contract";
import { sampleAnswers, sampleContext, type WizardAnswers, type WizardContext } from "./engine/answers";
import { computeCosts, type CostRowIn } from "./engine/costs";
import { formatAmount, formatPercent, shortDate } from "./engine/format";
import { parseMarkup, type Block as MarkupBlock, type CellLine, type ListItem as MarkupListItem, type Run as MarkupRun } from "./engine/markup";
import { numberOffer, type NumberedOffer, type NumberedSection } from "./engine/numbering";
import { BALLOT_BOX } from "./engine/printable";
import { resolveOffer, type InvalidIssue, type Issue, type ResolvedOffer } from "./engine/resolve";
import type { TemplateAst } from "./engine/syntax";
import { words } from "./engine/words";
import { formatManDays } from "./pdf";
import type { Scope } from "./scope";

// ─── Content version 2 (the members of letterhead-api/engine/src/content/model.rs) ───────────────────────────────────

export const CONTENT_VERSION = 2;

/** The legal entities that have a letterhead (the `Entity` enum of the schema, without the generated client). */
export type Entity = "welld_it" | "welld_ch";

export type ContentStyle = "plain" | "muted" | "small" | "right" | "center" | "title" | "missing";
export type ContentAlign = "left" | "center" | "right";

export interface ContentRun {
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly style?: ContentStyle;
}

export interface ContentParagraph {
  readonly type: "paragraph";
  readonly runs: readonly ContentRun[];
  readonly style?: ContentStyle;
}

export interface ContentHeading {
  readonly type: "heading";
  readonly level: 1 | 2 | 3;
  readonly text: string;
  readonly style?: ContentStyle;
}

export interface ContentList {
  readonly type: "list";
  readonly ordered?: true;
  readonly items: readonly { readonly runs: readonly ContentRun[] }[];
  readonly style?: ContentStyle;
}

export type ContentCellBlock = ContentParagraph | ContentList;

export interface ContentTable {
  readonly type: "table";
  /** Relative widths, one per column, above 0. */
  readonly columns: readonly number[];
  readonly align?: readonly ContentAlign[];
  readonly header?: readonly (readonly ContentCellBlock[])[];
  readonly rows: readonly (readonly (readonly ContentCellBlock[])[])[];
  readonly style?: ContentStyle;
}

export interface ContentPageBreak {
  readonly type: "pageBreak";
}

/** Every block this file produces. (`image` is part of the model; an offer has none.) */
export type ContentBlock = ContentParagraph | ContentHeading | ContentList | ContentTable | ContentPageBreak;

/**
 * The body of `POST /v1/render/preview` and `POST /v1/render/pdf`, without `letterheadVersion` (the default: the active one).
 * There is no `entityData`: the issuer's details are the service's to read. `legalEntityVersion` is the version of the
 * registry's details this content was built from (its body prints them, and so does the snapshot beside it). Only a sample
 * that prints nothing of the issuer (the letterhead retirement check) may leave it out: every document is `PinnedContent`.
 */
export interface LetterheadContent {
  readonly contentVersion: typeof CONTENT_VERSION;
  readonly entity: Entity;
  readonly language: OfferLanguage;
  readonly legalEntityVersion?: number;
  readonly blocks: readonly ContentBlock[];
}

/** A document's content: always pinned to the version of the issuer's details it was built from. */
export type PinnedContent = LetterheadContent & { readonly legalEntityVersion: number };

// ─── Inputs and answer ───────────────────────────────────────────────────────────────────────────────────────────────

/** The version of the registry's details a document is built from: the pin its content carries. */
export interface IssuerPin {
  readonly legalEntityVersion: number;
}

/**
 * What a template with no deal prints of the issuer in its body (`[EMITTENTE]`, `[INDIRIZZO]`): the registry's legal name and
 * address in the document's language, with the version they were read from. The header and the footer are the service's.
 */
export interface LetterheadProfile extends IssuerPin {
  readonly legalName: string;
  readonly addressLines: readonly string[];
  /** Printed beside the date; only the try-preview context uses it (a draft's context already holds it). */
  readonly placeOfIssue?: string | null;
}

/** A stored offer draft, or any template with answers: what `resolveOffer` reads. */
export interface DraftInput {
  readonly entity: Entity;
  readonly ast: TemplateAst;
  readonly answers: WizardAnswers;
  readonly context: WizardContext;
  /** The effort detail the offer prints when its answers ask for it; null: there is none to print. */
  readonly annex?: Scope | null;
  /** The offer's reference when it is known (an edit, a generation); null: it is not assigned yet and the title says so. */
  readonly reference?: string | null;
}

/** A template with no deal (G1, AC-10.14): the editor's sample answers, or the template's own samples. */
export interface TemplateInput {
  readonly entity: Entity;
  readonly ast: TemplateAst;
  readonly language: OfferLanguage;
  /** The editor's sample answers; absent: `sampleAnswers`. */
  readonly answers?: WizardAnswers;
  readonly annex?: Scope | null;
}

export interface MissingField {
  readonly name: string;
  /** The template's label; null for a cost line that has none. Never a value. */
  readonly label: string | null;
  readonly step: Issue["step"];
}

export interface DraftBlocks {
  readonly content: PinnedContent;
  /** What the person still owes, from the engine: the preview's list of missing fields. */
  readonly missing: readonly MissingField[];
  /** What the engine refuses in the answers (a figure out of range, a section too long …): generation refuses the draft. */
  readonly invalid: readonly InvalidIssue[];
}

// ─── Entry points ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The offer a stored draft makes, built from the registry's details of version `issuer`: what the draft preview and the generation render. */
export function draftToBlocks(input: DraftInput, issuer: IssuerPin): DraftBlocks {
  const reference = input.reference ?? null;
  const resolved = resolveOffer(input.ast, input.answers, input.context, { reference });
  const printed = printedFromResolved(resolved, { currency: input.context.currency, reference, annex: input.annex ?? null });
  return {
    content: {
      contentVersion: CONTENT_VERSION,
      entity: input.entity,
      language: resolved.language,
      legalEntityVersion: issuer.legalEntityVersion,
      blocks: documentBlocks(printed),
    },
    missing: resolved.missing.map(({ name, label, step }) => ({ name, label, step })),
    invalid: resolved.invalid,
  };
}

/**
 * The same conversion for a template with no deal (G1): a made-up deal in the template's language (`sampleContext`) whose
 * issuer is the registry's, and the sample answers the editor holds (or the template's own). Nothing of the made-up
 * deal is real and none of it is stored.
 */
export function templateToBlocks(input: TemplateInput, profile: LetterheadProfile): DraftBlocks {
  const base = sampleContext(input.language);
  const context: WizardContext = {
    ...base,
    issuerLegalName: profile.legalName,
    issuerAddressLines: profile.addressLines,
    placeOfIssue: profile.placeOfIssue?.trim() ? profile.placeOfIssue.trim() : base.placeOfIssue,
  };
  // The editor's answers are its own; the template's samples take the profile's place of issue like the context does.
  const sample = input.answers ? null : sampleAnswers(input.ast, input.language);
  const answers = input.answers ?? { ...sample!, client: { ...sample!.client, place: context.placeOfIssue } };
  return draftToBlocks({ entity: input.entity, ast: input.ast, answers, context, annex: input.annex ?? null }, profile);
}

/** An offer that was generated before (a contract snapshot, wizard or legacy template) as content, pinned to the registry's version `issuer`. */
export function snapshotToBlocks(snapshot: ContractSnapshot, issuer: IssuerPin, entity: Entity): PinnedContent {
  return {
    contentVersion: CONTENT_VERSION,
    entity,
    language: snapshot.language,
    legalEntityVersion: issuer.legalEntityVersion,
    blocks: documentBlocks(printedFromSnapshot(snapshot)),
  };
}

// ─── The document, as the renderer prints it ─────────────────────────────────────────────────────────────────────────

interface PrintedSection {
  /** Plain text; may carry the marker characters (DD-47). */
  readonly heading: string;
  /** 018 markup. */
  readonly body: string;
  readonly costs: boolean;
}

type PrintedCostRow =
  | { readonly type: "line"; readonly position: string; readonly description: string; readonly unit: Figure; readonly quantity: Figure; readonly total: Figure }
  | { readonly type: "total"; readonly label: string; readonly amount: string };

/** A figure of the cost table: its text, or `null` when the draft has no value for it yet (a `missing` run). */
type Figure = string | null;

interface PrintedCosts {
  readonly columns: { readonly position: boolean; readonly unit: boolean };
  readonly currency: "CHF" | "EUR";
  /** The template's own column headers (plain surfaces), or null for the defaults. */
  readonly labels: { readonly unit: string | null; readonly quantity: string | null };
  readonly rows: readonly PrintedCostRow[];
}

interface PrintedAnnex {
  readonly designation: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly intro: string;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
}

interface PrintedOffer {
  readonly language: OfferLanguage;
  readonly reference: string | null;
  readonly salutation: string;
  readonly clientLines: readonly string[];
  readonly contacts: readonly string[];
  readonly place: string;
  /** `YYYY-MM-DD`; null when the draft has none. */
  readonly issuedOn: string | null;
  readonly opening: string;
  readonly sections: readonly PrintedSection[];
  readonly costs: PrintedCosts | null;
  readonly acceptanceLabel: string | null;
  readonly textAnnexes: readonly PrintedAnnex[];
  /** The effort-detail annex, when the offer prints one. */
  readonly effort: Scope | null;
}

function printedFromResolved(
  resolved: ResolvedOffer,
  extra: { currency: "CHF" | "EUR"; reference: string | null; annex: Scope | null },
): PrintedOffer {
  const { costs } = resolved;
  const result = costs.result;
  const rows: PrintedCostRow[] = [];
  costs.rows.forEach((row, index) => {
    const out = result.rows[index];
    if (row.type === "total") {
      if (!costs.showTotals) return;
      // A span with no counted line (or one still incomplete) prints a dash, never a made-up zero.
      const amount = out?.type === "total" && out.state === "ok" && out.totalCents !== null ? formatAmount(out.totalCents, extra.currency) : "–";
      rows.push({ type: "total", label: row.label, amount });
    } else if (out?.type === "line") {
      rows.push(lineRow(row, out.position, out.totalCents, extra.currency, costs.columns));
    }
  });
  return {
    language: resolved.language,
    reference: extra.reference,
    salutation: resolved.salutation,
    clientLines: resolved.client.lines,
    contacts: resolved.client.contacts,
    place: resolved.client.place,
    issuedOn: resolved.client.date,
    opening: resolved.opening,
    sections: resolved.sections.map(({ heading, body, costs: carries }) => ({ heading, body, costs: carries })),
    costs: { columns: costs.columns, currency: extra.currency, labels: costs.labels, rows },
    acceptanceLabel: resolved.acceptanceLabel,
    textAnnexes: resolved.annexes.map((annex) => ({
      designation: annex.designation,
      title: annex.title,
      subtitle: annex.subtitle,
      intro: annex.intro,
      sections: annex.sections.map(({ heading, body }) => ({ heading, body })),
    })),
    effort: resolved.effortAnnex ? extra.annex : null,
  };
}

/** One cost line as the table prints it (the renderer's `costRow`), `null` for a figure the draft does not have yet. */
function lineRow(
  line: { description: string; kind: CostRowKind; unitCents: number | null; percentBp: number | null; quantity: number | null },
  position: number | null,
  totalCents: number | null,
  currency: "CHF" | "EUR",
  columns: { position: boolean; unit: boolean },
): PrintedCostRow {
  const discount = line.kind === "discount";
  const percent = discount && line.percentBp !== null;
  const sign = discount ? "- " : "";
  const text = line.kind === "option" ? `${BALLOT_BOX} ${line.description}` : line.description;
  const description = percent && !columns.unit ? `${text} (${formatPercent(line.percentBp!)})` : text;
  return {
    type: "line",
    position: position === null ? "" : String(position),
    description,
    unit: percent ? formatPercent(line.percentBp!) : line.unitCents === null ? null : `${sign}${formatAmount(line.unitCents, currency)}`,
    // A percentage discount has no quantity; any other line without one is not finished.
    quantity: percent ? "" : line.quantity === null ? null : String(line.quantity),
    total: totalCents === null ? null : `${sign}${formatAmount(totalCents, currency)}`,
  };
}

type CostRowKind = Extract<CostRowIn, { type: "line" }>["kind"];

/** A stored snapshot: its wizard rows when it has them, else a legacy table (the lines are one span, the TOTAL row of 018). */
function printedCostsOf(costs: OfferCosts, language: OfferLanguage): PrintedCosts {
  const rows: PrintedCostRow[] = [];
  if (costs.rows) {
    const inputs: CostRowIn[] = costs.rows.map((row) =>
      row.type === "total"
        ? { type: "total", label: row.label }
        : { type: "line", name: row.name, kind: row.kind, unitCents: row.unitCents, percentBp: row.percentBp, quantity: row.quantity },
    );
    const result = computeCosts(inputs);
    costs.rows.forEach((row, index) => {
      const out = result.rows[index]!;
      if (row.type === "total") {
        if (!costs.showTotal) return;
        const amount = out.type === "total" && out.state === "ok" && out.totalCents !== null ? formatAmount(out.totalCents, costs.currency) : "–";
        rows.push({ type: "total", label: row.label, amount });
      } else if (out.type === "line") {
        rows.push(lineRow(row, out.position, out.totalCents ?? 0, costs.currency, costs.columns));
      }
    });
  } else {
    const result = computeCosts(
      costs.lines.map((line, index) => ({ type: "line" as const, name: `cost:${index}`, kind: line.kind, unitCents: line.unitCents, percentBp: line.percentBp, quantity: line.quantity })),
    );
    costs.lines.forEach((line, index) => {
      const out = result.rows[index];
      rows.push(lineRow(line, out?.type === "line" ? out.position : null, line.totalCents, costs.currency, costs.columns));
    });
    if (costs.showTotal) rows.push({ type: "total", label: words(language).total, amount: formatAmount(costs.oneOffCents, costs.currency) });
  }
  return { columns: costs.columns, currency: costs.currency, labels: costs.labels ?? { unit: null, quantity: null }, rows };
}

function printedFromSnapshot(snapshot: ContractSnapshot): PrintedOffer {
  return {
    language: snapshot.language,
    reference: snapshot.reference,
    salutation: snapshot.salutation,
    clientLines: snapshot.clientLines,
    contacts: snapshot.contacts,
    place: snapshot.place,
    issuedOn: snapshot.issuedOn,
    opening: snapshot.opening,
    sections: snapshot.sections.map(({ heading, body, costs }) => ({ heading, body, costs })),
    costs: printedCostsOf(snapshot.costs, snapshot.language),
    acceptanceLabel: snapshot.acceptanceLabel,
    textAnnexes: (snapshot.textAnnexes ?? []).map((annex) => ({
      designation: annex.designation,
      title: annex.title,
      subtitle: annex.subtitle,
      intro: annex.intro,
      sections: annex.sections.map(({ heading, body }) => ({ heading, body })),
    })),
    effort: snapshot.annex,
  };
}

// ─── Text: markers, runs ─────────────────────────────────────────────────────────────────────────────────────────────

const MISSING_OPEN = "";
const MISSING_CLOSE = "";
const PENDING_OPEN = "";
const PENDING_CLOSE = "";
const MARKER_CHARACTERS = /[-]/g;
/** What the title prints for a reference that is not assigned yet: the shape of one, never a number that could be taken for real. */
const PENDING_REFERENCE: Record<OfferLanguage, string> = { it: "NNNN/AAAA", en: "NNNN/YYYY" };
/** A no-break space: the box and its text never part. */
const NBSP = " ";
/** U+25A1 is in none of the bundled fonts (it would draw the font's missing-glyph mark and count as unprintable). */
const BOX = `[${NBSP}]`;
const EMPTY_LABEL = "…";

const stripMarkers = (text: string): string => text.replace(MARKER_CHARACTERS, "");
const hasMissing = (text: string): boolean => text.includes(MISSING_OPEN);
const layoutText = (text: string): string => stripMarkers(text).split(BALLOT_BOX).join(BOX);

interface Emphasis {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

function run(text: string, emphasis: Emphasis = {}, style?: ContentStyle): ContentRun {
  return {
    text,
    ...(emphasis.bold ? { bold: true as const } : {}),
    ...(emphasis.italic ? { italic: true as const } : {}),
    ...(emphasis.underline ? { underline: true as const } : {}),
    ...(style !== undefined ? { style } : {}),
  };
}

/** A missing value as a run: the label, highlighted. A label that is empty still shows something to find. */
const missingRun = (label: string, emphasis: Emphasis = {}): ContentRun => run(layoutText(label).trim() === "" ? EMPTY_LABEL : layoutText(label), emphasis, "missing");

/**
 * A plain surface (a heading, a cost description, a column label: DD-47) as runs. The four marker characters are split
 * out, never parsed as markup: a missing value is a `missing` run with its label, the pending reference its label in italics.
 */
function plainRuns(text: string, emphasis: Emphasis = {}): ContentRun[] {
  const runs: ContentRun[] = [];
  let buffer = "";
  let mode: "plain" | "missing" | "pending" = "plain";
  const flush = (): void => {
    if (mode === "missing") runs.push(missingRun(buffer, emphasis));
    else if (mode === "pending") runs.push(run(layoutText(buffer) === "" ? EMPTY_LABEL : layoutText(buffer), { ...emphasis, italic: true }));
    else if (buffer !== "") runs.push(run(layoutText(buffer), emphasis));
    buffer = "";
  };
  for (const char of text) {
    if (char === MISSING_OPEN || char === PENDING_OPEN) {
      flush();
      mode = char === MISSING_OPEN ? "missing" : "pending";
    } else if (char === MISSING_CLOSE || char === PENDING_CLOSE) {
      if (mode !== "plain") flush();
      mode = "plain";
    } else {
      buffer += char;
    }
  }
  // A marker that is never closed holds the rest of the text.
  flush();
  return runs;
}

/** The runs of parsed markup (`parseMarkup`): emphasis as written, a marked run by its mark. */
function markupRuns(source: readonly MarkupRun[]): ContentRun[] {
  const runs: ContentRun[] = [];
  for (const piece of source) {
    const emphasis: Emphasis = { bold: piece.bold, italic: piece.italic, underline: piece.underline };
    if (piece.mark === "missing") {
      runs.push(missingRun(piece.text));
    } else if (piece.mark === "pending") {
      runs.push(run(layoutText(piece.text) === "" ? EMPTY_LABEL : layoutText(piece.text), { italic: true }));
    } else {
      const text = layoutText(piece.text);
      if (text !== "") runs.push(run(text, emphasis));
    }
  }
  return runs;
}

const paragraph = (runs: readonly ContentRun[], style?: ContentStyle): ContentParagraph => ({ type: "paragraph", runs, ...(style !== undefined ? { style } : {}) });
const blank = (): ContentParagraph => paragraph([]);

/** Lines joined with a hard break in one paragraph: the lines of an address stay together. */
function lined(lines: readonly ContentRun[][]): ContentRun[] {
  const runs: ContentRun[] = [];
  lines.forEach((line, index) => {
    if (index > 0) runs.push(run("\n"));
    runs.push(...line);
  });
  return runs;
}

// ─── Markup → blocks ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Headings {
  /** The engine's labels ("2.1 TEXT"), in markup order. */
  readonly labels: readonly string[];
  /** Whether the k-th `###` line holds a missing value. */
  readonly missing: readonly boolean[];
  taken: number;
}

const headingsOf = (labels: readonly string[], body: string): Headings => ({
  labels,
  missing: [...body.matchAll(/^[ \t]*###[ \t]+(.*)$/gm)].map((match) => hasMissing(match[1]!)),
  taken: 0,
});

const INDENT = NBSP.repeat(4);

function markupBlocks(source: readonly MarkupBlock[], headings: Headings | null, depth = 0): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of source) {
    if (block.type === "paragraph") {
      const runs = markupRuns(block.runs);
      if (runs.length > 0) out.push(paragraph(runs));
    } else if (block.type === "heading") {
      const at = headings?.taken ?? 0;
      const label = headings?.labels[at] ?? block.text.toUpperCase();
      const owed = headings?.missing[at] ?? false;
      if (headings) headings.taken += 1;
      out.push({ type: "heading", level: 2, text: layoutText(label), ...(owed ? { style: "missing" as const } : {}) });
    } else if (block.type === "list") {
      out.push(...listBlocks(block, headings, depth));
    } else {
      out.push(tableBlock(block));
    }
  }
  return out;
}

/**
 * A flat bulleted list, or a flat list numbered 1., 2., 3. …, is a `list`. Anything else would change the text the person
 * wrote (a lettered list, a list that starts elsewhere, a list with a nested list, whose numbering a restart would break),
 * so it is paragraphs that start with their marker as written and are indented one step per level.
 */
function listBlocks(list: Extract<MarkupBlock, { type: "list" }>, headings: Headings | null, depth: number): ContentBlock[] {
  const flat = list.items.every((item) => item.children.length === 0);
  const markers = list.ordered ? list.items.every((item, index) => item.marker === `${index + 1}.`) : list.items.every((item) => item.marker === "•");
  if (depth === 0 && flat && markers) {
    return [{ type: "list", ...(list.ordered ? { ordered: true as const } : {}), items: list.items.map((item) => ({ runs: markupRuns(item.runs) })) }];
  }
  const out: ContentBlock[] = [];
  for (const item of list.items as MarkupListItem[]) {
    out.push(paragraph([run(`${INDENT.repeat(depth)}${item.marker} `), ...markupRuns(item.runs)]));
    out.push(...markupBlocks(item.children, headings, depth + 1));
  }
  return out;
}

/** The cell of a table: bullet lines together are one list, every other line a paragraph. */
function cellBlocks(lines: readonly CellLine[]): ContentCellBlock[] {
  const out: ContentCellBlock[] = [];
  let bullets: { runs: ContentRun[] }[] = [];
  const closeList = (): void => {
    if (bullets.length > 0) out.push({ type: "list", items: bullets });
    bullets = [];
  };
  for (const line of lines) {
    const runs = markupRuns(line.runs);
    if (line.bullet) {
      bullets.push({ runs });
    } else {
      closeList();
      if (runs.length > 0) out.push(paragraph(runs));
    }
  }
  closeList();
  return out;
}

const cellTextLength = (cell: readonly CellLine[]): number => cell.reduce((sum, line) => sum + line.runs.reduce((n, piece) => n + piece.text.length, 0), 0);

/** A markup table: the header and the rows have one cell per column; a column's weight is the text it holds, between 8 and 60. */
function tableBlock(table: Extract<MarkupBlock, { type: "table" }>): ContentTable {
  const width = Math.max(1, table.header.length);
  const fit = <T>(row: readonly T[], empty: T): T[] => Array.from({ length: width }, (_, index) => row[index] ?? empty);
  const header = fit(table.header, [] as readonly CellLine[]);
  const rows = table.rows.map((row) => fit(row, [] as readonly CellLine[]));
  const columns = Array.from({ length: width }, (_, index) => Math.min(60, Math.max(8, ...[header, ...rows].map((row) => cellTextLength(row[index]!)))));
  return { type: "table", columns, header: header.map(cellBlocks), rows: rows.map((row) => row.map(cellBlocks)) };
}

// ─── The cost table ──────────────────────────────────────────────────────────────────────────────────────────────────

const cell = (runs: readonly ContentRun[]): ContentCellBlock[] => (runs.length === 0 ? [] : [paragraph(runs)]);
const textCell = (text: string, emphasis: Emphasis = {}): ContentCellBlock[] => cell(text === "" ? [] : [run(layoutText(text), emphasis)]);
const figureCell = (figure: Figure): ContentCellBlock[] => (figure === null ? cell([missingRun("–")]) : textCell(figure));

function costTable(costs: PrintedCosts, language: OfferLanguage): ContentTable {
  const t = words(language);
  const { columns, currency, labels } = costs;
  const unitLabel = labels.unit ?? t.unit(currency);
  const quantityLabel = labels.quantity ?? t.quantity;
  const head: ContentCellBlock[][] = [
    ...(columns.position ? [textCell(t.position)] : []),
    textCell(t.item),
    ...(columns.unit ? [cell(plainRuns(unitLabel)), cell(plainRuns(quantityLabel))] : []),
    textCell(t.amount(currency)),
  ];
  const itemColumn = columns.position ? 1 : 0;
  const rows = costs.rows.map((row): ContentCellBlock[][] => {
    if (row.type === "total") {
      const cells: ContentCellBlock[][] = head.map(() => []);
      cells[itemColumn] = cell(plainRuns(row.label, { bold: true }));
      cells[cells.length - 1] = textCell(row.amount, { bold: true });
      return cells;
    }
    return [
      ...(columns.position ? [textCell(row.position)] : []),
      cell(plainRuns(row.description)),
      ...(columns.unit ? [figureCell(row.unit), figureCell(row.quantity)] : []),
      figureCell(row.total),
    ];
  });
  // Weights: position 1, item 6, unit 2, quantity 1, total 2.
  const weights = [...(columns.position ? [1] : []), 6, ...(columns.unit ? [2, 1] : []), 2];
  const align: ContentAlign[] = [...(columns.position ? ["left" as const] : []), "left", ...(columns.unit ? ["right" as const, "right" as const] : []), "right"];
  return { type: "table", columns: weights, align, header: head, rows };
}

// ─── The effort annex ────────────────────────────────────────────────────────────────────────────────────────────────

function effortTable(scope: Scope, language: OfferLanguage): ContentTable {
  const t = words(language);
  const days = (tenths: number): string => formatManDays(tenths, language);
  const rows: ContentCellBlock[][][] = [];
  for (const release of scope.releases) {
    rows.push([textCell(release.name, { bold: true }), [], textCell(days(release.manDaysTenths), { bold: true })]);
    for (const epic of release.epics) rows.push([[], textCell(epic.epic), textCell(days(epic.manDaysTenths))]);
  }
  rows.push([textCell(t.annexTotal, { bold: true }), [], textCell(days(scope.manDaysTenths), { bold: true })]);
  return {
    type: "table",
    columns: [3, 5, 2],
    align: ["left", "left", "right"],
    header: [textCell(t.release), textCell(t.epic), textCell(t.manDays)],
    rows,
  };
}

// ─── The document ────────────────────────────────────────────────────────────────────────────────────────────────────

const SIGNATURE_RULE = "_".repeat(30);

function documentBlocks(offer: PrintedOffer): ContentBlock[] {
  const t = words(offer.language);
  const sectionKey = (index: number): string => `section:${index}`;
  const numbering: NumberedOffer = numberOffer({
    language: offer.language,
    // Headings and titles are plain surfaces (DD-47): a marker character is split out before numbering prints them.
    sections: offer.sections.map((section, index) => ({ key: sectionKey(index), heading: stripMarkers(section.heading), body: section.body })),
    annexes: offer.textAnnexes.map((annex) => ({
      designation: annex.designation,
      title: stripMarkers(annex.title),
      sections: annex.sections.map((section, index) => ({ key: `annex:${annex.designation}:${index}`, heading: stripMarkers(section.heading), body: section.body })),
    })),
    effortAnnex: offer.effort !== null,
    // The deal PDFs are appended by crm-api and are not part of the rendered document (G5).
    attachmentNames: [],
  });

  const out: ContentBlock[] = [];

  // — page 1: salutation, client, contacts, place and date, title —
  const head: ContentRun[][] = [plainRuns(offer.salutation)];
  offer.clientLines.forEach((line, index) => head.push(plainRuns(line, { bold: index === 0 })));
  out.push(paragraph(lined(head.filter((line) => line.length > 0))));
  if (offer.contacts.length > 0) out.push(paragraph(plainRuns(`${t.attn} ${offer.contacts.join(", ")}`, { bold: true })));
  const date = offer.issuedOn === null ? "" : shortDate(offer.issuedOn);
  const place = offer.place.trim();
  const dateLine = place !== "" && date !== "" ? `${place}, ${date}` : place !== "" ? place : date;
  if (dateLine !== "") out.push(paragraph(plainRuns(dateLine), "right"));
  const reference = offer.reference ?? PENDING_REFERENCE[offer.language];
  out.push(paragraph([run(layoutText(t.title(reference)), offer.reference === null ? { italic: true } : {}, "title")], "center"));

  // — index, only with the effort-detail annex: the entries, without page numbers (the pages are the service's) —
  if (numbering.index) {
    out.push(paragraph([run(t.index, { bold: true })]));
    out.push(paragraph(lined(numbering.index.map((entry) => [run(layoutText(entry.label))]))));
  }

  out.push(...markupBlocks(parseMarkup(offer.opening), null));

  // — sections —
  const sectionBlocks = (numbered: NumberedSection, source: { heading: string; body: string }, withCosts: boolean): void => {
    out.push({ type: "heading", level: 1, text: layoutText(numbered.heading), ...(hasMissing(source.heading) ? { style: "missing" as const } : {}) });
    if (withCosts && offer.costs) out.push(costTable(offer.costs, offer.language));
    out.push(...markupBlocks(parseMarkup(source.body), headingsOf(numbered.subheadings, source.body)));
  };
  offer.sections.forEach((section, index) => sectionBlocks(numbering.sections[index]!, section, section.costs));

  // — acceptance —
  out.push(paragraph([run(t.acceptance, { bold: true })]));
  if (offer.acceptanceLabel) out.push(paragraph(plainRuns(offer.acceptanceLabel, { bold: true })));
  for (const label of [t.place, t.signature]) {
    out.push(blank());
    out.push(paragraph([run(`${label}  ${SIGNATURE_RULE}`)]));
  }

  // — annexes list: the annexes of the document, never the deal PDFs (G5) —
  if (numbering.annexList.length > 0) {
    out.push(paragraph([run(t.annexes, { bold: true })]));
    out.push({ type: "list", items: numbering.annexList.map((entry) => ({ runs: [run(layoutText(entry))] })) });
  }

  // — text annexes: each from a new page, in template order, before the effort-detail annex —
  offer.textAnnexes.forEach((annex, index) => {
    const numbered = numbering.annexes[index]!;
    out.push({ type: "pageBreak" });
    out.push({ type: "heading", level: 1, text: layoutText(numbered.heading), ...(hasMissing(annex.title) ? { style: "missing" as const } : {}) });
    const subtitle = annex.subtitle === null ? [] : plainRuns(annex.subtitle.trim(), { italic: true });
    if (subtitle.length > 0) out.push(paragraph(subtitle));
    out.push(...markupBlocks(parseMarkup(annex.intro), null));
    annex.sections.forEach((section, at) => sectionBlocks(numbered.sections[at]!, section, false));
  });

  // — the effort-detail annex —
  if (offer.effort && numbering.effortAnnexLetter) {
    out.push({ type: "pageBreak" });
    out.push({ type: "heading", level: 1, text: layoutText(t.annexHeading(numbering.effortAnnexLetter)) });
    if (offer.effort.aiAssisted) out.push(paragraph([run(t.aiNote, { italic: true })]));
    out.push(effortTable(offer.effort, offer.language));
  }

  return out;
}
