import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as client from "./client";
import { resolve, sendNotice } from "./client";
import type { HostDefinition, HostNotice } from "./registry";
import type { ServiceTokenProvider } from "../lib/serviceToken";
import { startFakeHost } from "../test-support/fakeHost";

const fake = startFakeHost();
const [widget, gadget] = fake.definitions as [HostDefinition, HostDefinition];
afterAll(() => fake.stop());

let logged: string[];
let errSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fake.reset();
  logged = [];
  const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  errSpy = spyOn(console, "error").mockImplementation(capture);
  warnSpy = spyOn(console, "warn").mockImplementation(capture);
});
afterEach(() => {
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

const AUTH = "Bearer caller-jwt";

// ─── The module's whole surface ──────────────────────────────────────────────

describe("the client module (AC-11.10: a host is called for these two things only)", () => {
  it("exports only resolve and sendNotice at runtime", () => {
    expect(Object.keys(client).sort()).toEqual(["resolve", "sendNotice"]);
  });

  it("declares no other value export in its source (static assertion)", () => {
    const source = readFileSync(join(import.meta.dir, "client.ts"), "utf8");
    const valueExports = [...source.matchAll(/^export\s+(?!type\b|interface\b)(.*)$/gm)].map((m) => m[1]!.trim());
    expect(valueExports.map((line) => line.replace(/\(.*$/, "").trim())).toEqual(["async function resolve", "async function sendNotice"]);
  });
});

// ─── resolve ─────────────────────────────────────────────────────────────────

describe("resolve", () => {
  it("answers open, closed and missing, with title, href and hostVisible only for open", async () => {
    fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1", hostVisible: true });
    fake.setEntity("widget", "w2", { title: "Hidden", href: "/testhost/widgets/w2", state: "closed" });
    const result = await resolve(widget, AUTH, ["w1", "w2", "w3"]);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.entities.get("w1")).toEqual({ state: "open", title: "Widget one", href: "/testhost/widgets/w1", hostVisible: true });
    expect(result.entities.get("w2")).toEqual({ state: "closed" });
    expect(result.entities.get("w3")).toEqual({ state: "missing" });
  });

  it("forwards the caller's Authorization header verbatim and names the entity type", async () => {
    fake.setEntity("widget", "w1", { title: "T", href: "/x" });
    await resolve(widget, AUTH, ["w1"]);
    expect(fake.resolves).toHaveLength(1);
    expect(fake.resolves[0]).toMatchObject({
      path: "/testhost/meeting-host/v1/resolve",
      authorization: AUTH,
      body: { entityType: "widget", ids: ["w1"] },
    });
  });

  it("batches at most 25 ids per call and merges the answers", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `w${i}`);
    for (const id of ids) fake.setEntity("widget", id, { title: id, href: `/w/${id}` });
    const result = await resolve(widget, AUTH, ids);
    expect(fake.resolves.map((r) => r.body.ids.length)).toEqual([25, 25, 10]);
    expect(result.state === "ok" && result.entities.size).toBe(60);
  });

  it("asks once for a repeated id", async () => {
    fake.setEntity("widget", "w1", { title: "T", href: "/x" });
    await resolve(widget, AUTH, ["w1", "w1", "w1"]);
    expect(fake.resolves[0]!.body.ids).toEqual(["w1"]);
  });

  it("makes no call for no ids", async () => {
    const result = await resolve(widget, AUTH, []);
    expect(result).toEqual({ state: "ok", entities: new Map() });
    expect(fake.resolves).toHaveLength(0);
  });

  it("is unavailable when ANY batch fails: a partial answer is not an answer", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `w${i}`);
    for (const id of ids) fake.setEntity("widget", id, { title: id, href: "/x" });
    let calls = 0;
    const real = fetch;
    const spy = spyOn(globalThis, "fetch").mockImplementation(((url: unknown, init?: RequestInit) =>
      ++calls === 2 ? Promise.resolve(new Response(null, { status: 503 })) : real(url as string, init)) as unknown as typeof fetch);
    try {
      expect((await resolve(widget, AUTH, ids)).state).toBe("unavailable");
    } finally {
      spy.mockRestore();
    }
  });

  for (const status of [500, 502, 503, 401, 403, 404, 422]) {
    it(`maps a ${status} to unavailable`, async () => {
      fake.mode.resolve = { status };
      expect((await resolve(widget, AUTH, ["w1"])).state).toBe("unavailable");
    });
  }

  it("maps a timeout to unavailable", async () => {
    fake.mode.resolve = { delayMs: 400 };
    const started = Date.now();
    expect((await resolve(widget, AUTH, ["w1"], { timeoutMs: 100 })).state).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(380);
  });

  it("maps a transport error to unavailable", async () => {
    const dead = { ...widget, baseUrl: "http://127.0.0.1:1" };
    expect((await resolve(dead, AUTH, ["w1"])).state).toBe("unavailable");
  });

  it("maps a malformed body to unavailable", async () => {
    fake.mode.resolve = { malformed: true };
    expect((await resolve(widget, AUTH, ["w1"])).state).toBe("unavailable");
  });

  describe("a body that breaks the contract", () => {
    const answer = (body: unknown, status = 200) => {
      const spy = spyOn(globalThis, "fetch").mockResolvedValue(
        typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }),
      );
      return spy;
    };
    const cases: [string, unknown][] = [
      ["not JSON", "<html>oops</html>"],
      ["no items", {}],
      ["items is not an array", { items: {} }],
      ["an unknown state", { items: [{ id: "w1", state: "maybe" }] }],
      ["an item without an id", { items: [{ state: "closed" }] }],
      ["a title that is not a string", { items: [{ id: "w1", state: "open", title: 5, href: "/x" }] }],
      ["an absolute href", { items: [{ id: "w1", state: "open", title: "T", href: "https://evil.example/x" }] }],
      ["a protocol-relative href", { items: [{ id: "w1", state: "open", title: "T", href: "//evil.example/x" }] }],
      ["a script href", { items: [{ id: "w1", state: "open", title: "T", href: "javascript:alert(1)" }] }],
      ["an open item with no title or href", { items: [{ id: "w1", state: "open" }] }],
      ["a missing answer for an id that was asked", { items: [] }],
    ];
    for (const [name, body] of cases) {
      it(`is unavailable for ${name}`, async () => {
        const spy = answer(body);
        try {
          expect((await resolve(widget, AUTH, ["w1"])).state).toBe("unavailable");
        } finally {
          spy.mockRestore();
        }
      });
    }

    it("ignores an answer about an id that was not asked", async () => {
      const spy = answer({ items: [{ id: "w1", state: "closed" }, { id: "intruder", state: "open", title: "T", href: "/x" }] });
      try {
        const result = await resolve(widget, AUTH, ["w1"]);
        expect(result.state === "ok" && [...result.entities.keys()]).toEqual(["w1"]);
      } finally {
        spy.mockRestore();
      }
    });

    it("drops title, href and hostVisible that a host sends for a closed entity", async () => {
      const spy = answer({ items: [{ id: "w1", state: "closed", title: "Leaked", href: "/x", hostVisible: true }] });
      try {
        const result = await resolve(widget, AUTH, ["w1"]);
        expect(result.state === "ok" && result.entities.get("w1")).toEqual({ state: "closed" });
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("does not follow a redirect: the caller's token would travel with it", async () => {
    let redirect: string | undefined;
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      redirect = init?.redirect;
      throw new TypeError("redirect");
    }) as unknown as typeof fetch);
    try {
      expect((await resolve(widget, AUTH, ["w1"])).state).toBe("unavailable");
    } finally {
      spy.mockRestore();
    }
    expect(redirect).toBe("error");
  });

  it("never throws and logs no title, id or token", async () => {
    fake.mode.resolve = { status: 500 };
    await resolve(widget, "Bearer token-secret-value", ["CANARY-ENTITY-ID"]);
    const text = logged.join("\n");
    expect(text).not.toContain("token-secret-value");
    expect(text).not.toContain("CANARY-ENTITY-ID");
  });
});

