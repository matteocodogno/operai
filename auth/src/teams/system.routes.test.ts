/**
 * `GET /system/teams` (specs/20261126-teams, T9; AC-1.5, AC-1.6, AC-4.1, AC-4.7; plan D1, D11, D13, § Security 2)
 * against REAL Postgres: route logic with an injected key source backed by a throwaway in-memory RS256 key, the
 * real rate limits (with an injected clock where a window matters) and the real team tables. A team is no Tier 1
 * record (plan D8), so every row a test commits is tracked and removed in `afterAll`.
 *
 * What the rows prove: one frozen 401 for every credential failure whatever route form or query; verify BEFORE any
 * count and any row read; the allowance chosen only by the presence of `ids`; the two allowances independent;
 * ids mode (request order, unknown omitted, members in name order and inactive last, `appAccess` derived from the
 * verified `sub`); options mode (archived never, ranking exact > prefix > rest, `%` `_` `\` literal, 50 and
 * `truncated`); `q` bounds with a fixed body that never echoes; a log line with no id, name or `q`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { db } from "../lib/db";

const { env } = await import("../lib/env");
const { createSystemTeamsRouter, FROZEN_UNAUTHORIZED_BODY, TEAMS_READ_SCOPE, TEAM_READERS } = await import("./system.routes");
const { createSystemRateLimits } = await import("../system/systemRateLimits");
const { MAX_TOKEN_CHARS } = await import("../system/userContact.routes");

const { publicKey, privateKey } = await generateKeyPair("RS256");
const stranger = await generateKeyPair("RS256");
const KID = "teams-test-kid";
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" }] });

const SERVICE_AUDIENCE = "operai-teams-test";
const RUN = crypto.randomUUID().slice(0, 8);
const mutableEnv = env as unknown as Record<string, unknown>;
const saved = { audience: env.SERVICE_AUDIENCE };

const userIds: string[] = [];
const teamIds: string[] = [];
const roleIds: string[] = [];

beforeAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = SERVICE_AUDIENCE;
});

afterAll(async () => {
  await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
  await db.team.deleteMany({ where: { id: { in: teamIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.role.deleteMany({ where: { id: { in: roleIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  mutableEnv["SERVICE_AUDIENCE"] = saved.audience;
});

// ─── console capture: the route logs one line per accepted call and the verifier warns per refusal ──────────────

let logged: string[] = [];
let spies: { mockRestore(): void }[] = [];
const text = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
beforeEach(() => {
  logged = [];
  spies = (["log", "warn", "error", "info"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(text(args));
    }),
  );
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
});

// ─── credentials ────────────────────────────────────────────────────────────

const sign = async (
  opts: { sub?: string; aud?: string; scope?: string | undefined; iss?: string; signer?: CryptoKey; exp?: number } = {},
): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (!("scope" in opts) || opts.scope !== undefined) claims["scope"] = opts.scope ?? TEAMS_READ_SCOPE;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(opts.iss ?? env.BETTER_AUTH_URL)
    .setSubject(opts.sub ?? "system:projects-api")
    .setAudience(opts.aud ?? SERVICE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(opts.signer ?? privateKey);
};

let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter += 1)}`;

function makeRouter(limits = createSystemRateLimits(), client?: typeof db) {
  return createSystemTeamsRouter({ getJwks: async () => jwks, limits, ...(client ? { client } : {}) });
}

/**
 * The real client behind a counting proxy: every call on a model delegate or `$queryRaw` is recorded with its
 * arguments. (`spyOn(db.team, ...)` cannot do this: Prisma hands out a fresh delegate on every property read.)
 */
function countingClient() {
  const calls: { model: string; method: string; args: unknown[] }[] = [];
  const delegates = new Map<string, unknown>();
  const client = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "$queryRaw") {
        return (...args: unknown[]) => {
          calls.push({ model: "raw", method: "$queryRaw", args });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (typeof prop === "string" && ["team", "teamMember", "userRole", "userDepartment", "user"].includes(prop)) {
        if (!delegates.has(prop)) {
          delegates.set(
            prop,
            new Proxy(value as object, {
              get(d, method) {
                const fn = Reflect.get(d, method);
                if (typeof fn !== "function") return fn;
                return (...args: unknown[]) => {
                  calls.push({ model: prop, method: String(method), args });
                  return fn.apply(d, args);
                };
              },
            }),
          );
        }
        return delegates.get(prop);
      }
      return value;
    },
  }) as typeof db;
  return { client, calls, count: (model?: string) => calls.filter((c) => model === undefined || c.model === model).length };
}
type Router = ReturnType<typeof makeRouter>;

async function get(router: Router, path: string, token?: string | null, ip = freshIp()) {
  const headers: Record<string, string> = { "X-Forwarded-For": ip };
  const t = token === undefined ? await sign() : token;
  if (t) headers["Authorization"] = `Bearer ${t}`;
  const res = await router.request(path, { headers });
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    json = raw;
  }
  return { res, status: res.status, raw, json };
}

// ─── fixtures ───────────────────────────────────────────────────────────────

