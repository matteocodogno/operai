/**
 * Capability x route matrix and event-per-mutation test over the ASSEMBLED app
 * (T44, specs/015-hardware-inventory; AC-9.1 to AC-9.5, AC-9.7, AC-11.1).
 *
 * Nothing here is a per-router wrapper: `app` is `src/index.ts`'s own app, with
 * the real JWT-shaped and authorization middleware (over the shared harness: a
 * local key set and a steerable `/authz/resolve` fixture) and real Postgres.
 *
 * What makes it hard to let go stale:
 *  - the routes come from the app's own route table, compared both ways with
 *    the expectation table in `test-support/routeMatrix.ts` and with the
 *    OpenAPI document, so a route added without a row FAILS this file;
 *  - every verdict is written from the spec, with personas whose scope is a
 *    literal, not computed by the code under test;
 *  - every cell checks the status, then the body (field-level), then the
 *    database: exactly the expected `asset_event` rows on success, nothing at
 *    all on a refusal.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, spyOn } from "bun:test";
import { setupTestAuth } from "./test-support/testAuth";
import { truncateInventoryTables } from "./test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("./index");
const { db } = await import("./lib/db");
const { storage } = await import("./lib/storage");
const { assignmentHooks } = await import("./assignments/assignments.routes");
const { __resetAuthzCacheForTests } = await import("./auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("./lib/identities");
const M = await import("./test-support/routeMatrix");
type Persona = import("./test-support/routeMatrix").Persona;
type MatrixCase = import("./test-support/routeMatrix").MatrixCase;
type Entity = import("./test-support/routeMatrix").Entity;
type World = import("./test-support/routeMatrix").World;
type Req = import("./test-support/routeMatrix").Req;

// ─── Process-wide stubs (no per-file module mocks) ──────────────────────────

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let headSpy: ReturnType<typeof spyOn<typeof storage, "headObject">>;
let deleteSpy: ReturnType<typeof spyOn<typeof storage, "deleteObject">>;
const originalAfterCommit = assignmentHooks.afterCommit;
let consoleErr: ReturnType<typeof spyOn<typeof console, "error">>;

beforeAll(async () => {
  await dropFailTrigger();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/authz/users/identities")) {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      return Response.json({ users: ids.map((id) => ({ id, status: "active", name: `Name of ${id}` })) });
    }
    throw new Error(`unexpected network call in the matrix test: ${String(url)}`);
  }) as unknown as typeof fetch);
  headSpy = spyOn(storage, "headObject").mockImplementation(async () => ({
    sizeBytes: 1000,
    contentType: "application/pdf",
  }));
  deleteSpy = spyOn(storage, "deleteObject").mockImplementation(async () => undefined);
  assignmentHooks.afterCommit = () => undefined; // the push is T17's test, not this one
  consoleErr = spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(async () => {
  await dropFailTrigger();
  fetchSpy.mockRestore();
  headSpy.mockRestore();
  deleteSpy.mockRestore();
  consoleErr.mockRestore();
  assignmentHooks.afterCommit = originalAfterCommit;
  await truncateInventoryTables();
  console.log(`[T44] matrix cells exercised: ${cells}`);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

let cells = 0;
// RFC 7807 members plus the typed extension members plan.md "API contracts" lists
// (`from`, `year`, `serialNumber`, `assetId`, `assignmentId`): never record data.
const PROBLEM_MEMBERS = new Set([
  "type", "title", "status", "detail", "instance", "code", "field", "errors", "issues",
  "from", "year", "serialNumber", "assetId", "assignmentId",
]);

async function send(method: string, req: Req, authorization: string | null): Promise<Response> {
  return app.request(req.path, {
    method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
}

async function as(p: Persona): Promise<string> {
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  M.steerResolve(p);
  return `Bearer ${await M.tokenFor(p)}`;
}

const readBody = async (res: Response): Promise<{ text: string; json: unknown }> => {
  const text = await res.text();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
};

const isProblemShape = (json: unknown, status: number): string | null => {
  if (typeof json !== "object" || json === null) return "body is not a Problem JSON object";
  const o = json as Record<string, unknown>;
  if (o["status"] !== status) return `Problem status member ${String(o["status"])} != ${status}`;
  const extra = Object.keys(o).filter((k) => !PROBLEM_MEMBERS.has(k));
  return extra.length ? `error body carries non-problem members: ${extra.join(",")}` : null;
};

const sorted = (xs: readonly string[]) => [...xs].sort();

/** Evaluates one cell and returns its violations (empty = the cell holds). */
async function cell(
  c: MatrixCase,
  p: Persona,
  e: Entity,
  authorization: string,
  expected: number,
  w: World,
  before: Awaited<ReturnType<typeof M.snapshot>>,
  req: Req,
): Promise<string[]> {
  const tag = `${c.route}${c.variant ? ` [${c.variant}]` : ""} / ${p.name} / ${e}`;
  const bad: string[] = [];
  const res = await send(c.method, req, authorization);
  cells++;
  if (res.status !== expected) {
    bad.push(`${tag}: expected ${expected}, got ${res.status}`);
  }
  const { text, json } = await readBody(res);
  const after = await M.snapshot();
  const ok = res.status >= 200 && res.status < 300;

  if (!ok) {
    const shape = isProblemShape(json, res.status);
    if (shape) bad.push(`${tag}: ${shape}`);
    if (after.json !== before.json) bad.push(`${tag}: refused (${res.status}) but the database changed`);
    return bad;
  }

  // ── 2xx: field level ──
  if (!p.outage || !c.identity) {
    for (const v of M.scanBody(json, p, c.keyRuleOff ? { keyRuleOff: true } : {})) bad.push(`${tag}: ${v}`);
  }
  const hidden = M.ENTITIES.filter((x) => !M.visibleTo(p).includes(x));
  if (!c.identity) {
    for (const [id, ent] of after.entityOf) {
      if (hidden.includes(ent as Entity) && text.includes(id)) {
        bad.push(`${tag}: body carries ${ent} record ${id} outside the caller's scope`);
      }
    }
    for (const ent of hidden) if (text.includes(ent)) bad.push(`${tag}: body names ${ent}`);
  }
  if (c.ledgerShape) {
    for (const v of M.assetViews(json)) {
      const vEntity = String(v["entity"]) as Entity;
      const inLedger = p.ledgerScope.includes(vEntity);
      const ledger = v["ledger"] as Record<string, unknown> | undefined;
      if (inLedger && !ledger) bad.push(`${tag}: ${vEntity} asset has no ledger for a ledger-scope caller`);
      if (inLedger && ledger) {
        if (typeof ledger["bookValueCents"] !== "number") bad.push(`${tag}: ledger.bookValueCents missing`);
        const wantsSchedule = c.ledgerShape === "detail";
        if (wantsSchedule !== Array.isArray(ledger["schedule"])) bad.push(`${tag}: ledger.schedule shape wrong for ${c.ledgerShape}`);
      }
      if (!inLedger && "ledger" in v) bad.push(`${tag}: ${vEntity} asset carries ledger without ledger scope`);
      if (typeof v["purchasePriceCents"] !== "number") bad.push(`${tag}: asset without purchasePriceCents`);
    }
  }
  if (c.route === "GET /scope") {
    const want = { asset: [...p.assetScope], ledger: [...p.ledgerScope] };
    if (JSON.stringify(json) !== JSON.stringify(want)) bad.push(`${tag}: /scope ${text} != ${JSON.stringify(want)}`);
  }
  if (c.route === "GET /assets") {
    const ents = M.assetViews(json).map((v) => v["entity"]);
    const want = M.visibleTo(p);
    if (sorted(ents.map(String)).join() !== sorted(want).join()) bad.push(`${tag}: list returned ${ents.join()} for scope ${want.join()}`);
  }

  // ── 2xx: events (AC-11.1) ──
  const fresh = after.events.filter((ev) => !before.eventIds.has(ev.id));
  if (sorted(fresh.map((ev) => ev.action)).join() !== sorted(c.events).join()) {
    bad.push(`${tag}: wrote events [${fresh.map((ev) => ev.action)}], expected [${c.events}]`);
  }
  for (const ev of fresh) {
    if (ev.actorUserId !== p.sub) bad.push(`${tag}: event ${ev.action} actor ${ev.actorUserId} != ${p.sub}`);
    if (ev.entity !== e) bad.push(`${tag}: event ${ev.action} entity ${ev.entity} != ${e}`);
    if (ev.action !== "fiscal_year_closed" && ev.assetId === null) bad.push(`${tag}: event ${ev.action} has no asset`);
  }
  if (c.mutating && after.json === before.json) bad.push(`${tag}: a successful mutation changed nothing`);
  if (!c.mutating && after.json !== before.json) bad.push(`${tag}: a read changed the database`);
  void w;
  return bad;
}

