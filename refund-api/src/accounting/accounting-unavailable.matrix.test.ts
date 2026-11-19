/**
 * The refusal matrix: every way Accounting can be "unavailable" through every Refund operation that reads it (T25,
 * specs/20261119-accounting; US-6; AC-6.1 to AC-6.6, AC-6.8 to AC-6.10, AC-5.4, AC-7.4; plan § Test strategy rows AC-6.8 and
 * AC-6.10: "a parameterised int-R test runs one failure kind through approve, classify, view, options, settings write,
 * export and release").
 *
 * WHAT IS REAL. The `AccountingPort` is the REAL client (`createAccountingClient`) with its real wire schemas, deadline, 401
 * re-mint, redirect and body-cap rules, talking to a local PEER: an injected `fetch` that answers from memory, can fail in each of
 * the eleven ways of `ACCOUNTING_FAILURE_KINDS` (a never-answering peer for `timeout`, a throwing `fetch` for `network`, a 401
 * twice for `unauthorized`, a 302, an HTML page, a body over 256 KiB, an extra member, another entity, a missing pair, a failing
 * token mint) and whose every failure BODY is hostile: it carries a URL, a private host, a stack frame, a cuid and a marker
 * string, so that a refusal that echoed anything of the peer would show. No socket is opened; the routes, the database (real
 * Postgres) and the release script are production code.
 *
 * THE MATRIX. Each row is one operation with its own scenario and its own healthy outcome (the control: a row that did not
 * succeed when Accounting is readable would prove nothing when it fails). For each of the eleven kinds, the row is run with that
 * failure and must give the outcome the spec fixes for it, leave the database as it was, log the kind and the operation name and
 * nothing else, leak nothing of the peer, and then, once the peer is back, succeed on the very same call (AC-6.2: it "can be
 * approved later"). `pair_mismatch` is a failure of the RATES answer only, so the rows that never read rates (options, classify,
 * settings, the approved view) are correctly NOT refused by it: they must give their healthy outcome, which is asserted too.
 *
 * Around the matrix: AC-6.4 (an approval that needs no Accounting makes no call, whatever its state), AC-6.3 against AC-6.1 (a
 * line with no default while Accounting is down is a 503, never a 409 that would blame the admin), AC-5.4 and AC-6.6 (an export
 * built from copies, and paying and discarding a batch, do not depend on Accounting), and AC-6.10 over every refusal body.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { truncateRefundTables } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";
import { readWorkbook } from "../test-support/xlsxReader";

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

// A query suffix makes each router a module instance of this file alone: the jwt/authz mocks of `setupTestAuth` are bound per
// file, and a router shared with another test file would answer with that file's harness (testAuth.ts, "no shared router specifier").
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { decideRouter } = (await import("../review/decide.routes?unavailable-matrix")) as typeof import("../review/decide.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { classificationRouter } = (await import("./classification.routes?unavailable-matrix")) as typeof import("./classification.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { defaultsRouter } = (await import("./defaults.routes?unavailable-matrix")) as typeof import("./defaults.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { createExportRouter } = (await import("./export.routes?unavailable-matrix")) as typeof import("./export.routes");
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { requestsRouter } = (await import("../requests/requests.routes?unavailable-matrix")) as typeof import("../requests/requests.routes");
const { db } = await import("../lib/db");
const exportRouter = createExportRouter();
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { ACCOUNTING_FAILURE_KINDS, AccountingUnavailableError, createAccountingClient } = await import("./accountingClient");
const { restoreAccounting, useFakeAccounting } = await import("../test-support/fakeAccounting");
const { runAccountingRelease } = await import("../../scripts/accounting-release");
const { isAccountingReleased } = await import("./release");
const { markBatchPaid, discardBatch } = await import("../batches/decide.repo");
const { notifyTransport } = await import("../lib/notifyPost");
const { Effect } = await import("effect");
type AccountingFailureKind = (typeof ACCOUNTING_FAILURE_KINDS)[number];
type AccountingOperationName = import("./accountingClient").AccountingOperationName;

// The decision notification goes to notify-api: answered here, never sent (as approve-accounting.test.ts).
const realTokens = notifyTransport.tokens;
notifyTransport.tokens = { async getToken() { return "stub-service-jwt"; }, invalidate() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url === "string" && url.includes("/system/")) return new Response(JSON.stringify({ id: "n1" }), { status: 200 });
  return originalFetch(url, init);
}) as unknown as typeof fetch;

// ─── The peer: Accounting as a stub `fetch` ──────────────────────────────────

const BASE = "http://accounting.internal.test:8089";
const LEAK = "LEAK-7f3a9c";
/** What a hostile or broken peer says in its failure bodies: nothing of it may reach a caller or a log. */
const HOSTILE = `Error: boom at Object.<anonymous> (/app/src/system/reader.ts:12:7) ${BASE}/system/v1/entities/welld_ch cabcdefghijklmnopqrstuvwx ${LEAK}`;
const LEAKS = [LEAK, "accounting.internal.test", "reader.ts", "10.0.0.7", "ECONNREFUSED", "Object.<anonymous>", "cabcdefghijklmnopqrstuvwx"];
/** AC-6.10: a refusal carries no address, identifier or internal error text. */
const NO_INTERNALS = /https?:\/\/(?!httpstatuses\.com)|localhost|railway|\bc[a-z0-9]{24}\b|\bat .*\(/;

type Mode = "ok" | AccountingFailureKind;
const peer = {
  mode: "ok" as Mode,
  calls: [] as { path: string; authorization: string | null }[],
  reset() {
    this.mode = "ok";
    this.calls = [];
  },
};

const REFERENCE = (entity: "welld_ch" | "welld_it" = "welld_ch") => ({
  entity,
  ownCurrency: entity === "welld_ch" ? "CHF" : "EUR",
  ledgerAccounts: [
    { number: "5901", name: "Treno", active: true },
    { number: "6101", name: "Ufficio", active: true },
  ],
  vatCodes: [
    { code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, active: true },
    { code: "NOVAT", label: "Senza IVA", rateBasisPoints: 0, active: true },
  ],
});
/** Only EUR in March 2026 has a rate in effect; every other month is not published. */
const RATES = (pairs: string[], entity: "welld_ch" | "welld_it" = "welld_ch") => ({
  entity,
  rates: pairs.map((pair) => {
    const [currency, month] = pair.split(":");
    return pair === "EUR:2026-03"
      ? { currency, month, status: "in_effect", rateMicros: 924_600, origin: "fetched", attempted: false }
      : { currency, month, status: "missing", attempted: false, reason: "not_published" };
  }),
});

const peerFetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  peer.calls.push({ path: url.pathname + url.search, authorization: new Headers(init?.headers).get("authorization") });
  const isRates = url.pathname.endsWith("/rates");
  const pairs = (url.searchParams.get("pairs") ?? "").split(",").filter(Boolean);
  const healthy = (extra: Record<string, unknown> = {}, entity: "welld_ch" | "welld_it" = "welld_ch") =>
    Response.json({ ...(isRates ? RATES(pairs, entity) : REFERENCE(entity)), ...extra });
  switch (peer.mode) {
    case "ok":
      return healthy();
    case "timeout":
      return new Promise<Response>(() => undefined); // never answers, and ignores the abort signal
    case "network":
      throw new TypeError(`fetch failed: connect ECONNREFUSED 10.0.0.7:8089 ${LEAK}`);
    case "http_status":
      return new Response(HOSTILE, { status: 500, statusText: LEAK });
    case "unauthorized":
      return new Response(HOSTILE, { status: 401 });
    case "redirect":
      return new Response(null, { status: 302, headers: { Location: `http://evil.example/${LEAK}` } });
    case "not_json":
      return new Response(`<html>${HOSTILE}</html>`, { headers: { "Content-Type": "text/html" } });
    case "too_large":
      return new Response(JSON.stringify({ pad: "x".repeat(300 * 1024), note: HOSTILE }));
    case "schema":
      return healthy({ extra: HOSTILE });
    case "entity_mismatch":
      return healthy({}, "welld_it");
    case "pair_mismatch":
      // The reference data is fine; the rates answer names a pair nobody asked for, and only one.
      return isRates
        ? Response.json({ entity: "welld_ch", rates: [{ currency: "GBP", month: "2031-01", status: "missing", attempted: false, reason: "not_published" }] })
        : healthy();
    case "token":
      return healthy(); // never reached: the token mint fails first
  }
}) as unknown as typeof fetch;

