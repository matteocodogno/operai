import * as isolated from "../entity-profiles/isolatedPdfCheck";
import { describe, expect, it, spyOn } from "bun:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  type PDFPage,
} from "pdf-lib";
import type { ContractSnapshot, OfferCostLine } from "./contract";
import { AttachmentUnreadableError, renderContractPdf } from "./contractPdf";
import { deflatedRun, objStmBombPdf } from "../test-support/pdfBuild";
import { formatAmount, formatPercent, shortDate } from "./engine/format";
import { DEFAULT_TEMPLATES_IT } from "./defaultTemplates";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A synthetic one-page A4 letterhead, so the tests never depend on the real one. */
const makeLetterhead = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("1/1", { x: 511, y: 35, size: 8, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save();
};

const makeAttachment = async (pages: number, label = "Attachment"): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) doc.addPage([595.28, 841.89]).drawText(`${label} page ${i}`, { x: 50, y: 700, size: 12, font });
  return doc.save();
};

const line = (over: Partial<OfferCostLine> = {}): OfferCostLine => ({
  description: "Sviluppo piattaforma",
  kind: "one_off",
  unitCents: 700_000,
  percentBp: null,
  quantity: 1,
  totalCents: 700_000,
  ...over,
});

const scope = {
  aiAssisted: true,
  manDaysTenths: 1765,
  releases: [
    { name: "MVP", manDaysTenths: 1105, epics: [{ epic: "Autenticazione", manDaysTenths: 305 }, { epic: "Ingestione dati", manDaysTenths: 800 }] },
    { name: "Release 2", manDaysTenths: 660, epics: [{ epic: "Report e dashboard", manDaysTenths: 660 }] },
  ],
};

const snapshot = (over: Partial<ContractSnapshot> = {}): ContractSnapshot => ({
  kind: "contract",
  template: { id: "t1", name: "Progetto a corpo" },
  language: "it",
  reference: "0017/2026",
  issuedOn: "2026-02-09",
  validUntil: "2026-03-11",
  validityDays: 30,
  place: "Lugano",
  issuer: { legalName: "WellD Sagl", addressLines: ["Via Pessina 9", "6900 Lugano"], vatNumber: "CHE-1", iban: null },
  salutation: "Spettabile",
  clientLines: ["Esempio SA", "Via Roma 1", "Italia"],
  contacts: ["Mario Rossi", "Anna Bianchi"],
  opening: "Con riferimento alle discussioni intercorse.",
  sections: [
    { heading: "Definizioni", body: "**A corpo:** attività a corpo.", costs: false },
    { heading: "Costi", body: "- I costi si intendono IVA esclusa.", costs: true },
    { heading: "Condizioni generali", body: "### Limitazione\n\nTesto.\n\n### Foro\n\nLugano.", costs: false },
  ],
  costs: {
    currency: "CHF",
    columns: { position: true, unit: false },
    showTotal: true,
    lines: [line()],
    oneOffCents: 700_000,
    yearlyCents: 0,
  },
  acceptanceLabel: null,
  annex: null,
  attachments: [],
  aiAssisted: true,
  preparedBy: null,
  ...over,
});

// ─── Reading a PDF back ──────────────────────────────────────────────────────

const WIN_ANSI: Record<number, string> = { 0x92: "’", 0x95: "•", 0x96: "–", 0x91: "‘", 0x93: "“", 0x94: "”" };

