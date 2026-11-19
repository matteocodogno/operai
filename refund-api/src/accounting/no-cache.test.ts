/**
 * Refund keeps no copy of Accounting between operations (T25, specs/20261119-accounting; AC-4.8, AC-6.1, AC-6.5, AC-5.4; plan §
 * "How Refund reads Accounting" row "Freshness" and D2; plan § Test strategy row AC-4.8: "a test asserts each listed operation
 * performs a fresh read (call counter), so no cache exists to outlive 60 s").
 *
 * AC-4.8: a change saved in Accounting at T is offered and used by anything Refund starts after T + 60 seconds. Refund meets it
 * with no margin to spend, because it has no cache: every operation reads live. These tests make that a property of the code
 * rather than of its comments, by COUNTING the reads the REAL client (`createAccountingClient`, real wire schemas) makes of a
 * local peer (an injected `fetch` answering from memory; no socket) while the routes and the release script run for real:
 *
 *   1. for each operation (options, view, classify, approve, settings read, settings write, export, release), two runs with a
 *      change in Accounting between them make exactly twice the reads of one run, and the second run reflects the change at
 *      once (not after 60 seconds, not after a restart);
 *   2. within one operation the answer is shared (one snapshot, the operation agrees with itself), across operations nothing
 *      is: two requests in flight at the same time read twice, and a clock moved forward or back changes nothing;
 *   3. nothing is served after a failure: a read that worked a moment ago is not a reason to answer when the next one does not
 *      (never "last-known data"), and the first read after the outage is live again;
 *   4. the port itself holds no data.
 *
 * Real Postgres, jwt/authz mocked. A count is a RAW call of the peer, which is what a real HTTP request would be.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
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

// A query suffix gives each router a module instance of this file alone (testAuth.ts, "no shared router specifier").
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("../review/decide.routes?no-cache")) as typeof import("../review/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?no-cache")) as typeof import("./classification.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { defaultsRouter } = (await import("./defaults.routes?no-cache")) as typeof import("./defaults.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { createExportRouter } = (await import("./export.routes?no-cache")) as typeof import("./export.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { createAccountingClient } = await import("./accountingClient");
const { restoreAccounting, useFakeAccounting } = await import("../test-support/fakeAccounting");
const { runAccountingRelease } = await import("../../scripts/accounting-release");
const { notifyTransport } = await import("../lib/notifyPost");

const exportRouter = createExportRouter();

const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 200 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

// ─── The peer ────────────────────────────────────────────────────────────────

/** Accounting's data as the test changes it, and what was asked of it. */
const accounting = {
  down: false,
  accounts: new Map<string, { name: string; active: boolean }>(),
  vatCodes: new Map<string, { label: string; rateBasisPoints: number; active: boolean }>(),
  /** `EUR:2026-03` → in effect; a pair absent here is not published. */
  rates: new Map<string, { rateMicros: number; origin: "fetched" | "corrected" }>(),
  /** The raw requests, in order. */
  requests: [] as { kind: "reference" | "rates"; pairs: string[] }[],
  /** An optional hold on every answer, to keep two operations in flight at once. */
  gate: null as Promise<void> | null,
  reset() {
    this.down = false;
    this.gate = null;
    this.requests = [];
    this.accounts = new Map([
      ["5901", { name: "Treno", active: true }],
      ["6101", { name: "Ufficio", active: true }],
    ]);
    this.vatCodes = new Map([
      ["IMP81", { label: "IVA 8.1%", rateBasisPoints: 810, active: true }],
      ["NOVAT", { label: "Senza IVA", rateBasisPoints: 0, active: true }],
    ]);
    this.rates = new Map([["EUR:2026-03", { rateMicros: 924_600, origin: "fetched" }]]);
  },
  get reads() {
    return {
      reference: this.requests.filter((r) => r.kind === "reference").length,
      rates: this.requests.filter((r) => r.kind === "rates").length,
    };
  },
};

