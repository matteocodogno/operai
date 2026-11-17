/**
 * POST /system/emails — repeat protection, per-template caller binding and `recipientId` addressing
 * (specs/20261117-legal-entities T56, AC-9.13, AC-9.14, plan "Amendment 2026-11-17 after security review" G1.3-G1.5,
 * G5). The `legal_entity_change` template and its binding entry arrive with T57; here the mechanisms are exercised
 * through an INJECTED template table that binds and opens existing templates.
 *
 * done when (tasks.md T56, the email half): a repeated email after `sent` -> 200 with the same `deliveryId` and the
 * fake Resend called once; after `failed` -> called again; Resend receives `<sub>:<key>`; `to` and `recipientId`
 * together or neither -> 400; `recipientId` for a template that does not allow it -> 400; a template bound to
 * another caller -> 403 `template_not_allowed`, nothing written.
 *
 * Real Postgres; `@/lib/resend` is module-mocked (nothing leaves the process, Resend is never called); the address
 * lookup is an injected stub; the service credential is an in-memory JWT.
 */

import { describe, it, expect, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { env } from "@/lib/env";
import { expectZodIssuesBody } from "@/lib/zodIssuesBody.fixture";
import { createSystemAuthMiddleware } from "./systemAuth.middleware";

const ORIGINAL_EMAIL_ENABLED = env.EMAIL_ENABLED;

const SERVICE_AUD = "operai-system-emails-idempotency-test";
const KID = "emails-idempotency-kid";
const keyPair = await generateKeyPair("RS256");
const localJwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
});
const token = (sub: string) =>
  new SignJWT({ scope: "emails.send" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(SERVICE_AUD)
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(keyPair.privateKey);

// ─── @/lib/resend mock: the fake Resend ──────────────────────────────────────

type ResendInput = { to: string; subject: string; html: string; idempotencyKey?: string };
type ResendResult = { ok: true; providerId: string } | { ok: false; error: string };
let resendCalls: ResendInput[] = [];
let resendImpl: (input: ResendInput) => Promise<ResendResult> = async () => ({ ok: true, providerId: "re_fake" });
mock.module("@/lib/resend", () => ({
  sendEmail: (input: ResendInput) => {
    resendCalls.push(input);
    return resendImpl(input);
  },
}));

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: new URL("../../.env", import.meta.url).pathname, override: true });

const { PrismaClient } = await import("@/lib/generated/prisma/client");
const { PrismaPg } = await import("@prisma/adapter-pg");
const testDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }),
});
mock.module("@/lib/db", () => ({ db: testDb }));

const { createSystemEmailsRouter, EMAIL_TEMPLATE_POLICY } = await import("./emails.routes");
const { resendIdempotencyKey } = await import("@/channels/email.channel");

const PREFIX = "emails-idempotency-test";
const AUTH = "system:auth";
const REFUND = "system:refund-api";
const CRM = "system:crm-api";
const KEY = "legal-entity-notice:row_1";

// The injected table (the production one is empty until T57): `invitation_resend` is bound to system:auth and may be
// addressed by user id; `refund_batch_compiled` is bound to system:refund-api and may not; everything else is open.
const POLICY = {
  invitation_resend: { callers: [AUTH], allowRecipientId: true },
  refund_batch_compiled: { callers: [REFUND] },
  refund_decision_approved: { allowRecipientId: false },
} as const;

type Lookup = { status: "found"; email: string; name: string } | { status: "inactive" } | { status: "failed" };
let lookups: string[] = [];
let lookupResult: Lookup = { status: "found", email: `${PREFIX}-person@example.com`, name: "Person" };

const buildApp = (overrides: { contacts?: null; appBaseUrl?: string | undefined } = {}) => {
  const app = new Hono();
  app.route(
    "/",
    createSystemEmailsRouter(
      createSystemAuthMiddleware({ scope: "emails.send", jwks: localJwks, audience: SERVICE_AUD }),
      {
        policy: POLICY,
        contacts:
          "contacts" in overrides
            ? null
            : {
                lookup: async (id) => {
                  lookups.push(id);
                  return lookupResult;
                },
              },
        appBaseUrl: "appBaseUrl" in overrides ? overrides.appBaseUrl : "https://operai.example.test",
      },
    ),
  );
  return app;
};

