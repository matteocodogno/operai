/**
 * The service read API of the legal-entity registry (T6; AC-3.2, AC-3.4; plan decisions 2-3, E2) against REAL Postgres.
 *
 * Route logic with an injected key source backed by a throwaway in-memory RS256 key (this file must not depend on
 * `auth.config`'s real key set; `auth.config` is mocked only because the person router, compared against here, imports
 * its session source). Version rows are written and read inside ONE rolled-back transaction (`testDb.ts`); both
 * routers read through it. Limit rows build their own limits with an injected clock and send no `X-Forwarded-For`
 * unless the row is about the address.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { db } from "../lib/db";
import { inRolledBackTx, type Tx } from "./testDb";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;

mock.module("../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession) } },
}));

const { env } = await import("../lib/env");
const { createSystemLegalEntitiesRouter, FROZEN_UNAUTHORIZED_BODY, LEGAL_ENTITIES_READ_SCOPE } = await import("./system.routes");
const { createLegalEntityReadRouter, UNKNOWN_LEGAL_ENTITY_BODY } = await import("./read.routes");
const { createSystemRateLimits } = await import("../system/systemRateLimits");
const { MAX_TOKEN_CHARS } = await import("../system/userContact.routes");

const { publicKey, privateKey } = await generateKeyPair("RS256");
const stranger = await generateKeyPair("RS256");
const KID = "le-test-kid";
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" }] });

const SERVICE_AUDIENCE = "operai-legal-entities-test";
const RUN_ID = crypto.randomUUID().slice(0, 8);
const mutableEnv = env as unknown as Record<string, unknown>;
const saved = { audience: env.SERVICE_AUDIENCE };
let personId = "";

beforeAll(async () => {
  mutableEnv["SERVICE_AUDIENCE"] = SERVICE_AUDIENCE;
  const person = await db.user.create({ data: { name: `T6 person ${RUN_ID}`, email: `t6-le-${RUN_ID}@legalentities.test` } });
  personId = person.id;
  currentSession = { user: { id: person.id, email: person.email, name: person.name }, session: { id: `sess-${person.id}` } };
});
afterAll(async () => {
  mutableEnv["SERVICE_AUDIENCE"] = saved.audience;
  await db.user.deleteMany({ where: { id: personId } });
});

let logSpy: ReturnType<typeof spyOn<Console, "log">> | undefined;
let warnSpy: ReturnType<typeof spyOn<Console, "warn">> | undefined;
// The route logs one line per accepted call and the verifier warns per refusal: keep the run readable.
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  logSpy?.mockRestore();
  warnSpy?.mockRestore();
  logSpy = warnSpy = undefined;
});

const sign = async (
  opts: { sub?: string; aud?: string; scope?: string | undefined; iss?: string; signer?: CryptoKey; exp?: number } = {},
): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (!("scope" in opts) || opts.scope !== undefined) claims["scope"] = opts.scope ?? LEGAL_ENTITIES_READ_SCOPE;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(opts.iss ?? env.BETTER_AUTH_URL)
    .setSubject(opts.sub ?? "system:crm-api")
    .setAudience(opts.aud ?? SERVICE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(opts.signer ?? privateKey);
};

interface Seed {
  entity: "welld_it" | "welld_ch";
  version: number;
  legalName?: string;
  addressIt?: string[];
  addressEn?: string[];
  vatNumber?: string;
  iban?: string;
  createdAt?: string;
}

async function seed(tx: Tx, s: Seed) {
  const action = s.version === 1 ? "import" : "save";
  const by = s.version === 1 ? null : "u-saver";
  await tx.$executeRaw`
    INSERT INTO legal_entity_version
      ("entity","version","legalName","addressIt","addressEn","vatNumber","iban","contactsIt","contactsEn",
       "action","changedFields","createdByUserId","createdByName","createdAt")
    VALUES (${s.entity}, ${s.version}, ${s.legalName ?? ""}, ${s.addressIt ?? []}::text[], ${s.addressEn ?? []}::text[],
       ${s.vatNumber ?? ""}, ${s.iban ?? ""}, 'Tel +41', 'Phone +41', ${action}, ARRAY[]::text[], ${by}, ${by},
       ${new Date(s.createdAt ?? "2026-11-17T10:00:00.000Z")})`;
}

const CH_V1: Seed = { entity: "welld_ch", version: 1, legalName: "old name", addressIt: ["old"], addressEn: ["old"], vatNumber: "OLD" };
const CH_V2: Seed = {
  entity: "welld_ch",
  version: 2,
  legalName: "wellD SA",
  addressIt: ["Via Cantonale 1", "6900 Lugano"],
  addressEn: ["Via Cantonale 1", "6900 Lugano"],
  vatNumber: "CHE-123.456.789 IVA",
  iban: "CH9300762011623852957",
  createdAt: "2026-11-17T10:12:00.000Z",
};
const IT_V1: Seed = {
  entity: "welld_it",
  version: 1,
  legalName: "wellD S.r.l.",
  addressIt: ["Via Roma 1", "20100 Milano"],
  addressEn: ["Via Roma 1", "20100 Milan"],
  vatNumber: "IT01234567890",
  iban: "IT60X0542811101000000123457",
};

let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter += 1)}`;

/** The service router over `client`, with its own limits unless given. */
function serviceRouter(client: Tx, limits = createSystemRateLimits()) {
  return createSystemLegalEntitiesRouter({ getJwks: async () => jwks, limits, client });
}

