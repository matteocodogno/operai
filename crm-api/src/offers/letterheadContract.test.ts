/**
 * Contract test of crm-api against the REAL letterhead-api (specs/20261116-letterhead-service T31; AC-10.3, AC-10.9,
 * AC-1.3 with amendments A5 and A6, AC-10.1, AC-10.2, AC-10.10).
 *
 * Every other test of the service path stubs `fetch`; this one does not. crm-api's REAL client (`createLetterheadClient`)
 * calls a running letterhead-api, and the draft preview route, the generate route and the append of the deal PDFs run
 * unchanged on top of it, against real Postgres (the test world) and the in-memory bucket of the test world.
 *
 * ── Environment ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   LETTERHEAD_CONTRACT_URL         Base URL of a running letterhead-api, e.g. `http://localhost:8088` (compose) or
 *                                   `http://localhost:18131`. UNSET: the whole file is SKIPPED, with a message naming this
 *                                   variable (so a plain `bun test` stays green without the service).
 *   LETTERHEAD_REQUIRE_CONTRACT     `1`: an unset LETTERHEAD_CONTRACT_URL FAILS instead of skipping (CI / the compose gate).
 *   DATABASE_URL                    The CRM database of the test world (as for every crm-api route test), migrated.
 *
 *   The credential, exactly one of:
 *   LETTERHEAD_CONTRACT_TOKEN       A ready service JWT (`sub system:crm-api`, scope `letterhead:render`, the service's
 *                                   SERVICE_AUDIENCE), e.g. from `auth POST /system/service-token`.
 *   (otherwise) a LOCAL JWKS        The test generates a key, serves its public half on LETTERHEAD_CONTRACT_JWKS_PORT
 *                                   (default 18089, bound on 0.0.0.0 so a container reaches it) and mints its own tokens. The
 *                                   service must be started with AUTH_JWKS_URL=http://<this machine>:<port>/auth/jwks,
 *                                   AUTH_ISSUER = LETTERHEAD_CONTRACT_ISSUER (default `http://localhost:3001`) and
 *                                   SERVICE_AUDIENCE = LETTERHEAD_CONTRACT_AUDIENCE (default `operai-service`). The key is kept
 *                                   in the OS temp directory (`letterhead-contract-jwks.json`, mode 0600) and reused, because
 *                                   the service re-reads a key set for an unknown `kid` at most once every 30 s: a new key per
 *                                   run would make a second run within 30 s a 401.
 *
 *   What the service must hold: an ACTIVE letterhead for BOTH `welld_ch` and `welld_it` (a local one is seeded with
 *   `letterhead-api/perf/seed-local.ts`, which seeds `welld_it`; a version for `welld_ch` is the same script with the entity
 *   changed), and the means to read the issuer's details itself (specs/20261117-legal-entities T28: the compose service has its
 *   own client at `auth` and reads `GET /system/legal-entities`, so `auth` must be running with the entities moved: a service
 *   that cannot read them answers 503 `legal_entities_unavailable`, which the first tests name). The first test names what is
 *   missing. Nothing here writes to the service: it only renders.
 *
 *   The registry of crm-api's side is the test world's fake (`registry`). The service reads auth's own, whose version this test
 *   does not choose, so before each test the fake is set to the version the SERVICE holds, which the service itself tells: a pin
 *   no registry holds is answered 409 `legal_entity_version_mismatch` with `currentVersion` (`aligned`). The details the fake holds
 *   are the world's, not auth's: the body prints the world's issuer and the frame the service's, which no assertion here compares.
 *
 * ── What it proves ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   Content version 2 (no `entityData`, pinned by `legalEntityVersion`): the answers name the version the service printed, and
 *   a pin that is not the one in use is the 409 the client turns into `LegalEntityVersionMismatch` (the retry of AC-6.2 is
 *   proved in `generation.letterhead.test.ts`, with a stub service that can be told to mismatch).
 *
 *   For an Italian offer (the seeded wizard template "Progetto a corpo", welld_ch), an English one (welld_it) and an Italian one
 *   with two appended deal PDFs (the seeded "Manutenzione e SLA"), taken through the real routes:
 *     1. draft -> preview: the page count and the text of every page the service returns;
 *     2. draft -> generate: the PDF crm-api stores. Its rendered pages (the stored page count minus the appended pages) are
 *        counted with pdf-lib, and the text of EACH of them is read from the PDF's own content streams (a ToUnicode reader
 *        written here: no pdfium) and compared, whitespace normalised, with 1 and with the service's own preview of the exact
 *        blocks that were sent to `/v1/render/pdf` (AC-1.3, A5). No unprintable character is in these documents (A6: N is 0, so
 *        the text is equal, with no exception);
 *     3. a new offer's preview has no reference yet (it prints the pending label) and the PDF prints the one the offer took: the
 *        only difference allowed is that label, and the blocks of the two are equal except where it is printed. An EDIT of an
 *        issued-unsent offer previews with its own reference, so there page count, text and blocks are equal with no exception.
 *     4. the deal PDFs follow the rendered pages, in the order chosen, with their pages untouched and no number on them, and
 *        "N / M" on each rendered page counts the rendered pages only (AC-10.3);
 *     5. offers made before the switch keep their row, snapshot, stored bytes and download, byte for byte, while offers are
 *        generated, edited and revised through the service next to them (AC-10.9); the service is asked for nothing else.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, type PDFObject } from "pdf-lib";
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
// The test world first: it sets the environment the other modules read when they load.
import { bucket, call, db, insertOfferRow, makeDraftTemplate, makeReadyDeal, readyDealWithProfiles, registry, resetWorld, storedPdfAttachment, worldIssuer } from "../test-support/world";
import { env } from "../lib/env";
import { createLetterheadClient, letterhead, LegalEntityVersionMismatch, type LetterheadClient, type PreviewAnswer, type RenderedPdf } from "../lib/letterheadClient";
import type { LetterheadContent } from "./blocks";
import { parseTemplate } from "./engine/syntax";

// ─── Whether it runs ─────────────────────────────────────────────────────────────────────────────────────────────────

const URL_VARIABLE = "LETTERHEAD_CONTRACT_URL";
const baseUrl = process.env[URL_VARIABLE]?.trim().replace(/\/+$/, "") || undefined;
const required = process.env["LETTERHEAD_REQUIRE_CONTRACT"] === "1";

// ─── The credential ──────────────────────────────────────────────────────────────────────────────────────────────────

const ISSUER = process.env["LETTERHEAD_CONTRACT_ISSUER"] ?? "http://localhost:3001";
const AUDIENCE = process.env["LETTERHEAD_CONTRACT_AUDIENCE"] ?? "operai-service";
const JWKS_PORT = Number(process.env["LETTERHEAD_CONTRACT_JWKS_PORT"] ?? "18089");
const KEY_FILE = join(tmpdir(), "letterhead-contract-jwks.json");

interface Credential {
  getToken(): Promise<string>;
  stop(): void;
}

/** A token the caller made, or a key of this test's own whose public half is served for the service to fetch. */
async function credential(): Promise<Credential> {
  const given = process.env["LETTERHEAD_CONTRACT_TOKEN"]?.trim();
  if (given) return { getToken: async () => given, stop() {} };

  let stored: { kid: string; publicJwk: JWK; privateJwk: JWK } | null = null;
  if (existsSync(KEY_FILE)) {
    try {
      stored = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    } catch {
      stored = null;
    }
  }
  if (stored === null) {
    const pair = await generateKeyPair("RS256", { extractable: true });
    stored = { kid: `contract-${crypto.randomUUID().slice(0, 8)}`, publicJwk: await exportJWK(pair.publicKey), privateJwk: await exportJWK(pair.privateKey) };
    writeFileSync(KEY_FILE, JSON.stringify(stored), { mode: 0o600 });
  }
  const { kid } = stored;
  const privateKey = await importJWK(stored.privateJwk, "RS256");
  const jwk = { ...stored.publicJwk, kid, alg: "RS256", use: "sig" };
  const server = Bun.serve({
    port: JWKS_PORT,
    hostname: "0.0.0.0",
    fetch: (request) => (new URL(request.url).pathname === "/auth/jwks" ? Response.json({ keys: [jwk] }) : new Response("not found", { status: 404 })),
  });
  return {
    getToken: () =>
      new SignJWT({ scope: "letterhead:render" })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject("system:crm-api")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(privateKey),
    stop: () => server.stop(true),
  };
}