const peerTokens = {
  async getToken(): Promise<string> {
    if (peer.mode === "token") throw new Error(`auth is down at http://auth.internal.test:3001 ${HOSTILE}`);
    return "svc-token";
  },
  invalidate(): void {},
};

const DEADLINE_MS = 200;
const port = createAccountingClient({ baseUrl: BASE, fetchImpl: peerFetch, tokens: peerTokens, deadlineMs: DEADLINE_MS });

// ─── Harness ─────────────────────────────────────────────────────────────────

const OPERATOR: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "set-approved-total", conditions: null },
    { resource: "request", action: "approve", conditions: null },
    { resource: "request", action: "reject", conditions: null },
    { resource: "request", action: "reclassify", conditions: null },
    { resource: "settings", action: "read", conditions: null },
    { resource: "settings", action: "manage", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

interface Out {
  status: number;
  body: any;
  headers: Headers;
  /** The raw body: the export file is a workbook, not text. */
  bytes?: Uint8Array;
  error?: unknown;
}

type Router = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

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
const OFFICE: [string, string] = ["6101", "Ufficio"];

async function seedDefaults() {
  await recordDefault("travel_train", TRAIN);
  await recordDefault("office_material", OFFICE);
}

let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;
beforeEach(async () => {
  peer.reset();
  useFakeAccounting(port);
  await truncateRefundTables();
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
  error = spyOn(console, "error").mockImplementation(() => undefined);
  log = spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  log.mockRestore();
});
afterAll(async () => {
  restoreAccounting();
  await truncateRefundTables();
  notifyTransport.tokens = realTokens;
  globalThis.fetch = originalFetch;
});

interface LineSpec {
  date?: string;
  type?: "travel_train" | "office_material" | "stationery" | "postal";
  entity?: "welld_ch" | "welld_it";
  currency?: "CHF" | "EUR" | "USD" | "GBP";
  requestedAmountCents?: number;
  rejected?: boolean;
  stored?: Record<string, unknown>;
}

let seq = 0;
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
        entity: spec.entity ?? "welld_ch",
        currency: spec.currency ?? "CHF",
        requestedAmountCents: spec.requestedAmountCents ?? 2080,
        approvedTotalCents: opts.status === "approved" ? (spec.requestedAmountCents ?? 2080) : null,
        createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, i)),
        ...(spec.rejected ? { rejectionReason: "no", rejectedAt: new Date(), rejectedByUserId: "a", rejectedByEmail: "a@x", approvedTotalCents: 0 } : {}),
        ...(spec.stored ?? {}),
      },
    });
    ids.push(line.id);
  }
  return { id: request.id, lineIds: ids, owner };
}

