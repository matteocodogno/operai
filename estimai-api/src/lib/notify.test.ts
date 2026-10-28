/**
 * Unit tests for the notify-api client (T5, specs/013-estimate-sharing,
 * ADR-0017; credential switched to the service JWT by T10, specs/016,
 * ADR-0044/0049). The network and the token provider are injected stubs —
 * this module IS the boundary under test.
 *
 * Coverage: the push carries `Authorization: Bearer <provider token>` and no
 * `X-Internal-Token` (AC-1.3); a refused/failed token or push resolves and
 * never rejects (AC-4.3); one 401 invalidates the cached token and retries
 * once.
 */

import { describe, it, expect, afterEach } from "bun:test";

process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5435/test";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["SERVICE_CLIENT_ID"] = "estimai-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";

const { createCollaboratorNotifier, notifyCollaboratorGranted: defaultGranted } = await import("./notify");
const { ServiceTokenError } = await import("./serviceToken");
type ServiceTokenProvider = import("./serviceToken").ServiceTokenProvider;

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

const TOKEN = "service-jwt-from-provider";

interface Harness {
  readonly notifier: ReturnType<typeof createCollaboratorNotifier>;
  readonly calls: { url: string; init: RequestInit }[];
  readonly invalidated: string[];
  respond(fn: (call: number) => Promise<Response> | Response): void;
}

function harness(tokens?: Partial<ServiceTokenProvider>): Harness {
  const calls: { url: string; init: RequestInit }[] = [];
  const invalidated: string[] = [];
  let impl: (call: number) => Promise<Response> | Response = () =>
    new Response(JSON.stringify({ id: "n1" }), { status: 201 });
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return impl(calls.length);
  }) as unknown as typeof fetch;
  const provider: ServiceTokenProvider = {
    getToken: tokens?.getToken ?? (async () => TOKEN),
    invalidate: tokens?.invalidate ?? ((t) => void invalidated.push(t)),
  };
  return {
    notifier: createCollaboratorNotifier({ baseUrl: "http://localhost:8081", tokens: provider, fetchImpl }),
    calls,
    invalidated,
    respond: (fn) => void (impl = fn),
  };
}

const granted = {
  recipientId: "user-2",
  estimateId: "est-1",
  estimateName: "Q3 platform migration",
  accessLevel: "editor",
} as const;
const removed = { recipientId: "user-2", estimateId: "est-1", estimateName: "Q3 platform migration" } as const;

describe("notifyCollaboratorGranted", () => {
  it("POSTs to /system/notifications with Authorization: Bearer <provider token> and NO X-Internal-Token (AC-1.3), originApp:'estimai', and the estimate link", async () => {
    const h = harness();

    await h.notifier.notifyCollaboratorGranted(granted);

    expect(h.calls.length).toBe(1);
    const { url, init } = h.calls[0]!;
    expect(url).toBe("http://localhost:8081/system/notifications");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-internal-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.redirect).toBe("error");

    const body = JSON.parse(init.body as string) as {
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
    const h = harness();

    await h.notifier.notifyCollaboratorGranted({ ...granted, estimateName: "A".repeat(200), accessLevel: "viewer" });

    const body = JSON.parse(h.calls[0]!.init.body as string) as { body: string };
    // 120 chars of the name plus the ellipsis marker, never the full 200.
    expect(body.body).not.toContain("A".repeat(121));
    expect(body.body).toContain("A".repeat(120));
  });

  it("never throws on a non-2xx response, and logs the status only", async () => {
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    const h = harness();
    h.respond(() => new Response("secret-looking-body", { status: 500 }));

    await expect(h.notifier.notifyCollaboratorGranted(granted)).resolves.toBeUndefined();

    expect(logged.join("\n")).toContain("HTTP 500");
    expect(logged.join("\n")).not.toContain("secret-looking-body");
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("never throws on a network failure", async () => {
    console.error = () => {};
    const h = harness();
    h.respond(() => {
      throw new Error("connection refused");
    });

    await expect(h.notifier.notifyCollaboratorGranted(granted)).resolves.toBeUndefined();
  });

  // AC-4.3 — auth unreachable / refusing to issue a credential.
  it("resolves, logs, and sends nothing when the token provider rejects (auth down, 401, 429)", async () => {
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    const h = harness({
      getToken: async () => {
        throw new ServiceTokenError("auth /system/service-token responded with HTTP 429");
      },
    });

    await expect(h.notifier.notifyCollaboratorGranted(granted)).resolves.toBeUndefined();

    expect(h.calls.length).toBe(0);
    expect(logged.join("\n")).toContain("HTTP 429");
    expect(logged.join("\n")).toContain("NOT rolled back");
  });

  it("on one 401 drops the cached token and retries once with a fresh one", async () => {
    let issued = 0;
    const h = harness({ getToken: async () => `tok-${++issued}` });
    h.respond((call) => new Response("", { status: call === 1 ? 401 : 201 }));

    await h.notifier.notifyCollaboratorGranted(granted);

    expect(h.calls.length).toBe(2);
    expect((h.calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-1");
    expect((h.calls[1]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-2");
    expect(h.invalidated).toEqual(["tok-1"]);
  });

  it("does not loop on a second 401: logs and stops after two requests", async () => {
    console.error = () => {};
    const h = harness();
    h.respond(() => new Response("", { status: 401 }));

    await expect(h.notifier.notifyCollaboratorGranted(granted)).resolves.toBeUndefined();

    expect(h.calls.length).toBe(2);
  });

  it("the default instance (provider disabled under NODE_ENV=test) resolves without making any request", async () => {
    console.error = () => {};
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;

    await expect(defaultGranted(granted)).resolves.toBeUndefined();

    expect(requests).toBe(0);
  });
});

describe("notifyCollaboratorRemoved", () => {
  it("POSTs with a Bearer credential, originApp:'estimai' and NO link (the target would 404 on the estimate)", async () => {
    const h = harness();

    await h.notifier.notifyCollaboratorRemoved(removed);

    const { init } = h.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-internal-token");
    const body = JSON.parse(init.body as string) as {
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
    const h = harness();
    h.respond(() => new Response("nope", { status: 500 }));

    await expect(h.notifier.notifyCollaboratorRemoved(removed)).resolves.toBeUndefined();
  });

  it("never throws on a network failure", async () => {
    console.error = () => {};
    const h = harness();
    h.respond(() => {
      throw new Error("connection refused");
    });

    await expect(h.notifier.notifyCollaboratorRemoved(removed)).resolves.toBeUndefined();
  });

  it("resolves and sends nothing when the token provider rejects", async () => {
    console.error = () => {};
    const h = harness({
      getToken: async () => {
        throw new ServiceTokenError("auth /system/service-token responded with HTTP 503");
      },
    });

    await expect(h.notifier.notifyCollaboratorRemoved(removed)).resolves.toBeUndefined();

    expect(h.calls.length).toBe(0);
  });
});