// ─── Reading a PDF ───────────────────────────────────────────────────────────────────────────────────────────────────
// pdfium is not used. The page count is pdf-lib's. The text is read from the page's own content streams: a text run is
// `q … e f cm … BT /fN size Tf [(codes)] TJ ET`, its codes are two-byte glyph ids, and the font's /ToUnicode CMap says what
// each one is. This is what a text extractor does for a Typst PDF, and it reads what the PDF draws, not what the request said.

type Cmap = Map<number, string>;

const utf16 = (hex: string): string => {
  const bytes = hex.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [];
  let out = "";
  for (let at = 0; at + 1 < bytes.length; at += 2) out += String.fromCharCode((bytes[at]! << 8) | bytes[at + 1]!);
  return out;
};

function parseCmap(text: string): Cmap {
  const map: Cmap = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(pair[1]!, 16), utf16(pair[2]!));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const low = parseInt(range[1]!, 16);
      const high = parseInt(range[2]!, 16);
      const target = range[3]!;
      if (target.startsWith("[")) {
        [...target.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((one, index) => map.set(low + index, utf16(one[1]!)));
      } else {
        const first = utf16(target.slice(1, -1));
        for (let code = low; code <= high; code += 1) map.set(code, first.slice(0, -1) + String.fromCharCode(first.charCodeAt(first.length - 1) + (code - low)));
      }
    }
  }
  return map;
}

const streamText = (doc: PDFDocument, object: PDFObject | undefined): string => {
  const resolved = object instanceof PDFRef ? doc.context.lookup(object) : object;
  return resolved instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(resolved).decode()).toString("latin1") : "";
};

function stringBytes(body: string): number[] {
  const out: number[] = [];
  const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
  for (let at = 0; at < body.length; at += 1) {
    const ch = body[at]!;
    if (ch !== "\\") {
      out.push(ch.charCodeAt(0));
      continue;
    }
    const next = body[at + 1]!;
    if (/[0-7]/.test(next)) {
      let octal = next;
      let end = at + 2;
      while (end < body.length && octal.length < 3 && /[0-7]/.test(body[end]!)) octal += body[end++];
      out.push(parseInt(octal, 8));
      at = end - 1;
    } else {
      out.push(next in escapes ? escapes[next]! : next.charCodeAt(0));
      at += 1;
    }
  }
  return out;
}

/** The raw drawing instructions of a page, decoded: what was drawn on it, by whoever drew it. */
function contentOf(doc: PDFDocument, index: number): string {
  const contents = doc.getPage(index).node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray().map((ref) => streamText(doc, ref)) : [streamText(doc, contents)];
  return parts.join("\n");
}

/**
 * What a text object shows: the strings of its `TJ` arrays (and `Tj`) as bytes, and the adjustments between them as numbers.
 * Scanned, not matched: a glyph id may be 0x5D, a raw `]` inside a string, and a string may hold balanced parentheses.
 */
function shownItems(body: string): (number[] | number)[] {
  const items: (number[] | number)[] = [];
  const readString = (from: number): { bytes: number[]; end: number } => {
    let depth = 1;
    let at = from + 1;
    const start = at;
    while (at < body.length && depth > 0) {
      const ch = body[at]!;
      if (ch === "\\") at += 2;
      else {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        at += 1;
      }
    }
    return { bytes: stringBytes(body.slice(start, at - 1)), end: at };
  };
  let inArray = false;
  for (let at = 0; at < body.length; ) {
    const ch = body[at]!;
    if (ch === "(") {
      const { bytes, end } = readString(at);
      items.push(bytes);
      at = end;
    } else if (ch === "[") {
      inArray = true;
      at += 1;
    } else if (ch === "]") {
      inArray = false;
      at += 1;
    } else if (inArray && /[-\d.]/.test(ch)) {
      const number = /^-?\d*\.?\d+/.exec(body.slice(at));
      items.push(Number(number?.[0] ?? 0));
      at += number?.[0].length || 1;
    } else at += 1;
  }
  return items;
}

interface PdfFont {
  readonly cmap: Cmap;
  /** Glyph advance in thousandths of the font size. */
  readonly width: (code: number) => number;
}

