/**
 * Capability x route matrix fixtures (T44, specs/015-hardware-inventory;
 * AC-9.1 to AC-9.5, AC-9.7, AC-11.1).
 *
 * This file is DATA plus helpers; `src/matrix.test.ts` is the test. The
 * expectation table below is keyed by the route's own `METHOD /path`, and the
 * test compares its keys with the route table of the ASSEMBLED app, so a route
 * added without a row here fails, and so does a row for a route that is gone.
 *
 * The verdicts are written from the SPEC (plan.md "API contracts"), not read
 * back from the implementation: capability absent = 403 (404 on the routes
 * that are addressed to a record and need only a login to be reached), record
 * or entity out of scope = 404 (403 where the entity arrives in a body), and
 * `/me/*` = JWT only. The personas carry their covered entities as literals
 * rather than calling `scopeFor`, so the oracle is independent of the code
 * under test.
 */

import { generateKeyPair, SignJWT } from "jose";
import { setupTestAuth, TEST_AUDIENCE, TEST_ISSUER, TEST_KID } from "./testAuth";
import type { ResolvedPermission } from "../authz/resolveClient";
import { db } from "../lib/db";

export type Entity = "welld_ch" | "welld_it";
export const ENTITIES: readonly Entity[] = ["welld_ch", "welld_it"];
export const currencyOf = (e: Entity) => (e === "welld_ch" ? "CHF" : "EUR");

// ─── Personas ───────────────────────────────────────────────────────────────

const ENTITY_COND: ResolvedPermission["conditions"] = {
  attributes: [{ key: "entity", match: "user" }],
};
const perm = (
  resource: string,
  action: string,
  scoped: boolean,
): ResolvedPermission => ({
  resource,
  action,
  conditions: scoped ? ENTITY_COND : null,
});
const ASSET = (scoped: boolean) => perm("asset", "manage", scoped);
const LEDGER = (scoped: boolean) => perm("ledger", "manage", scoped);
const ACCESS = perm("inventory", "access", false);
const ODD_COND = { attributes: [{ key: "department", match: "user" }] };
const ODD_ASSET: ResolvedPermission = { resource: "asset", action: "manage", conditions: ODD_COND };
const ODD_LEDGER: ResolvedPermission = { resource: "ledger", action: "manage", conditions: ODD_COND };

/** A caller with a valid token and a steerable `/authz/resolve` answer. */
export interface Persona {
  readonly name: string;
  readonly sub: string;
  readonly permissions: readonly ResolvedPermission[];
  /** The caller's own entity, as `auth` reports it. */
  readonly entity: string | null;
  /** Spec oracle: the entities each capability covers. */
  readonly assetScope: readonly Entity[];
  readonly ledgerScope: readonly Entity[];
  readonly hasAsset: boolean;
  readonly hasLedger: boolean;
  /** `auth` is unreachable: `/authz/resolve` throws. */
  readonly outage?: boolean;
}

const BOTH: readonly Entity[] = ["welld_ch", "welld_it"];
const persona = (
  name: string,
  permissions: ResolvedPermission[],
  entity: string | null,
  assetScope: readonly Entity[],
  ledgerScope: readonly Entity[],
  extra: Partial<Persona> = {},
): Persona => ({
  name,
  sub: `sub-${name}`,
  permissions,
  entity,
  assetScope,
  ledgerScope,
  hasAsset: permissions.some((p) => p.resource === "asset"),
  hasLedger: permissions.some((p) => p.resource === "ledger"),
  ...extra,
});