const peerFetch = (async (input: unknown): Promise<Response> => {
  const url = new URL(String(input));
  const isRates = url.pathname.endsWith("/rates");
  const pairs = (url.searchParams.get("pairs") ?? "").split(",").filter(Boolean);
  accounting.requests.push({ kind: isRates ? "rates" : "reference", pairs });
  // The answer is built when the request ARRIVES (what Accounting held then); a hold only delays its delivery.
  const response = accounting.down
    ? new Response("down", { status: 503 })
    : isRates
      ? Response.json({
          entity: "welld_ch",
          rates: pairs.map((pair) => {
            const [currency, month] = pair.split(":");
            const found = accounting.rates.get(pair);
            return found
              ? { currency, month, status: "in_effect", rateMicros: found.rateMicros, origin: found.origin, attempted: false }
              : { currency, month, status: "missing", attempted: false, reason: "not_published" };
          }),
        })
      : Response.json({
          entity: "welld_ch",
          ownCurrency: "CHF",
          ledgerAccounts: [...accounting.accounts].map(([number, a]) => ({ number, ...a })),
          vatCodes: [...accounting.vatCodes].map(([code, v]) => ({ code, ...v })),
        });
  if (accounting.gate) await accounting.gate;
  return response;
}) as unknown as typeof fetch;

const port = createAccountingClient({
  baseUrl: "http://accounting.test:8089",
  fetchImpl: peerFetch,
  tokens: { async getToken() { return "svc-token"; }, invalidate() {} },
  deadlineMs: 2_000,
});

/** Runs `fn` and returns what it asked of Accounting. */
async function measured<T>(fn: () => Promise<T>): Promise<{ value: T; reference: number; rates: number; pairs: string[][] }> {
  accounting.requests = [];
  const value = await fn();
  return {
    value,
    ...accounting.reads,
    pairs: accounting.requests.filter((r) => r.kind === "rates").map((r) => r.pairs),
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

const OPERATOR: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "set-approved-total", conditions: null },
    { resource: "request", action: "approve", conditions: null },
    { resource: "request", action: "reclassify", conditions: null },
    { resource: "settings", action: "read", conditions: null },
    { resource: "settings", action: "manage", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

type Router = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
interface Out {
  status: number;
  body: any;
  headers: Headers;
  /** The raw body: the export file is a workbook, not text. */
  bytes: Uint8Array;
}
async function call(router: Router, method: string, path: string, body?: unknown): Promise<Out> {
  __resetAuthzCacheForTests();
  harness.setResolve(async () => OPERATOR);
  const token = await harness.signToken({ sub: "acct-1", email: "acct-1@welld.ch" });
  const res = await router.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* a workbook, or no body */
  }
  return { status: res.status, body: parsed, headers: res.headers, bytes };
}

const by = { createdByUserId: "admin", createdByEmail: "admin@welld.ch" };
const recordDefault = (type: string, account: [string, string] | null) =>
  db.expenseTypeAccountingDefault.create({
    data: {
      entity: "welld_ch",
      type: type as never,
      ...(account ? { accountNumber: account[0], accountName: account[1] } : {}),
      ...by,
    },
  });
const TRAIN: [string, string] = ["5901", "Treno"];
async function seedDefaults() {
  await recordDefault("travel_train", TRAIN);
  await recordDefault("office_material", ["6101", "Ufficio"]);
}

let warn: ReturnType<typeof spyOn>;
beforeEach(async () => {
  accounting.reset();
  useFakeAccounting(port);
  await truncateRefundTables();
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  setSystemTime(); // a test that moved the clock never leaves it moved
  warn.mockRestore();
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

let seq = 0;
interface LineSpec {
  date?: string;
  type?: "travel_train" | "office_material" | "stationery";
  currency?: "CHF" | "EUR" | "USD";
  stored?: Record<string, unknown>;
}
async function createRequest(lines: LineSpec[], opts: { status?: "submitted" | "approved"; batchId?: string } = {}) {
  const owner = `owner-${++seq}`;
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: owner,
      ownerEmail: `${owner}@welld.ch`,
      ownerName: "Matteo Codogno",
      status: opts.status ?? "submitted",
      submittedAt: new Date(),
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
    },
  });
  const ids: string[] = [];
  for (const [i, spec] of lines.entries()) {
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date(spec.date ?? "2026-03-02"),
        type: spec.type ?? "travel_train",
        motivo: "m",
        entity: "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: 2080,
        approvedTotalCents: opts.status === "approved" ? 2080 : null,
        createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, i)),
        ...(spec.stored ?? {}),
      },
    });
    ids.push(line.id);
  }
  return { id: request.id, lineIds: ids };
}
const lineOf = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });
const approve = (id: string) => call(decideRouter, "POST", `/review/requests/${id}/approve`);
const classify = (id: string, lineId: string, body: unknown) =>
  call(classificationRouter, "PUT", `/review/requests/${id}/lines/${lineId}/classification`, body);
