/**
 * The accounting export routes (T18, specs/20261118-refund-accounting-export, plan § Test strategy rows AC-6.1 to AC-6.12,
 * AC-7.2, AC-4.6; G9 to G11; reworked by T21, specs/20261119-accounting: the file is built from COPIES, the pending rate is
 * copied inside the export transaction, Accounting is a fake `AccountingPort`; plan rows AC-5.3 to AC-5.6, AC-6.6, AC-6.7,
 * AC-7.2, AC-7.3).
 *
 * Real Postgres, jwt/authz mocked (`test-support/testAuth.ts`), Accounting FAKE (`test-support/fakeAccounting.ts`): no test
 * touches the network. `export.routes` and the batch routers are imported with a query suffix (a module instance of their
 * own): the same files are imported by other test files bound to THEIR mocked jwt/authz (testAuth.ts, "no shared router
 * specifier").
 *
 *   AC-6.1   compiled and paid batches: a header and one row per approved, not rejected WellD CH line
 *   AC-6.2   the 16 columns (the golden file is `export.test.ts`; here, through the route, from rows of the database)
 *   AC-6.3   10.40 EUR dated 2026-03-02 at 0.9246 is 9.62, in the file
 *   AC-6.4   20.80 CHF at 8.1 % carries a VAT of 1.56, in the file
 *   AC-6.5   a missing rate: summary and CSV 409 list {currency, month}; compile, mark-paid and discard still 2xx
 *   AC-6.6   WellD Italia lines are left out and counted
 *   AC-6.7   no WellD CH line: a file with the header row only
 *   AC-6.8   exported twice, identical bytes and hashes
 *   AC-6.9   a discarded batch has no export (409 `batch_discarded`, both routes)
 *   AC-6.10  a download writes one log row, a summary writes none
 *   AC-6.11  no `request:review`: 403; a review scope without welld_ch: 403 `accounting_export_out_of_scope`
 *   AC-6.12  a line approved at 0 is a row with 0.00 and 0.00
 *   AC-7.2   unclassified lines block, with date and type, until accounting classifies them
 *   AC-4.6   two employees with the same initials: the name goes with the number
 *   G10      the 409 `accounting_export_blocked` body IS the summary
 *   BINDING  an approved or paid line is read STORED-ONLY (no live defaults), as the review view reads it
 *
 *   20261119:
 *   AC-5.3   the file does not move when Accounting deactivates, renames or re-rates after the copy
 *   AC-5.4   all copies held: 0 fake calls, also while Accounting is unreachable; two exports are identical
 *   AC-5.5   copied at 0.9246, Accounting now at 0.9300: `10.40;0.9246;9.62`
 *   AC-5.6   a pending rate is copied inside the export (audited with the exporter); a refused export copies nothing;
 *            concurrent exports copy once
 *   AC-6.6   a pending line and Accounting unreachable: `accountingUnavailable`, no missing rate, no log row
 *   AC-6.7   a missing rate lists {currency, month, reason}; `fetchAttempted` as Accounting reports it
 *   AC-7.2   the golden file, byte for byte, from rows of the database
 *   AC-7.3   `viewer.canOpenAccountingRates`
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
process.env["ACCOUNTING_INTERNAL_URL"] = "http://localhost:8089";
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
const { createStandardFakeAccounting } = await import("../test-support/fakeAccounting");
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

// ─── Accounting: fake ────────────────────────────────────────────────────────

type Fake = ReturnType<typeof createStandardFakeAccounting>;
let fake: Fake = createStandardFakeAccounting();
/** A port that always reads the CURRENT fake, so the one router below serves every test. */
const livePort = { begin: (name: Parameters<Fake["begin"]>[0]) => fake.begin(name) };
const exportRouter = createExportRouter({ accounting: livePort });

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

type Owner = { id: string; name: string | null; email: string; initials: string };
const MATTEO: Owner = { id: "u-matteo", name: "Matteo Codogno", email: "matteo.codogno@welld.ch", initials: "MC" };
const MARCO: Owner = { id: "u-marco", name: "Marco Cattaneo", email: "marco.cattaneo@welld.ch", initials: "MC" };
const ANNA: Owner = { id: "u-anna", name: "Anna Rossi", email: "anna.rossi@welld.ch", initials: "AR" };

/** What a line holds when it is booked: the copies, by natural key. */
type AccountCopy = { number: string; name: string };
type VatCopy = { code: string; rateBasisPoints: number };
const OFFICE: AccountCopy = { number: "6101", name: "Spese materiale ufficio" };
const KM: AccountCopy = { number: "5905", name: "Spese rimborsi chilometrici (viaggi)" };
const IMP81: VatCopy = { code: "IMP81", rateBasisPoints: 810 };
const NOVAT: VatCopy = { code: "NOVAT", rateBasisPoints: 0 };

