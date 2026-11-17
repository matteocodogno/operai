/**
 * `draftToBlocks` (specs/20261116-letterhead-service T27; AC-10.3, AC-10.4, AC-10.10, AC-10.14; plan amendments G1, G5,
 * 2026-11-17 item 3).
 *
 * The proof that the engine accepts what is built is `validateContent` below: a structural check in TypeScript that mirrors,
 * rule by rule, letterhead-api's `engine/src/content/validate.rs` (member names, types, limits, styles including
 * `missing`, null only where the plan allows it). It does NOT run the Rust validator and it did not call a running
 * service: the checker is itself tested first, on the refusals the Rust tests pin (`the validator itself`). When the Rust
 * rules change, this one changes in the same commit.
 *
 * Against it: the seven Italian seeds (three variants and the golden answers of the mockup) and an English template that
 * has every construct, converted as a draft, as a template with no deal (G1) and, for the English legacy templates, as a
 * stored contract snapshot. Beside it, the offer engine's own oracle of the PDF's text (`documentText`, the one the preview
 * ≡ PDF proof uses): the text of the content must equal it, apart from the differences this file lists.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenToAnswers, type GoldenState } from "../offer-templates/wizardSeeds/goldenAnswers";
import { WELLD_CH_IT_V1 } from "../offer-templates/wizardSeeds/welldChIt";
import { costsOf, documentText } from "../test-support/documentText";
import {
  CONTENT_VERSION,
  draftToBlocks,
  snapshotToBlocks,
  templateToBlocks,
  type ContentBlock,
  type DraftBlocks,
  type LetterheadContent,
  type LetterheadProfile,
} from "./blocks";
import type { ContractSnapshot, OfferCosts } from "./contract";
import { DEFAULT_TEMPLATES_EN } from "./defaultTemplates.en";
import { DEFAULT_TEMPLATES_IT } from "./defaultTemplates";
import { initialAnswers, sampleAnswers, sampleContext, setBlock, type WizardAnswers, type WizardContext } from "./engine/answers";
import { numberOffer } from "./engine/numbering";
import { BALLOT_BOX } from "./engine/printable";
import { resolveOffer } from "./engine/resolve";
import { parseTemplate, type TemplateAst } from "./engine/syntax";
import type { Scope } from "./scope";

// ─── The validator: letterhead-api/engine/src/content/validate.rs, in TypeScript ──────────────────────────────────────

interface Problem {
  readonly path: string;
  readonly reason: string;
}

interface Verdict {
  /** A request-level code (`unsupported_content_version` …) or `content_too_large`, else null. */
  readonly rejection: string | null;
  readonly problems: Problem[];
}