export const PERSONAS: readonly Persona[] = [
  persona("no-grants", [], null, [], []),
  persona("access-only", [ACCESS], "welld_ch", [], []),
  persona("mgr-global", [ACCESS, ASSET(false)], "welld_ch", BOTH, []),
  persona("mgr-ch", [ACCESS, ASSET(true)], "welld_ch", ["welld_ch"], []),
  persona("mgr-it", [ACCESS, ASSET(true)], "welld_it", ["welld_it"], []),
  persona("led-global", [ACCESS, LEDGER(false)], "welld_ch", [], BOTH),
  persona("led-ch", [ACCESS, LEDGER(true)], "welld_ch", [], ["welld_ch"]),
  persona("led-it", [ACCESS, LEDGER(true)], "welld_it", [], ["welld_it"]),
  persona("both-global", [ACCESS, ASSET(false), LEDGER(false)], "welld_ch", BOTH, BOTH),
  persona("both-ch", [ACCESS, ASSET(true), LEDGER(true)], "welld_ch", ["welld_ch"], ["welld_ch"]),
  // Mixed: every device in the group, but the books of one entity only.
  persona("mgr-global-led-it", [ACCESS, ASSET(false), LEDGER(true)], "welld_it", BOTH, ["welld_it"]),
  persona("mgr-ch-led-global", [ACCESS, ASSET(true), LEDGER(false)], "welld_ch", ["welld_ch"], BOTH),
  // An entity-conditioned grant whose holder has no entity: holds the
  // capability, covers nothing (R-7: fail closed, never "everything").
  persona("mgr-no-entity", [ACCESS, ASSET(true)], null, [], [], { hasAsset: true }),
  persona("led-no-entity", [ACCESS, LEDGER(true)], null, [], [], { hasLedger: true }),
  // A grant carrying a condition inventory-api does not understand: holds the
  // capability, covers nothing (fail closed - never "unrestricted").
  persona("mgr-odd-condition", [ACCESS, ODD_ASSET], "welld_ch", [], [], { hasAsset: true }),
  persona("led-odd-condition", [ACCESS, ODD_LEDGER], "welld_ch", [], [], { hasLedger: true }),
];

/** A fully privileged caller while `auth /authz/resolve` is down. */
export const OUTAGE: Persona = persona(
  "outage",
  [ACCESS, ASSET(false), LEDGER(false)],
  "welld_ch",
  BOTH,
  BOTH,
  { outage: true },
);

export const union = (a: readonly Entity[], b: readonly Entity[]): Entity[] =>
  ENTITIES.filter((e) => a.includes(e) || b.includes(e));
export const visibleTo = (p: Persona): Entity[] => union(p.assetScope, p.ledgerScope);

// ─── Tokens (the 401 personas) ──────────────────────────────────────────────

export interface Credentials {
  readonly label: string;
  /** The full Authorization header, or null for none. */
  readonly header: string | null;
}

export async function unauthenticatedCredentials(): Promise<Credentials[]> {
  const foreign = await generateKeyPair("RS256");
  const forged = await new SignJWT({ email: "mallory@welld.ch" })
    .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
    .setIssuer(TEST_ISSUER)
    .setSubject("mallory")
    .setAudience(TEST_AUDIENCE)
    .setExpirationTime("1h")
    .sign(foreign.privateKey);
  return [
    { label: "no token", header: null },
    { label: "basic scheme", header: "Basic dXNlcjpwYXNz" },
    { label: "garbage bearer", header: "Bearer not.a.jwt" },
    { label: "valid shape, wrong signing key", header: `Bearer ${forged}` },
  ];
}

export async function tokenFor(p: Persona): Promise<string> {
  return setupTestAuth().signToken({ sub: p.sub, email: `${p.name}@welld.ch`, permEpoch: 1 });
}

export function steerResolve(p: Persona): void {
  setupTestAuth().setResolve(async () => {
    if (p.outage) throw new Error("auth is unreachable (T44 outage persona)");
    return {
      sub: p.sub,
      epoch: 1,
      permissions: p.permissions,
      entity: p.entity,
      jobTitle: null,
    };
  });
}

// ─── Seeding ────────────────────────────────────────────────────────────────

let seq = 0;
export const mkAsset = (entity: Entity, over: Record<string, unknown> = {}) => {
  seq++;
  return db.asset.create({
    data: {
      entity,
      currency: currencyOf(entity),
      category: "laptop",
      description: `Device ${seq}`,
      serialNumber: `SN-${seq}`,
      purchaseDate: new Date("2025-03-01"),
      purchasePriceCents: 123456,
      status: "in_stock",
      invoiceRef: "INV-1",
      createdByUserId: "seed",
      ...over,
    } as never,
  });
};

export const mkFile = (entity: Entity, uploadStatus: "pending" | "stored", createdByUserId = "seed") => {
  seq++;
  return db.invoiceFile.create({
    data: {
      entity,
      invoiceRef: "INV-1",
      objectKey: `inventory/${entity}/file-${seq}/f.pdf`,
      fileName: "f.pdf",
      contentType: "application/pdf",
      sizeBytes: 1000,
      uploadStatus,
      createdByUserId,
    },
  });
};

