/**
 * The accounting export routes (T18, specs/20261118-refund-accounting-export,
 * plan § Test strategy rows AC-6.1 to AC-6.12, AC-7.2, AC-4.6; G9 to G11).
 *
 * Real Postgres, jwt/authz mocked (`test-support/testAuth.ts`), the exchange-rate
 * source FAKE (`createFxService` with an injected fetcher): no test touches the
 * network. `export.routes` and the batch routers are imported with a query suffix
 * (a module instance of their own): the same files are imported by other test
 * files bound to THEIR mocked jwt/authz (testAuth.ts, "no shared router specifier").
 *
 *   AC-6.1   compiled and paid batches: a header and one row per approved, not rejected WellD CH line
 *   AC-6.2   the 16 columns (the golden file is `export.test.ts`; here, through the route)
 *   AC-6.3   10.40 EUR dated 2026-03-02 at 0.9246 is 9.62, in the file
 *   AC-6.4   20.80 CHF at 8.1 % carries a VAT of 1.56, in the file
 *   AC-6.5   a missing rate: summary and CSV 409 list {currency, month}; compile, mark-paid and discard still 2xx
 *   AC-6.6   WellD Italia lines are left out and counted
 *   AC-6.7   no WellD CH line: a file with the header row only
 *   AC-6.8   exported twice, identical bytes and hashes; a rate correction changes the hash
 *   AC-6.9   a discarded batch has no export (409 `batch_discarded`, both routes)
 *   AC-6.10  a download writes one log row, a summary writes none
 *   AC-6.11  no `request:review`: 403; a review scope without welld_ch: 403 `accounting_export_out_of_scope`
 *   AC-6.12  a line approved at 0 is a row with 0.00 and 0.00
 *   AC-7.2   unclassified lines block, with date and type, until accounting classifies them
 *   AC-4.6   two employees with the same initials: the name goes with the number
 *   G10      the 409 `accounting_export_blocked` body IS the summary
 *   BINDING  an approved or paid line is read STORED-ONLY (no live defaults), as the review view reads it
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

// Object storage is mocked (the compile route renders and stores the batch PDF; no live bucket, no network). The real
// module is spread underneath: `mock.module` is process-wide (see batches/decide.routes.test.ts).
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const realStorage = (await import("../lib/storage?real")) as typeof import("../lib/storage");
const storedObjectKeys = new Set<string>();
mock.module("../lib/storage", () => ({
  ...realStorage,
  putObject: async (objectKey: string) => {
    storedObjectKeys.add(objectKey);
  },
  headObject: async (objectKey: string) =>
    storedObjectKeys.has(objectKey) ? { sizeBytes: 1, contentType: "application/pdf" } : null,
  mintPresignedGet: async (objectKey: string) => `https://mock.example.com/${objectKey}?signed`,
}));

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { createExportRouter } = (await import("./export.routes?t18")) as typeof import("./export.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { batchesRouter } = (await import("../batches/batches.routes?export-t18")) as typeof import("../batches/batches.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { batchDecideRouter } = (await import("../batches/decide.routes?export-t18")) as typeof import("../batches/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?export-t18")) as typeof import("./classification.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { createFxService } = await import("../fx/fx.service");
const { notifyTransport } = await import("../lib/notifyPost");
const { sha256Hex } = await import("./export.repo");
const { ExportBlockedSchema, ExportSummarySchema } = await import("./export.schemas");
const { COLUMNS, FORMAT_VERSION } = await import("./exportFormat");

// The compilation email and the paid push go to notify-api: answered here, never sent.
const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/emails")) return new Response(JSON.stringify({ deliveryId: "d1", status: "sent" }), { status: 200 });
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

// ─── Exchange-rate source: fake ──────────────────────────────────────────────

const NOW = new Date("2026-11-19T10:00:00.000Z"); // March 2026 is fetchable; November 2026 is not
const xmlFor = (month: string, eur = "0.9246", usd = "0.7808", gbp = "1.0635") =>
  `<?xml version="1.0"?><monatsmittelkurs><monat>${month}</monat>
    <devise code="eur"><waehrung>1 EUR</waehrung><kurs>${eur}</kurs></devise>
    <devise code="usd"><waehrung>1 USD</waehrung><kurs>${usd}</kurs></devise>
    <devise code="gbp"><waehrung>1 GBP</waehrung><kurs>${gbp}</kurs></devise></monatsmittelkurs>`;

type Fetcher = NonNullable<Parameters<typeof createFxService>[0]["fetcher"]>;
function fakeSource(answer: (month: string) => Response | Promise<Response> = (m) => new Response(xmlFor(m))) {
  const urls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    urls.push(url);
    return answer(`${/j=(\d{4})/.exec(url)![1]}-${/m=(\d{2})/.exec(url)![1]}`);
  };
  return { fetcher, urls };
}
const routerWith = (fetcher?: Fetcher) =>
  createExportRouter({ fx: createFxService({ mode: fetcher ? "bazg" : "off", ...(fetcher ? { fetcher } : {}), now: () => NOW }) });
/** No source at all (`REFUND_FX_SOURCE=off`): a missing rate stays missing. */
const exportRouter = routerWith();

// ─── Permissions ─────────────────────────────────────────────────────────────