const MAX_BLOCKS = 5_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_PROBLEMS = 20;
const MAX_COLUMN_WEIGHT = 1_000_000;
const STYLES = ["plain", "muted", "small", "right", "center", "title", "missing"];
const ALIGNS = ["left", "center", "right"];
const ENTITIES = ["welld_it", "welld_ch"];
const LANGUAGES = ["it", "en"];
const ROOT_MEMBERS_V1 = ["contentVersion", "entity", "letterheadVersion", "language", "entityData", "blocks"];
/** Version 2 adds the pin of the issuer's details; a version 1 request that carries it is refused as an unknown member. */
const ROOT_MEMBERS = [...ROOT_MEMBERS_V1.slice(0, 3), "legalEntityVersion", ...ROOT_MEMBERS_V1.slice(3)];
const ENTITY_DATA_MEMBERS = ["legalName", "addressLines", "vat", "iban", "contacts"];
const MEMBERS: Record<string, string[]> = {
  heading: ["type", "level", "text", "style"],
  paragraph: ["type", "runs", "style"],
  list: ["type", "ordered", "items", "style"],
  table: ["type", "columns", "align", "header", "rows", "style"],
  image: ["type", "data", "widthRatio", "style"],
  pageBreak: ["type"],
};
const RUN_MEMBERS = ["text", "bold", "italic", "underline", "style"];
const BLOCK_TYPES = Object.keys(MEMBERS);
const CELL_BLOCK_TYPES = ["paragraph", "list"];
const IMAGE_REFERENCE_MEMBERS = ["url", "uri", "href", "src", "source", "path", "file"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const chars = (text: string): number => [...text].length;

/** The request as the service receives it: JSON, so an `undefined` member is gone and a `null` stays. */
export function validateContent(content: unknown): Verdict {
  const problems: Problem[] = [];
  let units = 0;
  let limit: string | null = null;
  const problem = (path: string, reason: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push({ path, reason });
  };
  const reach = (name: string): void => {
    limit ??= name;
  };
  const unit = (): void => {
    units += 1;
    if (units > MAX_BLOCKS) reach("content_too_large");
  };
  /** A text adds its characters to a total; one that adds none counts as one (an empty run cannot escape the limit). */
  const count = (total: { n: number }, text: string): void => {
    total.n += Math.max(chars(text), 1);
    if (total.n > MAX_TEXT_CHARS) reach("content_too_large");
  };
  const unknownMembers = (object: Record<string, unknown>, at: string, allowed: readonly string[]): void => {
    if (Object.keys(object).some((key) => !allowed.includes(key))) problem(at, "unknown_member");
  };
  const optionalBool = (object: Record<string, unknown>, key: string, at: string): void => {
    if (key in object && typeof object[key] !== "boolean") problem(`${at}/${key}`, "wrong_type");
  };
  const optionalStyle = (object: Record<string, unknown>, at: string): void => {
    if (!("style" in object)) return;
    const value = object["style"];
    if (typeof value !== "string") problem(`${at}/style`, "wrong_type");
    else if (!STYLES.includes(value)) problem(`${at}/style`, "unknown_style");
  };
  const requiredString = (object: Record<string, unknown>, key: string, at: string): string => {
    if (!(key in object)) {
      problem(`${at}/${key}`, "missing_member");
      return "";
    }
    const value = object[key];
    if (typeof value !== "string") {
      problem(`${at}/${key}`, "wrong_type");
      return "";
    }
    return value;
  };

  const runs = (value: unknown, at: string, total: { n: number }): void => {
    if (!Array.isArray(value)) return problem(at, "wrong_type");
    value.forEach((item, index) => {
      if (limit) return;
      const here = `${at}/${index}`;
      if (!isObject(item)) return problem(here, "wrong_type");
      unknownMembers(item, here, RUN_MEMBERS);
      count(total, requiredString(item, "text", here));
      for (const flag of ["bold", "italic", "underline"]) optionalBool(item, flag, here);
      optionalStyle(item, here);
    });
  };
  const paragraph = (object: Record<string, unknown>, at: string): void => {
    unknownMembers(object, at, MEMBERS["paragraph"]!);
    optionalStyle(object, at);
    const total = { n: 0 };
    if (!("runs" in object)) problem(`${at}/runs`, "missing_member");
    else runs(object["runs"], `${at}/runs`, total);
  };
  const list = (object: Record<string, unknown>, at: string): void => {
    unknownMembers(object, at, MEMBERS["list"]!);
    optionalStyle(object, at);
    optionalBool(object, "ordered", at);
    const total = { n: 0 };
    if (!("items" in object)) return problem(`${at}/items`, "missing_member");
    const items = object["items"];
    if (!Array.isArray(items)) return problem(`${at}/items`, "wrong_type");
    items.forEach((item, index) => {
      if (limit) return;
      const here = `${at}/items/${index}`;
      if (!isObject(item)) return problem(here, "wrong_type");
      unknownMembers(item, here, ["runs"]);
      if (!("runs" in item)) problem(`${here}/runs`, "missing_member");
      else runs(item["runs"], `${here}/runs`, total);
    });
  };
  const cell = (value: unknown, at: string): void => {
    if (!Array.isArray(value)) return problem(at, "wrong_type");
    if (value.length === 0) unit();
    value.forEach((item, index) => {
      if (limit) return;
      const here = `${at}/${index}`;
      if (!isObject(item)) return problem(here, "wrong_type");
      const kind = item["type"];
      if (kind === undefined) return problem(`${here}/type`, "missing_member");
      if (typeof kind !== "string") return problem(`${here}/type`, "wrong_type");
      if (!CELL_BLOCK_TYPES.includes(kind)) return problem(`${here}/type`, "unknown_block_type");
      unit();
      if (limit) return;
      if (kind === "paragraph") paragraph(item, here);
      else list(item, here);
    });
  };
  const row = (value: unknown, at: string, width: number): void => {
    if (!Array.isArray(value)) return problem(at, "wrong_type");
    if (value.length !== width) problem(at, "column_count_mismatch");
    value.forEach((item, index) => {
      if (!limit) cell(item, `${at}/${index}`);
    });
  };
  const table = (object: Record<string, unknown>, at: string): void => {
    unknownMembers(object, at, MEMBERS["table"]!);
    optionalStyle(object, at);
    let width = 0;
    if (!("columns" in object)) problem(`${at}/columns`, "missing_member");
    else if (!Array.isArray(object["columns"])) problem(`${at}/columns`, "wrong_type");
    else {
      const columns = object["columns"];
      width = columns.length;
      if (columns.length === 0) problem(`${at}/columns`, "no_columns");
      columns.forEach((weight, index) => {
        if (typeof weight !== "number") problem(`${at}/columns/${index}`, "wrong_type");
        else if (!(weight > 0 && weight <= MAX_COLUMN_WEIGHT)) problem(`${at}/columns/${index}`, "out_of_range");
      });
    }
    if ("align" in object) {
      const align = object["align"];
      if (!Array.isArray(align)) problem(`${at}/align`, "wrong_type");
      else {
        if (align.length > width) problem(`${at}/align`, "column_count_mismatch");
        align.forEach((item, index) => {
          if (typeof item !== "string") problem(`${at}/align/${index}`, "wrong_type");
          else if (!ALIGNS.includes(item)) problem(`${at}/align/${index}`, "out_of_range");
        });
      }
    }
    if ("header" in object) row(object["header"], `${at}/header`, width);
    if (!("rows" in object)) problem(`${at}/rows`, "missing_member");
    else if (!Array.isArray(object["rows"])) problem(`${at}/rows`, "wrong_type");
    else {
      object["rows"].forEach((item, index) => {
        if (!limit) row(item, `${at}/rows/${index}`, width);
      });
    }
  };
  const heading = (object: Record<string, unknown>, at: string): void => {
    unknownMembers(object, at, MEMBERS["heading"]!);
    optionalStyle(object, at);
    if (!("level" in object)) problem(`${at}/level`, "missing_member");
    else {
      const level = object["level"];
      if (typeof level !== "number") problem(`${at}/level`, "wrong_type");
      else if (!Number.isInteger(level) || level < 1 || level > 3) problem(`${at}/level`, "out_of_range");
    }
    count({ n: 0 }, requiredString(object, "text", at));
  };

  const image = (object: Record<string, unknown>, at: string): void => {
    // A block that names an address is refused whatever else it holds; the bytes are judged by the service's asset rules.
    for (const name of IMAGE_REFERENCE_MEMBERS) if (name in object) problem(`${at}/${name}`, "external_reference");
    unknownMembers(object, at, [...MEMBERS["image"]!, ...IMAGE_REFERENCE_MEMBERS]);
    optionalStyle(object, at);
    const data = requiredString(object, "data", at);
    if ("data" in object && typeof object["data"] === "string" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) problem(`${at}/data`, "invalid_base64");
    if ("data" in object && data === "") problem(`${at}/data`, "invalid_base64");
    if ("widthRatio" in object) {
      const ratio = object["widthRatio"];
      if (typeof ratio !== "number") problem(`${at}/widthRatio`, "wrong_type");
      else if (!(ratio > 0 && ratio <= 1)) problem(`${at}/widthRatio`, "out_of_range");
    }
  };

  const blocks = (value: unknown, at: string): void => {
    if (!Array.isArray(value)) return problem(at, "wrong_type");
    if (value.length > MAX_BLOCKS) return reach("content_too_large");
    value.forEach((item, index) => {
      if (limit) return;
      const here = `${at}/${index}`;
      if (!isObject(item)) return problem(here, "wrong_type");
      const kind = item["type"];
      if (kind === undefined) return problem(`${here}/type`, "missing_member");
      if (typeof kind !== "string") return problem(`${here}/type`, "wrong_type");
      if (!BLOCK_TYPES.includes(kind)) return problem(`${here}/type`, "unknown_block_type");
      unit();
      if (limit) return;
      if (kind === "heading") heading(item, here);
      else if (kind === "paragraph") paragraph(item, here);
      else if (kind === "list") list(item, here);
      else if (kind === "table") table(item, here);
      else if (kind === "image") image(item, here);
      else unknownMembers(item, here, MEMBERS["pageBreak"]!);
    });
  };

  if (!isObject(content)) return { rejection: null, problems: [{ path: "", reason: "wrong_type" }] };
  // The envelope first, each with its own code.
  const contentVersion = content["contentVersion"];
  if (contentVersion !== 1 && contentVersion !== 2) return { rejection: "unsupported_content_version", problems: [] };
  if (typeof content["entity"] !== "string" || !ENTITIES.includes(content["entity"])) return { rejection: "unknown_entity", problems: [] };
  if (typeof content["language"] !== "string" || !LANGUAGES.includes(content["language"])) return { rejection: "unsupported_language", problems: [] };

  unknownMembers(content, "", contentVersion === 2 ? ROOT_MEMBERS : ROOT_MEMBERS_V1);
  const version = content["letterheadVersion"];
  if (version !== undefined && version !== null) {
    if (typeof version !== "number") problem("/letterheadVersion", "wrong_type");
    else if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647) problem("/letterheadVersion", "out_of_range");
  }
  const pin = content["legalEntityVersion"];
  if (contentVersion === 2 && pin !== undefined && pin !== null) {
    if (typeof pin !== "number") problem("/legalEntityVersion", "wrong_type");
    else if (!Number.isInteger(pin) || pin < 1 || pin > 2_147_483_647) problem("/legalEntityVersion", "out_of_range");
  }
  // `entityData` is read for its shape in both versions and then ignored by the service (AC-5.2).
  const data = content["entityData"];
  if (data !== undefined && data !== null) {
    if (!isObject(data)) problem("/entityData", "wrong_type");
    else {
      unknownMembers(data, "/entityData", ENTITY_DATA_MEMBERS);
      for (const key of ["legalName", "vat", "iban", "contacts"]) {
        const text = data[key];
        if (text === undefined || text === null) continue;
        if (typeof text !== "string") problem(`/entityData/${key}`, "wrong_type");
        else count({ n: 0 }, text);
      }
      const lines = data["addressLines"];
      if (lines !== undefined && lines !== null) {
        if (!Array.isArray(lines)) problem("/entityData/addressLines", "wrong_type");
        else {
          const total = { n: 0 };
          lines.forEach((line, index) => {
            if (typeof line !== "string") problem(`/entityData/addressLines/${index}`, "wrong_type");
            else count(total, line);
          });
        }
      }
    }
  }
  if (!("blocks" in content)) problem("/blocks", "missing_member");
  else blocks(content["blocks"], "/blocks");
  // A limit that is reached wins over problems, because the request is refused whatever else it holds.
  if (limit) return { rejection: limit, problems: [] };
  return { rejection: null, problems };
}

