/**
 * The service-JWT guard of hours-api's first `/system` route (specs/20261112-meeting-hours T2 — AC-1.7, plan
 * R5; ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049 mechanism). `systemAuth.middleware.ts` is a
 * copy of meetings-api's, whose marked region `scripts/check-shared-copies.ts` keeps identical across the
 * resource servers; what is proved here is that it COMPILES and BEHAVES in hours-api, against hours-api's own
 * environment, for the route the notices will use (scope `meeting-hours-notices.send`, `sub` allowlist
 * `system:meetings-api`, as in the plan).
 *
 * A bare app (no assembled hours-api, no database): a local RS256 key set injected into the middleware, as
 * `meetings-api/src/system/hosts.routes.test.ts` does. The route itself is T7's, and so is the proof that it is
 * mounted before the user session guard (plan R8).
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { TEST_AUDIENCE, TEST_ISSUER, TEST_SERVICE_AUDIENCE } from "../test-support/env";
import { __setDefaultJwksForTests, createSystemAuthMiddleware, type SystemAuthVariables } from "./systemAuth.middleware";

const SCOPE = "meeting-hours-notices.send";
const SUBS = ["system:meetings-api"] as const;
const PATH = "/system/meeting-hours/v1/notices";
const KID = "svc-meeting-hours-kid";

const pair = await generateKeyPair("RS256");
const otherPair = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }] });

const serviceJwt = (
  o: { sub?: string; scope?: string | null; aud?: string; iss?: string; exp?: string | number; signer?: CryptoKey } = {},
): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (o.scope !== null) claims["scope"] = o.scope ?? SCOPE;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(o.iss ?? TEST_ISSUER)
    .setAudience(o.aud ?? TEST_SERVICE_AUDIENCE)
    .setSubject(o.sub ?? "system:meetings-api")
    .setExpirationTime(o.exp ?? "5m")
    .sign(o.signer ?? pair.privateKey);
};

/** What a route behind the guard would do: counts how often it ran, and answers who the verified caller was. */
const build = (options: { audience?: string | undefined; withAudience?: boolean; withJwks?: boolean } = {}) => {
  const reached = { count: 0 };
  const guard = createSystemAuthMiddleware({
    scope: SCOPE,
    allowedSubs: SUBS,
    ...(options.withJwks === false ? {} : { jwks }),
    ...(options.withAudience === false ? {} : { audience: "audience" in options ? options.audience : TEST_SERVICE_AUDIENCE }),
  });
  const app = new Hono<{ Variables: SystemAuthVariables }>();
  app.post(PATH, guard, (c) => {
    reached.count++;
    return c.json({ applied: true, caller: c.get("serviceSub") });
  });
  return { app, reached };
};

const BODY = JSON.stringify({ noticeId: "notice-1", meeting: { id: "meeting-1", seq: 1, facts: null } });

const post = (app: Hono<{ Variables: SystemAuthVariables }>, token?: string | null, init: { scheme?: string; body?: string } = {}) =>
  app.request(PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `${init.scheme ?? "Bearer"} ${token}` } : {}) },
    body: init.body ?? BODY,
  });

describe("the one caller: system:meetings-api with the scope (AC-1.7)", () => {
  it("passes, and the route sees the verified sub", async () => {
    const { app, reached } = build();
    const res = await post(app, await serviceJwt());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true, caller: "system:meetings-api" });
    expect(reached.count).toBe(1);
  });

  it("passes with the scope among others, and not with a scope that only contains it", async () => {
    const { app } = build();
    expect((await post(app, await serviceJwt({ scope: `notifications.push host-notices.send ${SCOPE}` }))).status).toBe(200);
    expect((await post(app, await serviceJwt({ scope: `${SCOPE}.extra` }))).status).toBe(401);
    expect((await post(app, await serviceJwt({ scope: `x${SCOPE}` }))).status).toBe(401);
  });
});

