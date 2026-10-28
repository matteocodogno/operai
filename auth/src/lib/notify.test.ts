/**
 * Unit tests for the invitation email client (T7, specs/016 — refs AC-1.4,
 * AC-4.3, AC-5.2; ADR-0048): the call carries `auth`'s own service JWT as a
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
  setNotifyTokenProvider({ getToken: async () => "provider-token" });
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
    });
    stubFetch(sentResponse);

    const result = await sendInvitationEmail(INPUT);

    expect(result).toEqual({ status: "failed", error: "signer unavailable" });
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
    expect(await sendInvitationEmail(INPUT)).toEqual({ status: "failed", error: "connect ECONNREFUSED" });
  });

  test("an unexpected 200 body returns failed", async () => {
    stubFetch(() => Response.json({ status: "queued" }));
    const result = await sendInvitationEmail(INPUT);
    expect(result.status).toBe("failed");
  });
});