/** What the service receives: the content serialised and parsed again. */
const onTheWire = (content: unknown): unknown => JSON.parse(JSON.stringify(content));

function expectAccepted(content: LetterheadContent, label: string): void {
  const verdict = validateContent(onTheWire(content));
  expect({ label, ...verdict }).toEqual({ label, rejection: null, problems: [] });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The version of the registry's details the content is built from, and what a template with no deal prints of the issuer. */
const PROFILE: LetterheadProfile = { legalName: "wellD Sagl", addressLines: ["Via Pessina 9", "6900 Lugano"], legalEntityVersion: 4 };
const REFERENCE = "0017/2026";

/** A stored legacy (contract) snapshot, to convert: its issuer is the one the registry had when it was made. */
const SNAPSHOT: ContractSnapshot = (() => {
  const template = DEFAULT_TEMPLATES_IT[0]!;
  return {
    kind: "contract",
    template: { id: "t", name: template.name },
    language: "it",
    reference: REFERENCE,
    issuedOn: "2026-11-17",
    validUntil: "2026-12-17",
    validityDays: 30,
    place: "Lugano",
    issuer: { legalName: PROFILE.legalName, addressLines: PROFILE.addressLines, vatNumber: "CHE-123.456.789 IVA", iban: "CH93 0076 2011 6238 5295 7" },
    legalEntityVersion: PROFILE.legalEntityVersion,
    salutation: template.salutation,
    clientLines: ["Acme SA"],
    contacts: [],
    opening: template.opening,
    sections: template.sections,
    costs: { currency: "CHF", columns: template.costColumns, showTotal: true, lines: [{ description: "Voce", kind: "one_off", unitCents: 100_000, percentBp: null, quantity: 2, totalCents: 200_000 }], oneOffCents: 200_000, yearlyCents: 0 },
    acceptanceLabel: template.acceptanceLabel,
    annex: null,
    attachments: [],
    aiAssisted: false,
    preparedBy: null,
  };
})();
const GOLDEN_DIR = join(import.meta.dir, "..", "offer-templates", "wizardSeeds", "golden");

const EFFORT: Scope = {
  aiAssisted: true,
  releases: [
    { name: "Release 1", epics: [{ epic: "Login e profilo", manDaysTenths: 125 }, { epic: "Consumi", manDaysTenths: 80 }], manDaysTenths: 205 },
    { name: "Release 2", epics: [{ epic: "Segnalazioni", manDaysTenths: 60 }], manDaysTenths: 60 },
  ],
  manDaysTenths: 265,
};

/** An English wizard template with every construct the converter handles. */
const ENGLISH_SOURCE = [
  "@@salutation Dear Sirs",
  "@@acceptance The Client",
  "",
  "Further to our talks we submit our offer to [CLIENT], ref. [REF].",
  "{{!NOTE::No notes.}}",
  "",
  "## SCOPE",
  "@@step scope",
  "The project is **[TITLE]** of [DATE], at the *agreed* terms.",
  "{{?NOTE::Note: [NOTE]}}",
  "",
  "a. First deliverable",
  "b. Second deliverable",
  "  - nested one",
  "  - nested two",
  "",
  "- [ITEMS]",
  "",
  "| Activity | Days |",
  "|---|---|",
  "| [ACT] | [DAYS] |",
  "",
  "### Terms",
  "Payment within 30 days.",
  "",
  "## COSTS",
  "@@step costs",
  "@@costs position unit",
  "@@line main one_off | **[TITLE]** | unit=[RATE] | qty=1",
  "@@line extra option | Optional training | unit=? | qty=1",
  "@@line promo discount | Loyalty discount | unit=?",
  "@@total **TOTAL**",
  "@@end",
  "Costs note.",
  "",
  "@@annex A Technical annex",
  "@@subtitle Ref [REF]",
  "Intro text for [TITLE].",
  "",
  "## DETAILS",
  "Details of the work.",
  "",
  "@@field CLIENT",
  "source: client",
  "",
  "@@field REF",
  "label: Reference",
  "source: reference",
  "",
  "@@field DATE",
  "source: date",
  "",
  "@@field TITLE",
  "label: Title",
  "",
  "@@field NOTE",
  "label: Note",
  "",
  "@@field RATE",
  "label: Rate",
  "kind: amount",
  "",
  "@@field DAYS",
  "label: Days",
  "kind: number",
  "",
  "@@list ITEMS",
  "label: Items",
  "",
  "@@table ACT",
  "label: Activities",
  "columns: ACT, DAYS",
  "",
].join("\n");

interface Case {
  readonly name: string;
  readonly ast: TemplateAst;
  readonly language: "it" | "en";
  readonly answers: WizardAnswers;
  readonly context: WizardContext;
  readonly annex: Scope | null;
}

function seedCases(): Case[] {
  const out: Case[] = [];
  for (const seed of WELLD_CH_IT_V1) {
    const { ast } = parseTemplate(seed.source);
    for (const variant of ["defaults", "everything", "annexes"] as const) {
      const context = sampleContext("it");
      let answers = sampleAnswers(ast, "it");
      if (variant !== "defaults") {
        const options = new Set(ast.choices.flatMap((choice) => choice.options));
        for (const block of ast.blocks) if (!options.has(block.name)) answers = setBlock(ast, answers, block.name, true);
      }
      if (variant === "annexes") answers = { ...answers, effortAnnex: true };
      out.push({ name: `${seed.code} ${variant}`, ast, language: "it", answers, context, annex: variant === "annexes" ? EFFORT : null });
    }
    const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, `answers.${seed.code}.json`), "utf8")) as GoldenState;
    const mapped = goldenToAnswers(seed.code, golden, ast);
    expect(mapped.unmapped).toEqual([]);
    out.push({ name: `${seed.code} golden`, ast, language: "it", answers: { ...mapped.answers, effortAnnex: seed.code === "T1" }, context: mapped.context, annex: seed.code === "T1" ? EFFORT : null });
  }
  const english = parseTemplate(ENGLISH_SOURCE);
  expect(english.problems).toEqual([]);
  for (const variant of ["defaults", "everything", "annexes"] as const) {
    const context = sampleContext("en");
    let answers = sampleAnswers(english.ast, "en");
    if (variant !== "defaults") for (const block of english.ast.blocks) answers = setBlock(english.ast, answers, block.name, true);
    if (variant === "annexes") answers = { ...answers, effortAnnex: true };
    out.push({ name: `English ${variant}`, ast: english.ast, language: "en", answers, context, annex: variant === "annexes" ? { ...EFFORT, aiAssisted: false } : null });
  }
  return out;
}

