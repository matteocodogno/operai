/**
 * The legacy surface is cut (T23, specs/20261119-accounting; AC-3.7, AC-4.6; plan § API contracts "Removed (404)"; and, for the
 * 2026-11-19 sign-off, T61: the foreign-currency VAT code route of 20261118 is gone too, 20261118 SO-16, retired AC-2.5 to AC-2.7).
 *
 * The ledger accounts, the VAT codes and the monthly exchange rates are Accounting's. refund-api no longer serves them: the
 * routes of 20261118 (`/accounting/ledger-accounts*`, `/accounting/vat-codes*`, `/exchange-rates*`) are not registered, so they
 * answer 404 to everyone, a `settings:manage` holder included, and they are not in the OpenAPI document. What stayed in Refund
 * (the defaults, the options, the review view, the export) is still there, which tells "removed" from "refused" in this test.
 *
 * T62 (20261118 SO-12): the accounting export's file moved from `…/accounting-export/csv` to `…/accounting-export/file` (an XLSX
 * workbook); the old path answers 404, to everyone, with no token too.
 *
 * The REAL app (`src/index.ts`) is under test, so it runs in a SUBPROCESS: importing it here would load every router of the
 * service into THIS process's module cache bound to this file's auth, and break the test files that import those routers after it
 * (testAuth.ts, "no shared router specifier"). The subprocess verifies real RS256 tokens against a JWKS served from here and
 * resolves permissions from `GET /authz/resolve` served from here, so the caller really is a `settings:manage` holder.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const AUDIENCE = "operai-suite";
const KID = "removed-routes-test";

interface Probe {
  readonly method: string;
  readonly path: string;
}
interface Answer {
  readonly status: number;
  readonly code: string | null;
}

/** What a settings admin holds: both settings capabilities, nothing of Accounting. */
const SETTINGS_ADMIN = {
  sub: "settings-admin",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "settings", action: "read", conditions: null },
    { resource: "settings", action: "manage", conditions: null },
  ],
  entity: null,
  jobTitle: null,
};

const LEDGER = "/accounting/ledger-accounts";
const VAT = "/accounting/vat-codes";
const RATES = "/exchange-rates";
/** The designation of the foreign-currency VAT code (20261118 AC-2.5 to AC-2.7), retired 2026-11-19: no VAT code is ever pre-set. */
const DESIGNATION = "/accounting/foreign-currency-vat-code";
/** The CSV of the accounting export, replaced by `…/file` (an XLSX) on 2026-11-19. */
const CSV_EXPORT = "/batches/b-1/accounting-export/csv";