beforeEach(async () => {
  await truncateRefundTables();
  as(GLOBAL_REVIEWER);
  fake = createStandardFakeAccounting().setAccount(KM.number, KM.name);
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
  /** The copies stored on the line; default the office account and IMP81. `null` = nothing stored for that half. */
  account?: AccountCopy | null;
  vat?: VatCopy | null;
  /** The exchange-rate copy of a foreign-currency line, in micros. Default `null`: the rate is pending (AC-5.6). */
  fx?: number | null;
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
  const account = spec.account === undefined ? OFFICE : spec.account;
  const vat = spec.vat === undefined ? IMP81 : spec.vat;
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
      ...(classified && account ? { accountNumber: account.number, accountName: account.name, ledgerAccountIsDefault: true } : {}),
      ...(classified && vat ? { vatCodeCopy: vat.code, vatRateBasisPoints: vat.rateBasisPoints, vatCodeIsDefault: true } : {}),
      ...(classified && (spec.currency ?? "CHF") !== "CHF" && spec.fx != null
        ? { fxRateMicros: spec.fx, fxRateMonth: new Date(`${date.slice(0, 7)}-01T00:00:00.000Z`), fxRateCopiedAt: new Date("2026-03-20T10:00:00.000Z") }
        : {}),
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
          { type: "travel_km", approved: 8400, km: 120, motivo: "Visita cliente", account: KM, vat: NOVAT },
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

  it("(AC-6.3, AC-5.5) 10.40 EUR dated 2026-03-02, copied at 0.9246, is 9.62 CHF, whatever Accounting says now (0.9300)", async () => {
    fake.setRate("EUR", "2026-03", 930_000, "corrected");
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", approved: 1040, date: "2026-03-02", vat: NOVAT, fx: 924_600 }] }]);
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(out.text).toContain(";EUR;10.40;0.9246;9.62;");
    const row = dataRows(out.text)[0]!;
    expect([row[col("approvedTotal")], row[col("exchangeRate")], row[col("chfAmount")]]).toEqual(["10.40", "0.9246", "9.62"]);
    // The copy is held: Accounting was not asked at all.
    expect(fake.reads.total).toBe(0);
  });

  it("(AC-6.3) each line carries ITS OWN copy: the rate of the month of the expense date, per currency", async () => {
    const { batchId } = await createBatch([
      {
        lines: [
          { currency: "EUR", approved: 1000, date: "2026-02-28", vat: NOVAT, fx: 900_000 },
          { currency: "EUR", approved: 1000, date: "2026-03-01", vat: NOVAT, fx: 924_600 },
          { currency: "USD", approved: 1000, date: "2026-03-31", vat: NOVAT, fx: 780_800 },
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
  it("(AC-6.5, AC-6.7) a pending foreign-currency line whose month has no rate in effect blocks: the summary lists each missing currency, month and reason", async () => {
    const { batchId } = await createBatch([
      {
        lines: [
          { currency: "EUR", date: "2026-03-02", vat: NOVAT },
          { currency: "EUR", date: "2026-03-20", vat: NOVAT }, // same pair: listed once
          { currency: "USD", date: "2026-03-05", vat: NOVAT },
          { currency: "GBP", date: "2026-02-10", vat: NOVAT },
          { currency: "EUR", date: "2026-02-10", vat: NOVAT }, // February EUR has its rate in Accounting
          { currency: "EUR", date: "2026-01-10", vat: NOVAT, fx: 910_000 }, // already copied: not asked
        ],
      },
    ]);
    fake.setRate("EUR", "2026-02", 900_000);
    fake.setRateMissing("EUR", "2026-03", "not_published").setRateMissing("USD", "2026-03", "fetch_failed").setRateMissing("GBP", "2026-02", "no_source");
    const { status, body } = await summaryOf(batchId);
    expect(status).toBe(200);
    expect(body["exportable"]).toBe(false);
    expect(body["blockers"]["missingRates"]).toEqual([
      { currency: "GBP", month: "2026-02", reason: "no_source" },
      { currency: "EUR", month: "2026-03", reason: "not_published" },
      { currency: "USD", month: "2026-03", reason: "fetch_failed" },
    ]);
    expect(body["blockers"]["accountingUnavailable"]).toBe(false);
    expect(body["blockers"]["unclassifiedLines"]).toEqual([]);
    expect(body["rowCount"]).toBe(6);
    expect(body["ratePendingLineCount"]).toBe(5);
    // ONE read of the rates, for the distinct pending pairs only, in a stable order; the reference data is never read.
    expect(fake.reads).toEqual({ referenceData: 0, rates: 1, total: 1 });
    expect(fake.calls[0]!.pairs).toEqual(["EUR:2026-02", "GBP:2026-02", "EUR:2026-03", "USD:2026-03"]);
    expect(fake.calls[0]!.operation).toBe("export");
  });

  it("(G10) fetchAttempted is true when Accounting reports having tried its source for any pending pair, false otherwise", async () => {
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", date: "2026-03-02", vat: NOVAT }, { currency: "USD", date: "2026-03-02", vat: NOVAT }] }]);
    fake.setRate("EUR", "2026-03", 924_600).setRate("USD", "2026-03", 780_800);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, fetchAttempted: false });
    fake.setAttempted("USD", "2026-03", true);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, fetchAttempted: true });
    fake.setRateMissing("USD", "2026-03", "fetch_failed");
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: false, fetchAttempted: true });
  });

  it("(AC-6.5, G10) the CSV is refused with 409 accounting_export_blocked, whose body IS the summary, and no file leaves", async () => {
    const { batchId } = await createBatch([{ lines: [{}, { currency: "EUR", date: "2026-03-02", vat: NOVAT }] }]);
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
    expect(summaryPart["blockers"]["missingRates"]).toEqual([{ currency: "EUR", month: "2026-03", reason: "not_published" }]);
    expect(await exportLog()).toHaveLength(0);
  });

  it("(SR-5, S-06, D-4) the summary 200 and the blocked 409 carry Cache-Control private, no-store and nosniff, as the CSV does; so does the blocked summary 200", async () => {
    const ready = await createBatch([{ lines: [{}] }]);
    const readySummary = await call(exportRouter, `/batches/${ready.batchId}/accounting-export`);
    expect(readySummary.status).toBe(200);
    expect(readySummary.headers.get("cache-control")).toBe("private, no-store");
    expect(readySummary.headers.get("x-content-type-options")).toBe("nosniff");

    const blocked = await createBatch([{ lines: [{ currency: "EUR", date: "2026-03-02", vat: NOVAT }] }]);
    const blockedSummary = await call(exportRouter, `/batches/${blocked.batchId}/accounting-export`);
    expect(blockedSummary.status).toBe(200);
    expect(blockedSummary.headers.get("cache-control")).toBe("private, no-store");
    expect(blockedSummary.headers.get("x-content-type-options")).toBe("nosniff");
    const refused = await csvOf(blocked.batchId);
    expect(refused.status).toBe(409);
    expect(refused.res.headers.get("cache-control")).toBe("private, no-store");
    expect(refused.res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("(AC-6.5) compile, mark-paid and discard of the blocked batch are not affected: all 2xx", async () => {
    // Two approved requests with a EUR line and no rate: the export of any batch holding them is blocked.
    await createUnbatchedRequest([{ currency: "EUR", date: "2026-03-02", vat: NOVAT }]);
    as(GLOBAL_REVIEWER);

    const compiled = await call(batchesRouter, "/batches", { method: "POST", body: JSON.stringify({}) });
    expect(compiled.status).toBe(201);
    const batchId = ((await compiled.json()) as { id: string }).id;
    expect((await summaryOf(batchId)).body["blockers"]["missingRates"]).toEqual([{ currency: "EUR", month: "2026-03", reason: "not_published" }]);
    expect((await csvOf(batchId)).status).toBe(409);

    const paid = await call(batchDecideRouter, `/batches/${batchId}/mark-paid`, { method: "POST" });
    expect(paid.status).toBe(200);
    // Still blocked, still refused, and the batch is paid.
    expect((await csvOf(batchId)).status).toBe(409);
    expect(((await db.refundBatch.findUnique({ where: { id: batchId } }))!).status).toBe("paid");

    // A second blocked batch: discard it.
    await createUnbatchedRequest([{ currency: "GBP", date: "2026-03-09", vat: NOVAT }]);
    const compiled2 = await call(batchesRouter, "/batches", { method: "POST", body: JSON.stringify({}) });
    expect(compiled2.status).toBe(201);
    const batch2 = ((await compiled2.json()) as { id: string }).id;
    expect((await csvOf(batch2)).status).toBe(409);
    const discarded = await call(batchDecideRouter, `/batches/${batch2}/discard`, { method: "POST" });
    expect(discarded.status).toBe(200);
  });

  it("(AC-7.2, G11, 20261118 AC-3.11) lines without an account block, named by id, date, type, employee and number, until accounting classifies them; a missing VAT code never blocks", async () => {
    const { batchId, lineIds, requestIds } = await createBatch([
      {
        lines: [
          { type: "office_material", date: "2026-03-10", account: null, vat: IMP81 },
          { type: "travel_train", date: "2026-03-03", account: OFFICE, vat: null }, // an account and no VAT code: complete
          { type: "postal", date: "2026-03-04", account: null, vat: null },
          { type: "office_material", date: "2026-03-05" }, // fully classified: not listed
        ],
      },
    ]);
    const { body } = await summaryOf(batchId);
    expect(body["exportable"]).toBe(false);
    expect(body["blockers"]["unclassifiedLines"]).toEqual([
      { lineId: lineIds[2], requestId: requestIds[0], date: "2026-03-04", type: "postal", employee: "Matteo Codogno", receiptNumber: "MC26/003", missing: ["account"] },
      { lineId: lineIds[0], requestId: requestIds[0], date: "2026-03-10", type: "office_material", employee: "Matteo Codogno", receiptNumber: "MC26/001", missing: ["account"] },
    ]);
    const csv = await csvOf(batchId);
    expect(csv.status).toBe(409);
    expect(json(csv.text)["blockers"]["unclassifiedLines"]).toHaveLength(2);
    // Nothing was classified, copied or read from Accounting to say so.
    expect(fake.reads.total).toBe(0);

    // Accounting classifies them (the PUT writes copies by natural key): the export opens.
    await db.refundLine.update({ where: { id: lineIds[0]! }, data: { accountNumber: OFFICE.number, accountName: OFFICE.name, ledgerAccountIsDefault: false } });
    await db.refundLine.update({
      where: { id: lineIds[2]! },
      data: { accountNumber: OFFICE.number, accountName: OFFICE.name, ledgerAccountIsDefault: false },
    });
    as(GLOBAL_REVIEWER);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, rowCount: 4 });
    expect((await csvOf(batchId)).status).toBe(200);
  });

  it("BINDING: an approved line is read STORED-ONLY, exactly as the review view reads it: a live default never fills an account left empty", async () => {
    // Refund records a default account for the type, Accounting lists every entry as active...
    const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
    await db.expenseTypeAccountingDefault.create({
      data: { entity: "welld_ch", type: "office_material", accountNumber: OFFICE.number, accountName: OFFICE.name, ...by },
    });
    fake.setRate("EUR", "2026-03", 924_600);
    // ...but the approved line has nothing stored for the account: it stays blocked, it is not classified by the default.
    const { batchId, lineIds } = await createBatch([
      { lines: [{ type: "office_material", account: null, vat: null }, { type: "office_material", currency: "EUR", account: OFFICE, vat: null }] },
    ]);
    const { body } = await summaryOf(batchId);
    expect(body["exportable"]).toBe(false);
    expect(body["blockers"]["unclassifiedLines"].map((l: any) => [l.lineId, l.missing])).toEqual([[lineIds[0], ["account"]]]);
    expect((await csvOf(batchId)).status).toBe(409);
    // The rate of the EUR line was asked (it is pending), the reference data and the defaults never were consulted.
    expect(fake.reads.referenceData).toBe(0);
    // ...and the refused export copied nothing.
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: lineIds[1]! } })).fxRateMicros).toBeNull();
  });

  it("(20261118 AC-3.11) a batch whose lines have an account and no VAT code is exported like any other, the VAT cells empty", async () => {
    const { batchId } = await createBatch([{ lines: [{ account: OFFICE, vat: null }] }]);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, rowCount: 1 });
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(out.text).toContain(";6101;Spese materiale ufficio;;;;");
  });

  it("(AC-5.3) a stored account or VAT code that was deactivated since, or renamed, or gone, is kept: the line still exports as copied", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    fake.setAccountActive("6101", false).setVatCodeActive("IMP81", false);
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(out.text).toContain(";6101;Spese materiale ufficio;IMP81;8.10;1.56;");
    fake.setAccount("6101", "Another name").removeVatCode("IMP81");
    expect((await csvOf(batchId)).text).toContain(";6101;Spese materiale ufficio;IMP81;8.10;1.56;");
    expect(fake.reads.total).toBe(0);
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
      { owner: ANNA, lines: [{ currency: "USD", vat: NOVAT, account: null }] },
      { owner: MATTEO, lines: [{ numbered: false }] },
    ]);
    const { body } = await summaryOf(batchId);
    expect(body["blockers"]["missingRates"]).toEqual([{ currency: "USD", month: "2026-03", reason: "not_published" }]);
    expect(body["blockers"]["unclassifiedLines"].map((l: any) => l.employee)).toEqual(["Anna Rossi"]);
    expect(body["blockers"]["unnumberedLines"].map((l: any) => l.employee)).toEqual(["Matteo Codogno"]);
    expect(body["rowCount"]).toBe(2);
  });
});