const view = (id: string) => call(classificationRouter, "GET", `/review/requests/${id}/accounting`);
const options = () => call(classificationRouter, "GET", "/accounting/options");

// ═════════════════════════════════════════════════════════════════════════════

describe("each listed operation reads Accounting afresh (AC-4.8, D2)", () => {
  it("options: two calls are two reads, and the second shows what changed in between, at once", async () => {
    const first = await measured(options);
    expect(first.value.body.ledgerAccounts.map((a: any) => a.number)).toEqual(["5901", "6101"]);
    expect([first.reference, first.rates]).toEqual([1, 0]);

    accounting.accounts.get("6101")!.active = false; // deactivated in Accounting at T
    accounting.accounts.set("7777", { name: "Nuovo", active: true }); // added at T
    const second = await measured(options); // started right after T: no 60-second margin is used
    expect(second.value.body.ledgerAccounts.map((a: any) => a.number)).toEqual(["5901", "7777"]);
    expect([second.reference, second.rates]).toEqual([1, 0]);

    accounting.accounts.get("6101")!.active = true; // reactivated at T'
    const third = await measured(options);
    expect(third.value.body.ledgerAccounts.map((a: any) => a.number)).toEqual(["5901", "6101", "7777"]);
    expect(third.reference).toBe(1);
  });

  it("view: the live default's state follows Accounting between two views; each view is one read of the reference data", async () => {
    await seedDefaults();
    const r = await createRequest([{ type: "travel_train" }]);
    const first = await measured(() => view(r.id));
    expect(first.value.body.lines[0].classification.account).toEqual({ number: "5901", name: "Treno", state: "active" });
    expect([first.reference, first.rates]).toEqual([1, 0]);

    accounting.accounts.get("5901")!.active = false;
    const second = await measured(() => view(r.id));
    expect(second.value.body.lines[0].classification.account).toEqual({ number: "5901", name: "Treno", state: "deactivated" });
    expect([second.reference, second.rates]).toEqual([1, 0]);

    accounting.accounts.delete("5901"); // entered again later: for now it is not there
    const third = await measured(() => view(r.id));
    expect(third.value.body.lines[0].classification.account.state).toBe("not_found");
  });

  it("view: a rate corrected in Accounting is the rate the next view shows, one rates read per view", async () => {
    await seedDefaults();
    const r = await createRequest([{ type: "office_material", currency: "EUR", date: "2026-03-03" }]);
    const first = await measured(() => view(r.id));
    expect(first.value.body.lines[0].chf).toMatchObject({ rateMicros: 924_600, rateStatus: "in_effect" });
    expect([first.reference, first.rates]).toEqual([1, 1]);
    accounting.rates.set("EUR:2026-03", { rateMicros: 930_000, origin: "corrected" });
    const second = await measured(() => view(r.id));
    expect(second.value.body.lines[0].chf).toMatchObject({ rateMicros: 930_000, rateStatus: "in_effect" });
    expect([second.reference, second.rates]).toEqual([1, 1]);
  });

  it("classify: an entry deactivated at T is refused by the next PUT, and offered again the moment it is reactivated", async () => {
    const r = await createRequest([{}, {}, {}]);
    const first = await measured(() => classify(r.id, r.lineIds[0]!, { accountNumber: "6101" }));
    expect(first.value.status).toBe(200);
    expect([first.reference, first.rates]).toEqual([1, 0]); // the answer's view re-uses the operation's snapshot: no second read

    accounting.accounts.get("6101")!.active = false;
    const second = await measured(() => classify(r.id, r.lineIds[1]!, { accountNumber: "6101" }));
    expect(second.value.status).toBe(422);
    expect(second.value.body.code).toBe("ledger_account_inactive");
    expect(second.reference).toBe(1);
    expect((await lineOf(r.lineIds[1]!)).accountNumber).toBeNull();

    accounting.accounts.get("6101")!.active = true;
    const third = await measured(() => classify(r.id, r.lineIds[1]!, { accountNumber: "6101" }));
    expect(third.value.status).toBe(200);
    expect(third.reference).toBe(1);
    // A name changed in Accounting is the name the next classification copies (AC-5.2: "at that moment").
    accounting.accounts.set("6101", { name: "Ufficio (nuovo nome)", active: true });
    expect((await classify(r.id, r.lineIds[2]!, { accountNumber: "6101" })).status).toBe(200);
    expect((await lineOf(r.lineIds[2]!)).accountName).toBe("Ufficio (nuovo nome)");
    expect((await lineOf(r.lineIds[0]!)).accountName).toBe("Ufficio"); // the earlier copy is what it was
  });

  it("approve: each approval reads once (the reference data, and the rates in one call) and books what Accounting holds NOW", async () => {
    await seedDefaults();
    const lines: LineSpec[] = [
      { type: "travel_train", date: "2026-03-01" },
      { type: "office_material", currency: "EUR", date: "2026-03-03" },
      { type: "office_material", currency: "EUR", date: "2026-03-20" }, // the same month: the same pair, asked once
    ];
    const a = await createRequest(lines);
    const first = await measured(() => approve(a.id));
    expect(first.value.status).toBe(200);
    expect([first.reference, first.rates]).toEqual([1, 1]);
    expect(first.pairs).toEqual([["EUR:2026-03"]]);
    expect(await lineOf(a.lineIds[0]!)).toMatchObject({ accountNumber: "5901", accountName: "Treno" });
    expect((await lineOf(a.lineIds[1]!)).fxRateMicros).toBe(924_600);

    // The entry is renamed and the rate corrected in Accounting at T; the next approval started afterwards uses both.
    accounting.accounts.set("5901", { name: "Treno e bus", active: true });
    accounting.rates.set("EUR:2026-03", { rateMicros: 930_000, origin: "corrected" });
    const b = await createRequest(lines);
    const second = await measured(() => approve(b.id));
    expect(second.value.status).toBe(200);
    expect([second.reference, second.rates]).toEqual([1, 1]);
    expect(await lineOf(b.lineIds[0]!)).toMatchObject({ accountNumber: "5901", accountName: "Treno e bus" });
    expect((await lineOf(b.lineIds[1]!)).fxRateMicros).toBe(930_000);
    // ...and what the first approval booked is still what it booked (AC-5.3).
    expect(await lineOf(a.lineIds[0]!)).toMatchObject({ accountName: "Treno" });
    expect((await lineOf(a.lineIds[1]!)).fxRateMicros).toBe(924_600);

    // The default's entry is deactivated at T: the approval started after it is refused for the lines it leaves unclassified.
    accounting.accounts.get("5901")!.active = false;
    const c = await createRequest([{ type: "travel_train" }]);
    const third = await measured(() => approve(c.id));
    expect(third.value.status).toBe(409);
    expect(third.value.body.code).toBe("classification_missing");
    expect(third.reference).toBe(1);
  });

  it("settings read and write: a default is checked against Accounting at the moment of the request", async () => {
    await recordDefault("travel_train", TRAIN);
    const read1 = await measured(() => call(defaultsRouter, "GET", "/accounting/expense-type-defaults"));
    expect(read1.value.body.types.find((t: any) => t.type === "travel_train").account.state).toBe("active");
    expect([read1.reference, read1.rates]).toEqual([1, 0]);
    accounting.accounts.get("5901")!.active = false;
    const read2 = await measured(() => call(defaultsRouter, "GET", "/accounting/expense-type-defaults"));
    expect(read2.value.body.types.find((t: any) => t.type === "travel_train").account.state).toBe("deactivated");
    expect(read2.reference).toBe(1);

    const put = (account: string) => call(defaultsRouter, "PUT", "/accounting/expense-type-defaults/postal", { accountNumber: account });
    const w1 = await measured(() => put("7777"));
    expect(w1.value.status).toBe(422);
    expect(w1.value.body.code).toBe("ledger_account_not_found");
    expect(w1.reference).toBe(1);
    accounting.accounts.set("7777", { name: "Nuovo", active: true }); // entered at T
    const w2 = await measured(() => put("7777"));
    expect(w2.value.status).toBe(200);
    expect(w2.value.body.account).toEqual({ number: "7777", name: "Nuovo", state: "active" });
    expect(w2.reference).toBe(1);
    accounting.accounts.get("7777")!.active = false; // and deactivated again at T'
    const stale = await put("7777"); // the value is the current default, but its entry is deactivated NOW: checked live, refused
    expect(stale.status).toBe(422);
    expect(stale.body.code).toBe("ledger_account_inactive");
  });

  it("export: a rate published after a refusal is copied by the next export, and a batch holding its copies makes no read at all", async () => {
    const batch = await db.refundBatch.create({
      data: { cutoff: new Date("2026-04-30"), status: "compiled", createdByUserId: "a", createdByEmail: "a@x", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
    });
    const owner = "exp-1";
    const request = await db.refundRequest.create({
      data: { ownerUserId: owner, ownerEmail: "exp-1@welld.ch", ownerName: "Matteo Codogno", status: "approved", decidedAt: new Date("2026-04-20"), decidedByUserId: "a", decidedByEmail: "a@welld.ch", batchId: batch.id },
    });
    const line = await db.refundLine.create({
      data: {
        requestId: request.id,
        date: new Date("2026-04-02"),
        type: "office_material",
        motivo: "Cancelleria",
        entity: "welld_ch",
        currency: "EUR",
        requestedAmountCents: 2080,
        approvedTotalCents: 2080,
        accountNumber: "6101",
        accountName: "Ufficio",
        ledgerAccountIsDefault: true,
        vatCodeCopy: "NOVAT",
        vatRateBasisPoints: 0,
        vatCodeIsDefault: true,
        receiptNumber: "MC26/001",
        receiptOwnerUserId: owner,
        receiptYear: 2026,
        receiptSeq: 1,
        numberedAt: new Date(),
      },
    });
    await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });

    const summaryPath = `/batches/${batch.id}/accounting-export`;
    const blocked = await measured(() => call(exportRouter, "GET", summaryPath));
    expect(blocked.value.body.blockers.missingRates).toEqual([{ currency: "EUR", month: "2026-04", reason: "not_published" }]);
    expect([blocked.reference, blocked.rates]).toEqual([0, 1]); // the export asks for rates only, and only for what waits for one
    expect((await measured(() => call(exportRouter, "GET", `${summaryPath}/file`))).value.status).toBe(409);
    expect((await lineOf(line.id)).fxRateMicros).toBeNull();

    accounting.rates.set("EUR:2026-04", { rateMicros: 910_000, origin: "fetched" }); // published at T
    const first = await measured(() => call(exportRouter, "GET", `${summaryPath}/file`));
    expect(first.value.status).toBe(200);
    expect([first.reference, first.rates]).toEqual([0, 1]);
    expect((await lineOf(line.id)).fxRateMicros).toBe(910_000);

    // From now on the line holds its copy: corrected in Accounting at T', the file does not change, and nothing is read.
    accounting.rates.set("EUR:2026-04", { rateMicros: 950_000, origin: "corrected" });
    const second = await measured(() => call(exportRouter, "GET", `${summaryPath}/file`));
    expect(second.value.status).toBe(200);
    expect([second.reference, second.rates]).toEqual([0, 0]);
    expect(Buffer.from(second.value.bytes).equals(Buffer.from(first.value.bytes))).toBe(true);
    expect((await measured(() => call(exportRouter, "GET", summaryPath))).rates).toBe(0);
  });

  it("release: two runs are two reads, and an entry deactivated between them is not seeded by the second", async () => {
    await truncateRefundTables({ released: false });
    const defaults = { typeDefaults: { travel_train: { ledgerAccount: "5901" } } };
    const run = () => runAccountingRelease({ accounting: port, defaults, dryRun: true, offsets: [] });

    const first = await measured(run);
    expect(first.value.seeded.typeDefaults).toEqual(["travel_train"]);
    expect([first.reference, first.rates]).toEqual([1, 0]);

    accounting.accounts.get("5901")!.active = false;
    const second = await measured(run);
    // The account is no longer offered: it is not seeded and the report says so.
    expect(first.value.seeded.warnings).toEqual([]);
    expect(second.value.seeded.warnings.join(" ")).toContain("account 5901 is deactivated in Accounting, no default account seeded");
    expect([second.reference, second.rates]).toEqual([1, 0]);
    expect(await db.expenseTypeAccountingDefault.count()).toBe(0); // dry runs write nothing
  });
});

