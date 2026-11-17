/**
 * Golden capture of the issuer details today's document paths print (specs/20261117-legal-entities T24; AC-7.5, amendment
 * D2). It is run ONCE, on the code BEFORE the switch to the registry (T26 to T28), and its output,
 * `specs/20261117-legal-entities/fixtures/issuer-lines.golden.json`, is committed. The switch tasks compare against that
 * committed file (`issuerGolden.test.ts`, T27/T28); they never re-capture, because a capture made after the switch would
 * only describe the new code.
 *
 * For every COMPLETE profile of the MIG fixture set (`crm-entity-profiles.json`, `expect.missing` empty) and for each
 * language, a wizard offer of the entity is generated through the assembled app, the way the people do it, and:
 *
 *  - classic: with `LETTERHEAD_SERVICE_ENABLED` off, the stored PDF is read back: the strings crm-api drew in the page header
 *    (its plain letterhead: no uploaded letterhead), in the footer, the body lines the template prints for `[EMITTENTE]`
 *    and `[INDIRIZZO]`, and the document's Author. Only the issuer's lines are kept, so no date, number or amount is in the
 *    file.
 *  - service: with the switch on, the request body the client sent to the layout service: `entityData` and the same body
 *    lines.
 *
 * The profile is seeded with `setRetiredLegalColumns` (the retired columns are where the document paths read from until
 * T26), never through the settings API, which no longer takes them (T29).
 *
 * Runs only with `CAPTURE_ISSUER_GOLDEN=1` (skipped otherwise). Re-running it on the same code reproduces the file byte for
 * byte. Run it from `crm-api` with a test database of its own:
 *   CAPTURE_ISSUER_GOLDEN=1 DATABASE_URL=… bun test src/offers/issuerGolden.capture.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
// The test world first: it sets the environment the other modules read when they load.
import { bucket, call, db, makeReadyDeal, makeWizardTemplate, resetWorld, setRetiredLegalColumns } from "../test-support/world";
import { resetLetterheadMemoForTests } from "../entity-profiles/letterheadUse";
import { env } from "../lib/env";
import { LETTERHEAD_TIMEOUT_MS, createLetterheadClient, letterhead } from "../lib/letterheadClient";
import type { ServiceTokenProvider } from "../lib/serviceToken";
import fixture from "../../../specs/20261117-legal-entities/fixtures/crm-entity-profiles.json";
import { FRAME } from "./paper";

const CAPTURE = process.env["CAPTURE_ISSUER_GOLDEN"] === "1";
const GOLDEN = join(import.meta.dir, "../../../specs/20261117-legal-entities/fixtures/issuer-lines.golden.json");

type Entity = "welld_ch" | "welld_it";
type Language = "it" | "en";
const LANGUAGES: readonly Language[] = ["it", "en"];

interface CrmProfile {
  readonly legalName: string;
  readonly addressLines: string[];
  readonly vatNumber: string | null;
  readonly iban: string | null;
}
interface FixtureCase {
  readonly name: string;
  readonly entity: Entity;
  readonly crm: CrmProfile | null;
  readonly expect: { readonly missing: readonly string[] };
}
const complete = (fixture.cases as unknown as FixtureCase[]).filter((c) => c.crm !== null && c.expect.missing.length === 0);

// ─── The template ────────────────────────────────────────────────────────────────────────────────────────────────────

const BEGIN = "BEGIN-ISSUER-LINES";
const END = "END-ISSUER-LINES";

/** A wizard template whose opening prints the issuer's name and address between two marker paragraphs. */
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

// ─── The fake layout service: records what the real client sent ──────────────────────────────────────────────────────

const sent: { body: any }[] = [];
let spy: { mockRestore(): void } | null = null;
const switchWas = env.LETTERHEAD_SERVICE_ENABLED;

async function servicePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return doc.save({ useObjectStreams: false });
}