async function makeUser(label: string, opts: { deleted?: boolean; id?: string } = {}) {
  const user = await db.user.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      name: `${label} ${RUN}`,
      email: `t9-${label.toLowerCase()}-${RUN}-${crypto.randomUUID().slice(0, 4)}@operai.test`,
      emailVerified: true,
      deletedAt: opts.deleted ? new Date() : null,
    },
  });
  userIds.push(user.id);
  return user;
}
async function makeTeam(name: string, opts: { archived?: boolean; members?: string[] } = {}) {
  const team = await db.team.create({
    data: {
      name,
      archivedAt: opts.archived ? new Date() : null,
      members: { create: (opts.members ?? []).map((userId) => ({ userId })) },
    },
  });
  teamIds.push(team.id);
  return team;
}
async function grantAccess(userId: string, resource: string) {
  const role = await db.role.create({
    data: { name: `t9-${resource}-${RUN}-${crypto.randomUUID().slice(0, 4)}`, rules: { create: [{ resource, action: "access" }] } },
  });
  roleIds.push(role.id);
  await db.userRole.create({ data: { userId, roleId: role.id } });
  return role.id;
}

let ada: { id: string; name: string };
let bea: { id: string; name: string };
let cyd: { id: string; name: string };
let gone1: { id: string; name: string };
let gone2: { id: string; name: string };
let backend: { id: string; name: string };
let oldTeam: { id: string; name: string };
let emptyTeam: { id: string; name: string };
let teamOfOther: { id: string; name: string };
let beaRoleId = "";

beforeAll(async () => {
  ada = await makeUser("Ada");
  bea = await makeUser("Bea");
  cyd = await makeUser("Cyd");
  // Ids chosen so that id order (gone1, gone2) is the reverse of name order (Abe, Zed): the test tells them apart.
  gone1 = await makeUser("Zed", { deleted: true, id: `a-${RUN}-gone1` });
  gone2 = await makeUser("Abe", { deleted: true, id: `b-${RUN}-gone2` });
  await grantAccess(ada.id, "projects");
  beaRoleId = await grantAccess(bea.id, "projects");
  // Cyd holds another app's access only: no Projects access.
  await grantAccess(cyd.id, `crm${RUN}`);
  // A deactivated member WITH the access: still reads as inactive and no access.
  await grantAccess(gone1.id, "projects");

  backend = await makeTeam(`Backend ${RUN}`, { members: [cyd.id, gone1.id, bea.id, gone2.id, ada.id] });
  oldTeam = await makeTeam(`Old ${RUN}`, { archived: true, members: [ada.id] });
  emptyTeam = await makeTeam(`Empty ${RUN}`);
  teamOfOther = await makeTeam(`Other ${RUN}`, { members: [bea.id] });
});

const idsPath = (...ids: string[]) => `/system/teams?ids=${ids.join(",")}`;

// ═════════════════════════════════════════════════════════════════════════════

