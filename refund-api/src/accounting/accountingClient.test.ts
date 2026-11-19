/**
 * The `AccountingPort` against a stubbed `fetch` and a stubbed token provider (T17, specs/20261119-accounting;
 * AC-6.8, AC-4.8, AC-3.9; plan § "How Refund reads Accounting").
 *
 * Plan rows: the default deadline is 10 000 ms; with an injected 200 ms deadline a 150 ms answer is ok and a 250 ms one is
 * unavailable; every failure kind is `AccountingUnavailableError`; two operations are two reads; the token is the service
 * token (never a user's), a 401 re-mints once; nothing about the peer reaches a log.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5435/refund_accounting_client_test";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["ACCOUNTING_INTERNAL_URL"] = "http://accounting.test:8089";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const {
  ACCOUNTING_DEADLINE_MS,
  ACCOUNTING_FAILURE_KINDS,
  ACCOUNTING_MAX_BODY_BYTES,
  AccountingUnavailableError,
  accountingUnavailableProblem,
  createAccountingClient,
} = await import("./accountingClient");
type AccountingFailureKind = (typeof ACCOUNTING_FAILURE_KINDS)[number];

const BASE = "http://accounting.test:8089";

const REFERENCE = {
  entity: "welld_ch",
  ownCurrency: "CHF",
  ledgerAccounts: [
    { number: "6101", name: "Spese materiale ufficio", active: true },
    { number: "5901", name: "Treno", active: false },
  ],
  vatCodes: [{ code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, active: true }],
};

const ratesFor = (pairs: string[], extra: Record<string, unknown> = {}) => ({
  entity: "welld_ch",
  rates: pairs.map((p) => {
    const [currency, month] = p.split(":");
    return { currency, month, status: "in_effect", rateMicros: 924600, origin: "fetched", attempted: false };
  }),
  ...extra,
});

interface Harness {
  calls: { url: string; init: RequestInit }[];
  tokensMinted: number;
  invalidated: string[];
  client: ReturnType<typeof createAccountingClient>;
}

/** `route` answers each GET; the default answers the two routes with valid bodies. */
function harness(
  options: {
    route?: (url: URL, call: number) => Promise<Response> | Response;
    deadlineMs?: number;
    mint?: (n: number) => Promise<string>;
  } = {},
): Harness {
  const calls: { url: string; init: RequestInit }[] = [];
  const h: Harness = { calls, tokensMinted: 0, invalidated: [], client: undefined as never };
  const route =
    options.route ??
    ((url: URL) => {
      if (url.pathname.endsWith("/reference-data")) return Response.json(REFERENCE);
      const pairs = (url.searchParams.get("pairs") ?? "").split(",");
      return Response.json(ratesFor(pairs));
    });
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return route(new URL(String(url)), calls.length);
  }) as unknown as typeof fetch;
  h.client = createAccountingClient({
    baseUrl: `${BASE}/`,
    fetchImpl,
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    tokens: {
      async getToken() {
        h.tokensMinted++;
        return options.mint ? options.mint(h.tokensMinted) : `token-${h.tokensMinted}`;
      },
      invalidate(token) {
        h.invalidated.push(token);
      },
    },
  });
  return h;
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

async function kindOf(promise: Promise<unknown>): Promise<AccountingFailureKind | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    expect(error).toBeInstanceOf(AccountingUnavailableError);
    return (error as InstanceType<typeof AccountingUnavailableError>).kind;
  }
}

describe("constants (AC-6.8)", () => {
  it("the default deadline is 10 000 ms and the body cap is 256 KiB", () => {
    expect(ACCOUNTING_DEADLINE_MS).toBe(10_000);
    expect(ACCOUNTING_MAX_BODY_BYTES).toBe(256 * 1024);
  });
});