const perms = (...grants: [string, string, boolean?][]): ResolveResponse => ({
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    ...grants.map(([resource, action, scoped]) => ({
      resource,
      action,
      conditions: scoped ? { attributes: [{ key: "entity", match: "user" as const }] } : null,
    })),
  ],
  entity: null,
  jobTitle: null,
});
const GLOBAL_REVIEWER = perms(["request", "review"], ["request", "approve"]);
const CH_REVIEWER: ResolveResponse = { ...perms(["request", "review", true]), entity: "welld_ch" };
const IT_REVIEWER: ResolveResponse = { ...perms(["request", "review", true]), entity: "welld_it" };
const SCOPED_NO_ENTITY: ResolveResponse = { ...perms(["request", "review", true]), entity: null };
const NO_REVIEW = perms(["request", "create"]);
const RECLASSIFIER = perms(["request", "review"], ["request", "reclassify"]);

function as(resolve: ResolveResponse): void {
  __resetAuthzCacheForTests();
  harness.setResolve(async () => resolve);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
type Owner = { id: string; name: string | null; email: string; initials: string };
const MATTEO: Owner = { id: "u-matteo", name: "Matteo Codogno", email: "matteo.codogno@welld.ch", initials: "MC" };
const MARCO: Owner = { id: "u-marco", name: "Marco Cattaneo", email: "marco.cattaneo@welld.ch", initials: "MC" };
const ANNA: Owner = { id: "u-anna", name: "Anna Rossi", email: "anna.rossi@welld.ch", initials: "AR" };

let office: { id: string };
let km: { id: string };
let imp81: { id: string };
let novat: { id: string };

beforeEach(async () => {
  await truncateRefundTables();
  as(GLOBAL_REVIEWER);
  office = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Spese materiale ufficio", ...by } });
  km = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "5905", name: "Spese rimborsi chilometrici (viaggi)", ...by } });
  imp81 = await db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by } });
  novat = await db.vatCode.create({ data: { entity: "welld_ch", code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, ...by } });
});
afterAll(async () => {
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

interface LineSpec {
  owner?: Owner;
  date?: string;
  type?: "office_material" | "travel_train" | "travel_km" | "postal";
  entity?: "welld_ch" | "welld_it";
  currency?: "CHF" | "EUR" | "USD" | "GBP";
  /** `approvedTotalCents`; `null` leaves it unset (the requested amount is then the line's amount). */
  approved?: number | null;
  requested?: number;
  motivo?: string;
  km?: number;
  rejected?: boolean;
  /** `false`: the line has no receipt number. Default: numbered with the next sequence of its owner and year. */
  numbered?: boolean;
  /** What is stored on the line; default the office account and IMP81. `null` = nothing stored for that half. */
  account?: { id: string } | null;
  vat?: { id: string } | null;
}

let seqs = new Map<string, number>();
beforeEach(() => {
  seqs = new Map();
});
const nextSeq = (ownerId: string, year: number): number => {
  const key = `${ownerId}:${year}`;
  const n = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, n);
  return n;
};

let lineCreatedAt = 0;
async function addLine(requestId: string, owner: Owner, spec: LineSpec) {
  const date = spec.date ?? "2026-03-02";
  const year = Number(date.slice(0, 4));
  const numbered = spec.numbered !== false && !spec.rejected;
  const seq = numbered ? nextSeq(owner.id, year) : null;
  const classified = (spec.entity ?? "welld_ch") === "welld_ch" && !spec.rejected;
  const account = spec.account === undefined ? office : spec.account;
  const vat = spec.vat === undefined ? imp81 : spec.vat;
  const line = await db.refundLine.create({
    data: {
      requestId,
      date: new Date(date),
      type: spec.type ?? "office_material",
      motivo: spec.motivo ?? "Cancelleria",
      entity: spec.entity ?? "welld_ch",
      currency: spec.currency ?? "CHF",
      requestedAmountCents: spec.requested ?? spec.approved ?? 2080,
      approvedTotalCents: spec.rejected ? 0 : spec.approved === undefined ? 2080 : spec.approved,
      ...(spec.km !== undefined ? { km: spec.km } : {}),
      createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, ++lineCreatedAt % 60, Math.floor(lineCreatedAt / 60))),
      ...(spec.rejected ? { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x" } : {}),
      ...(classified && account ? { ledgerAccountId: account.id, ledgerAccountIsDefault: true } : {}),
      ...(classified && vat ? { vatCodeId: vat.id, vatCodeIsDefault: true } : {}),
      ...(numbered && seq !== null
        ? {
            receiptNumber: `${owner.initials}${String(year).slice(2)}/${String(seq).padStart(3, "0")}`,
            receiptOwnerUserId: owner.id,
            receiptYear: year,
            receiptSeq: seq,
            numberedAt: new Date(),
          }
        : {}),
    },
  });
  return line.id;
}

interface RequestSpec {
  owner?: Owner;
  lines: LineSpec[];
}

/** An approved (or paid) request per spec, in one batch. Returns the batch id, the request ids and the line ids. */
async function createBatch(requests: RequestSpec[], status: "compiled" | "paid" = "compiled") {
  const batch = await db.refundBatch.create({
    data: {
      cutoff: new Date("2026-03-31T21:59:59.000Z"),
      status,
      createdByUserId: "acct-1",
      createdByEmail: "acct-1@welld.ch",
      pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
      ...(status === "paid" ? { paidAt: new Date(), paidByEmail: "acct-1@welld.ch" } : {}),
    },
  });
  const requestIds: string[] = [];
  const lineIds: string[] = [];
  for (const spec of requests) {
    const owner = spec.owner ?? MATTEO;
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: owner.id,
        ownerEmail: owner.email,
        ownerName: owner.name,
        status: status === "paid" ? "paid" : "approved",
        decidedAt: new Date("2026-03-20T10:00:00.000Z"),
        decidedByUserId: "acct-1",
        decidedByEmail: "acct-1@welld.ch",
        batchId: batch.id,
      },
    });
    requestIds.push(request.id);
    for (const line of spec.lines) lineIds.push(await addLine(request.id, owner, { owner, ...line }));
    await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
  }
  return { batchId: batch.id, requestIds, lineIds };
}