const lineOf = (id: string) => db.refundLine.findUniqueOrThrow({ where: { id } });
const batchOf = () =>
  db.refundBatch.create({
    data: { cutoff: new Date("2026-03-31"), status: "compiled", createdByUserId: "a", createdByEmail: "a@x", pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf` },
  });
const TRAIN_COPY = { accountNumber: "5901", accountName: "Treno", ledgerAccountIsDefault: true, vatCodeCopy: "IMP81", vatRateBasisPoints: 810, vatCodeIsDefault: false };

// ─── The rows ────────────────────────────────────────────────────────────────

interface Row {
  label: string;
  /** The operation name the client logs with a failure. */
  operation: AccountingOperationName;
  /** `false`: the row reads reference data only, so a failure of the rates answer alone does not touch it. */
  readsRates: boolean;
  arrange(): Promise<any>;
  act(ctx: any): Promise<Out>;
  /** Accounting readable (or a failure that does not concern this row): the row's normal outcome. */
  healthy(ctx: any, out: Out): Promise<void>;
  /** Accounting unreachable: the outcome the spec fixes, and nothing changed. */
  refused(ctx: any, out: Out, kind: AccountingFailureKind): Promise<void>;
}

const expect503 = (out: Out) => {
  expect(out.status).toBe(503);
  expect(out.body.code).toBe("accounting_unavailable");
  expect(out.body.status).toBe(503);
  expect(out.headers.get("retry-after")).toBe("30");
  expect(out.body.detail).toBe("Accounting's reference data cannot be read right now. Nothing was saved. Try again in a few minutes.");
};

const rows: Row[] = [
  {
    label: "approve (AC-6.1, AC-6.2)",
    operation: "approve",
    readsRates: true,
    async arrange() {
      await seedDefaults();
      return createRequest([
        // classified by hand earlier: even so, the approval still reads Accounting (AC-6.1)
        { date: "2026-03-01", type: "travel_train", stored: { accountNumber: "6101", accountName: "Ufficio (as copied)", ledgerAccountIsDefault: false } },
        { date: "2026-03-03", type: "office_material", currency: "EUR", requestedAmountCents: 1040 },
        { date: "2026-03-04", type: "postal", entity: "welld_it", currency: "EUR" },
      ]);
    },
    act: (r) => call(decideRouter, "POST", `/review/requests/${r.id}/approve`),
    async healthy(r, out) {
      expect(out.status).toBe(200);
      const [hand, eur, it] = await Promise.all(r.lineIds.map(lineOf));
      expect(hand).toMatchObject({ accountNumber: "6101", accountName: "Ufficio (as copied)", vatCodeCopy: null, receiptNumber: "MC26/001" });
      expect(eur).toMatchObject({ accountNumber: "6101", vatCodeCopy: null, fxRateMicros: 924_600, receiptNumber: "MC26/002" });
      expect(it!.receiptNumber).toBe("MC26/003");
      expect(it!.accountNumber).toBeNull();
    },
    async refused(r, out) {
      expect503(out);
      // AC-6.2: the request stays as it was: no number consumed, no copy, no decision, no audit entry.
      const request = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } });
      expect(request).toMatchObject({ status: "submitted", decidedAt: null, decidedByUserId: null });
      expect(await db.receiptCounter.count()).toBe(0);
      expect(await db.refundAuditEntry.count()).toBe(0);
      const [hand, eur, it] = await Promise.all(r.lineIds.map(lineOf));
      expect(hand).toMatchObject({ accountNumber: "6101", accountName: "Ufficio (as copied)", vatCodeCopy: null, vatRateBasisPoints: null, receiptNumber: null });
      expect([eur!.accountNumber, eur!.vatCodeCopy, eur!.fxRateMicros, eur!.fxRateMonth, eur!.receiptNumber]).toEqual([null, null, null, null, null]);
      expect([it!.receiptNumber, it!.approvedTotalCents]).toEqual([null, null]);
    },
  },
  {
    label: "classify, under review (AC-6.5)",
    operation: "classify",
    readsRates: false,
    async arrange() {
      await seedDefaults();
      return createRequest([{ type: "travel_train" }]);
    },
    act: (r) => call(classificationRouter, "PUT", `/review/requests/${r.id}/lines/${r.lineIds[0]}/classification`, { accountNumber: "6101" }),
    async healthy(r, out) {
      expect(out.status).toBe(200);
      expect(out.body.classification.account).toMatchObject({ number: "6101", name: "Ufficio", state: "active" });
      expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false });
      expect(await db.refundAuditEntry.count({ where: { action: "line_classified" } })).toBe(1);
    },
    async refused(r, out) {
      expect503(out);
      const line = await lineOf(r.lineIds[0]!);
      expect([line.accountNumber, line.accountName, line.ledgerAccountIsDefault, line.vatCodeCopy]).toEqual([null, null, null, null]);
      expect(await db.refundAuditEntry.count()).toBe(0);
    },
  },
  {
    label: "reclassify, approved in an unpaid batch (AC-6.5)",
    operation: "classify",
    readsRates: false,
    async arrange() {
      const batch = await batchOf();
      return createRequest([{ type: "travel_train", stored: TRAIN_COPY }], { status: "approved", batchId: batch.id });
    },
    act: (r) => call(classificationRouter, "PUT", `/review/requests/${r.id}/lines/${r.lineIds[0]}/classification`, { vatCode: "NOVAT" }),
    async healthy(r, out) {
      expect(out.status).toBe(200);
      expect(await lineOf(r.lineIds[0]!)).toMatchObject({ accountNumber: "5901", accountName: "Treno", vatCodeCopy: "NOVAT", vatRateBasisPoints: 0, vatCodeIsDefault: false });
    },
    async refused(r, out) {
      expect503(out);
      expect(await lineOf(r.lineIds[0]!)).toMatchObject({ ...TRAIN_COPY });
      expect(await db.refundAuditEntry.count()).toBe(0);
    },
  },
  {
    label: "view, under review, with a foreign-currency line (AC-6.5, AC-6.8)",
    operation: "view",
    readsRates: true,
    async arrange() {
      await seedDefaults();
      return createRequest([
        { date: "2026-03-01", type: "travel_train", stored: { accountNumber: "6101", accountName: "Ufficio", ledgerAccountIsDefault: false } },
        { date: "2026-03-03", type: "office_material", currency: "EUR", requestedAmountCents: 1040 },
      ]);
    },
    act: (r) => call(classificationRouter, "GET", `/review/requests/${r.id}/accounting`),
    async healthy(_r, out) {
      expect(out.status).toBe(200);
      expect(out.body.accounting).toBe("available");
      expect(out.body.lines[0].classification.account).toEqual({ number: "6101", name: "Ufficio", state: "active" });
      expect(out.body.lines[1].chf).toMatchObject({ rateStatus: "in_effect", rateMicros: 924_600 });
    },
    async refused(_r, out, kind) {
      // The view still answers, with what the lines hold, no options and a note (AC-6.5): never a 5xx. An entry's state is
      // Accounting's when the reference data was read (only the rates failed), else it is unverified.
      expect(out.status).toBe(200);
      expect(out.body.accounting).toBe("unavailable");
      expect(out.body.lines[0].classification.account).toEqual({ number: "6101", name: "Ufficio", state: kind === "pair_mismatch" ? "active" : "unverified" });
      expect(out.body.lines[1].chf).toMatchObject({ amountCents: null, rateMicros: null, rateStatus: "unavailable" });
      expect(out.body.lines[1].vatAmountCents).toBeNull();
      expect(JSON.stringify(out.body)).not.toMatch(/ledgerAccounts|vatCodes|options/);
    },
  },
  {
    label: "view, approved in an unpaid batch, one line rate pending (AC-6.5)",
    operation: "view",
    readsRates: false,
    async arrange() {
      const batch = await batchOf();
      return createRequest(
        [
          { type: "travel_train", stored: TRAIN_COPY },
          { type: "office_material", currency: "EUR", date: "2026-03-03", requestedAmountCents: 1040, stored: { ...TRAIN_COPY, accountNumber: "6101", accountName: "Ufficio", vatCodeCopy: "NOVAT", vatRateBasisPoints: 0 } },
        ],
        { status: "approved", batchId: batch.id },
      );
    },
    act: (r) => call(classificationRouter, "GET", `/review/requests/${r.id}/accounting`),
    async healthy(_r, out) {
      expect(out.status).toBe(200);
      expect(out.body.accounting).toBe("available");
      expect(out.body.lines[0].classification.account.state).toBe("active");
      expect(out.body.lines[1].chf).toMatchObject({ amountCents: null, rateStatus: "pending" });
    },
    async refused(_r, out) {
      expect(out.status).toBe(200);
      expect(out.body.accounting).toBe("unavailable");
      // What the line holds is shown as booked, unverified; a pending rate stays pending (never 0, never a guess).
      expect(out.body.lines[0].classification.account).toEqual({ number: "5901", name: "Treno", state: "unverified" });
      expect(out.body.lines[1].chf).toMatchObject({ amountCents: null, rateStatus: "pending" });
    },
  },
  {
    label: "options (AC-6.5, AC-6.9)",
    operation: "options",
    readsRates: false,
    arrange: async () => ({}),
    act: () => call(classificationRouter, "GET", "/accounting/options"),
    async healthy(_r, out) {
      expect(out.status).toBe(200);
      expect(out.body.ledgerAccounts.map((a: any) => a.number)).toEqual(["5901", "6101"]);
      expect(out.body.vatCodes.map((v: any) => v.code)).toEqual(["IMP81", "NOVAT"]);
    },
    async refused(_r, out) {
      expect503(out);
      // No stale list, no empty list that reads as "nothing to choose": no list at all.
      expect(Object.keys(out.body).sort()).toEqual(["code", "detail", "instance", "status", "title", "type"]);
    },
  },
  {
    label: "settings read (AC-6.9)",
    operation: "defaults_read",
    readsRates: false,
    async arrange() {
      await recordDefault("travel_train", TRAIN);
      return {};
    },
    act: () => call(defaultsRouter, "GET", "/accounting/expense-type-defaults"),
    async healthy(_r, out) {
      expect(out.status).toBe(200);
      expect(out.body.accounting).toBe("available");
      expect(out.body.types.find((t: any) => t.type === "travel_train").account).toEqual({ number: "5901", name: "Treno", state: "active" });
      expect(Object.keys(out.body).sort()).toEqual(["accounting", "entity", "types"]); // no designation, no VAT
    },
    async refused(_r, out) {
      // The page opens, shows each default account as recorded, and offers no new choice.
      expect(out.status).toBe(200);
      expect(out.body.accounting).toBe("unavailable");
      expect(out.body.types).toHaveLength(14);
      const train = out.body.types.find((t: any) => t.type === "travel_train");
      expect(train.account).toEqual({ number: "5901", name: "Treno", state: "unverified" });
      for (const t of out.body.types.filter((t: any) => t.type !== "travel_train")) expect(t.account).toBeNull();
      expect(JSON.stringify(out.body)).not.toMatch(/options|ledgerAccounts"/);
    },
  },
  {
    label: "settings write, a type's default (AC-6.9)",
    operation: "defaults_write",
    readsRates: false,
    arrange: async () => ({ before: await db.expenseTypeAccountingDefault.count() }),
    act: () => call(defaultsRouter, "PUT", "/accounting/expense-type-defaults/stationery", { accountNumber: "6101" }),
    async healthy(ctx, out) {
      expect(out.status).toBe(200);
      expect(out.body.account).toEqual({ number: "6101", name: "Ufficio", state: "active" });
      expect(await db.expenseTypeAccountingDefault.count()).toBe(ctx.before + 1);
    },
    async refused(ctx, out) {
      expect503(out);
      expect(await db.expenseTypeAccountingDefault.count()).toBe(ctx.before);
    },
  },
  {
    label: "export summary, a line waiting for its rate (AC-6.6)",
    operation: "export",
    readsRates: true,
    arrange: () => seedExportBatch(),
    act: (b) => call(exportRouter, "GET", `/batches/${b.id}/accounting-export`),
    async healthy(_b, out) {
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ exportable: true, ratePendingLineCount: 1 });
      expect(out.body.blockers).toEqual({ missingRates: [], unclassifiedLines: [], unnumberedLines: [], accountingUnavailable: false });
    },
    async refused(_b, out) {
      // "Cannot be read", never "missing rate" (AC-6.6).
      expect(out.status).toBe(200);
      expect(out.body.exportable).toBe(false);
      expect(out.body.blockers).toEqual({ missingRates: [], unclassifiedLines: [], unnumberedLines: [], accountingUnavailable: true });
    },
  },
  {
    label: "export file, a line waiting for its rate (AC-6.6, AC-5.6)",
    operation: "export",
    readsRates: true,
    arrange: () => seedExportBatch(),
    act: (b) => call(exportRouter, "GET", `/batches/${b.id}/accounting-export/file`),
    async healthy(b, out) {
      expect(out.status).toBe(200);
      expect(out.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(readWorkbook(out.bytes!).rows).toHaveLength(3); // the header and the two lines of the batch
      expect(await db.refundBatchExport.count()).toBe(1);
      expect((await lineOf(b.pendingLineId)).fxRateMicros).toBe(924_600);
      expect(await db.refundAuditEntry.count({ where: { action: "line_rate_copied" } })).toBe(1);
    },
    async refused(b, out) {
      expect(out.status).toBe(409);
      expect(out.headers.get("content-type")).toContain("application/json");
      expect(out.body.code).toBe("accounting_export_blocked");
      expect(out.body.blockers).toEqual({ missingRates: [], unclassifiedLines: [], unnumberedLines: [], accountingUnavailable: true });
      // No file, no export log entry, no copy and no audit row of a copy.
      expect(out.headers.get("content-disposition")).toBeNull();
      expect(await db.refundBatchExport.count()).toBe(0);
      expect(await lineOf(b.pendingLineId)).toMatchObject({ fxRateMicros: null, fxRateMonth: null, fxRateCopiedAt: null });
      expect(await db.refundAuditEntry.count()).toBe(0);
    },
  },
  {
    label: "release (AC-7.4)",
    operation: "release",
    readsRates: true,
    async arrange() {
      await truncateRefundTables({ released: false });
      // A legacy approved request: a CHF line and an EUR line, neither numbered nor classified.
      const request = await createRequest(
        [
          { date: "2026-03-01", type: "travel_train" },
          { date: "2026-03-03", type: "travel_train", currency: "EUR", requestedAmountCents: 1040 },
        ],
        { status: "approved" },
      );
      return { request, before: await releaseFootprint() };
    },
    async act() {
      try {
        const report = await runAccountingRelease({
          accounting: port,
          defaults: { typeDefaults: { travel_train: { ledgerAccount: "5901" } } },
          offsets: [], // the explicit empty list of hand-issued numbers (T63: the list is required)
          now: () => new Date("2026-11-20T08:00:00.000Z"),
        });
        return { status: 0, body: report, headers: new Headers() };
      } catch (caught) {
        return { status: 0, body: null, headers: new Headers(), error: caught };
      }
    },
    async healthy(ctx, out) {
      expect(out.error).toBeUndefined();
      expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(true);
      const [chf, eur] = await Promise.all(ctx.request.lineIds.map(lineOf));
      expect(chf).toMatchObject({ accountNumber: "5901", vatCodeCopy: null });
      expect(eur).toMatchObject({ accountNumber: "5901", fxRateMicros: 924_600, vatCodeCopy: null });
      expect([chf!.receiptNumber, eur!.receiptNumber].every((n) => n !== null)).toBe(true);
    },
    async refused(ctx, out, kind) {
      // The run ends with the typed error (the CLI maps it to exit 2) and has written nothing: no number, copy, default,
      // counter, audit row or marker. Running it again later is safe.
      expect(out.error).toBeInstanceOf(AccountingUnavailableError);
      expect((out.error as InstanceType<typeof AccountingUnavailableError>).kind).toBe(kind);
      expect((out.error as Error).message).toBe("Accounting cannot be read");
      expect(await releaseFootprint()).toEqual(ctx.before);
      expect(await db.$transaction((tx) => isAccountingReleased(tx))).toBe(false);
    },
  },
];

async function releaseFootprint() {
  return {
    typeDefaults: await db.expenseTypeAccountingDefault.count(),
    settings: await db.refundSetting.count(),
    counters: await db.receiptCounter.count(),
    audit: await db.refundAuditEntry.count(),
    lines: JSON.stringify(await db.refundLine.findMany({ orderBy: { id: "asc" } })),
  };
}

/** A compiled batch of one CHF line holding its copies and one EUR line waiting for its rate (March 2026, which has a rate). */
async function seedExportBatch(opts: { pendingLine?: boolean; month?: string } = {}) {
  const batch = await batchOf();
  const owner = `exp-${++seq}`;
  const request = await db.refundRequest.create({
    data: { ownerUserId: owner, ownerEmail: `${owner}@welld.ch`, ownerName: "Matteo Codogno", status: "approved", decidedAt: new Date("2026-03-20"), decidedByUserId: "a", decidedByEmail: "a@welld.ch", batchId: batch.id },
  });
  const make = async (i: number, currency: "CHF" | "EUR", fx: boolean) =>
    (
      await db.refundLine.create({
        data: {
          requestId: request.id,
          date: new Date(`${opts.month ?? "2026-03"}-02`),
          type: "office_material",
          motivo: "Cancelleria",
          entity: "welld_ch",
          currency,
          requestedAmountCents: 2080,
          approvedTotalCents: 2080,
          createdAt: new Date(Date.UTC(2026, 2, 5, 10, 0, i)),
          accountNumber: "6101",
          accountName: "Ufficio",
          ledgerAccountIsDefault: true,
          vatCodeCopy: currency === "CHF" ? "IMP81" : "NOVAT",
          vatRateBasisPoints: currency === "CHF" ? 810 : 0,
          vatCodeIsDefault: true,
          ...(fx ? { fxRateMicros: 930_000, fxRateMonth: new Date(`${opts.month ?? "2026-03"}-01T00:00:00.000Z`), fxRateCopiedAt: new Date("2026-03-21") } : {}),
          receiptNumber: `MC26/${String(i + 1).padStart(3, "0")}`,
          receiptOwnerUserId: owner,
          receiptYear: 2026,
          receiptSeq: i + 1,
          numberedAt: new Date(),
        },
      })
    ).id;
  await make(0, "CHF", false);
  const pendingLineId = await make(1, "EUR", opts.pendingLine === false);
  await db.refundBatchItem.create({ data: { batchId: batch.id, requestId: request.id } });
  return { id: batch.id, pendingLineId };
}

// ─── The matrix ──────────────────────────────────────────────────────────────

/** Every line the client logged about Accounting being unreadable: exactly `{event, operation, kind}`, nothing of the peer. */
const unavailableLogs = () =>
  warn.mock.calls
    .map((args: unknown[]) => String(args[0]))
    .filter((line: string) => line.includes("refund.accounting_unavailable"))
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);

const everythingLogged = () => [warn, error, log].flatMap((spy) => spy.mock.calls.map((args: unknown[]) => args.map(String).join(" "))).join("\n");

/** AC-6.10 over one refusal: the message names the cause and carries no address, identifier or internal error text. */
function expectNoLeak(out: Out, forbidden: string[] = []) {
  const text = JSON.stringify(out.body ?? null) + String((out.error as Error | undefined)?.message ?? "") + [...out.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  for (const leak of [...LEAKS, ...forbidden]) expect(text).not.toContain(leak);
  if (out.body && typeof out.body === "object" && out.status !== 200) {
    // The message members, whatever the status; `instance` may be the route pattern or the caller's own path, never a peer's.
    for (const member of ["type", "title", "detail", "code"]) expect(String(out.body[member] ?? "")).not.toMatch(NO_INTERNALS);
    expect(String(out.body.instance ?? "")).not.toMatch(/https?:|localhost|railway/);
  }
}

describe("every failure kind through every operation that reads Accounting", () => {
  for (const row of rows) {
    describe(row.label, () => {
      it("control: with Accounting readable the row's normal outcome holds, with its own reads and no failure logged", async () => {
        const ctx = await row.arrange();
        const out = await row.act(ctx);
        await row.healthy(ctx, out);
        expect(unavailableLogs()).toEqual([]);
        expect(peer.calls.length).toBeGreaterThan(0);
        for (const c of peer.calls) {
          expect(c.authorization).toBe("Bearer svc-token"); // the service token, never a user's
          expect(c.path.startsWith("/system/v1/entities/welld_ch/")).toBe(true); // WellD CH's data only
        }
      });

      for (const kind of ACCOUNTING_FAILURE_KINDS) {
        const concerns = kind !== "pair_mismatch" || row.readsRates;
        it(`${kind}: ${concerns ? "refused as the spec says, nothing changed, then it works once Accounting is back" : "a rates-only failure does not touch a row that reads no rates"}`, async () => {
          const ctx = await row.arrange();
          peer.mode = kind;
          const started = Date.now();
          const out = await row.act(ctx);
          if (kind === "timeout") expect(Date.now() - started).toBeLessThan(DEADLINE_MS * 10);

          if (!concerns) {
            await row.healthy(ctx, out);
            expect(unavailableLogs()).toEqual([]);
            return;
          }
          await row.refused(ctx, out, kind);

          // AC-6.10: nothing of the peer reaches the caller or any log.
          expectNoLeak(out);
          expect(everythingLogged()).not.toContain(LEAK);
          for (const leak of LEAKS) expect(everythingLogged()).not.toContain(leak);
          // The kind and the operation are logged, and nothing else (no body, URL, token or status text).
          const logs = unavailableLogs();
          expect(logs.length).toBeGreaterThan(0);
          for (const entry of logs) expect(entry).toEqual({ event: "refund.accounting_unavailable", operation: row.operation, kind });

          // AC-6.2 and AC-6.8: the failure was not remembered. The same call, with Accounting back, succeeds.
          peer.mode = "ok";
          warn.mockClear();
          const again = await row.act(ctx);
          await row.healthy(ctx, again);
          expect(unavailableLogs()).toEqual([]);
        });
      }
    });
  }
});

// ─── AC-6.4: an approval that does not need Accounting does not call it ──────

describe("approval without a WellD CH line to book never depends on Accounting (AC-6.4)", () => {
  for (const kind of ACCOUNTING_FAILURE_KINDS) {
    it(`${kind}: a WellD Italia-only request, and one whose CH lines are all rejected, approve with no call`, async () => {
      const it1 = await createRequest([{ entity: "welld_it", currency: "EUR", type: "postal" }]);
      const rejectedOnly = await createRequest([{ rejected: true }, { entity: "welld_it", currency: "EUR", type: "postal" }]);
      peer.mode = kind;
      for (const r of [it1, rejectedOnly]) {
        const out = await call(decideRouter, "POST", `/review/requests/${r.id}/approve`);
        expect(out.status).toBe(200);
        expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("approved");
      }
      expect(peer.calls).toEqual([]);
      expect(unavailableLogs()).toEqual([]);
      // IT lines are numbered and never classified (AC-4.9).
      const line = await lineOf(it1.lineIds[0]!);
      expect(line.receiptNumber).not.toBeNull();
      expect([line.accountNumber, line.vatCodeCopy]).toEqual([null, null]);
    });
  }
});

describe("Accounting down outranks a missing default (AC-6.3, AC-6.1)", () => {
  for (const kind of ACCOUNTING_FAILURE_KINDS) {
    it(`${kind}: a CH line with no default is a 503 while Accounting cannot be read, and the 409 naming it once it can`, async () => {
      await seedDefaults(); // `stationery` has none
      const r = await createRequest([{ type: "stationery" }]);
      peer.mode = kind;
      const down = await call(decideRouter, "POST", `/review/requests/${r.id}/approve`);
      if (kind === "pair_mismatch") {
        // No foreign-currency line: no rates are read, so Accounting is readable and the refusal is the admin's to fix.
        expect(down.status).toBe(409);
        expect(down.body.code).toBe("classification_missing");
        return;
      }
      expect503(down);
      expectNoLeak(down);
      peer.mode = "ok";
      const up = await call(decideRouter, "POST", `/review/requests/${r.id}/approve`);
      expect(up.status).toBe(409);
      expect(up.body.code).toBe("classification_missing");
      expect(up.body.lines).toHaveLength(1);
      expect(up.body.lines[0].missing).toEqual(["account"]);
      // AC-6.10: the message names the cause with no internals (the lines are named by id, as the contract says).
      expect(String(up.body.detail)).not.toMatch(NO_INTERNALS);
      expect(await db.receiptCounter.count()).toBe(0);
    });
  }
});

// ─── AC-5.4, AC-6.6: what does not depend on Accounting ──────────────────────

describe("what is built from copies, or is not accounting at all, does not depend on Accounting (AC-5.4, AC-6.6)", () => {
  it("an export whose lines all hold their copies is the same file under every failure kind, with no call", async () => {
    const b = await seedExportBatch({ pendingLine: false });
    const files: Uint8Array[] = [];
    for (const kind of ACCOUNTING_FAILURE_KINDS) {
      peer.mode = kind;
      const summary = await call(exportRouter, "GET", `/batches/${b.id}/accounting-export`);
      expect(summary.status).toBe(200);
      expect(summary.body.exportable).toBe(true);
      expect(summary.body.blockers.accountingUnavailable).toBe(false);
      const csv = await call(exportRouter, "GET", `/batches/${b.id}/accounting-export/file`);
      expect(csv.status).toBe(200);
      files.push(csv.bytes!);
    }
    expect(peer.calls).toEqual([]);
    expect(new Set(files.map((f) => Buffer.from(f).toString("base64"))).size).toBe(1); // byte for byte: AC-5.4 "two exports of the same batch are identical"
    expect(await db.refundBatchExport.count()).toBe(ACCOUNTING_FAILURE_KINDS.length);
  });

  it("an export that waits for a rate is refused for the cause, and paying and discarding that batch are not affected", async () => {
    peer.mode = "http_status";
    const b = await seedExportBatch();
    const csv = await call(exportRouter, "GET", `/batches/${b.id}/accounting-export/file`);
    expect(csv.status).toBe(409);
    expect(csv.body.blockers.accountingUnavailable).toBe(true);
    expect(csv.body.blockers.missingRates).toEqual([]);
    expect(await db.refundBatchExport.count()).toBe(0);

    const calls = peer.calls.length;
    const paid = await Effect.runPromise(markBatchPaid(b.id, "acct-1", "acct-1@welld.ch"));
    expect(paid).toBeDefined();
    expect((await db.refundBatch.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("paid");

    const other = await seedExportBatch();
    await Effect.runPromise(discardBatch(other.id, "acct-1", "acct-1@welld.ch"));
    expect((await db.refundBatch.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("discarded");
    expect(peer.calls.length).toBe(calls); // neither read Accounting
  });

  it("a paid batch's lines are never classified or read again: the view of a paid request makes no call (AC-4.9 spirit)", async () => {
    const batch = await batchOf();
    await db.refundBatch.update({ where: { id: batch.id }, data: { status: "paid" } });
    const r = await createRequest([{ type: "travel_train", stored: TRAIN_COPY }], { status: "approved", batchId: batch.id });
    await db.refundRequest.update({ where: { id: r.id }, data: { status: "paid" } });
    peer.mode = "http_status";
    const out = await call(classificationRouter, "GET", `/review/requests/${r.id}/accounting`);
    expect(out.status).toBe(200);
    expect(out.body.classificationState).toBe("locked");
    expect(peer.calls).toEqual([]);
  });
});

// ─── AC-7.1, AC-7.2: nothing changes for the employee ────────────────────────

describe("the employee's own request is the same, and shows no accounting, while Accounting is down (AC-7.1, AC-7.2, AC-3.10 of 20261118)", () => {
  /** The exact key set of a line in `GET /requests/{id}`: a new key is a deliberate change of this list. */
  const LINE_KEYS = ["approvedTotalCents", "attachments", "currency", "date", "entity", "id", "km", "mileage", "motivo", "receiptNumber", "rejection", "requestedAmountCents", "type"];
  const EMPLOYEE: ResolveResponse = {
    sub: "",
    epoch: 1,
    permissions: [
      { resource: "refund", action: "access", conditions: null },
      { resource: "request", action: "create", conditions: null },
      { resource: "request", action: "read", conditions: { ownership: "own" } },
    ],
    entity: "welld_it",
    jobTitle: null,
  };

  for (const kind of ACCOUNTING_FAILURE_KINDS) {
    it(`${kind}: the owner reads an approved request with its receipt number and no account, VAT code, rate or CHF figure, with no call to Accounting`, async () => {
      const r = await createRequest(
        [
          { type: "travel_train", stored: TRAIN_COPY },
          { type: "office_material", currency: "EUR", stored: { ...TRAIN_COPY, accountNumber: "6101", accountName: "Ufficio", vatCodeCopy: "NOVAT", vatRateBasisPoints: 0, fxRateMicros: 924_600, fxRateMonth: new Date("2026-03-01"), fxRateCopiedAt: new Date() } },
        ],
        { status: "approved" },
      );
      await db.refundLine.update({
        where: { id: r.lineIds[0]! },
        data: { receiptNumber: "MC26/001", receiptOwnerUserId: r.owner, receiptYear: 2026, receiptSeq: 1, numberedAt: new Date() },
      });
      peer.mode = kind;
      __resetAuthzCacheForTests();
      harness.setResolve(async () => EMPLOYEE);
      const token = await harness.signToken({ sub: r.owner, email: `${r.owner}@welld.ch` });
      const res = await requestsRouter.request(`/requests/${r.id}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = (await res.json()) as { lines: Record<string, unknown>[] };
      expect(res.status).toBe(200);
      expect(body.lines).toHaveLength(2);
      for (const line of body.lines) expect(Object.keys(line).sort()).toEqual(LINE_KEYS);
      expect(body.lines.find((l) => l["receiptNumber"] === "MC26/001")).toBeDefined();
      const keys = (value: unknown): string[] =>
        Array.isArray(value) ? value.flatMap(keys) : value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]) : [];
      expect(keys(body).filter((k) => /^(ledger|vat|chf|account|rate|fx)/i.test(k))).toEqual([]);
      expect(JSON.stringify(body)).not.toMatch(/Treno|Ufficio|IVA|Senza IVA/); // no name, label or amount of an entry
      expect(peer.calls).toEqual([]);
    });
  }
});