const contentsOf = (page: PDFPage): string => {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => page.doc.context.lookup(ref)) : [contents];
  return streams
    .map((stream) => (stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") : ""))
    .join("\n");
};

/** Every `<hex> Tj` string of a page, decoded from WinAnsi, in drawing order. */
const textOf = (page: PDFPage): string[] =>
  [...contentsOf(page).matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((match) =>
    (match[1]!.match(/../g) ?? []).map((hex) => WIN_ANSI[parseInt(hex, 16)] ?? String.fromCharCode(parseInt(hex, 16))).join(""),
  );

/** Number of XObjects (the embedded letterhead) a page draws. */
const xobjectCount = (page: PDFPage): number => {
  const resources = page.node.Resources();
  const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  return xobjects ? xobjects.keys().length : 0;
};

const render = async (snap: ContractSnapshot, over: { letterhead?: Uint8Array | null; attachments?: Uint8Array[] } = {}) => {
  const bytes = await renderContractPdf(snap, {
    letterhead: over.letterhead === undefined ? await makeLetterhead() : over.letterhead,
    attachments: over.attachments ?? [],
  });
  const doc = await PDFDocument.load(bytes);
  return { bytes, doc, pages: doc.getPages(), text: doc.getPages().map(textOf) };
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("formatting", () => {
  it("prints amounts per currency, whole units without cents", () => {
    expect(formatAmount(700_000, "CHF")).toBe("7’000");
    expect(formatAmount(3_630_000, "CHF")).toBe("36’300");
    expect(formatAmount(3_630_050, "CHF")).toBe("36’300.50");
    expect(formatAmount(3_630_050, "EUR")).toBe("36.300,50");
    expect(formatAmount(120_000, "EUR")).toBe("1.200");
  });

  it("trims percentages and dates", () => {
    expect(formatPercent(1000)).toBe("10%");
    expect(formatPercent(750)).toBe("7.5%");
    expect(shortDate("2026-02-09")).toBe("9.2.2026");
  });
});

describe("renderContractPdf — letterhead, frame and page numbers", () => {
  it("draws the letterhead on every contract and annex page, and not on appended PDFs", async () => {
    const { pages, text } = await render(snapshot({ annex: scope, attachments: [{ id: "a", fileName: "annex.pdf", sizeBytes: 1 }] }), {
      attachments: [await makeAttachment(2)],
    });
    const body = pages.length - 2;
    expect(body).toBeGreaterThanOrEqual(2); // contract page(s) + Annex A
    pages.slice(0, body).forEach((page) => expect(xobjectCount(page)).toBeGreaterThanOrEqual(1));
    pages.slice(body).forEach((page) => expect(xobjectCount(page)).toBe(0));
    expect(text[body]!.join("\n")).toContain("Attachment page 1");
    expect(text[body + 1]!.join("\n")).toContain("Attachment page 2");
  });

  it("numbers pages n/N counting contract and Annex A only", async () => {
    const { pages, text } = await render(snapshot({ annex: scope, attachments: [{ id: "a", fileName: "annex.pdf", sizeBytes: 1 }] }), {
      attachments: [await makeAttachment(3)],
    });
    const body = pages.length - 3;
    for (let i = 0; i < body; i += 1) expect(text[i]).toContain(`${i + 1}/${body}`);
    for (let i = body; i < pages.length; i += 1) expect(text[i]!.some((t) => /^\d+\/\d+$/.test(t))).toBe(false);
  });

  it("paints the letterhead's own number corner white before the new number (D-2)", async () => {
    const { pages } = await render(snapshot());
    const content = contentsOf(pages[0]!);
    expect(content).toMatch(/1 1 1 rg/);
    // The corner is painted after the letterhead is drawn and before the new number is written.
    expect(content.indexOf(" Do")).toBeLessThan(content.indexOf("1 1 1 rg"));
    expect(content.indexOf("1 1 1 rg")).toBeLessThan(content.lastIndexOf("Tj"));
  });

  it("falls back to the issuer name and address without a letterhead", async () => {
    const { pages, text } = await render(snapshot(), { letterhead: null });
    expect(xobjectCount(pages[0]!)).toBe(0);
    expect(text[0]!.join("\n")).toContain("WellD Sagl");
    expect(text[0]).toContain("1/1");
  });

  it("folds a line break in the issuer name or address into one line, as the engine does (security I-7)", async () => {
    const issuer = { legalName: "Acme\nSagl", addressLines: ["Via Pessina 9\r\nint. 3", "", "6900 Lugano"], vatNumber: null, iban: null };
    const { text } = await render(snapshot({ issuer }), { letterhead: null });
    const first = text[0]!;
    // header: the folded name and address lines, never the halves
    expect(first).toContain("Acme Sagl");
    expect(first).toContain("Via Pessina 9 int. 3");
    expect(first).not.toContain("Acme");
    // footer: one run, folded, so no line starts with a half
    expect(first.join("\n")).toContain("Acme Sagl · Via Pessina 9 int. 3 · 6900 Lugano");
    expect(first).not.toContain("Sagl");
    expect(first).not.toContain("int. 3");
  });

  it("prints the VAT number and the IBAN as the snapshot holds them, in the footer; the registry version is never drawn (T27, AC-6.2, D2)", async () => {
    const issuer = { legalName: "WellD Sagl", addressLines: ["Via Pessina 9", "6900 Lugano"], vatNumber: "CHE-1", iban: "CH93 0076 2011 6238 5295 7" };
    const plain = await render(snapshot({ issuer }), { letterhead: null });
    expect(plain.text[0]!.join(" ")).toContain("WellD Sagl · Via Pessina 9 · 6900 Lugano · P. IVA CHE-1 · IBAN CH93 0076 2011 6238 5295 7");
    const english = await render(snapshot({ issuer, language: "en" }), { letterhead: null });
    expect(english.text[0]!.join(" ")).toContain("VAT CHE-1 · IBAN CH93 0076 2011 6238 5295 7");
    // A snapshot made after the registry carries its version; it changes nothing on the page, so one made before it draws the same bytes.
    const versioned = await render(snapshot({ issuer, legalEntityVersion: 9 }), { letterhead: null });
    expect(Buffer.from(versioned.bytes).equals(Buffer.from(plain.bytes))).toBe(true);
  });

  it("is deterministic for the same inputs", async () => {
    const a = await render(snapshot({ annex: scope }));
    const b = await render(snapshot({ annex: scope }));
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});

describe("renderContractPdf — page 1 and sections", () => {
  it("prints salutation, client, contacts, place and date, and the title", async () => {
    const { text } = await render(snapshot());
    const first = text[0]!;
    expect(first.slice(0, 4)).toEqual(["Spettabile", "Esempio SA", "Via Roma 1", "Italia"]);
    expect(first).toContain("A.c.a. Mario Rossi, Anna Bianchi");
    expect(first).toContain("Lugano, 9.2.2026");
    expect(first).toContain("CONTRATTO DI FORNITURA – Rif. 0017/2026");
  });

  it("omits the contacts line when there are none and speaks English for en", async () => {
    const { text } = await render(snapshot({ language: "en", contacts: [] }));
    expect(text[0]!.some((t) => t.startsWith("A.c.a.") || t.startsWith("Attn."))).toBe(false);
    expect(text[0]).toContain("SUPPLY CONTRACT – Ref. 0017/2026");
    expect(text.flat()).toContain("Acceptance");
  });

  it("numbers sections and sub-headings, headings upper-case", async () => {
    const all = (await render(snapshot())).text.flat();
    expect(all).toContain("1. DEFINIZIONI");
    expect(all).toContain("2. COSTI");
    expect(all).toContain("3. CONDIZIONI GENERALI");
    expect(all).toContain("3.1 LIMITAZIONE");
    expect(all).toContain("3.2 FORO");
  });

  it("prints the index only with Annex A, with the right page numbers", async () => {
    const without = (await render(snapshot())).text.flat();
    expect(without).not.toContain("INDICE");

    const long = "Testo di prova per riempire la pagina. ".repeat(60);
    const sections = Array.from({ length: 6 }, (_, i) => ({ heading: `Sezione ${i + 1}`, body: long, costs: i === 2 }));
    const { text } = await render(snapshot({ sections, annex: scope }));
    expect(text[0]).toContain("INDICE");
    // The index prints label, dot leader and number as three strings.
    const entry = (label: string) => Number(text[0]![text[0]!.indexOf(label) + 2]);
    // The page a heading really sits on: page 1 also holds the index line with the same text.
    const pageOf = (heading: string) => text.findIndex((page, i) => page.filter((t) => t === heading).length > (i === 0 ? 1 : 0)) + 1;
    for (let n = 1; n <= 6; n += 1) expect(entry(`${n}. SEZIONE ${n}`)).toBe(pageOf(`${n}. SEZIONE ${n}`));
    expect(Math.max(...Array.from({ length: 6 }, (_, i) => pageOf(`${i + 1}. SEZIONE ${i + 1}`)))).toBeGreaterThan(2);
    expect(text.flat()).toContain("ALLEGATO A – DETTAGLIO DELL’IMPEGNO");
    const annexNumber = entry("ALLEGATO A – DETTAGLIO DELL’IMPEGNO");
    expect(text[annexNumber - 1]).toContain("Release");
    expect(text.length).toBe(annexNumber); // the annex is the last page
  });

  it("never leaves a heading alone at the bottom of a page", async () => {
    const filler = "Riga di riempimento.\n\n".repeat(34);
    for (let extra = 0; extra < 48; extra += 1) {
      const body = filler + "Riga.\n\n".repeat(extra);
      const { text } = await render(snapshot({ sections: [{ heading: "Uno", body, costs: false }, { heading: "Due", body: "Testo del secondo.\n\nAltro testo.", costs: false }] }));
      text.forEach((page) => {
        const at = page.indexOf("2. DUE");
        // Something follows the heading on the same page besides the page number.
        if (at !== -1) expect(page.length - 1 - at).toBeGreaterThan(1);
      });
    }
  });

  it("keeps the acceptance block together and lists the annexes", async () => {
    const { text } = await render(snapshot({ acceptanceLabel: "Il Cliente", annex: scope, attachments: [{ id: "a", fileName: "Offerta.pdf", sizeBytes: 1 }] }), {
      attachments: [await makeAttachment(1)],
    });
    const page = text.find((p) => p.includes("Per accettazione"))!;
    expect(page).toContain("Il Cliente");
    expect(page).toContain("Luogo e data:");
    expect(page).toContain("Firma valida del Cliente:");
    const all = text.flat();
    expect(all).toContain("Allegati:");
    expect(all).toContain("Allegato A - Dettaglio dell’impegno");
    expect(all).toContain("Allegato B - Offerta.pdf");
  });

  it("letters attachments from A when there is no effort annex", async () => {
    const { text } = await render(snapshot({ attachments: [{ id: "a", fileName: "Offerta.pdf", sizeBytes: 1 }] }), { attachments: [await makeAttachment(1)] });
    expect(text.flat()).toContain("Allegato A - Offerta.pdf");
  });
});

describe("renderContractPdf — cost table (AC-1.5)", () => {
  const costs = (over: Partial<ContractSnapshot["costs"]>): ContractSnapshot["costs"] => ({ ...snapshot().costs, ...over });

  it("numbers one-off and yearly lines but not discounts, and prints discounts negative", async () => {
    const lines = [
      line({ description: "Una tantum", totalCents: 700_000 }),
      line({ description: "Sconto", kind: "discount", unitCents: 300_000, totalCents: 300_000 }),
      line({ description: "Canone", kind: "yearly", totalCents: 120_000 }),
    ];
    const { text } = await render(snapshot({ costs: costs({ lines, oneOffCents: 400_000, yearlyCents: 120_000 }) }));
    const page = text.flat();
    expect(page).toContain("Pos.");
    expect(page).toContain("Voce di costo");
    expect(page).toContain("Totale CHF");
    expect(page).toContain("7’000");
    expect(page).toContain("- 3’000");
    expect(page).toContain("1.200".replace(".", "’"));
    // Positions: "1" for the first line, "2" for the yearly line; the discount gets none.
    const numbers = page.filter((t) => t === "1" || t === "2" || t === "3");
    expect(numbers).toEqual(["1", "2"]);
  });

  it("shows a percentage discount as 10% in the unit column, or appended when that column is off", async () => {
    const discount = line({ description: "Scontistica riservata", kind: "discount", unitCents: null, percentBp: 1000, totalCents: 70_000 });
    const withUnit = (await render(snapshot({ costs: costs({ columns: { position: true, unit: true }, lines: [line(), discount], oneOffCents: 630_000 }) }))).text.flat();
    expect(withUnit).toContain("10%");
    expect(withUnit).toContain("CHF / unità");
    expect(withUnit).toContain("Qt.");
    expect(withUnit).toContain("- 700");
    const without = (await render(snapshot({ costs: costs({ lines: [line(), discount], oneOffCents: 630_000 }) }))).text.flat();
    expect(without).toContain("Scontistica riservata (10%)");
  });

  it("prints a bold TOTALE row with the one-off total only when showTotal is on", async () => {
    const on = (await render(snapshot({ costs: costs({ showTotal: true, oneOffCents: 650_000 }) }))).text.flat();
    expect(on).toContain("TOTALE");
    expect(on).toContain("6’500");
    const off = (await render(snapshot({ costs: costs({ showTotal: false }) }))).text.flat();
    expect(off).not.toContain("TOTALE");
  });

  it("uses grouping and decimals of the currency", async () => {
    const eur = costs({ currency: "EUR", lines: [line({ totalCents: 3_630_050, unitCents: 3_630_050 })], showTotal: false });
    const flat = (await render(snapshot({ costs: eur }))).text.flat();
    expect(flat).toContain("36.300,50");
    expect(flat).toContain("Totale EUR");
  });

  it("wraps long descriptions inside their cell instead of overflowing", async () => {
    const long = line({ description: "Descrizione molto lunga ".repeat(20) });
    const { text } = await render(snapshot({ costs: costs({ lines: [long] }) }));
    expect(text.flat().filter((t) => t.startsWith("Descrizione molto")).length).toBeGreaterThan(1);
  });

  it("repeats the header when a long table continues on the next page", async () => {
    const lines = Array.from({ length: 70 }, (_, i) => line({ description: `Voce ${i + 1}` }));
    const { text } = await render(snapshot({ costs: costs({ lines, oneOffCents: 70 * 700_000 }) }));
    expect(text.filter((page) => page.includes("Voce di costo")).length).toBeGreaterThan(1);
  });
});

describe("renderContractPdf — pathological text", () => {
  it("hard-breaks one 20 000-character word in linear time, in a body and in a table cell", async () => {
    const word = "x".repeat(20_000);
    const started = performance.now();
    const { text } = await render(snapshot({ sections: [{ heading: "Uno", body: word, costs: false }, { heading: "Due", body: `| a | b |\n|---|---|\n| ${word} | y |`, costs: false }] }));
    expect(performance.now() - started).toBeLessThan(1500);
    expect(text.flat().join("").split("x").length - 1).toBeGreaterThanOrEqual(20_000);
  });

  it("renders 15 sections of 20 000 characters within the budget", async () => {
    const sections = Array.from({ length: 15 }, (_, i) => ({ heading: `S${i}`, body: "y".repeat(20_000), costs: false }));
    const started = performance.now();
    await render(snapshot({ sections }));
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("right-aligns the index page numbers: every dot leader ends at the same x", async () => {
    const { pages } = await render(snapshot({ annex: scope }));
    // Each leader is a Tm followed by a hex string of dots (0x2E); its end is x + dots × glyph width.
    const ends = [...contentsOf(pages[0]!).matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm\s+<((?:2E){4,})>/g)].map(
      (m) => Number(m[1]) + (m[2]!.length / 2) * 2.78,
    );
    expect(ends.length).toBe(4); // three sections and the annex
    expect(Math.max(...ends) - Math.min(...ends)).toBeLessThan(2.78);
  });
});

describe("renderContractPdf — Annex A", () => {
  it("prints releases, epics, one-decimal man-days with a comma, the total and the AI note, and no price", async () => {
    const { text } = await render(snapshot({ annex: scope }));
    const annexPage = text.find((p) => p.includes("ALLEGATO A – DETTAGLIO DELL’IMPEGNO") && p.includes("Release"))!;
    expect(annexPage).toContain("Autenticazione");
    expect(annexPage).toContain("30,5");
    expect(annexPage).toContain("176,5");
    expect(annexPage).toContain("Totale");
    expect(annexPage.some((t) => t.includes("AI"))).toBe(true);
    expect(annexPage.some((t) => /CHF|’000/.test(t))).toBe(false);
  });

  it("uses a decimal point in English and omits the AI note when not AI-assisted", async () => {
    const { text } = await render(snapshot({ language: "en", annex: { ...scope, aiAssisted: false } }));
    const flat = text.flat();
    expect(flat).toContain("ANNEX A – EFFORT DETAIL");
    expect(flat).toContain("176.5");
    expect(flat.some((t) => t.includes("AI-assisted"))).toBe(false);
  });
});

describe("renderContractPdf — attachments", () => {
  it("appends every attachment page unchanged after the contract", async () => {
    const { pages } = await render(snapshot({ attachments: [{ id: "a", fileName: "a.pdf", sizeBytes: 1 }, { id: "b", fileName: "b.pdf", sizeBytes: 1 }] }), {
      attachments: [await makeAttachment(2, "First"), await makeAttachment(1, "Second")],
    });
    const base = (await render(snapshot())).pages.length;
    expect(pages.length).toBe(base + 3);
  });

  it("throws AttachmentUnreadableError with the file name for an unreadable PDF", async () => {
    const error = await renderContractPdf(snapshot({ attachments: [{ id: "a", fileName: "broken.pdf", sizeBytes: 3 }] }), {
      letterhead: null,
      attachments: [new Uint8Array([1, 2, 3])],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttachmentUnreadableError);
    expect((error as AttachmentUnreadableError).fileName).toBe("broken.pdf");
  });
});

describe("renderContractPdf — an attachment is bounded before pdf-lib loads it (security M-7)", () => {
  it("refuses an object-stream bomb with the file's name and never hands it to PDFDocument.load", async () => {
    const bomb = objStmBombPdf(await deflatedRun(16));
    const load = spyOn(PDFDocument, "load");
    try {
      const error = await renderContractPdf(snapshot({ attachments: [{ id: "a", fileName: "bomb.pdf", sizeBytes: bomb.length }] }), {
        letterhead: null,
        attachments: [bomb],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AttachmentUnreadableError);
      expect((error as AttachmentUnreadableError).fileName).toBe("bomb.pdf");
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("an attachment whose check was killed (time or memory) is refused by name and never loaded; a child that cannot answer propagates as a 503", async () => {
    const check = spyOn(isolated, "boundPdfIsolated").mockResolvedValueOnce({ ok: false, reason: "too_complex" });
    const load = spyOn(PDFDocument, "load");
    try {
      const input = { letterhead: null, attachments: [new Uint8Array([1, 2, 3])] };
      const killed = await renderContractPdf(snapshot({ attachments: [{ id: "a", fileName: "slow.pdf", sizeBytes: 3 }] }), input).catch((e: unknown) => e);
      expect(killed).toBeInstanceOf(AttachmentUnreadableError);
      expect((killed as AttachmentUnreadableError).fileName).toBe("slow.pdf");
      expect(load).not.toHaveBeenCalled();
      check.mockRejectedValueOnce(new isolated.PdfCheckUnavailableError());
      const unanswered = await renderContractPdf(snapshot({ attachments: [{ id: "a", fileName: "slow.pdf", sizeBytes: 3 }] }), input).catch((e: unknown) => e);
      expect(unanswered).toBeInstanceOf(isolated.PdfCheckUnavailableError);
    } finally {
      check.mockRestore();
      load.mockRestore();
    }
  });

  it("refuses every filter the bound cannot measure (LZW here), and still appends a good one", async () => {
    const lzw = Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    const bytes = new Uint8Array(Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /LZWDecode /Length 9 >>\nstream\n"), lzw, Buffer.from("\nendstream\nendobj\n")]));
    const error = await renderContractPdf(snapshot({ attachments: [{ id: "a", fileName: "old.pdf", sizeBytes: bytes.length }] }), {
      letterhead: null,
      attachments: [bytes],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttachmentUnreadableError);
    const ok = await render(snapshot({ attachments: [{ id: "a", fileName: "a.pdf", sizeBytes: 1 }] }), { attachments: [await makeAttachment(1, "Fine")] });
    expect(ok.pages.length).toBeGreaterThan(1);
  });
});

describe("renderContractPdf — seeded templates", () => {
  const substitute = (source: string): string =>
    source
      .replaceAll("{deal}", "Piattaforma analisi")
      .replaceAll("{issuer}", "WellD Sagl")
      .replaceAll("{client}", "Esempio SA")
      .replaceAll("{currency}", "CHF")
      .replaceAll("{validityDays}", "30")
      .replaceAll("{manDays}", "142")
      .replaceAll("{epics}", "1. Auth\n2. Ingestione")
      .replaceAll("{phases}", "- Fase 1: Auth")
      .replaceAll("{timeline}", "| Fase | Mesi |\n|---|---|\n| Fase 1 | 3 - 4 |")
      .replaceAll("{release}", "MVP");

  it.each(DEFAULT_TEMPLATES_IT.map((template) => [template.name, template] as const))("renders %s", async (_name, template) => {
    const lines: OfferCostLine[] = template.costLines.map((costLine) =>
      line({
        description: substitute(costLine.description),
        kind: costLine.kind,
        unitCents: 700_000,
        totalCents: 700_000,
        ...(costLine.kind === "discount" ? { percentBp: 1000, unitCents: null } : {}),
      }),
    );
    const snap = snapshot({
      template: { id: "x", name: template.name },
      salutation: template.salutation,
      opening: substitute(template.opening),
      sections: template.sections.map((s) => ({ ...s, body: substitute(s.body) })),
      costs: { currency: "CHF", columns: template.costColumns, showTotal: template.showTotal, lines, oneOffCents: 700_000, yearlyCents: 0 },
      acceptanceLabel: template.acceptanceLabel,
      annex: template.annex ? scope : null,
    });
    const { pages, text } = await render(snap);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    // Every section heading made it to a page, numbered.
    template.sections.forEach((section, index) => expect(text.flat()).toContain(`${index + 1}. ${section.heading.toUpperCase()}`));
  });
});
