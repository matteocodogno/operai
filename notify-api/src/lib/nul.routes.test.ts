/**
 * A NUL in any id, query, cursor or text of any route is a 400, never a 5xx (specs/20261126-teams QE F1). Postgres text cannot hold
 * U+0000; before the fix `GET /notifications?cursor=<NUL>` and `DELETE /push/devices/<NUL>` wrapped the driver's refusal into an
 * `Error` that dropped the cause (or rendered it as a 500), so the global safety net (`app.onError`) never saw it. `nul.test.ts` proves
 * the net on a probe route; this file proves the path a real request takes: the REAL app (`src/index.ts`) in a child process, real
 * JWTs verified against a JWKS served here, one request per placement, a NUL appended to each.
 *
 * `ROUTES` is the table of every route with every id, query member and text a request can carry (a route can appear twice, for a
 * body of another shape). A route the app serves that is not in the table fails the completeness test, so a new route cannot ship
 * without its NUL cases.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const NUL = "\u0000";
const AUD = "operai-suite-nulroutes";
const SERVICE_AUD = "operai-system-nulroutes";
const ISS = "http://localhost:3001";
const RUN = crypto.randomUUID().slice(0, 8);
/** Every id and address the cases create starts with it: the probe deletes by it when the run is over. */
const PREFIX = `nul-routes-${RUN}-`;
const USER = `${PREFIX}user`;

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const DEVICE = {
  endpoint: `https://fcm.googleapis.com/fcm/send/${PREFIX}device`,
  keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
};
const LINK = { href: "/estimai/estimates/abc", label: "Open" };
const LEGAL_ENTITY_CHANGE_DATA = {
  entity: "welld_ch",
  action: "save",
  restoredFrom: null,
  actorEmail: "author@operai.test",
  storedAt: "2026-01-01T00:00:00.000Z",
  version: 2,
  protectedChanged: ["legalName"],
  otherChanged: ["address.en"],
};

