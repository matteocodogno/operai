/**
 * Unit tests for the notify-api client (T13, specs/007-refund-service,
 * AC-3.6, ADR-0017).
 *
 * Mocks global `fetch` directly (this module IS the network boundary being
 * tested, unlike decide.routes.test.ts which mocks THIS module) — asserts
 * the request shape (method, header, body) and the never-throws contract
 * for both a non-2xx response and a network failure.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] = "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["REFUND_S3_ENDPOINT"] =
  "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";

const { notifyDecision } = await import("./notify");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("notifyDecision", () => {
  it("POSTs to /system/notifications with the internal token and the correct shape", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
    }) as unknown as typeof fetch;

    await notifyDecision({
      recipientId: "emp-1",
      requestId: "req-1",
      outcome: "approved",
    });

    expect(capturedUrl).toBe("http://localhost:8081/system/notifications");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-Internal-Token"]).toBe(
      "test-notify-internal-token-at-least-32-characters",
    );
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(capturedInit?.body as string) as {
      recipientId: string;
      originApp: string;
      severity: string;
      link: { href: string };
    };
    expect(body.recipientId).toBe("emp-1");
    expect(body.originApp).toBe("refund");
    expect(body.severity).toBe("success");
    expect(body.link).toEqual({ href: "/refund/requests/req-1" });
  });

  it("uses severity=warning for a rejected outcome and the same link shape", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
    }) as unknown as typeof fetch;

    await notifyDecision({
      recipientId: "emp-2",
      requestId: "req-2",
      outcome: "rejected",
    });

    const body = JSON.parse(capturedBody!) as { severity: string; link: { href: string } };
    expect(body.severity).toBe("warning");
    expect(body.link).toEqual({ href: "/refund/requests/req-2" });
  });

  it("never throws on a non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(
      notifyDecision({ recipientId: "emp-1", requestId: "req-1", outcome: "approved" }),
    ).resolves.toBeUndefined();
  });

  it("never throws on a network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(
      notifyDecision({ recipientId: "emp-1", requestId: "req-1", outcome: "rejected" }),
    ).resolves.toBeUndefined();
  });
});