type Row = { id: string };
export interface World {
  /** A live `in_stock` asset per entity with one history entry. */
  readonly A: Record<Entity, Row>;
  /** A stored invoice file per entity, ref INV-1. */
  readonly F: Record<Entity, Row>;
}

/** The base world: per entity one asset, one stored file, one history entry. */
export async function seedWorld(): Promise<World> {
  const A = {} as Record<Entity, Row>;
  const F = {} as Record<Entity, Row>;
  for (const e of ENTITIES) {
    const a = await mkAsset(e);
    A[e] = a;
    F[e] = await mkFile(e, "stored");
    await db.assetEvent.create({
      data: {
        assetId: a.id,
        entity: e,
        action: "edited",
        actorUserId: "seed",
        actorEmail: "seed@welld.ch",
        oldValue: { locationNote: null },
        newValue: { locationNote: "shelf 3" },
      },
    });
  }
  return { A, F };
}

// ─── DB snapshots ───────────────────────────────────────────────────────────

export interface Snapshot {
  readonly json: string;
  readonly eventIds: ReadonlySet<string>;
  readonly events: readonly { id: string; assetId: string | null; entity: string; action: string; actorUserId: string }[];
  /** id -> entity for every row that belongs to one entity. */
  readonly entityOf: ReadonlyMap<string, string>;
}

export async function snapshot(): Promise<Snapshot> {
  const o = { orderBy: { id: "asc" as const } };
  const [assets, assignments, rules, years, figures, files, events] = await Promise.all([
    db.asset.findMany(o),
    db.assignment.findMany(o),
    db.depreciationRule.findMany(o),
    db.fiscalYear.findMany(o),
    db.assetYearFigure.findMany(o),
    db.invoiceFile.findMany(o),
    db.assetEvent.findMany(o),
  ]);
  const entityOf = new Map<string, string>();
  for (const r of [...assets, ...rules, ...years, ...figures, ...files]) entityOf.set(r.id, r.entity);
  const assetEntity = new Map(assets.map((a) => [a.id, a.entity as string]));
  for (const a of assignments) entityOf.set(a.id, assetEntity.get(a.assetId) ?? "unknown");
  return {
    json: JSON.stringify({ assets, assignments, rules, years, figures, files, events }),
    eventIds: new Set(events.map((e) => e.id)),
    events: events.map((e) => ({
      id: e.id,
      assetId: e.assetId,
      entity: e.entity,
      action: e.action,
      actorUserId: e.actorUserId,
    })),
    entityOf,
  };
}

// ─── Response scanning ──────────────────────────────────────────────────────

/** Keys that belong to the books (schedule, book value, rules, roll-forward). */
export const LEDGER_KEY =
  /(ledger|book.?value|schedule|roll.?forward|depreciation|closing|opening|in.?force|residual|useful.?life|first.?year|low.?value|effective.?from|^rules?$)/i;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface ScanOptions {
  /** Skip the ledger-key rule (the `/scope` body names the capability). */
  readonly keyRuleOff?: boolean;
}

/**
 * Violations of the field-level rules for `p` in a 2xx body:
 *  - an object tagged with an entity outside everything `p` may see;
 *  - a ledger-ish key (or a history `field` naming one) anywhere outside an
 *    object whose entity `p`'s ledger scope covers.
 */
export function scanBody(body: unknown, p: Persona, opts: ScanOptions = {}): string[] {
  const visible = visibleTo(p);
  const violations: string[] = [];
  const walk = (node: unknown, path: string, ledgerAllowed: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, ledgerAllowed));
      return;
    }
    if (!isObj(node)) return;
    let allowed = ledgerAllowed;
    const e = node["entity"];
    if (typeof e === "string" && (ENTITIES as readonly string[]).includes(e)) {
      if (!visible.includes(e as Entity)) violations.push(`${path}: entity ${e} is outside the caller's scope`);
      allowed = p.ledgerScope.includes(e as Entity);
    }
    for (const [k, v] of Object.entries(node)) {
      if (!opts.keyRuleOff && !allowed && LEDGER_KEY.test(k)) violations.push(`${path}.${k}: ledger key without ledger scope`);
      if (!opts.keyRuleOff && !allowed && k === "field" && typeof v === "string" && LEDGER_KEY.test(v)) {
        violations.push(`${path}.field=${v}: ledger field without ledger scope`);
      }
      walk(v, `${path}.${k}`, allowed);
    }
  };
  walk(body, "$", p.ledgerScope.length > 0);
  return violations;
}

