/**
 * The issuer of the CRM's own documents is the registry's, and prints as it did the day before (specs/20261117-legal-entities
 * T27; AC-6.2, AC-7.5, amendment D2). Every complete profile of the MIG fixture (`crm-entity-profiles.json`) is seeded in the
 * registry fake the way the move writes version 1 (`expect`: the legal name, the address in both languages, the VAT number, the
 * IBAN in electronic form, printed in groups of four), an offer is generated through the assembled app with the classic
 * renderer (switch off), and what the PDF drew is compared with T24's golden, captured on the code BEFORE the switch
 * (`issuer-lines.golden.json`; never re-captured, see `issuerGolden.capture.test.ts`): the header, the footer (unwrapped), the
 * body lines printed for `[EMITTENTE]` / `[INDIRIZZO]`, the Author.
 *
 * The one difference allowed is the IBAN, exactly where the fixture says `ibanPrintChanged`: the registry prints it in groups of
 * four, the CRM printed what was typed. The test checks the flag against the golden both ways (a case where the golden and the
 * groups differ must be flagged, a flagged case must differ), so the list of differences cannot be longer or shorter than the
 * fixture's. Nothing else may differ: a pinned behaviour of the old path (the header prints the first 3 non-blank address lines,
 * a U+2028 in the VAT number prints `?`, a line break folds into one space) is kept.
 *
 * The legacy-template route (`POST /deals/{id}/offers`, its own `snapshotOf`) is not in the golden: the golden is wizard-only.
 * The same cases are run through it here, against the same golden entries: it draws the page with the same renderer
 * (`renderContractPdf`, `plainLetterhead`), so the header, the footer and the Author must be the golden's; a legacy template has
 * no `[EMITTENTE]` / `[INDIRIZZO]` field, only `{issuer}` (the legal name) in its opening, which is checked against the golden's
 * name. The service path (switch on) is T28's.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
// The test world first: it sets the environment the other modules read when they load.
import { bucket, call, db, makeReadyDeal, makeWizardTemplate, offerBody, registry, resetWorld } from "../test-support/world";
import { completeEntity } from "../test-support/fakeRegistry";
import { env } from "../lib/env";
import fixture from "../../../specs/20261117-legal-entities/fixtures/crm-entity-profiles.json";
import { FRAME } from "./paper";

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dir, "../../../specs/20261117-legal-entities/fixtures/issuer-lines.golden.json"), "utf8")) as {
  cases: { name: string; entity: Entity; languages: Record<Language, { classic: Classic }> }[];
};

type Entity = "welld_ch" | "welld_it";
type Language = "it" | "en";
const LANGUAGES: readonly Language[] = ["it", "en"];

interface Classic {
  readonly header: string[];
  readonly footer: string;
  readonly body: string[];
  readonly author: string;
}
interface FixtureCase {
  readonly name: string;
  readonly entity: Entity;
  readonly crm: unknown;
  readonly expect: {
    readonly legalName: string;
    readonly address: string[];
    readonly vatNumber: string;
    readonly iban: string;
    readonly missing: string[];
    readonly invalid: { field: string; reason: string; line?: number; limit?: number }[];
    readonly ibanPrintChanged: boolean;
  };
}
const cases = (fixture.cases as unknown as FixtureCase[]).filter((c) => c.crm !== null && c.expect.missing.length === 0);

/** The registry's version of the moved details; not 1, so a snapshot that lost it, or took a default, shows. */
const VERSION = 4;

/** `ibanPrint`, written here independently of auth's code: the electronic form in groups of four separated by one space. */
const groupsOfFour = (iban: string) => (iban.match(/.{1,4}/g) ?? []).join(" ");

/** The details the move writes for a fixture case (the fixture's `expect`), the address in both languages. */
function seed(c: FixtureCase, over: { addressEn?: string[] } = {}) {
  const e = c.expect;
  registry.set(
    completeEntity(c.entity, {
      version: VERSION,
      legalName: e.legalName,
      address: { it: [...e.address], en: [...(over.addressEn ?? e.address)] },
      vatNumber: e.vatNumber,
      iban: e.iban,
      ibanPrint: groupsOfFour(e.iban),
      contacts: { it: "", en: "" },
      complete: true,
      missing: [],
      invalid: e.invalid.map((item) => ({ ...item })),
    }),
  );
}

// ─── The template of the capture ─────────────────────────────────────────────────────────────────────────────────────

const BEGIN = "BEGIN-ISSUER-LINES";
const END = "END-ISSUER-LINES";

/** The capture's wizard template, line for line: its opening prints the issuer's name and address between two markers. */
const source = (language: Language) =>
  [
    `@@salutation ${language === "it" ? "Spett.le" : "Dear"}`,
    "",
    BEGIN,
    "",
    `${language === "it" ? "Emittente" : "Issuer"}: [EMITTENTE] / [INDIRIZZO]`,
    "",
    END,
    "",
    "## COSTS",
    "@@step costs",
    "@@costs",
    "@@line work one_off | Work | unit=deal | qty=1",
    "@@total **TOTAL**",
    "@@end",
    "",
    "@@field EMITTENTE",
    "source: issuer",
    "",
    "@@field INDIRIZZO",
    "source: issuerAddress",
    "",
  ].join("\n");

