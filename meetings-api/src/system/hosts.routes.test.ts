/**
 * GET /system/meetings/hosts (specs/029-time-tracking T9 — AC-2.6, AC-4.5, AC-4.11; ADR-0089 § 6).
 * Which deal each meeting is linked to, read by hours-api with a scoped SERVICE credential
 * (`meetings.hosts.read`, `sub` `system:hours-api`) and answering `{ id, host }` and nothing else:
 * never a title, a participant, a duration or any content (ADR-0058: no role, and no service, reads
 * a meeting's content through here).
 *
 * Real Postgres (`meetings_test`); the JWKS is an in-memory one injected into the middleware, so no
 * live `auth` is needed. The last block drives the ASSEMBLED app, with the real default router.
 */

import { TEST_AUDIENCE, TEST_ISSUER, setupTestAuth } from "../test-support/testAuth";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

// The assembled app (last block) loads every router, `auth/guards` among them: the shared test-auth mocks
// must be registered BEFORE it does, as in every route test of this service.
setupTestAuth();

const { db } = await import("../lib/db");
const { env } = await import("../lib/env");
const { createSystemAuthMiddleware, __setDefaultJwksForTests } = await import("../auth/systemAuth.middleware");
const { HOSTS_ALLOWED_SUBS, HOSTS_SCOPE, createSystemHostsRouter } = await import("./hosts.routes");
const { app: assembled } = await import("../index");

const SERVICE_AUD = "operai-system-test";
const KID = "svc-hosts-kid";
const RUN = crypto.randomUUID().slice(0, 8);
const PREFIX = `t9-${RUN}`;
const PATH = "/system/meetings/hosts";
const TITLE_CANARY = `${PREFIX}-title-canary`;

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
let app: Hono;
let noAudienceApp: Hono;

const serviceJwt = (
  o: { sub?: string; scope?: string | null; aud?: string; iss?: string; exp?: string | number; signer?: CryptoKey } = {},
): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (o.scope !== null) claims["scope"] = o.scope ?? HOSTS_SCOPE;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(o.iss ?? TEST_ISSUER)
    .setAudience(o.aud ?? SERVICE_AUD)
    .setSubject(o.sub ?? "system:hours-api")
    .setExpirationTime(o.exp ?? "5m")
    .sign(o.signer ?? signingKey);
};