const CASES = seedCases();

const draftOf = (item: Case, reference: string | null = REFERENCE): DraftBlocks =>
  draftToBlocks({ entity: "welld_ch", ast: item.ast, answers: item.answers, context: item.context, annex: item.annex, reference }, PROFILE);

/** Every text of the content, in reading order, one string per piece. */
function textsOf(blocks: readonly ContentBlock[]): string[] {
  const out: string[] = [];
  const cellBlocks = (cell: readonly { type: string }[]): void => {
    for (const block of cell as ContentBlock[]) visit(block);
  };
  const visit = (block: ContentBlock): void => {
    if (block.type === "heading") out.push(block.text);
    else if (block.type === "paragraph") for (const run of block.runs) out.push(run.text);
    else if (block.type === "list") for (const item of block.items) for (const run of item.runs) out.push(run.text);
    else if (block.type === "table") {
      for (const cell of block.header ?? []) cellBlocks(cell);
      for (const row of block.rows) for (const cell of row) cellBlocks(cell);
    }
  };
  for (const block of blocks) visit(block);
  return out;
}

/** Every object of the content, whatever its depth. */
function* walk(value: unknown): Generator<unknown> {
  yield value;
  if (Array.isArray(value)) for (const item of value) yield* walk(item);
  else if (isObject(value)) for (const item of Object.values(value)) yield* walk(item);
}

const squash = (text: string): string => text.replace(/\s+/g, "");

// ─── The validator itself ────────────────────────────────────────────────────────────────────────────────────────────

const para = (text: string): ContentBlock => ({ type: "paragraph", runs: [{ text }] });
const request = (blocks: unknown, over: Record<string, unknown> = {}): unknown => ({ contentVersion: 2, entity: "welld_it", language: "it", blocks, ...over });
const problemsOf = (value: unknown): [string, string][] => validateContent(value).problems.map((p) => [p.path, p.reason]);

