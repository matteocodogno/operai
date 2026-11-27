/**
 * A NUL in any id, query or text of any route is a 400, never a 5xx (specs/20261126-teams QE F1). Postgres text cannot hold U+0000;
 * before the fix the routes wrapped the driver's refusal into an `Error` that dropped the cause, so the global safety net
 * (`app.onError`) never saw it and the caller got a 500 for a request that was wrong. `nul.test.ts` proves the net on a probe route;
 * this file proves the path a real request takes: the REAL app (`src/index.ts`) in a child process, real JWTs verified against a
 * JWKS served here, one request per placement, a NUL in each.
 *
 * `ROUTES` is the table of every route with every id, query member and text a request can carry. A route the app serves that is not
 * in the table fails the completeness test, so a new route cannot ship without its NUL cases.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const NUL = "a\u0000b";
const AUD = "operai-suite-nulroutes";
const SERVICE_AUD = "operai-system-nulroutes";
const ISS = "http://localhost:3001";

const UPSERT = {
  name: "n",
  author: "a",
  content: {
    params: { parallelism: 0.7 },
    releases: [{ id: "r1", name: "MVP", fte: 1 }],
    acts: [{ id: "a1", num: "1", epic: "e", act: "t", prof: "p", o: 1, ml: 2, p: 3, risk: 0, aiGain: 0.3, notes: "n", release: "r1" }],
  },
};
const NOTICE = { estimateId: "est1", dealId: "deal1", event: "linked", at: "2026-01-01T00:00:00.000Z" };

type Auth = "user" | "service";
type Route = {
  method: string;
  /** Hono form: `:name` for a path parameter. `:id` is replaced by an estimate the caller owns, any other parameter by a plain id. */
  path: string;
  auth?: Auth;
  query?: string[];
  body?: unknown;
  headers?: Record<string, string>;
};
const IF_MATCH = { "If-Match": '"1"' };
const ROUTES: Route[] = [
  { method: "GET", path: "/estimates", query: ["status", "whose"] },
  { method: "POST", path: "/estimates", body: UPSERT },
  { method: "POST", path: "/estimates/import", body: { estimates: [{ ...UPSERT, localId: "l1" }] } },
  { method: "GET", path: "/estimates/:id" },
  { method: "PUT", path: "/estimates/:id", body: UPSERT, headers: IF_MATCH },
  { method: "DELETE", path: "/estimates/:id" },
  { method: "POST", path: "/estimates/:id/close", headers: IF_MATCH },
  { method: "POST", path: "/estimates/:id/reopen", headers: IF_MATCH },
  { method: "GET", path: "/estimates/:id/collaborators" },
  { method: "POST", path: "/estimates/:id/collaborators", body: { email: "x@operai.test", accessLevel: "viewer" } },
  { method: "DELETE", path: "/estimates/:id/collaborators/me" },
  { method: "PATCH", path: "/estimates/:id/collaborators/:collaboratorId", body: { accessLevel: "viewer" } },
  { method: "DELETE", path: "/estimates/:id/collaborators/:collaboratorId" },
  { method: "POST", path: "/system/deal-link-notices", auth: "service", body: NOTICE },
  { method: "GET", path: "/system/estimates/:id/summary", auth: "service" },
];
const UNGATED = new Set(["GET /health", "GET /openapi.json", "GET /docs"]);

/** Every string leaf of a body, as the path that reaches it. */
const leaves = (value: unknown, at: (string | number)[] = []): (string | number)[][] =>
  typeof value === "string"
    ? [at]
    : Array.isArray(value)
      ? value.flatMap((v, i) => leaves(v, [...at, i]))
      : value !== null && typeof value === "object"
        ? Object.entries(value).flatMap(([k, v]) => leaves(v, [...at, k]))
        : [];
const withNul = (value: unknown, at: (string | number)[]): unknown => {
  // Appended, so the value stays otherwise as valid as it was and the NUL is the only thing wrong with the request.
  if (at.length === 0) return `${value as string}\u0000`;
  const [head, ...rest] = at as [string | number, ...(string | number)[]];
  const copy = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
  (copy as Record<string | number, unknown>)[head] = withNul((value as Record<string | number, unknown>)[head], rest);
  return copy;
};

type Case = { label: string; method: string; path: string; body?: unknown; auth: Auth; headers?: Record<string, string>; control: boolean };
/** The path with one parameter holding the NUL (or none). The others stay valid: the estimate is the caller's own, so the NUL is the only thing wrong. */
const fill = (route: Route, nulParam?: string) =>
  route.path.replace(/:(\w+)/g, (_, name: string) =>
    name === nulParam ? encodeURIComponent(NUL) : name === "id" && route.path.startsWith("/estimates/") ? "{owned}" : "ctl1",
  );