/** Every `AssetView`-shaped object in a body. */
export function assetViews(body: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isObj(n)) return;
    if (typeof n["purchasePriceCents"] === "number" && typeof n["entity"] === "string" && "status" in n && "currency" in n) out.push(n);
    Object.values(n).forEach(walk);
  };
  walk(body);
  return out;
}

// ─── The expectation table ──────────────────────────────────────────────────

export interface Req {
  readonly path: string;
  readonly body?: unknown;
  /** The record id inside `path`, replaced by a nonexistent one for the "as if it did not exist" probe. */
  readonly subject?: string;
}

export interface MatrixCase {
  /** `METHOD /path` exactly as the route table spells it, `{id}` style. */
  readonly route: string;
  readonly variant?: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** True when the row is hit once per target entity, false when it is entity-less. */
  readonly perEntity: boolean;
  /** `/me/*`: reachable with a login alone, built per persona. */
  readonly identity?: boolean;
  /** Expected status for a persona with working `auth` and a token. */
  readonly verdict: (p: Persona, e: Entity) => number;
  /** The `asset_event` actions a successful call must write, exactly. */
  readonly events: readonly string[];
  /** Whether a successful call may change the database at all. */
  readonly mutating: boolean;
  /** Keep the body-scan from flagging the `ledger` key (the `/scope` shape). */
  readonly keyRuleOff?: boolean;
  /** `detail` or `list`: a ledger-scope caller MUST get the matching `ledger` member. */
  readonly ledgerShape?: "detail" | "list";
  readonly build: (e: Entity, p: Persona, w: World) => Promise<Req>;
}

type Need = "asset" | "ledger" | "either";
const holds = (p: Persona, n: Need) =>
  n === "asset" ? p.hasAsset : n === "ledger" ? p.hasLedger : p.hasAsset || p.hasLedger;
const covers = (p: Persona, n: Need): readonly Entity[] =>
  n === "asset" ? p.assetScope : n === "ledger" ? p.ledgerScope : visibleTo(p);

/** capability absent -> `noCap`; held but entity not covered -> `out`; else `ok`. */
const gate =
  (n: Need, ok: number, noCap = 403, out = 404) =>
  (p: Persona, e: Entity): number =>
    !holds(p, n) ? noCap : covers(p, n).includes(e) ? ok : out;

const byId = (e: Entity, w: World) => w.A[e].id;

const post = (route: string, over: Partial<MatrixCase> & Pick<MatrixCase, "verdict" | "build" | "events">): MatrixCase => ({
  route,
  method: "POST",
  perEntity: true,
  mutating: true,
  ...over,
});

/** A transition route: seeds an asset in the state it needs. */
const transition = (
  kind: string,
  action: string,
  seed: (e: Entity) => Promise<Row>,
): MatrixCase =>
  post(`POST /assets/{id}/${kind}`, {
    verdict: gate("asset", 200),
    events: [action],
    build: async (e) => {
      const a = await seed(e);
      return { path: `/assets/${a.id}/${kind}`, subject: a.id };
    },
  });