async function getAs(router: OpenAPIHono, path: string, token?: string | null, ip = freshIp()) {
  const headers: Record<string, string> = { "X-Forwarded-For": ip };
  const t = token === undefined ? await sign() : token;
  if (t) headers["Authorization"] = `Bearer ${t}`;
  return router.request(path, { headers });
}

describe("the 200 answer (AC-3.2): byte-equal to the person route over the same rows", () => {
  test("list and one entity, both entities, every byte of body and the headers that matter", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V1);
      await seed(tx, CH_V2);
      await seed(tx, IT_V1);
      const person = createLegalEntityReadRouter(tx);
      const service = serviceRouter(tx);
      for (const path of ["/legal-entities", "/legal-entities/welld_it", "/legal-entities/welld_ch"]) {
        const expected = await person.request(path);
        const got = await getAs(service, `/system${path}`);
        expect(got.status).toBe(200);
        expect(got.status).toBe(expected.status);
        expect(await got.text()).toBe(await expected.text());
        expect(got.headers.get("cache-control")).toBe("no-store");
        expect(got.headers.get("content-type")).toBe(expected.headers.get("content-type") ?? "");
      }
    });
  });

  test("an entity not moved yet is version 0 with empty values, 200, as for the person route", async () => {
    await inRolledBackTx(async (tx) => {
      const person = createLegalEntityReadRouter(tx);
      const service = serviceRouter(tx);
      const got = await getAs(service, "/system/legal-entities/welld_ch");
      expect(got.status).toBe(200);
      expect(await got.text()).toBe(await (await person.request("/legal-entities/welld_ch")).text());
      expect(await (await getAs(service, "/system/legal-entities/welld_ch")).json()).toMatchObject({ version: 0, complete: false });
    });
  });

  test("the answer is the current version, the IBAN included, in both forms", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V1);
      await seed(tx, CH_V2);
      const body = (await (await getAs(serviceRouter(tx), "/system/legal-entities/welld_ch")).json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        entity: "welld_ch",
        version: 2,
        legalName: "wellD SA",
        iban: "CH9300762011623852957",
        ibanPrint: "CH93 0076 2011 6238 5295 7",
        complete: true,
      });
    });
  });

  test("a scope among others is enough; `legal-entities:read` is matched as a whole word", async () => {
    await inRolledBackTx(async (tx) => {
      const service = serviceRouter(tx);
      expect((await getAs(service, "/system/legal-entities", await sign({ scope: "notifications.push legal-entities:read" }))).status).toBe(200);
      expect((await getAs(service, "/system/legal-entities", await sign({ scope: "legal-entities:read letterhead:render" }))).status).toBe(200);
      expect((await getAs(service, "/system/legal-entities", await sign({ scope: "legal-entities:readx" }))).status).toBe(401);
      expect((await getAs(service, "/system/legal-entities", await sign({ scope: "xlegal-entities:read" }))).status).toBe(401);
      expect((await getAs(service, "/system/legal-entities", await sign({ scope: "legal-entities:write" }))).status).toBe(401);
    });
  });
});