describe("every failure is the same 401, byte for byte, and the route never runs", () => {
  it("no token, a user JWT, another sub, scope, audience, issuer, key, an expired or malformed token", async () => {
    const { app, reached } = build();
    const userJwt = await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE, scope: null });
    const failures: Array<[string, Response]> = [
      ["no token", await post(app, null)],
      ["a user JWT", await post(app, userJwt)],
      ["a user JWT carrying the scope claim", await post(app, await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE }))],
      ["meetings-api's sub but the USER audience", await post(app, await serviceJwt({ aud: TEST_AUDIENCE }))],
      ["another scope", await post(app, await serviceJwt({ scope: "notifications.push" }))],
      ["the scope of the hosts route, not this one", await post(app, await serviceJwt({ scope: "meetings.hosts.read" }))],
      ["no scope claim", await post(app, await serviceJwt({ scope: null }))],
      ["another audience", await post(app, await serviceJwt({ aud: "someone-else" }))],
      ["another issuer", await post(app, await serviceJwt({ iss: "http://evil.example" }))],
      ["another signing key", await post(app, await serviceJwt({ signer: otherPair.privateKey }))],
      ["a sub that is not a service principal", await post(app, await serviceJwt({ sub: "meetings-api" }))],
      ["an empty service sub", await post(app, await serviceJwt({ sub: "system:" }))],
      ["another service client holding the scope: crm-api", await post(app, await serviceJwt({ sub: "system:crm-api" }))],
      ["another service client holding the scope: activities-api", await post(app, await serviceJwt({ sub: "system:activities-api" }))],
      ["hours-api itself", await post(app, await serviceJwt({ sub: "system:hours-api" }))],
      ["an expired token", await post(app, await serviceJwt({ exp: Math.floor(Date.now() / 1000) - 60 }))],
      ["a malformed token", await post(app, "not-a-jwt")],
      ["a non-Bearer scheme", await post(app, await serviceJwt(), { scheme: "Basic" })],
    ];
    const reference = await failures[0]![1].clone().text();
    expect(JSON.parse(reference)).toMatchObject({ status: 401, instance: PATH });
    for (const [label, res] of failures) {
      expect({ label, status: res.status }).toEqual({ label, status: 401 });
      expect({ label, body: await res.text() }).toEqual({ label, body: reference });
    }
    expect(reached.count).toBe(0);
  });

  it("is decided before the body: a bad credential with an unknown key, a title, or text that is not JSON is a 401, never a 400", async () => {
    const { app, reached } = build();
    const withTitle = JSON.stringify({ noticeId: "n", meeting: { id: "m", seq: 1, facts: null, title: "Offer review" } });
    const unauthorized = await (await post(app, null)).text();
    for (const [token, body] of [
      [null, withTitle],
      ["not-a-jwt", withTitle],
      [await serviceJwt({ sub: "system:crm-api" }), withTitle],
      [await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE, scope: null }), "{ not json"],
      [null, ""],
    ] as const) {
      const res = await post(app, token, { body });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(unauthorized);
    }
    expect(reached.count).toBe(0);
  });

  it("fails closed when no service audience is configured, even for an otherwise valid token", async () => {
    const { app, reached } = build({ audience: undefined });
    const res = await post(app, await serviceJwt());
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(await (await post(build().app, null)).text());
    expect(reached.count).toBe(0);
  });
});

describe("in hours-api's own environment", () => {
  it("reads SERVICE_AUDIENCE and AUTH_ISSUER from hours-api's env when the options leave them out, and AUTH_JWKS_URL through the default key set", async () => {
    const previous = __setDefaultJwksForTests(jwks);
    try {
      const { app, reached } = build({ withJwks: false, withAudience: false });
      expect((await post(app, await serviceJwt())).status).toBe(200);
      // `SERVICE_AUDIENCE` (what the test environment sets: TEST_SERVICE_AUDIENCE) is the audience, never the user's.
      expect((await post(app, await serviceJwt({ aud: TEST_AUDIENCE }))).status).toBe(401);
      expect((await post(app, await serviceJwt({ iss: "http://evil.example" }))).status).toBe(401);
      expect(reached.count).toBe(1);
    } finally {
      __setDefaultJwksForTests(previous);
    }
  });
});

describe("what an accepted and a refused call log", () => {
  it("an accepted call names its caller and nothing else; a refused one names nobody and never the token", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { app } = build();
      const token = await serviceJwt();
      const refused = await serviceJwt({ sub: "system:crm-api" });
      await post(app, token);
      await post(app, refused);
      const lines = [...log.mock.calls, ...warn.mock.calls].map((args) => args.join(" "));
      expect(lines.filter((l) => l.includes("caller="))).toEqual([`[system-auth] POST ${PATH} caller=system:meetings-api`]);
      for (const line of lines) for (const secret of [token, refused, "notice-1", "meeting-1"]) expect(line).not.toContain(secret);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