describe("the validator itself: it refuses what letterhead-api's tests pin, so its acceptance means something", () => {
  it("accepts a full request and every named style, `missing` included, on a block and on a run", () => {
    for (const style of ["plain", "muted", "small", "right", "center", "title", "missing"]) {
      expect(problemsOf(request([{ type: "paragraph", runs: [{ text: "x", style }], style }]))).toEqual([]);
    }
    expect(validateContent(request([{ type: "pageBreak" }, { type: "heading", level: 3, text: "t" }, { type: "list", ordered: true, items: [{ runs: [] }] }]))).toEqual({ rejection: null, problems: [] });
  });

  it("accepts every request of the engine's own golden corpus (its offers, tables, lists, glyphs, overflow cases): the checker is not stricter than the service", () => {
    const dir = join(import.meta.dir, "..", "..", "..", "letterhead-api", "engine", "tests", "golden", "fixtures");
    const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as { request: unknown };
      expect({ file, ...validateContent(fixture.request) }).toEqual({ file, rejection: null, problems: [] });
    }
  });

  it("accepts null only for letterheadVersion, legalEntityVersion, entityData and each entityData member", () => {
    expect(validateContent(request([para("x")], { letterheadVersion: null, legalEntityVersion: null, entityData: null }))).toEqual({ rejection: null, problems: [] });
    expect(validateContent(request([para("x")], { entityData: { legalName: null, addressLines: null, vat: null, iban: null, contacts: null } }))).toEqual({ rejection: null, problems: [] });
  });

  it("refuses null on every other optional member as wrong_type", () => {
    expect(problemsOf(request([{ type: "paragraph", runs: [{ text: "x" }], style: null }]))).toEqual([["/blocks/0/style", "wrong_type"]]);
    expect(problemsOf(request([{ type: "paragraph", runs: [{ text: "x", bold: null }] }]))).toEqual([["/blocks/0/runs/0/bold", "wrong_type"]]);
    expect(problemsOf(request([{ type: "list", ordered: null, items: [] }]))).toEqual([["/blocks/0/ordered", "wrong_type"]]);
    const table = { type: "table", columns: [1], rows: [] };
    expect(problemsOf(request([{ ...table, align: null }]))).toEqual([["/blocks/0/align", "wrong_type"]]);
    expect(problemsOf(request([{ ...table, header: null }]))).toEqual([["/blocks/0/header", "wrong_type"]]);
  });

  it("refuses an unknown style, an unknown member, a heading level out of range, a missing runs and a wrong block type", () => {
    expect(problemsOf(request([{ type: "paragraph", runs: [{ text: "x", style: "huge" }] }]))).toEqual([["/blocks/0/runs/0/style", "unknown_style"]]);
    expect(problemsOf(request([{ type: "paragraph", runs: [], colour: "red" }]))).toEqual([["/blocks/0", "unknown_member"]]);
    expect(problemsOf(request([{ type: "heading", level: 4, text: "x" }]))).toEqual([["/blocks/0/level", "out_of_range"]]);
    expect(problemsOf(request([{ type: "paragraph" }]))).toEqual([["/blocks/0/runs", "missing_member"]]);
    expect(problemsOf(request([{ type: "banner" }]))).toEqual([["/blocks/0/type", "unknown_block_type"]]);
    expect(problemsOf(request([{ type: "paragraph", runs: [{ text: "x" }], style: "Missing" }]))).toEqual([["/blocks/0/style", "unknown_style"]]);
  });

  it("refuses a table whose rows, header or align do not fit its columns, and a cell that holds a table", () => {
    const base = { type: "table", columns: [1, 2] };
    expect(problemsOf(request([{ ...base, rows: [[[], []], [[]]] }]))).toEqual([["/blocks/0/rows/1", "column_count_mismatch"]]);
    expect(problemsOf(request([{ ...base, header: [[]], rows: [] }]))).toEqual([["/blocks/0/header", "column_count_mismatch"]]);
    expect(problemsOf(request([{ ...base, align: ["left", "right", "left"], rows: [] }]))).toEqual([["/blocks/0/align", "column_count_mismatch"]]);
    expect(problemsOf(request([{ type: "table", columns: [], rows: [] }]))).toEqual([["/blocks/0/columns", "no_columns"]]);
    expect(problemsOf(request([{ type: "table", columns: [0, 1], rows: [] }]))).toEqual([["/blocks/0/columns/0", "out_of_range"]]);
    expect(problemsOf(request([{ ...base, rows: [[[{ type: "table" }], []]] }]))).toEqual([["/blocks/0/rows/0/0/0/type", "unknown_block_type"]]);
  });

  it("names the limits: 5 000 blocks counting cells, 200 000 characters of one block, an empty text counting one", () => {
    expect(validateContent(request(Array.from({ length: 5_000 }, () => ({ type: "pageBreak" }))))).toEqual({ rejection: null, problems: [] });
    expect(validateContent(request(Array.from({ length: 5_001 }, () => ({ type: "pageBreak" }))))).toEqual({ rejection: "content_too_large", problems: [] });
    const cells = Array.from({ length: 5_000 }, () => [[]]);
    expect(validateContent(request([{ type: "table", columns: [1], rows: cells }])).rejection).toBe("content_too_large");
    expect(validateContent(request([para("é".repeat(200_000))])).rejection).toBeNull();
    expect(validateContent(request([para("é".repeat(200_001))])).rejection).toBe("content_too_large");
    expect(validateContent(request([{ type: "paragraph", runs: Array.from({ length: 200_001 }, () => ({ text: "" })) }])).rejection).toBe("content_too_large");
  });

  it("judges the envelope first, each with its own code", () => {
    for (const refused of [0, 3, "2", null]) expect(validateContent({ ...(request([]) as object), contentVersion: refused }).rejection).toBe("unsupported_content_version");
    // Both 1 and 2 are accepted; the pin is version 2's member only.
    expect(validateContent({ ...(request([]) as object), contentVersion: 1 })).toEqual({ rejection: null, problems: [] });
    expect(problemsOf({ ...(request([]) as object), contentVersion: 1, legalEntityVersion: 4 })).toEqual([["", "unknown_member"]]);
    expect(validateContent({ ...(request([]) as object), entity: "welld_xx" }).rejection).toBe("unknown_entity");
    expect(validateContent({ ...(request([]) as object), language: "fr" }).rejection).toBe("unsupported_language");
    expect(problemsOf(request([], { letterheadVersion: 0 }))).toEqual([["/letterheadVersion", "out_of_range"]]);
    expect(problemsOf(request([], { legalEntityVersion: 0 }))).toEqual([["/legalEntityVersion", "out_of_range"]]);
    expect(problemsOf(request([], { legalEntityVersion: "4" }))).toEqual([["/legalEntityVersion", "wrong_type"]]);
    expect(problemsOf(request([], { legalEntityVersion: 4 }))).toEqual([]);
    expect(problemsOf(request([], { entityData: { vatNumber: "x" } }))).toEqual([["/entityData", "unknown_member"]]);
  });
});

// ─── The content the conversion builds ────────────────────────────────────────────────────────────────────────────────

