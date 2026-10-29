/**
 * Unit tests for refund-api's four notify-api call sites (T13, specs/007;
 * `notifyPaid` T6, specs/008; the email pair T5, specs/008 and specs/007;
 * credential: T9, specs/016, AC-1.1, AC-1.2, AC-4.3, AC-5.2, ADR-0049).
 *
 * Push (`notify.ts`): `notifyDecision`, `notifyPaid` -> `/system/notifications`,
 * scope `notifications.push`. Email (`notifyEmail.ts`): `notifyBatchCompiled`,
 * `notifyDecisionEmail` -> `/system/emails`, scope `emails.send`.
 *
 * Every call site is driven through an injected transport (a stub token
 * provider and a stub `fetch`), so nothing here touches the network, `auth`,
 * or the global `fetch`; the wired default provider is disabled under
 * NODE_ENV=test anyway (serviceToken.ts).
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { ServiceTokenProvider } from "./serviceToken";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["REFUND_APP_BASE_URL"] ??= "http://localhost:5173";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";

const { notifyDecision, notifyPaid } = await import("./notify");
// `?real`: batches.routes.test.ts mock.module()s ./notifyEmail process-wide; this
// file tests the real client, so it must not pick up that stand-in (T21, specs/016).
// @ts-expect-error -- the query suffix is a runtime-only cache-buster
const { notifyBatchCompiled, notifyDecisionEmail } = (await import("./notifyEmail?real")) as typeof import("./notifyEmail");
const { ServiceTokenError } = await import("./serviceToken");
const { env } = await import("./env");

const BASE = "http://localhost:8081";

// ─── Stubs ──────────────────────────────────────────────────────────────────

/** A token provider: t1 until it is invalidated, then t2, and so on. */
function stubTokens(opts: { failWith?: Error } = {}) {
  const invalidated: string[] = [];
  const provider: ServiceTokenProvider = {
    async getToken() {
      if (opts.failWith) throw opts.failWith;
      return `t${1 + invalidated.length}`;
    },
    invalidate(token) {
      invalidated.push(token);
    },
  };
  return { provider, invalidated };
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A stub fetch answering from a script of responses (the last one repeats). */
function stubFetch(script: Array<Response | Error>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>,
    });
    const next = script[Math.min(seen.length - 1, script.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const pushOk = () => new Response(JSON.stringify({ id: "n1" }), { status: 201 });
const emailOk = () => new Response(JSON.stringify({ deliveryId: "d1", status: "sent" }), { status: 200 });
const http = (status: number) => new Response("nope", { status });

// ─── The four call sites, behind one uniform shape ──────────────────────────

interface Transport {
  tokens: ServiceTokenProvider;
  fetchImpl: typeof fetch;
}

interface Site {
  readonly name: string;
  readonly path: string;
  readonly ok: () => Response;
  /** Runs the call site and returns whatever it resolved to. */
  readonly call: (t: Transport) => Promise<unknown>;
  /** What the call site resolves to when delivery did not happen. */
  readonly failed: unknown;
}

const batchInput = {
  batchId: "b1",
  batchReference: "b1",
  cutoff: new Date("2026-10-01T00:00:00Z"),
  generatedAt: new Date("2026-10-02T00:00:00Z"),
  requestCount: 3,
  recipientEmail: "accounting@example.test",
};
const decisionEmailInput = {
  requestId: "req-1",
  recipientEmail: "emp@example.test",
  decidedAt: new Date("2026-10-02T00:00:00Z"),
  approvedTotals: [{ currency: "EUR", amountCents: 1234 }],
};

const SITES: readonly Site[] = [
  {
    name: "notifyDecision",
    path: "/system/notifications",
    ok: pushOk,
    failed: undefined,
    call: (t) => notifyDecision({ recipientId: "emp-1", requestId: "req-1", outcome: "approved" }, t),
  },
  {
    name: "notifyPaid",
    path: "/system/notifications",
    ok: pushOk,
    failed: undefined,
    call: (t) => notifyPaid({ recipientId: "emp-1", requestId: "req-1" }, t),
  },
  {
    name: "notifyBatchCompiled",
    path: "/system/emails",
    ok: emailOk,
    failed: { status: "failed", deliveryId: null },
    call: (t) => notifyBatchCompiled(batchInput, t),
  },
  {
    name: "notifyDecisionEmail",
    path: "/system/emails",
    ok: emailOk,
    failed: { status: "failed", deliveryId: null },
    call: (t) => notifyDecisionEmail("approved", decisionEmailInput, t),
  },
];

let errorLog: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorLog = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
});

const logged = () => errorLog.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");