// ─── AC-6.10 over the refusals that are not 503 ──────────────────────────────

describe("AC-6.10: every refusal of the story names the cause and carries no address, identifier or internal text", () => {
  it("the 422 of a choice, the 409 naming lines, the 503 and the blocked export, side by side", async () => {
    await seedDefaults();
    const review = await createRequest([{ type: "stationery" }, { type: "travel_train" }]);
    const refusals: Out[] = [];

    // 422: an entry Accounting does not hold (a number and a code, direct requests)
    refusals.push(await call(classificationRouter, "PUT", `/review/requests/${review.id}/lines/${review.lineIds[1]}/classification`, { accountNumber: "0000" }));
    refusals.push(await call(classificationRouter, "PUT", `/review/requests/${review.id}/lines/${review.lineIds[1]}/classification`, { vatCode: "NOPE" }));
    refusals.push(await call(defaultsRouter, "PUT", "/accounting/expense-type-defaults/postal", { accountNumber: "0000" }));
    for (const out of refusals) expect(out.status).toBe(422);

    // 409: the lines left without an account
    const missing = await call(decideRouter, "POST", `/review/requests/${review.id}/approve`);
    expect(missing.status).toBe(409);
    refusals.push(missing);

    // 503 on every operation that can be refused, each with every kind of hostile peer in turn
    for (const kind of ACCOUNTING_FAILURE_KINDS.filter((k) => k !== "pair_mismatch")) {
      peer.mode = kind;
      refusals.push(await call(decideRouter, "POST", `/review/requests/${review.id}/approve`));
      refusals.push(await call(classificationRouter, "PUT", `/review/requests/${review.id}/lines/${review.lineIds[1]}/classification`, { accountNumber: "6101" }));
      refusals.push(await call(classificationRouter, "GET", "/accounting/options"));
      refusals.push(await call(defaultsRouter, "PUT", "/accounting/expense-type-defaults/postal", { accountNumber: "6101" }));
    }
    peer.mode = "ok";

    // 409: the blocked export, with a rate that is not published (April has none in the peer)
    const b = await seedExportBatch({ month: "2026-04" });
    const blocked = await call(exportRouter, "GET", `/batches/${b.id}/accounting-export/file`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers.missingRates).toHaveLength(1);
    refusals.push(blocked);

    const statuses = new Set(refusals.map((out) => out.status));
    expect([...statuses].sort()).toEqual([409, 422, 503]);
    for (const out of refusals) {
      expectNoLeak(out);
      // The cause is named: a code and a message that says what to do or what was refused.
      expect(typeof out.body.code).toBe("string");
      expect(String(out.body.detail).length).toBeGreaterThan(20);
      // No identifier in the message members, whatever the route was called with.
      for (const id of [review.id, ...review.lineIds, b.id]) {
        expect(String(out.body.detail)).not.toContain(id);
        expect(String(out.body.title)).not.toContain(id);
      }
    }
    // The 503's `instance` is the route pattern, never the caller's ids (D15).
    for (const out of refusals.filter((o) => o.status === 503)) {
      for (const id of [review.id, ...review.lineIds]) expect(String(out.body.instance)).not.toContain(id);
    }
  });
});