describe("the content the engine accepts (AC-10.3): every fixture is valid content v2", () => {
  for (const item of CASES) {
    it(`${item.name}: as a stored draft`, () => {
      const built = draftOf(item);
      expectAccepted(built.content, item.name);
      expect(built.content.contentVersion).toBe(2);
      expect(built.content.legalEntityVersion).toBe(PROFILE.legalEntityVersion);
      expect(built.content.language).toBe(item.language);
      expect(built.content.blocks.length).toBeGreaterThan(5);
      // These fixtures are complete: nothing is owed and nothing is refused.
      expect(built.missing).toEqual([]);
      expect(built.invalid).toEqual([]);
    });
  }

  it("the seven seeds and the English template are all covered, with the three variants and the golden answers", () => {
    expect(CASES.length).toBe(7 * 4 + 3);
    expect(new Set(CASES.map((item) => item.name.split(" ")[0])).size).toBe(8);
  });

  for (const seed of WELLD_CH_IT_V1) {
    it(`${seed.code}: as a template with no deal (G1, AC-10.14), with the sample answers`, () => {
      const { ast } = parseTemplate(seed.source);
      const built = templateToBlocks({ entity: "welld_ch", ast, language: "it" }, PROFILE);
      expectAccepted(built.content, seed.code);
      expect(built.missing).toEqual([]);
    });
  }

  it("English: as a template with no deal, with the editor's own sample answers", () => {
    const { ast } = parseTemplate(ENGLISH_SOURCE);
    const built = templateToBlocks({ entity: "welld_it", ast, language: "en", answers: { ...sampleAnswers(ast, "en"), effortAnnex: true }, annex: EFFORT }, PROFILE);
    expectAccepted(built.content, "English template");
    expect(built.content.language).toBe("en");
    expect(built.content.entity).toBe("welld_it");
    expect(built.missing).toEqual([]);
    // The effort annex is there, with its page break: English words.
    expect(textsOf(built.content.blocks)).toContain("ANNEX B – EFFORT DETAIL");
  });

  it("a template with no deal uses the profile's issuer, not the made-up one, and the profile's place of issue", () => {
    const { ast } = parseTemplate(WELLD_CH_IT_V1[0]!.source);
    const built = templateToBlocks({ entity: "welld_ch", ast, language: "it" }, { ...PROFILE, placeOfIssue: "Bellinzona" });
    const text = textsOf(built.content.blocks).join(" ");
    expect(text).toContain("wellD Sagl");
    expect(text).not.toContain("Fornitore di esempio");
    expect(text).toContain("Bellinzona, 15.1.2026");
  });

  it("the legacy English templates (the seeded contract texts) convert as stored snapshots, with and without a letterhead's effort annex", () => {
    expect(DEFAULT_TEMPLATES_EN.length).toBe(7);
    for (const [index, template] of DEFAULT_TEMPLATES_EN.entries()) {
      const lines = template.costLines.map((line, at) => {
        const cents = "cents" in (typeof line.amount === "object" ? line.amount : {}) ? (line.amount as { cents: number }).cents : 1_000_000 + at * 100;
        const quantity = typeof line.quantity === "number" ? line.quantity : 1;
        return { description: line.description.replace(/\{[a-z]+\}/g, "Project"), kind: line.kind, unitCents: line.kind === "discount" && "percentBp" in (line.amount as object) ? null : cents, percentBp: "percentBp" in (typeof line.amount === "object" ? line.amount : {}) ? (line.amount as { percentBp: number }).percentBp : null, quantity, totalCents: cents * quantity };
      });
      const costs: OfferCosts = {
        currency: "EUR",
        columns: template.costColumns,
        showTotal: template.showTotal,
        lines,
        oneOffCents: lines.filter((line) => line.kind === "one_off").reduce((sum, line) => sum + line.totalCents, 0),
        yearlyCents: 0,
      };
      const snapshot: ContractSnapshot = {
        kind: "contract",
        template: { id: `t${index}`, name: template.name },
        language: "en",
        reference: REFERENCE,
        issuedOn: "2026-11-17",
        validUntil: "2026-12-17",
        validityDays: 30,
        place: "Lugano",
        issuer: { legalName: PROFILE.legalName, addressLines: PROFILE.addressLines, vatNumber: "CHE-123.456.789 IVA", iban: "CH93 0076 2011 6238 5295 7" },
        salutation: template.salutation,
        clientLines: ["Acme Ltd", "1 High Street", "London"],
        contacts: ["Jane Doe"],
        opening: template.opening,
        sections: template.sections,
        costs,
        acceptanceLabel: template.acceptanceLabel,
        annex: template.annex ? EFFORT : null,
        attachments: [{ id: "a", fileName: "Spec.pdf", sizeBytes: 10 }],
        aiAssisted: false,
        preparedBy: "Ada",
      };
      const content = snapshotToBlocks(snapshot, PROFILE, "welld_it");
      expectAccepted(content, template.name);
      expect(content.language).toBe("en");
      const text = textsOf(content.blocks).join(" ");
      expect(text).toContain("SUPPLY CONTRACT – Ref. 0017/2026");
      // G5: the deal PDF is neither drawn nor listed.
      expect(text).not.toContain("Spec.pdf");
    }
  });

  it("the Italian legacy templates convert too (the contract text with `{placeholders}` left as written)", () => {
    for (const template of DEFAULT_TEMPLATES_IT) {
      const snapshot: ContractSnapshot = {
        kind: "contract",
        template: { id: "t", name: template.name },
        language: "it",
        reference: REFERENCE,
        issuedOn: "2026-11-17",
        validUntil: "2026-12-17",
        validityDays: 30,
        place: "Lugano",
        issuer: { legalName: PROFILE.legalName, addressLines: PROFILE.addressLines, vatNumber: null, iban: null },
        salutation: template.salutation,
        clientLines: ["Acme SA"],
        contacts: [],
        opening: template.opening,
        sections: template.sections,
        costs: { currency: "CHF", columns: template.costColumns, showTotal: true, lines: [{ description: "Voce", kind: "one_off", unitCents: 100_000, percentBp: null, quantity: 2, totalCents: 200_000 }], oneOffCents: 200_000, yearlyCents: 0 },
        acceptanceLabel: template.acceptanceLabel,
        annex: null,
        attachments: [],
        aiAssisted: false,
        preparedBy: null,
      };
      expectAccepted(snapshotToBlocks(snapshot, PROFILE, "welld_ch"), template.name);
    }
  });
});

describe("the text is the PDF's text (AC-10.3): the engine's own oracle of the printed document", () => {
  /** What the oracle holds, minus what is drawn rather than written (list markers). */
  function oracleText(item: Case): string {
    const resolved = resolveOffer(item.ast, item.answers, item.context, { reference: REFERENCE });
    const numbered = numberOffer({
      language: resolved.language,
      sections: resolved.sections.map((section) => ({ key: section.key, heading: section.heading.replace(/[-]/g, ""), body: section.body })),
      annexes: resolved.annexes.map((annex) => ({
        designation: annex.designation,
        title: annex.title.replace(/[-]/g, ""),
        sections: annex.sections.map((section) => ({ key: section.key, heading: section.heading.replace(/[-]/g, ""), body: section.body })),
      })),
      effortAnnex: item.annex !== null && resolved.effortAnnex,
      attachmentNames: [],
    });
    const parts = documentText({ resolved, numbered, costs: costsOf(resolved), reference: REFERENCE, currency: item.context.currency, effort: resolved.effortAnnex ? item.annex : null });
    return squash(parts.filter((part) => part.role !== "marker").map((part) => part.text).join(""));
  }

  /** What the content holds, minus what only the layout service draws or this conversion adds. */
  function contentText(content: LetterheadContent): string {
    const pieces: string[] = [];
    for (const block of content.blocks) {
      if (block.type === "paragraph") {
        // A list written as paragraphs starts with its marker as a run of its own: the oracle draws markers separately.
        const [first, ...rest] = block.runs;
        const runs = first && /^ *(•|\d+\.|[a-z]\.) $/.test(first.text) ? rest : block.runs;
        pieces.push(...runs.map((run) => run.text));
      } else {
        pieces.push(...textsOf([block]));
      }
    }
    // The signature rules and the box as the layout service can draw it.
    return squash(pieces.join("")).replace(/_{30}/g, "").replaceAll(squash("[ ]"), BALLOT_BOX);
  }

  for (const item of CASES) {
    it(`${item.name}`, () => {
      const built = draftOf(item);
      // The list markers of flat lists are drawn by the service: the oracle's are removed, and so is the content's own
      // numbering of a flat list (none is written). What is left is every word, figure and heading, in order.
      const ours = contentText(built.content);
      const theirs = oracleText(item);
      // The one difference by design: the rules of the signature lines (the oracle has none) are gone from `ours`.
      expect(ours).toBe(theirs);
      expect(ours.length).toBeGreaterThan(500);
    });
  }
});