// ─── Reading what was printed (the capture's reader) ─────────────────────────────────────────────────────────────────

const WIN_ANSI: Record<number, string> = { 0x92: "’", 0x95: "•", 0x96: "–", 0x91: "‘", 0x93: "“", 0x94: "”" };
const PAGE_HEIGHT = 841.89;

/** Every string a page draws, with its baseline, in drawing order (`1 0 0 1 x y Tm <hex> Tj`). */
function drawnOn(doc: PDFDocument, index: number): { y: number; text: string }[] {
  const contents = doc.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const content = streams.map((stream) => Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString("latin1")).join("\n");
  return [...content.matchAll(/1 0 0 1 [\d.-]+ ([\d.-]+) Tm\s*<([0-9A-Fa-f]*)>\s*Tj/g)].map((match) => ({
    y: Number(match[1]),
    text: (match[2]!.match(/../g) ?? []).map((pair) => WIN_ANSI[parseInt(pair, 16)] ?? String.fromCharCode(parseInt(pair, 16))).join(""),
  }));
}

const PAGE_NUMBER = /^\d+\/\d+$/;

/** The issuer's strings of a classic PDF: the header above the body frame, the footer below it (unwrapped), the Author. */
function classicOf(doc: PDFDocument, markers: boolean): Classic {
  const drawn = drawnOn(doc, 0);
  const header = drawn.filter((d) => d.y > PAGE_HEIGHT - FRAME.top).map((d) => d.text);
  const footer = drawn.filter((d) => d.y < FRAME.bottom && !PAGE_NUMBER.test(d.text)).map((d) => d.text).join(" ");
  const body = drawn.filter((d) => d.y >= FRAME.bottom && d.y <= PAGE_HEIGHT - FRAME.top).map((d) => d.text);
  if (!markers) return { header, footer, body: [], author: doc.getAuthor() ?? "" };
  const from = body.indexOf(BEGIN);
  const to = body.indexOf(END);
  if (from < 0 || to < from) throw new Error(`the issuer markers are not in the body: ${JSON.stringify(body)}`);
  return { header, footer, body: body.slice(from + 1, to), author: doc.getAuthor() ?? "" };
}

// ─── Making the offers ───────────────────────────────────────────────────────────────────────────────────────────────

const noMatch = { "If-None-Match": "*" };
const switchWas = env.LETTERHEAD_SERVICE_ENABLED;
beforeEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = false;
});
afterEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = switchWas;
});

async function putTerms(entity: Entity) {
  const put = await call("PUT", `/entity-profiles/${entity}`, { as: "admin", body: { offerTermsEn: "Payment within 30 days.", offerTermsIt: "Pagamento a 30 giorni." } });
  if (put.status !== 200) throw new Error(`profile: ${put.status} ${JSON.stringify(put.json)}`);
}

const storedOffer = async (dealId: string) => {
  const [row] = await db.dealOffer.findMany({ where: { dealId }, orderBy: { number: "asc" } });
  return { row: row!, pdf: await PDFDocument.load(bucket.objects.get(row!.objectKey)!.bytes!) };
};

/** One wizard offer, as the people make it. */
async function wizardOffer(c: FixtureCase, language: Language) {
  await putTerms(c.entity);
  const { deal } = await makeReadyDeal({ entity: c.entity });
  const template = await makeWizardTemplate({ entity: c.entity, language, name: `Golden ${language}`, source: source(language) });
  const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch });
  if (created.status !== 201) throw new Error(`draft: ${created.status} ${JSON.stringify(created.json)}`);
  const generated = await call("POST", `/deals/${deal.id}/offer-draft/generate`, { ifMatch: created.json.version });
  if (generated.status !== 201) throw new Error(`generate: ${generated.status} ${JSON.stringify(generated.json)}`);
  const { row, pdf } = await storedOffer(deal.id);
  return { row, classic: classicOf(pdf, true) };
}

/** One offer of the legacy-template route `POST /deals/{id}/offers`, from the default template of the language. */
async function legacyOffer(c: FixtureCase, language: Language) {
  await putTerms(c.entity);
  const { deal } = await makeReadyDeal({ entity: c.entity });
  const body = await offerBody(deal.id, c.entity, language === "it" ? "Formazione" : "Training");
  const res = await call("POST", `/deals/${deal.id}/offers`, { as: "admin", body });
  if (res.status !== 201) throw new Error(`legacy generate: ${res.status} ${JSON.stringify(res.json)}`);
  const { row, pdf } = await storedOffer(deal.id);
  return { row, classic: classicOf(pdf, false) };
}

// ─── The comparison ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the golden says today's documents print for the case, with the one allowed difference applied: the IBAN of the footer in
 * groups of four where (and only where) the fixture says `ibanPrintChanged`. The flag is checked against the golden both ways.
 */