const cases: Case[] = [];
for (const r of ROUTES) {
  const base = { method: r.method, auth: r.auth ?? "user", ...(r.headers ? { headers: r.headers } : {}) } as const;
  const name = `${r.method} ${r.path}`;
  // The control: the same request with no NUL reaches the route (not a 401) and does not fail. It is what makes a 400 below mean something.
  cases.push({ ...base, label: `${name} | control`, path: fill(r), ...(r.body !== undefined ? { body: r.body } : {}), control: true });
  for (const p of [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]!)) {
    cases.push({ ...base, label: `${name} | path :${p}`, path: fill(r, p), ...(r.body !== undefined ? { body: r.body } : {}), control: false });
  }
  for (const q of r.query ?? []) cases.push({ ...base, label: `${name} | query ${q}`, path: `${fill(r)}?${q}=${encodeURIComponent(NUL)}`, control: false });
  if (r.body !== undefined) {
    for (const at of leaves(r.body)) {
      cases.push({ ...base, label: `${name} | body ${at.join(".")}`, path: fill(r), body: withNul(r.body, at), control: false });
    }
  }
}

let served: ReturnType<typeof Bun.serve> | undefined;
let out: { routes: string[]; results: Record<string, { status: number; body: string }>; left: number } = { routes: [], results: {}, left: -1 };

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "nulroutes", alg: "RS256", use: "sig" };
  served = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  const sign = (claims: Record<string, unknown>, sub: string, aud: string) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "nulroutes" }).setIssuer(ISS).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  const userToken = await sign({ email: "nul-routes@operai.test" }, `nul-routes-${crypto.randomUUID()}`, AUD);
  const serviceToken = await sign({ scope: "estimai.estimates.read deal-link-notices.send" }, "system:crm-api", SERVICE_AUD);

  const child = Bun.spawn(["bun", "src/lib/nul.routes.probe.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:5173",
      AUTH_JWKS_URL: `http://localhost:${served.port}/jwks`,
      AUTH_ISSUER: ISS,
      AUTH_AUDIENCE: AUD,
      SERVICE_AUDIENCE: SERVICE_AUD,
      AUTH_BASE_URL: "http://127.0.0.1:9", // nothing listens: no call can reach a real auth
      SERVICE_CLIENT_ID: "estimai-api",
      SERVICE_CLIENT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
      NOTIFY_INTERNAL_URL: "http://127.0.0.1:9",
      USER_TOKEN: userToken,
      SERVICE_TOKEN: serviceToken,
    },
    stdin: new Blob([JSON.stringify(cases)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`the probe printed no result: ${stderr.slice(0, 800)}`);
  out = JSON.parse(line.slice("RESULT ".length)) as typeof out;
}, 120_000);

afterAll(() => served?.stop(true));

describe("a NUL in any id, query or text of any route is a 400, never a 5xx (QE F1)", () => {
  it("the table names every route the app serves (a new route needs its NUL cases)", () => {
    const seen = new Set(out.routes.filter((r) => !r.startsWith("ALL ")).map((r) => r.replace(/\{(\w+)\}/g, ":$1")));
    const known = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    expect([...seen].filter((r) => !known.has(r) && !UNGATED.has(r))).toEqual([]);
    expect([...known].filter((r) => !seen.has(r))).toEqual([]);
  });

  it("leaves nothing behind in the database it ran on", () => {
    expect(out.left).toBe(0);
  });

  it("covers every placement: each route has at least one NUL case", () => {
    expect(cases.filter((c) => !c.control).length).toBeGreaterThan(40);
    for (const r of ROUTES) expect(cases.some((c) => !c.control && c.label.startsWith(`${r.method} ${r.path} |`))).toBe(true);
  });

  for (const c of cases.filter((x) => x.control)) {
    it(`control, no NUL: ${c.label} reaches its handler`, () => {
      const res = out.results[c.label]!;
      expect(res.status).not.toBe(401);
      // A collaborator add asks an `auth` that is not there (a 503); everything else is answered without a server error.
      if (!c.label.startsWith("POST /estimates/:id/collaborators |")) expect(res.status).toBeLessThan(500);
    });
  }

  for (const c of cases.filter((x) => !x.control)) {
    it(`${c.label}: 400`, () => {
      const res = out.results[c.label]!;
      expect({ status: res.status, body: res.body.slice(0, 160) }).toMatchObject({ status: 400 });
      // No NUL echoed back, `instance` aside (it is the path the caller sent).
      let stripped = res.body;
      try {
        const json = JSON.parse(res.body) as Record<string, unknown>;
        delete json["instance"];
        stripped = JSON.stringify(json);
      } catch {}
      expect(stripped).not.toMatch(/\\u0000|\u0000|%00/);
    });
  }
});