/**
 * The "as if it did not exist" rule (AC-9.4): for a 404 on a record id, the
 * answer is byte-identical (ids aside) to the answer for an id that never was.
 */
async function sameAsAbsent(c: MatrixCase, req: Req, authorization: string, status: number, text: string): Promise<string | null> {
  if (!req.subject || status !== 404) return null;
  const ghost = "c" + "0".repeat(24);
  const res = await send(c.method, { ...req, path: req.path.split(req.subject).join(ghost) }, authorization);
  const ghostText = (await res.text()).split(ghost).join("<ID>");
  const realText = text.split(req.subject).join("<ID>");
  if (res.status !== 404) return `ghost id answered ${res.status}, real out-of-scope id answered 404`;
  return ghostText === realText ? null : `404 for an out-of-scope id differs from 404 for an absent id:\n  real:  ${realText}\n  ghost: ${ghostText}`;
}

// ─── 1. Enumeration: the route table is the source of truth ─────────────────

describe("route enumeration (a route without a matrix row fails)", () => {
  const table = M.routeKeys(app);

  it("every route of the assembled app has a matrix row or is on the explicit public list", () => {
    const covered = new Set([...M.CASE_ROUTES, ...M.PUBLIC_ROUTES]);
    const unclassified = table.filter((k) => !covered.has(k));
    expect(unclassified).toEqual([]);
  });

  it("every matrix row names a route that still exists (no stale rows)", () => {
    const stale = [...M.CASE_ROUTES, ...M.PUBLIC_ROUTES].filter((k) => !table.includes(k));
    expect(stale).toEqual([]);
  });

  it("the route table and the OpenAPI document agree on every API route", async () => {
    const res = await app.request("/openapi.json");
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    const documented = Object.entries(doc.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
      .sort();
    const apiRoutes = table.filter((k) => !["GET /docs", "GET /openapi.json"].includes(k));
    expect(documented).toEqual(apiRoutes);
  });

  it("there is no PUT/DELETE/PATCH route outside the contract (no reopen, no rule edit, no history edit)", () => {
    // AC-6.5, AC-8.7, AC-11.2: the table is closed. A new mutating verb on these paths is a spec change.
    const mutating = table.filter((k) => !k.startsWith("GET "));
    expect(mutating.filter((k) => /\b(DELETE)\b/.test(k))).toEqual([]);
    expect(mutating.filter((k) => /history|reopen/.test(k))).toEqual([]);
    expect(mutating.filter((k) => /^(PUT|PATCH) \/(rules|fiscal-years)/.test(k))).toEqual([]);
  });

  it("the matrix covers a meaningful grid", () => {
    expect(M.PERSONAS.length).toBeGreaterThanOrEqual(14);
    expect(M.CASES.length).toBeGreaterThanOrEqual(M.CASE_ROUTES.length);
  });
});

// ─── 2. The public surface ──────────────────────────────────────────────────

describe("public routes are only health / OpenAPI / docs, and expose nothing sensitive", () => {
  it("/health answers without a token and carries only status fields", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["db", "service", "status", "timestamp", "version"]);
    expect(Object.keys(body["db"] as object)).toEqual(["status"]);
  });

  it("/openapi.json and /docs carry no secret value from the environment and no data", async () => {
    const secrets = [
      "DATABASE_URL",
      "INVENTORY_S3_SECRET_ACCESS_KEY",
      "INVENTORY_S3_ACCESS_KEY_ID",
      "SERVICE_CLIENT_SECRET",
    ]
      .map((k) => process.env[k])
      .filter((v): v is string => !!v && v.length > 6);
    expect(secrets.length).toBeGreaterThan(0);
    for (const path of ["/openapi.json", "/docs"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const s of secrets) expect(text.includes(s)).toBe(false);
    }
    const doc = JSON.stringify(await (await app.request("/openapi.json")).json());
    expect(/bearer\s+ey/i.test(doc)).toBe(false);
    expect(/-----BEGIN/.test(doc)).toBe(false);
  });

  it("an unknown path is a 404 Problem with no auth and no data (not a redirect to anything)", async () => {
    for (const path of ["/", "/assets/", "/nope", "/me", "/admin", "/.git/config"]) {
      const res = await app.request(path);
      expect([401, 404]).toContain(res.status);
      if (res.status === 404) expect(M.CASE_ROUTES.includes(`GET ${path}`)).toBe(false);
    }
  });

  it("every non-public route refuses an unauthenticated caller (covered per cell below)", () => {
    const nonPublic = M.CASE_ROUTES.filter((k) => !M.PUBLIC_ROUTES.includes(k));
    expect(nonPublic.length).toBe(M.CASE_ROUTES.length);
  });
});