describe("the file is built from copies; Accounting is asked only for a pending rate (AC-5.3, AC-5.4)", () => {
  const EUR_LINE: LineSpec = { currency: "EUR", approved: 1040, date: "2026-03-02", vat: NOVAT, fx: 924_600 };

  it("(AC-5.4) every line holds its copies and Accounting is unreachable: the summary is exportable, the file is produced, 0 fake calls", async () => {
    const { batchId } = await createBatch([{ lines: [{}, EUR_LINE, { type: "travel_km", km: 10, account: KM, vat: NOVAT }] }]);
    fake.failWith("timeout");
    const summary = await summaryOf(batchId);
    expect(summary.body).toMatchObject({ exportable: true, rowCount: 3, ratePendingLineCount: 0, fetchAttempted: false });
    expect(summary.body["blockers"]).toEqual({ missingRates: [], unclassifiedLines: [], unnumberedLines: [], accountingUnavailable: false });
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(dataRows(out.text)).toHaveLength(3);
    expect(fake.calls).toHaveLength(0);
  });

  it("(AC-5.4) a batch with CHF lines only, or only IT and rejected foreign lines, never asks Accounting", async () => {
    const { batchId } = await createBatch([
      { lines: [{}, { entity: "welld_it", currency: "EUR" }, { rejected: true, currency: "EUR" }, { currency: "USD", rejected: true, numbered: false }] },
    ]);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true, rowCount: 1, ratePendingLineCount: 0 });
    expect((await csvOf(batchId)).status).toBe(200);
    expect(fake.calls).toHaveLength(0);
  });

  it("(AC-5.3, AC-5.4) Accounting deactivates the account and the VAT code, renames them, corrects the rate and re-enters entries between two exports: the bytes and the hash are identical", async () => {
    const { batchId } = await createBatch([{ owner: MATTEO, lines: [{ approved: 2080 }, EUR_LINE] }, { owner: ANNA, lines: [{ approved: 450 }] }]);
    const a = await csvOf(batchId);
    fake.setAccountActive("6101", false).setAccount("6101", "A new name").removeVatCode("IMP81").setRate("EUR", "2026-03", 930_000, "corrected");
    const b = await csvOf(batchId);
    fake.failWith("network");
    const c = await csvOf(batchId);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(c.bytes))).toBe(true);
    const log = await exportLog();
    expect(log.map((row) => row.contentSha256)).toEqual([sha256Hex(a.bytes), sha256Hex(a.bytes), sha256Hex(a.bytes)]);
    expect(fake.calls).toHaveLength(0);
  });

  it("(AC-5.5) copied at 0.9246 with Accounting now at 0.9300, the row reads 10.40;0.9246;9.62 and the VAT follows the copied code", async () => {
    const { batchId } = await createBatch([{ lines: [{ ...EUR_LINE, vat: IMP81 }] }]);
    fake.setRate("EUR", "2026-03", 930_000, "corrected");
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    const row = dataRows(out.text)[0]!;
    expect([row[col("approvedTotal")], row[col("exchangeRate")], row[col("chfAmount")], row[col("vatAmount")]]).toEqual(["10.40", "0.9246", "9.62", "0.72"]);
    expect(out.text).toContain(";EUR;10.40;0.9246;9.62;");
  });

  it("the file does not follow the copied rate's origin: a line copied at one rate and one copied at another each keep theirs", async () => {
    const { batchId } = await createBatch([
      { lines: [{ ...EUR_LINE, date: "2026-03-02" }, { ...EUR_LINE, date: "2026-03-09", fx: 950_000 }] },
    ]);
    const rows = dataRows((await csvOf(batchId)).text);
    expect(rows.map((r) => [r[col("exchangeRate")], r[col("chfAmount")]])).toEqual([
      ["0.9246", "9.62"],
      ["0.9500", "9.88"],
    ]);
  });
});