function expectedOf(c: FixtureCase, golden: Classic): Classic {
  const printed = groupsOfFour(c.expect.iban);
  const typed = golden.footer.match(/ IBAN (.+)$/)?.[1];
  if (typed === undefined) throw new Error(`the golden footer of ${c.name} has no IBAN`);
  // The fixture's flag and the golden agree: the print changes exactly when the typed text is not the groups of four.
  expect(typed !== printed).toBe(c.expect.ibanPrintChanged);
  return { ...golden, footer: golden.footer.replace(` IBAN ${typed}`, ` IBAN ${printed}`) };
}

const goldenOf = (name: string, language: Language) => {
  const entry = GOLDEN.cases.find((g) => g.name === name);
  if (!entry) throw new Error(`the golden has no case ${name}`);
  return entry.languages[language].classic;
};

describe("the golden covers what the fixture's complete cases are", () => {
  it("has exactly the complete cases, and the IBAN differs only where the fixture says it does", () => {
    expect(GOLDEN.cases.map((g) => g.name).sort()).toEqual(cases.map((c) => c.name).sort());
    const changed = cases.filter((c) => c.expect.ibanPrintChanged).map((c) => c.name);
    expect(changed).toEqual(["iban-spaces-lower-case"]);
    for (const c of cases) {
      for (const language of LANGUAGES) expectedOf(c, goldenOf(c.name, language));
    }
  });
});

describe("a wizard offer prints the golden's issuer lines (classic renderer; AC-6.2, AC-7.5, D2)", () => {
  beforeEach(resetWorld);

  for (const c of cases) {
    for (const language of LANGUAGES) {
      it(`${c.name} / ${language}`, async () => {
        seed(c);
        const { row, classic } = await wizardOffer(c, language);
        const want = expectedOf(c, goldenOf(c.name, language));
        expect(classic.header).toEqual(want.header);
        expect(classic.footer).toBe(want.footer);
        expect(classic.body).toEqual(want.body);
        expect(classic.author).toBe(want.author);
        // The snapshot holds the same values and the version they were read from.
        const snapshot = row.snapshot as any;
        expect(snapshot.issuer).toEqual({
          legalName: c.expect.legalName,
          addressLines: c.expect.address,
          vatNumber: c.expect.vatNumber,
          iban: groupsOfFour(c.expect.iban),
        });
        expect(snapshot.legalEntityVersion).toBe(VERSION);
      });
    }
  }
});

describe("a legacy-template offer prints the golden's issuer lines (the route the golden does not cover)", () => {
  beforeEach(resetWorld);

  for (const c of cases) {
    for (const language of LANGUAGES) {
      it(`${c.name} / ${language}`, async () => {
        seed(c);
        const { row, classic } = await legacyOffer(c, language);
        const want = expectedOf(c, goldenOf(c.name, language));
        expect(classic.header).toEqual(want.header);
        expect(classic.footer).toBe(want.footer);
        expect(classic.author).toBe(want.author);
        const snapshot = row.snapshot as any;
        expect(snapshot.issuer).toEqual({
          legalName: c.expect.legalName,
          addressLines: c.expect.address,
          vatNumber: c.expect.vatNumber,
          iban: groupsOfFour(c.expect.iban),
        });
        expect(snapshot.legalEntityVersion).toBe(VERSION);
        // `{issuer}` of the template's opening is the golden's legal name (the Author is the folded legal name).
        expect(snapshot.opening).toContain(want.author);
      });
    }
  }
});

describe("an English offer prints address.en, an Italian one address.it (AC-6.2)", () => {
  beforeEach(resetWorld);
  const c = cases.find((x) => x.name === "complete-ch")!;
  const addressEn = ["Xyzzy Street 2", "6900 Lugano", "Switzerland"];

  for (const [name, make] of [
    ["wizard", wizardOffer],
    ["legacy", legacyOffer],
  ] as const) {
    it(`${name}: header, footer and snapshot follow the language`, async () => {
      seed(c, { addressEn });
      const en = await make(c, "en");
      expect(en.classic.header).toEqual([c.expect.legalName, ...addressEn]);
      expect(en.classic.footer).toStartWith([c.expect.legalName, ...addressEn].join(" · "));
      expect((en.row.snapshot as any).issuer.addressLines).toEqual(addressEn);
      if (name === "wizard") expect(en.classic.body).toEqual([`Issuer: ${c.expect.legalName} / ${addressEn.join(", ")}`]);

      await resetWorld();
      seed(c, { addressEn });
      const it = await make(c, "it");
      expect(it.classic.header).toEqual([c.expect.legalName, ...c.expect.address]);
      expect((it.row.snapshot as any).issuer.addressLines).toEqual(c.expect.address);
      if (name === "wizard") expect(it.classic.body).toEqual([`Emittente: ${c.expect.legalName} / ${c.expect.address.join(", ")}`]);
    });
  }
});