describe("the credential: every failure is the identical frozen 401 (AC-3.2)", () => {
  const cases: [string, () => Promise<string | null>][] = [
    ["a missing header", async () => null],
    ["a user JWT (aud AUTH_AUDIENCE)", () => sign({ aud: env.AUTH_AUDIENCE })],
    ["a wrong audience", () => sign({ aud: "someone-else" })],
    ["a missing scope claim", () => sign({ scope: undefined })],
    ["another service scope", () => sign({ scope: "users.contact" })],
    ["a sub without the system: prefix", () => sign({ sub: "user-123" })],
    ["a bare system: sub", () => sign({ sub: "system:" })],
    ["a wrong issuer", () => sign({ iss: "https://evil.example" })],
    ["a signature from another keypair", () => sign({ signer: stranger.privateKey })],
    ["an expired token", () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["garbage", async () => "not-a-jwt"],
    ["a token over the length cap", async () => "a".repeat(MAX_TOKEN_CHARS + 1)],
  ];
  const paths = [
    "/system/legal-entities",
    "/system/legal-entities/welld_ch",
    "/system/legal-entities/welld_de",
    "/system/legal-entities/manageable",
    `/system/legal-entities/${"x".repeat(300)}`,
  ];

  test("all failures, on every path, return the same status, headers and body bytes, which are the frozen constant", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V2);
      const service = serviceRouter(tx);
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const seen = new Set<string>();
      for (const [label, make] of cases) {
        for (const path of paths) {
          const res = await getAs(service, path, await make());
          expect({ label, path: path.slice(0, 40), status: res.status }).toEqual({ label, path: path.slice(0, 40), status: 401 });
          expect(res.headers.get("cache-control")).toBe("no-store");
          const text = await res.text();
          expect(text).not.toContain("wellD SA");
          expect(text).not.toContain("xxxx");
          seen.add(`${res.headers.get("content-type")}|${text}`);
        }
      }
      expect([...seen]).toEqual([`application/json|${JSON.stringify(FROZEN_UNAUTHORIZED_BODY)}`]);
    });
  });

  test("a person's session (cookie, no bearer) and a person's bearer open nothing here", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V2);
      const service = serviceRouter(tx);
      const withCookie = await service.request("/system/legal-entities", { headers: { Cookie: "better-auth.session_token=abc" } });
      expect(withCookie.status).toBe(401);
      // The person route does answer for the same session: the families do not mix.
      expect((await createLegalEntityReadRouter(tx).request("/legal-entities")).status).toBe(200);
    });
  });

  test("a rejected request reads no row (the key set is the only work done)", async () => {
    let reads = 0;
    const counting = { $queryRaw: (async () => (reads += 1, [])) as unknown as Tx["$queryRaw"] } as unknown as Tx;
    const service = serviceRouter(counting);
    expect((await getAs(service, "/system/legal-entities", null)).status).toBe(401);
    expect((await getAs(service, "/system/legal-entities/welld_ch", await sign({ scope: "users.contact" }))).status).toBe(401);
    expect(reads).toBe(0);
  });

  test("an unknown name without a valid credential is 401, not 404 (nothing to learn before authenticating)", async () => {
    await inRolledBackTx(async (tx) => {
      expect((await getAs(serviceRouter(tx), "/system/legal-entities/welld_de", null)).status).toBe(401);
    });
  });

  test("only GET answers: other methods never reach the registry", async () => {
    await inRolledBackTx(async (tx) => {
      const service = serviceRouter(tx);
      const token = await sign();
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await service.request("/system/legal-entities/welld_ch", { method, headers: { Authorization: `Bearer ${token}` } });
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("wellD");
      }
    });
  });
});