describe("a clean read", () => {
  it("reads the reference data with the service token, no cookies, no redirect following", async () => {
    const h = harness();
    const data = await h.client.begin("view").referenceData();
    expect(data.ledgerAccounts.map((a) => a.number)).toEqual(["6101", "5901"]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(`${BASE}/system/v1/entities/welld_ch/reference-data`);
    const init = h.calls[0]!.init;
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-1");
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBeUndefined();
  });

  it("reads rates for the asked pairs, in the asked order", async () => {
    const h = harness();
    const answers = await h.client.begin("view").rates([
      { currency: "USD", month: "2026-11" },
      { currency: "EUR", month: "2026-03" },
    ]);
    expect(answers.map((a) => `${a.currency}:${a.month}`)).toEqual(["USD:2026-11", "EUR:2026-03"]);
    expect(h.calls[0]!.url).toBe(`${BASE}/system/v1/entities/welld_ch/rates?pairs=USD:2026-11,EUR:2026-03`);
  });

  it("asks nothing for no pairs, and once for a repeated pair", async () => {
    const h = harness();
    const op = h.client.begin("approve");
    expect(await op.rates([])).toEqual([]);
    const answers = await op.rates([
      { currency: "EUR", month: "2026-03" },
      { currency: "EUR", month: "2026-03" },
    ]);
    expect(answers).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  it("splits more than 36 pairs into calls of at most 36", async () => {
    const h = harness();
    const pairs = Array.from({ length: 40 }, (_, i) => ({
      currency: "EUR" as const,
      month: `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
    }));
    const answers = await h.client.begin("release").rates(pairs);
    expect(answers).toHaveLength(40);
    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((c) => new URL(c.url).searchParams.get("pairs")!.split(",").length).sort((a, b) => a - b)).toEqual([4, 36]);
  });
});

describe("pairs before Accounting's month floor (F-02, AC-6.8, AC-7.4)", () => {
  // Accounting answers a rates request with ANY month before 2000-01 as a whole 400, which this client reads as "unavailable":
  // one such line (the expense date is only a 4-digit year) would fail every read of its request, and the release, for good.
  const MISSING = (currency: string, month: string) => ({ currency, month, status: "missing", attempted: false, reason: "no_source" });

  it("asks Accounting only the in-range pairs; an earlier month is answered missing (no_source), in the asked order", async () => {
    const h = harness();
    const answers = await h.client.begin("approve").rates([
      { currency: "EUR", month: "1999-12" },
      { currency: "USD", month: "2026-03" },
      { currency: "GBP", month: "0001-01" },
    ]);
    expect(h.calls.map((c) => new URL(c.url).searchParams.get("pairs"))).toEqual(["USD:2026-03"]);
    expect(answers.map((a) => [a.currency, a.month, a.status])).toEqual([
      ["EUR", "1999-12", "missing"],
      ["USD", "2026-03", "in_effect"],
      ["GBP", "0001-01", "missing"],
    ]);
    expect(answers[0]).toEqual(MISSING("EUR", "1999-12"));
    expect(answers[2]).toEqual(MISSING("GBP", "0001-01"));
  });

  it("the floor itself, 2000-01, is asked", async () => {
    const h = harness();
    await h.client.begin("view").rates([{ currency: "EUR", month: "2000-01" }]);
    expect(h.calls.map((c) => new URL(c.url).searchParams.get("pairs"))).toEqual(["EUR:2000-01"]);
  });

  it("only out-of-range pairs: no call and no token, and nothing is unavailable", async () => {
    const h = harness();
    const answers = await h.client.begin("release").rates([{ currency: "EUR", month: "1999-05" }]);
    expect(answers).toEqual([MISSING("EUR", "1999-05")]);
    expect(h.calls).toHaveLength(0);
    expect(h.tokensMinted).toBe(0);
  });

  it("a month that is not YYYY-MM at all (a year past 9999 or before 0) is not asked either", async () => {
    const h = harness();
    const answers = await h.client.begin("view").rates([
      { currency: "EUR", month: "+010000-01" },
      { currency: "EUR", month: "-000001-01" },
    ]);
    expect(answers.map((a) => a.status)).toEqual(["missing", "missing"]);
    expect(h.calls).toHaveLength(0);
  });

  it("an in-range pair that Accounting fails still fails the read: the floor is not a way to swallow errors", async () => {
    const h = harness({ route: () => new Response("no", { status: 500 }) });
    expect(
      await kindOf(
        h.client.begin("view").rates([
          { currency: "EUR", month: "1999-05" },
          { currency: "EUR", month: "2026-03" },
        ]),
      ),
    ).toBe("http_status");
  });
});

describe("no cache across operations (AC-4.8, D2)", () => {
  it("within one operation the answer is memoised: one read", async () => {
    const h = harness();
    const op = h.client.begin("view");
    await Promise.all([op.referenceData(), op.referenceData()]);
    await op.referenceData();
    await op.rates([{ currency: "EUR", month: "2026-03" }]);
    await op.rates([{ currency: "EUR", month: "2026-03" }]);
    expect(h.calls.map((c) => new URL(c.url).pathname.split("/").pop())).toEqual(["reference-data", "rates"]);
  });

  it("two operations are two reads", async () => {
    const h = harness();
    await h.client.begin("options").referenceData();
    await h.client.begin("options").referenceData();
    expect(h.calls).toHaveLength(2);
  });

  it("an operation that asks nothing reads nothing and mints no token", async () => {
    const h = harness();
    h.client.begin("approve");
    expect(h.calls).toHaveLength(0);
    expect(h.tokensMinted).toBe(0);
  });

  it("a failed read is not retried inside the operation", async () => {
    const h = harness({ route: () => new Response("x", { status: 500 }) });
    const op = h.client.begin("view");
    expect(await kindOf(op.referenceData())).toBe("http_status");
    expect(await kindOf(op.referenceData())).toBe("http_status");
    expect(h.calls).toHaveLength(1);
  });
});

describe("the deadline (AC-6.8, D3)", () => {
  it("a 150 ms answer at a 200 ms deadline is ok, a 250 ms one is unavailable", async () => {
    const slow = (ms: number) => async (): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return Response.json(REFERENCE);
    };
    expect(await kindOf(harness({ deadlineMs: 200, route: slow(150) }).client.begin("view").referenceData())).toBe("ok");
    expect(await kindOf(harness({ deadlineMs: 200, route: slow(250) }).client.begin("view").referenceData())).toBe("timeout");
  });

  it("holds even when the peer ignores the abort signal and never answers", async () => {
    const h = harness({ deadlineMs: 100, route: () => new Promise<Response>(() => undefined) });
    const started = Date.now();
    expect(await kindOf(h.client.begin("approve").referenceData())).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("one deadline covers the token mint and every call of the operation", async () => {
    const h = harness({
      deadlineMs: 200,
      mint: () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 400)),
    });
    expect(await kindOf(h.client.begin("approve").referenceData())).toBe("timeout");
    expect(h.calls).toHaveLength(0);
  });

  it("a body that stalls half way is cut at the deadline", async () => {
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"entity":'));
          },
        }),
      );
    const h = harness({ deadlineMs: 150, route: stalled });
    expect(await kindOf(h.client.begin("view").referenceData())).toBe("timeout");
  });
});

describe("every failure kind is unavailable (AC-6.8)", () => {
  const cases: [string, AccountingFailureKind, () => Promise<Response> | Response][] = [
    ["500", "http_status", () => new Response("boom", { status: 500 })],
    ["503", "http_status", () => new Response("down", { status: 503 })],
    ["403", "http_status", () => new Response("no", { status: 403 })],
    ["404", "http_status", () => new Response("no", { status: 404 })],
    ["a redirect", "redirect", () => new Response(null, { status: 302, headers: { Location: "http://evil.example/steal" } })],
    ["a non-JSON body", "not_json", () => new Response("<html>nope</html>", { headers: { "Content-Type": "text/html" } })],
    ["an empty body", "not_json", () => new Response("")],
    ["a body over 256 KiB", "too_large", () => new Response(JSON.stringify({ pad: "x".repeat(ACCOUNTING_MAX_BODY_BYTES + 10) }))],
    ["a body over 256 KiB by its declared length", "too_large", () => new Response("{}", { headers: { "Content-Length": String(ACCOUNTING_MAX_BODY_BYTES + 1) } })],
    ["a schema mismatch", "schema", () => Response.json({ ...REFERENCE, extra: true })],
    ["a missing member", "schema", () => Response.json({ entity: "welld_ch", ownCurrency: "CHF", ledgerAccounts: [] })],
    ["an account listed twice", "schema", () => Response.json({ ...REFERENCE, ledgerAccounts: [REFERENCE.ledgerAccounts[0], REFERENCE.ledgerAccounts[0]] })],
    ["another entity's data", "entity_mismatch", () => Response.json({ ...REFERENCE, entity: "welld_it", ownCurrency: "EUR" })],
  ];
  for (const [label, kind, route] of cases) {
    it(`${label} → ${kind}`, async () => {
      const h = harness({ route });
      expect(await kindOf(h.client.begin("approve").referenceData())).toBe(kind);
      expect(h.calls).toHaveLength(1); // no retry other than the 401 one
    });
  }

  it("a network error → network", async () => {
    const h = harness({
      route: () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.7:8089");
      },
    });
    expect(await kindOf(h.client.begin("view").referenceData())).toBe("network");
  });

  it("a rates answer that misses a pair, adds a pair, or answers for another entity → unavailable", async () => {
    const ask = [
      { currency: "EUR" as const, month: "2026-03" },
      { currency: "USD" as const, month: "2026-03" },
    ];
    const answer = (body: unknown) => () => Response.json(body);
    expect(await kindOf(harness({ route: answer(ratesFor(["EUR:2026-03"])) }).client.begin("approve").rates(ask))).toBe("pair_mismatch");
    expect(await kindOf(harness({ route: answer(ratesFor(["EUR:2026-03", "USD:2026-03", "GBP:2026-03"])) }).client.begin("approve").rates(ask))).toBe("pair_mismatch");
    expect(await kindOf(harness({ route: answer(ratesFor(["EUR:2026-03", "GBP:2026-03"])) }).client.begin("approve").rates(ask))).toBe("pair_mismatch");
    expect(await kindOf(harness({ route: answer({ ...ratesFor(["EUR:2026-03", "USD:2026-03"]), entity: "welld_it" }) }).client.begin("approve").rates(ask))).toBe("entity_mismatch");
    expect(await kindOf(harness({ route: answer({ entity: "welld_ch", rates: [] }) }).client.begin("approve").rates(ask))).toBe("schema");
  });

  it("a token mint failure → token, with no call to Accounting", async () => {
    const h = harness({
      mint: async () => {
        throw new Error("auth is down");
      },
    });
    expect(await kindOf(h.client.begin("approve").referenceData())).toBe("token");
    expect(h.calls).toHaveLength(0);
  });

  it("one failed call fails the whole operation's pair read", async () => {
    const h = harness({ route: () => new Response("x", { status: 502 }) });
    expect(await kindOf(h.client.begin("approve").rates([{ currency: "EUR", month: "2026-03" }]))).toBe("http_status");
  });
});

describe("the 401 re-mint (D3)", () => {
  it("one 401 drops the token, mints a new one and retries once", async () => {
    const h = harness({
      route: (url, call) => (call === 1 ? new Response("expired", { status: 401 }) : Response.json(REFERENCE)),
    });
    expect(await kindOf(h.client.begin("view").referenceData())).toBe("ok");
    expect(h.tokensMinted).toBe(2);
    expect(h.invalidated).toEqual(["token-1"]);
    expect((h.calls[1]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-2");
  });

  it("401 twice → unavailable, after exactly two calls", async () => {
    const h = harness({ route: () => new Response("no", { status: 401 }) });
    expect(await kindOf(h.client.begin("view").referenceData())).toBe("unauthorized");
    expect(h.calls).toHaveLength(2);
    expect(h.tokensMinted).toBe(2);
  });

  it("a 401 then a 500 → unavailable (the retry is not a second chance for other failures)", async () => {
    const h = harness({ route: (_url, call) => (call === 1 ? new Response("", { status: 401 }) : new Response("", { status: 500 })) });
    expect(await kindOf(h.client.begin("view").referenceData())).toBe("http_status");
    expect(h.calls).toHaveLength(2);
  });
});

describe("logs and messages carry nothing of the peer (AC-6.10)", () => {
  it("logs the kind and the operation only", async () => {
    const h = harness({ route: () => new Response("secret-body http://10.0.0.7:8089/stack", { status: 500 }) });
    await kindOf(h.client.begin("approve").referenceData());
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(logged)).toEqual({ event: "refund.accounting_unavailable", operation: "approve", kind: "http_status" });
    expect(logged).not.toContain("secret-body");
    expect(logged).not.toContain("token-1");
    expect(logged).not.toContain("accounting.test");
  });

  it("the error and the problem body carry no URL, host, id or stack text", async () => {
    const h = harness({
      route: () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED http://accounting.test:8089/system/v1");
      },
    });
    let caught: unknown;
    try {
      await h.client.begin("view").referenceData();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe("Accounting cannot be read");
    const body = accountingUnavailableProblem("/review/requests/abc/accounting");
    expect(body.code).toBe("accounting_unavailable");
    expect(body.status).toBe(503);
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\/(?!httpstatuses\.com)|localhost|railway|\bc[a-z0-9]{24}\b|\bat .*\(/);
  });
});

describe("a real loopback server (redirects and size are enforced on real responses)", () => {
  it("does not follow a 302 and does not send the token to the target", async () => {
    let evilHits = 0;
    const evil = Bun.serve({ port: 0, fetch: () => (evilHits++, new Response("{}")) });
    const front = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${evil.port}/steal` } }),
    });
    try {
      const client = createAccountingClient({
        baseUrl: `http://127.0.0.1:${front.port}`,
        tokens: { getToken: async () => "tok", invalidate() {} },
      });
      expect(await kindOf(client.begin("view").referenceData())).toBe("redirect");
      expect(evilHits).toBe(0);
    } finally {
      await front.stop(true);
      await evil.stop(true);
    }
  });

  it("stops reading a body that never ends", async () => {
    const endless = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
            },
          }),
        ),
    });
    try {
      const client = createAccountingClient({
        baseUrl: `http://127.0.0.1:${endless.port}`,
        tokens: { getToken: async () => "tok", invalidate() {} },
      });
      expect(await kindOf(client.begin("view").referenceData())).toBe("too_large");
    } finally {
      await endless.stop(true);
    }
  });
});
