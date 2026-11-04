/**
 * systemAuth middleware (specs/021 T6, AC-11.8): the only credential for
 * `POST /system/meeting-host/v1/notices` is a scoped service JWT. A tiny Hono
 * app with the middleware and a recording handler proves what stops and what
 * passes; keys and JWKS are generated in memory and injected, so nothing here
 * needs a database or a live `auth`.
 */

import { TEST_ISSUER } from "../test-support/testAuth"; // sets the environment before ../lib/env is read
import { describe, it, expect, beforeAll, spyOn } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, UnsecuredJWT, createLocalJWKSet } from "jose";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "./systemAuth.middleware";

const SERVICE_AUD = "operai-system-test";
const USER_AUD = "operai-suite";
const KID = "svc-test-kid";
const SUB = "system:meetings-api";
const SCOPE = "host-notices.send";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  jwks = createLocalJWKSet({ keys: [publicJwk] });
});

const sign = (
  o: {
    sub?: string | null;
    aud?: string | null;
    iss?: string;
    scope?: string | null;
    exp?: string | number | null;
    signer?: CryptoKey;
    kid?: string;
  } = {},
) => {
  const jwt = new SignJWT(o.scope === null ? {} : { scope: o.scope ?? SCOPE })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? KID })
    .setIssuedAt()
    .setIssuer(o.iss ?? TEST_ISSUER);
  if (o.sub !== null) jwt.setSubject(o.sub ?? SUB);
  if (o.aud !== null) jwt.setAudience(o.aud ?? SERVICE_AUD);
  if (o.exp !== null) jwt.setExpirationTime(o.exp ?? "5m");
  return jwt.sign(o.signer ?? signingKey);
};

type App = Hono<{ Variables: SystemAuthVariables }>;

const buildApp = (opts: { audience?: string | undefined } = { audience: SERVICE_AUD }) => {
  const ran = { value: false };
  const seen: { sub?: string } = {};
  const app: App = new Hono();
  app.use(
    "/x",
    createSystemAuthMiddleware({
      scope: SCOPE,
      allowedSubs: [SUB],
      jwks,
      audience: "audience" in opts ? opts.audience : SERVICE_AUD,
    }),
  );
  app.post("/x", (c) => {
    ran.value = true;
    seen.sub = c.get("serviceSub");
    return c.json({ ok: true });
  });
  return { app, ran, seen };
};

const post = (app: App, headers: Record<string, string> = {}) => app.request("/x", { method: "POST", headers });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("a valid scoped service JWT", () => {
  it("is accepted and the handler sees the service sub", async () => {
    const { app, ran, seen } = buildApp();
    const res = await post(app, bearer(await sign()));
    expect(res.status).toBe(200);
    expect(ran.value).toBe(true);
    expect(seen.sub).toBe(SUB);
  });

  it("may carry other scopes next to the one required", async () => {
    const { app } = buildApp();
    expect((await post(app, bearer(await sign({ scope: `notifications.push ${SCOPE}` })))).status).toBe(200);
  });
});