describe("the credential: one frozen 401 for every failure (plan D1, § Security 2)", () => {
  const bodies = new Map<string, string>();

  const failures: [string, () => Promise<string | null>][] = [
    ["no Authorization header", async () => null],
    ["a scheme that is not Bearer", async () => "x"],
    ["a token that is not a JWT", async () => "not-a-jwt"],
    ["a token over the size cap", async () => "a".repeat(MAX_TOKEN_CHARS + 1)],
    ["a user JWT (aud = the user audience)", async () => sign({ aud: "operai-user-audience", scope: undefined })],
    ["a user JWT that even carries the scope", async () => sign({ aud: env.AUTH_AUDIENCE ?? "operai-user-audience", sub: "user-123" })],
    ["a wrong audience", async () => sign({ aud: "someone-else" })],
    ["a missing scope", async () => sign({ scope: undefined })],
    ["another scope", async () => sign({ scope: "legal-entities:read" })],
    ["a near-miss scope", async () => sign({ scope: "teams:readx" })],
    ["a scope that only contains the name", async () => sign({ scope: "xteams:read" })],
    ["an expired token", async () => sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["a token signed by another key", async () => sign({ signer: stranger.privateKey })],
    ["another issuer", async () => sign({ iss: "https://evil.example" })],
    ["a sub that is not a service", async () => sign({ sub: "user-123" })],
    ["a sub that is only the prefix", async () => sign({ sub: "system:" })],
    ["the scope held by a client NOT in TEAM_READERS", async () => sign({ sub: "system:crm-api" })],
    ["the scope held by a client the binding does not know", async () => sign({ sub: "system:nobody" })],
    ["a prototype-property sub", async () => sign({ sub: "system:__proto__" })],
    ["a prototype-property sub, constructor", async () => sign({ sub: "system:constructor" })],
  ];

  const paths = [
    "/system/teams?ids=abc",
    "/system/teams?state=active",
    "/system/teams?state=active&q=back",
    "/system/teams",
    `/system/teams?ids=${"x".repeat(300)}`,
    "/system/teams?ids=a b%00&q=%00",
  ];

  for (const [name, make] of failures) {
    test(`${name}: the identical 401 on every form of the route`, async () => {
      const token = await make();
      for (const path of paths) {
        const r = await get(makeRouter(), path, token);
        expect([name, path, r.status]).toEqual([name, path, 401]);
        expect(r.json).toEqual(FROZEN_UNAUTHORIZED_BODY);
        expect(r.res.headers.get("Cache-Control")).toBe("no-store");
        bodies.set(`${name} ${path}`, r.raw);
      }
    });
  }

  test("every one of those 401 bodies is byte-identical, whatever failed and whatever path was asked", () => {
    expect(bodies.size).toBe(failures.length * paths.length);
    expect(new Set(bodies.values()).size).toBe(1);
    // the body carries no request path or text
    expect(JSON.stringify(FROZEN_UNAUTHORIZED_BODY)).not.toContain("xxx");
    expect(FROZEN_UNAUTHORIZED_BODY.instance).toBe("/system/teams");
  });

  test("the binding names exactly one reader, projects-api, and derives the app from it", () => {
    expect(Object.keys(TEAM_READERS)).toEqual(["system:projects-api"]);
    expect(TEAM_READERS["system:projects-api"]).toBe("projects");
    expect(Object.isFrozen(TEAM_READERS)).toBe(true);
  });

  test("the credential is not accepted from a cookie, a query parameter or a header other than Authorization", async () => {
    const router = makeRouter();
    const token = await sign();
    const viaQuery = await router.request(`/system/teams?state=active&access_token=${token}&token=${token}`, {
      headers: { "X-Forwarded-For": freshIp() },
    });
    const viaCookie = await router.request("/system/teams?state=active", {
      headers: { Cookie: `token=${token}; session=${token}`, "X-Token": token, "X-Forwarded-For": freshIp() },
    });
    expect(viaQuery.status).toBe(401);
    expect(viaCookie.status).toBe(401);
  });

  test("a valid credential answers 200 with no-store", async () => {
    const r = await get(makeRouter(), idsPath(backend.id));
    expect(r.status).toBe(200);
    expect(r.res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("verify, then count, then read (ADR 20261112-system-endpoints-limited-per-verified-service)", () => {
  test("an invalid credential spends no allowance of any service and reads no row", async () => {
    const limits = createSystemRateLimits({ config: { teamsLimit: 1, teamsOptionsLimit: 1 } });
    const counting = countingClient();
    const router = makeRouter(limits, counting.client);
    for (let i = 0; i < 5; i++) {
      expect((await get(router, idsPath(backend.id), await sign({ scope: undefined }))).status).toBe(401);
      expect((await get(router, "/system/teams?state=active", await sign({ sub: "system:crm-api" }))).status).toBe(401);
    }
    expect(counting.count()).toBe(0);
    // the allowances are untouched: one call of each mode is still admitted
    expect((await get(router, idsPath(backend.id))).status).toBe(200);
    expect((await get(router, "/system/teams?state=active")).status).toBe(200);
  });

  test("a spent allowance does not turn an invalid credential into a 429, and an exhausted invalid count does not touch a valid one", async () => {
    const limits = createSystemRateLimits({ config: { teamsLimit: 1, teamsOptionsLimit: 1, invalidLimit: 2 } });
    const router = makeRouter(limits);
    expect((await get(router, idsPath(backend.id))).status).toBe(200);
    expect((await get(router, idsPath(backend.id))).status).toBe(429); // the allowance is spent
    const ip = "198.51.100.7";
    expect((await get(router, idsPath(backend.id), "garbage", ip)).status).toBe(401);
    expect((await get(router, idsPath(backend.id), "garbage", ip)).status).toBe(401);
    // the address's invalid count is now exhausted: the third invalid is the one 429
    const third = await get(router, idsPath(backend.id), "garbage", ip);
    expect(third.status).toBe(429);
    // a valid credential from that very address is judged by its service allowance, not the address count
    expect((await get(router, "/system/teams?state=active", undefined, ip)).status).toBe(200);
  });

  test("the 429 is the one /system 429: same body and headers for either allowance and for an exhausted invalid count", async () => {
    const limits = createSystemRateLimits({ config: { teamsLimit: 1, teamsOptionsLimit: 1, invalidLimit: 1 } });
    const router = makeRouter(limits);
    await get(router, idsPath(backend.id));
    await get(router, "/system/teams?state=active");
    const viaIds = await get(router, idsPath(backend.id));
    const viaOptions = await get(router, "/system/teams?state=active");
    const ip = "198.51.100.9";
    await get(router, idsPath(backend.id), "garbage", ip);
    const viaInvalid = await get(router, idsPath(backend.id), "garbage", ip);
    for (const r of [viaIds, viaOptions, viaInvalid]) {
      expect(r.status).toBe(429);
      expect(r.res.headers.get("Retry-After")).toBe(String(limits.windowMs / 1000));
      expect(r.res.headers.get("Cache-Control")).toBe("no-store");
      expect(r.json.code).toBe("rate_limited");
    }
    // the body names the request path, as the one tooManyRequests does, and nothing that says which limiter refused
    expect(viaIds.json).toEqual(viaOptions.json);
    expect(viaIds.json).toEqual(viaInvalid.json);
  });

  test("a refused (429) request reads no row", async () => {
    const limits = createSystemRateLimits({ config: { teamsLimit: 1, teamsOptionsLimit: 1 } });
    const counting = countingClient();
    const router = makeRouter(limits, counting.client);
    expect((await get(router, idsPath(backend.id))).status).toBe(200);
    expect((await get(router, "/system/teams?state=active")).status).toBe(200);
    const readsSoFar = counting.count();
    expect(readsSoFar).toBeGreaterThan(0); // the counting client does see the route's reads
    expect((await get(router, idsPath(backend.id))).status).toBe(429);
    expect((await get(router, "/system/teams?state=active")).status).toBe(429);
    expect(counting.count()).toBe(readsSoFar);
  });

  test("the two allowances are independent: a spent options allowance leaves ids answering, and the reverse", async () => {
    const limits = createSystemRateLimits({ config: { teamsLimit: 2, teamsOptionsLimit: 2 } });
    const router = makeRouter(limits);
    expect((await get(router, "/system/teams?state=active")).status).toBe(200);
    expect((await get(router, "/system/teams?state=active&q=back")).status).toBe(200);
    expect((await get(router, "/system/teams?state=active")).status).toBe(429);
    expect((await get(router, idsPath(backend.id))).status).toBe(200);
    expect((await get(router, idsPath(backend.id))).status).toBe(200);
    expect((await get(router, idsPath(backend.id))).status).toBe(429);
    expect((await get(router, "/system/teams?state=active")).status).toBe(429);

    const reverse = makeRouter(createSystemRateLimits({ config: { teamsLimit: 1, teamsOptionsLimit: 1 } }));
    expect((await get(reverse, idsPath(backend.id))).status).toBe(200);
    expect((await get(reverse, idsPath(backend.id))).status).toBe(429);
    expect((await get(reverse, "/system/teams?state=active")).status).toBe(200);
  });

  test("the allowance is chosen only by the presence of ids, and a malformed request counts against the mode it names", async () => {
    const limits = createSystemRateLimits({ config: { teamsLimit: 3, teamsOptionsLimit: 3 } });
    const counting = countingClient();
    const router = makeRouter(limits, counting.client);
    // three malformed requests naming ids (empty value, bad shape, with state) each spend ONE `teams` count
    expect((await get(router, "/system/teams?ids=")).status).toBe(400);
    expect((await get(router, "/system/teams?ids=a%20b")).status).toBe(400);
    expect((await get(router, "/system/teams?ids=abc&state=active")).status).toBe(400);
    expect(counting.count()).toBe(0); // a malformed request reads no row either
    expect((await get(router, idsPath(backend.id))).status).toBe(429);
    // ... and none of the options' budget: `q` alone, a bad state and no parameter at all spend `teamsOptions`
    expect((await get(router, "/system/teams?q=back")).status).toBe(400);
    expect((await get(router, "/system/teams?state=archived")).status).toBe(400);
    expect((await get(router, "/system/teams")).status).toBe(400);
    expect((await get(router, "/system/teams?state=active")).status).toBe(429);
  });

  test("each allowance is per verified service, not shared between services", async () => {
    // Only projects-api is bound; the allowance is keyed by the verified sub all the same: a different valid sub
    // would not draw on it. (An unbound sub is a 401 and spends nothing - asserted above.)
    const limits = createSystemRateLimits({ config: { teamsLimit: 1 } });
    expect(limits.teams.consume("system:projects-api").allowed).toBe(true);
    expect(limits.teams.consume("system:projects-api").allowed).toBe(false);
    expect(limits.teams.consume("system:other").allowed).toBe(true);
  });
});

describe("query validation: exactly one of ids / state, fixed 400, no echo (plan § API contract)", () => {
  const SENTINEL = `SENTINEL-${RUN}-secret`;
  const bad = (path: string) => async () => {
    const r = await get(makeRouter(), path);
    expect([path, r.status]).toEqual([path, 400]);
    expect(r.res.headers.get("Content-Type")).toContain("application/problem+json");
    expect(r.res.headers.get("Cache-Control")).toBe("no-store");
    expect(r.json.code).toBe("validation_failed");
    expect(r.raw).not.toContain(SENTINEL);
    return r;
  };

  test("neither ids nor state; both; q with ids; q alone; another state; an unknown parameter", async () => {
    await bad("/system/teams")();
    await bad(`/system/teams?ids=${backend.id}&state=active`)();
    await bad(`/system/teams?ids=${backend.id}&q=back`)();
    await bad("/system/teams?q=back")();
    await bad("/system/teams?state=archived")();
    await bad("/system/teams?state=")();
    await bad("/system/teams?state=ACTIVE")();
    await bad("/system/teams?state=active&appId=crm")();
    await bad(`/system/teams?ids=${backend.id}&appId=crm`)();
    await bad(`/system/teams?state=active&${SENTINEL}=1`)();
    await bad(`/system/teams?ids=${backend.id}&${SENTINEL}=1`)();
  });

  test("a parameter repeated is refused (no first-wins or last-wins reading)", async () => {
    await bad(`/system/teams?ids=${backend.id}&ids=${oldTeam.id}`)();
    await bad("/system/teams?state=active&state=active")();
    await bad("/system/teams?state=active&q=a&q=b")();
  });

  test("ids: 1..50 distinct, each ^[A-Za-z0-9_-]{1,64}$", async () => {
    await bad("/system/teams?ids=")();
    await bad("/system/teams?ids=,")();
    await bad("/system/teams?ids=a,,b")();
    await bad("/system/teams?ids=a,b,")();
    await bad("/system/teams?ids=,a")();
    await bad("/system/teams?ids=a%20b")();
    await bad("/system/teams?ids=a%2Cb%00")();
    await bad("/system/teams?ids=a/b")();
    await bad("/system/teams?ids=a.b")();
    await bad(`/system/teams?ids=${"a".repeat(65)}`)();
    await bad("/system/teams?ids=a,a")(); // duplicates
    await bad(`/system/teams?ids=${Array.from({ length: 51 }, (_, i) => `t${i}`).join(",")}`)();
    await bad(`/system/teams?ids=${"a".repeat(20_000)}`)();
    await bad(`/system/teams?ids=${SENTINEL}!`)();
    await bad("/system/teams?ids=%C3%A9")(); // a non-ASCII letter is not [A-Za-z0-9_-]
    const ok = await get(makeRouter(), `/system/teams?ids=${Array.from({ length: 50 }, (_, i) => `t${i}`).join(",")}`);
    expect(ok.status).toBe(200);
    expect(ok.json.items).toEqual([]);
    const sixtyFour = await get(makeRouter(), `/system/teams?ids=${"a".repeat(64)}`);
    expect(sixtyFour.status).toBe(200);
  });

  test("q: no NUL, JS-trimmed, 1..80 characters after trimming, raw at most 200, never echoed", async () => {
    await bad("/system/teams?state=active&q=")();
    await bad("/system/teams?state=active&q=%20%20%20")();
    await bad("/system/teams?state=active&q=%09%0A%C2%A0")(); // tab, newline, no-break space: all trimmed away
    await bad("/system/teams?state=active&q=a%00b")();
    await bad("/system/teams?state=active&q=%00")();
    await bad(`/system/teams?state=active&q=${"a".repeat(81)}`)();
    await bad(`/system/teams?state=active&q=${SENTINEL}${"a".repeat(80)}`)();
    await bad(`/system/teams?state=active&q=${"%20".repeat(201)}a`)(); // raw 202 characters
    await bad(`/system/teams?state=active&q=${"%20".repeat(200)}`)();
    await bad(`/system/teams?state=active&q=${SENTINEL}%00`)();
    // the bounds themselves are fine
    const eighty = await get(makeRouter(), `/system/teams?state=active&q=${"a".repeat(80)}`);
    expect(eighty.status).toBe(200);
    const padded = await get(makeRouter(), `/system/teams?state=active&q=${"%20".repeat(120)}${"a".repeat(80)}`);
    expect(padded.status).toBe(200); // raw 200
    const astral = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent("😀".repeat(80))}`);
    expect(astral.status).toBe(200); // 80 characters, 160 UTF-16 units: counted as characters, like the name CHECK
    await bad(`/system/teams?state=active&q=${encodeURIComponent("😀".repeat(81))}`)();
  });

  test("the 400 body is the same for every kind of bad request", async () => {
    const a = await get(makeRouter(), "/system/teams");
    const b = await get(makeRouter(), "/system/teams?state=active&q=%00");
    const c = await get(makeRouter(), "/system/teams?ids=a%20b");
    expect(a.raw).toBe(b.raw);
    expect(a.raw).toBe(c.raw);
  });
});

describe("ids mode (AC-4.7, AC-1.3 shape)", () => {
  test("a team answers in the plan's shape: members in name order, inactive last, name null and no access when inactive", async () => {
    const r = await get(makeRouter(), idsPath(backend.id));
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    const item = r.json.items[0];
    expect(Object.keys(item).sort()).toEqual(["archived", "id", "members", "name"]);
    expect(item.id).toBe(backend.id);
    expect(item.name).toBe(backend.name);
    expect(item.archived).toBe(false);
    const inactiveIds = [gone1.id, gone2.id]; // already in id order; by hidden name they would be reversed
    expect(item.members).toEqual([
      { id: ada.id, name: ada.name, active: true, appAccess: true },
      { id: bea.id, name: bea.name, active: true, appAccess: true },
      { id: cyd.id, name: cyd.name, active: true, appAccess: false },
      // inactive: last, in id order (never in the order of their hidden names), no name, no access even with a role
      { id: inactiveIds[0], name: null, active: false, appAccess: false },
      { id: inactiveIds[1], name: null, active: false, appAccess: false },
    ]);
  });

  test("a member carries nothing but id, name, active, appAccess (no email, no role, no entity)", async () => {
    const r = await get(makeRouter(), idsPath(backend.id));
    for (const m of r.json.items[0].members) expect(Object.keys(m).sort()).toEqual(["active", "appAccess", "id", "name"]);
    expect(r.raw).not.toContain("@operai.test");
    expect(r.raw).not.toContain("description");
  });

  test("request order, unknown ids omitted, an archived team included with archived:true, an empty team has no members", async () => {
    const r = await get(makeRouter(), idsPath(emptyTeam.id, `unknown-${RUN}`, oldTeam.id, backend.id));
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: any) => i.id)).toEqual([emptyTeam.id, oldTeam.id, backend.id]);
    expect(r.json.items[0]).toEqual({ id: emptyTeam.id, name: emptyTeam.name, archived: false, members: [] });
    expect(r.json.items[1].archived).toBe(true);
    expect(r.json.items[1].members).toEqual([{ id: ada.id, name: ada.name, active: true, appAccess: true }]);
    const none = await get(makeRouter(), idsPath(`unknown-${RUN}`));
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ items: [] });
  });

  test("a team is in the answer once however its members overlap; the same person in two teams is answered in both", async () => {
    const r = await get(makeRouter(), idsPath(backend.id, teamOfOther.id));
    expect(r.json.items.map((i: any) => i.id)).toEqual([backend.id, teamOfOther.id]);
    expect(r.json.items[1].members).toEqual([{ id: bea.id, name: bea.name, active: true, appAccess: true }]);
  });

  test("appAccess follows the permission on the next call: grant, then revoke (AC-4.7)", async () => {
    const router = makeRouter();
    const read = async () => (await get(router, idsPath(teamOfOther.id))).json.items[0].members[0].appAccess;
    expect(await read()).toBe(true);
    await db.userRole.delete({ where: { userId_roleId: { userId: bea.id, roleId: beaRoleId } } });
    try {
      expect(await read()).toBe(false);
    } finally {
      await db.userRole.create({ data: { userId: bea.id, roleId: beaRoleId } });
    }
    expect(await read()).toBe(true);
  });

  test("a department-conferred access counts", async () => {
    const dana = await makeUser("Dana");
    const team = await makeTeam(`Dept ${RUN}`, { members: [dana.id] });
    const role = await db.role.create({
      data: { name: `t9-dept-${RUN}`, rules: { create: [{ resource: "projects", action: "access", conditions: { ownership: "own" } }] } },
    });
    roleIds.push(role.id);
    const dept = await db.department.create({
      data: { name: `t9-dept-${RUN}`, departmentRoles: { create: [{ roleId: role.id }] }, members: { create: [{ userId: dana.id }] } },
    });
    try {
      const r = await get(makeRouter(), idsPath(team.id));
      expect(r.json.items[0].members).toEqual([{ id: dana.id, name: dana.name, active: true, appAccess: true }]);
    } finally {
      await db.userDepartment.deleteMany({ where: { departmentId: dept.id } });
      await db.departmentRole.deleteMany({ where: { departmentId: dept.id } });
      await db.department.delete({ where: { id: dept.id } });
    }
  });

  test("the app is derived from the verified sub: another app's access never reads as Projects', and no parameter can ask for it", async () => {
    const r = await get(makeRouter(), idsPath(backend.id));
    const cydEntry = r.json.items[0].members.find((m: any) => m.id === cyd.id);
    expect(cydEntry.appAccess).toBe(false); // Cyd holds `crm${RUN}` access
    expect((await get(makeRouter(), `${idsPath(backend.id)}&appId=crm${RUN}`)).status).toBe(400);
    expect((await get(makeRouter(), `${idsPath(backend.id)}&app=crm${RUN}`)).status).toBe(400);
  });

  test("a soft-deleted member turns inactive and comes back when deletedAt is cleared", async () => {
    const evan = await makeUser("Evan");
    await grantAccess(evan.id, "projects");
    const team = await makeTeam(`Soft ${RUN}`, { members: [evan.id] });
    const router = makeRouter();
    const member = async () => (await get(router, idsPath(team.id))).json.items[0].members[0];
    expect(await member()).toEqual({ id: evan.id, name: evan.name, active: true, appAccess: true });
    await db.user.update({ where: { id: evan.id }, data: { deletedAt: new Date() } });
    expect(await member()).toEqual({ id: evan.id, name: null, active: false, appAccess: false });
    await db.user.update({ where: { id: evan.id }, data: { deletedAt: null } });
    expect((await member()).active).toBe(true);
  });

  test("a team of 100 members, 50 teams at a time: one answer, no per-member query", async () => {
    const people = await Promise.all(Array.from({ length: 100 }, (_, i) => makeUser(`Bulk${String(i).padStart(3, "0")}`)));
    const bulk = await Promise.all(
      Array.from({ length: 50 }, (_, i) => makeTeam(`Bulk ${String(i).padStart(2, "0")} ${RUN}`, { members: people.map((p) => p.id) })),
    );
    const counting = countingClient();
    const r = await get(makeRouter(createSystemRateLimits(), counting.client), idsPath(...bulk.map((t) => t.id)));
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(50);
    expect(r.json.items[0].members).toHaveLength(100);
    // 5 000 (team, member) rows: the teams, the members, and the access facts in ONE batch of two queries
    expect(counting.count("team")).toBe(1);
    expect(counting.count("teamMember")).toBe(1);
    expect(counting.count("userRole")).toBe(1);
    expect(counting.count("userDepartment")).toBe(1);
    expect(counting.count()).toBe(4);
  });
});

describe("options mode (AC-1.5, AC-1.6, AC-4.1, plan D13)", () => {
  test("answers {items:[{id,name}], truncated} and nothing else per item (no member, no count, no description)", async () => {
    const r = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(backend.name)}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["items", "truncated"]);
    expect(r.json.truncated).toBe(false);
    expect(r.json.items).toEqual([{ id: backend.id, name: backend.name }]);
  });

  test("a case-insensitive substring of the name finds it; the text is trimmed first", async () => {
    for (const q of ["ack", "ACK", "  back  ", `kend ${RUN.toUpperCase()}`, backend.name.toUpperCase(), backend.name.toLowerCase()]) {
      const r = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(q)}`);
      expect([q, r.json.items.some((i: any) => i.id === backend.id)]).toEqual([q, true]);
    }
    const miss = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(`zzz-${RUN}-nothing`)}`);
    expect(miss.json).toEqual({ items: [], truncated: false });
  });

  test("it matches team names only: not a member's name, not an id, not an app name", async () => {
    for (const q of [ada.name, `Bea ${RUN}`, backend.id, "projects"]) {
      const r = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      for (const item of r.json.items) expect([q, item.name.toLowerCase().includes(q.toLowerCase())]).toEqual([q, true]);
    }
    const byMember = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(`Ada ${RUN}`)}`);
    expect(byMember.json.items).toEqual([]);
    const byId = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(backend.id)}`);
    expect(byId.json.items).toEqual([]);
  });

  test("an archived team is never offered, with or without q, even when q is its whole name; restoring brings it back (AC-1.5, AC-1.6)", async () => {
    const team = await makeTeam(`Archivable ${RUN}`);
    const router = makeRouter();
    const find = async (withQ: boolean) =>
      (await get(router, `/system/teams?state=active${withQ ? `&q=${encodeURIComponent(team.name)}` : ""}`)).json.items.some(
        (i: any) => i.id === team.id,
      );
    expect(await find(true)).toBe(true);
    await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
    expect(await find(true)).toBe(false);
    expect(await find(false)).toBe(false);
    const all = await get(router, `/system/teams?state=active&q=${encodeURIComponent(oldTeam.name)}`);
    expect(all.json.items).toEqual([]); // the seeded archived team too
    await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
    expect(await find(true)).toBe(true);
  });

  test("ranking: the exact name first, then names that start with q, then the rest; at most 50 and truncated (60 decoys)", async () => {
    const stem = `rk${RUN}`;
    // 60 decoys that merely CONTAIN q and would sort before the exact team and the prefixes by name alone
    for (let i = 1; i <= 60; i++) await makeTeam(`0-${stem}-${String(i).padStart(2, "0")}`);
    const prefixB = await makeTeam(`${stem}b`);
    const prefixC = await makeTeam(`${stem}c`);
    const exact = await makeTeam(stem.toUpperCase());
    const r = await get(makeRouter(), `/system/teams?state=active&q=${stem}`);
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(50);
    expect(r.json.truncated).toBe(true);
    const names = r.json.items.map((i: any) => i.name);
    expect(names.slice(0, 3)).toEqual([exact.name, prefixB.name, prefixC.name]);
    expect(names.slice(3)).toEqual(Array.from({ length: 47 }, (_, i) => `0-${stem}-${String(i + 1).padStart(2, "0")}`));
    expect(r.json.items.map((i: any) => i.id).slice(0, 3)).toEqual([exact.id, prefixB.id, prefixC.id]);
    // 60 matches: capped at 50 with truncated; 10 matches ("-5" is in 50..59 only): all of them, not truncated
    const sixty = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(`0-${stem}-`)}`);
    expect(sixty.json.items).toHaveLength(50);
    expect(sixty.json.truncated).toBe(true);
    const ten = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(`0-${stem}-5`)}`);
    expect(ten.json.items).toHaveLength(10);
    expect(ten.json.truncated).toBe(false);
  });

  test("a tie in name is broken by id (a total order)", async () => {
    const stem = `tie${RUN}`;
    const a = await makeTeam(`${stem}`);
    const b = await makeTeam(`${stem}-x`);
    const r = await get(makeRouter(), `/system/teams?state=active&q=${stem}`);
    expect(r.json.items.map((i: any) => i.id)).toEqual([a.id, b.id]);
  });

  test("%, _ and \\ in q are literal characters, never wildcards", async () => {
    const pct = await makeTeam(`50%_off ${RUN}`);
    const slash = await makeTeam(`back\\slash ${RUN}`);
    const plain = await makeTeam(`Plain ${RUN}`);
    const q = async (text: string) =>
      (await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(text)}`)).json.items as { id: string; name: string }[];

    const byPct = await q("%_");
    expect(byPct.map((i) => i.id)).toContain(pct.id);
    expect(byPct.every((i) => i.name.toLowerCase().includes("%_"))).toBe(true);
    expect(byPct.map((i) => i.id)).not.toContain(plain.id);

    const byUnderscore = await q("_");
    expect(byUnderscore.map((i) => i.id)).toContain(pct.id);
    expect(byUnderscore.map((i) => i.id)).not.toContain(backend.id); // `_` is not "any one character"
    expect(byUnderscore.every((i) => i.name.includes("_"))).toBe(true);

    const byPercentAlone = await q("%");
    expect(byPercentAlone.map((i) => i.id)).not.toContain(plain.id); // `%` is not "anything"
    expect(byPercentAlone.every((i) => i.name.includes("%"))).toBe(true);

    const bySlash = await q("\\");
    expect(bySlash.map((i) => i.id)).toContain(slash.id);
    expect(bySlash.every((i) => i.name.includes("\\"))).toBe(true);
    expect((await q("ba%k")).map((i) => i.id)).not.toContain(backend.id);
    expect((await q(`50%_off ${RUN}`)).map((i) => i.id)).toEqual([pct.id]);
  });

  test("SQL metacharacters in q are data: a quote and a comment marker change nothing", async () => {
    const odd = await makeTeam(`O'Brien ${RUN}`);
    const hit = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(`o'brien ${RUN}`)}`);
    expect(hit.json.items.map((i: any) => i.id)).toEqual([odd.id]);
    for (const q of [`' OR '1'='1`, `'; DROP TABLE team; --`, `") OR 1=1 --`]) {
      const r = await get(makeRouter(), `/system/teams?state=active&q=${encodeURIComponent(q)}`);
      expect([q, r.status, r.json.items]).toEqual([q, 200, []]);
    }
    expect(await db.team.count({ where: { id: backend.id } })).toBe(1);
  });

  test("without q: active teams only, in name order, at most 50, truncated when more", async () => {
    const r = await get(makeRouter(), "/system/teams?state=active");
    expect(r.status).toBe(200);
    expect(r.json.items.length).toBeLessThanOrEqual(50);
    expect(r.json.truncated).toBe(true); // this file alone created more than 50 active teams
    expect(r.json.items.map((i: any) => i.id)).not.toContain(oldTeam.id);
    for (const item of r.json.items) expect(Object.keys(item).sort()).toEqual(["id", "name"]);
  });

  test("51 rows are read, no more", async () => {
    const counting = countingClient();
    const router = makeRouter(createSystemRateLimits(), counting.client);
    await get(router, "/system/teams?state=active");
    await get(router, `/system/teams?state=active&q=${RUN}`);
    // one query each (no q: a findMany, with q: a raw query), both limited to 51 rows
    expect(counting.calls.map((c) => c.method)).toEqual(["findMany", "$queryRaw"]);
    expect((counting.calls[0]!.args[0] as { take?: number }).take).toBe(51);
    expect(counting.calls[1]!.args.slice(1)).toContain(51);
    // and q reaches the database only as a bound parameter, never inside the SQL text
    expect((counting.calls[1]!.args[0] as string[]).join("?")).not.toContain(RUN);
    expect(counting.calls[1]!.args.slice(1)).toContain(RUN);
  });
});