const get = (query = "", token?: string, target: Hono = app) =>
  target.request(`${PATH}${query}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});

/** Calls as hours-api, with a valid credential. */
const asHours = async (query: string) => get(query, await serviceJwt());

interface Item {
  id: string;
  host: { app: string; entityType: string; entityId: string } | null;
}
const items = async (res: Response): Promise<Item[]> => ((await res.json()) as { items: Item[] }).items;

const deal = (entityId: string) => ({ app: "crm", entityType: "deal", entityId });

/** A text meeting (the least a row needs), optionally linked to a host entity. */
const make = (host?: { app: string; entityType: string; entityId: string; visible?: boolean }) =>
  db.meeting.create({
    data: {
      title: TITLE_CANARY,
      format: "online",
      startsAt: new Date("2026-11-10T09:00:00Z"),
      language: "en",
      source: "text",
      creatorUserId: `${PREFIX}-creator`,
      ...(host ? { hostApp: host.app, hostEntityType: host.entityType, hostEntityId: host.entityId, hostVisible: host.visible ?? false } : {}),
    },
  });

const cleanup = () => db.meeting.deleteMany({ where: { creatorUserId: { startsWith: PREFIX } } });

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }] });
  app = new Hono();
  app.route("/", createSystemHostsRouter(createSystemAuthMiddleware({ scope: HOSTS_SCOPE, allowedSubs: HOSTS_ALLOWED_SUBS, jwks, audience: SERVICE_AUD })));
  noAudienceApp = new Hono();
  noAudienceApp.route("/", createSystemHostsRouter(createSystemAuthMiddleware({ scope: HOSTS_SCOPE, allowedSubs: HOSTS_ALLOWED_SUBS, jwks, audience: undefined })));
  await cleanup();
});

afterAll(cleanup);

describe("GET /system/meetings/hosts?ids= (AC-2.6, AC-4.5)", () => {
  it("answers { id, host } for a linked meeting and nothing else: no title, participant or duration", async () => {
    const linked = await make(deal(`${PREFIX}-d1`));
    await db.meeting.update({ where: { id: linked.id }, data: { durationMs: 7_654_321 } });
    await db.meetingParticipant.create({ data: { meetingId: linked.id, userId: `${PREFIX}-p1`, addedBy: `${PREFIX}-creator` } });
    const res = await asHours(`?ids=${linked.id}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ items: [{ id: linked.id, host: { app: "crm", entityType: "deal", entityId: `${PREFIX}-d1` } }] });
    // A canary in the title, the creator and participant ids, the start and the duration: none is anywhere in the answer.
    for (const secret of [TITLE_CANARY, `${PREFIX}-creator`, `${PREFIX}-p1`, "2026-11-10", "startsAt", "7654321", "durationMs"]) expect(text).not.toContain(secret);
  });

  it("answers host: null for an unlinked meeting, and omits an id that names no meeting", async () => {
    const unlinked = await make();
    const linked = await make(deal(`${PREFIX}-d2`));
    const found = await items(await asHours(`?ids=${unlinked.id},no-such-meeting,${linked.id}`));
    expect(found.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: unlinked.id, host: null },
        { id: linked.id, host: deal(`${PREFIX}-d2`) },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("reports the host the meeting stores, whoever the host is, and whether or not its creator made it visible to host readers", async () => {
    const visible = await make({ ...deal(`${PREFIX}-d3`), visible: true });
    const hidden = await make({ ...deal(`${PREFIX}-d3`), visible: false });
    const widget = await make({ app: "testhost", entityType: "widget", entityId: `${PREFIX}-w1` });
    const found = new Map((await items(await asHours(`?ids=${visible.id},${hidden.id},${widget.id}`))).map((i) => [i.id, i.host]));
    expect(found.get(visible.id)).toEqual(deal(`${PREFIX}-d3`));
    expect(found.get(hidden.id)).toEqual(deal(`${PREFIX}-d3`));
    expect(found.get(widget.id)).toEqual({ app: "testhost", entityType: "widget", entityId: `${PREFIX}-w1` });
  });

  it("names a meeting once however often its id is repeated", async () => {
    const m = await make(deal(`${PREFIX}-d4`));
    expect(await items(await asHours(`?ids=${m.id},${m.id}`))).toEqual([{ id: m.id, host: deal(`${PREFIX}-d4`) }]);
  });

  it("takes 100 ids and refuses 101 (422), before it asks the database anything", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `${PREFIX}-none-${i}`).join(",");
    const ok = await asHours(`?ids=${many(100)}`);
    expect(ok.status).toBe(200);
    expect(await items(ok)).toEqual([]);
    const refused = await asHours(`?ids=${many(101)}`);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ status: 422, field: "ids" });
  });

  it.each([
    ["an empty list", "?ids="],
    ["an empty member", "?ids=a,,b"],
    ["a trailing comma", "?ids=a,"],
    ["a blank member", "?ids=a,%20,b"],
    ["an id over 64 characters", `?ids=${"x".repeat(65)}`],
    ["a repeated parameter", "?ids=a&ids=b"],
  ])("refuses %s with 422, never reading it as no filter", async (_label, query) => {
    const res = await asHours(query);
    expect(res.status).toBe(422);
  });

  it("takes an id with a NUL for an id that names no meeting: absent, never a 500", async () => {
    const linked = await make(deal(`${PREFIX}-d5`));
    const res = await asHours(`?ids=bad%00id,${linked.id}`);
    expect(res.status).toBe(200);
    expect(await items(res)).toEqual([{ id: linked.id, host: deal(`${PREFIX}-d5`) }]);
  });
});