/** An approved request not in any batch, for the compile route. */
async function createUnbatchedRequest(lines: LineSpec[], owner: Owner = MATTEO) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      ownerName: owner.name,
      status: "approved",
      decidedAt: new Date("2026-03-20T10:00:00.000Z"),
      decidedByUserId: "acct-1",
      decidedByEmail: "acct-1@welld.ch",
    },
  });
  const lineIds: string[] = [];
  for (const line of lines) lineIds.push(await addLine(request.id, owner, { owner, ...line }));
  return { requestId: request.id, lineIds };
}

const addRate = (currency: "EUR" | "USD" | "GBP", month: string, rateMicros: number, origin: "fetched" | "corrected" = "fetched", at?: string) =>
  db.exchangeRateEntry.create({
    data: {
      currency,
      month: new Date(`${month}-01T00:00:00.000Z`),
      rateMicros,
      origin,
      createdByUserId: origin === "fetched" ? "system:fx-fetch" : "admin",
      createdByEmail: "x@welld.ch",
      ...(origin === "fetched" ? { sourceUrl: "https://example.test", sourceMonth: month, fetchedAt: new Date() } : {}),
      ...(at ? { createdAt: new Date(at) } : {}),
    },
  });

// ─── Calls ───────────────────────────────────────────────────────────────────

async function token(sub = "acct-1") {
  return harness.signToken({ sub, email: `${sub}@welld.ch` });
}
async function call(router: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, path: string, init: RequestInit = {}, sub = "acct-1") {
  return router.request(path, { ...init, headers: { Authorization: `Bearer ${await token(sub)}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}
const summaryOf = async (batchId: string, router = exportRouter) => {
  const res = await call(router, `/batches/${batchId}/accounting-export`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const csvOf = async (batchId: string, router = exportRouter, sub?: string) => {
  const res = await call(router, `/batches/${batchId}/accounting-export/csv`, {}, sub);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, status: res.status, bytes, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
};
const json = (text: string) => JSON.parse(text) as Record<string, any>;

/** Rows of a CSV with no quoted newlines, as arrays of cells (the files of these tests have no `;`, `"` or CR/LF in their text). */
const rowsOf = (text: string): string[][] =>
  text
    .replace(/^﻿/, "")
    .split("\r\n")
    .filter((r) => r !== "")
    .map((r) => r.split(";"));
const col = (key: (typeof COLUMNS)[number]["key"]): number => COLUMNS.findIndex((c) => c.key === key);
const dataRows = (text: string) => rowsOf(text).slice(1);
const exportLog = () => db.refundBatchExport.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

// ═════════════════════════════════════════════════════════════════════════════

describe("who may export (AC-6.11, D8)", () => {
  it("answers 401 without a token, on both routes", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    expect((await exportRouter.request(`/batches/${batchId}/accounting-export`)).status).toBe(401);
    expect((await exportRouter.request(`/batches/${batchId}/accounting-export/csv`)).status).toBe(401);
  });

  it("without request:review it is 403, on both routes, and nothing is logged", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    as(NO_REVIEW);
    for (const path of [`/batches/${batchId}/accounting-export`, `/batches/${batchId}/accounting-export/csv`]) {
      const res = await call(exportRouter, path);
      expect(res.status).toBe(403);
      expect(json(await res.text())["code"]).toBeUndefined();
    }
    expect(await exportLog()).toHaveLength(0);
  });

  it("a review scope that covers only WellD Italia is 403 accounting_export_out_of_scope, on both routes, with no file and no log row", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    as(IT_REVIEWER);
    for (const path of [`/batches/${batchId}/accounting-export`, `/batches/${batchId}/accounting-export/csv`]) {
      const res = await call(exportRouter, path);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(json(await res.text())).toMatchObject({ status: 403, code: "accounting_export_out_of_scope" });
    }
    expect(await exportLog()).toHaveLength(0);
  });

  it("a conditioned grant whose holder has no entity covers nothing: 403 accounting_export_out_of_scope", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    as(SCOPED_NO_ENTITY);
    const res = await call(exportRouter, `/batches/${batchId}/accounting-export`);
    expect(res.status).toBe(403);
    expect(json(await res.text())["code"]).toBe("accounting_export_out_of_scope");
  });

  it("the scope is checked before the batch is looked up: a WellD Italia reviewer learns nothing about which batches exist", async () => {
    as(IT_REVIEWER);
    const res = await call(exportRouter, "/batches/does-not-exist/accounting-export");
    expect(res.status).toBe(403);
  });

  it("a reviewer scoped to WellD CH, and a global one, may export", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    for (const who of [CH_REVIEWER, GLOBAL_REVIEWER]) {
      as(who);
      expect((await summaryOf(batchId)).status).toBe(200);
      expect((await csvOf(batchId)).status).toBe(200);
    }
  });

  it("an unknown batch is 404 for an allowed reviewer", async () => {
    expect((await summaryOf("nope")).status).toBe(404);
    expect((await csvOf("nope")).status).toBe(404);
  });
});