/** A Type0 font's `/W` array (`c [w1 w2 …]` and `first last w`) and `/DW`. */
function fontOf(doc: PDFDocument, font: PDFDict): PdfFont {
  const cmap = parseCmap(streamText(doc, font.get(PDFName.of("ToUnicode"))));
  const widths = new Map<number, number>();
  let fallback = 1000;
  const descendants = font.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
  const cid = descendants ? doc.context.lookupMaybe(descendants.get(0), PDFDict) : undefined;
  if (cid) {
    const dw = cid.lookupMaybe(PDFName.of("DW"), PDFNumber);
    if (dw) fallback = dw.asNumber();
    const list = cid.lookupMaybe(PDFName.of("W"), PDFArray)?.asArray().map((item) => doc.context.lookup(item)) ?? [];
    for (let at = 0; at < list.length; ) {
      const first = (list[at] as PDFNumber).asNumber();
      const next = list[at + 1];
      if (next instanceof PDFArray) {
        next.asArray().forEach((width, offset) => widths.set(first + offset, (doc.context.lookup(width) as PDFNumber).asNumber()));
        at += 2;
      } else {
        const last = (next as PDFNumber).asNumber();
        const width = (list[at + 2] as PDFNumber).asNumber();
        for (let code = first; code <= last; code += 1) widths.set(code, width);
        at += 3;
      }
    }
  }
  return { cmap, width: (code) => widths.get(code) ?? fallback };
}

interface Run {
  readonly x: number;
  readonly y: number;
  readonly advance: number;
  readonly text: string;
}

const numbers = (text: string): number[] => text.trim().split(/\s+/).map(Number);
const MATRIX = "((?:-?[\\d.]+\\s+){5}-?[\\d.]+)\\s+cm";

/**
 * The text of the first `count` pages of a PDF, in the order the PDF draws it. A run is a `BT … ET` with a font, a size and
 * `TJ` strings of glyph codes; where it starts comes from the matrices (`cm`, `Tm`) and where it ends from the font's glyph
 * widths and the `TJ` adjustments. A run that begins where the one before it ended, on the same baseline, continues it (a
 * change of style inside a sentence is not a line break); any other run starts a new line.
 */
async function pdfPageTexts(bytes: Uint8Array, count: number): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const fonts = doc.getPage(index).node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    const known = new Map<string, PdfFont>();
    for (const [name, ref] of fonts?.entries() ?? []) known.set(name.asString().slice(1), fontOf(doc, doc.context.lookup(ref, PDFDict)));

    const runs: Run[] = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const saved: number[][] = [];
    const tokens = contentOf(doc, index).matchAll(new RegExp(`(?<![\\w/])(q|Q)(?![\\w])|${MATRIX}|BT([^]*?)ET`, "g"));
    for (const token of tokens) {
      if (token[1] === "q") saved.push(ctm);
      else if (token[1] === "Q") ctm = saved.pop() ?? ctm;
      else if (token[2] !== undefined) {
        const [a, b, c, d, e, f] = numbers(token[2]) as [number, number, number, number, number, number];
        const [A, B, C, D, E, F] = ctm as [number, number, number, number, number, number];
        ctm = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
      } else if (token[3] !== undefined) {
        const body = token[3];
        const selected = /\/(\w+)\s+([\d.]+)\s+Tf/.exec(body);
        const font = selected ? known.get(selected[1]!) : undefined;
        if (!selected || !font) continue;
        const size = Number(selected[2]);
        const tm = /((?:-?[\d.]+\s+){5}-?[\d.]+)\s*Tm/.exec(body);
        const [ta = 1, , , td = 1, te = 0, tf = 0] = tm ? numbers(tm[1]!) : [];
        const scale = Math.abs(ctm[0]! * ta);
        let text = "";
        let advance = 0;
        for (const item of shownItems(body)) {
          if (typeof item === "number") {
            advance -= (item / 1000) * size * scale;
            continue;
          }
          for (let at = 0; at + 1 < item.length; at += 2) {
            const code = (item[at]! << 8) | item[at + 1]!;
            text += font.cmap.get(code) ?? "\uFFFD";
            advance += (font.width(code) / 1000) * size * scale;
          }
        }
        void td;
        if (text !== "") runs.push({ x: ctm[0]! * te + ctm[2]! * tf + ctm[4]!, y: ctm[1]! * te + ctm[3]! * tf + ctm[5]!, advance, text });
      }
    }
    const lines: { text: string; y: number; end: number }[] = [];
    for (const run of runs) {
      const last = lines.at(-1);
      if (last && Math.abs(run.y - last.y) < 0.2 && Math.abs(run.x - last.end) < 1) {
        last.text += run.text;
        last.end = run.x + run.advance;
      } else {
        lines.push({ text: run.text, y: run.y, end: run.x + run.advance });
      }
    }
    texts.push(lines.map((line) => line.text).join("\n"));
  }
  return texts;
}

/** The text of a block, runs and cells in order: what its shape is compared by when the reference makes the runs differ. */
function textOfBlock(block: any): string {
  switch (block.type) {
    case "paragraph":
      return block.runs.map((run: { text: string }) => run.text).join("");
    case "heading":
      return block.text;
    case "list":
      return block.items.map((item: { runs: { text: string }[] }) => item.runs.map((run) => run.text).join("")).join("\n");
    case "table":
      return [...(block.header ?? []), ...block.rows.flat()].map((cell: any[]) => cell.map(textOfBlock).join("\n")).join("\t");
    default:
      return "";
  }
}

/** AC-1.3, A5: every run of whitespace is one space. */
const squeeze = (text: string): string => text.replace(/\s+/g, " ").trim();

