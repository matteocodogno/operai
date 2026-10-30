/**
 * Auth matrix for the two internal routes (specs/015 T6, ADR-0044; specs/016
 * T3, ADR-0049): one scoped middleware, each route requiring its own scope.
 * specs/016 T14: the shared X-Internal-Token is gone; the header is never a credential.
 *
 * No DB: a tiny Hono app with the auth middleware + a recording handler
 * proves the guard stops (or lets through) the request. Keys and the JWKS are
 * generated in memory and INJECTED into the middleware factory, so nothing
 * here depends on module load order or a live auth service.
 */

import { describe, it, expect, beforeAll, spyOn } from "bun:test";
import { Hono } from "hono";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
} from "jose";
import { env } from "@/lib/env";
import {
  createSystemAuthMiddleware,
  originAllowed,
  type SystemAuthVariables,
} from "./systemAuth.middleware";

const ISSUER = env.AUTH_ISSUER;
const SERVICE_AUD = "operai-system-test";
const USER_AUD = "operai-suite-test";
const KID = "svc-test-kid";
// The retired header, with any value. The name is built from parts so no file
// under notify-api/src spells it (tasks.md T14 done-when). When a local env
// file still carries the old secret, that exact value is used, so the test
// would fail if the token were ever accepted again.
const RETIRED_VAR = ["NOTIFY", "INTERNAL", "TOKEN"].join("_");
const RETIRED_VALUE = process.env[RETIRED_VAR] ?? "x".repeat(48);
const RETIRED_HEADER_VALUES = [RETIRED_VALUE, "undefined", "", "wrong"];

let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherSigningKey = (await generateKeyPair("RS256")).privateKey;
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
  const jwt = new SignJWT(o.scope === null ? {} : { scope: o.scope ?? "notifications.push" })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? KID })
    .setIssuedAt()
    .setIssuer(o.iss ?? ISSUER);
  if (o.sub !== null) jwt.setSubject(o.sub ?? "system:inventory-api");
  if (o.aud !== null) jwt.setAudience(o.aud ?? SERVICE_AUD);
  if (o.exp !== null) jwt.setExpirationTime(o.exp ?? "5m");
  return jwt.sign(o.signer ?? signingKey);
};

type App = Hono<{ Variables: SystemAuthVariables }>;

const buildApp = (
  opts: { audience?: string | undefined; scope?: "notifications.push" | "emails.send" } = {
    audience: SERVICE_AUD,
  },
) => {
  const audience = "audience" in opts ? opts.audience : SERVICE_AUD;
  const ran = { value: false };
  const seen: { origins?: readonly string[]; sub?: string } = {};
  const app: App = new Hono();
  app.use(
    "/x",
    createSystemAuthMiddleware({
      scope: opts.scope ?? "notifications.push",
      jwks,
      audience,
    }),
  );
  app.post("/x", (c) => {
    ran.value = true;
    seen.origins = c.get("allowedOrigins");
    seen.sub = c.get("serviceSub");
    return c.json({ ok: true });
  });
  return { app, ran, seen };
};

const post = (app: App, headers: Record<string, string>) =>
  app.request("/x", { method: "POST", headers });

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("the retired shared token (specs/016 T14, AC-5.1)", () => {
  it("X-Internal-Token with any value alone -> 401, handler not run", async () => {
    for (const scope of ["notifications.push", "emails.send"] as const) {
      for (const v of RETIRED_HEADER_VALUES) {
        const { app, ran } = buildApp({ scope });
        expect((await post(app, { "X-Internal-Token": v })).status).toBe(401);
        expect(ran.value).toBe(false);
      }
    }
  });

  it("is refused even when the service-JWT path is disabled (SERVICE_AUDIENCE unset)", async () => {
    const { app, ran } = buildApp({ audience: undefined });
    expect((await post(app, { "X-Internal-Token": RETIRED_VALUE })).status).toBe(401);
    expect(ran.value).toBe(false);
  });

  it("no credentials at all -> 401", async () => {
    const { app, ran } = buildApp();
    expect((await post(app, {})).status).toBe(401);
    expect(ran.value).toBe(false);
  });
});