describe("within one operation the answer is shared, across operations nothing is", () => {
  it("two operations in flight at the same time read twice: no single flight, no shared answer between requests", async () => {
    let release!: () => void;
    accounting.gate = new Promise<void>((resolve) => (release = resolve));
    const both = Promise.all([options(), options()]);
    // Both requests have asked Accounting (and are held) before either is answered.
    for (let i = 0; i < 200 && accounting.reads.reference < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(accounting.reads.reference).toBe(2);
    release();
    const [a, b] = await both;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(accounting.reads.reference).toBe(2);
  });

  it("an operation answered after a change at T has the data of its own read; one started after T has the new data", async () => {
    let release!: () => void;
    accounting.gate = new Promise<void>((resolve) => (release = resolve));
    const held = options(); // asked before the change, answered after it
    for (let i = 0; i < 200 && accounting.reads.reference < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(accounting.reads.reference).toBe(1);
    accounting.accounts.set("7777", { name: "Nuovo", active: true }); // saved in Accounting at T
    accounting.gate = null;
    const later = await options(); // started after T
    release();
    const heldBody = await held;
    expect(heldBody.body.ledgerAccounts.map((a: any) => a.number)).toEqual(["5901", "6101"]);
    expect(later.body.ledgerAccounts.map((a: any) => a.number)).toEqual(["5901", "6101", "7777"]);
  });

  it("classify makes one read of the reference data though it checks the entry, writes, and then builds the line's view", async () => {
    const r = await createRequest([{}]);
    const out = await measured(() => classify(r.id, r.lineIds[0]!, { accountNumber: "6101", vatCode: "NOVAT" }));
    expect(out.value.status).toBe(200);
    expect([out.reference, out.rates]).toEqual([1, 0]);
  });

  it("a PUT that changes nothing needs no check of the entry; only the answer's view reads, and it reads once", async () => {
    const r = await createRequest([{ stored: { accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false } }]);
    const out = await measured(() => classify(r.id, r.lineIds[0]!, { accountNumber: "6101" }));
    expect(out.value.status).toBe(200);
    expect([out.reference, out.rates]).toEqual([1, 0]);
  });

  it("the clock does not matter: 59 s, 61 s, a day later, or an hour earlier, each operation still reads live", async () => {
    const realNow = Date.now();
    let expected = 0;
    for (const [label, offsetMs] of [["+0", 0], ["+59 s", 59_000], ["+61 s", 61_000], ["+1 day", 86_400_000], ["-1 hour", -3_600_000]] as const) {
      setSystemTime(new Date(realNow + offsetMs));
      accounting.accounts.set("7777", { name: `Nuovo ${label}`, active: true });
      const out = await options();
      expect(out.status).toBe(200);
      expect(out.body.ledgerAccounts.find((a: any) => a.number === "7777").name).toBe(`Nuovo ${label}`);
      expect(accounting.reads.reference).toBe(++expected);
    }
  });
});

describe("nothing is served after a failure (AC-6.1, AC-6.5; non-goal: approving from last-known data)", () => {
  it("options: a read that worked a moment ago is no reason to answer when Accounting is down, and the first read after is live", async () => {
    expect((await options()).status).toBe(200);
    accounting.down = true;
    const down = await options();
    expect(down.status).toBe(503);
    expect(down.body.code).toBe("accounting_unavailable");
    expect(JSON.stringify(down.body)).not.toContain("5901"); // none of the last-known list
    accounting.down = false;
    accounting.accounts.set("7777", { name: "Nuovo", active: true }); // changed during the outage
    const back = await options();
    expect(back.status).toBe(200);
    expect(back.body.ledgerAccounts.map((a: any) => a.number)).toContain("7777");
  });

  it("approve: Accounting read cleanly a moment ago, down now: refused, nothing booked; back: approved with what it holds then", async () => {
    await seedDefaults();
    const warmUp = await createRequest([{ type: "travel_train" }]);
    expect((await approve(warmUp.id)).status).toBe(200);

    accounting.down = true;
    const r = await createRequest([{ type: "travel_train" }]);
    const refused = await approve(r.id);
    expect(refused.status).toBe(503);
    expect(await db.receiptCounter.count()).toBe(1); // the warm-up's owner only: the refused request consumed no number
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: null, vatCodeCopy: null, receiptNumber: null });
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("submitted");

    accounting.down = false;
    accounting.accounts.set("5901", { name: "Treno (dopo l'interruzione)", active: true });
    expect((await approve(r.id)).status).toBe(200);
    expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountName: "Treno (dopo l'interruzione)" });
  });

  it("view: down after a good read shows the lines as stored and every entry unverified, never the earlier states", async () => {
    await seedDefaults();
    const r = await createRequest([{ type: "travel_train" }]);
    expect((await view(r.id)).body.lines[0].classification.account.state).toBe("active");
    accounting.down = true;
    const out = await view(r.id);
    expect(out.status).toBe(200);
    expect(out.body.accounting).toBe("unavailable");
    expect(out.body.lines[0].classification.account).toEqual({ number: "5901", name: "Treno", state: "unverified" });
  });

  it("settings write: down after a good read is a 503 and writes nothing, even for an entry that was valid a moment ago", async () => {
    const put = () => call(defaultsRouter, "PUT", "/accounting/expense-type-defaults/postal", { accountNumber: "6101" });
    expect((await call(defaultsRouter, "PUT", "/accounting/expense-type-defaults/stationery", { accountNumber: "6101" })).status).toBe(200);
    accounting.down = true;
    const out = await put();
    expect(out.status).toBe(503);
    expect(await db.expenseTypeAccountingDefault.count({ where: { type: "postal" } })).toBe(0);
  });

  it("a failed read is not remembered: the same operation, repeated after each outcome, reads each time", async () => {
    const outcomes: number[] = [];
    for (const down of [false, true, true, false, true, false]) {
      accounting.down = down;
      outcomes.push((await options()).status);
    }
    expect(outcomes).toEqual([200, 503, 503, 200, 503, 200]);
    expect(accounting.reads.reference).toBe(6);
  });
});

describe("the port holds no data", () => {
  it("is nothing but `begin`, and an operation is a fresh object that shares nothing with the one before", async () => {
    expect(Object.keys(port)).toEqual(["begin"]);
    const one = port.begin("options");
    const two = port.begin("options");
    expect(one).not.toBe(two);
    expect(await one.referenceData()).toEqual(await two.referenceData());
    expect(accounting.reads.reference).toBe(2); // equal answers, two reads
    // an operation that is never asked makes no call
    accounting.requests = [];
    port.begin("view");
    expect(accounting.requests).toEqual([]);
  });

  it("no operation outlives its caller: the data the first operation read is not what the second returns after a change", async () => {
    const one = port.begin("view");
    const before = await one.referenceData();
    accounting.accounts.set("6101", { name: "Cambiato", active: false });
    const stillOne = await one.referenceData(); // the same operation agrees with itself
    const two = await port.begin("view").referenceData(); // a new one does not
    expect(stillOne).toBe(before);
    expect(two.ledgerAccounts.find((a) => a.number === "6101")).toEqual({ number: "6101", name: "Cambiato", active: false });
  });
});