describe("GET /system/meetings/hosts?dealId= (AC-2.6, AC-4.11)", () => {
  const byId = (a: Item, b: Item) => a.id.localeCompare(b.id);

  it("lists the meetings currently linked to the deal, and no other: not another deal, not an unlinked meeting, not another host's entity of the same id", async () => {
    const dealId = `${PREFIX}-deal-a`;
    const mine1 = await make(deal(dealId));
    const mine2 = await make({ ...deal(dealId), visible: true });
    await make(deal(`${PREFIX}-deal-other`));
    await make();
    await make({ app: "testhost", entityType: "widget", entityId: dealId });
    await make({ app: "crm", entityType: "company", entityId: dealId });
    const found = await items(await asHours(`?dealId=${dealId}`));
    expect(found.sort(byId)).toEqual(
      [
        { id: mine1.id, host: deal(dealId) },
        { id: mine2.id, host: deal(dealId) },
      ].sort(byId),
    );
  });

  it("follows a relink: the meeting leaves the old deal's list and joins the new one's", async () => {
    const [from, to] = [`${PREFIX}-deal-from`, `${PREFIX}-deal-to`];
    const moving = await make(deal(from));
    const staying = await make(deal(from));
    expect((await items(await asHours(`?dealId=${from}`))).map((i) => i.id).sort()).toEqual([moving.id, staying.id].sort());
    await db.meeting.update({ where: { id: moving.id }, data: { hostEntityId: to } });
    expect(await items(await asHours(`?dealId=${from}`))).toEqual([{ id: staying.id, host: deal(from) }]);
    expect(await items(await asHours(`?dealId=${to}`))).toEqual([{ id: moving.id, host: deal(to) }]);
    await db.meeting.update({ where: { id: moving.id }, data: { hostApp: null, hostEntityType: null, hostEntityId: null } });
    expect(await items(await asHours(`?dealId=${to}`))).toEqual([]);
  });

  it("answers an empty list for a deal with no meeting, and for an id that cannot name one (a NUL), never a 500", async () => {
    const none = await asHours(`?dealId=${PREFIX}-deal-none`);
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ items: [] });
    const nul = await asHours("?dealId=bad%00id");
    expect(nul.status).toBe(200);
    expect(await nul.json()).toEqual({ items: [] });
  });

  it("is not paged and not capped: every linked meeting comes back, however many (an answer too low is a wrong total, AC-4.11)", async () => {
    const dealId = `${PREFIX}-deal-many`;
    await db.meeting.createMany({
      data: Array.from({ length: 130 }, () => ({
        title: TITLE_CANARY,
        format: "online" as const,
        startsAt: new Date("2026-11-10T09:00:00Z"),
        language: "en" as const,
        source: "text" as const,
        creatorUserId: `${PREFIX}-creator`,
        hostApp: "crm",
        hostEntityType: "deal",
        hostEntityId: dealId,
      })),
    });
    const found = await items(await asHours(`?dealId=${dealId}`));
    expect(found).toHaveLength(130);
    expect(new Set(found.map((i) => i.id)).size).toBe(130);
    expect(found.every((i) => i.host?.entityId === dealId)).toBe(true);
  });

  it.each([
    ["an empty dealId", "?dealId="],
    ["a blank dealId", "?dealId=%20"],
    ["a dealId over 64 characters", `?dealId=${"x".repeat(65)}`],
    ["a repeated dealId", "?dealId=a&dealId=b"],
  ])("refuses %s with 422", async (_label, query) => {
    expect((await asHours(query)).status).toBe(422);
  });
});

describe("exactly one of ids and dealId (AC-4.11)", () => {
  it.each([
    ["neither", ""],
    ["both", "?ids=a&dealId=b"],
  ])("%s is a 422 naming the filters, never an unfiltered or half-filtered answer", async (_label, query) => {
    const res = await asHours(query);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ status: 422, field: "ids" });
  });
});

describe("the credential: every failure is the same 401, byte for byte", () => {
  it("no token, a user JWT, another scope, audience, issuer, key or sub, an expired or malformed token: one identical body", async () => {
    const userJwt = await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE, scope: null });
    const failures: Array<[string, Response]> = [
      ["no token", await get("?ids=a")],
      ["a user JWT", await get("?ids=a", userJwt)],
      ["a user JWT carrying the scope claim", await get("?ids=a", await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE }))],
      ["hours-api's sub but the USER audience", await get("?ids=a", await serviceJwt({ aud: TEST_AUDIENCE }))],
      ["another scope", await get("?ids=a", await serviceJwt({ scope: "notifications.push" }))],
      ["no scope claim", await get("?ids=a", await serviceJwt({ scope: null }))],
      ["a scope that only contains ours", await get("?ids=a", await serviceJwt({ scope: `${HOSTS_SCOPE}.extra` }))],
      ["another audience", await get("?ids=a", await serviceJwt({ aud: "someone-else" }))],
      ["another issuer", await get("?ids=a", await serviceJwt({ iss: "http://evil.example" }))],
      ["another signing key", await get("?ids=a", await serviceJwt({ signer: otherKey }))],
      ["a sub that is not a service principal", await get("?ids=a", await serviceJwt({ sub: "hours-api" }))],
      ["an empty service sub", await get("?ids=a", await serviceJwt({ sub: "system:" }))],
      ["another service client holding the scope: crm-api", await get("?ids=a", await serviceJwt({ sub: "system:crm-api" }))],
      ["another service client holding the scope: meetings-api itself", await get("?ids=a", await serviceJwt({ sub: "system:meetings-api" }))],
      ["an expired token", await get("?ids=a", await serviceJwt({ exp: Math.floor(Date.now() / 1000) - 60 }))],
      ["a malformed token", await get("?ids=a", "not-a-jwt")],
      ["a non-Bearer scheme", await app.request(`${PATH}?ids=a`, { headers: { Authorization: `Basic ${await serviceJwt()}` } })],
    ];
    const reference = await failures[0]![1].clone().text();
    expect(JSON.parse(reference)).toMatchObject({ status: 401, instance: PATH });
    for (const [label, res] of failures) {
      expect({ label, status: res.status }).toEqual({ label, status: 401 });
      expect({ label, body: await res.text() }).toEqual({ label, body: reference });
    }
  });

  it("is checked before the query: a bad credential with a bad query is a 401, not a 422 that tells it the query's shape", async () => {
    expect((await get("", "not-a-jwt")).status).toBe(401);
    expect((await get("?ids=a&dealId=b")).status).toBe(401);
  });

  it("accepts a token that carries our scope among others", async () => {
    const res = await get("?ids=a", await serviceJwt({ scope: `notifications.push ${HOSTS_SCOPE}` }));
    expect(res.status).toBe(200);
  });

  it("fails closed when SERVICE_AUDIENCE is not configured, even for an otherwise valid token", async () => {
    const res = await get("?ids=a", await serviceJwt(), noAudienceApp);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(await (await get("?ids=a")).text());
  });
});