const post = async (app: Hono, body: Record<string, unknown>, sub = AUTH) =>
  app.request("/system/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${await token(sub)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const DATA = {
  inviteUrl: "https://auth.operai.welld.io/invite?id=inv_1&token=abc123",
  inviterName: "Admin",
  expiresAt: "2026-07-16T10:00:00Z",
};
const addressed = (overrides: Record<string, unknown> = {}) => ({
  to: `${PREFIX}-invitee@example.com`,
  template: "invitation",
  data: DATA,
  idempotencyKey: KEY,
  ...overrides,
});
const byId = (overrides: Record<string, unknown> = {}) => {
  const { to: _to, ...rest } = addressed({ template: "invitation_resend" });
  return { ...rest, recipientId: "user_1", ...overrides };
};

type Answer = { deliveryId?: string; status: string; reason?: string; error?: string };
const answer = async (res: Response) => (await res.json()) as Answer;
const rows = () => testDb.emailDelivery.findMany({ where: { to: { contains: PREFIX } }, orderBy: { createdAt: "asc" } });

afterEach(async () => {
  env.EMAIL_ENABLED = ORIGINAL_EMAIL_ENABLED;
  resendCalls = [];
  resendImpl = async () => ({ ok: true, providerId: "re_fake" });
  lookups = [];
  lookupResult = { status: "found", email: `${PREFIX}-person@example.com`, name: "Person" };
  await testDb.emailDelivery.deleteMany({ where: { to: { contains: PREFIX } } });
});

