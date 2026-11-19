/**
 * The budget of a consumer-triggered fetch sits strictly inside the deadline of the consumer (T15, specs/20261119-accounting,
 * AC-2.10, AC-6.8; ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-
 * the-deadline-of-the-consumer-...; plan § Test strategy "The consumer budget sits under the consumer deadline").
 *
 * Two packages, one inequality: accounting-api's `CONSUMER_FETCH_BUDGET_MS` (the time it spends fetching on a consumer's behalf,
 * then answers) must leave room under refund-api's `ACCOUNTING_DEADLINE_MS` (the time refund-api waits for the whole answer),
 * or Refund gives up on a fetch that Accounting is still doing and the user sees "Accounting unavailable" for a month that was
 * about to be there.
 *
 * HOW THE REFUND CONSTANT IS READ. `refund-api/src/accounting/accountingClient.ts` cannot be IMPORTED from here: it evaluates
 * refund-api's own `env` (which ends the process when refund-api's variables, S3 included, are not set) and resolves its
 * dependencies from refund-api's own `node_modules`, which an accounting-api install does not have. So the file is read as text
 * and the one `export const ACCOUNTING_DEADLINE_MS = …;` declaration is evaluated (a number, or a product of numbers). A file
 * that is missing, a declaration that is absent, repeated or not a plain number is a FAILURE, never a skip: the inequality is
 * the whole point of this file, and a refactor that hides the constant must make it say so.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { TEST_ISSUER, TEST_SERVICE_AUDIENCE } from "./test-support/testAuth"; // first: it sets the environment the modules below read
import { hangingFetcher } from "./test-support/fakeSource";
import { truncateAccountingTables } from "./test-support/dbCleanup";

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { __setDefaultJwksForTests } = await import("./auth/systemAuth.middleware");
const { db } = await import("./lib/db");
const { FX_CALL_TIMEOUT_MS } = await import("./rates/bazgSource");
const { CONSUMER_FETCH_BUDGET_MS, FX_FETCH_BUDGET_MS, createRatesService } = await import("./rates/rates.service");
const { handleProblemError, problem, validationHook } = await import("./lib/problem");
const { createSystemRatesRouter } = await import("./system/rates.routes");
const { REFERENCE_READ_SCOPE } = await import("./system/readers");

// ─── The refund-api constant ─────────────────────────────────────────────────

/** Repo-relative: this file is `accounting-api/src/…`, the client is `refund-api/src/accounting/…`. */
const CLIENT_URL = new URL("../../refund-api/src/accounting/accountingClient.ts", import.meta.url);

/** The value of the one `export const ACCOUNTING_DEADLINE_MS = <n | n * n>;` of `source`; throws when it is not exactly that. */
function deadlineOf(source: string): number {
  const declarations = [...source.matchAll(/^export const ACCOUNTING_DEADLINE_MS\s*(?::\s*number\s*)?=\s*([^;\n]*);/gm)];
  if (declarations.length !== 1) throw new Error(`expected exactly one \`export const ACCOUNTING_DEADLINE_MS = …;\`, found ${declarations.length}`);
  const expression = declarations[0]![1]!.trim();
  if (!/^\d[\d_]*(\s*\*\s*\d[\d_]*)*$/.test(expression)) throw new Error(`ACCOUNTING_DEADLINE_MS is not a plain number or product of numbers: ${expression}`);
  return expression.split("*").reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
}

function readDeadline(): number {
  if (!existsSync(CLIENT_URL)) throw new Error(`refund-api's accounting client is not at ${CLIENT_URL.pathname}: this test does not skip, the inequality it checks has to be checkable`);
  return deadlineOf(readFileSync(CLIENT_URL, "utf8"));
}

/** Room left for the route, the database and the network between "the budget ends" and "Refund has its answer". */
const MARGIN_MS = 1_000;