type Auth = "user" | "service";
type Route = {
  method: string;
  /** Hono form: `:name` for a path parameter. */
  path: string;
  /** Tells two bodies of the same route apart. */
  tag?: string;
  auth?: Auth;
  query?: string[];
  body?: unknown;
  /** What a query member answers where it is not a 400: the stream ticket is checked in memory, never by the database. */
  answers?: Record<string, number>;
  /** What the control answers where it is not a handler reached with a credential: the stream, with no ticket, is a 401. */
  controlStatus?: number;
};
const ROUTES: Route[] = [
  { method: "POST", path: "/notifications", body: { title: "t", body: "b", severity: "info", originApp: "estimai", link: LINK, toast: false } },
  { method: "GET", path: "/notifications", query: ["cursor", "limit"] },
  { method: "GET", path: "/notifications/unread-count" },
  { method: "POST", path: "/notifications/mark-all-read" },
  { method: "POST", path: "/notifications/stream-ticket" },
  { method: "GET", path: "/notifications/stream", query: ["ticket"], answers: { ticket: 401 }, controlStatus: 401 },
  { method: "GET", path: "/push/config" },
  { method: "PUT", path: "/push/devices", body: DEVICE },
  { method: "GET", path: "/push/devices" },
  { method: "DELETE", path: "/push/devices/:id" },
  {
    method: "POST",
    path: "/system/notifications",
    auth: "service",
    body: {
      recipientId: `${PREFIX}recipient`,
      originApp: "admin",
      severity: "info",
      title: "t",
      body: "b",
      link: LINK,
      it: { title: "t", body: "b" },
      email: false,
      idempotencyKey: `${PREFIX}key`,
    },
  },
  {
    method: "POST",
    path: "/system/emails",
    tag: "to",
    auth: "service",
    body: {
      template: "invitation",
      to: `${PREFIX}invitee@operai.test`,
      data: { inviteUrl: "https://app.operai.test/invite/abc", inviterName: "Ada", expiresAt: "2026-02-01T00:00:00.000Z" },
      idempotencyKey: `${PREFIX}mail`,
    },
  },
  {
    method: "POST",
    path: "/system/emails",
    tag: "recipientId",
    auth: "service",
    body: {
      template: "legal_entity_change",
      recipientId: `${PREFIX}recipient`,
      data: LEGAL_ENTITY_CHANGE_DATA,
      idempotencyKey: `${PREFIX}notice`,
    },
  },
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
/** The body with a NUL appended to one string leaf: the value stays otherwise as valid as it was, so the NUL is the only thing wrong. */
const withNul = (value: unknown, at: (string | number)[]): unknown => {
  if (at.length === 0) return `${value as string}${NUL}`;
  const [head, ...rest] = at as [string | number, ...(string | number)[]];
  const copy = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
  (copy as Record<string | number, unknown>)[head] = withNul((value as Record<string | number, unknown>)[head], rest);
  return copy;
};

type Case = { label: string; method: string; path: string; body?: unknown; auth: Auth; control: boolean; expected: number };
const fill = (route: Route, nulParam?: string) =>
  route.path.replace(/:(\w+)/g, (_, name: string) => (name === nulParam ? `ctl1${encodeURIComponent(NUL)}` : "ctl1"));

const cases: Case[] = [];
for (const r of ROUTES) {
  const base = { method: r.method, auth: r.auth ?? "user" } as const;
  const name = `${r.method} ${r.path}${r.tag ? ` [${r.tag}]` : ""}`;
  // The control: the same request with no NUL reaches the route (not a 401) and does not fail. It is what makes a 400 below mean something.
  cases.push({ ...base, label: `${name} | control`, path: fill(r), ...(r.body !== undefined ? { body: r.body } : {}), control: true, expected: r.controlStatus ?? 0 });
  for (const p of [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]!)) {
    cases.push({ ...base, label: `${name} | path :${p}`, path: fill(r, p), control: false, expected: 400 });
  }
  for (const q of r.query ?? []) {
    cases.push({ ...base, label: `${name} | query ${q}`, path: `${fill(r)}?${q}=${encodeURIComponent(`1${NUL}`)}`, control: false, expected: r.answers?.[q] ?? 400 });
  }
  if (r.body !== undefined) {
    for (const at of leaves(r.body)) {
      cases.push({ ...base, label: `${name} | body ${at.join(".")}`, path: fill(r), body: withNul(r.body, at), control: false, expected: 400 });
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
  const userToken = await sign({ email: "nul-routes@operai.test" }, USER, AUD);
  // `system:auth` is the one principal bound to the `admin` origin and allowed to send `legal_entity_change`.
  const serviceToken = await sign({ scope: "notifications.push emails.send" }, "system:auth", SERVICE_AUD);

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
      // Push on, so a device registration reaches its validation; every outbound base points at a port nothing listens on.
      PUSH_ENABLED: "true",
      VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString("base64url"),
      VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString("base64url"),
      VAPID_SUBJECT: "mailto:ops@operai.test",
      APP_BASE_URL: "https://app.operai.test",
      AUTH_BASE_URL: "http://127.0.0.1:9",
      SERVICE_CLIENT_ID: "notify-api",
      SERVICE_CLIENT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
      USER_TOKEN: userToken,
      SERVICE_TOKEN: serviceToken,
      USER_PREFIX: PREFIX,
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
    expect(cases.filter((c) => !c.control).length).toBeGreaterThan(30);
    for (const r of ROUTES) {
      const name = `${r.method} ${r.path}${r.tag ? ` [${r.tag}]` : ""}`;
      const nulCases = cases.filter((c) => !c.control && c.label.startsWith(`${name} |`));
      // A route that takes no id, query or body has nothing a NUL can ride in on.
      const hasInput = r.body !== undefined || (r.query?.length ?? 0) > 0 || r.path.includes(":");
      expect(nulCases.length > 0).toBe(hasInput);
    }
  });

  for (const c of cases.filter((x) => x.control)) {
    it(`control, no NUL: ${c.label} reaches its handler`, () => {
      const res = out.results[c.label]!;
      const seen = { status: res.status, body: res.body.slice(0, 160) };
      if (c.expected !== 0) return expect(seen).toMatchObject({ status: c.expected });
      expect(seen).not.toMatchObject({ status: 401 });
      expect(res.status).toBeLessThan(500);
    });
  }

  for (const c of cases.filter((x) => !x.control)) {
    it(`${c.label}: ${c.expected}`, () => {
      const res = out.results[c.label]!;
      expect({ status: res.status, body: res.body.slice(0, 160) }).toMatchObject({ status: c.expected });
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
