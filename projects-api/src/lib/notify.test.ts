/**
 * The after-take push to notify-api (specs/022 T25; AC-4.3, AC-4.4): `createNotifier` posts one
 * notification to `POST /system/notifications` as the service principal, best-effort — nothing it
 * does throws, and nothing it logs carries a token, a title, a name or contact data. The network is
 * a recording `fetch` handed to the notifier; the routes' own wiring is tested in queue/take.test.ts.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  announcePurchaseOrderAssigned,
  clip,
  createNotifier,
  notifierFromEnv,
  resetNotifierForTests,
  setNotifierForTests,
  type Notifier,
  type NotifyEvent,
} from "./notify";
import { ServiceTokenError, type ServiceTokenProvider } from "./serviceToken";

const EVENT: NotifyEvent = {
  kind: "purchase_order_assigned",
  projectId: "proj-1",
  recipientId: "user-ops",
  severity: "info",
  title: "Purchase order assigned: Secret Portal Name",
  body: "Acme Secret SA — pick the project manager of this project.",
  href: "/projects/proj-1",
};

/** A token provider that mints `token-1`, `token-2`, … and remembers what was invalidated. */
function fakeTokens() {
  let minted = 0;
  const invalidated: string[] = [];
  const provider: ServiceTokenProvider = {
    async getToken() {
      return `token-${++minted}`;
    },
    invalidate(token) {
      invalidated.push(token);
    },
  };
  return { provider, invalidated, minted: () => minted };
}

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** A `fetch` that records every request and answers from `answers` in order (the last one repeats). */
function recordingFetch(...answers: (number | Error | (() => Promise<Response>))[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      authorization: new Headers(init?.headers).get("Authorization"),
      body: JSON.parse(String(init?.body)),
    });
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)] ?? 201;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    return new Response(JSON.stringify({ id: "n-1" }), { status: answer });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

/** Everything the code under test writes to the console while `run` runs. */
async function logged(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  const spies = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")].map((spy) => spy.mockImplementation(record));
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines;
}

describe("createNotifier(...).notify — the request", () => {
  it("posts one notification to notify-api's system route as the service principal, in the shape of the contract", async () => {
    const tokens = fakeTokens();
    const { fetchImpl, seen } = recordingFetch(201);
    await createNotifier({ baseUrl: "http://notify.test", tokens: tokens.provider, fetchImpl }).notify(EVENT);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      url: "http://notify.test/system/notifications",
      method: "POST",
      authorization: "Bearer token-1",
      body: {
        recipientId: "user-ops",
        originApp: "projects",
        severity: "info",
        title: "Purchase order assigned: Secret Portal Name",
        body: "Acme Secret SA — pick the project manager of this project.",
        link: { href: "/projects/proj-1" },
      },
    });
  });
});

describe("createNotifier(...).notify — a rejected token", () => {
  it("drops the cached token and retries ONCE with a fresh one on a 401", async () => {
    const tokens = fakeTokens();
    const { fetchImpl, seen } = recordingFetch(401, 201);
    await createNotifier({ baseUrl: "http://notify.test", tokens: tokens.provider, fetchImpl }).notify(EVENT);

    expect(seen.map((request) => request.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(tokens.invalidated).toEqual(["token-1"]);
  });

  it("gives up after that one retry: a second 401 is logged, not retried again", async () => {
    const tokens = fakeTokens();
    const { fetchImpl, seen } = recordingFetch(401);
    const lines = await logged(() => createNotifier({ baseUrl: "http://notify.test", tokens: tokens.provider, fetchImpl }).notify(EVENT));

    expect(seen).toHaveLength(2);
    expect(lines.join("\n")).toContain("HTTP 401");
  });
});

describe("createNotifier(...).notify — best-effort, and silent about what it carries", () => {
  /** Everything a log line must never hold: a token, the title, any name, the recipient. */
  const SECRETS = /token-\d|Secret Portal Name|Acme Secret|Bearer|user-ops/;

  it("logs an HTTP failure as the event kind, the project id and the status — nothing else — and does not throw", async () => {
    const tokens = fakeTokens();
    const { fetchImpl } = recordingFetch(503);
    const lines = await logged(() => createNotifier({ baseUrl: "http://notify.test", tokens: tokens.provider, fetchImpl }).notify(EVENT));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("purchase_order_assigned");
    expect(lines[0]).toContain("proj-1");
    expect(lines[0]).toContain("HTTP 503");
    expect(lines[0]).not.toMatch(SECRETS);
  });

  it("swallows a network error and logs its name only", async () => {
    const tokens = fakeTokens();
    const failure = new Error("connect ECONNREFUSED http://notify.test with Bearer token-1");
    failure.name = "ConnectionRefused";
    const { fetchImpl } = recordingFetch(failure);
    const lines = await logged(() => createNotifier({ baseUrl: "http://notify.test", tokens: tokens.provider, fetchImpl }).notify(EVENT));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ConnectionRefused");
    expect(lines[0]).toContain("proj-1");
    expect(lines[0]).not.toMatch(SECRETS);
    expect(lines[0]).not.toContain("ECONNREFUSED");
  });

  it("swallows a service-token failure and logs its status only", async () => {
    const provider: ServiceTokenProvider = {
      async getToken() {
        throw new ServiceTokenError("auth /system/service-token responded with HTTP 503");
      },
      invalidate() {},
    };
    const { fetchImpl, seen } = recordingFetch(201);
    const lines = await logged(() => createNotifier({ baseUrl: "http://notify.test", tokens: provider, fetchImpl }).notify(EVENT));

    expect(seen).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HTTP 503");
    expect(lines[0]).not.toMatch(SECRETS);
  });

  it("gives up on a notify-api that never answers once the timeout passes, and does not throw", async () => {
    const tokens = fakeTokens();
    const hangs = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      })) as typeof fetch;
    const lines = await logged(() => createNotifier({ baseUrl: "http://notify.test", tokens: tokens.provider, fetchImpl: hangs, timeoutMs: 20 }).notify(EVENT));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TimeoutError");
  });

  it("refuses a redirect, as it would replay the credential to another host", async () => {
    const tokens = fakeTokens();
    let redirect: RequestInit["redirect"];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    await createNotifier({ baseUrl: "http://notify.test", tokens: tokens.provider, fetchImpl }).notify(EVENT);
    expect(redirect).toBe("error");
  });
});