describe("the reader of the refund-api constant", () => {
  it("evaluates a number, a number with separators and a product, and refuses anything else", () => {
    expect(deadlineOf("export const ACCOUNTING_DEADLINE_MS = 10_000;")).toBe(10_000);
    expect(deadlineOf("export const ACCOUNTING_DEADLINE_MS: number = 10 * 1_000;")).toBe(10_000);
    expect(deadlineOf("// export const ACCOUNTING_DEADLINE_MS = 1;\nexport const ACCOUNTING_DEADLINE_MS = 12_000;")).toBe(12_000);
    for (const bad of [
      "",
      "const ACCOUNTING_DEADLINE_MS = 10_000;",
      "export const ACCOUNTING_DEADLINE_MS = env.DEADLINE;",
      "export const ACCOUNTING_DEADLINE_MS = 10_000 + 1;",
      "export const ACCOUNTING_DEADLINE_MS = 10_000;\nexport const ACCOUNTING_DEADLINE_MS = 5_000;",
    ]) {
      expect(() => deadlineOf(bad)).toThrow();
    }
  });
});

describe("the consumer budget sits strictly inside the consumer deadline (AC-2.10, AC-6.8)", () => {
  it("reads refund-api's deadline: 10 s, as AC-6.8 says", () => {
    expect(readDeadline()).toBe(10_000);
  });

  it("budget + 1 s < deadline", () => {
    const deadline = readDeadline();
    expect(CONSUMER_FETCH_BUDGET_MS + MARGIN_MS).toBeLessThan(deadline);
  });

  it("the budgets keep their order: one call < the consumer's budget < the manager's budget, and only the consumer's is bound by the deadline", () => {
    expect(FX_CALL_TIMEOUT_MS).toBeLessThan(CONSUMER_FETCH_BUDGET_MS);
    expect(CONSUMER_FETCH_BUDGET_MS).toBeLessThan(FX_FETCH_BUDGET_MS);
    // The manager waits on its own screen, not under Refund's deadline (it is not a consumer), so it is allowed to be longer.
    expect(FX_FETCH_BUDGET_MS).toBeGreaterThanOrEqual(readDeadline());
  });
});

describe("through the system route, with the real budget, a source that never answers ends inside the deadline", () => {
  const KID = "svc-budgets-test";
  let token: string;
  let previousJwks: ReturnType<typeof __setDefaultJwksForTests>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    previousJwks = __setDefaultJwksForTests(createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
    token = await new SignJWT({ scope: REFERENCE_READ_SCOPE })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_SERVICE_AUDIENCE)
      .setSubject("system:refund-api")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    await truncateAccountingTables();
  });

  it(
    "answers `missing` within the budget and a margin, which is inside refund-api's deadline by the same margin (the per-call timeout is out of the way, so only the budget can end it)",
    async () => {
      const deadline = readDeadline();
      const service = createRatesService({
        mode: "bazg",
        fetcher: hangingFetcher,
        now: () => new Date("2026-11-19T10:00:00.000Z"),
        callTimeoutMs: 60_000, // longer than any budget: only the budget ends the wait
      });
      const app = new OpenAPIHono({ defaultHook: validationHook });
      app.route("/", createSystemRatesRouter(service));
      app.onError((err, c) => handleProblemError(err, c.req.path) ?? problem({ status: 500, detail: "unexpected" }, c.req.path));

      // Six months, all missing and published: the most one request may attempt, all in parallel under the one budget.
      const pairs = ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"].map((m) => `EUR:${m}`).join(",");
      const started = Date.now();
      const res = await app.request(`/system/v1/entities/welld_ch/rates?pairs=${pairs}`, { headers: { Authorization: `Bearer ${token}` } });
      const elapsed = Date.now() - started;
      const body = (await res.json()) as { rates: { status: string; reason?: string; attempted: boolean }[] };

      expect(res.status).toBe(200);
      expect(body.rates).toHaveLength(6);
      for (const rate of body.rates) expect([rate.status, rate.reason, rate.attempted]).toEqual(["missing", "fetch_failed", true]);
      expect(elapsed).toBeGreaterThanOrEqual(CONSUMER_FETCH_BUDGET_MS - 100); // it was the budget that ended it
      expect(elapsed).toBeLessThan(CONSUMER_FETCH_BUDGET_MS + MARGIN_MS);
      expect(elapsed + MARGIN_MS).toBeLessThan(deadline);
      // Six months, one failure each, logged under the consumer trigger.
      expect((await db.exchangeRateFetchAttempt.findMany()).map((a) => [a.trigger, a.outcome, a.errorCode])).toEqual(Array(6).fill(["consumer", "failed", "timeout"]));
    },
    20_000,
  );

  afterAll(async () => {
    __setDefaultJwksForTests(previousJwks);
    await truncateAccountingTables();
  });
});