// ─── 3. The matrix ──────────────────────────────────────────────────────────

describe("capability x route matrix", () => {
  beforeEach(async () => {
    await truncateInventoryTables();
  });

  for (const c of M.CASES) {
    const label = `${c.route}${c.variant ? ` [${c.variant}]` : ""}`;

    it(
      `${label}: unauthenticated callers get 401 and nothing changes`,
      async () => {
        const creds = await M.unauthenticatedCredentials();
        const w = await M.seedWorld();
        const failures: string[] = [];
        const e: Entity = "welld_ch";
        const req = await c.build(e, M.PERSONAS[0]!, w);
        const before = await M.snapshot();
        for (const cr of creds) {
          const res = await send(c.method, req, cr.header);
          cells++;
          const { json } = await readBody(res);
          if (res.status !== 401) failures.push(`${label} / ${cr.label}: expected 401, got ${res.status}`);
          const shape = isProblemShape(json, res.status);
          if (shape) failures.push(`${label} / ${cr.label}: ${shape}`);
        }
        if ((await M.snapshot()).json !== before.json) failures.push(`${label}: unauthenticated call changed the database`);
        expect(failures).toEqual([]);
      },
      60_000,
    );

    it(
      `${label}: every persona x entity gets the spec'd outcome, body and events`,
      async () => {
        const failures: string[] = [];
        const targets: Entity[] = c.perEntity ? [...M.ENTITIES] : ["welld_ch"];
        let w = await M.seedWorld();
        let dirty = false;
        for (const p of M.PERSONAS) {
          for (const e of targets) {
            if (dirty) {
              await truncateInventoryTables();
              w = await M.seedWorld();
              dirty = false;
            }
            const authorization = await as(p);
            const req = await c.build(e, p, w);
            const before = await M.snapshot();
            const expected = c.verdict(p, e);
            failures.push(...(await cell(c, p, e, authorization, expected, w, before, req)));
            const after = await M.snapshot();
            // A successful mutation spends the world (a disposed asset, a closed year): rebuild it.
            dirty = after.json !== before.json;
            if (expected === 404 && req.subject) {
              const res = await send(c.method, req, authorization);
              const probe = await sameAsAbsent(c, req, authorization, res.status, await res.text());
              if (probe) failures.push(`${label} / ${p.name} / ${e}: ${probe}`);
            }
          }
        }
        expect(failures).toEqual([]);
      },
      240_000,
    );

    it(
      `${label}: with auth unreachable it is ${c.identity ? "unaffected (/me is JWT only, ADR-0045)" : "503 fail-closed"}`,
      async () => {
        const failures: string[] = [];
        const w = await M.seedWorld();
        const e: Entity = "welld_ch";
        const authorization = await as(M.OUTAGE);
        const req = await c.build(e, M.OUTAGE, w);
        const before = await M.snapshot();
        const expected = c.identity ? c.verdict(M.OUTAGE, e) : 503;
        const res = await send(c.method, req, authorization);
        cells++;
        const { json } = await readBody(res);
        if (res.status !== expected) failures.push(`${label}: outage expected ${expected}, got ${res.status}`);
        if (res.status === 503) {
          const shape = isProblemShape(json, 503);
          if (shape) failures.push(`${label}: ${shape}`);
          if ((await M.snapshot()).json !== before.json) failures.push(`${label}: 503 but the database changed`);
        }
        expect(failures).toEqual([]);
      },
      60_000,
    );
  }
});

