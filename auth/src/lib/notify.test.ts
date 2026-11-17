/**
 * Unit tests for the invitation email client (T7, specs/20261013-notify-service-credentials — refs AC-1.4,
 * AC-4.3, AC-5.2; ADR 20261013-auth-mints-own-service-credential-in-process): the call carries `auth`'s own service JWT as a
 * Bearer token, never the retired shared token, and every failure is
 * surfaced as `{ status: "failed" }` instead of a throw.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { env } = await import("./env");
const { sendInvitationEmail, setNotifyTokenProvider } = await import("./notify");

const INPUT = {
  to: "new.hire@example.com",
  template: "invitation",
  inviteUrl: "https://auth.example/invite?token=abc",
  inviterName: "Ada Admin",
  expiresAt: "2026-11-01T00:00:00.000Z",
} as const;

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function stubFetch(respond: () => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
}

const sentResponse = () => Response.json({ deliveryId: "del_1", status: "sent" });

beforeEach(() => {
  setNotifyTokenProvider({ getToken: async () => "provider-token", invalidate: () => {} });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("sendInvitationEmail", () => {
  test("sends Authorization: Bearer <provider token> and no X-Internal-Token", async () => {
    stubFetch(sentResponse);
    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ status: "sent", deliveryId: "del_1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${env.NOTIFY_INTERNAL_URL}/system/emails`);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-token");
    expect(headers.has("x-internal-token")).toBe(false);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      to: INPUT.to,
      template: INPUT.template,
      data: { inviteUrl: INPUT.inviteUrl, inviterName: INPUT.inviterName, expiresAt: INPUT.expiresAt },
    });
  });

  test("a provider failure returns failed and never calls notify-api", async () => {
    setNotifyTokenProvider({
      getToken: async () => {
        throw new Error("signer unavailable");
      },
      invalidate: () => {},
    });
    stubFetch(sentResponse);

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ status: "failed", error: "Error" });
    expect(calls).toHaveLength(0);
  });

  test("no configured provider returns failed and never calls notify-api", async () => {
    setNotifyTokenProvider(undefined);
    stubFetch(sentResponse);

    const result = await sendInvitationEmail(INPUT);

    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  test("a non-2xx response returns failed with the status code", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    expect(await sendInvitationEmail(INPUT)).toEqual({
      status: "failed",
      error: "notify-api responded with HTTP 401",
    });
  });

  test("a network error returns failed", async () => {
    stubFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await sendInvitationEmail(INPUT)).toEqual({ status: "failed", error: "Error" });
  });

  test("an unexpected 200 body returns failed", async () => {
    stubFetch(() => Response.json({ status: "queued" }));
    const result = await sendInvitationEmail(INPUT);
    expect(result.status).toBe("failed");
  });
});

describe("sendInvitationEmail — one retry on 401 (AC-4.3, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired)", () => {
  function sequencedProvider() {
    const issued: string[] = [];
    const invalidated: string[] = [];
    let n = 0;
    setNotifyTokenProvider({
      getToken: async () => {
        const token = `token-${++n}`;
        issued.push(token);
        return token;
      },
      invalidate: (token) => void invalidated.push(token),
    });
    return { issued, invalidated };
  }

  test("a 401 drops the cached token and retries once with a fresh one", async () => {
    const { issued, invalidated } = sequencedProvider();
    let attempt = 0;
    stubFetch(() => (++attempt === 1 ? new Response("expired", { status: 401 }) : sentResponse()));

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ status: "sent", deliveryId: "del_1" });
    expect(calls).toHaveLength(2);
    expect(invalidated).toEqual(["token-1"]);
    expect(issued).toEqual(["token-1", "token-2"]);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token-1");
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer token-2");
  });

  test("two 401s stay failed after exactly two requests, and the token is never in the error", async () => {
    const { invalidated } = sequencedProvider();
    stubFetch(() => new Response("nope", { status: 401 }));

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ status: "failed", error: "notify-api responded with HTTP 401" });
    expect(calls).toHaveLength(2);
    expect(invalidated).toEqual(["token-1"]);
    expect(JSON.stringify(result)).not.toContain("token-");
  });

  test("a non-401 failure is never retried", async () => {
    const { invalidated } = sequencedProvider();
    stubFetch(() => new Response("boom", { status: 503 }));

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ status: "failed", error: "notify-api responded with HTTP 503" });
    expect(calls).toHaveLength(1);
    expect(invalidated).toEqual([]);
  });

  test("a provider failure on the retry mint is a failed result, not a throw", async () => {
    let n = 0;
    setNotifyTokenProvider({
      getToken: async () => {
        if (++n === 2) throw new Error("signer unavailable");
        return "token-1";
      },
      invalidate: () => {},
    });
    stubFetch(() => new Response("expired", { status: 401 }));

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ status: "failed", error: "Error" });
    expect(calls).toHaveLength(1);
  });
});

// ─── pushSystemNotification (specs/20261105-signup-gate T4, AC-4.1, AC-4.3; ADR 20261105-auth-pushes-admin-notifications) ─────────

const { pushSystemNotification } = await import("./notify");

const PUSH = {
  recipientId: "usr_admin_1",
  originApp: "admin",
  severity: "info",
  title: "Access request from Ada",
  body: "ada@welld.ch asked to join Operai.",
  link: { href: "/admin/users/access-requests" },
  email: true,
} as const;

describe("pushSystemNotification", () => {
  test("POSTs the body to /system/notifications with the provider's Bearer token", async () => {
    stubFetch(() => Response.json({ id: "n1" }, { status: 201 }));
    const result = await pushSystemNotification(PUSH);

    expect(result).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${env.NOTIFY_INTERNAL_URL}/system/notifications`);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer provider-token");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(PUSH);
  });

  test("a 500 resolves to failed with the status, never throws", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    expect(await pushSystemNotification(PUSH)).toEqual({ status: "failed", error: "notify-api responded with HTTP 500" });
    expect(calls).toHaveLength(1);
  });

  test("a network error resolves to failed", async () => {
    stubFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await pushSystemNotification(PUSH)).toEqual({ status: "failed", error: "Error" });
  });

  test("a timeout resolves to failed instead of hanging", async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      })) as typeof fetch;
    const result = await pushSystemNotification(PUSH, { timeoutMs: 20 });
    expect(result.status).toBe("failed");
  });

  test("a mint failure resolves to failed and never calls notify-api", async () => {
    setNotifyTokenProvider({
      getToken: async () => {
        throw new Error("signer unavailable");
      },
      invalidate: () => {},
    });
    stubFetch(() => Response.json({}, { status: 201 }));
    expect(await pushSystemNotification(PUSH)).toEqual({ status: "failed", error: "Error" });
    expect(calls).toHaveLength(0);
  });

  test("a 401 drops the token and retries once with a fresh one", async () => {
    const invalidated: string[] = [];
    let n = 0;
    setNotifyTokenProvider({ getToken: async () => `token-${++n}`, invalidate: (t) => void invalidated.push(t) });
    let attempt = 0;
    stubFetch(() => (++attempt === 1 ? new Response("expired", { status: 401 }) : Response.json({}, { status: 201 })));

    expect(await pushSystemNotification(PUSH)).toEqual({ status: "sent" });
    expect(calls).toHaveLength(2);
    expect(invalidated).toEqual(["token-1"]);
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer token-2");
  });
});

describe("notify client never returns a raw error message (specs/20261105-signup-gate T14)", () => {
  test("a network error carrying the internal host reports only the error name", async () => {
    setNotifyTokenProvider({ getToken: async () => "tok", invalidate: () => {} });
    stubFetch(() => {
      throw new TypeError("Unable to connect to http://notify.railway.internal:8081/system/emails");
    });
    const email = await sendInvitationEmail(INPUT);
    const push = await pushSystemNotification(PUSH);
    for (const result of [email, push]) {
      expect(result).toEqual({ status: "failed", error: "TypeError" });
      expect(JSON.stringify(result)).not.toContain("railway.internal");
    }
  });
});

// ─── The legal-entity change notice (specs/20261117-legal-entities T59; plan G5, G6) ──────────────────────────────

const { sendLegalEntityEmail, sendLegalEntityNotification } = await import("./notify");

const NOTICE_IN_APP = {
  recipientId: "usr_1",
  originApp: "admin",
  severity: "warning",
  title: "Legal details of WellD CH changed: IBAN",
  body: "The legal details of WellD CH were changed.",
  it: { title: "Dati legali di WellD CH modificati: IBAN", body: "I dati legali di WellD CH sono stati modificati." },
  link: { href: "/admin/legal-entities?entity=welld_ch&view=history", label: "Open the history" },
  idempotencyKey: "legal-entity-notice:row1",
} as const;
const NOTICE_EMAIL = {
  template: "legal_entity_change",
  recipientId: "usr_1",
  data: { entity: "welld_ch" },
  idempotencyKey: "legal-entity-notice:row2",
} as const;

describe("sendLegalEntityNotification", () => {
  test("POSTs the body as it is to /system/notifications as system:auth (Bearer), no redirect followed, a timeout set", async () => {
    stubFetch(() => Response.json({ id: "n1" }, { status: 201 }));
    expect(await sendLegalEntityNotification(NOTICE_IN_APP)).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${env.NOTIFY_INTERNAL_URL}/system/notifications`);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer provider-token");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.signal).toBeDefined();
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toEqual(NOTICE_IN_APP);
    expect("email" in sent).toBe(false); // the email is its own row and its own call
  });

  test("200 (a repeat of the same key: stored before) is delivered too", async () => {
    stubFetch(() => Response.json({ id: "n1" }, { status: 200 }));
    expect(await sendLegalEntityNotification(NOTICE_IN_APP)).toEqual({ status: "sent" });
  });

  test("the reasons: network and timeout, a 4xx (also a second 401), a 5xx, a redirect", async () => {
    stubFetch(() => {
      throw new TypeError("Unable to connect to http://notify.railway.internal:8081/system/notifications");
    });
    const unreachable = await sendLegalEntityNotification(NOTICE_IN_APP);
    expect(unreachable).toEqual({ status: "failed", reason: "notify_unreachable" });
    expect(JSON.stringify(unreachable)).not.toContain("railway.internal");

    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      })) as typeof fetch;
    expect(await sendLegalEntityNotification(NOTICE_IN_APP, { timeoutMs: 20 })).toEqual({ status: "failed", reason: "notify_unreachable" });

    for (const [status, reason] of [[400, "notify_refused"], [403, "notify_refused"], [404, "notify_refused"], [429, "notify_refused"], [500, "notify_error"], [503, "notify_error"], [302, "notify_error"]] as const) {
      stubFetch(() => new Response("x", { status }));
      expect([status, await sendLegalEntityNotification(NOTICE_IN_APP)]).toEqual([status, { status: "failed", reason }]);
      expect(calls).toHaveLength(1);
    }

    stubFetch(() => new Response("nope", { status: 401 }));
    expect(await sendLegalEntityNotification(NOTICE_IN_APP)).toEqual({ status: "failed", reason: "notify_refused" });
    expect(calls).toHaveLength(2); // one retry of the 401, no more
  });

  test("a 401 drops the token and retries once with a fresh one", async () => {
    const invalidated: string[] = [];
    let n = 0;
    setNotifyTokenProvider({ getToken: async () => `token-${++n}`, invalidate: (t) => void invalidated.push(t) });
    let attempt = 0;
    stubFetch(() => (++attempt === 1 ? new Response("expired", { status: 401 }) : Response.json({}, { status: 201 })));
    expect(await sendLegalEntityNotification(NOTICE_IN_APP)).toEqual({ status: "sent" });
    expect(invalidated).toEqual(["token-1"]);
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer token-2");
  });

  test("no credential or a failed mint is notify_unreachable, and notify-api is never called", async () => {
    setNotifyTokenProvider(undefined);
    stubFetch(() => Response.json({}, { status: 201 }));
    expect(await sendLegalEntityNotification(NOTICE_IN_APP)).toEqual({ status: "failed", reason: "notify_unreachable" });
    setNotifyTokenProvider({
      getToken: async () => {
        throw new Error("signer unavailable");
      },
      invalidate: () => {},
    });
    expect(await sendLegalEntityNotification(NOTICE_IN_APP)).toEqual({ status: "failed", reason: "notify_unreachable" });
    expect(calls).toHaveLength(0);
  });

  test("an injected fetch is the one used (the dispatcher's tests talk to a fake notify-api)", async () => {
    stubFetch(() => {
      throw new Error("the global fetch must not be used");
    });
    const seen: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return Response.json({ id: "n" }, { status: 201 });
    }) as typeof fetch;
    expect(await sendLegalEntityNotification(NOTICE_IN_APP, { fetch: fake })).toEqual({ status: "sent" });
    expect(seen).toEqual([`${env.NOTIFY_INTERNAL_URL}/system/notifications`]);
    expect(calls).toHaveLength(0);
  });
});

describe("sendLegalEntityEmail", () => {
  test("POSTs template, recipientId (or `to`), data and the key to /system/emails", async () => {
    stubFetch(() => Response.json({ deliveryId: "d1", status: "sent" }));
    expect(await sendLegalEntityEmail(NOTICE_EMAIL)).toEqual({ status: "sent" });
    expect(calls[0]?.url).toBe(`${env.NOTIFY_INTERNAL_URL}/system/emails`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(NOTICE_EMAIL);

    const outside = { template: "legal_entity_change", to: "ops@example.invalid", data: { entity: "welld_ch" }, idempotencyKey: "legal-entity-notice:row3" } as const;
    expect(await sendLegalEntityEmail(outside)).toEqual({ status: "sent" });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(outside);
  });

  test("a `skipped` answer is a failure with its reason; `failed` and a surprise are notify_error", async () => {
    const answers: [unknown, string][] = [
      [{ status: "skipped", reason: "recipient_inactive" }, "recipient_inactive"],
      [{ status: "skipped", reason: "not_configured" }, "email_not_configured"],
      [{ status: "failed", reason: "contact_lookup_failed" }, "notify_error"],
      [{ status: "failed", error: "Resend said no" }, "notify_error"],
      [{ status: "skipped", reason: "something_new" }, "notify_error"],
      [{ status: "queued" }, "notify_error"],
      ["not json", "notify_error"],
    ];
    for (const [answer, reason] of answers) {
      stubFetch(() => (typeof answer === "string" ? new Response(answer, { status: 200 }) : Response.json(answer)));
      expect([answer, await sendLegalEntityEmail(NOTICE_EMAIL)]).toEqual([answer, { status: "failed", reason: reason as never }]);
    }
  });

  test("the reasons of a non-200: network, 4xx, 5xx", async () => {
    stubFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await sendLegalEntityEmail(NOTICE_EMAIL)).toEqual({ status: "failed", reason: "notify_unreachable" });
    stubFetch(() => new Response("bad template", { status: 400 }));
    expect(await sendLegalEntityEmail(NOTICE_EMAIL)).toEqual({ status: "failed", reason: "notify_refused" });
    stubFetch(() => new Response("boom", { status: 502 }));
    expect(await sendLegalEntityEmail(NOTICE_EMAIL)).toEqual({ status: "failed", reason: "notify_error" });
  });
});
