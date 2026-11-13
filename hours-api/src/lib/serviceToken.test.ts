/**
 * Service-token client (specs/029 T10; ADR-0044/0049, ADR-0089): the byte-identical provider the
 * suite's services share, proved in this tree, and the one hours-api wires from its environment
 * (`SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET`) to read a meeting's current deal as itself.
 * `auth` is a stubbed `fetch`; time is an injected clock.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { env } from "./env";
import { createServiceTokenProvider, serviceTokens } from "./serviceToken";

const SECRET = "s3cret-value-that-must-never-be-logged-0123456789";
const BASE = "http://auth.test";

function harness(opts: { ttl?: number } = {}) {
  let now = 1_000_000;
  let n = 0;
  const calls: { url: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  let impl: (call: number) => Promise<Response> = async (call) =>
    Response.json({ token: `tok-${call}`, expiresInSeconds: opts.ttl ?? 300 });
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    n++;
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), init: init! });
    return impl(n);
  }) as unknown as typeof fetch;
  const provider = createServiceTokenProvider({
    baseUrl: BASE,
    clientId: "hours-api",
    clientSecret: SECRET,
    fetchImpl,
    now: () => now,
  });
  return {
    provider,
    calls,
    advance: (ms: number) => void (now += ms),
    respond: (fn: (call: number) => Promise<Response>) => void (impl = fn),
  };
}

describe("getToken", () => {
  it("posts the client credentials to auth /system/service-token with a timeout and no redirects", async () => {
    const h = harness();
    expect(await h.provider.getToken()).toBe("tok-1");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(`${BASE}/system/service-token`);
    expect(h.calls[0]!.init.method).toBe("POST");
    expect(h.calls[0]!.body).toEqual({ clientId: "hours-api", clientSecret: SECRET });
    expect(h.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    // The body carries the secret: a redirect would replay it to another host.
    expect(h.calls[0]!.init.redirect).toBe("error");
  });

  it("reuses the token within its lifetime and refetches 60 s before expiry", async () => {
    const h = harness({ ttl: 300 });
    expect(await h.provider.getToken()).toBe("tok-1");
    h.advance(239_000); // 61 s left
    expect(await h.provider.getToken()).toBe("tok-1");
    expect(h.calls).toHaveLength(1);
    h.advance(1_000); // 60 s left: inside the safety margin
    expect(await h.provider.getToken()).toBe("tok-2");
    expect(h.calls).toHaveLength(2);
  });

  it("single-flights concurrent refreshes", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.respond(async (call) => {
      await gate;
      return Response.json({ token: `tok-${call}`, expiresInSeconds: 300 });
    });
    const all = Promise.all([h.provider.getToken(), h.provider.getToken(), h.provider.getToken()]);
    release();
    expect(await all).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(h.calls).toHaveLength(1);
  });

  it("a failed refresh is not cached: the next call tries again", async () => {
    const h = harness();
    h.respond(async () => new Response("no", { status: 500 }));
    await expect(h.provider.getToken()).rejects.toThrow();
    h.respond(async (call) => Response.json({ token: `tok-${call}`, expiresInSeconds: 300 }));
    expect(await h.provider.getToken()).toBe("tok-2");
  });

  it("rejects on a 401, a network error, and a body it cannot use", async () => {
    for (const impl of [
      async () => new Response("{}", { status: 401 }),
      async () => {
        throw new TypeError("connect ECONNREFUSED");
      },
      async () => Response.json({ nope: true }),
      async () => Response.json({ token: "", expiresInSeconds: 300 }),
      async () => Response.json({ token: "t", expiresInSeconds: "300" }),
      async () => new Response("<html>", { status: 200 }),
    ]) {
      const h = harness();
      h.respond(impl);
      await expect(h.provider.getToken()).rejects.toThrow();
    }
  });

  it("a token that lives no longer than the margin is usable once but never cached", async () => {
    const h = harness({ ttl: 30 });
    expect(await h.provider.getToken()).toBe("tok-1");
    expect(await h.provider.getToken()).toBe("tok-2");
  });

  it("error messages and logs never carry the secret or a token", async () => {
    const h = harness();
    const logs = [spyOn(console, "error"), spyOn(console, "warn"), spyOn(console, "log")];
    h.respond(async () => new Response(`echo ${SECRET}`, { status: 500 }));
    try {
      const err = await h.provider.getToken().then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBeNull();
      expect(String(err!.message)).not.toContain(SECRET);
      expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain(SECRET);
    } finally {
      for (const l of logs) l.mockRestore();
    }
  });
});

describe("invalidate", () => {
  it("drops the cached token so the next call fetches a new one", async () => {
    const h = harness();
    expect(await h.provider.getToken()).toBe("tok-1");
    h.provider.invalidate("tok-1");
    expect(await h.provider.getToken()).toBe("tok-2");
  });

  it("ignores a stale token: a fresh one cached meanwhile is kept", async () => {
    const h = harness();
    expect(await h.provider.getToken()).toBe("tok-1");
    h.provider.invalidate("tok-1");
    expect(await h.provider.getToken()).toBe("tok-2");
    h.provider.invalidate("tok-1"); // a late 401 about the old token
    expect(await h.provider.getToken()).toBe("tok-2");
    expect(h.calls).toHaveLength(2);
  });
});

describe("the provider hours-api wires from its environment", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is always there (the credential is required at start) and mints as hours-api against AUTH_BASE_URL", async () => {
    let seen: { url: string; body: unknown } | undefined;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return Response.json({ token: "minted", expiresInSeconds: 300 });
    }) as typeof fetch;
    expect(await serviceTokens.getToken()).toBe("minted");
    expect(seen).toEqual({
      url: `${env.AUTH_BASE_URL}/system/service-token`,
      body: { clientId: env.SERVICE_CLIENT_ID, clientSecret: env.SERVICE_CLIENT_SECRET },
    });
    serviceTokens.invalidate("minted");
  });

  it("follows the environment at call time, so a test can point it at its own fake auth (env is mutable on purpose)", async () => {
    const before = env.AUTH_BASE_URL;
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return Response.json({ token: `minted-${urls.length}`, expiresInSeconds: 300 });
    }) as typeof fetch;
    try {
      env.AUTH_BASE_URL = "http://fake-auth.test";
      expect(await serviceTokens.getToken()).toBe("minted-1");
      expect(urls).toEqual(["http://fake-auth.test/system/service-token"]);
    } finally {
      env.AUTH_BASE_URL = before;
      serviceTokens.invalidate("minted-1");
    }
  });
});