describe("an unknown entity name (AC-3.4, E2)", () => {
  const names = ["welld_de", "%00", "x".repeat(300), "WELLD_CH", "welld_ch%20", "constructor", "__proto__", "%E0%A4%A", "%zz", "manageable", "Manageable", "a%2Fb"];

  test("with a valid credential: one fixed 404, byte-identical to the person route's, containing none of the names", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V2);
      const person = createLegalEntityReadRouter(tx);
      const service = serviceRouter(tx);
      const personBodies = new Set<string>();
      const serviceBodies = new Set<string>();
      for (const name of names) {
        const res = await getAs(service, `/system/legal-entities/${name}`);
        expect({ name: name.slice(0, 30), status: res.status }).toEqual({ name: name.slice(0, 30), status: 404 });
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        serviceBodies.add(text);
        expect(text).not.toContain(name);
        expect(text).not.toContain("wellD SA");
        personBodies.add(await (await person.request(`/legal-entities/${name === "manageable" ? "welld_de" : name}`)).text());
      }
      expect([...serviceBodies]).toEqual([JSON.stringify(UNKNOWN_LEGAL_ENTITY_BODY)]);
      expect([...personBodies]).toEqual([...serviceBodies]);
    });
  });

  test("`manageable` does not exist under /system: the standard 404, not a list, not a 200 (E2)", async () => {
    await inRolledBackTx(async (tx) => {
      const res = await getAs(serviceRouter(tx), "/system/legal-entities/manageable");
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ status: 404, code: "unknown_legal_entity" });
    });
  });
});