describe("a pending rate is copied by the first export that succeeds (AC-5.6, D12)", () => {
  const PENDING: LineSpec = { currency: "EUR", approved: 1040, date: "2026-03-02", vat: NOVAT };
  const lineRow = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });
  const copiedAudit = () => db.refundAuditEntry.findMany({ where: { action: "line_rate_copied" }, orderBy: { createdAt: "asc" } });

  it("the summary asks Accounting once and writes nothing: the line stays pending, nothing is audited or logged", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const { batchId, lineIds } = await createBatch([{ lines: [PENDING, {}] }]);
    const summary = await summaryOf(batchId);
    expect(summary.body).toMatchObject({ exportable: true, rowCount: 2, ratePendingLineCount: 1, fetchAttempted: false });
    expect(fake.reads).toEqual({ referenceData: 0, rates: 1, total: 1 });
    const line = await lineRow(lineIds[0]!);
    expect([line.fxRateMicros, line.fxRateMonth, line.fxRateCopiedAt]).toEqual([null, null, null]);
    expect(await copiedAudit()).toHaveLength(0);
    expect(await exportLog()).toHaveLength(0);
  });

  it("the CSV copies the rate in effect onto the line, audits the exporter, builds the file from the copy and logs it, all in one go", async () => {
    fake.setRate("EUR", "2026-03", 924_600, "fetched");
    const { batchId, lineIds, requestIds } = await createBatch([{ lines: [PENDING] }]);
    const before = Date.now();
    const out = await csvOf(batchId, exportRouter, "acct-7");
    expect(out.status).toBe(200);
    expect(out.text).toContain(";EUR;10.40;0.9246;9.62;");

    const line = await lineRow(lineIds[0]!);
    expect(line.fxRateMicros).toBe(924_600);
    expect(line.fxRateMonth?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(line.fxRateCopiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const audit = await copiedAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ requestId: requestIds[0], lineId: lineIds[0], actorUserId: "acct-7", actorEmail: "acct-7@welld.ch" });
    expect(audit[0]!.detail).toEqual({ v: 2, cause: "export", batchId, rateMicros: 924_600, month: "2026-03", currency: "EUR" });
    expect(await exportLog()).toHaveLength(1);
    expect(fake.reads).toEqual({ referenceData: 0, rates: 1, total: 1 });
  });

  it("(AC-5.3) afterwards the line is as any other: Accounting changes the rate, and a second export makes no call, copies nothing and gives the same bytes", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const { batchId, lineIds } = await createBatch([{ lines: [PENDING, {}] }]);
    const first = await csvOf(batchId);
    fake.setRate("EUR", "2026-03", 930_000, "corrected");
    fake.resetCalls();
    const second = await csvOf(batchId);
    expect(second.status).toBe(200);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect((await lineRow(lineIds[0]!)).fxRateMicros).toBe(924_600);
    expect(await copiedAudit()).toHaveLength(1);
    expect((await summaryOf(batchId)).body).toMatchObject({ ratePendingLineCount: 0 });
  });

  it("two pending lines of the same pair share the one rate; two currencies and two months each get their own", async () => {
    fake.setRate("EUR", "2026-03", 924_600).setRate("USD", "2026-03", 780_800).setRate("EUR", "2026-02", 900_000);
    const { batchId, lineIds } = await createBatch([
      {
        lines: [
          { ...PENDING, date: "2026-03-02" },
          { ...PENDING, date: "2026-03-20" },
          { ...PENDING, currency: "USD", date: "2026-03-05" },
          { ...PENDING, date: "2026-02-10" },
        ],
      },
    ]);
    expect((await csvOf(batchId)).status).toBe(200);
    expect((await Promise.all(lineIds.map(lineRow))).map((l) => [l.fxRateMicros, l.fxRateMonth?.toISOString().slice(0, 7)])).toEqual([
      [924_600, "2026-03"],
      [924_600, "2026-03"],
      [780_800, "2026-03"],
      [900_000, "2026-02"],
    ]);
    expect(await copiedAudit()).toHaveLength(4);
    expect(fake.reads.rates).toBe(1);
  });

  it("a pending line of a PAID batch is copied at its first export too (the copy is null to set, never a change)", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const { batchId, lineIds } = await createBatch([{ lines: [PENDING] }], "paid");
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect((await lineRow(lineIds[0]!)).fxRateMicros).toBe(924_600);
  });

  it("a refused export copies nothing to any line: another pair is missing, or a line is unclassified, or Accounting is down", async () => {
    fake.setRate("EUR", "2026-03", 924_600); // USD has none
    const missing = await createBatch([{ lines: [PENDING, { ...PENDING, currency: "USD" }] }]);
    expect((await csvOf(missing.batchId)).status).toBe(409);

    fake.setRate("USD", "2026-03", 780_800);
    const unclassified = await createBatch([{ lines: [PENDING, { account: null }] }]);
    expect((await csvOf(unclassified.batchId)).status).toBe(409);

    const unnumbered = await createBatch([{ lines: [PENDING, { numbered: false }] }]);
    expect((await csvOf(unnumbered.batchId)).status).toBe(409);

    fake.failWith("timeout");
    const down = await createBatch([{ lines: [PENDING] }]);
    expect((await csvOf(down.batchId)).status).toBe(409);

    for (const id of [...missing.lineIds, ...unclassified.lineIds, ...unnumbered.lineIds, ...down.lineIds]) {
      const line = await lineRow(id);
      expect([line.fxRateMicros, line.fxRateMonth, line.fxRateCopiedAt]).toEqual([null, null, null]);
    }
    expect(await copiedAudit()).toHaveLength(0);
    expect(await exportLog()).toHaveLength(0);
  });

  it("two exports at once copy once: one audit row, both files equal, both logged (20 batches)", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    for (let i = 0; i < 20; i++) {
      const { batchId, lineIds } = await createBatch([{ lines: [PENDING, { ...PENDING, date: "2026-03-09" }, {}] }]);
      const before = (await copiedAudit()).length;
      const [a, b] = await Promise.all([csvOf(batchId), csvOf(batchId, exportRouter, "acct-2")]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
      expect((await copiedAudit()).length - before).toBe(2); // two pending lines, each copied exactly once
      expect((await Promise.all(lineIds.slice(0, 2).map(lineRow))).map((l) => l.fxRateMicros)).toEqual([924_600, 924_600]);
      expect((await db.refundBatchExport.findMany({ where: { batchId } })).length).toBe(2);
    }
  });

  it("a concurrent export that copied first wins: this export writes no copy and no audit, and builds its file from the winner's rate", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const { batchId, lineIds } = await createBatch([{ lines: [PENDING] }]);
    // While Accounting is being read, another export commits its copy (a different rate in effect at that moment).
    fake.onRead(async (call) => {
      if (call.read !== "rates") return;
      fake.onRead(null);
      await db.refundLine.update({
        where: { id: lineIds[0]! },
        data: { fxRateMicros: 910_000, fxRateMonth: new Date("2026-03-01T00:00:00.000Z"), fxRateCopiedAt: new Date() },
      });
    });
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(out.text).toContain(";EUR;10.40;0.9100;9.46;");
    expect((await lineRow(lineIds[0]!)).fxRateMicros).toBe(910_000);
    expect(await copiedAudit()).toHaveLength(0);
  });

  it("a batch discarded while Accounting is being read is refused 409 batch_discarded, and nothing is copied or logged", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const { batchId, lineIds } = await createBatch([{ lines: [PENDING] }]);
    fake.onRead(async () => {
      fake.onRead(null);
      await db.refundBatch.update({ where: { id: batchId }, data: { status: "discarded" } });
    });
    const out = await csvOf(batchId);
    expect(out.status).toBe(409);
    expect(json(out.text)).toMatchObject({ code: "batch_discarded" });
    expect((await lineRow(lineIds[0]!)).fxRateMicros).toBeNull();
    expect(await copiedAudit()).toHaveLength(0);
    expect(await exportLog()).toHaveLength(0);
  });

  it("a line that stops being exportable while Accounting is being read refuses the export from the summary it re-evaluated, with nothing copied", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const { batchId, lineIds } = await createBatch([{ lines: [PENDING, {}] }]);
    fake.onRead(async () => {
      fake.onRead(null);
      await db.refundLine.update({ where: { id: lineIds[1]! }, data: { accountNumber: null, accountName: null } });
    });
    const out = await csvOf(batchId);
    expect(out.status).toBe(409);
    expect(json(out.text)).toMatchObject({ code: "accounting_export_blocked", exportable: false });
    expect(json(out.text)["blockers"]["unclassifiedLines"].map((l: any) => l.lineId)).toEqual([lineIds[1]]);
    expect((await lineRow(lineIds[0]!)).fxRateMicros).toBeNull();
    expect(await copiedAudit()).toHaveLength(0);
    expect(await exportLog()).toHaveLength(0);
  });
});

