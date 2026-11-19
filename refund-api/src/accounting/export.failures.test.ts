/**
 * How the accounting export fails (T19, specs/20261118-refund-accounting-export;
 * AC-6.5, AC-6.10; plan § Test strategy "Extra tests", rows 4 to 6; G6, G9; ADR
 * 20261118-the-accounting-export-is-generated-on-request-never-stored-and-logged-
 * append-only-with-its-content-hash-and-format-version).
 *
 *   1. A failed export-log write is a 500 Problem with NO file and NO log row:
 *      record, then deliver. The failure is a REAL one: a trigger on the table
 *      that raises on INSERT (created here, always dropped), so the whole path
 *      from the route to the database is the production one.
 *   2. CORS exposes `Content-Disposition` and `X-Export-*` (G9), from the real
 *      app's CORS layer, and every header the CSV route sets for the file is in
 *      that list, so a header added later cannot silently stay unreadable.
 *   3. The exchange-rate budget (G6, R10): a source that never answers cannot
 *      hold an export for more than about 10 s. The summary answers 200 with the
 *      missing months as blockers and one `failed`/`timeout` attempt per month; a
 *      second call right after is throttled and returns at once.
 *
 * Real Postgres, jwt/authz mocked, the rate source fake, no network.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolveResponse } from "../authz/resolveClient";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173,http://localhost:3000";
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

// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { createExportRouter } = (await import("./export.routes?failures")) as typeof import("./export.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { createFxService } = await import("../fx/fx.service");
const { FX_FETCH_BUDGET_MS } = await import("../fx/fx.service");

const NOW = new Date("2026-11-19T10:00:00.000Z");
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

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
let office: { id: string };
let novat: { id: string };
let imp81: { id: string };

const TRIGGER = "test_t19_fail_export_log";
const dropFailingTrigger = async () => {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON "refund_batch_export"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
};

beforeAll(dropFailingTrigger); // a crashed earlier run must not leave the table broken for the rest of the suite
beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
  harness.setResolve(async () => REVIEWER);
  office = await db.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Spese materiale ufficio", ...by } });
  imp81 = await db.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...by } });
  novat = await db.vatCode.create({ data: { entity: "welld_ch", code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, ...by } });
});
afterEach(dropFailingTrigger);
afterAll(async () => {
  await dropFailingTrigger();
  await truncateRefundTables();
});

async function seedBatch(lines: { currency?: "CHF" | "EUR"; date?: string }[]) {
  const batch = await db.refundBatch.create({
    data: { cutoff: new Date("2026-03-31T21:59:59.000Z"), status: "compiled", createdByUserId: "a", createdByEmail: "a@welld.ch", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
  });
  const request = await db.refundRequest.create({
    data: { ownerUserId: "u-1", ownerEmail: "u-1@welld.ch", ownerName: "Matteo Codogno", status: "approved", decidedAt: new Date("2026-03-20"), decidedByUserId: "a", decidedByEmail: "a@welld.ch", batchId: batch.id },
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
        ledgerAccountId: office.id,
        ledgerAccountIsDefault: true,
        vatCodeId: (spec.currency ?? "CHF") === "CHF" ? imp81.id : novat.id,
        vatCodeIsDefault: true,
        receiptNumber: `MC26/${String(i + 1).padStart(3, "0")}`,
        receiptOwnerUserId: "u-1",
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

describe("a failed export-log write is a 500 with no file and no row (AC-6.10)", () => {
  const exportRouter = createExportRouter({ fx: createFxService({ mode: "off" }) });

  async function breakTheLog() {
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated export log failure'; END; $$`,
    );
    await db.$executeRawUnsafe(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON "refund_batch_export" FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}()`);
  }

  it("answers 500 Problem JSON; no text/csv, no BOM, no header row, no filename, no X-Export-*; nothing is logged", async () => {
    const batchId = await seedBatch([{}, {}]);
    await breakTheLog();

    const res = await call(exportRouter, `/batches/${batchId}/accounting-export/csv`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("csv");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("x-export-row-count")).toBeNull();
    expect(res.headers.get("x-export-excluded-line-count")).toBeNull();
    expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(text).not.toContain("Receipt number");
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
    expect((await call(exportRouter, `/batches/${batchId}/accounting-export/csv`)).status).toBe(500);

    await dropFailingTrigger();
    const ok = await call(exportRouter, `/batches/${batchId}/accounting-export/csv`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await db.refundBatchExport.count()).toBe(1);
  });

  it("every failed attempt leaves no row, and a later success leaves exactly one: the log never counts a file that did not leave", async () => {
    const batchId = await seedBatch([{}]);
    await breakTheLog();
    for (let i = 0; i < 3; i++) expect((await call(exportRouter, `/batches/${batchId}/accounting-export/csv`)).status).toBe(500);
    expect(await db.refundBatchExport.count()).toBe(0);
    await dropFailingTrigger();
    expect((await call(exportRouter, `/batches/${batchId}/accounting-export/csv`)).status).toBe(200);
    expect(await db.refundBatchExport.count()).toBe(1);
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
      const csv = "http://localhost/batches/b-1/accounting-export/csv";
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

  it("every header the CSV route sets for the file is in the exposed list, so one added later cannot stay unreadable", async () => {
    const batchId = await seedBatch([{}]);
    const exportRouter = createExportRouter({ fx: createFxService({ mode: "off" }) });
    const res = await call(exportRouter, `/batches/${batchId}/accounting-export/csv`);
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

describe("a rate source that does not answer cannot hold the export (G6, R10)", () => {
  /** A source that answers each month after `delayMs`, unless it is aborted first (as `fetch` is). */
  function slowSource(delayMs: number) {
    const urls: string[] = [];
    const fetcher: NonNullable<Parameters<typeof createFxService>[0]["fetcher"]> = (url, init) => {
      urls.push(url);
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("<monatsmittelkurs/>")), delayMs);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    return { fetcher, urls };
  }

  const MONTHS = ["2026-01-15", "2026-02-15", "2026-03-15"];

  it(
    "3 months, each answering after 30 s: the summary comes back in under 11 s with the three months as missing rates and three failed/timeout attempts",
    async () => {
      const { fetcher, urls } = slowSource(30_000);
      const router = createExportRouter({ fx: createFxService({ mode: "bazg", fetcher, now: () => NOW }) });
      const batchId = await seedBatch(MONTHS.map((date) => ({ currency: "EUR" as const, date })));

      const started = performance.now();
      const res = await call(router, `/batches/${batchId}/accounting-export`);
      const elapsed = performance.now() - started;
      const body = (await res.json()) as Record<string, any>;

      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(11_000);
      expect(body).toMatchObject({ exportable: false, fetchAttempted: true });
      expect(body["blockers"]["missingRates"]).toEqual([
        { currency: "EUR", month: "2026-01" },
        { currency: "EUR", month: "2026-02" },
        { currency: "EUR", month: "2026-03" },
      ]);
      // The three months were asked in parallel, not one after the other.
      expect(urls).toHaveLength(3);

      const attempts = await db.exchangeRateFetchAttempt.findMany({ orderBy: { month: "asc" } });
      expect(attempts.map((a) => [a.month.toISOString().slice(0, 7), a.trigger, a.outcome, a.errorCode])).toEqual([
        ["2026-01", "export", "failed", "timeout"],
        ["2026-02", "export", "failed", "timeout"],
        ["2026-03", "export", "failed", "timeout"],
      ]);
      expect(await db.exchangeRateEntry.count()).toBe(0);

      // A second call right after is throttled (15 min per month): no new request, no new attempt, and no new wait.
      const again = performance.now();
      const second = await call(router, `/batches/${batchId}/accounting-export`);
      expect(second.status).toBe(200);
      expect(performance.now() - again).toBeLessThan(1_000);
      expect(urls).toHaveLength(3);
      expect(await db.exchangeRateFetchAttempt.count()).toBe(3);

      // And the CSV is refused with the blockers, in the same breath, with nothing logged.
      const csvStarted = performance.now();
      const csv = await call(router, `/batches/${batchId}/accounting-export/csv`);
      expect(csv.status).toBe(409);
      expect(performance.now() - csvStarted).toBeLessThan(1_000);
      expect(await db.refundBatchExport.count()).toBe(0);
    },
    25_000,
  );

  it(
    "the 10 s TOTAL budget is what bounds it when each call is allowed longer (per-call timeout 60 s)",
    async () => {
      const { fetcher } = slowSource(30_000);
      const router = createExportRouter({
        fx: createFxService({ mode: "bazg", fetcher, now: () => NOW, callTimeoutMs: 60_000 }),
      });
      const batchId = await seedBatch(MONTHS.map((date) => ({ currency: "EUR" as const, date })));

      const started = performance.now();
      const res = await call(router, `/batches/${batchId}/accounting-export`);
      const elapsed = performance.now() - started;
      const body = (await res.json()) as Record<string, any>;

      expect(FX_FETCH_BUDGET_MS).toBe(10_000);
      expect(res.status).toBe(200);
      // The budget, not the calls, ended it: about 10 s, never the 30 s the source would have taken.
      expect(elapsed).toBeGreaterThanOrEqual(9_000);
      expect(elapsed).toBeLessThan(11_000);
      expect(body["blockers"]["missingRates"]).toHaveLength(3);
      const attempts = await db.exchangeRateFetchAttempt.findMany();
      expect(attempts).toHaveLength(3);
      expect(attempts.every((a) => a.outcome === "failed" && a.errorCode === "timeout")).toBe(true);
    },
    25_000,
  );

  it("a rate that DID arrive within the budget is kept, and only the slow months are blockers", async () => {
    const urls: string[] = [];
    const fetcher: NonNullable<Parameters<typeof createFxService>[0]["fetcher"]> = (url, init) => {
      urls.push(url);
      const month = `${/j=(\d{4})/.exec(url)![1]}-${/m=(\d{2})/.exec(url)![1]}`;
      if (month === "2026-03") {
        return Promise.resolve(
          new Response(`<?xml version="1.0"?><monatsmittelkurs><monat>2026-03</monat>
            <devise code="eur"><waehrung>1 EUR</waehrung><kurs>0.9246</kurs></devise>
            <devise code="usd"><waehrung>1 USD</waehrung><kurs>0.7808</kurs></devise>
            <devise code="gbp"><waehrung>1 GBP</waehrung><kurs>1.0635</kurs></devise></monatsmittelkurs>`),
        );
      }
      return new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    };
    const router = createExportRouter({ fx: createFxService({ mode: "bazg", fetcher, now: () => NOW, budgetMs: 300, callTimeoutMs: 5_000 }) });
    const batchId = await seedBatch([{ currency: "EUR", date: "2026-03-15" }, { currency: "EUR", date: "2026-02-15" }]);

    const res = await call(router, `/batches/${batchId}/accounting-export`);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body["blockers"]["missingRates"]).toEqual([{ currency: "EUR", month: "2026-02" }]);
    expect((await db.exchangeRateEntry.findMany({ where: { currency: "EUR" } })).map((r) => r.rateMicros)).toEqual([924_600]);
  });
});