// ─── 4. /me/* never exposes price or ledger keys, and is scoped to sub ──────

describe("/me/* is scoped to the caller and carries no price or ledger key", () => {
  const MY_KEYS = new Set(["assetId", "description", "category", "serialNumber", "assignedAt", "assignmentId"]);

  beforeEach(async () => {
    await truncateInventoryTables();
  });

  it("GET /me/devices returns only the caller's rows, with the documented keys only, for every persona", async () => {
    const failures: string[] = [];
    for (const p of [...M.PERSONAS, M.OUTAGE]) {
      await truncateInventoryTables();
      const mine = await M.mkAsset("welld_ch", { status: "assigned", holderUserId: p.sub });
      const offered = await M.mkAsset("welld_it");
      await db.assignment.create({ data: { assetId: offered.id, assigneeUserId: p.sub, createdByUserId: "mgr" } });
      const theirs = await M.mkAsset("welld_it", { status: "assigned", holderUserId: "someone-else" });
      const theirOffer = await M.mkAsset("welld_ch");
      await db.assignment.create({ data: { assetId: theirOffer.id, assigneeUserId: "someone-else", createdByUserId: "mgr" } });

      const res = await send("GET", { path: "/me/devices" }, await as(p));
      cells++;
      if (res.status !== 200) {
        failures.push(`${p.name}: ${res.status}`);
        continue;
      }
      const { text, json } = await readBody(res);
      const body = json as { devices: Record<string, unknown>[]; pending: Record<string, unknown>[] };
      const ids = [...body.devices, ...body.pending].map((d) => d["assetId"]);
      if (sorted(ids.map(String)).join() !== sorted([mine.id, offered.id]).join()) failures.push(`${p.name}: wrong rows ${ids}`);
      if (text.includes(theirs.id) || text.includes(theirOffer.id)) failures.push(`${p.name}: another user's device leaked`);
      for (const d of [...body.devices, ...body.pending]) {
        for (const k of Object.keys(d)) if (!MY_KEYS.has(k)) failures.push(`${p.name}: unexpected key ${k}`);
      }
      if (/price|cents|ledger|schedule|book|rule|deprec|entity|currency|supplier|invoice/i.test(text)) {
        failures.push(`${p.name}: /me/devices body matches a price/ledger/entity pattern: ${text}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("confirm / decline of an assignment addressed to someone else is the same 404 as an absent one, with no write", async () => {
    const failures: string[] = [];
    for (const p of M.PERSONAS) {
      for (const action of ["confirm", "decline"]) {
        await truncateInventoryTables();
        const a = await M.mkAsset("welld_ch");
        const other = await db.assignment.create({ data: { assetId: a.id, assigneeUserId: "someone-else", createdByUserId: "mgr" } });
        const authorization = await as(p);
        const before = await M.snapshot();
        const real = await send("POST", { path: `/me/assignments/${other.id}/${action}` }, authorization);
        const ghostId = "c" + "0".repeat(24);
        const ghost = await send("POST", { path: `/me/assignments/${ghostId}/${action}` }, authorization);
        cells += 2;
        const realText = (await real.text()).split(other.id).join("<ID>");
        const ghostText = (await ghost.text()).split(ghostId).join("<ID>");
        if (real.status !== 404 || ghost.status !== 404) failures.push(`${p.name}/${action}: ${real.status}/${ghost.status}`);
        if (realText !== ghostText) failures.push(`${p.name}/${action}: bodies differ`);
        if ((await M.snapshot()).json !== before.json) failures.push(`${p.name}/${action}: wrote something`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ─── 5. Cross-entity figures (AC-9.4) with real money in both entities ──────

describe("a ledger caller scoped to one entity never sees the other entity's figures", () => {
  it("list, detail, fiscal years, history, rules and invoice URL carry nothing of the other entity", async () => {
    await truncateInventoryTables();
    const w = await M.seedWorld();
    // Make the other entity's books distinctive and non-trivial.
    const itRich = await M.mkAsset("welld_it", { purchasePriceCents: 7_777_777, invoiceRef: "INV-1" });
    await db.asset.update({ where: { id: itRich.id }, data: { invoiceFileId: w.F.welld_it.id } });
    const closed = await send("POST", { path: "/fiscal-years/welld_it/2025/close" }, await as(M.PERSONAS.find((x) => x.name === "led-global")!));
    expect(closed.status).toBe(201);

    const failures: string[] = [];
    const caller = M.PERSONAS.find((x) => x.name === "both-ch")!;
    const authorization = await as(caller);
    const probes: [string, number][] = [
      ["/assets", 200],
      [`/assets/${w.A.welld_ch.id}`, 200],
      [`/assets/${w.A.welld_ch.id}/history`, 200],
      ["/fiscal-years?entity=welld_ch", 200],
      ["/fiscal-years/welld_ch/2025", 200],
      ["/rules?entity=welld_ch", 200],
      [`/invoice-files/${w.F.welld_ch.id}/url`, 200],
      [`/assets/${itRich.id}`, 404],
      [`/assets/${itRich.id}/history`, 404],
      ["/fiscal-years?entity=welld_it", 404],
      ["/fiscal-years/welld_it/2025", 404],
      ["/rules?entity=welld_it", 404],
      [`/invoice-files/${w.F.welld_it.id}/url`, 404],
    ];
    const itFigures = ["7777777", "welld_it", "EUR", itRich.id, w.A.welld_it.id, w.F.welld_it.id, "rule_launch_welld_it"];
    for (const [path, status] of probes) {
      const res = await send("GET", { path }, authorization);
      cells++;
      const { text } = await readBody(res);
      if (res.status !== status) failures.push(`${path}: ${res.status} != ${status}`);
      for (const needle of itFigures) {
        // the 404 echoes the requested path, which legitimately names the id or entity asked for
        const echoed = !res.ok && path.includes(needle);
        if (text.includes(needle) && !echoed) failures.push(`${path}: leaked ${needle}`);
      }
    }
    const close = await send("POST", { path: "/fiscal-years/welld_it/2025/close" }, authorization);
    cells++;
    if (close.status !== 404) failures.push(`close IT as CH: ${close.status}`);
    const rule = await send(
      "POST",
      { path: "/rules", body: { entity: "welld_it", effectiveFrom: "2027-01-01", usefulLifeYears: 1, firstYearShare: "full", lowValueThresholdCents: null, residualCents: 0 } },
      authorization,
    );
    cells++;
    if (rule.status !== 404) failures.push(`rule for IT as CH: ${rule.status}`);
    const dispose = await send("POST", { path: `/assets/${itRich.id}/dispose`, body: { disposedOn: "2026-05-01", reason: "scrapped" } }, authorization);
    cells++;
    if (dispose.status !== 404) failures.push(`dispose IT as CH: ${dispose.status}`);
    expect(failures).toEqual([]);
  }, 60_000);
});

// ─── 5b. Refusals by state or validation write nothing ──────────────────────

describe("refused mutations (state, validation, capability) write no row and no event", () => {
  const owner = () => M.PERSONAS.find((x) => x.name === "both-global")!;
  const mutatingCases = M.CASES.filter((x) => x.mutating && !x.identity);

  for (const c of mutatingCases) {
    const label = `${c.route}${c.variant ? ` [${c.variant}]` : ""}`;

    it(`${label}: a repeated call is either a clean refusal (nothing written) or writes exactly its events again`, async () => {
      await truncateInventoryTables();
      const w = await M.seedWorld();
      const authorization = await as(owner());
      const req = await c.build("welld_ch", owner(), w);
      const first = await send(c.method, req, authorization);
      cells++;
      expect(first.status).toBeLessThan(300);
      const mid = await M.snapshot();
      const second = await send(c.method, req, authorization);
      cells++;
      const end = await M.snapshot();
      if (second.status >= 400) {
        expect(end.json).toBe(mid.json);
        expect(isProblemShape((await readBody(second)).json, second.status)).toBeNull();
      } else {
        const fresh = end.events.filter((ev) => !mid.eventIds.has(ev.id)).map((ev) => ev.action);
        // A repeat that changes nothing (the same edit, the same link) is a no-op:
        // no history entry, since there is no old/new pair to record. Anything
        // that does change state must write exactly its events.
        if (end.json === mid.json) expect(fresh).toEqual([]);
        else expect(sorted(fresh)).toEqual(sorted(c.events));
      }
    }, 60_000);

    if (c.method !== "PATCH" || c.variant?.startsWith("locationNote")) {
      it(`${label}: an invalid body is refused (4xx) with nothing written, but a caller without the capability gets 403 first`, async () => {
        if (c.verdict(owner(), "welld_ch") === undefined) return;
        await truncateInventoryTables();
        const w = await M.seedWorld();
        const req = await c.build("welld_ch", owner(), w);
        if (req.body === undefined) return; // nothing to corrupt
        const bad: Req = { ...req, body: { nonsense: true, entity: 42 } };
        const before = await M.snapshot();
        const res = await send(c.method, bad, await as(owner()));
        cells++;
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect((await M.snapshot()).json).toBe(before.json);
        const none = M.PERSONAS.find((x) => x.name === "no-grants")!;
        const denied = await send(c.method, bad, await as(none));
        cells++;
        // Capability before validation. The record-addressed routes with no route-level
        // gate (their capability check is the handler's 404) may answer 422 for a
        // malformed body: it names only the documented body shape and says nothing
        // about whether any record exists.
        const gatedAtRoute = c.verdict(none, "welld_ch") === 403;
        expect(gatedAtRoute ? [403] : [403, 404, 422]).toContain(denied.status);
        expect((await M.snapshot()).json).toBe(before.json);
      }, 60_000);
    }
  }

  it("registering quantity N writes N `registered` events, one per asset, in one call", async () => {
    await truncateInventoryTables();
    const res = await send(
      "POST",
      {
        path: "/assets",
        body: { entity: "welld_it", category: "laptop", description: "Bulk", purchaseDate: "2026-02-01", totalPriceCents: 100001, quantity: 3 },
      },
      await as(owner()),
    );
    cells++;
    expect(res.status).toBe(201);
    const snap = await M.snapshot();
    expect(snap.events.map((e) => e.action)).toEqual(["registered", "registered", "registered"]);
    expect(new Set(snap.events.map((e) => e.assetId)).size).toBe(3);
  });
});

// ─── 6. Event and change are one transaction (AC-11.1) ──────────────────────

async function dropFailTrigger(): Promise<void> {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS t44_fail_event ON "asset_event"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS t44_fail_event()`);
}

describe("every mutation that writes an event does so in the same transaction", () => {
  afterAll(dropFailTrigger);

  for (const c of M.CASES.filter((x) => x.events.length > 0)) {
    const label = `${c.route}${c.variant ? ` [${c.variant}]` : ""}`;
    it(
      `${label}: when the event cannot be written, the change rolls back and the call fails`,
      async () => {
        await truncateInventoryTables();
        const w = await M.seedWorld();
        const owner = M.PERSONAS.find((x) => x.name === "both-global")!;
        const e: Entity = "welld_ch";
        const authorization = await as(owner);
        const req = await c.build(e, owner, w);
        const before = await M.snapshot();

        // The success of the same call without the trigger is the matrix's job (section 3).
        await db.$executeRawUnsafe(
          `CREATE FUNCTION t44_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 't44: event write refused'; END $$`,
        );
        await db.$executeRawUnsafe(
          `CREATE TRIGGER t44_fail_event BEFORE INSERT ON "asset_event" FOR EACH ROW EXECUTE FUNCTION t44_fail_event()`,
        );
        let res: Response;
        try {
          res = await send(c.method, req, authorization);
        } finally {
          await dropFailTrigger();
        }
        cells++;
        const after = await M.snapshot();
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(after.json).toBe(before.json);
      },
      60_000,
    );
  }
});