describe("the file (AC-6.1, AC-6.2, AC-6.3, AC-6.4, AC-6.12, AC-4.6)", () => {
  it("(AC-6.1, AC-6.2) a compiled batch gives a CSV with the header and one row per approved, not rejected WellD CH line", async () => {
    const { batchId, lineIds } = await createBatch([
      {
        lines: [
          { type: "office_material", approved: 2080, motivo: "Cancelleria" },
          { type: "travel_km", approved: 8400, km: 120, motivo: "Visita cliente", account: km, vat: novat },
          { entity: "welld_it", currency: "EUR", approved: 5000 }, // left out
          { rejected: true, requested: 999 }, // never a row
        ],
      },
    ]);
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect([...out.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = rowsOf(out.text);
    expect(rows[0]).toEqual(COLUMNS.map((c) => c.header));
    expect(rows).toHaveLength(1 + 2);

    const office1 = rows.find((r) => r[col("receiptNumber")] === "MC26/001")!;
    expect(office1).toEqual([
      "Matteo Codogno", "MC26/001", "2026-03-02", "Office material", "Cancelleria", "", "CHF", "20.80", "", "20.80",
      "6101", "Spese materiale ufficio", "IMP81", "8.10", "1.56", batchId,
    ]);
    const km1 = rows.find((r) => r[col("receiptNumber")] === "MC26/002")!;
    expect(km1).toEqual([
      "Matteo Codogno", "MC26/002", "2026-03-02", "Travel — mileage (km)", "Visita cliente", "120", "CHF", "84.00", "", "84.00",
      "5905", "Spese rimborsi chilometrici (viaggi)", "NOVAT", "0.00", "0.00", batchId,
    ]);
    expect(lineIds).toHaveLength(4);
  });

  it("(AC-6.1) a paid batch exports too", async () => {
    const { batchId } = await createBatch([{ lines: [{}, {}] }], "paid");
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(dataRows(out.text)).toHaveLength(2);
    expect((await summaryOf(batchId)).body).toMatchObject({ batchStatus: "paid", exportable: true, rowCount: 2 });
  });

  it("(AC-6.3) 10.40 EUR dated 2026-03-02 at the March rate 0.9246 is 9.62 CHF", async () => {
    await addRate("EUR", "2026-03", 924_600);
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", approved: 1040, date: "2026-03-02", vat: novat }] }]);
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(out.text).toContain(";EUR;10.40;0.9246;9.62;");
    const row = dataRows(out.text)[0]!;
    expect([row[col("approvedTotal")], row[col("exchangeRate")], row[col("chfAmount")]]).toEqual(["10.40", "0.9246", "9.62"]);
  });

  it("(AC-6.3) the rate is the one of the month of the EXPENSE date, per currency", async () => {
    await addRate("EUR", "2026-02", 900_000);
    await addRate("EUR", "2026-03", 924_600);
    await addRate("USD", "2026-03", 780_800);
    const { batchId } = await createBatch([
      {
        lines: [
          { currency: "EUR", approved: 1000, date: "2026-02-28", vat: novat },
          { currency: "EUR", approved: 1000, date: "2026-03-01", vat: novat },
          { currency: "USD", approved: 1000, date: "2026-03-31", vat: novat },
        ],
      },
    ]);
    const rows = dataRows((await csvOf(batchId)).text);
    expect(rows.map((r) => [r[col("expenseDate")], r[col("exchangeRate")], r[col("chfAmount")]])).toEqual([
      ["2026-02-28", "0.9000", "9.00"],
      ["2026-03-01", "0.9246", "9.25"],
      ["2026-03-31", "0.7808", "7.81"],
    ]);
  });

  it("(AC-6.3) a corrected rate is the one in effect", async () => {
    await addRate("EUR", "2026-03", 924_600, "fetched", "2026-04-01T08:00:00.000Z");
    await addRate("EUR", "2026-03", 950_000, "corrected", "2026-04-02T08:00:00.000Z");
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", approved: 1040, vat: novat }] }]);
    const row = dataRows((await csvOf(batchId)).text)[0]!;
    expect([row[col("exchangeRate")], row[col("chfAmount")]]).toEqual(["0.9500", "9.88"]);
  });

  it("(AC-6.4) a CHF line of 20.80 classified at 8.1 % carries a VAT of 1.56", async () => {
    const { batchId } = await createBatch([{ lines: [{ approved: 2080 }] }]);
    const out = await csvOf(batchId);
    expect(out.text).toContain(";CHF;20.80;;20.80;6101;Spese materiale ufficio;IMP81;8.10;1.56;");
  });

  it("(AC-6.12) a line approved at 0 and not rejected is a row with 0.00 CHF and 0.00 VAT", async () => {
    const { batchId } = await createBatch([{ lines: [{ approved: 0, requested: 500 }] }]);
    const rows = dataRows((await csvOf(batchId)).text);
    expect(rows).toHaveLength(1);
    expect([rows[0]![col("approvedTotal")], rows[0]![col("chfAmount")], rows[0]![col("vatAmount")]]).toEqual(["0.00", "0.00", "0.00"]);
  });

  it("the amount is the approved total, not the requested one", async () => {
    const { batchId } = await createBatch([{ lines: [{ requested: 5000, approved: 3000 }] }]);
    expect(dataRows((await csvOf(batchId)).text)[0]![col("approvedTotal")]).toBe("30.00");
  });

  it("(AC-4.6) two employees with the same initials each carry their own MC26/001, and the name goes with it", async () => {
    const { batchId } = await createBatch([
      { owner: MATTEO, lines: [{}] },
      { owner: MARCO, lines: [{}] },
      { owner: ANNA, lines: [{}] },
    ]);
    const rows = dataRows((await csvOf(batchId)).text);
    expect(rows.map((r) => [r[col("employee")], r[col("receiptNumber")]])).toEqual([
      ["Anna Rossi", "AR26/001"],
      ["Marco Cattaneo", "MC26/001"],
      ["Matteo Codogno", "MC26/001"],
    ]);
  });

  it("an account with no name falls back to its email in the Employee column", async () => {
    const { batchId } = await createBatch([{ owner: { ...MATTEO, name: null }, lines: [{}] }]);
    expect(dataRows((await csvOf(batchId)).text)[0]![col("employee")]).toBe("matteo.codogno@welld.ch");
  });

  it("answers with the download headers: type, attachment filename without personal data, row and left-out counts", async () => {
    const { batchId } = await createBatch([{ lines: [{}, {}, { entity: "welld_it", currency: "EUR" }] }]);
    const { res } = await csvOf(batchId);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="refund-accounting-2026-03-31-${batchId}.csv"`);
    expect(res.headers.get("x-export-row-count")).toBe("2");
    expect(res.headers.get("x-export-excluded-line-count")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).not.toMatch(/codogno|matteo/i);
  });
});

describe("what is left out (AC-6.6, AC-6.7)", () => {
  it("(AC-6.6) WellD Italia lines are not in the file, and the summary counts them", async () => {
    const { batchId } = await createBatch([
      { lines: [{}, { entity: "welld_it", currency: "EUR", approved: 700 }, { entity: "welld_it", approved: 800 }] },
      { owner: ANNA, lines: [{ entity: "welld_it", approved: 100 }] },
    ]);
    const summary = await summaryOf(batchId);
    expect(summary.body).toMatchObject({ rowCount: 1, excludedLineCount: 3, exportable: true });
    const out = await csvOf(batchId);
    expect(dataRows(out.text)).toHaveLength(1);
    expect(out.res.headers.get("x-export-excluded-line-count")).toBe("3");
  });

  it("a rejected WellD Italia line is not counted as left out: it was never going to be paid", async () => {
    const { batchId } = await createBatch([{ lines: [{}, { entity: "welld_it", approved: 800 }, { entity: "welld_it", rejected: true }] }]);
    expect((await summaryOf(batchId)).body["excludedLineCount"]).toBe(1);
  });

  it("(AC-6.7) a batch whose WellD CH lines are all rejected gives the header row only", async () => {
    const { batchId } = await createBatch([{ lines: [{ rejected: true }, { rejected: true }] }]);
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(rowsOf(out.text)).toEqual([COLUMNS.map((c) => c.header)]);
    expect(out.res.headers.get("x-export-row-count")).toBe("0");
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, rowCount: 0 });
  });

  it("(AC-6.7) a batch with only WellD Italia lines gives the header row only, and says how many were left out", async () => {
    const { batchId } = await createBatch([{ lines: [{ entity: "welld_it", currency: "EUR" }, { entity: "welld_it" }] }]);
    const out = await csvOf(batchId);
    expect(rowsOf(out.text)).toHaveLength(1);
    expect(out.res.headers.get("x-export-excluded-line-count")).toBe("2");
  });

  it("a rejected line never blocks, even though it has no classification and no number", async () => {
    const { batchId } = await createBatch([{ lines: [{}, { rejected: true, numbered: false, account: null, vat: null }] }]);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, rowCount: 1 });
  });

  it("a WellD Italia line never blocks either: it has no classification by design (AC-3.9, AC-7.3)", async () => {
    const { batchId } = await createBatch([{ lines: [{ entity: "welld_it", currency: "EUR", numbered: false, account: null, vat: null }] }]);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, rowCount: 0, excludedLineCount: 1 });
  });
});

describe("blockers (AC-6.5, AC-7.2, G10, G11)", () => {
  it("(AC-6.5) a foreign-currency line whose month has no rate blocks: the summary lists each missing currency and month", async () => {
    const { batchId } = await createBatch([
      {
        lines: [
          { currency: "EUR", date: "2026-03-02", vat: novat },
          { currency: "EUR", date: "2026-03-20", vat: novat }, // same pair: listed once
          { currency: "USD", date: "2026-03-05", vat: novat },
          { currency: "GBP", date: "2026-02-10", vat: novat },
          { currency: "EUR", date: "2026-02-10", vat: novat }, // February EUR has its rate
        ],
      },
    ]);
    await addRate("EUR", "2026-02", 900_000);
    const { status, body } = await summaryOf(batchId);
    expect(status).toBe(200);
    expect(body["exportable"]).toBe(false);
    expect(body["blockers"]["missingRates"]).toEqual([
      { currency: "GBP", month: "2026-02" },
      { currency: "EUR", month: "2026-03" },
      { currency: "USD", month: "2026-03" },
    ]);
    expect(body["blockers"]["unclassifiedLines"]).toEqual([]);
    expect(body["rowCount"]).toBe(5);
  });

  it("(AC-6.5, G10) the CSV is refused with 409 accounting_export_blocked, whose body IS the summary, and no file leaves", async () => {
    const { batchId } = await createBatch([{ lines: [{}, { currency: "EUR", date: "2026-03-02", vat: novat }] }]);
    const summary = await summaryOf(batchId);
    const csv = await csvOf(batchId);
    expect(csv.status).toBe(409);
    expect(csv.res.headers.get("content-type")).toContain("application/json");
    expect(csv.res.headers.get("content-disposition")).toBeNull();
    const body = json(csv.text);
    // The one shared shape: the refusal parses as the summary AND as the problem, and carries the summary's values.
    expect(ExportSummarySchema.safeParse(body).success).toBe(true);
    expect(ExportBlockedSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ status: 409, code: "accounting_export_blocked" });
    const { type, title, status, detail, instance, code, ...summaryPart } = body;
    expect([type, title, status, detail, instance, code].every((v) => v !== undefined)).toBe(true);
    expect(summaryPart).toEqual(summary.body);
    expect(summaryPart["blockers"]["missingRates"]).toEqual([{ currency: "EUR", month: "2026-03" }]);
    expect(await exportLog()).toHaveLength(0);
  });

  it("(AC-6.5) compile, mark-paid and discard of the blocked batch are not affected: all 2xx", async () => {
    // Two approved requests with a EUR line and no rate: the export of any batch holding them is blocked.
    await createUnbatchedRequest([{ currency: "EUR", date: "2026-03-02", vat: novat }]);
    as(GLOBAL_REVIEWER);

    const compiled = await call(batchesRouter, "/batches", { method: "POST", body: JSON.stringify({}) });
    expect(compiled.status).toBe(201);
    const batchId = ((await compiled.json()) as { id: string }).id;
    expect((await summaryOf(batchId)).body["blockers"]["missingRates"]).toEqual([{ currency: "EUR", month: "2026-03" }]);
    expect((await csvOf(batchId)).status).toBe(409);

    const paid = await call(batchDecideRouter, `/batches/${batchId}/mark-paid`, { method: "POST" });
    expect(paid.status).toBe(200);
    // Still blocked, still refused, and the batch is paid.
    expect((await csvOf(batchId)).status).toBe(409);
    expect(((await db.refundBatch.findUnique({ where: { id: batchId } }))!).status).toBe("paid");

    // A second blocked batch: discard it.
    await createUnbatchedRequest([{ currency: "GBP", date: "2026-03-09", vat: novat }]);
    const compiled2 = await call(batchesRouter, "/batches", { method: "POST", body: JSON.stringify({}) });
    expect(compiled2.status).toBe(201);
    const batch2 = ((await compiled2.json()) as { id: string }).id;
    expect((await csvOf(batch2)).status).toBe(409);
    const discarded = await call(batchDecideRouter, `/batches/${batch2}/discard`, { method: "POST" });
    expect(discarded.status).toBe(200);
  });

  it("(AC-7.2, G11) unclassified lines block, named by id, date, type, employee and number, until accounting classifies them", async () => {
    const { batchId, lineIds, requestIds } = await createBatch([
      {
        lines: [
          { type: "office_material", date: "2026-03-10", account: null, vat: imp81 },
          { type: "travel_train", date: "2026-03-03", account: office, vat: null },
          { type: "postal", date: "2026-03-04", account: null, vat: null },
          { type: "office_material", date: "2026-03-05" }, // fully classified: not listed
        ],
      },
    ]);
    const { body } = await summaryOf(batchId);
    expect(body["exportable"]).toBe(false);
    expect(body["blockers"]["unclassifiedLines"]).toEqual([
      { lineId: lineIds[1], requestId: requestIds[0], date: "2026-03-03", type: "travel_train", employee: "Matteo Codogno", receiptNumber: "MC26/002", missing: ["vatCode"] },
      { lineId: lineIds[2], requestId: requestIds[0], date: "2026-03-04", type: "postal", employee: "Matteo Codogno", receiptNumber: "MC26/003", missing: ["account", "vatCode"] },
      { lineId: lineIds[0], requestId: requestIds[0], date: "2026-03-10", type: "office_material", employee: "Matteo Codogno", receiptNumber: "MC26/001", missing: ["account"] },
    ]);
    const csv = await csvOf(batchId);
    expect(csv.status).toBe(409);
    expect(json(csv.text)["blockers"]["unclassifiedLines"]).toHaveLength(3);

    // Accounting classifies them (PUT classification with `request:reclassify`, AC-3.6): the export opens.
    as(RECLASSIFIER);
    const put = (lineId: string, requestId: string, body: object) =>
      call(classificationRouter, `/review/requests/${requestId}/lines/${lineId}/classification`, { method: "PUT", body: JSON.stringify(body) });
    expect((await put(lineIds[0]!, requestIds[0]!, { ledgerAccountId: office.id })).status).toBe(200);
    expect((await put(lineIds[1]!, requestIds[0]!, { vatCodeId: imp81.id })).status).toBe(200);
    expect((await put(lineIds[2]!, requestIds[0]!, { ledgerAccountId: office.id, vatCodeId: novat.id })).status).toBe(200);
    as(GLOBAL_REVIEWER);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, rowCount: 4 });
    expect((await csvOf(batchId)).status).toBe(200);
  });

  it("BINDING: an approved line is read STORED-ONLY, exactly as the review view reads it: a live default never fills a half left empty", async () => {
    // Defaults exist for the type and for foreign currencies, and the designation points at an active code...
    await db.expenseTypeDefault.create({ data: { entity: "welld_ch", type: "office_material", ledgerAccountId: office.id, vatCodeId: imp81.id, ...by } });
    await db.refundSetting.create({ data: { key: "accounting.welld_ch.foreign-currency-vat-code", value: novat.id, ...by } });
    await addRate("EUR", "2026-03", 924_600);
    // ...but the approved lines have nothing stored for one half: they stay blocked, they are not classified by the defaults.
    const { batchId, lineIds } = await createBatch([
      { lines: [{ type: "office_material", account: null, vat: null }, { type: "office_material", currency: "EUR", account: office, vat: null }] },
    ]);
    const { body } = await summaryOf(batchId);
    expect(body["exportable"]).toBe(false);
    expect(body["blockers"]["unclassifiedLines"].map((l: any) => [l.lineId, l.missing])).toEqual([
      [lineIds[0], ["account", "vatCode"]],
      [lineIds[1], ["vatCode"]],
    ]);
    expect((await csvOf(batchId)).status).toBe(409);
  });

  it("a stored account or VAT code that was deactivated since is kept: the line still exports (AC-1.3, AC-1.6)", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    await db.accountingCatalogStatus.create({ data: { ledgerAccountId: office.id, active: false, ...by } });
    await db.accountingCatalogStatus.create({ data: { vatCodeId: imp81.id, active: false, ...by } });
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(out.text).toContain(";6101;Spese materiale ufficio;IMP81;8.10;1.56;");
  });

  it("a line with no receipt number blocks (it cannot happen after the release): unnumberedLines", async () => {
    const { batchId, lineIds, requestIds } = await createBatch([{ lines: [{}, { numbered: false }] }]);
    const { body } = await summaryOf(batchId);
    expect(body["exportable"]).toBe(false);
    expect(body["blockers"]["unnumberedLines"]).toEqual([{ lineId: lineIds[1], requestId: requestIds[0], employee: "Matteo Codogno" }]);
    expect(body["blockers"]["unclassifiedLines"]).toEqual([]);
    expect((await csvOf(batchId)).status).toBe(409);
  });

  it("all blockers at once are reported together, in a stable order", async () => {
    const { batchId } = await createBatch([
      { owner: ANNA, lines: [{ currency: "USD", vat: novat, account: null }] },
      { owner: MATTEO, lines: [{ numbered: false }] },
    ]);
    const { body } = await summaryOf(batchId);
    expect(body["blockers"]["missingRates"]).toEqual([{ currency: "USD", month: "2026-03" }]);
    expect(body["blockers"]["unclassifiedLines"].map((l: any) => l.employee)).toEqual(["Anna Rossi"]);
    expect(body["blockers"]["unnumberedLines"].map((l: any) => l.employee)).toEqual(["Matteo Codogno"]);
    expect(body["rowCount"]).toBe(2);
  });
});

describe("a missing rate is asked of the source on demand (plan G6, R10)", () => {
  it("the missing rate is fetched BEFORE the blockers are computed: the export opens, fetchAttempted says so", async () => {
    const { fetcher, urls } = fakeSource();
    const router = routerWith(fetcher);
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", approved: 1040, date: "2026-03-02", vat: novat }] }]);

    const first = await summaryOf(batchId, router);
    expect(first.body).toMatchObject({ exportable: true, fetchAttempted: true });
    expect(first.body["blockers"]["missingRates"]).toEqual([]);
    expect(urls).toEqual(["https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03"]);

    const rates = await db.exchangeRateEntry.findMany();
    expect(rates.map((r) => [r.currency, r.rateMicros, r.origin, r.createdByUserId]).sort()).toEqual([
      ["EUR", 924_600, "fetched", "system:fx-fetch"],
      ["GBP", 1_063_500, "fetched", "system:fx-fetch"],
      ["USD", 780_800, "fetched", "system:fx-fetch"],
    ]);
    const attempts = await db.exchangeRateFetchAttempt.findMany();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ trigger: "export", outcome: "ok", actorUserId: "acct-1" });

    // The rate is now in effect: the file converts at it, and nothing is fetched again.
    const csv = await csvOf(batchId, router);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(";EUR;10.40;0.9246;9.62;");
    expect(urls).toHaveLength(1);
    expect((await summaryOf(batchId, router)).body["fetchAttempted"]).toBe(false);
  });

  it("the CSV route fetches too (it recomputes the same as the summary)", async () => {
    const { fetcher, urls } = fakeSource();
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", approved: 1040, date: "2026-03-02", vat: novat }] }]);
    const csv = await csvOf(batchId, routerWith(fetcher));
    expect(csv.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(csv.text).toContain(";EUR;10.40;0.9246;9.62;");
  });

  it("a source that is down is a blocker, never a 5xx: 200 summary, 409 CSV, rates unchanged, the attempt logged", async () => {
    const { fetcher } = fakeSource(() => new Response("boom", { status: 503 }));
    const router = routerWith(fetcher);
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", date: "2026-03-02", vat: novat }] }]);
    const summary = await summaryOf(batchId, router);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ exportable: false, fetchAttempted: true });
    expect(summary.body["blockers"]["missingRates"]).toEqual([{ currency: "EUR", month: "2026-03" }]);
    expect(await db.exchangeRateEntry.count()).toBe(0);
    expect((await db.exchangeRateFetchAttempt.findMany())[0]).toMatchObject({ outcome: "failed", errorCode: "http_503" });
    expect((await csvOf(batchId, router)).status).toBe(409);
  });

  it("a fetcher that throws is a blocker too", async () => {
    const router = createExportRouter({
      fx: {
        ensureRates: async () => {
          throw new Error("source exploded");
        },
        ratesInEffect: async (pairs) => new Map(pairs.map((p) => [`${p.currency}:${p.month}`, null])),
      },
    });
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", date: "2026-03-02", vat: novat }] }]);
    const summary = await summaryOf(batchId, router);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ exportable: false, fetchAttempted: true });
  });

  it("a month that is not yet fetchable (the current one) is never asked of the source", async () => {
    const { fetcher, urls } = fakeSource();
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", date: "2026-11-10", vat: novat }] }]);
    const summary = await summaryOf(batchId, routerWith(fetcher));
    expect(urls).toHaveLength(0);
    expect(summary.body).toMatchObject({ exportable: false, fetchAttempted: false });
    expect(summary.body["blockers"]["missingRates"]).toEqual([{ currency: "EUR", month: "2026-11" }]);
  });

  it("a batch with only CHF lines never calls the source", async () => {
    const { fetcher, urls } = fakeSource();
    const { batchId } = await createBatch([{ lines: [{}] }]);
    expect((await summaryOf(batchId, routerWith(fetcher))).body["fetchAttempted"]).toBe(false);
    expect(urls).toHaveLength(0);
  });
});

describe("the same batch twice (AC-6.8)", () => {
  it("is byte-identical, with the same hash in both log rows; a rate correction changes the hash", async () => {
    await addRate("EUR", "2026-03", 924_600, "fetched", "2026-04-01T08:00:00.000Z");
    const { batchId } = await createBatch([
      { owner: MATTEO, lines: [{ approved: 2080 }, { currency: "EUR", approved: 1040, vat: novat }] },
      { owner: ANNA, lines: [{ approved: 450 }] },
    ]);
    const a = await csvOf(batchId);
    const b = await csvOf(batchId);
    expect(a.status).toBe(200);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const log = await exportLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.contentSha256).toBe(log[1]!.contentSha256);
    expect(log[0]!.contentSha256).toBe(sha256Hex(a.bytes));

    await addRate("EUR", "2026-03", 930_000, "corrected", "2026-04-05T08:00:00.000Z");
    const c = await csvOf(batchId);
    expect(c.status).toBe(200);
    expect(Buffer.from(c.bytes).equals(Buffer.from(a.bytes))).toBe(false);
    const log3 = await exportLog();
    expect(log3).toHaveLength(3);
    expect(log3[2]!.contentSha256).not.toBe(log3[0]!.contentSha256);
    expect(c.text).toContain(";EUR;10.40;0.9300;9.67;");
  });

  it("a change of a line's classification changes the file", async () => {
    const { batchId, lineIds } = await createBatch([{ lines: [{}] }]);
    const a = await csvOf(batchId);
    await db.refundLine.update({ where: { id: lineIds[0]! }, data: { ledgerAccountId: km.id, ledgerAccountIsDefault: false } });
    const b = await csvOf(batchId);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(false);
    expect(b.text).toContain(";5905;Spese rimborsi chilometrici (viaggi);");
  });

  it("does not depend on the order the lines were created in", async () => {
    const specs: LineSpec[] = [
      { date: "2026-03-09", approved: 100 },
      { date: "2026-03-02", approved: 200 },
      { date: "2026-03-05", approved: 300 },
    ];
    const one = await createBatch([{ owner: MATTEO, lines: specs }, { owner: ANNA, lines: [{ approved: 50 }] }]);
    const forward = await csvOf(one.batchId);
    await truncateRefundTables();
    office = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Spese materiale ufficio", ...by } });
    imp81 = await db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by } });
    seqs = new Map();
    // The same lines, the requests in the opposite order. Receipt numbers follow the creation order, so create the
    // lines in the same per-owner order; only the REQUESTS' order (and so the batch item order) is reversed.
    const two = await createBatch([{ owner: ANNA, lines: [{ approved: 50 }] }, { owner: MATTEO, lines: specs }]);
    const reversed = await csvOf(two.batchId);
    // The batch id is a column, so compare everything but that.
    const strip = (text: string, id: string) => text.split(id).join("<batch>");
    expect(strip(forward.text, one.batchId)).toBe(strip(reversed.text, two.batchId));
  });
});

describe("a discarded batch has no export (AC-6.9)", () => {
  it("is 409 batch_discarded on both routes, with no file and no log row", async () => {
    await createUnbatchedRequest([{}]);
    const compiled = await call(batchesRouter, "/batches", { method: "POST", body: JSON.stringify({}) });
    const batchId = ((await compiled.json()) as { id: string }).id;
    expect((await csvOf(batchId)).status).toBe(200);
    expect((await call(batchDecideRouter, `/batches/${batchId}/discard`, { method: "POST" })).status).toBe(200);
    const before = (await exportLog()).length;

    const summary = await call(exportRouter, `/batches/${batchId}/accounting-export`);
    expect(summary.status).toBe(409);
    expect(json(await summary.text())).toMatchObject({ code: "batch_discarded" });
    const csv = await csvOf(batchId);
    expect(csv.status).toBe(409);
    expect(json(csv.text)).toMatchObject({ code: "batch_discarded" });
    expect(csv.res.headers.get("content-disposition")).toBeNull();
    expect(await exportLog()).toHaveLength(before);
  });
});

describe("the export log (AC-6.10)", () => {
  it("a download writes one row: who, which batch, how many rows, what was left out, the SHA-256 of the bytes, the format version", async () => {
    const { batchId } = await createBatch([{ lines: [{}, { approved: 99 }, { entity: "welld_it", approved: 5 }] }]);
    const out = await csvOf(batchId, exportRouter, "acct-7");
    expect(out.status).toBe(200);
    const log = await exportLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      batchId,
      actorUserId: "acct-7",
      actorEmail: "acct-7@welld.ch",
      rowCount: 2,
      excludedLineCount: 1,
      formatVersion: FORMAT_VERSION,
      contentSha256: sha256Hex(out.bytes),
    });
    expect(log[0]!.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(log[0]!.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("a summary writes no row", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    expect((await summaryOf(batchId)).status).toBe(200);
    expect((await summaryOf(batchId)).status).toBe(200);
    expect(await exportLog()).toHaveLength(0);
  });

  it("a blocked download writes no row either: nothing left the system", async () => {
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", vat: novat }] }]);
    expect((await csvOf(batchId)).status).toBe(409);
    expect(await exportLog()).toHaveLength(0);
  });
});
