/**
 * The real `sendEmail` against a stubbed `fetch` (specs/20261117-legal-entities T56, AC-9.14): proves that the
 * idempotency key reaches Resend as the `Idempotency-Key` header through the SDK's own option — resend 6.17.2's
 * `emails.send(payload, { idempotencyKey })` — so no raw header is needed. Nothing leaves the process: `fetch` is
 * replaced for the duration of each test and Resend is never contacted.
 *
 * Other test files replace the module `@/lib/resend` with a fake for the whole run; this file therefore imports the
 * real one under a query string, which the fake's specifier does not match.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { env } from "@/lib/env";

const realSpecifier = "../lib/resend.ts?real-sdk"; // a variable: the query is a runtime trick the type checker cannot resolve
const real = (await import(realSpecifier)) as typeof import("../lib/resend");

const originalFetch = globalThis.fetch;
const originalKey = env.RESEND_API_KEY;
const originalFrom = env.RESEND_FROM;

type Seen = { url: string; headers: Headers; body: Record<string, unknown> };
const stubFetch = (respond: () => Response): Seen[] => {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return respond();
  }) as typeof fetch;
  return seen;
};
const ok = () => Response.json({ id: "re_fake_message" }, { status: 200 });

afterEach(() => {
  globalThis.fetch = originalFetch;
  env.RESEND_API_KEY = originalKey;
  env.RESEND_FROM = originalFrom;
});

describe("sendEmail → Resend SDK 6.17.2", () => {
  it("sends the key as the Idempotency-Key header (SDK option, no raw header)", async () => {
    env.RESEND_API_KEY = "re_test_not_a_real_key";
    env.RESEND_FROM = "no-reply@operai.example.test";
    const seen = stubFetch(ok);

    const result = await real.sendEmail({
      to: "someone@example.test",
      subject: "S",
      html: "<p>H</p>",
      idempotencyKey: "system:auth:legal-entity-notice:row_1",
    });

    expect(result).toEqual({ ok: true, providerId: "re_fake_message" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/emails");
    expect(seen[0]!.headers.get("Idempotency-Key")).toBe("system:auth:legal-entity-notice:row_1");
    // the key is a header, never part of the message
    expect(JSON.stringify(seen[0]!.body)).not.toContain("legal-entity-notice");
  });

  it("sends no Idempotency-Key header when no key was given", async () => {
    env.RESEND_API_KEY = "re_test_not_a_real_key";
    env.RESEND_FROM = "no-reply@operai.example.test";
    const seen = stubFetch(ok);

    await real.sendEmail({ to: "someone@example.test", subject: "S", html: "<p>H</p>" });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.has("Idempotency-Key")).toBe(false);
  });

  it("a Resend refusal of a reused key is a soft failure like any other (never a throw)", async () => {
    env.RESEND_API_KEY = "re_test_not_a_real_key";
    env.RESEND_FROM = "no-reply@operai.example.test";
    stubFetch(() =>
      Response.json(
        { name: "concurrent_idempotent_requests", message: "Same idempotency key used while in progress", statusCode: 409 },
        { status: 409 },
      ),
    );

    const result = await real.sendEmail({
      to: "someone@example.test",
      subject: "S",
      html: "<p>H</p>",
      idempotencyKey: "k",
    });

    expect(result.ok).toBe(false);
  });
});