beforeEach(() => {
  sent.length = 0;
  const tokens: ServiceTokenProvider = { getToken: async () => "svc-token", invalidate() {} };
  spy = spyOn(letterhead, "pdf").mockImplementation((content, options) =>
    createLetterheadClient({
      baseUrl: "http://letterhead.test",
      tokens,
      timeoutMs: LETTERHEAD_TIMEOUT_MS,
      sleep: async () => {},
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent.push({ body: JSON.parse(String(init?.body)) });
        return new Response(await servicePdf(), {
          status: 200,
          headers: { "Content-Type": "application/pdf", "Page-Count": "1", "Unprintable-Characters": "0", "Letterhead-Version": "1" },
        });
      }) as typeof fetch,
    }).pdf(content, options),
  );
});
afterEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = switchWas;
  spy?.mockRestore();
  spy = null;
});

// ─── Reading what was printed ────────────────────────────────────────────────────────────────────────────────────────

const WIN_ANSI: Record<number, string> = { 0x92: "’", 0x95: "•", 0x96: "–", 0x91: "‘", 0x93: "“", 0x94: "”" };
const PAGE_HEIGHT = 841.89;

interface Drawn {
  readonly y: number;
  readonly text: string;
}

/** Every string a page draws, with its baseline, in drawing order (`1 0 0 1 x y Tm <hex> Tj`). */
function drawnOn(doc: PDFDocument, index: number): Drawn[] {
  const contents = doc.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const content = streams.map((stream) => Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString("latin1")).join("\n");
  return [...content.matchAll(/1 0 0 1 [\d.-]+ ([\d.-]+) Tm\s*<([0-9A-Fa-f]*)>\s*Tj/g)].map((match) => ({
    y: Number(match[1]),
    text: (match[2]!.match(/../g) ?? []).map((pair) => WIN_ANSI[parseInt(pair, 16)] ?? String.fromCharCode(parseInt(pair, 16))).join(""),
  }));
}

const PAGE_NUMBER = /^\d+\/\d+$/;

/** What crm-api's own pages print: header above the body frame, footer below it (the page number aside), the body between. */
function classicOf(doc: PDFDocument) {
  const drawn = drawnOn(doc, 0);
  const header = drawn.filter((d) => d.y > PAGE_HEIGHT - FRAME.top).map((d) => d.text);
  const footerLines = drawn.filter((d) => d.y < FRAME.bottom && !PAGE_NUMBER.test(d.text)).map((d) => d.text);
  const body = drawn.filter((d) => d.y >= FRAME.bottom && d.y <= PAGE_HEIGHT - FRAME.top).map((d) => d.text);
  const from = body.indexOf(BEGIN);
  const to = body.indexOf(END);
  if (from < 0 || to < from) throw new Error(`the issuer markers are not in the body: ${JSON.stringify(body)}`);
  // The footer is one text the renderer wraps at the width of the page: `footer` is it unwrapped, so a comparison does not
  // depend on where a longer or shorter IBAN falls.
  return { header, footer: footerLines.join(" "), footerLines, body: body.slice(from + 1, to), author: doc.getAuthor() ?? "" };
}

type Run = { text?: string };
type Block = { type: string; runs?: Run[] };

/** The paragraphs between the two markers, each as its text (a hard line break is a "\n" in it). */
function bodyLinesOf(blocks: Block[]): string[] {
  const texts = blocks.map((block) => (block.type === "paragraph" ? (block.runs ?? []).map((r) => r.text ?? "").join("") : null));
  const from = texts.indexOf(BEGIN);
  const to = texts.indexOf(END);
  if (from < 0 || to < from) throw new Error("the issuer markers are not in the request");
  return texts.slice(from + 1, to).filter((text): text is string => text !== null && text !== "");
}

// ─── The capture ─────────────────────────────────────────────────────────────────────────────────────────────────────

const noMatch = { "If-None-Match": "*" };