describe("the per-service limit (AC-3.2): 300 per window, counted after verification", () => {
  const T0 = 9_000_000;
  const clock = () => {
    let t = T0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  test("the 300th call is answered, the 301st is the one 429; the window ends on its own", async () => {
    await inRolledBackTx(async (tx) => {
      const c = clock();
      const limits = createSystemRateLimits({ now: c.now });
      const service = serviceRouter(tx, limits);
      const token = await sign();
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      for (let i = 1; i <= 300; i++) {
        const res = await service.request("/system/legal-entities", { headers: { Authorization: `Bearer ${token}` } });
        if (res.status !== 200) throw new Error(`call ${i} answered ${res.status}`);
      }
      const refused = await service.request("/system/legal-entities/welld_ch", { headers: { Authorization: `Bearer ${token}` } });
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("600");
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(await refused.json()).toMatchObject({ status: 429, code: "rate_limited" });

      // Both routes share the one allowance; a refusal is not recorded, so the window is not extended.
      expect((await service.request("/system/legal-entities", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(429);
      c.advance(600_001);
      expect((await service.request("/system/legal-entities", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    });
  });

  test("the allowance is per verified service: one service exhausted does not refuse another", async () => {
    await inRolledBackTx(async (tx) => {
      const limits = createSystemRateLimits({ now: clock().now, config: { legalEntitiesLimit: 2 } });
      const service = serviceRouter(tx, limits);
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      const crm = await sign({ sub: "system:crm-api" });
      const letterhead = await sign({ sub: "system:letterhead-api" });
      const call = (token: string) => service.request("/system/legal-entities", { headers: { Authorization: `Bearer ${token}` } });
      expect([(await call(crm)).status, (await call(crm)).status, (await call(crm)).status]).toEqual([200, 200, 429]);
      expect((await call(letterhead)).status).toBe(200);
    });
  });

  test("the limiter is its own: the other /system limiters' allowances are untouched, and it does not use theirs", async () => {
    await inRolledBackTx(async (tx) => {
      const limits = createSystemRateLimits({
        now: clock().now,
        config: { legalEntitiesLimit: 1, serviceTokenLimit: 1, usersContactLimit: 1 },
      });
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      limits.serviceToken.consume("system:crm-api");
      limits.usersContact.consume("system:crm-api");
      const service = serviceRouter(tx, limits);
      expect((await getAs(service, "/system/legal-entities")).status).toBe(200);
      expect((await getAs(service, "/system/legal-entities")).status).toBe(429);
      expect(limits.serviceToken.consume("system:crm-api").allowed).toBe(false);
    });
  });

  test("an invalid credential counts against the source address only, never against a service's allowance", async () => {
    await inRolledBackTx(async (tx) => {
      const limits = createSystemRateLimits({ now: clock().now, config: { legalEntitiesLimit: 2, invalidLimit: 3 } });
      const service = serviceRouter(tx, limits);
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const ip = "198.51.100.7";
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await getAs(service, "/system/legal-entities", "not-a-jwt", ip)).status);
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      // The same address with a valid credential is counted as the service, not as the address.
      const crm = await sign({ sub: "system:crm-api" });
      expect((await getAs(service, "/system/legal-entities", crm, ip)).status).toBe(200);
      expect((await getAs(service, "/system/legal-entities", crm, ip)).status).toBe(200);
      expect((await getAs(service, "/system/legal-entities", crm, ip)).status).toBe(429);
    });
  });

  test("the invalid-credential count is the SAME counter as the other /system routes (one limits object)", async () => {
    await inRolledBackTx(async (tx) => {
      const limits = createSystemRateLimits({ now: clock().now, config: { invalidLimit: 2 } });
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      limits.invalidCredentials.consume("198.51.100.9"); // e.g. a bad mint from the same address
      limits.invalidCredentials.consume("198.51.100.9");
      expect((await getAs(serviceRouter(tx, limits), "/system/legal-entities", null, "198.51.100.9")).status).toBe(429);
    });
  });
});

describe("logging", () => {
  test("one line per accepted call names the caller and nothing else: no entity, no value", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V2);
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const service = serviceRouter(tx);
      await getAs(service, "/system/legal-entities/welld_ch");
      await getAs(service, "/system/legal-entities/welld_de");
      await getAs(service, "/system/legal-entities", null);
      const lines = logSpy.mock.calls.map((args) => args.join(" "));
      expect(lines).toEqual(["[system] legal-entities.read caller=system:crm-api", "[system] legal-entities.read caller=system:crm-api"]);
      expect(JSON.stringify([...lines, ...warnSpy.mock.calls])).not.toMatch(/welld_|wellD|CH93/);
    });
  });
});

describe("mounting", () => {
  test("mounted in a parent beside the person router, as index.ts does, each path reaches its own router", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V2);
      const parent = new OpenAPIHono();
      parent.route("/", createLegalEntityReadRouter(tx));
      parent.route("/", serviceRouter(tx));
      const service = await getAs(parent as never, "/system/legal-entities/welld_ch");
      expect(service.status).toBe(200);
      expect(await service.text()).toBe(await (await parent.request("/legal-entities/welld_ch")).text());
      // The person route still answers, and `manageable` is still the person router's own path.
      expect((await parent.request("/legal-entities/manageable")).status).toBe(200);
      expect((await getAs(parent as never, "/system/legal-entities/manageable")).status).toBe(404);
    });
  });

  test("the module is documented in the API document and declares only GET", () => {
    const router = serviceRouter(db as unknown as Tx);
    expect(new Set(router.routes.map((r) => r.method))).toEqual(new Set(["GET"]));
    const doc = router.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(["/system/legal-entities", "/system/legal-entities/{entity}"]);
  });
});
