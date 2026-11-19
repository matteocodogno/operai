/**
 * How the accounting export fails (T19, specs/20261118-refund-accounting-export; AC-6.5, AC-6.10; plan § Test strategy "Extra
 * tests", rows 4 to 6; G6, G9; reworked by T21, specs/20261119-accounting: AC-5.6, AC-6.6, AC-6.8; ADR 20261118-the-accounting-
 * export-is-generated-on-request-never-stored-and-logged-append-only-with-its-content-hash-and-format-version).
 *
 *   1. A failed export-log write, or a failed rate copy, is a 500 Problem with NO file, NO log row and NO copy: record, then
 *      deliver, and a refused export copies nothing (AC-5.6). The failure is a REAL one: a trigger on the table that raises
 *      (created here, always dropped), so the whole path from the route to the database is the production one.
 *   2. CORS exposes `Content-Disposition` and `X-Export-*` (G9), from the real app's CORS layer, and every header the file route
 *      sets for the file is in that list, so a header added later cannot silently stay unreadable.
 *   3. Accounting that does not answer cannot hold the export (AC-6.8, D3): through the REAL client with a short deadline, a
 *      read that never returns ends as the `accountingUnavailable` blocker in about the deadline, never as a 5xx and never as a
 *      missing rate; and through the real client and its wire schema, a rates answer is read as the contract says
 *      (`attempted` is `fetchAttempted`, `reason` is the missing rate's reason).
 *
 * Real Postgres, jwt/authz mocked, Accounting fake or an injected `fetch`, no network.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolveResponse } from "../authz/resolveClient";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";
import { cellValues, readWorkbook } from "../test-support/xlsxReader";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173,http://localhost:3000";
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

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { createExportRouter } = (await import("./export.routes?failures")) as typeof import("./export.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { createStandardFakeAccounting } = await import("../test-support/fakeAccounting");
const { createAccountingClient } = await import("./accountingClient");
const REVIEWER: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

let fake = createStandardFakeAccounting();

const TRIGGER = "test_t19_fail_export_log";
const COPY_TRIGGER = "test_t21_fail_rate_copy";
const dropFailingTrigger = async () => {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON "refund_batch_export"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${COPY_TRIGGER} ON "refund_line"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${COPY_TRIGGER}()`);
};

beforeAll(dropFailingTrigger); // a crashed earlier run must not leave the table broken for the rest of the suite
beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => REVIEWER);
  fake = createStandardFakeAccounting();
});
afterEach(dropFailingTrigger);
afterAll(async () => {
  await dropFailingTrigger();
  await truncateRefundTables();
});

let owners = 0;
async function seedBatch(lines: { currency?: "CHF" | "EUR" | "USD"; date?: string; fx?: number }[]) {
  const batch = await db.refundBatch.create({
    data: { cutoff: new Date("2026-03-31T21:59:59.000Z"), status: "compiled", createdByUserId: "a", createdByEmail: "a@welld.ch", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
  });
  const ownerId = `u-${++owners}`;
  const request = await db.refundRequest.create({
    data: { ownerUserId: ownerId, ownerEmail: `${ownerId}@welld.ch`, ownerName: "Matteo Codogno", status: "approved", decidedAt: new Date("2026-03-20"), decidedByUserId: "a", decidedByEmail: "a@welld.ch", batchId: batch.id },
  });
  for (const [i, spec] of lines.entries()) {
    await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date(spec.date ?? "2026-03-02"),
        type: "office_material",
        motivo: "Cancelleria",
        entity: "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: 2080,
        approvedTotalCents: 2080,
        createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, i)),
        accountNumber: "6101",
        accountName: "Spese materiale ufficio",
        ledgerAccountIsDefault: true,
        vatCodeCopy: (spec.currency ?? "CHF") === "CHF" ? "IMP81" : "NOVAT",
        vatRateBasisPoints: (spec.currency ?? "CHF") === "CHF" ? 810 : 0,
        vatCodeIsDefault: true,
        ...(spec.fx !== undefined
          ? { fxRateMicros: spec.fx, fxRateMonth: new Date(`${(spec.date ?? "2026-03-02").slice(0, 7)}-01T00:00:00.000Z`), fxRateCopiedAt: new Date() }
          : {}),
        receiptNumber: `MC26/${String(i + 1).padStart(3, "0")}`,
        receiptOwnerUserId: ownerId,
        receiptYear: 2026,
        receiptSeq: i + 1,
        numberedAt: new Date(),
      },
    });
  }
  await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
  return batch.id;
}

async function call(router: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, path: string) {
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  return router.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

// ═════════════════════════════════════════════════════════════════════════════

describe("a failed export-log write or rate copy is a 500 with no file, no row and no copy (AC-6.10, AC-5.6)", () => {
  const exportRouter = createExportRouter({ accounting: { begin: (name) => fake.begin(name) } });

  async function breakTheLog() {
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated export log failure'; END; $$`,
    );
    await db.$executeRawUnsafe(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON "refund_batch_export" FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}()`);
  }

  it("answers 500 Problem JSON; no workbook, no ZIP bytes, no filename, no X-Export-*; nothing is logged", async () => {
    const batchId = await seedBatch([{}, {}]);
    await breakTheLog();

    const res = await call(exportRouter, `/batches/${batchId}/accounting-export/file`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("x-export-row-count")).toBeNull();
    expect(res.headers.get("x-export-excluded-line-count")).toBeNull();
    expect([...bytes.slice(0, 2)]).not.toEqual([0x50, 0x4b]); // "PK": not a ZIP, so not a workbook
    expect(text).not.toContain("Description");
    expect(text).not.toContain("MC26/001");
    expect(text).not.toContain("Matteo");

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 500, title: "Internal Server Error", code: "export_log_failed" });
    // The database's own message (a table, a trigger, a statement) is not shown to the caller.
    expect(text).not.toMatch(/simulated|trigger|refund_batch_export|INSERT|prisma/i);

    expect(await db.refundBatchExport.count()).toBe(0);
  });

  it("the summary is unaffected (it writes no row), and the route works again once the log is repaired", async () => {
    const batchId = await seedBatch([{}]);
    await breakTheLog();
    expect((await call(exportRouter, `/batches/${batchId}/accounting-export`)).status).toBe(200);
    expect((await call(exportRouter, `/batches/${batchId}/accounting-export/file`)).status).toBe(500);

    await dropFailingTrigger();
    const ok = await call(exportRouter, `/batches/${batchId}/accounting-export/file`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(readWorkbook(new Uint8Array(await ok.arrayBuffer())).rows).toHaveLength(2); // the header and the one line
    expect(await db.refundBatchExport.count()).toBe(1);
  });

  it("every failed attempt leaves no row, and a later success leaves exactly one: the log never counts a file that did not leave", async () => {
    const batchId = await seedBatch([{}]);
    await breakTheLog();
    for (let i = 0; i < 3; i++) expect((await call(exportRouter, `/batches/${batchId}/accounting-export/file`)).status).toBe(500);
    expect(await db.refundBatchExport.count()).toBe(0);
    await dropFailingTrigger();
    expect((await call(exportRouter, `/batches/${batchId}/accounting-export/file`)).status).toBe(200);
    expect(await db.refundBatchExport.count()).toBe(1);
  });
});

describe("a failed export copies no rate and writes no audit row (AC-5.6)", () => {
  const exportRouter = createExportRouter({ accounting: { begin: (name) => fake.begin(name) } });
  const copiedAudit = () => db.refundAuditEntry.count({ where: { action: "line_rate_copied" } });

  it("a failed log write after the copy rolls the copy and its audit row back: the line is still pending, and the retry copies it", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const batchId = await seedBatch([{ currency: "EUR" }, { currency: "EUR", date: "2026-03-09" }]);
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated export log failure'; END; $$`,
    );
    await db.$executeRawUnsafe(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON "refund_batch_export" FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}()`);

    const res = await call(exportRouter, `/batches/${batchId}/accounting-export/file`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/simulated|trigger|refund_line|UPDATE|prisma|MC26/i);
    expect(await db.refundLine.count({ where: { fxRateMicros: { not: null } } })).toBe(0);
    expect(await copiedAudit()).toBe(0);
    expect(await db.refundBatchExport.count()).toBe(0);

    await dropFailingTrigger();
    const ok = await call(exportRouter, `/batches/${batchId}/accounting-export/file`);
    expect(ok.status).toBe(200);
    expect(await db.refundLine.count({ where: { fxRateMicros: 924_600 } })).toBe(2);
    expect(await copiedAudit()).toBe(2);
    expect(await db.refundBatchExport.count()).toBe(1);
  });

  it("a copy the database refuses is a 500 with no file: the earlier copies of the same export are rolled back too", async () => {
    fake.setRate("EUR", "2026-03", 924_600);
    const batchId = await seedBatch([{ currency: "EUR", date: "2026-03-02" }, { currency: "EUR", date: "2026-03-09" }]);
    // Refuses the copy of the SECOND line only (the lines are copied in id order, so which is second is not known: refuse
    // when one copy already exists in this transaction).
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${COPY_TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
         IF NEW."fxRateMicros" IS NOT NULL AND OLD."fxRateMicros" IS NULL AND EXISTS (SELECT 1 FROM "refund_line" WHERE "fxRateMicros" IS NOT NULL) THEN
           RAISE EXCEPTION 'simulated copy failure';
         END IF;
         RETURN NEW;
       END; $$`,
    );
    await db.$executeRawUnsafe(`CREATE TRIGGER ${COPY_TRIGGER} BEFORE UPDATE ON "refund_line" FOR EACH ROW EXECUTE FUNCTION ${COPY_TRIGGER}()`);

    const res = await call(exportRouter, `/batches/${batchId}/accounting-export/file`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).not.toMatch(/simulated|trigger|refund_line|prisma/i);
    expect(await db.refundLine.count({ where: { fxRateMicros: { not: null } } })).toBe(0);
    expect(await copiedAudit()).toBe(0);
    expect(await db.refundBatchExport.count()).toBe(0);
  });
});

describe("CORS exposes the download headers (G9)", () => {
  // The REAL app's CORS layer is what is under test, so the app is loaded in a SUBPROCESS: importing `src/index.ts` here
  // would load every router of the service into THIS process's module cache bound to this file's mocked auth, and break
  // the test files that import those routers after it (testAuth.ts, "no shared router specifier"). The CORS layer runs
  // before every route, so none of them has to authenticate: a preflight, and a GET that is refused with 401.
  const ORIGIN = "http://localhost:5173";
  interface Seen {
    readonly status: number;
    readonly headers: Record<string, string>;
  }
  let seen: { preflight: Seen; get401: Seen; foreign: Seen };

  beforeAll(async () => {
    const entry = new URL("../index.ts", import.meta.url).pathname;
    const script = `
      const app = (await import(${JSON.stringify(entry)})).default;
      const grab = async (request) => {
        const res = await app.fetch(request);
        return { status: res.status, headers: Object.fromEntries(res.headers.entries()) };
      };
      const csv = "http://localhost/batches/b-1/accounting-export/file";
      const out = {
        preflight: await grab(new Request(csv, { method: "OPTIONS", headers: { Origin: ${JSON.stringify(ORIGIN)}, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } })),
        get401: await grab(new Request(csv, { headers: { Origin: ${JSON.stringify(ORIGIN)} } })),
        foreign: await grab(new Request("http://localhost/health", { headers: { Origin: "https://evil.example" } })),
      };
      console.log("@@RESULT@@" + JSON.stringify(out));
      process.exit(0);
    `;
    const dir = mkdtempSync(join(tmpdir(), "refund-cors-"));
    const file = join(dir, "cors-probe.ts");
    writeFileSync(file, script);
    try {
      const proc = Bun.spawn([process.execPath, "run", file], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env } as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      const line = stdout.split("\n").find((l) => l.startsWith("@@RESULT@@"));
      if (!line) throw new Error(`the app did not answer in the subprocess:\n${stdout}\n${stderr}`);
      seen = JSON.parse(line.slice("@@RESULT@@".length));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  const exposed = (res: Seen) =>
    (res.headers["access-control-expose-headers"] ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

  it("a preflight from an allowed origin carries Access-Control-Expose-Headers with Content-Disposition and X-Export-*", () => {
    expect(seen.preflight.status).toBe(204);
    expect(seen.preflight.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(exposed(seen.preflight)).toEqual(expect.arrayContaining(["content-disposition", "x-export-row-count", "x-export-excluded-line-count"]));
  });

  it("an actual GET from an allowed origin carries it too, whatever the status (here 401, no token)", () => {
    expect(seen.get401.status).toBe(401);
    expect(seen.get401.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(exposed(seen.get401)).toEqual(expect.arrayContaining(["content-disposition", "x-export-row-count", "x-export-excluded-line-count"]));
  });

  it("an origin that is not allowed is given no CORS access", () => {
    expect(seen.foreign.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    expect(seen.foreign.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("every header the file route sets for the file is in the exposed list, so one added later cannot stay unreadable", async () => {
    const batchId = await seedBatch([{}]);
    const exportRouter = createExportRouter({ accounting: { begin: (name) => fake.begin(name) } });
    const res = await call(exportRouter, `/batches/${batchId}/accounting-export/file`);
    expect(res.status).toBe(200);

    // CORS-safelisted response headers are readable anyway; every other header of the download must be exposed.
    const safelisted = new Set(["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]);
    const custom = [...res.headers.keys()].filter((name) => !safelisted.has(name.toLowerCase()));
    expect(custom).toContain("content-disposition");
    for (const name of custom) {
      // `x-content-type-options` is a directive to the browser, not data the page reads.
      if (name === "x-content-type-options") continue;
      expect(exposed(seen.preflight)).toContain(name.toLowerCase());
    }
  });
});

describe("Accounting that does not answer cannot hold the export (AC-6.8, D3), through the real client", () => {
  const tokens = { async getToken() { return "service-jwt"; }, invalidate() {} };
  const never = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const warnings: string[] = [];
  const realWarn = console.warn;
  beforeAll(() => {
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  });
  afterAll(() => {
    console.warn = realWarn;
  });

  it("a read that never returns ends at the deadline as the accountingUnavailable blocker: summary 200 and file 409 in about the deadline, no log row, no copy", async () => {
    const client = createAccountingClient({ baseUrl: "http://accounting.test", tokens, fetchImpl: ((_url: string, init?: RequestInit) => never(init)) as unknown as typeof fetch, deadlineMs: 300 });
    const router = createExportRouter({ accounting: client });
    const batchId = await seedBatch([{ currency: "EUR" }, { currency: "USD", date: "2026-02-10" }, {}]);

    const started = performance.now();
    const res = await call(router, `/batches/${batchId}/accounting-export`);
    const elapsed = performance.now() - started;
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
    expect(body).toMatchObject({ exportable: false, ratePendingLineCount: 2, fetchAttempted: false });
    expect(body["blockers"]).toMatchObject({ accountingUnavailable: true, missingRates: [] });

    const csv = await call(router, `/batches/${batchId}/accounting-export/file`);
    expect(csv.status).toBe(409);
    expect(await db.refundBatchExport.count()).toBe(0);
    expect(await db.refundLine.count({ where: { fxRateMicros: { not: null } } })).toBe(0);
    // The kind and the operation are logged, nothing else.
    expect(warnings.some((w) => w.includes('"operation":"export"') && w.includes('"kind":"timeout"'))).toBe(true);
    expect(warnings.join("\n")).not.toMatch(/accounting\.test|service-jwt|http/);
  });

  it("a real answer is read as the contract says: `attempted` makes fetchAttempted, `reason` the missing rate's reason, and the rate in effect is copied", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (url: string) => {
      requests.push(url);
      return Response.json({
        entity: "welld_ch",
        rates: [
          { currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 924_600, origin: "fetched", attempted: true },
          { currency: "USD", month: "2026-03", status: "missing", attempted: true, reason: "fetch_failed" },
        ],
      });
    }) as unknown as typeof fetch;
    const router = createExportRouter({ accounting: createAccountingClient({ baseUrl: "http://accounting.test", tokens, fetchImpl }) });

    const blockedBatch = await seedBatch([{ currency: "EUR" }, { currency: "USD" }]);
    const summary = (await (await call(router, `/batches/${blockedBatch}/accounting-export`)).json()) as Record<string, any>;
    expect(summary).toMatchObject({ exportable: false, fetchAttempted: true });
    expect(summary["blockers"]["missingRates"]).toEqual([{ currency: "USD", month: "2026-03", reason: "fetch_failed" }]);
    expect(requests).toEqual(["http://accounting.test/system/v1/entities/welld_ch/rates?pairs=EUR:2026-03,USD:2026-03"]);

    const okBatch = await seedBatch([{ currency: "EUR" }]);
    requests.length = 0;
    const answerEur = (): Response =>
      Response.json({ entity: "welld_ch", rates: [{ currency: "EUR", month: "2026-03", status: "in_effect", rateMicros: 924_600, origin: "fetched", attempted: true }] });
    const okRouter = createExportRouter({
      accounting: createAccountingClient({ baseUrl: "http://accounting.test", tokens, fetchImpl: (async () => answerEur()) as unknown as typeof fetch }),
    });
    const csv = await call(okRouter, `/batches/${okBatch}/accounting-export/file`);
    expect(csv.status).toBe(200);
    const rows = readWorkbook(new Uint8Array(await csv.arrayBuffer())).rows.map(cellValues);
    expect(rows[1]![1]).toContain("[EUR 20.80 = CHF 19.23]");
    expect(rows[1]![4]).toEqual({ n: "19.23" });
  });

  it("a rates answer that skips a pair, or answers one Refund did not ask, is 'cannot be read', never a missing rate or a guess", async () => {
    const wrong = (async () =>
      Response.json({ entity: "welld_ch", rates: [{ currency: "GBP", month: "2026-03", status: "in_effect", rateMicros: 1_063_500, origin: "fetched", attempted: false }] })) as unknown as typeof fetch;
    const router = createExportRouter({ accounting: createAccountingClient({ baseUrl: "http://accounting.test", tokens, fetchImpl: wrong }) });
    const batchId = await seedBatch([{ currency: "EUR" }]);
    const body = (await (await call(router, `/batches/${batchId}/accounting-export`)).json()) as Record<string, any>;
    expect(body["blockers"]).toMatchObject({ accountingUnavailable: true, missingRates: [] });
    expect(body["exportable"]).toBe(false);
  });
});