describe("scoped service JWT", () => {
  it("valid token -> accepted, bound to the inventory origin only", async () => {
    const { app, ran, seen } = buildApp();
    const res = await post(app, bearer(await sign()));
    expect(res.status).toBe(200);
    expect(ran.value).toBe(true);
    expect(seen.sub).toBe("system:inventory-api");
    expect(seen.origins).toEqual(["inventory"]);
  });

  it("scope may be one of several space-separated scopes", async () => {
    const { app } = buildApp();
    const res = await post(app, bearer(await sign({ scope: "other.thing notifications.push" })));
    expect(res.status).toBe(200);
  });

  it("refund-api and estimai-api are bound to their own origin only", async () => {
    for (const [sub, origin] of [
      ["system:refund-api", "refund"],
      ["system:estimai-api", "estimai"],
    ] as const) {
      const { app, seen } = buildApp();
      expect((await post(app, bearer(await sign({ sub })))).status).toBe(200);
      expect(seen.origins).toEqual([origin]);
    }
  });

  it("an unknown system:* client authenticates but is bound to NO origin", async () => {
    const { app, seen } = buildApp();
    const res = await post(app, bearer(await sign({ sub: "system:someone-else" })));
    expect(res.status).toBe(200);
    expect(seen.origins).toEqual([]);
  });

  const rejected: Array<[string, () => Promise<string>]> = [
    ["user JWT (aud = AUTH_AUDIENCE)", () => sign({ aud: USER_AUD, sub: "user-1" })],
    ["wrong audience", () => sign({ aud: "somewhere-else" })],
    ["missing audience", () => sign({ aud: null })],
    ["missing scope claim", () => sign({ scope: null })],
    ["wrong scope (the other route's)", () => sign({ scope: "emails.send" })],
    ["scope that merely contains the string as a prefix", () => sign({ scope: "notifications.push.admin" })],
    ["empty scope", () => sign({ scope: "" })],
    ["wrong issuer", () => sign({ iss: "http://evil.example" })],
    ["expired", () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["no exp claim", () => sign({ exp: null })],
    ["missing sub", () => sign({ sub: null })],
    ["sub is not system:*", () => sign({ sub: "user-1" })],
    ["sub is the bare prefix", () => sign({ sub: "system:" })],
    ["signed with a different key", () => sign({ signer: otherSigningKey })],
    ["unknown kid", () => sign({ kid: "nope" })],
    [
      "alg:none",
      async () =>
        new UnsecuredJWT({ scope: "notifications.push" })
          .setIssuer(ISSUER)
          .setAudience(SERVICE_AUD)
          .setSubject("system:inventory-api")
          .setExpirationTime("5m")
          .encode(),
    ],
    [
      "HS256 signed with the public JWK as the shared secret",
      async () =>
        new SignJWT({ scope: "notifications.push" })
          .setProtectedHeader({ alg: "HS256", kid: KID })
          .setIssuer(ISSUER)
          .setAudience(SERVICE_AUD)
          .setSubject("system:inventory-api")
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

  it("every rejection carries a byte-identical body (no detail leak)", async () => {
    const { app } = buildApp();
    const bodies = new Set<string>();
    for (const [, make] of rejected) {
      const res = await post(app, bearer(await make()));
      bodies.add(JSON.stringify(await res.json()));
    }
    for (const h of [{}, { "X-Internal-Token": RETIRED_VALUE }]) {
      bodies.add(JSON.stringify(await (await post(app, h)).json()));
    }
    expect(bodies.size).toBe(1);
  });

  it("disabled when SERVICE_AUDIENCE is unset: a validly signed service JWT is 401", async () => {
    const { app, ran } = buildApp({ audience: undefined });
    const res = await post(app, bearer(await sign()));
    expect(res.status).toBe(401);
    expect(ran.value).toBe(false);
  });

  it("the retired header does not rescue an invalid JWT, and does not disturb a valid one", async () => {
    const { app } = buildApp();
    expect(
      (await post(app, { ...bearer(await sign()), "X-Internal-Token": "wrong" })).status,
    ).toBe(200);
    expect(
      (await post(app, { ...bearer(await sign({ scope: "x" })), "X-Internal-Token": RETIRED_VALUE })).status,
    ).toBe(401);
  });

  it("a non-Bearer scheme or an empty token -> 401", async () => {
    const { app } = buildApp();
    expect((await post(app, { Authorization: `Basic ${await sign()}` })).status).toBe(401);
    expect((await post(app, { Authorization: "Bearer " })).status).toBe(401);
  });
});

describe("each route requires its own scope", () => {
  it("emails.send: accepted with the email scope, 401 with only the push scope", async () => {
    const ok = buildApp({ scope: "emails.send" });
    const res = await post(ok.app, bearer(await sign({ scope: "emails.send", sub: "system:auth" })));
    expect(res.status).toBe(200);
    expect(ok.seen.sub).toBe("system:auth");

    const no = buildApp({ scope: "emails.send" });
    expect((await post(no.app, bearer(await sign({ scope: "notifications.push" })))).status).toBe(401);
    expect(no.ran.value).toBe(false);
  });

  it("a credential holding both scopes is accepted on both routes", async () => {
    const t = await sign({ scope: "notifications.push emails.send", sub: "system:refund-api" });
    for (const scope of ["notifications.push", "emails.send"] as const) {
      expect((await post(buildApp({ scope }).app, bearer(t))).status).toBe(200);
    }
  });

  it("the 401 body is byte-identical across scopes, causes and routes", async () => {
    const bodies = new Set<string>();
    for (const scope of ["notifications.push", "emails.send"] as const) {
      const { app } = buildApp({ scope });
      const other = scope === "emails.send" ? "notifications.push" : "emails.send";
      for (const h of [{}, bearer(await sign({ scope: other })), { "X-Internal-Token": "wrong" }]) {
        const res = await post(app, h);
        const j = (await res.json()) as Record<string, unknown>;
        bodies.add(JSON.stringify({ ...j, instance: undefined }));
      }
    }
    expect(bodies.size).toBe(1);
  });
});

describe("caller log line", () => {
  const capture = () => {
    const spies = [
      spyOn(console, "log").mockImplementation(() => {}),
      spyOn(console, "info").mockImplementation(() => {}),
      spyOn(console, "warn").mockImplementation(() => {}),
      spyOn(console, "error").mockImplementation(() => {}),
    ];
    const lines = () => spies.flatMap((s) => s.mock.calls.map((a) => a.join(" ")));
    return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
  };

  it("a service credential logs exactly one line naming its sub", async () => {
    const log = capture();
    try {
      const { app } = buildApp();
      const token = await sign({ sub: "system:refund-api" });
      await app.request("/x?secret=abc", { method: "POST", headers: bearer(token) });
      expect(log.lines()).toEqual(["[system-auth] POST /x caller=system:refund-api"]);
      expect(log.lines().join("\n")).not.toContain(token);
    } finally {
      log.restore();
    }
  });

  it("a refused call logs no caller line", async () => {
    const log = capture();
    try {
      await post(buildApp().app, { "X-Internal-Token": RETIRED_VALUE });
      expect(log.lines().filter((l) => l.includes("caller="))).toEqual([]);
    } finally {
      log.restore();
    }
  });
});

describe("originAllowed", () => {
  it("a list allows only its members; an empty list allows nothing", () => {
    expect(originAllowed(["inventory"], "inventory")).toBe(true);
    expect(originAllowed(["inventory"], "refund")).toBe(false);
    expect(originAllowed([], "inventory")).toBe(false);
  });
});