describe("rejections", () => {
  const rejected: Array<[string, () => Promise<string>]> = [
    ["a user JWT (aud = AUTH_AUDIENCE)", () => sign({ aud: USER_AUD, sub: "user-1" })],
    ["a token with the right sub and scope but the user audience", () => sign({ aud: USER_AUD })],
    ["wrong audience", () => sign({ aud: "somewhere-else" })],
    ["missing audience", () => sign({ aud: null })],
    ["missing scope claim", () => sign({ scope: null })],
    ["a different scope", () => sign({ scope: "notifications.push" })],
    ["a scope that only has the required one as a prefix", () => sign({ scope: `${SCOPE}.admin` })],
    ["an empty scope", () => sign({ scope: "" })],
    ["an unlisted system sub", () => sign({ sub: "system:refund-api" })],
    ["a non-system sub", () => sign({ sub: "user-1" })],
    ["the bare prefix as sub", () => sign({ sub: "system:" })],
    ["missing sub", () => sign({ sub: null })],
    ["wrong issuer", () => sign({ iss: "http://evil.example" })],
    ["expired", () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["no exp claim", () => sign({ exp: null })],
    ["signed with another key", () => sign({ signer: otherKey })],
    ["an unknown kid", () => sign({ kid: "nope" })],
    [
      "alg:none",
      async () =>
        new UnsecuredJWT({ scope: SCOPE })
          .setIssuer(TEST_ISSUER)
          .setAudience(SERVICE_AUD)
          .setSubject(SUB)
          .setExpirationTime("5m")
          .encode(),
    ],
    [
      "HS256 signed with the public JWK as the secret",
      async () =>
        new SignJWT({ scope: SCOPE })
          .setProtectedHeader({ alg: "HS256", kid: KID })
          .setIssuer(TEST_ISSUER)
          .setAudience(SERVICE_AUD)
          .setSubject(SUB)
          .setExpirationTime("5m")
          .sign(new TextEncoder().encode(JSON.stringify(publicJwk))),
    ],
    ["garbage", async () => "not.a.jwt"],
  ];

  for (const [name, make] of rejected) {
    it(`401: ${name}`, async () => {
      const { app, ran } = buildApp();
      const res = await post(app, bearer(await make()));
      expect(res.status).toBe(401);
      expect(ran.value).toBe(false);
    });
  }

  it("every rejection carries the same body, so a caller learns nothing about which check failed", async () => {
    const { app } = buildApp();
    const bodies = new Set<string>();
    for (const [, make] of rejected) {
      bodies.add(JSON.stringify(await (await post(app, bearer(await make()))).json()));
    }
    bodies.add(JSON.stringify(await (await post(app)).json()));
    bodies.add(JSON.stringify(await (await post(app, { Authorization: "Basic abc" })).json()));
    expect(bodies.size).toBe(1);
  });

  it("no credential, a non-Bearer scheme or an empty token -> 401", async () => {
    const { app, ran } = buildApp();
    expect((await post(app)).status).toBe(401);
    expect((await post(app, { Authorization: `Basic ${await sign()}` })).status).toBe(401);
    expect((await post(app, { Authorization: "Bearer " })).status).toBe(401);
    expect(ran.value).toBe(false);
  });

  it("is closed when SERVICE_AUDIENCE is unset: even a validly signed token is 401", async () => {
    const { app, ran } = buildApp({ audience: undefined });
    expect((await post(app, bearer(await sign()))).status).toBe(401);
    expect(ran.value).toBe(false);
  });

  it("an empty allowlist admits nobody", async () => {
    const app: App = new Hono();
    app.use("/x", createSystemAuthMiddleware({ scope: SCOPE, allowedSubs: [], jwks, audience: SERVICE_AUD }));
    app.post("/x", (c) => c.json({ ok: true }));
    expect((await post(app, bearer(await sign()))).status).toBe(401);
  });
});

describe("caller log line", () => {
  const capture = () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    return {
      lines: () => spies.flatMap((s) => s.mock.calls.map((a) => a.join(" "))),
      restore: () => spies.forEach((s) => s.mockRestore()),
    };
  };

  it("an accepted call logs exactly one line naming its sub, without the token or the query", async () => {
    const log = capture();
    try {
      const { app } = buildApp();
      const token = await sign();
      await app.request("/x?secret=abc", { method: "POST", headers: bearer(token) });
      expect(log.lines()).toEqual([`[system-auth] POST /x caller=${SUB}`]);
      expect(log.lines().join("\n")).not.toContain(token);
    } finally {
      log.restore();
    }
  });

  it("a rejected call never logs the token or a caller line", async () => {
    const log = capture();
    try {
      const { app } = buildApp();
      const token = await sign({ sub: "system:refund-api" });
      await post(app, bearer(token));
      const out = log.lines().join("\n");
      expect(out).not.toContain(token);
      expect(out).not.toContain("caller=");
    } finally {
      log.restore();
    }
  });
});