const sizeOf = (doc: PDFDocument, index: number): string => {
  const { width, height } = doc.getPage(index).getSize();
  return `${Math.round(width)}x${Math.round(height)}`;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A deal's own PDF: pages of the given sizes, each with a line of text of its own. */
async function dealPdf(name: string, sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach((size, index) => doc.addPage(size).drawText(`DEAL PDF ${name} PAGE ${index + 1}`, { x: 20, y: 100, size: 10, font }));
  return doc.save({ useObjectStreams: false });
}

// ─── The contract ────────────────────────────────────────────────────────────────────────────────────────────────────

/** crm-api's pending label for a reference the offer has not taken yet (blocks.ts `PENDING_REFERENCE`). */
const PENDING: Record<"it" | "en", string> = { it: "NNNN/AAAA", en: "NNNN/YYYY" };
/** What the preview of a new offer prints where the PDF prints the reference: the title's label, and the field's name inside a text. */
const PENDING_MARKERS = /NNNN\/(?:AAAA|YYYY)|\bRIF\b/g;
const YEAR = new Date().getUTCFullYear();
const noMatch = { "If-None-Match": "*" };

function defineContract(url: string): void {
  let who: Credential;
  let real: LetterheadClient;
  const spies: { mockRestore(): void }[] = [];
  const switchWas = env.LETTERHEAD_SERVICE_ENABLED;

  /** Every request that reached the service, and every answer of the real client. */
  const traffic: { path: string; status: number }[] = [];
  const seen = { previews: [] as { content: LetterheadContent; answer: PreviewAnswer }[], pdfs: [] as { content: LetterheadContent; answer: RenderedPdf }[] };
  const report: string[] = [];
  let active: Record<string, { activeVersion: number } | null> = {};

  beforeAll(async () => {
    who = await credential();
    const countingFetch = (async (input: unknown, init?: RequestInit) => {
      const res = await fetch(input as string, init);
      traffic.push({ path: new globalThis.URL(String(input)).pathname, status: res.status });
      return res;
    }) as typeof fetch;
    real = createLetterheadClient({ baseUrl: url, tokens: { getToken: () => who.getToken(), invalidate() {} }, fetchImpl: countingFetch });
    // The routes call `letterhead.*`: the same real client, with what it answered kept for the assertions.
    spies.push(
      spyOn(letterhead, "preview").mockImplementation(async (content, options) => {
        const answer = await real.preview(content, options);
        seen.previews.push({ content, answer });
        return answer;
      }),
      spyOn(letterhead, "pdf").mockImplementation(async (content, options) => {
        const answer = await real.pdf(content, options);
        seen.pdfs.push({ content, answer });
        return answer;
      }),
    );
    env.LETTERHEAD_SERVICE_ENABLED = true;
  });

  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
    env.LETTERHEAD_SERVICE_ENABLED = switchWas;
    who?.stop();
    if (report.length > 0) console.log(`\n[letterhead contract] ${url}\n${report.join("\n")}\n`);
  });

  type IssuerEntity = "welld_ch" | "welld_it";
  /** The version of the issuer's details each entity has AT THE SERVICE, learned once from its own 409 (see the header). */
  let held: Record<IssuerEntity, number> | null = null;

  /** A pin no registry holds (the largest the service accepts): the service answers with the version it prints. */
  async function serviceIssuerVersions(): Promise<Record<IssuerEntity, number>> {
    if (held !== null) return held;
    const found = {} as Record<IssuerEntity, number>;
    for (const entity of ["welld_ch", "welld_it"] as const) {
      const probe: LetterheadContent = { contentVersion: 2, entity, language: "it", legalEntityVersion: 2_147_483_647, blocks: [{ type: "paragraph", runs: [{ text: "Which version of the issuer's details do you print?" }] }] };
      try {
        await real.preview(probe, { pages: [1] });
        throw new Error(`the service printed ${entity} for the pin 2147483647: it does not check the pin`);
      } catch (error) {
        if (!(error instanceof LegalEntityVersionMismatch)) {
          const reason = error instanceof Error && "extras" in error ? JSON.stringify((error as { extras: unknown }).extras) : String(error);
          throw new Error(
            `the service did not say which version of the issuer's details it holds for ${entity} (${reason}): it must read them itself, so auth must be running with the legal entities moved and the service's own client configured (see the header)`,
          );
        }
        if (error.currentVersion === null) throw new Error(`the service's 409 for ${entity} did not name the version in use`);
        found[entity] = error.currentVersion;
      }
    }
    held = found;
    return found;
  }

  /** The fake registry of crm-api's side at the versions the service holds: the pin of every document of a test is the service's. */
  async function alignRegistry(): Promise<void> {
    // The first test proves the service is reachable and says what is missing; until it has passed there is nothing to ask.
    if (Object.keys(active).length === 0) return;
    const versions = await serviceIssuerVersions();
    for (const entity of ["welld_ch", "welld_it"] as const) registry.set({ ...worldIssuer(entity), version: versions[entity] });
  }

  beforeEach(async () => {
    await resetWorld();
    traffic.length = 0;
    seen.previews.length = 0;
    seen.pdfs.length = 0;
    env.LETTERHEAD_SERVICE_ENABLED = true;
    await alignRegistry();
    traffic.length = 0;
  });

  afterEach(() => {
    env.LETTERHEAD_SERVICE_ENABLED = true;
  });

  // ─── Helpers over the real routes ──────────────────────────────────────────────────────────────────────────────────

  interface Setup {
    dealId: string;
    entity: "welld_ch" | "welld_it";
    language: "it" | "en";
    templateId: string;
    source: string;
    draft: { answers: any; version: number; templateVersion: number; target: { kind: "new" | "edit" | "revision"; offerId?: string } };
  }

  const targetOf = (s: Setup) => (s.draft.target.kind === "new" ? { kind: "new" } : { kind: s.draft.target.kind, offerId: s.draft.target.offerId });

  type Template = { id: string; language: "it" | "en"; source: string };

  async function seededTemplate(entity: "welld_ch", name: string): Promise<Template> {
    const list = await call("GET", `/offer-templates?entity=${entity}&formats=wizard`);
    const found = list.json.items.find((item: { name: string }) => item.name === name);
    if (!found) throw new Error(`the seeded wizard template "${name}" is not there: ${JSON.stringify(list.json.items.map((item: { name: string }) => item.name))}`);
    return found;
  }

  async function startDraft(entity: "welld_ch" | "welld_it", template: () => Promise<Template>): Promise<Setup> {
    const { deal } = await readyDealWithProfiles({ entity });
    const chosen = await template();
    const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: chosen.id }, headers: noMatch });
    if (created.status !== 201) throw new Error(`draft: ${created.status} ${JSON.stringify(created.json)}`);
    return { dealId: deal.id, entity, language: chosen.language, templateId: chosen.id, source: chosen.source, draft: created.json };
  }

  /** Saves `change(answers)` through the API. */
  async function save(s: Setup, change: (answers: any) => void): Promise<void> {
    const answers = structuredClone(s.draft.answers);
    change(answers);
    const res = await call("PUT", `/deals/${s.dealId}/offer-draft`, {
      ifMatch: s.draft.version,
      body: { templateVersion: s.draft.templateVersion, target: targetOf(s), answers },
    });
    if (res.status !== 200) throw new Error(`save: ${res.status} ${JSON.stringify(res.json)}`);
    s.draft = res.json;
  }

  const previewRoute = (s: Setup) =>
    call("POST", `/deals/${s.dealId}/offer-draft/preview`, { body: { templateVersion: s.draft.templateVersion, target: targetOf(s), answers: s.draft.answers } });

  /** Fills what the template still asks for, as a person would (an option from its list, a figure, a date, or a line of text), until the preview lists nothing missing. */
  async function complete(s: Setup): Promise<void> {
    const { ast } = parseTemplate(s.source);
    for (let round = 0; round < 4; round += 1) {
      const res = await previewRoute(s);
      if (res.status !== 200) throw new Error(`preview while completing: ${res.status} ${JSON.stringify(res.json)}`);
      const missing = res.json.missingFields as { name: string }[];
      if (missing.length === 0) return;
      if (round === 3) throw new Error(`the draft could not be completed with answers for its fields; still missing: ${JSON.stringify(res.json.missingFields)}`);
      await save(s, (answers) => {
        for (const { name } of missing) {
          if (name.startsWith("cost:")) {
            // a cost line without its figures: a unit price and one unit
            const line = (answers.costs.lines[name.slice("cost:".length)] ??= {});
            line.unitCents ??= 120_000;
            line.quantity ??= 1;
            continue;
          }
          const field = ast.fields.find((declared) => declared.name === name);
          const value = field?.options?.[0] ?? (field?.kind === "number" || field?.kind === "percentage" ? "10" : field?.kind === "amount" ? 150_000 : field?.kind === "date" ? "2026-11-17" : `Valore di prova per ${name}`);
          answers.fields[name] = value;
        }
      });
    }
  }

  const generate = (s: Setup) => call("POST", `/deals/${s.dealId}/offer-draft/generate`, { ifMatch: s.draft.version });
  const offersOf = (dealId: string) => db.dealOffer.findMany({ where: { dealId }, orderBy: { number: "asc" } });
  const storedPdf = (objectKey: string): Uint8Array => bucket.objects.get(objectKey)!.bytes!;

  // ─── The whole of one draft: preview, generate, and what must agree ────────────────────────────────────────────────

  interface Proven {
    label: string;
    previewPages: number;
    renderedPages: number;
    appendedPages: number;
    totalPages: number;
    version: number;
    textsCompared: number;
    row: Awaited<ReturnType<typeof offersOf>>[number];
    pdf: Uint8Array;
    reference: string;
  }

  /**
   * Draft -> preview, then draft -> generate, and everything the two must agree on. `pendingReference`: the draft is a new offer
   * (or a revision), whose preview prints the pending label where the PDF prints the reference it took.
   */
  async function prove(label: string, s: Setup, options: { appended?: { name: string; sizes: [number, number][] }[]; pendingReference: boolean; expectStatus?: 200 | 201 }): Promise<Proven> {
    const appended = options.appended ?? [];
    const attachmentPdfs: { name: string; bytes: Uint8Array }[] = [];
    for (const { name, sizes } of appended) attachmentPdfs.push({ name, bytes: await dealPdf(name, sizes) });
    if (attachmentPdfs.length > 0) {
      const rows: { id: string }[] = [];
      for (const { name, bytes } of attachmentPdfs) rows.push(await storedPdfAttachment(s.dealId, `${name}.pdf`, bytes));
      // the order chosen is the reverse of the order they were stored in
      await save(s, (answers) => (answers.attachmentIds = rows.map((row) => row.id).reverse()));
    }
    const chosen = [...attachmentPdfs].reverse();

    // 1. draft -> preview
    const started = performance.now();
    const preview = await previewRoute(s);
    const previewMs = Math.round(performance.now() - started);
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    const pv = preview.json as { letterheadVersion: number; pageCount: number; missingPlaceholders: string[]; unprintableCharacters: number; pages: { n: number; image: string; text: string }[]; missingFields: unknown[] };
    expect(pv.missingFields).toEqual([]);
    expect(pv.pageCount).toBeGreaterThanOrEqual(1);
    expect(pv.pages.map((page) => page.n)).toEqual(Array.from({ length: pv.pageCount }, (_, index) => index + 1));
    for (const page of pv.pages) {
      expect(page.text.length).toBeGreaterThan(0);
      expect(Buffer.from(page.image, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // a PNG
    }
    const previewed = seen.previews.at(-1)!;
    expect(previewed.answer.pageCount).toBe(pv.pageCount);

    // 2. draft -> generate
    const generating = performance.now();
    const res = await generate(s);
    const generateMs = Math.round(performance.now() - generating);
    expect(res.status, JSON.stringify(res.json)).toBe(options.expectStatus ?? 201);
    expect(await db.offerDraft.count()).toBe(0);
    const rows = await offersOf(s.dealId);
    const row = rows.find((candidate) => candidate.id === res.json.id)!;
    const reference = res.json.reference as string;
    const pdf = storedPdf(row.objectKey);
    expect(row.sizeBytes).toBe(pdf.byteLength);

    expect(seen.pdfs).toHaveLength(1);
    const sent = seen.pdfs[0]!;
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const service = await PDFDocument.load(sent.answer.bytes, { updateMetadata: false });

    // the version the service answered is the one the offer records (AC-10.2), the preview's, and the entity's active one
    const activeVersion = active[s.entity]!.activeVersion;
    expect(sent.answer.letterheadVersion).toBe(activeVersion);
    expect(pv.letterheadVersion).toBe(activeVersion);
    expect(row.letterheadVersion).toBe(activeVersion);

    // 3. the page count: the preview's M, the service's header, pdf-lib on its bytes, and the stored PDF less the deal PDFs (AC-1.3, AC-10.3)
    const appendedPages = appended.reduce((sum, file) => sum + file.sizes.length, 0);
    expect(sent.answer.pageCount).toBe(service.getPageCount());
    expect(service.getPageCount()).toBe(pv.pageCount);
    expect(doc.getPageCount() - appendedPages).toBe(pv.pageCount);

    // 4. the text of every rendered page: the preview's, the service's preview of the exact blocks of the PDF, and the PDF's own (AC-1.3, A5)
    expect(sent.answer.unprintableCharacters).toBe(0);
    expect(pv.unprintableCharacters).toBe(0);
    const again = await real.preview(sent.content);
    expect(again.pageCount).toBe(pv.pageCount);
    expect(again.letterheadVersion).toBe(activeVersion);
    const fromPdf = await pdfPageTexts(sent.answer.bytes, service.getPageCount());
    // A new offer's preview has no reference yet and shows a pending marker where the PDF prints the reference it took: "NNNN/AAAA"
    // in the title, the field's own name ("RIF") inside a text. Both sides are read with the reference as one token.
    const REF = "\u27e6ref\u27e7";
    const previewSide = (text: string) => (options.pendingReference ? text.replace(PENDING_MARKERS, REF) : text);
    const pdfSide = (text: string) => (options.pendingReference ? text.replaceAll(reference, REF) : text);
    let references = 0;
    for (let index = 0; index < pv.pageCount; index += 1) {
      const previewText = squeeze(previewSide(pv.pages[index]!.text));
      references += previewText.split(REF).length - 1;
      // the service's preview of the PDF's own blocks: the page text of the PDF in the service's own words
      expect(squeeze(pdfSide(again.pages[index]!.text)), `page ${index + 1}: the service's preview of the generated blocks`).toBe(previewText);
      // the text the PDF itself draws
      expect(squeeze(pdfSide(fromPdf[index]!)), `page ${index + 1}: the text read from the PDF`).toBe(previewText);
    }
    // a new offer prints its reference at least in the title; an edit prints it as its own and needs no token
    if (options.pendingReference) expect(references).toBeGreaterThanOrEqual(1);
    else expect(fromPdf.join("\n")).toContain(reference);

    // the missing placeholders: the service prints the issuer from its own registry (AC-5.1), so what it consumes is the registry's, not the request's
    expect(sent.answer.missingPlaceholders).toEqual(pv.missingPlaceholders);
    for (const name of ["legal_name", "address", "vat", "iban"]) expect(pv.missingPlaceholders).not.toContain(name);

    // 5. the blocks: an edit's preview and its PDF are the very same blocks; a new offer's are the same blocks, block for block, where only the reference differs
    if (options.pendingReference) {
      const shape = (content: LetterheadContent, side: (text: string) => string) => content.blocks.map((block) => `${block.type}:${side(textOfBlock(block))}`);
      expect(shape(sent.content, pdfSide)).toEqual(shape(previewed.content, previewSide));
    } else {
      expect(JSON.stringify(sent.content)).toBe(JSON.stringify(previewed.content));
    }
    // content version 2: no `entityData`, and the pin is the version of the details the service printed, in the preview and in the PDF
    for (const content of [sent.content, previewed.content]) {
      expect(content.contentVersion).toBe(2);
      expect(content).not.toHaveProperty("entityData");
      expect(content.legalEntityVersion).toBe(held![s.entity]);
    }
    expect(sent.answer.legalEntityVersion).toBe(held![s.entity]);
    expect(previewed.answer.legalEntityVersion).toBe(held![s.entity]);
    expect(again.legalEntityVersion).toBe(held![s.entity]);
    expect((row.snapshot as any).legalEntityVersion).toBe(held![s.entity]);
    expect(sent.content.language).toBe(s.language);
    expect(sent.content.entity).toBe(s.entity);

    // 6. "N / M" on each page is the PDF's own, and counts the rendered pages only (AC-10.3)
    const numbered = pv.pages.map((page, index) => ({ at: index + 1, found: /(\d+) \/ (\d+)\s*$/.exec(page.text) }));
    for (const { at, found } of numbered) {
      expect(found, `page ${at} ends with "N / M"`).not.toBeNull();
      expect([Number(found![1]), Number(found![2])]).toEqual([at, pv.pageCount]);
    }

    // 7. the rendered pages are the service's, instruction for instruction; the deal PDFs follow them, in the order chosen, untouched and unnumbered
    if (appended.length === 0) {
      expect(sha256(pdf)).toBe(sha256(sent.answer.bytes));
      expect(doc.getPageCount()).toBe(pv.pageCount);
    } else {
      expect(doc.getPageCount()).toBe(pv.pageCount + appendedPages);
      for (let index = 0; index < pv.pageCount; index += 1) expect(contentOf(doc, index)).toBe(contentOf(service, index));
      const sources = await Promise.all(chosen.map((file) => PDFDocument.load(file.bytes)));
      let at = pv.pageCount;
      for (const source of sources) {
        for (let page = 0; page < source.getPageCount(); page += 1, at += 1) {
          expect(sizeOf(doc, at), `appended page ${at + 1}`).toBe(sizeOf(source, page));
          expect(contentOf(doc, at), `appended page ${at + 1} carries only its own drawing: no number was put on it`).toBe(contentOf(source, page));
        }
      }
      expect(at).toBe(doc.getPageCount());
      // the service's own title and producer survive the append
      expect(doc.getProducer()).toBe(service.getProducer());
      expect(doc.getTitle()).toBe(service.getTitle());
      expect((row.snapshot as any).attachments.map((attachment: { fileName: string }) => attachment.fileName)).toEqual(chosen.map((file) => `${file.name}.pdf`));
    }

    report.push(
      `  ${label.padEnd(58)} preview ${String(pv.pageCount).padStart(2)}p ${String(previewMs).padStart(4)} ms | generate ${String(generateMs).padStart(4)} ms | stored ${doc.getPageCount()}p = ${pv.pageCount} rendered + ${appendedPages} appended | ${pv.pageCount} page texts equal x3 | letterhead v${activeVersion} | ${row.sizeBytes} bytes`,
    );
    return { label, previewPages: pv.pageCount, renderedPages: pv.pageCount, appendedPages, totalPages: doc.getPageCount(), version: activeVersion, textsCompared: pv.pageCount * 3, row, pdf, reference };
  }

  // ─── The tests ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe(`against the real service at ${url}`, () => {
    it("is reachable with the credential, and holds an active letterhead for both entities (what the other tests need)", async () => {
      const res = await fetch(`${url}/v1/letterheads/status`, { headers: { Authorization: `Bearer ${await who.getToken()}` }, signal: AbortSignal.timeout(10_000) }).catch((error: unknown) => {
        throw new Error(`${URL_VARIABLE}=${url} is not reachable: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (res.status === 401) {
        throw new Error(
          "the service answered 401 to the test's service token: its AUTH_ISSUER, SERVICE_AUDIENCE and AUTH_JWKS_URL must match LETTERHEAD_CONTRACT_ISSUER, LETTERHEAD_CONTRACT_AUDIENCE and the JWKS this test serves on " +
            `:${JWKS_PORT} (or LETTERHEAD_CONTRACT_TOKEN must be a valid service token); a key the service has not seen is fetched at most once every 30 s`,
        );
      }
      expect(res.status).toBe(200);
      active = (await res.json()) as typeof active;
      for (const entity of ["welld_ch", "welld_it"]) {
        expect(active[entity], `the service has no active letterhead for ${entity}: seed one (letterhead-api/perf/seed-local.ts) before running this test`).not.toBeNull();
      }
    });

    it("renders content version 2 pinned to the issuer's details: both entities answer the version they hold, in the preview and in the PDF, and another pin is the 409 with the version in use (AC-5.2, AC-6.2)", async () => {
      for (const entity of ["welld_ch", "welld_it"] as const) {
        const version = held![entity];
        const content: LetterheadContent = { contentVersion: 2, entity, language: "it", legalEntityVersion: version, blocks: [{ type: "paragraph", runs: [{ text: "Pin check" }] }] };
        const previewed = await real.preview(content, { pages: [1] });
        expect(previewed.legalEntityVersion).toBe(version);
        expect(previewed.letterheadVersion).toBe(active[entity]!.activeVersion);
        const pdf = await real.pdf(content);
        expect(pdf.legalEntityVersion).toBe(version);
        expect(pdf.letterheadVersion).toBe(active[entity]!.activeVersion);
        // the service reads the issuer itself: with no `entityData` the four values of the frame are not missing
        expect(previewed.missingPlaceholders).not.toContain("legal_name");
        expect(previewed.missingPlaceholders).not.toContain("iban");

        for (const wrong of [version + 1, version + 2]) {
          const refused = await real.pdf({ ...content, legalEntityVersion: wrong }).then(
            () => null,
            (error: unknown) => error,
          );
          expect(refused, `a pin of ${wrong} for ${entity}`).toBeInstanceOf(LegalEntityVersionMismatch);
          expect((refused as LegalEntityVersionMismatch).currentVersion).toBe(version);
        }
        // a request with no pin prints whatever the service holds (a sample that prints nothing of the issuer)
        const { legalEntityVersion: _unpinned, ...bare } = content;
        expect((await real.preview(bare, { pages: [1] })).legalEntityVersion).toBe(version);
      }
    });

    it("an Italian offer from a seeded template: preview equals generate, page count and the text of every page (AC-10.3, AC-1.3)", async () => {
      const s = await startDraft("welld_ch", () => seededTemplate("welld_ch", "Progetto a corpo"));
      expect(s.language).toBe("it");
      await complete(s);
      const proven = await prove("it  welld_ch  seeded \"Progetto a corpo\" (new offer)", s, { pendingReference: true });
      expect(proven.reference).toBe(`0001/${YEAR}`);
      expect(proven.previewPages).toBeGreaterThan(1);
      expect(traffic.every((request) => request.status === 200)).toBe(true);
      expect(traffic.length).toBeGreaterThanOrEqual(3);
    });

    it("an English offer: preview equals generate, page count and the text of every page (AC-10.3, AC-1.3)", async () => {
      const s = await startDraft("welld_it", () => makeDraftTemplate({ entity: "welld_it", language: "en" }) as Promise<Template>);
      expect(s.language).toBe("en");
      const proven = await prove("en  welld_it  English wizard template (new offer)", s, { pendingReference: true });
      expect(proven.reference).toBe(`0001/${YEAR}`);
    });

    it("an offer with appended deal PDFs: the pages are the service's, the deal PDFs follow unnumbered and unchanged, pdf-lib reads the Typst PDF (AC-10.3, T29)", async () => {
      const s = await startDraft("welld_ch", () => seededTemplate("welld_ch", "Manutenzione e SLA"));
      await complete(s);
      const proven = await prove("it  welld_ch  seeded \"Manutenzione e SLA\" + 2 deal PDFs (3 pages)", s, {
        pendingReference: true,
        appended: [
          { name: "first", sizes: [[200, 300], [210, 310]] },
          { name: "second", sizes: [[220, 320]] },
        ],
      });
      expect(proven.appendedPages).toBe(3);
      expect(proven.totalPages).toBe(proven.renderedPages + 3);
    });

    it("an edit of an unsent offer previews with its own reference: page count, text and blocks are equal with no exception (AC-10.3)", async () => {
      const s = await startDraft("welld_ch", () => seededTemplate("welld_ch", "Progetto a corpo"));
      await complete(s);
      const first = await prove("it  welld_ch  seeded \"Progetto a corpo\" (new offer, to be edited)", s, { pendingReference: true });

      seen.pdfs.length = 0;
      seen.previews.length = 0;
      const created = await call("POST", `/deals/${s.dealId}/offer-draft`, { body: { target: { kind: "edit", offerId: first.row.id } }, headers: noMatch });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      const edit: Setup = { ...s, draft: created.json };
      expect(edit.draft.target.kind).toBe("edit");
      await save(edit, (answers) => {
        for (const name of Object.keys(answers.fields)) if (name === "DURATA") answers.fields[name] = "9 mesi, dopo la modifica";
      });
      const proven = await prove("it  welld_ch  the same offer, EDITED (reference 0001)", edit, { pendingReference: false, expectStatus: 200 });
      // the same row, the same reference, a new PDF, drawn by the service again
      expect(proven.row.id).toBe(first.row.id);
      expect(proven.reference).toBe(first.reference);
      expect(sha256(proven.pdf)).not.toBe(sha256(first.pdf));
      expect(proven.row.letterheadVersion).toBe(first.version);
    });

    it("offers generated before the switch keep their row, snapshot, stored PDF and download, byte for byte, beside offers made through the service (AC-10.9)", async () => {
      // before the switch: crm-api's own renderer makes the offer, and it is sent
      env.LETTERHEAD_SERVICE_ENABLED = false;
      const s = await startDraft("welld_ch", () => makeDraftTemplate({ entity: "welld_ch", language: "it" }) as Promise<Template>);
      const issued = await generate(s);
      expect(issued.status, JSON.stringify(issued.json)).toBe(201);
      const [before] = await offersOf(s.dealId);
      expect(before!.letterheadVersion).toBeNull();
      expect((await call("POST", `/deals/${s.dealId}/offers/${before!.id}/sent`)).status).toBe(200);
      // a second deal holds an UNSENT pre-switch offer that will be edited after the switch (AC-10.9, second sentence)
      const other = await startDraft("welld_ch", () => makeDraftTemplate({ entity: "welld_ch", language: "it" }) as Promise<Template>);
      const unsent = await generate(other);
      expect(unsent.status).toBe(201);
      const [unsentBefore] = await offersOf(other.dealId);
      const sentRow = await db.dealOffer.findUniqueOrThrow({ where: { id: before!.id } });
      // and a 018 summary offer ("OF-…", no `kind`), whose PDF was made by a renderer that no longer exists
      const { deal: legacyDeal } = await makeReadyDeal({ entity: "welld_ch" });
      const legacyBytes = await dealPdf("legacy", [[595, 842]]);
      const legacy = await insertOfferRow(legacyDeal.id, { reference: "OF-2026-LEGACY-1", issuedOn: "2026-01-05" });
      bucket.objects.set(legacy.objectKey, { bytes: legacyBytes, contentType: "application/pdf", sizeBytes: legacyBytes.byteLength });

      const photograph = async (offerId: string) => {
        const row = await db.dealOffer.findUniqueOrThrow({ where: { id: offerId } });
        return { row: JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value)), bytes: sha256(storedPdf(row.objectKey)), size: row.sizeBytes };
      };
      const pre = await photograph(sentRow.id);
      const preLegacy = await photograph(legacy.id);
      expect(pre.bytes).toBe(sha256(storedPdf(before!.objectKey)));
      expect(preLegacy.bytes).toBe(sha256(legacyBytes));
      traffic.length = 0;

      // after the switch
      env.LETTERHEAD_SERVICE_ENABLED = true;
      // a new revision of the SENT offer is drawn by the service, with the active letterhead; the sent offer is not touched
      const revisionDraft = await call("POST", `/deals/${s.dealId}/offer-draft`, { body: { target: { kind: "revision", offerId: before!.id } }, headers: noMatch });
      expect(revisionDraft.status, JSON.stringify(revisionDraft.json)).toBe(201);
      const revision: Setup = { ...s, draft: revisionDraft.json };
      const revised = await prove("it  welld_ch  REVISION of a pre-switch sent offer", revision, { pendingReference: true });
      expect(revised.reference).toBe(`0001/${YEAR}r1`);
      expect(revised.row.letterheadVersion).toBe(revised.version);

      // an unsent pre-switch offer, edited after the switch, takes the entity's active letterhead (the service draws it)
      const editDraft = await call("POST", `/deals/${other.dealId}/offer-draft`, { body: { target: { kind: "edit", offerId: unsentBefore!.id } }, headers: noMatch });
      expect(editDraft.status, JSON.stringify(editDraft.json)).toBe(201);
      seen.pdfs.length = 0;
      const edited = await prove("it  welld_ch  EDIT of a pre-switch unsent offer", { ...other, draft: editDraft.json }, { pendingReference: false, expectStatus: 200 });
      expect(edited.row.id).toBe(unsentBefore!.id);
      expect(edited.row.letterheadVersion).toBe(edited.version);
      expect(unsentBefore!.letterheadVersion).toBeNull();

      // the sent pre-switch offer: unchanged in every column, its bytes the same, nothing re-rendered, still downloadable
      const post = await photograph(sentRow.id);
      expect(post).toEqual(pre);
      expect(await photograph(legacy.id)).toEqual(preLegacy);
      const legacyDownload = await call("GET", `/deals/${legacyDeal.id}/offers/${legacy.id}/download`);
      expect(legacyDownload.status).toBe(200);
      expect(legacyDownload.json.url).toContain(legacy.objectKey);
      expect(post.row).toContain('"letterheadVersion":null');
      const download = await call("GET", `/deals/${s.dealId}/offers/${sentRow.id}/download`);
      expect(download.status).toBe(200);
      expect(download.json.url).toContain(sentRow.objectKey);
      expect(sha256(storedPdf(sentRow.objectKey))).toBe(pre.bytes);
      // the service was asked for exactly the two post-switch renders (the revision, the edit), each preview and each PDF: never for the pre-switch offer
      const pdfCalls = traffic.filter((request) => request.path === "/v1/render/pdf");
      expect(pdfCalls).toHaveLength(2);
      expect(pdfCalls.every((request) => request.status === 200)).toBe(true);
      const list = await call("GET", `/deals/${s.dealId}/offers`);
      expect(list.status).toBe(200);
      const offers = list.json.items ?? list.json;
      const preSwitch = (offers as { id: string; reference: string }[]).find((offer) => offer.id === sentRow.id);
      expect(preSwitch?.reference).toBe(`0001/${YEAR}`);
      report.push(`  pre-switch offer ${preSwitch?.reference}: ${pre.size} bytes, sha256 ${pre.bytes.slice(0, 16)}… identical before and after a revision and an edit were made through the service; PDF renders the service was asked for: ${pdfCalls.length}`);
    });
  });
}

// ─── Run, skip, or fail ──────────────────────────────────────────────────────────────────────────────────────────────

if (baseUrl === undefined) {
  if (required) {
    describe("letterhead contract (LETTERHEAD_REQUIRE_CONTRACT=1)", () => {
      it(`has ${URL_VARIABLE} set`, () => {
        throw new Error(
          `${URL_VARIABLE} is not set, and LETTERHEAD_REQUIRE_CONTRACT=1 says this contract test must run: ` +
            `start letterhead-api and set ${URL_VARIABLE} to its base URL (see the top of this file)`,
        );
      });
    });
  } else {
    console.warn(`[letterhead contract] SKIPPED: ${URL_VARIABLE} is not set. Set it to a running letterhead-api's base URL to run this test (LETTERHEAD_REQUIRE_CONTRACT=1 makes the skip a failure).`);
    describe.skip(`letterhead contract against the real service (skipped: ${URL_VARIABLE} is not set)`, () => {
      it(`needs ${URL_VARIABLE}`, () => {});
    });
  }
} else {
  defineContract(baseUrl);
}