describe("what the content holds (AC-10.4, AC-10.10, G5)", () => {
  const seed = WELLD_CH_IT_V1[0]!;
  const { ast } = parseTemplate(seed.source);

  it("a missing field is a run in the `missing` style with the template's label, and the list of missing fields carries the same", () => {
    const context = sampleContext("it");
    const answers = initialAnswers(ast, context);
    const built = draftToBlocks({ entity: "welld_ch", ast, answers, context }, PROFILE);
    expectAccepted(built.content, "incomplete");
    const missing: { text: string; style?: string }[] = [];
    for (const piece of walk(built.content.blocks)) {
      if (isObject(piece) && piece["style"] === "missing" && typeof piece["text"] === "string") missing.push(piece as { text: string });
    }
    expect(missing.length).toBeGreaterThan(0);
    // Each missing run names its field by the template's label: the labels the engine lists as missing.
    const labels = built.missing.map((issue) => issue.label).filter((label): label is string => label !== null);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(missing.some((run) => run.text === label)).toBe(true);
    expect(built.missing[0]).toEqual({ name: expect.any(String), label: expect.any(String), step: expect.any(String) });
    // Nothing else is highlighted, and no marker character leaks into the text.
    expect(JSON.stringify(built.content)).not.toMatch(/[-]/);
  });

  it("a missing value in a heading highlights the heading; one in a cost figure is a `missing` dash", () => {
    const english = parseTemplate(ENGLISH_SOURCE).ast;
    const context = sampleContext("en");
    const answers = sampleAnswers(english, "en");
    // The title is in the cost line's description (a plain surface): unset it. The rate is a cost figure: unset it.
    delete answers.fields["TITLE"];
    delete answers.fields["RATE"];
    const built = draftToBlocks({ entity: "welld_it", ast: english, answers, context }, PROFILE);
    expectAccepted(built.content, "missing in a cost line");
    const runs = [...walk(built.content.blocks)].filter((piece): piece is { text: string; style: string } => isObject(piece) && piece["style"] === "missing");
    expect(runs.map((run) => run.text)).toContain("Title");
    expect(runs.map((run) => run.text)).toContain("–");
    expect(built.missing.map((issue) => issue.label)).toContain("Title");
  });

  it("the pending reference is its label in italics, never a missing run, and the title says the shape of a reference", () => {
    const built = draftOf(CASES[0]!, null);
    const title = built.content.blocks.find((block) => block.type === "paragraph" && block.style === "center");
    expect(title).toMatchObject({ runs: [{ text: "CONTRATTO DI FORNITURA – Rif. NNNN/AAAA", italic: true, style: "title" }] });
    expect(built.missing).toEqual([]);
    const english = CASES.find((item) => item.language === "en")!;
    const englishTitle = draftOf(english, null).content.blocks.find((block) => block.type === "paragraph" && block.style === "center");
    expect(englishTitle).toMatchObject({ runs: [{ text: "SUPPLY CONTRACT – Ref. NNNN/YYYY" }] });
    // With a reference the title carries it, plain.
    expect(draftOf(CASES[0]!).content.blocks.find((block) => block.type === "paragraph" && block.style === "center")).toMatchObject({
      runs: [{ text: "CONTRATTO DI FORNITURA – Rif. 0017/2026", style: "title" }],
    });
  });

  it("sends no entityData (AC-5.2): the content's members are version 2's, and the issuer's values are nowhere in it", () => {
    const item = CASES[0]!;
    for (const content of [
      draftOf(item).content,
      templateToBlocks({ entity: "welld_ch", ast: item.ast, language: "it" }, PROFILE).content,
      snapshotToBlocks(SNAPSHOT, PROFILE, "welld_ch"),
    ]) {
      expect(Object.keys(content).sort()).toEqual(["blocks", "contentVersion", "entity", "language", "legalEntityVersion"]);
      expect(content).not.toHaveProperty("entityData");
      expect(JSON.stringify(content)).not.toContain("CHE-123.456.789 IVA");
      expect(JSON.stringify(content)).not.toContain("CH93 0076");
    }
  });

  it("legalEntityVersion is the version of the registry's details the document was built from, on every entry point", () => {
    const item = CASES[0]!;
    const input = { entity: "welld_ch" as const, ast: item.ast, answers: item.answers, context: item.context };
    expect(draftToBlocks(input, { legalEntityVersion: 9 }).content.legalEntityVersion).toBe(9);
    expect(templateToBlocks({ entity: "welld_ch", ast: item.ast, language: "it" }, { ...PROFILE, legalEntityVersion: 11 }).content.legalEntityVersion).toBe(11);
    expect(snapshotToBlocks(SNAPSHOT, { legalEntityVersion: 13 }, "welld_it").legalEntityVersion).toBe(13);
    // The pin is the only thing that changes: the same draft, another version.
    const { legalEntityVersion: _a, ...first } = draftToBlocks(input, { legalEntityVersion: 1 }).content;
    const { legalEntityVersion: _b, ...second } = draftToBlocks(input, { legalEntityVersion: 2 }).content;
    expect(second).toEqual(first);
  });

  it("the converter does not judge the issuer: completeness is the registry's (409 legal_entity_incomplete, upstream), never entity_profile_missing", () => {
    // A blank name in the made-up context of a template with no deal is a value of the registry the route refused before; it is not refused here.
    for (const legalName of ["", "   ", "\n"]) {
      const item = CASES[0]!;
      expect(() => templateToBlocks({ entity: "welld_ch", ast: item.ast, language: "it" }, { ...PROFILE, legalName })).not.toThrow();
    }
  });

  it("no member is null or undefined anywhere in the blocks: an absent optional member is omitted (amendment 2026-11-17, 3c)", () => {
    for (const item of CASES) {
      const built = draftOf(item);
      for (const piece of walk(built.content)) {
        expect(piece).not.toBeNull();
        expect(piece).not.toBeUndefined();
      }
      // `false` flags are omitted too: a flag is `true` or absent.
      for (const piece of walk(built.content.blocks)) {
        if (!isObject(piece)) continue;
        for (const flag of ["bold", "italic", "underline", "ordered"]) if (flag in piece) expect(piece[flag]).toBe(true);
        if ("style" in piece) expect(typeof piece["style"]).toBe("string");
      }
    }
  });

  it("no line names the deal PDFs (G5): not in the text, not in the list of annexes, with or without the effort annex", () => {
    const item = CASES.find((entry) => entry.name === "T1 annexes")!;
    const answers: WizardAnswers = { ...item.answers, effortAnnex: true, attachmentIds: ["a1", "a2"] };
    const context: WizardContext = {
      ...item.context,
      attachments: [
        { id: "a1", fileName: "Capitolato tecnico.pdf", sizeBytes: 1000 },
        { id: "a2", fileName: "Allegato commerciale.pdf", sizeBytes: 2000 },
      ],
    };
    const built = draftToBlocks({ entity: "welld_ch", ast: item.ast, answers, context, annex: EFFORT, reference: REFERENCE }, PROFILE);
    const text = textsOf(built.content.blocks).join("\n");
    expect(text).not.toContain("Capitolato");
    expect(text).not.toContain(".pdf");
    expect(text).not.toContain("Allegato commerciale");
    // The annexes the document has: the text annex A and the effort detail B; the PDFs would have been C and D.
    const at = built.content.blocks.findIndex((block) => block.type === "paragraph" && block.runs[0]?.text === "Allegati:");
    expect(at).toBeGreaterThan(0);
    const listed = built.content.blocks[at + 1];
    expect(listed).toMatchObject({ type: "list" });
    expect((listed as unknown as { items: { runs: { text: string }[] }[] }).items.map((entry) => entry.runs[0]!.text)).toEqual([
      "Allegato A - Perimetro funzionale e stime",
      "Allegato B - Dettaglio dell’impegno",
    ]);
    expect(text).not.toContain("Allegato C");
  });

  it("each text annex and the effort annex start on a new page; the index lists them without page numbers", () => {
    const item = CASES.find((entry) => entry.name === "T1 annexes")!;
    const built = draftOf(item);
    const kinds = built.content.blocks.map((block) => block.type);
    const breaks = kinds.flatMap((kind, index) => (kind === "pageBreak" ? [index] : []));
    expect(breaks.length).toBe(2);
    for (const at of breaks) expect(built.content.blocks[at + 1]).toMatchObject({ type: "heading", level: 1 });
    expect(built.content.blocks[breaks[1]! + 1]).toMatchObject({ text: "ALLEGATO B – DETTAGLIO DELL’IMPEGNO" });
    const indexAt = built.content.blocks.findIndex((block) => block.type === "paragraph" && block.runs[0]?.text === "INDICE");
    expect(indexAt).toBeGreaterThan(0);
    const entries = built.content.blocks[indexAt + 1] as unknown as { runs: { text: string }[] };
    const lines = entries.runs.map((run) => run.text).filter((text) => text !== "\n");
    expect(lines[0]).toMatch(/^1\. /);
    expect(lines.at(-1)).toBe("ALLEGATO B – DETTAGLIO DELL’IMPEGNO");
    for (const line of lines) expect(line).not.toMatch(/\s\d+$/);
    // Without the effort annex there is no index and one page break fewer.
    const plain = draftOf(CASES.find((entry) => entry.name === "T1 everything")!);
    expect(plain.content.blocks.some((block) => block.type === "paragraph" && block.runs[0]?.text === "INDICE")).toBe(false);
  });

  it("the ballot box of an option line is `[ ]` with a no-break space, and no character the fonts lack is introduced", () => {
    const item = CASES.find((entry) => entry.name === "T1 everything")!;
    const built = draftOf(item);
    const all = JSON.stringify(built.content);
    expect(all).not.toContain(BALLOT_BOX);
    expect(all).toContain("[ ] ");
    // The characters of the document words and of the template text, as the bundled fonts hold them: no U+25A1.
    expect(all).not.toMatch(/[■-◿]/);
  });

  it("lists are lists when they can be, and paragraphs that keep their marker when they cannot", () => {
    const english = CASES.find((entry) => entry.name === "English everything")!;
    const built = draftOf(english);
    const blocks = built.content.blocks;
    // `a. / b.` with a nested list: paragraphs that start with the marker as written, the nested ones indented.
    const lettered = blocks.filter((block) => block.type === "paragraph" && /^ *(•|[a-z]\.) $/.test(block.runs[0]?.text ?? ""));
    expect(lettered.map((block) => (block as unknown as { runs: { text: string }[] }).runs.map((run) => run.text).join(""))).toEqual([
      "a. First deliverable",
      "b. Second deliverable",
      "    • nested one",
      "    • nested two",
    ]);
    // The flat bulleted list of the answers' items is a `list` block, with no `ordered` member.
    const lists = blocks.filter((block) => block.type === "list");
    expect(lists.some((block) => block.type === "list" && block.ordered === undefined && block.items.length === 2)).toBe(true);
  });

  it("a flat list numbered from 1 is an ordered list, any other numbering is kept as written", () => {
    const snapshot = (body: string): ContractSnapshot => ({
      kind: "contract",
      template: { id: "t", name: "t" },
      language: "en",
      reference: REFERENCE,
      issuedOn: "2026-11-17",
      validUntil: "2026-12-17",
      validityDays: 30,
      place: "",
      issuer: { legalName: "x", addressLines: [], vatNumber: null, iban: null },
      salutation: "To",
      clientLines: [],
      contacts: [],
      opening: "",
      sections: [{ heading: "Terms", body, costs: false }],
      costs: { currency: "EUR", columns: { position: false, unit: false }, showTotal: false, lines: [], oneOffCents: 0, yearlyCents: 0 },
      acceptanceLabel: null,
      annex: null,
      attachments: [],
      aiAssisted: false,
      preparedBy: null,
    });
    const blocksOf = (body: string) => snapshotToBlocks(snapshot(body), PROFILE, "welld_it").blocks;
    expect(blocksOf("1. one\n2. two\n3. three").filter((block) => block.type === "list")).toEqual([{ type: "list", ordered: true, items: [{ runs: [{ text: "one" }] }, { runs: [{ text: "two" }] }, { runs: [{ text: "three" }] }] }]);
    expect(blocksOf("3. three\n4. four").filter((block) => block.type === "list")).toEqual([]);
    expect(textsOf(blocksOf("3. three\n4. four"))).toContain("3. ");
    expect(blocksOf("- a\n- b").filter((block) => block.type === "list")).toEqual([{ type: "list", items: [{ runs: [{ text: "a" }] }, { runs: [{ text: "b" }] }] }]);
  });

  it("is deterministic, and the same draft gives the same content with the date, the profile and the reference it had", () => {
    for (const item of CASES.slice(0, 6)) expect(JSON.stringify(draftOf(item).content)).toBe(JSON.stringify(draftOf(item).content));
  });

  it("the preview of a draft and its generation give the same content for the same answers (one conversion, AC-10.3)", () => {
    const item = CASES.find((entry) => entry.name === "T2 everything")!;
    const preview = draftToBlocks({ entity: "welld_ch", ast: item.ast, answers: item.answers, context: item.context, reference: REFERENCE }, PROFILE);
    const generated = draftToBlocks({ entity: "welld_ch", ast: item.ast, answers: structuredClone(item.answers), context: structuredClone(item.context), reference: REFERENCE }, PROFILE);
    expect(generated).toEqual(preview);
  });

  it("stays within the service's limits for the largest template the CRM accepts", () => {
    for (const item of CASES) {
      const built = draftOf(item);
      expect(built.content.blocks.length).toBeLessThan(1_000);
    }
  });
});