describe("the log line holds no id, no name and no q text (plan § API contract, § Security 2)", () => {
  test("ids mode: one line, caller, mode, search=no, count", async () => {
    const r = await get(makeRouter(), idsPath(backend.id, emptyTeam.id, `unknown-${RUN}`));
    expect(r.status).toBe(200);
    const lines = logged.filter((l) => l.includes("teams.read"));
    expect(lines).toEqual(["[system] teams.read caller=system:projects-api mode=ids search=no count=2"]);
  });

  test("options mode: search=yes with q, search=no without; the q text is never logged", async () => {
    const sentinel = `QSENT${RUN}`;
    await get(makeRouter(), `/system/teams?state=active&q=${sentinel}`);
    await get(makeRouter(), "/system/teams?state=active");
    const lines = logged.filter((l) => l.includes("teams.read"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("[system] teams.read caller=system:projects-api mode=options search=yes count=0");
    expect(lines[1]).toMatch(/^\[system\] teams\.read caller=system:projects-api mode=options search=no count=\d+$/);
  });

  test("nothing that was logged during any kind of request holds an id, a name, the q text or a token", async () => {
    const sentinel = `LOGSENT${RUN}`;
    const token = await sign();
    const limits = createSystemRateLimits({ config: { teamsLimit: 2, teamsOptionsLimit: 1, invalidLimit: 1 } });
    const router = makeRouter(limits);
    await get(router, idsPath(backend.id, oldTeam.id), token);
    await get(router, idsPath(backend.id), token);
    await get(router, idsPath(backend.id), token); // 429
    await get(router, `/system/teams?state=active&q=${sentinel}`, token);
    await get(router, `/system/teams?state=active&q=${sentinel}`, token); // 429
    await get(router, `/system/teams?state=active&q=${sentinel}%00`, token); // 429, malformed
    await get(router, `/system/teams?ids=${sentinel}!`, token);
    await get(router, `/system/teams?state=active&q=${sentinel}`, "garbage");
    await get(router, `/system/teams?state=active&q=${sentinel}`, "garbage");
    await get(router, `/system/teams?state=active&q=${sentinel}`, await sign({ sub: "system:crm-api" }));
    const everything = logged.join("\n");
    for (const secret of [sentinel, backend.id, oldTeam.id, backend.name, oldTeam.name, ada.name, ada.id, token, "garbage", RUN]) {
      expect([secret.slice(0, 12), everything.includes(secret)]).toEqual([secret.slice(0, 12), false]);
    }
    // the refusals are logged through the shared limiter, by caller and not by what was asked
    expect(everything).toContain("[system/teams] allowance exhausted caller=system:projects-api");
  });

  test("a malformed request logs no accepted-call line", async () => {
    await get(makeRouter(), "/system/teams?ids=a%20b");
    expect(logged.filter((l) => l.includes("teams.read"))).toEqual([]);
  });
});

describe("other shapes of the route", () => {
  test("only GET /system/teams exists: other methods and sub-paths are the router's 404, with or without a credential", async () => {
    const router = makeRouter();
    const token = await sign();
    for (const [method, path] of [
      ["POST", "/system/teams"],
      ["PUT", "/system/teams"],
      ["DELETE", "/system/teams"],
      ["GET", `/system/teams/${backend.id}`],
      ["GET", "/system/teams/"],
    ] as const) {
      const res = await router.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
  });

  test("the route is in the API document", () => {
    const router = makeRouter();
    const doc = (router as any).getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } });
    expect(Object.keys(doc.paths)).toContain("/system/teams");
    expect(JSON.stringify(doc.paths["/system/teams"])).toContain("teams:read");
  });
});