export const CASES: readonly MatrixCase[] = [
  // ── Scope ──
  {
    route: "GET /scope",
    method: "GET",
    perEntity: false,
    mutating: false,
    keyRuleOff: true,
    verdict: () => 200,
    events: [],
    build: async () => ({ path: "/scope" }),
  },

  // ── /me/*: JWT only ──
  {
    route: "GET /me/devices",
    method: "GET",
    perEntity: false,
    mutating: false,
    identity: true,
    verdict: () => 200,
    events: [],
    build: async () => ({ path: "/me/devices" }),
  },
  post("POST /me/assignments/{id}/confirm", {
    identity: true,
    verdict: () => 200,
    events: ["assignment_confirmed"],
    build: async (e, p) => {
      const a = await mkAsset(e);
      const as = await db.assignment.create({
        data: { assetId: a.id, assigneeUserId: p.sub, createdByUserId: "mgr" },
      });
      return { path: `/me/assignments/${as.id}/confirm`, subject: as.id };
    },
  }),
  post("POST /me/assignments/{id}/decline", {
    identity: true,
    verdict: () => 204,
    events: ["assignment_declined"],
    build: async (e, p) => {
      const a = await mkAsset(e);
      const as = await db.assignment.create({
        data: { assetId: a.id, assigneeUserId: p.sub, createdByUserId: "mgr" },
      });
      return { path: `/me/assignments/${as.id}/decline`, subject: as.id };
    },
  }),

  // ── Assets: reads (either capability) ──
  {
    route: "GET /assets",
    method: "GET",
    perEntity: false,
    mutating: false,
    ledgerShape: "list",
    verdict: (p) => (holds(p, "either") ? 200 : 403),
    events: [],
    build: async () => ({ path: "/assets" }),
  },
  {
    route: "GET /assets/{id}",
    method: "GET",
    perEntity: true,
    mutating: false,
    ledgerShape: "detail",
    verdict: gate("either", 200, 404),
    events: [],
    build: async (e, _p, w) => ({ path: `/assets/${byId(e, w)}`, subject: byId(e, w) }),
  },
  {
    route: "GET /assets/{id}/history",
    method: "GET",
    perEntity: true,
    mutating: false,
    verdict: gate("either", 200, 404),
    events: [],
    build: async (e, _p, w) => ({ path: `/assets/${byId(e, w)}/history`, subject: byId(e, w) }),
  },

  // ── Assets: manager writes ──
  post("POST /assets", {
    verdict: gate("asset", 201, 403, 403),
    events: ["registered"],
    build: async (e) => ({
      path: "/assets",
      body: {
        entity: e,
        category: "laptop",
        description: "Matrix laptop",
        purchaseDate: "2026-02-01",
        totalPriceCents: 50000,
      },
    }),
  }),
  {
    route: "PATCH /assets/{id}",
    variant: "locationNote (manager field)",
    method: "PATCH",
    perEntity: true,
    mutating: true,
    verdict: (p, e) => {
      if (!holds(p, "either")) return 403;
      if (!visibleTo(p).includes(e)) return 404;
      return p.assetScope.includes(e) ? 200 : 403;
    },
    events: ["edited"],
    build: async (e, _p, w) => ({
      path: `/assets/${byId(e, w)}`,
      body: { locationNote: "shelf 9" },
      subject: byId(e, w),
    }),
  },
  {
    route: "PATCH /assets/{id}",
    variant: "supplier (either capability, AC-10.1)",
    method: "PATCH",
    perEntity: true,
    mutating: true,
    verdict: gate("either", 200),
    events: ["edited"],
    build: async (e, _p, w) => ({
      path: `/assets/${byId(e, w)}`,
      body: { supplier: "ACME" },
      subject: byId(e, w),
    }),
  },
  {
    route: "PATCH /assets/{id}",
    variant: "purchasePriceCents (manager field, AC-9.2)",
    method: "PATCH",
    perEntity: true,
    mutating: true,
    verdict: (p, e) => {
      if (!holds(p, "either")) return 403;
      if (!visibleTo(p).includes(e)) return 404;
      return p.assetScope.includes(e) ? 200 : 403;
    },
    events: ["edited"],
    build: async (e, _p, w) => ({
      path: `/assets/${byId(e, w)}`,
      body: { purchasePriceCents: 99999 },
      subject: byId(e, w),
    }),
  },
  transition("receive", "received", (e) => mkAsset(e, { status: "ordered" })),
  transition("return", "returned", (e) => mkAsset(e, { status: "assigned", holderUserId: "holder-1" })),
  transition("repair", "repair_started", (e) => mkAsset(e)),
  transition("repair-done", "repair_finished", (e) => mkAsset(e, { status: "in_repair" })),
  transition("lost", "marked_lost", (e) => mkAsset(e)),
  transition("found", "marked_found", (e) => mkAsset(e, { status: "lost" })),
  post("POST /assets/{id}/assignments", {
    verdict: gate("asset", 201),
    events: ["assignment_created"],
    build: async (e, _p, w) => ({
      path: `/assets/${byId(e, w)}/assignments`,
      body: { assigneeUserId: "emp-9" },
      subject: byId(e, w),
    }),
  }),
  post("POST /assignments/{id}/cancel", {
    verdict: gate("asset", 200),
    events: ["assignment_cancelled"],
    build: async (e) => {
      const a = await mkAsset(e);
      const as = await db.assignment.create({
        data: { assetId: a.id, assigneeUserId: "emp-9", createdByUserId: "mgr" },
      });
      return { path: `/assignments/${as.id}/cancel`, subject: as.id };
    },
  }),

  // ── Ledger ──
  post("POST /assets/{id}/dispose", {
    verdict: gate("ledger", 200),
    events: ["disposed"],
    build: async (e, _p, w) => ({
      path: `/assets/${byId(e, w)}/dispose`,
      body: { disposedOn: "2026-05-01", reason: "scrapped" },
      subject: byId(e, w),
    }),
  }),
  {
    route: "GET /rules",
    method: "GET",
    perEntity: true,
    mutating: false,
    verdict: gate("ledger", 200),
    events: [],
    build: async (e) => ({ path: `/rules?entity=${e}` }),
  },
  post("POST /rules", {
    verdict: gate("ledger", 201),
    events: [],
    build: async (e) => ({
      path: "/rules",
      body: {
        entity: e,
        effectiveFrom: "2027-01-01",
        usefulLifeYears: 4,
        firstYearShare: "full",
        lowValueThresholdCents: null,
        residualCents: 0,
      },
    }),
  }),
  {
    route: "GET /fiscal-years",
    method: "GET",
    perEntity: true,
    mutating: false,
    verdict: gate("ledger", 200),
    events: [],
    build: async (e) => ({ path: `/fiscal-years?entity=${e}` }),
  },
  {
    route: "GET /fiscal-years/{entity}/{year}",
    method: "GET",
    perEntity: true,
    mutating: false,
    verdict: gate("ledger", 200),
    events: [],
    build: async (e) => ({ path: `/fiscal-years/${e}/2025` }),
  },
  post("POST /fiscal-years/{entity}/{year}/close", {
    verdict: gate("ledger", 201),
    events: ["fiscal_year_closed"],
    build: async (e) => ({ path: `/fiscal-years/${e}/2025/close` }),
  }),

  // ── Invoice files (either capability, scoped to the entity) ──
  post("POST /invoice-files", {
    verdict: gate("either", 201, 403, 403),
    events: [],
    build: async (e) => ({
      path: "/invoice-files",
      body: {
        entity: e,
        invoiceRef: "INV-1",
        fileName: "fattura.pdf",
        contentType: "application/pdf",
        sizeBytes: 1000,
      },
    }),
  }),
  post("POST /invoice-files/{id}/confirm", {
    verdict: gate("either", 200, 404),
    events: [],
    // Confirm is the uploader's alone: the file is the caller's own.
    build: async (e, p) => {
      const f = await mkFile(e, "pending", p.sub);
      return { path: `/invoice-files/${f.id}/confirm`, subject: f.id };
    },
  }),
  {
    route: "PUT /invoice-files/{id}/assets",
    method: "PUT",
    perEntity: true,
    mutating: true,
    verdict: gate("either", 200, 404),
    events: ["invoice_file_linked"],
    build: async (e, _p, w) => ({
      path: `/invoice-files/${w.F[e].id}/assets`,
      body: { assetIds: [w.A[e].id] },
      subject: w.F[e].id,
    }),
  },
  {
    route: "GET /invoice-files/{id}/url",
    method: "GET",
    perEntity: true,
    mutating: false,
    verdict: gate("either", 200, 404),
    events: [],
    build: async (e, _p, w) => ({ path: `/invoice-files/${w.F[e].id}/url`, subject: w.F[e].id }),
  },
];

/** The only routes that answer without a token. Adding one here is a deliberate act. */
export const PUBLIC_ROUTES: readonly string[] = ["GET /health", "GET /openapi.json", "GET /docs"];

/** The matrix rows' route keys, deduplicated (PATCH has several variants). */
export const CASE_ROUTES: readonly string[] = [...new Set(CASES.map((c) => c.route))];

/** `/assets/:id` (Hono) -> `/assets/{id}` (OpenAPI), so both views compare. */
export const braces = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

/** Every `METHOD /path` the app answers, from its own route table. */
export function routeKeys(app: { routes: readonly { method: string; path: string }[] }): string[] {
  const keys = new Set<string>();
  for (const r of app.routes) {
    if (r.method === "ALL") continue; // app-wide middleware (cors, request log)
    keys.add(`${r.method} ${braces(r.path)}`);
  }
  return [...keys].sort();
}