describe("Accounting cannot be read while a line waits for its rate (AC-6.6, AC-6.8, D14)", () => {
  const PENDING: LineSpec = { currency: "EUR", approved: 1040, date: "2026-03-02", vat: NOVAT };

  it("is a blocker of its own, never a missing rate: summary 200 and CSV 409 say accountingUnavailable, with no log row and no copy", async () => {
    const { batchId, lineIds } = await createBatch([{ lines: [PENDING, { currency: "USD", date: "2026-03-05", vat: NOVAT }, {}] }]);
    for (const kind of ["timeout", "network", "http_status", "unauthorized", "redirect", "not_json", "too_large", "schema", "entity_mismatch", "pair_mismatch", "token"] as const) {
      fake.failWith(kind);
      const summary = await summaryOf(batchId);
      expect(summary.status).toBe(200);
      expect(summary.body).toMatchObject({ exportable: false, rowCount: 3, ratePendingLineCount: 2, fetchAttempted: false });
      expect(summary.body["blockers"]).toEqual({ missingRates: [], unclassifiedLines: [], unnumberedLines: [], accountingUnavailable: true });
      const csv = await csvOf(batchId);
      expect(csv.status).toBe(409);
      const body = json(csv.text);
      expect(body).toMatchObject({ code: "accounting_export_blocked", exportable: false });
      expect(body["blockers"]["accountingUnavailable"]).toBe(true);
      expect(body["blockers"]["missingRates"]).toEqual([]);
      expect(ExportBlockedSchema.safeParse(body).success).toBe(true);
    }
    expect(await exportLog()).toHaveLength(0);
    expect((await db.refundLine.findUniqueOrThrow({ where: { id: lineIds[0]! } })).fxRateMicros).toBeNull();
    expect(await db.refundAuditEntry.count({ where: { action: "line_rate_copied" } })).toBe(0);
  });

  it("only the rates read failing is the same; the reference data is not even asked", async () => {
    const { batchId } = await createBatch([{ lines: [PENDING] }]);
    fake.failRatesWith("schema");
    expect((await summaryOf(batchId)).body["blockers"]["accountingUnavailable"]).toBe(true);
    fake.failRatesWith(null).failReferenceDataWith("schema").setRate("EUR", "2026-03", 924_600);
    expect((await summaryOf(batchId)).body).toMatchObject({ exportable: true });
    expect(fake.reads.referenceData).toBe(0);
  });

  it("is reported next to the other blockers, which Refund knows without Accounting", async () => {
    const { batchId } = await createBatch([{ lines: [PENDING, { account: null }, { numbered: false }] }]);
    fake.failWith("timeout");
    const { body } = await summaryOf(batchId);
    expect(body["exportable"]).toBe(false);
    expect(body["blockers"]["accountingUnavailable"]).toBe(true);
    expect(body["blockers"]["unclassifiedLines"]).toHaveLength(1);
    expect(body["blockers"]["unnumberedLines"]).toHaveLength(1);
  });

  it("compiling, paying and discarding the batch are not affected; once Accounting is back the export opens and copies", async () => {
    await createUnbatchedRequest([PENDING]);
    as(GLOBAL_REVIEWER);
    fake.failWith("timeout");
    const compiled = await call(batchesRouter, "/batches", { method: "POST", body: JSON.stringify({}) });
    expect(compiled.status).toBe(201);
    const batchId = ((await compiled.json()) as { id: string }).id;
    expect((await csvOf(batchId)).status).toBe(409);
    expect((await call(batchDecideRouter, `/batches/${batchId}/mark-paid`, { method: "POST" })).status).toBe(200);
    expect((await csvOf(batchId)).status).toBe(409);
    expect(await exportLog()).toHaveLength(0);

    fake.failWith(null).setRate("EUR", "2026-03", 924_600);
    const out = await csvOf(batchId);
    expect(out.status).toBe(200);
    expect(out.text).toContain(";EUR;10.40;0.9246;9.62;");
    expect(await exportLog()).toHaveLength(1);
  });

  it("a second batch can be discarded while Accounting is down", async () => {
    await createUnbatchedRequest([PENDING]);
    as(GLOBAL_REVIEWER);
    fake.failWith("network");
    const compiled = await call(batchesRouter, "/batches", { method: "POST", body: JSON.stringify({}) });
    const batchId = ((await compiled.json()) as { id: string }).id;
    expect((await csvOf(batchId)).status).toBe(409);
    expect((await call(batchDecideRouter, `/batches/${batchId}/discard`, { method: "POST" })).status).toBe(200);
  });

  it("the refusal bodies carry no address, host, id or internal text (AC-6.10)", async () => {
    const { batchId } = await createBatch([{ lines: [PENDING] }]);
    fake.failWith("timeout");
    const summary = (await summaryOf(batchId)).body;
    const csv = json((await csvOf(batchId)).text);
    for (const body of [summary, csv]) {
      // `type` is the RFC 7807 pointer to the status page, the one URL a Problem body has.
      const { type: _type, ...rest } = body;
      expect(JSON.stringify(rest)).not.toMatch(/https?:|localhost|8089|accounting-api|\.internal|stack|at \//i);
    }
  });
});

describe("who may open Accounting's rates (AC-7.3, D17)", () => {
  const withAccounting = (...grants: [string, string, boolean?][]): ResolveResponse => ({
    ...perms(["request", "review"], ...grants),
    entity: "welld_ch",
  });

  it("is true for accounting:read or accounting:manage covering WellD CH, on the summary and on the blocked 409", async () => {
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", date: "2026-03-02", vat: NOVAT }] }]);
    for (const resolve of [
      withAccounting(["accounting", "read"]),
      withAccounting(["accounting", "manage"]),
      withAccounting(["accounting", "read", true]),
      withAccounting(["accounting", "manage", true]),
    ]) {
      as(resolve);
      expect((await summaryOf(batchId)).body["viewer"]).toEqual({ canOpenAccountingRates: true });
      expect(json((await csvOf(batchId)).text)["viewer"]).toEqual({ canOpenAccountingRates: true });
    }
  });

  it("is false with no Accounting grant, or a grant that covers WellD Italia only, or an unrecognised condition", async () => {
    const { batchId } = await createBatch([{ lines: [{}] }]);
    for (const resolve of [
      withAccounting(),
      { ...withAccounting(["accounting", "read", true]), entity: "welld_it" },
      { ...withAccounting(["accounting", "manage", true]), entity: null },
      {
        ...withAccounting(),
        permissions: [
          ...withAccounting().permissions,
          { resource: "accounting", action: "read", conditions: { ownership: "own" } },
        ],
      } as unknown as ResolveResponse,
    ]) {
      as(resolve);
      const summary = await summaryOf(batchId);
      expect(summary.status).toBe(200);
      expect(summary.body["viewer"]).toEqual({ canOpenAccountingRates: false });
    }
  });
});

describe("the same batch twice (AC-6.8)", () => {
  it("is byte-identical, with the same hash in both log rows; a rate correction in Accounting changes nothing (AC-5.3)", async () => {
    const { batchId } = await createBatch([
      { owner: MATTEO, lines: [{ approved: 2080 }, { currency: "EUR", approved: 1040, vat: NOVAT, fx: 924_600 }] },
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

    fake.setRate("EUR", "2026-03", 930_000, "corrected");
    const c = await csvOf(batchId);
    expect(c.status).toBe(200);
    expect(Buffer.from(c.bytes).equals(Buffer.from(a.bytes))).toBe(true);
    expect((await exportLog()).map((row) => row.contentSha256)).toEqual([sha256Hex(a.bytes), sha256Hex(a.bytes), sha256Hex(a.bytes)]);
    expect(c.text).toContain(";EUR;10.40;0.9246;9.62;");
  });

  it("a change of a line's classification changes the file", async () => {
    const { batchId, lineIds } = await createBatch([{ lines: [{}] }]);
    const a = await csvOf(batchId);
    await db.refundLine.update({ where: { id: lineIds[0]! }, data: { accountNumber: KM.number, accountName: KM.name, ledgerAccountIsDefault: false } });
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

describe("the golden file, through the route and the database (AC-7.2, AC-6.2)", () => {
  interface GoldenLine {
    lineId: string;
    ownerUserId: string;
    ownerName: string | null;
    ownerEmail: string;
    receiptNumber: string;
    receiptYear: number;
    receiptSeq: number;
    date: string;
    type: string;
    motivo: string;
    km: number | null;
    currency: "CHF" | "EUR" | "USD" | "GBP";
    approvedCents: number;
    rateMicros: number | null;
    accountNumber: string;
    accountName: string;
    vatCode: string;
    vatRateBasisPoints: number;
  }
  const FIXTURES = join(import.meta.dir, "fixtures");
  const golden = readFileSync(join(FIXTURES, "accounting-export.golden.csv"));
  const input = JSON.parse(readFileSync(join(FIXTURES, "accounting-export.input.json"), "utf8")) as { lines: GoldenLine[] };

  it("the lines of the 20261118 input, held as copies, give the 20261118 golden bytes, header, column order and values unchanged", async () => {
    const batch = await db.refundBatch.create({
      data: { cutoff: new Date("2026-03-31T21:59:59.000Z"), status: "compiled", createdByUserId: "a", createdByEmail: "a@welld.ch", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
    });
    const requestOf = new Map<string, string>();
    for (const line of input.lines) {
      let requestId = requestOf.get(line.ownerUserId);
      if (!requestId) {
        const request = await db.refundRequest.create({
          data: {
            ownerUserId: line.ownerUserId,
            ownerEmail: line.ownerEmail,
            ownerName: line.ownerName,
            status: "approved",
            decidedAt: new Date("2026-03-20T10:00:00.000Z"),
            decidedByUserId: "a",
            decidedByEmail: "a@welld.ch",
            batchId: batch.id,
          },
        });
        requestId = request.id;
        requestOf.set(line.ownerUserId, requestId);
        await db.refundBatchItem.create({ data: { batchId: batch.id, requestId } });
      }
      await db.refundLine.create({
        data: {
          requestId,
          date: new Date(line.date),
          type: line.type as "office_material",
          motivo: line.motivo,
          entity: "welld_ch",
          currency: line.currency,
          requestedAmountCents: line.approvedCents,
          approvedTotalCents: line.approvedCents,
          ...(line.km !== null ? { km: line.km } : {}),
          accountNumber: line.accountNumber,
          accountName: line.accountName,
          ledgerAccountIsDefault: false,
          vatCodeCopy: line.vatCode,
          vatRateBasisPoints: line.vatRateBasisPoints,
          vatCodeIsDefault: false,
          ...(line.rateMicros !== null
            ? { fxRateMicros: line.rateMicros, fxRateMonth: new Date(`${line.date.slice(0, 7)}-01T00:00:00.000Z`), fxRateCopiedAt: new Date() }
            : {}),
          receiptNumber: line.receiptNumber,
          receiptOwnerUserId: line.ownerUserId,
          receiptYear: line.receiptYear,
          receiptSeq: line.receiptSeq,
          numberedAt: new Date(),
        },
      });
    }

    const out = await csvOf(batch.id);
    expect(out.status).toBe(200);
    // The batch id is a column of the file: the fixture's is `batch-golden-1`.
    const replaced = new TextEncoder().encode(out.text.split(batch.id).join("batch-golden-1"));
    expect(Buffer.from(replaced).equals(golden)).toBe(true);
    expect(fake.calls).toHaveLength(0);
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
    const { batchId } = await createBatch([{ lines: [{ currency: "EUR", vat: NOVAT }] }]);
    expect((await csvOf(batchId)).status).toBe(409);
    expect(await exportLog()).toHaveLength(0);
  });
});