describe("notifierFromEnv — when the wired notifier exists", () => {
  const tokens = fakeTokens().provider;

  it("is a notifier with the URL and the service credential, outside the test environment", () => {
    expect(notifierFromEnv({ NODE_ENV: "production", NOTIFY_INTERNAL_URL: "http://notify.test" }, tokens)).not.toBeNull();
    expect(notifierFromEnv({ NODE_ENV: "development", NOTIFY_INTERNAL_URL: "http://notify.test" }, tokens)).not.toBeNull();
  });

  it("is none when NOTIFY_INTERNAL_URL is unset (AC-4.4: the take is unaffected)", () => {
    expect(notifierFromEnv({ NODE_ENV: "production", NOTIFY_INTERNAL_URL: undefined }, tokens)).toBeNull();
  });

  it("is none without a service credential", () => {
    expect(notifierFromEnv({ NODE_ENV: "production", NOTIFY_INTERNAL_URL: "http://notify.test" }, null)).toBeNull();
  });

  it("is none under NODE_ENV=test, whatever else is set: a route test must never push for real", () => {
    expect(notifierFromEnv({ NODE_ENV: "test", NOTIFY_INTERNAL_URL: "http://notify.test" }, tokens)).toBeNull();
  });
});

describe("announcePurchaseOrderAssigned — the copy and the hand-over", () => {
  afterEach(resetNotifierForTests);

  const recording = () => {
    const events: NotifyEvent[] = [];
    const notifier: Notifier = {
      async notify(event) {
        events.push(event);
      },
    };
    setNotifierForTests(notifier);
    return events;
  };
  const ORDER = { projectId: "proj-1", projectName: "Portal 2027", companyName: "Acme SA", opsManagerId: "user-ops" };

  it("hands the notifier one event for the ops-manager, in English, linking to the project (AC-4.3, D51)", () => {
    const events = recording();
    announcePurchaseOrderAssigned(ORDER);
    expect(events).toEqual([
      {
        kind: "purchase_order_assigned",
        projectId: "proj-1",
        recipientId: "user-ops",
        severity: "info",
        title: "Purchase order assigned: Portal 2027",
        body: "Acme SA — pick the project manager of this project.",
        href: "/projects/proj-1",
      },
    ]);
  });

  it("clips the user-entered names so title and body stay inside notify-api's 200 and 2000 characters, copy intact", () => {
    const events = recording();
    announcePurchaseOrderAssigned({ ...ORDER, projectName: "P".repeat(200), companyName: "C".repeat(5000) });
    const [event] = events;
    expect(event!.title.length).toBeLessThanOrEqual(200);
    expect(event!.title.startsWith("Purchase order assigned: PPP")).toBe(true);
    expect(event!.title.endsWith("…")).toBe(true);
    expect(event!.body.length).toBeLessThanOrEqual(2000);
    expect(event!.body.startsWith("CCC")).toBe(true);
    expect(event!.body.endsWith("… — pick the project manager of this project.")).toBe(true);
  });

  it("leaves a name that fits untouched", () => {
    expect(clip("Portal", 10)).toBe("Portal");
    expect(clip("0123456789", 10)).toBe("0123456789");
    expect(clip("01234567890", 10)).toBe("012345678…");
  });

  it("does nothing, and does not throw, when no notifier is wired", () => {
    setNotifierForTests(null);
    expect(announcePurchaseOrderAssigned(ORDER)).toBeUndefined();
  });

  it("returns at once, without waiting for a delivery that never finishes", () => {
    setNotifierForTests({ notify: () => new Promise<void>(() => {}) });
    expect(announcePurchaseOrderAssigned(ORDER)).toBeUndefined();
  });

  it("never throws, whether the notifier throws at once or returns a rejection", async () => {
    setNotifierForTests({
      notify() {
        throw new Error("boom");
      },
    });
    expect(() => announcePurchaseOrderAssigned(ORDER)).not.toThrow();

    // A `Notifier` never rejects; a rejection would still be swallowed (`bun test` cannot see an unhandled one).
    setNotifierForTests({ notify: () => Promise.reject(new Error("boom")) });
    expect(() => announcePurchaseOrderAssigned(ORDER)).not.toThrow();
    await Bun.sleep(0);
  });
});