describe("repeat protection (idempotencyKey)", () => {
  it("a repeat after `sent` -> 200 with the same deliveryId; the fake Resend is called once", async () => {
    env.EMAIL_ENABLED = true;
    const app = buildApp();
    const first = await answer(await post(app, addressed()));
    expect(first.status).toBe("sent");

    const repeatRes = await post(app, addressed());
    expect(repeatRes.status).toBe(200);
    const repeat = await answer(repeatRes);
    expect(repeat).toEqual({ deliveryId: first.deliveryId!, status: "sent" });

    expect(resendCalls).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("the stub path (EMAIL_ENABLED=false) is protected the same way", async () => {
    const app = buildApp();
    const first = await answer(await post(app, addressed()));
    const repeat = await answer(await post(app, addressed()));
    expect(repeat.deliveryId).toBe(first.deliveryId!);
    expect(await rows()).toHaveLength(1);
    expect(resendCalls).toHaveLength(0);
  });

  it("after `failed` the repeat sends again; after that `sent`, a further repeat does not", async () => {
    env.EMAIL_ENABLED = true;
    const app = buildApp();
    resendImpl = async () => ({ ok: false, error: "simulated network timeout" });
    const failed = await answer(await post(app, addressed()));
    expect(failed.status).toBe("failed");
    expect(resendCalls).toHaveLength(1);

    resendImpl = async () => ({ ok: true, providerId: "re_second" });
    const sent = await answer(await post(app, addressed()));
    expect(sent.status).toBe("sent");
    expect(sent.deliveryId).not.toBe(failed.deliveryId);
    expect(resendCalls).toHaveLength(2);

    const repeat = await answer(await post(app, addressed()));
    expect(repeat).toEqual({ deliveryId: sent.deliveryId!, status: "sent" });
    expect(resendCalls).toHaveLength(2);

    const stored = await rows();
    expect(stored.map((r) => r.status)).toEqual(["failed", "sent"]);
  });

  it("several failed attempts may share a key", async () => {
    env.EMAIL_ENABLED = true;
    const app = buildApp();
    resendImpl = async () => ({ ok: false, error: "simulated" });
    await post(app, addressed());
    await post(app, addressed());
    await post(app, addressed());
    expect((await rows()).map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    expect(resendCalls).toHaveLength(3);
  });

  it("Resend receives `<sub>:<key>` as its idempotency key — the same on a retry after a failure", async () => {
    env.EMAIL_ENABLED = true;
    const app = buildApp();
    resendImpl = async () => ({ ok: false, error: "simulated" });
    await post(app, addressed());
    resendImpl = async () => ({ ok: true, providerId: "re_ok" });
    await post(app, addressed());
    expect(resendCalls.map((c) => c.idempotencyKey)).toEqual([`${AUTH}:${KEY}`, `${AUTH}:${KEY}`]);
  });

  it("without a key nothing is passed to Resend and every call sends, as before", async () => {
    env.EMAIL_ENABLED = true;
    const app = buildApp();
    await post(app, addressed({ idempotencyKey: undefined }));
    await post(app, addressed({ idempotencyKey: undefined }));
    expect(resendCalls).toHaveLength(2);
    expect(resendCalls.every((c) => !("idempotencyKey" in c))).toBe(true);
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.callerSub === null && r.idempotencyKey === null)).toBe(true);
  });

  it("the delivery row records the caller and the key", async () => {
    await post(buildApp(), addressed());
    const [row] = await rows();
    expect(row?.callerSub).toBe(AUTH);
    expect(row?.idempotencyKey).toBe(KEY);
  });

  it("the key is scoped to the calling service: another sub with the same key sends its own", async () => {
    env.EMAIL_ENABLED = true;
    const app = buildApp();
    const a = await answer(await post(app, addressed(), AUTH));
    const b = await answer(await post(app, addressed(), CRM));
    expect(b.status).toBe("sent");
    expect(b.deliveryId).not.toBe(a.deliveryId);
    expect(resendCalls.map((c) => c.idempotencyKey)).toEqual([`${AUTH}:${KEY}`, `${CRM}:${KEY}`]);
    expect(await rows()).toHaveLength(2);
  });

  it("concurrent calls with one key leave one `sent` row and all answer with it", async () => {
    env.EMAIL_ENABLED = true;
    resendImpl = async () => {
      await new Promise((r) => setTimeout(r, 20)); // keep every caller past the lookup before any records
      return { ok: true, providerId: "re_same" };
    };
    const app = buildApp();
    const answers = await Promise.all(Array.from({ length: 6 }, async () => answer(await post(app, addressed()))));
    expect(answers.every((a) => a.status === "sent")).toBe(true);
    expect(new Set(answers.map((a) => a.deliveryId)).size).toBe(1);
    const stored = await rows();
    expect(stored.filter((r) => r.status === "sent")).toHaveLength(1);
    expect(stored).toHaveLength(1);
  });

  it.each([
    ["empty", ""],
    ["201 characters", "k".repeat(201)],
    ["a space", "legal entity"],
    ["a non-string", 7],
  ])("a malformed key (%s) -> 400, nothing sent or stored", async (_name, key) => {
    env.EMAIL_ENABLED = true;
    const res = await post(buildApp(), addressed({ idempotencyKey: key }));
    expect(res.status).toBe(400);
    expect(resendCalls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
});

describe("resendIdempotencyKey", () => {
  it("is `<sub>:<key>` while it fits Resend's 256 characters", () => {
    expect(resendIdempotencyKey({ callerSub: AUTH, idempotencyKey: KEY })).toBe(`${AUTH}:${KEY}`);
    const edge = "k".repeat(256 - AUTH.length - 1);
    expect(resendIdempotencyKey({ callerSub: AUTH, idempotencyKey: edge })).toHaveLength(256);
  });

  it("is a stable hash beyond it, never a truncation that two keys could share", () => {
    const longSub = `system:${"s".repeat(100)}`;
    const a = resendIdempotencyKey({ callerSub: longSub, idempotencyKey: "k".repeat(200) });
    const b = resendIdempotencyKey({ callerSub: longSub, idempotencyKey: `${"k".repeat(199)}j` });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(resendIdempotencyKey({ callerSub: longSub, idempotencyKey: "k".repeat(200) })).toBe(a);
  });
});

describe("addressing: `to` xor `recipientId`", () => {
  it("both -> 400 (the usual validation body)", async () => {
    const res = await post(buildApp(), byId({ to: `${PREFIX}-x@example.com` }));
    await expectZodIssuesBody(res, ["recipientId"]);
    expect(lookups).toEqual([]);
    expect(await rows()).toHaveLength(0);
  });

  it("neither -> 400", async () => {
    const { to: _to, ...none } = addressed();
    const res = await post(buildApp(), none);
    await expectZodIssuesBody(res, ["to"]);
    expect(await rows()).toHaveLength(0);
  });

  it("an empty or over-long recipientId -> 400", async () => {
    expect((await post(buildApp(), byId({ recipientId: "" }))).status).toBe(400);
    expect((await post(buildApp(), byId({ recipientId: "u".repeat(201) }))).status).toBe(400);
  });

  it("`recipientId` for a template that does not allow it -> 400, nothing resolved or written", async () => {
    // not in the table (open to every caller, `to` only) ...
    const open = { ...addressed(), to: undefined, recipientId: "user_1" };
    const res = await post(buildApp(), open);
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "recipient_id_not_allowed" });
    // ... explicitly refused, ... and a bound template that lists no `allowRecipientId`
    const refused = await post(buildApp(), {
      ...addressed({ template: "refund_decision_approved" }),
      to: undefined,
      recipientId: "user_1",
      data: { requestUrl: "https://x.example.test/r", decidedAt: "2026-11-17T10:00:00Z", approvedTotals: [{ currency: "EUR", amountCents: 1 }] },
    });
    expect(refused.status).toBe(400);
    const bound = await post(
      buildApp(),
      {
        template: "refund_batch_compiled",
        recipientId: "user_1",
        data: {
          batchUrl: "https://x.example.test/b",
          batchReference: "B-1",
          cutoff: "2026-11-17T10:00:00Z",
          generatedAt: "2026-11-17T10:00:00Z",
          requestCount: 1,
        },
      },
      REFUND,
    );
    expect(bound.status).toBe(400);
    expect(lookups).toEqual([]);
    expect(resendCalls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("`recipientId` on a template that allows it is resolved and sent to the address auth gives", async () => {
    env.EMAIL_ENABLED = true;
    const res = await post(buildApp(), byId());
    expect(res.status).toBe(200);
    const body = await answer(res);
    expect(body.status).toBe("sent");
    expect(lookups).toEqual(["user_1"]);
    expect(resendCalls.map((c) => c.to)).toEqual([`${PREFIX}-person@example.com`]);
    const [row] = await rows();
    expect(row?.id).toBe(body.deliveryId!);
    expect(row?.template).toBe("invitation_resend");
  });
});

describe("`recipientId` outcomes", () => {
  it("inactive user -> 200 skipped / recipient_inactive; no address, no row, no send", async () => {
    env.EMAIL_ENABLED = true;
    lookupResult = { status: "inactive" };
    const res = await post(buildApp(), byId());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "skipped", reason: "recipient_inactive" });
    expect(resendCalls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("lookup failure -> 200 failed / contact_lookup_failed; a later repeat looks again and sends", async () => {
    env.EMAIL_ENABLED = true;
    const app = buildApp();
    lookupResult = { status: "failed" };
    const res = await post(app, byId());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "failed", reason: "contact_lookup_failed" });
    expect(resendCalls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);

    lookupResult = { status: "found", email: `${PREFIX}-person@example.com`, name: "P" };
    expect((await answer(await post(app, byId()))).status).toBe("sent");
    expect(lookups).toEqual(["user_1", "user_1"]);
    expect(resendCalls).toHaveLength(1);
  });

  it("email group unset (no contact client, or no APP_BASE_URL) -> 200 skipped / not_configured", async () => {
    env.EMAIL_ENABLED = true;
    for (const app of [buildApp({ contacts: null }), buildApp({ appBaseUrl: undefined })]) {
      const res = await post(app, byId());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "skipped", reason: "not_configured" });
    }
    expect(resendCalls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("a repeat after `sent` answers with the first result WITHOUT looking the address up again", async () => {
    env.EMAIL_ENABLED = true;
    const app = buildApp();
    const first = await answer(await post(app, byId()));
    lookupResult = { status: "inactive" }; // gone since — must not undo a delivered send
    const repeat = await answer(await post(app, byId()));
    expect(repeat).toEqual({ deliveryId: first.deliveryId!, status: "sent" });
    expect(lookups).toEqual(["user_1"]);
    expect(resendCalls).toHaveLength(1);
  });

  it("no address of the person is in the answer", async () => {
    const res = await post(buildApp(), byId());
    expect(JSON.stringify(await res.json())).not.toContain("@");
  });
});

describe("per-template caller binding", () => {
  it("a template bound to another caller -> 403 template_not_allowed; nothing resolved, sent or written", async () => {
    env.EMAIL_ENABLED = true;
    for (const sub of [CRM, REFUND]) {
      const res = await post(buildApp(), byId(), sub);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string; status: number; title: string };
      expect(body).toMatchObject({ code: "template_not_allowed", status: 403, title: "Forbidden" });
    }
    // with a plain address too
    expect((await post(buildApp(), addressed({ template: "invitation_resend" }), CRM)).status).toBe(403);
    expect(lookups).toEqual([]);
    expect(resendCalls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("the bound caller may send it; a binding does not make the other templates closed", async () => {
    expect((await post(buildApp(), byId(), AUTH)).status).toBe(200);
    expect((await post(buildApp(), addressed({ idempotencyKey: "other" }), CRM)).status).toBe(200); // `invitation`: open
    expect((await post(buildApp(), addressed({ idempotencyKey: "other-2" }), REFUND)).status).toBe(200);
  });

  it("binding is checked before `recipientId` addressing: an unbound caller learns nothing about it", async () => {
    const res = await post(buildApp(), byId(), CRM);
    expect(res.status).toBe(403);
  });

  it("a malformed body is still the usual 400 for any caller", async () => {
    const res = await post(buildApp(), { template: "nope", to: "a@example.test", data: {} }, CRM);
    expect(res.status).toBe(400);
  });
});

describe("the production table", () => {
  it("binds exactly legal_entity_change: system:auth only, recipientId allowed", () => {
    expect(EMAIL_TEMPLATE_POLICY).toEqual({ legal_entity_change: { callers: ["system:auth"], allowRecipientId: true } });
  });
});