/** One new offer of the deal through the wizard path, as the people make it. */
async function generateWizardOffer(dealId: string, templateId: string) {
  const created = await call("POST", `/deals/${dealId}/offer-draft`, { body: { templateId }, headers: noMatch });
  if (created.status !== 201) throw new Error(`draft: ${created.status} ${JSON.stringify(created.json)}`);
  const generated = await call("POST", `/deals/${dealId}/offer-draft/generate`, { ifMatch: created.json.version });
  if (generated.status !== 201) throw new Error(`generate: ${generated.status} ${JSON.stringify(generated.json)}`);
}

async function capture(c: FixtureCase, language: Language) {
  await resetWorld();
  resetLetterheadMemoForTests();
  // The entity's row (its own settings), then the legal details in the retired columns: the other entity has no row at all.
  const put = await call("PUT", `/entity-profiles/${c.entity}`, { as: "admin", body: { offerTermsEn: "Payment within 30 days.", offerTermsIt: "Pagamento a 30 giorni." } });
  if (put.status !== 200) throw new Error(`profile: ${put.status} ${JSON.stringify(put.json)}`);
  await setRetiredLegalColumns(c.entity, c.crm!);
  const { deal } = await makeReadyDeal({ entity: c.entity });
  const template = await makeWizardTemplate({ entity: c.entity, language, name: `Golden ${language}`, source: source(language) });

  env.LETTERHEAD_SERVICE_ENABLED = false;
  await generateWizardOffer(deal.id, template.id);
  const [row] = await db.dealOffer.findMany({ where: { dealId: deal.id }, orderBy: { number: "asc" } });
  const pdf = bucket.objects.get(row!.objectKey)!.bytes!;
  const classic = classicOf(await PDFDocument.load(pdf));

  // A deal takes one new offer until it is sent: the service pass is a second deal of the same entity.
  const other = (await makeReadyDeal({ entity: c.entity })).deal;
  env.LETTERHEAD_SERVICE_ENABLED = true;
  sent.length = 0;
  await generateWizardOffer(other.id, template.id);
  if (sent.length !== 1) throw new Error(`the layout service was asked ${sent.length} times`);
  const request = sent[0]!.body;
  return { classic, service: { entityData: request.entityData, body: bodyLinesOf(request.blocks) } };
}

describe.skipIf(!CAPTURE)("issuer golden capture (before the switch)", () => {
  it("captures every complete MIG fixture profile, in it and en, and writes the golden file", async () => {
    expect(complete.length).toBeGreaterThan(0);
    const cases: unknown[] = [];
    for (const c of complete) {
      const languages: Record<string, unknown> = {};
      for (const language of LANGUAGES) {
        const got = await capture(c, language);
        // A capture that lost the issuer would write a golden that proves nothing.
        expect(got.classic.header.length).toBeGreaterThan(0);
        expect(got.classic.footer).not.toBe("");
        expect(got.classic.body.length).toBeGreaterThan(0);
        expect(got.classic.author).not.toBe("");
        expect(got.service.entityData.legalName).toBeTruthy();
        expect(got.service.body.length).toBeGreaterThan(0);
        languages[language] = got;
      }
      cases.push({ name: c.name, entity: c.entity, languages });
    }
    const file = {
      $comment:
        "Golden issuer output of the document paths BEFORE the switch to the registry (specs/20261117-legal-entities T24, AC-7.5, amendment D2). Written by crm-api/src/offers/issuerGolden.capture.test.ts with CAPTURE_ISSUER_GOLDEN=1 on the pre-switch code; never re-capture after T26. Per complete case of crm-entity-profiles.json and language: `classic` = the strings crm-api's own PDF drew (header, footer as drawn and unwrapped, the body lines printed for [EMITTENTE] / [INDIRIZZO], the Author), `service` = `entityData` and the same body lines of the request sent to the layout service. Synthetic values only.",
      cases,
    };
    writeFileSync(GOLDEN, `${JSON.stringify(file, null, 2)}\n`);
  });
});
