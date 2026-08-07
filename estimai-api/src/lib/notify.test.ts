/**
 * Unit tests for the notify-api client (T5, specs/013-estimate-sharing,
 * ADR-0017/ADR-0040). Mirrors `refund-api/src/lib/notify.test.ts`'s
 * strategy — global `fetch` is mocked directly since this module IS the
 * network boundary under test.
 *
 * Done-when coverage (tasks.md T5): "notify.ts swallows and logs a
 * rejection" — both a non-2xx response and a network failure must resolve
 * (never reject) for both notification kinds.
 */

import { describe, it, expect, afterEach } from "bun:test";

process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5435/test";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] =
  "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";

const { notifyCollaboratorGranted, notifyCollaboratorRemoved } = await import(
  "./notify"
);

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

describe("notifyCollaboratorGranted", () => {
  it("POSTs to /system/notifications with the internal token, originApp:'estimai', and the estimate link", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
    }) as unknown as typeof fetch;

    await notifyCollaboratorGranted({
      recipientId: "user-2",
      estimateId: "est-1",
      estimateName: "Q3 platform migration",
      accessLevel: "editor",
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
      title: string;
      body: string;
      link: { href: string };
    };
    expect(body.recipientId).toBe("user-2");
    expect(body.originApp).toBe("estimai");
    expect(body.severity).toBe("info");
    expect(body.link).toEqual({ href: "/estimai/estimates/est-1" });
    expect(body.body).toContain("Q3 platform migration");
    expect(body.body.toLowerCase()).toContain("edit");
  });

  it("truncates an over-120-char estimate name before it leaves estimai-api", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
    }) as unknown as typeof fetch;

    const longName = "A".repeat(200);
    await notifyCollaboratorGranted({
      recipientId: "user-2",
      estimateId: "est-1",
      estimateName: longName,
      accessLevel: "viewer",
    });

    const body = JSON.parse(capturedBody!) as { body: string };
    // 120 chars of the name plus the ellipsis marker, never the full 200.
    expect(body.body).not.toContain("A".repeat(121));
    expect(body.body).toContain("A".repeat(120));
  });

  it("never throws on a non-2xx response", async () => {
    console.error = () => {};
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(
      notifyCollaboratorGranted({
        recipientId: "user-2",
        estimateId: "est-1",
        estimateName: "Estimate",
        accessLevel: "viewer",
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws on a network failure", async () => {
    console.error = () => {};
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(
      notifyCollaboratorGranted({
        recipientId: "user-2",
        estimateId: "est-1",
        estimateName: "Estimate",
        accessLevel: "editor",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("notifyCollaboratorRemoved", () => {
  it("POSTs with originApp:'estimai' and NO link (the target would 404 on the estimate)", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
    }) as unknown as typeof fetch;

    await notifyCollaboratorRemoved({
      recipientId: "user-2",
      estimateId: "est-1",
      estimateName: "Q3 platform migration",
    });

    const body = JSON.parse(capturedBody!) as {
      recipientId: string;
      originApp: string;
      severity: string;
      body: string;
      link?: { href: string };
    };
    expect(body.recipientId).toBe("user-2");
    expect(body.originApp).toBe("estimai");
    expect(body.severity).toBe("info");
    expect(body.body).toContain("Q3 platform migration");
    expect(body.link).toBeUndefined();
  });

  it("never throws on a non-2xx response", async () => {
    console.error = () => {};
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(
      notifyCollaboratorRemoved({
        recipientId: "user-2",
        estimateId: "est-1",
        estimateName: "Estimate",
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws on a network failure", async () => {
    console.error = () => {};
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(
      notifyCollaboratorRemoved({
        recipientId: "user-2",
        estimateId: "est-1",
        estimateName: "Estimate",
      }),
    ).resolves.toBeUndefined();
  });
});
