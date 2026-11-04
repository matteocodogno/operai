import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createNotifier, notificationLink, recipientsOf, type NotifyEvent } from "./notify";
import type { ServiceTokenProvider } from "./serviceToken";

const event: NotifyEvent = {
  kind: "transcription_done",
  meetingId: "m1",
  meetingTitle: "Budget review",
  actorId: "actor",
  recipientIds: ["actor", "a", "b", "a", null, undefined, ""],
};

function harness(statuses: (number | "throw")[] = [201], tokensIssued: string[] = ["t1", "t2"]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const invalidated: string[] = [];
  let issued = 0;
  const tokens: ServiceTokenProvider = {
    async getToken() {
      return tokensIssued[Math.min(issued++, tokensIssued.length - 1)]!;
    },
    invalidate(token) {
      invalidated.push(token);
    },
  };
  const queue = [...statuses];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next === "throw") throw new Error("connect ECONNREFUSED");
    return new Response(null, { status: next });
  }) as typeof fetch;
  return { calls, invalidated, notifier: createNotifier({ baseUrl: "http://notify.test", tokens, fetchImpl }) };
}

let logged: string[];
let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logged = [];
  errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(() => errSpy.mockRestore());

describe("recipientsOf", () => {
  it("is distinct, without the actor and without empty ids", () => {
    expect(recipientsOf(event).sort()).toEqual(["a", "b"]);
  });
});

describe("meetings-api notifier", () => {
  it("posts one request per recipient with the contract's shape, never to the actor", async () => {
    const { calls, notifier } = harness();
    await notifier.notify(event);
    expect(calls.map((c) => c.body["recipientId"]).sort()).toEqual(["a", "b"]);
    expect(calls[0]).toMatchObject({
      url: "http://notify.test/system/notifications",
      headers: { Authorization: "Bearer t1", "Content-Type": "application/json" },
      body: {
        originApp: "meetings",
        severity: "success",
        link: { href: "/my-meetings/m/m1" },
      },
    });
  });

  it("sends the English text and the Italian variant (AC-12.5)", async () => {
    const { calls, notifier } = harness();
    await notifier.notify({ ...event, recipientIds: ["a"] });
    const body = calls[0]!.body as { title: string; body: string; it: { title: string; body: string } };
    expect(body.title).toContain("Budget review");
    expect(body.it.title).toContain("Budget review");
    expect(body.it.title).not.toBe(body.title);
    expect(typeof body.it.body).toBe("string");
  });

  it("only ever sends allowlisted keys: no content keys, and email is never set (AC-12.4)", async () => {
    const { calls, notifier } = harness();
    await notifier.notify(event);
    const allowed = ["recipientId", "originApp", "severity", "title", "body", "link", "it"];
    for (const call of calls) {
      expect(Object.keys(call.body).every((k) => allowed.includes(k))).toBe(true);
      expect("email" in call.body).toBe(false);
      expect(Object.keys(call.body.link as object)).toEqual(["href"]);
      expect(Object.keys(call.body.it as object).sort()).toEqual(["body", "title"]);
    }
  });

  it("links every kind to the route that works for every visibility class", () => {
    expect(notificationLink("m42")).toBe("/my-meetings/m/m42");
  });

  it("does not reject when notify-api answers 500", async () => {
    const { notifier } = harness([500]);
    await expect(notifier.notify(event)).resolves.toBeUndefined();
    expect(logged.join("\n")).toContain("500");
  });

  it("does not reject when the request throws", async () => {
    const { notifier } = harness(["throw"]);
    await expect(notifier.notify(event)).resolves.toBeUndefined();
  });

  it("does not reject when the token cannot be minted", async () => {
    const tokens: ServiceTokenProvider = {
      async getToken() {
        throw new Error("auth /system/service-token responded with HTTP 401");
      },
      invalidate() {},
    };
    const notifier = createNotifier({ baseUrl: "http://notify.test", tokens, fetchImpl: (async () => new Response(null)) as unknown as typeof fetch });
    await expect(notifier.notify(event)).resolves.toBeUndefined();
  });

  it("on one 401 drops the cached token and retries once with a fresh one", async () => {
    const { calls, invalidated, notifier } = harness([401, 201]);
    await notifier.notify({ ...event, recipientIds: ["a"] });
    expect(invalidated).toEqual(["t1"]);
    expect(calls.map((c) => c.headers["Authorization"])).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("gives up after the one retry: a second 401 is logged, not looped", async () => {
    const { calls, notifier } = harness([401]);
    await notifier.notify({ ...event, recipientIds: ["a"] });
    expect(calls).toHaveLength(2);
    expect(logged.join("\n")).toContain("401");
  });

  it("keeps going for the other recipients when one push fails", async () => {
    const { calls, notifier } = harness([500, 201]);
    await notifier.notify(event);
    expect(calls).toHaveLength(2);
  });

  it("logs the kind and the meeting id, never the title or a token", async () => {
    const { notifier } = harness([500], ["token-secret-value"]);
    await notifier.notify({ ...event, meetingTitle: "CANARY-TITLE", recipientIds: ["a"] });
    const text = logged.join("\n");
    expect(text).toContain("transcription_done");
    expect(text).not.toContain("CANARY-TITLE");
    expect(text).not.toContain("token-secret-value");
  });

  it("sends nothing when there is nobody to tell", async () => {
    const { calls, notifier } = harness();
    await notifier.notify({ ...event, recipientIds: ["actor"] });
    expect(calls).toHaveLength(0);
  });
});