describe.each(SITES.map((s) => [s.name, s] as const))("%s", (_name, site) => {
  it("POSTs to notify-api's system route with Authorization: Bearer and no X-Internal-Token", async () => {
    const { provider } = stubTokens();
    const { seen, fetchImpl } = stubFetch([site.ok()]);

    await site.call({ tokens: provider, fetchImpl });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${BASE}${site.path}`);
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer t1");
    expect(seen[0]!.headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain("x-internal-token");
  });

  it("after one 401 drops the cached token and retries ONCE with a fresh one", async () => {
    const { provider, invalidated } = stubTokens();
    const { seen, fetchImpl } = stubFetch([http(401), site.ok()]);

    const result = await site.call({ tokens: provider, fetchImpl });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer t1");
    expect(seen[1]!.headers["Authorization"]).toBe("Bearer t2");
    expect(invalidated).toEqual(["t1"]);
    expect(JSON.stringify(seen[1]!.body)).toBe(JSON.stringify(seen[0]!.body));
    expect(result).not.toEqual(site.failed === undefined ? "never" : site.failed);
  });

  it("does not loop on a second 401: two requests, then failure is logged and swallowed", async () => {
    const { provider } = stubTokens();
    const { seen, fetchImpl } = stubFetch([http(401)]);

    const result = await site.call({ tokens: provider, fetchImpl });

    expect(seen).toHaveLength(2);
    expect(result).toEqual(site.failed as never);
    expect(logged()).toContain("HTTP 401");
  });

  for (const status of [429, 500, 503]) {
    it(`resolves without retrying on HTTP ${status} (rate-limited / down)`, async () => {
      const { provider, invalidated } = stubTokens();
      const { seen, fetchImpl } = stubFetch([http(status)]);

      const result = await site.call({ tokens: provider, fetchImpl });

      expect(seen).toHaveLength(1);
      expect(invalidated).toEqual([]);
      expect(result).toEqual(site.failed as never);
      expect(logged()).toContain(`HTTP ${status}`);
    });
  }

  for (const [label, message] of [
    ["auth down", "service-token request failed (TimeoutError)"],
    ["auth refused (401)", "auth /system/service-token responded with HTTP 401"],
    ["auth rate-limited (429)", "auth /system/service-token responded with HTTP 429"],
  ] as const) {
    it(`provider rejection, ${label}: no request to notify-api, resolves, logs the status only`, async () => {
      const { provider } = stubTokens({ failWith: new ServiceTokenError(message) });
      const { seen, fetchImpl } = stubFetch([site.ok()]);

      const result = await site.call({ tokens: provider, fetchImpl });

      expect(seen).toHaveLength(0);
      expect(result).toEqual(site.failed as never);
      expect(logged()).toContain(message);
      expect(logged()).not.toContain("test-service-client-secret");
    });
  }

  it("resolves on a network failure", async () => {
    const { provider } = stubTokens();
    const { fetchImpl } = stubFetch([new Error("connection refused")]);

    expect(await site.call({ tokens: provider, fetchImpl })).toEqual(site.failed as never);
    expect(logged()).toContain("connection refused");
  });
});

// ─── Per-site request shapes (unchanged by T9) ──────────────────────────────

describe("request shapes", () => {
  it("notifyDecision: approved -> success; rejected -> warning; English copy and request link", async () => {
    const { provider } = stubTokens();
    const a = stubFetch([pushOk()]);
    await notifyDecision({ recipientId: "emp-1", requestId: "req-1", outcome: "approved" }, { tokens: provider, fetchImpl: a.fetchImpl });
    expect(a.seen[0]!.body).toEqual({
      recipientId: "emp-1",
      originApp: "refund",
      severity: "success",
      title: "Refund approved",
      body: "Your refund request has been approved.",
      link: { href: "/refund/requests/req-1" },
    });

    const r = stubFetch([pushOk()]);
    await notifyDecision({ recipientId: "emp-2", requestId: "req-2", outcome: "rejected" }, { tokens: provider, fetchImpl: r.fetchImpl });
    expect(r.seen[0]!.body["severity"]).toBe("warning");
    expect(r.seen[0]!.body["title"]).toBe("Refund rejected");
    expect(r.seen[0]!.body["originApp"]).toBe("refund");
  });

  it("notifyPaid: generic body, originApp refund", async () => {
    const { provider } = stubTokens();
    const { seen, fetchImpl } = stubFetch([pushOk()]);
    await notifyPaid({ recipientId: "emp-1", requestId: "req-1" }, { tokens: provider, fetchImpl });
    expect(seen[0]!.body).toEqual({
      recipientId: "emp-1",
      originApp: "refund",
      severity: "success",
      title: "Refund paid",
      body: "Your refund request has been paid.",
      link: { href: "/refund/requests/req-1" },
    });
  });

  it("notifyBatchCompiled: refund_batch_compiled template with the deep link; passes delivery status through", async () => {
    const { provider } = stubTokens();
    const { seen, fetchImpl } = stubFetch([new Response(JSON.stringify({ deliveryId: "d9", status: "failed" }), { status: 200 })]);
    const out = await notifyBatchCompiled(batchInput, { tokens: provider, fetchImpl });
    expect(out).toEqual({ status: "failed", deliveryId: "d9" });
    expect(seen[0]!.body["template"]).toBe("refund_batch_compiled");
    expect(seen[0]!.body["to"]).toBe("accounting@example.test");
    expect((seen[0]!.body["data"] as Record<string, unknown>)["batchUrl"]).toBe(`${env.REFUND_APP_BASE_URL}/refund/batches/b1`);
  });

  it("notifyDecisionEmail: rejected carries no amount", async () => {
    const { provider } = stubTokens();
    const { seen, fetchImpl } = stubFetch([emailOk()]);
    const out = await notifyDecisionEmail("rejected", decisionEmailInput, { tokens: provider, fetchImpl });
    expect(out).toEqual({ status: "sent", deliveryId: "d1" });
    expect(seen[0]!.body["template"]).toBe("refund_decision_rejected");
    expect(JSON.stringify(seen[0]!.body)).not.toContain("approvedTotals");
  });
});

describe("the wired default under NODE_ENV=test", () => {
  it("never reaches the network: the disabled provider fails the token step, which is swallowed", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return pushOk();
    }) as unknown as typeof fetch;
    try {
      await notifyPaid({ recipientId: "emp-1", requestId: "req-1" });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