// ─── sendNotice ──────────────────────────────────────────────────────────────

function tokens(issued: string[] = ["svc-1", "svc-2"]) {
  const invalidated: string[] = [];
  let n = 0;
  const provider: ServiceTokenProvider = {
    async getToken() {
      return issued[Math.min(n++, issued.length - 1)]!;
    },
    invalidate(token) {
      invalidated.push(token);
    },
  };
  return { provider, invalidated };
}

const notice = (overrides: Partial<HostNotice> = {}): HostNotice => ({
  noticeId: crypto.randomUUID(),
  seq: 1,
  event: "linked",
  meeting: { id: "m1", title: "Kickoff", startsAt: "2026-11-04T09:00:00.000Z", creatorId: "user-1" },
  entity: { type: "widget", id: "w1" },
  ...overrides,
});

describe("sendNotice", () => {
  beforeEach(() => fake.setEntity("widget", "w1", { title: "Widget", href: "/x" }));

  it("posts the strict body with the service token and reports delivered", async () => {
    const n = notice();
    const result = await sendNotice(widget, n, tokens().provider);
    expect(result).toEqual({ state: "delivered", applied: true });
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]).toMatchObject({ path: "/testhost/system/meeting-host/v1/notices", authorization: "Bearer svc-1" });
    expect(fake.notices[0]!.body).toEqual(n as unknown as Record<string, unknown>);
    expect(Object.keys(fake.notices[0]!.body).sort()).toEqual(["entity", "event", "meeting", "noticeId", "seq"]);
  });

  it("sends title and startsAt as null for unlinked and deleted, verbatim", async () => {
    for (const event of ["unlinked", "deleted"] as const) {
      const n = notice({ event, seq: event === "unlinked" ? 2 : 3, meeting: { id: "m1", title: null, startsAt: null, creatorId: "user-1" } });
      expect(await sendNotice(widget, n, tokens().provider)).toEqual({ state: "delivered", applied: true });
      expect((fake.notices.at(-1)!.body["meeting"] as Record<string, unknown>)["title"]).toBeNull();
    }
  });

  it("a duplicate or reordered notice is delivered with applied: false (AC-14.9)", async () => {
    await sendNotice(widget, notice({ seq: 5 }), tokens().provider);
    expect(await sendNotice(widget, notice({ seq: 4 }), tokens().provider)).toEqual({ state: "delivered", applied: false });
  });

  it("an unknown entity is a PERMANENT failure", async () => {
    const result = await sendNotice(widget, notice({ entity: { type: "widget", id: "gone" } }), tokens().provider);
    expect(result).toEqual({ state: "failed", permanent: true, code: "entity_not_found" });
  });

  it("a 422 that is not entity_not_found means the body itself is refused: PERMANENT, retrying cannot fix it", async () => {
    fake.mode.notices = { status: 422 };
    expect(await sendNotice(widget, notice(), tokens().provider)).toEqual({ state: "failed", permanent: true, code: "rejected" });
  });

  it("a 403 (a scope an operator can still grant) stays retryable", async () => {
    fake.mode.notices = { status: 403 };
    expect(await sendNotice(widget, notice(), tokens().provider)).toEqual({ state: "failed", permanent: false, code: "rejected" });
  });

  for (const status of [500, 502, 503]) {
    it(`a ${status} is a transient failure`, async () => {
      fake.mode.notices = { status };
      expect(await sendNotice(widget, notice(), tokens().provider)).toEqual({ state: "failed", permanent: false, code: "unavailable" });
    });
  }

  it("a timeout is a transient failure (the awaited attempt is bounded)", async () => {
    fake.mode.notices = { delayMs: 400 };
    const started = Date.now();
    const result = await sendNotice(widget, notice(), tokens().provider, { timeoutMs: 100 });
    expect(result).toEqual({ state: "failed", permanent: false, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(380);
  });

  it("a malformed 200 is a transient failure", async () => {
    fake.mode.notices = { malformed: true };
    expect(await sendNotice(widget, notice(), tokens().provider)).toEqual({ state: "failed", permanent: false, code: "malformed" });
  });

  it("a transport error is a transient failure", async () => {
    const dead = { ...widget, baseUrl: "http://127.0.0.1:1" };
    expect(await sendNotice(dead, notice(), tokens().provider)).toEqual({ state: "failed", permanent: false, code: "unavailable" });
  });

  it("on one 401 drops the cached token and retries once with a fresh one", async () => {
    const t = tokens();
    let first = true;
    const real = fetch;
    const spy = spyOn(globalThis, "fetch").mockImplementation(((url: unknown, init?: RequestInit) => {
      if (first) {
        first = false;
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return real(url as string, init);
    }) as unknown as typeof fetch);
    try {
      expect(await sendNotice(widget, notice(), t.provider)).toEqual({ state: "delivered", applied: true });
    } finally {
      spy.mockRestore();
    }
    expect(t.invalidated).toEqual(["svc-1"]);
    expect(fake.notices[0]!.authorization).toBe("Bearer svc-2");
  });

  it("a second 401 is a transient failure, not a loop", async () => {
    fake.mode.notices = { status: 401 };
    const t = tokens();
    expect(await sendNotice(widget, notice(), t.provider)).toEqual({ state: "failed", permanent: false, code: "unauthorized" });
    expect(fake.notices).toHaveLength(2);
  });

  it("sends nothing to a host that takes no notices, and says so permanently", async () => {
    const result = await sendNotice(gadget, notice({ entity: { type: "gadget", id: "g1" } }), tokens().provider);
    expect(result).toEqual({ state: "failed", permanent: true, code: "notices_not_supported" });
    expect(fake.quietNoticeAttempts).toHaveLength(0);
  });

  it("without a service-token provider it fails transiently, without a request", async () => {
    expect(await sendNotice(widget, notice(), null)).toEqual({ state: "failed", permanent: false, code: "unavailable" });
    expect(fake.notices).toHaveLength(0);
  });

  it("when the token cannot be minted it fails transiently", async () => {
    const broken: ServiceTokenProvider = {
      async getToken() {
        throw new Error("auth /system/service-token responded with HTTP 401");
      },
      invalidate() {},
    };
    expect(await sendNotice(widget, notice(), broken)).toEqual({ state: "failed", permanent: false, code: "unavailable" });
  });

  it("never throws, and logs neither the title nor the token", async () => {
    fake.mode.notices = { status: 500 };
    await sendNotice(widget, notice({ meeting: { id: "m1", title: "CANARY-TITLE", startsAt: null, creatorId: "u" } }), tokens(["svc-secret-value"]).provider);
    const text = logged.join("\n");
    expect(text).not.toContain("CANARY-TITLE");
    expect(text).not.toContain("svc-secret-value");
  });
});