/** Every route of 20261118's catalog and exchange-rate surface, and plausible sub-paths of each, in every method. */
const REMOVED: Probe[] = [
  ...["GET", "POST", "PUT", "PATCH", "DELETE"].flatMap((method) => [
    { method, path: LEDGER },
    { method, path: `${LEDGER}/ckledger0001` },
    { method, path: `${LEDGER}/ckledger0001/deactivate` },
    { method, path: `${LEDGER}/ckledger0001/reactivate` },
    { method, path: `${LEDGER}/6101` },
    { method, path: VAT },
    { method, path: `${VAT}/ckvat0001` },
    { method, path: `${VAT}/ckvat0001/deactivate` },
    { method, path: `${VAT}/ckvat0001/reactivate` },
    { method, path: `${VAT}/IMP81` },
    { method, path: RATES },
    { method, path: `${RATES}/fetch` },
    { method, path: `${RATES}/2026-03/EUR` },
    { method, path: `${RATES}/2026-03` },
  ]),
  ...["GET", "POST", "PUT", "PATCH", "DELETE"].flatMap((method) => [
    { method, path: DESIGNATION },
    { method, path: `${DESIGNATION}/history` },
  ]),
  ...["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => ({ method, path: CSV_EXPORT })),
  { method: "GET", path: `${LEDGER}?includeInactive=true` },
  { method: "GET", path: `${RATES}?month=2026-03` },
];

/** What Refund still serves, for a settings admin: a control, so a 404 above means "removed" and not "this probe is broken". */
const KEPT: Probe[] = [
  { method: "GET", path: "/accounting/expense-type-defaults" },
  { method: "GET", path: "/accounting/options" },
  { method: "PUT", path: "/accounting/expense-type-defaults/postal" },
  // The export's file route exists and is protected (the settings admin lacks `request:review`: 403, not 404).
  { method: "GET", path: "/batches/b-1/accounting-export/file" },
];

let dir = "";
let auth: ReturnType<typeof Bun.serve>;
let token = "";
let answers: { removed: Record<string, Answer>; kept: Record<string, Answer>; unauthenticated: Record<string, Answer>; paths: string[] };

const keyOf = (probe: Probe) => `${probe.method} ${probe.path}`;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), use: "sig", alg: "RS256", kid: KID };
  auth = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/auth/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/authz/resolve") return Response.json(SETTINGS_ADMIN);
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${auth.port}`;
  token = await new SignJWT({ email: "settings-admin@welld.ch", perm_epoch: 1 })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(base)
    .setSubject(SETTINGS_ADMIN.sub)
    .setAudience(AUDIENCE)
    .setExpirationTime("1h")
    .sign(privateKey);

  const entry = new URL("./index.ts", import.meta.url).pathname;
  const script = `
    const app = (await import(${JSON.stringify(entry)})).default;
    const probes = JSON.parse(process.env.REMOVED_ROUTES_PROBES);
    const ask = async (probe, bearer) => {
      const init = { method: probe.method, headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: "Bearer " + bearer } : {}) } };
      if (probe.method !== "GET" && probe.method !== "DELETE") init.body = "{}";
      const res = await app.fetch(new Request("http://localhost" + probe.path, init));
      let code = null;
      try { code = (await res.json()).code ?? null; } catch {}
      return { status: res.status, code };
    };
    const out = { removed: {}, kept: {}, unauthenticated: {}, paths: [] };
    for (const probe of probes.removed) {
      out.removed[probe.method + " " + probe.path] = await ask(probe, process.env.REMOVED_ROUTES_TOKEN);
      out.unauthenticated[probe.method + " " + probe.path] = await ask(probe, null);
    }
    for (const probe of probes.kept) {
      out.kept[probe.method + " " + probe.path] = await ask(probe, process.env.REMOVED_ROUTES_TOKEN);
      out.unauthenticated[probe.method + " " + probe.path] = await ask(probe, null);
    }
    const doc = await (await app.fetch(new Request("http://localhost/openapi.json"))).json();
    out.paths = Object.keys(doc.paths ?? {});
    console.log("@@RESULT@@" + JSON.stringify(out));
    process.exit(0);
  `;
  dir = mkdtempSync(join(tmpdir(), "refund-removed-routes-"));
  const file = join(dir, "probe.ts");
  writeFileSync(file, script);
  const proc = Bun.spawn([process.execPath, "run", file], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      AUTH_JWKS_URL: `${base}/auth/jwks`,
      AUTH_BASE_URL: base,
      AUTH_ISSUER: base,
      AUTH_AUDIENCE: AUDIENCE,
      NODE_ENV: "test",
      REMOVED_ROUTES_TOKEN: token,
      REMOVED_ROUTES_PROBES: JSON.stringify({ removed: REMOVED, kept: KEPT }),
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = stdout.split("\n").find((l) => l.startsWith("@@RESULT@@"));
  if (!line) throw new Error(`the app did not answer in the subprocess:\n${stdout}\n${stderr}`);
  answers = JSON.parse(line.slice("@@RESULT@@".length));
}, 60_000);

afterAll(() => {
  auth?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the catalog and exchange-rate routes of 20261118 are gone (AC-3.7, AC-4.6)", () => {
  it("every one answers 404 to a settings:manage holder, in every method: the ledger accounts, the VAT codes, the exchange rates and their sub-paths", () => {
    const wrong = REMOVED.map(keyOf).filter((key) => answers.removed[key]?.status !== 404);
    expect(wrong).toEqual([]);
    expect(REMOVED.length).toBeGreaterThanOrEqual(80);
  });

  it("they are not even behind authentication: with no token the answer is still 404, never 401 (there is no route to protect)", () => {
    const wrong = REMOVED.map(keyOf).filter((key) => answers.unauthenticated[key]?.status !== 404);
    expect(wrong).toEqual([]);
  });

  it("the caller really is a settings:manage holder: what Refund still serves answers them (so a 404 above is 'removed', not 'refused')", () => {
    // Defaults GET (settings:read): served, with Accounting unreachable in this process (200, `accounting: "unavailable"`).
    expect(answers.kept["GET /accounting/expense-type-defaults"]?.status).toBe(200);
    // The options need Accounting, which cannot be read here: 503, not 404 and not 403 (D16: settings:manage is allowed).
    expect(answers.kept["GET /accounting/options"]).toEqual({ status: 503, code: "accounting_unavailable" });
    // A default write is validated live: with Accounting unreachable it is 503 (or 422 for this empty body), never 404.
    expect(answers.kept["PUT /accounting/expense-type-defaults/postal"]?.status).not.toBe(404);
    // And without a token the same routes are 401: they exist and are protected.
    for (const probe of KEPT) expect(answers.unauthenticated[keyOf(probe)]?.status).toBe(401);
  });

  it("(20261118 SO-16) the designation route answers 404 in every method, to a settings:manage holder and to no one alike", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const key = keyOf({ method, path: DESIGNATION });
      expect([key, answers.removed[key]?.status, answers.unauthenticated[key]?.status]).toEqual([key, 404, 404]);
    }
  });

  it("the OpenAPI document no longer lists them, and still lists what stayed", () => {
    const listed = answers.paths.filter(
      (path) => path.startsWith(LEDGER) || path.startsWith(VAT) || path.startsWith(RATES) || path.startsWith(DESIGNATION),
    );
    expect(listed).toEqual([]);
    expect(answers.paths).toContain("/accounting/expense-type-defaults");
    expect(answers.paths).toContain("/accounting/expense-type-defaults/{type}");
    expect(answers.paths).toContain("/accounting/options");
    expect(answers.paths).toContain("/batches/{id}/accounting-export");
  });

  it("(T62, SO-12) the export's CSV route is gone and its file route is there, in the routes and in the OpenAPI document", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const key = keyOf({ method, path: CSV_EXPORT });
      expect([key, answers.removed[key]?.status, answers.unauthenticated[key]?.status]).toEqual([key, 404, 404]);
    }
    expect(answers.paths).toContain("/batches/{id}/accounting-export/file");
    expect(answers.paths).not.toContain("/batches/{id}/accounting-export/csv");
    // The file route answers a settings admin with a refusal (no review capability), not with "no such route".
    expect(answers.kept["GET /batches/b-1/accounting-export/file"]?.status).toBe(403);
  });
});