describe("mounted in the assembled app, with the real default router (AC-2.6, AC-4.5)", () => {
  /** Runs `fn` with the service audience configured (or unset) and the suite JWKS replaced by the in-memory one. */
  async function configured<T>(audience: string | undefined, fn: () => Promise<T>): Promise<T> {
    const previousAudience = env.SERVICE_AUDIENCE;
    const previousJwks = __setDefaultJwksForTests(jwks);
    env.SERVICE_AUDIENCE = audience;
    try {
      return await fn();
    } finally {
      env.SERVICE_AUDIENCE = previousAudience;
      __setDefaultJwksForTests(previousJwks);
    }
  }

  const call = (query: string, token?: string) => get(query, token, assembled as unknown as Hono);

  it("SERVICE_AUDIENCE unset (as in the test environment): every call is a 401, a valid-looking credential included", async () => {
    await configured(undefined, async () => {
      expect((await call("?ids=a", await serviceJwt())).status).toBe(401);
      expect((await call("?ids=a")).status).toBe(401);
    });
  });

  it("SERVICE_AUDIENCE set: hours-api's token reads the link; another client's token, a user JWT and another scope do not", async () => {
    const linked = await make(deal(`${PREFIX}-d-mount`));
    await configured(SERVICE_AUD, async () => {
      const ok = await call(`?ids=${linked.id}`, await serviceJwt());
      expect(ok.status).toBe(200);
      expect(await items(ok)).toEqual([{ id: linked.id, host: deal(`${PREFIX}-d-mount`) }]);
      expect((await call(`?dealId=${PREFIX}-d-mount`, await serviceJwt())).status).toBe(200);

      const unauthorized = await (await call(`?ids=${linked.id}`)).text();
      for (const token of [
        await serviceJwt({ sub: "system:crm-api" }),
        await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE, scope: null }),
        await serviceJwt({ scope: "notifications.push" }),
      ]) {
        const res = await call(`?ids=${linked.id}`, token);
        expect(res.status).toBe(401);
        expect(await res.text()).toBe(unauthorized);
      }
    });
  });

  it("an accepted call logs the caller and no query string, an id or the token; a refused one logs no caller", async () => {
    const linked = await make(deal(`${PREFIX}-d-log`));
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await configured(SERVICE_AUD, async () => {
        const token = await serviceJwt();
        await call(`?ids=${linked.id}`, token);
        await call(`?dealId=${PREFIX}-d-log`, token);
        const refused = await serviceJwt({ sub: "system:crm-api" });
        await call(`?ids=${linked.id}`, refused);

        const lines = [...log.mock.calls, ...warn.mock.calls].map((args) => args.join(" "));
        // Two accepted calls name their caller; the refused one names nobody.
        expect(lines.filter((l) => l.includes("caller="))).toEqual(Array(2).fill("[system-auth] GET /system/meetings/hosts caller=system:hours-api"));
        // The request logger: method, path WITHOUT the query string, status, duration.
        const requests = lines.filter((l) => /^GET \/system\/meetings\/hosts \d{3} \d+ms$/.test(l));
        expect(requests.map((l) => l.split(" ")[2])).toEqual(["200", "200", "401"]);
        for (const line of lines) {
          for (const secret of ["ids=", "dealId=", linked.id, `${PREFIX}-d-log`, token, refused]) expect(line).not.toContain(secret);
        }
      });
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("is in the OpenAPI document, under System", async () => {
    const doc = (await (await assembled.request("/openapi.json")).json()) as { paths: Record<string, { get?: { tags?: string[] } }> };
    expect(doc.paths["/system/meetings/hosts"]?.get?.tags).toEqual(["System"]);
  });
});
