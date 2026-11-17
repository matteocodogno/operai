/**
 * Test world for crm-api route tests (specs/20261101-crm § Test strategy): personas
 * with literal permission sets, a request helper over the ASSEMBLED app, a
 * stub for `auth POST /authz/users/identities`, and table cleanup.
 *
 * Import order matters: this module imports `testAuth` first, which sets the
 * environment before `src/lib/env` is evaluated.
 */

import { spyOn } from "bun:test";
import { setupTestAuth } from "./testAuth";
import type { ResolvedPermission } from "../authz/resolveClient";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { setStorageForTests } = await import("../lib/storage");
type Storage = import("../lib/storage").Storage;
const { legalEntities } = await import("../lib/legalEntities");
const { fakeRegistryClient, completeEntity } = await import("./fakeRegistry");

export { app, db };

/** Forgets cached display names (60 s cache), so the next read asks `auth` again. */
export const forgetIdentities = () => __resetIdentityCacheForTests();

const ENTITY_COND = { attributes: [{ key: "entity", match: "user" }] } as const;
const ACCESS: ResolvedPermission = { resource: "crm", action: "access", conditions: null };
const DEALS = (scoped: boolean): ResolvedPermission => ({
  resource: "deal",
  action: "manage",
  conditions: scoped ? ENTITY_COND : null,
});
const ERASE: ResolvedPermission = { resource: "contact", action: "erase", conditions: null };
const MONEY: ResolvedPermission = { resource: "deal", action: "financials", conditions: null };

export interface Persona {
  readonly sub: string;
  readonly entity: string | null;
  readonly permissions: readonly ResolvedPermission[];
}

/** The callers every test file uses. Scopes are literals, not computed by the code under test. */
export const PERSONAS = {
  /** No CRM grant at all. */
  outsider: { sub: "user-outsider", entity: "welld_ch", permissions: [] },
  /**
   * `crm:access` only — the `crm-technical` role (specs/20261101-crm-sales-flow): reads everything
   * but the money, edits companies/contacts/activities, no deals.
   */
  consultant: { sub: "user-consultant", entity: "welld_ch", permissions: [ACCESS] },
  /** The technical contact of the estimate tests: `crm-technical`, and an EstimAI user. */
  tech: { sub: "user-tech", entity: "welld_ch", permissions: [ACCESS] },
  /** A colleague with the same grant, for author-only and concurrency checks. */
  colleague: { sub: "user-colleague", entity: "welld_it", permissions: [ACCESS] },
  /** `sales` role in wellD CH: deals of welld_ch only. */
  salesCh: { sub: "user-sales-ch", entity: "welld_ch", permissions: [ACCESS, DEALS(true), MONEY] },
  /** deal:manage without deal:financials — unsupported by the seed, tested anyway (specs/20261101-crm-sales-flow AC-5.2). */
  managerNoMoney: { sub: "user-manager-no-money", entity: "welld_ch", permissions: [ACCESS, DEALS(true)] },
  /** Admin: everything, both entities. */
  admin: { sub: "user-admin", entity: null, permissions: [ACCESS, DEALS(false), ERASE, MONEY] },
} satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;

const subOf = (authorizationHeader: string): string => {
  const payload = authorizationHeader.slice("Bearer ".length).split(".")[1] ?? "";
  return (JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { sub: string }).sub;
};

harness.setResolve(async (authorizationHeader) => {
  const sub = subOf(authorizationHeader);
  const persona = Object.values(PERSONAS).find((p) => p.sub === sub);
  if (!persona) throw new Error(`no persona for ${sub}`);
  return { sub, epoch: 0, permissions: persona.permissions, entity: persona.entity, jobTitle: null };
});

const tokens = new Map<string, string>();
async function tokenFor(name: PersonaName): Promise<string> {
  const cached = tokens.get(name);
  if (cached) return cached;
  const token = await harness.signToken({ sub: PERSONAS[name].sub, email: `${name}@welld.test` });
  tokens.set(name, token);
  return token;
}

// ─── auth identities stub ────────────────────────────────────────────────────
// Ids starting with "user-" are active people; "user-gone" is deleted; any other
// id is unknown. `identitiesDown` simulates an auth outage.

export const identities = { down: false, calls: 0 };

/**
 * auth's app access, for `POST /authz/app-access-check` and the directory's
 * `?appId=` filter (ADR 20261101-app-access-check-by-user-id-and-directory-app-filter). CRM users are the personas holding `crm:access`
 * plus `user-tech`; EstimAI users are listed explicitly. Tests may edit both.
 */
export const appAccess = {
  crm: new Set<string>(),
  estimai: new Set<string>(),
};
function resetAppAccess(): void {
  appAccess.crm = new Set([
    ...Object.values(PERSONAS)
      .filter((p) => p.permissions.some((perm) => perm.resource === "crm" && perm.action === "access"))
      .map((p) => p.sub),
    "user-tech",
  ]);
  appAccess.estimai = new Set(["user-tech", "user-admin", "user-sales-ch"]);
}
resetAppAccess();

/**
 * A fake estimai-api (specs/20261101-crm-sales-flow): estimates by id, their editors by email, and
 * switches to make it refuse the caller or a collaborator.
 */
export const estimai = {
  estimates: new Map<string, { id: string; name: string; owner: string; content: unknown; editors: string[] }>(),
  /** Callers estimai-api answers 403 (no EstimAI access). */
  forbidden: new Set<string>(),
  /** Answer the collaborator grant with this status instead of 201. */
  shareStatus: 201,
  down: false,
  deletes: [] as string[],
  /** Answer the create with this name instead of the one asked for (to make the link's insert fail). */
  createdName: null as string | null,
};

let tokenSerial = 0;

type ActivitiesOp = "put" | "delete" | "completion" | "mirror" | "erase";

/**
 * A fake activities-api (specs/20261110-activities T12): crm-api's whole view of it is the five `/system/v1/*`
 * calls, answered with the contract T10 implements, and auth's service-token exchange. `calls` is
 * every request in order (what the CRM asked for); `activities` is what PUT created and DELETE
 * removed; switches make a call fail (`fail`), the service unreachable (`down`), or the token
 * refused (`refuseTokens`).
 */
export const activitiesApi = {
  calls: [] as { op: ActivitiesOp; id: string | null; body: any; query: string; authorization: string }[],
  activities: new Map<string, { body: any; completedAt: string | null; seq: number | null }>(),
  /** Reject the service JWT with a 401 this many more times. */
  refuseTokens: 0,
  /** Service-token exchanges answered (auth stub). */
  tokenExchanges: 0,
  /** The network is down: fetch rejects. */
  down: false,
  /** An HTTP status to answer instead of the contract, per operation (e.g. `{ put: 503 }`). */
  fail: {} as Partial<Record<ActivitiesOp, number>>,
  /** What the stub answers a meeting notice (`applied` is activities-api's call, not crm-api's). */
  mirrorApplied: true,
  /** Runs when a request reaches the stub, before it answers (e.g. to look at the database at that moment). */
  onCall: null as null | ((call: { op: ActivitiesOp; id: string | null }) => Promise<void>),
  /** Answer 200 with a body that is not the contract's. */
  malformed: false,
  /** `unlinked` of the erase answer. */
  unlinked: 0,
  reset() {
    this.calls = [];
    this.activities.clear();
    this.refuseTokens = 0;
    this.tokenExchanges = 0;
    this.down = false;
    this.fail = {};
    this.mirrorApplied = true;
    this.unlinked = 0;
    this.onCall = null;
    this.malformed = false;
  },
  /** The activities a request body created, in order. */
  puts() {
    return this.calls.filter((c) => c.op === "put");
  },
  of(op: ActivitiesOp) {
    return this.calls.filter((c) => c.op === op);
  },
};

const realFetch = globalThis.fetch;
spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
  const href = String(url);
  const method = init?.method ?? "GET";
  const caller = () => subOf(String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""));

  if (href.endsWith("/authz/app-access-check")) {
    if (identities.down) return new Response("down", { status: 503 });
    const { appId, userId } = JSON.parse(String(init?.body)) as { appId: "crm" | "estimai"; userId: string };
    const eligible = appAccess[appId]?.has(userId) ?? false;
    return Response.json(eligible ? { eligible: true, userId } : { eligible: false });
  }
  if (href.includes("/authz/users/directory")) {
    if (identities.down) return new Response("down", { status: 503 });
    const appId = new URL(href).searchParams.get("appId") as "crm" | "estimai" | null;
    const ids = appId ? [...(appAccess[appId] ?? [])] : [...appAccess.crm];
    return Response.json({
      users: ids.map((id) => ({ id, name: `Name of ${id}`, email: `${id}@welld.test`, entity: "welld_ch" })),
    });
  }
  if (href.endsWith("/system/service-token")) {
    activitiesApi.tokenExchanges++;
    // A process-wide serial, not reset with the world: the provider caches a token across tests.
    return Response.json({ token: `svc-token-${++tokenSerial}`, expiresInSeconds: 300 });
  }
  if (href.startsWith("http://activities.test/")) {
    if (activitiesApi.down) throw new TypeError("fetch failed");
    const url = new URL(href);
    const authorization = String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "");
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let op: ActivitiesOp;
    let id: string | null = null;
    let match: RegExpExecArray | null;
    if ((match = /^\/system\/v1\/activities\/([^/]+)\/completion$/.exec(path))) {
      op = "completion";
      id = decodeURIComponent(match[1]!);
    } else if ((match = /^\/system\/v1\/activities\/([^/]+)$/.exec(path))) {
      op = method === "PUT" ? "put" : "delete";
      id = decodeURIComponent(match[1]!);
    } else if (path === "/system/v1/meeting-mirror") op = "mirror";
    else if ((match = /^\/system\/v1\/contacts\/([^/]+)\/erase$/.exec(path))) {
      op = "erase";
      id = decodeURIComponent(match[1]!);
    } else return Response.json({ status: 404 }, { status: 404 });
    activitiesApi.calls.push({ op, id, body, query: url.search, authorization });
    await activitiesApi.onCall?.({ op, id });
    if (activitiesApi.malformed) return Response.json({ nope: true });

    if (activitiesApi.refuseTokens > 0) {
      activitiesApi.refuseTokens--;
      return Response.json({ status: 401 }, { status: 401 });
    }
    const forced = activitiesApi.fail[op];
    if (forced !== undefined) return Response.json({ status: forced, code: forced === 503 ? "maintenance" : undefined }, { status: forced });

    switch (op) {
      case "put": {
        if (activitiesApi.activities.has(id!)) return Response.json({ id, created: false }, { status: 200 });
        activitiesApi.activities.set(id!, { body, completedAt: null, seq: null });
        return Response.json({ id, created: true }, { status: 201 });
      }
      case "delete": {
        const row = activitiesApi.activities.get(id!);
        if (row && !(url.searchParams.get("onlyIfOpen") === "true" && row.completedAt !== null)) activitiesApi.activities.delete(id!);
        return new Response(null, { status: 204 });
      }
      case "completion": {
        const row = activitiesApi.activities.get(id!);
        if (!row || (row.seq !== null && row.seq >= body.seq)) return Response.json({ applied: false });
        row.seq = body.seq;
        row.completedAt = body.completed ? body.at : null;
        return Response.json({ applied: true });
      }
      case "mirror":
        return Response.json({ applied: activitiesApi.mirrorApplied });
      case "erase":
        return Response.json({ unlinked: activitiesApi.unlinked });
    }
  }
  if (href.startsWith("http://estimai.test/")) {
    if (estimai.down) return new Response("down", { status: 503 });
    if (estimai.forbidden.has(caller())) return Response.json({ status: 403 }, { status: 403 });
    const path = new URL(href).pathname;
    if (method === "POST" && path === "/estimates") {
      const body = JSON.parse(String(init?.body)) as { name: string; content: unknown };
      const id = `est-${estimai.estimates.size + 1}-${crypto.randomUUID().slice(0, 6)}`;
      const name = estimai.createdName ?? body.name;
      estimai.estimates.set(id, { id, name, owner: caller(), content: body.content, editors: [] });
      return Response.json({ id, name }, { status: 201 });
    }
    const match = /^\/estimates\/([^/]+)(\/collaborators)?$/.exec(path);
    const estimate = match ? estimai.estimates.get(decodeURIComponent(match[1]!)) : undefined;
    if (!estimate) return Response.json({ status: 404 }, { status: 404 });
    if (match![2] && method === "POST") {
      if (estimai.shareStatus !== 201) return Response.json({ status: estimai.shareStatus }, { status: estimai.shareStatus });
      estimate.editors.push((JSON.parse(String(init?.body)) as { email: string }).email);
      return Response.json({}, { status: 201 });
    }
    if (method === "DELETE") {
      estimai.estimates.delete(estimate.id);
      estimai.deletes.push(estimate.id);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") return Response.json({ id: estimate.id, name: estimate.name, content: estimate.content });
  }
  if (href.endsWith("/authz/users/identities")) {
    identities.calls++;
    if (identities.down) return new Response("down", { status: 503 });
    const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
    return Response.json({
      users: ids.map((id) =>
        id === "user-gone"
          ? { id, status: "deleted", name: null }
          : id.startsWith("user-")
            ? { id, status: "active", name: `Name of ${id}` }
            : { id, status: "unknown", name: null },
      ),
    });
  }
  return realFetch(url as string, init);
}) as typeof fetch);

// ─── Requests ────────────────────────────────────────────────────────────────

export interface CallOptions {
  readonly as?: PersonaName | null;
  readonly body?: unknown;
  /** A JSON text sent as it is (a body `JSON.stringify` cannot build, such as a very deep one); wins over `body`. */
  readonly rawBody?: string;
  readonly ifMatch?: number | string;
  /** Further request headers (`If-None-Match`, …). */
  readonly headers?: Record<string, string>;
}

export async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  const as = options.as === undefined ? "admin" : options.as;
  if (as) headers["Authorization"] = `Bearer ${await tokenFor(as)}`;
  if (options.body !== undefined || options.rawBody !== undefined) headers["Content-Type"] = "application/json";
  if (options.ifMatch !== undefined) {
    headers["If-Match"] = typeof options.ifMatch === "number" ? `"${options.ifMatch}"` : options.ifMatch;
  }
  Object.assign(headers, options.headers);
  const res = await app.request(path, {
    method,
    headers,
    ...(options.rawBody !== undefined ? { body: options.rawBody } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = text ? JSON.parse(text) : undefined;
  return { status: res.status, json, headers: res.headers };
}

/** An in-memory bucket: what was put, minted and deleted (specs/20261101-crm-sales-flow). */
export const bucket = {
  objects: new Map<string, { bytes: Uint8Array | null; contentType: string; sizeBytes: number }>(),
  deleted: [] as string[],
  /** Keys read through `getObject`, in order (ADR 20261102-crm-api-reads-attachment-bytes-for-offer-annexes: nothing is read before the size check). */
  reads: [] as string[],
  /** The `maxBytes` of the last presigned POST (letterhead 5 MiB, attachments 20 MiB). */
  lastPostMaxBytes: 0,
};
export const memoryStorage: Storage = {
  async mintPresignedPost(objectKey, contentType, maxBytes = 20 * 1024 * 1024) {
    bucket.lastPostMaxBytes = maxBytes;
    return { url: "http://bucket.test/upload", fields: { key: objectKey, "Content-Type": contentType } };
  },
  async getObject(objectKey) {
    bucket.reads.push(objectKey);
    const object = bucket.objects.get(objectKey);
    if (!object?.bytes) throw new Error(`no bytes for ${objectKey}`);
    return object.bytes;
  },
  async headObject(objectKey) {
    const object = bucket.objects.get(objectKey);
    return object ? { sizeBytes: object.sizeBytes, contentType: object.contentType } : null;
  },
  async mintPresignedGet(objectKey) {
    return `http://bucket.test/${objectKey}?signed`;
  },
  async putObject(objectKey, bytes, contentType) {
    bucket.objects.set(objectKey, { bytes, contentType, sizeBytes: bytes.byteLength });
  },
  async deleteObject(objectKey) {
    bucket.objects.delete(objectKey);
    bucket.deleted.push(objectKey);
  },
};

export async function resetWorld(): Promise<void> {
  resetRegistry();
  estimaiVersions.clear();
  activitiesApi.reset();
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "offer_template", "offer_sequence", "deal_offer", "deal_attachment", "deal_estimate", "entity_profile", "deal", "contact", "company" RESTART IDENTITY CASCADE',
  );
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  identities.down = false;
  identities.calls = 0;
  resetAppAccess();
  estimai.estimates.clear();
  estimai.forbidden.clear();
  estimai.shareStatus = 201;
  estimai.down = false;
  estimai.deletes = [];
  estimai.createdName = null;
  bucket.objects.clear();
  bucket.deleted = [];
  bucket.reads = [];
  bucket.lastPostMaxBytes = 0;
  setStorageForTests(memoryStorage);
}

/** Creates a company through the API and returns its body. */
export async function makeCompany(overrides: Record<string, unknown> = {}, as: PersonaName = "admin") {
  const res = await call("POST", "/companies", {
    as,
    body: { name: `Acme ${crypto.randomUUID().slice(0, 8)}`, status: "prospect", entity: "welld_ch", ...overrides },
  });
  if (res.status !== 201) throw new Error(`makeCompany: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/**
 * Links a ready estimate to a deal straight in the database, for tests about
 * something other than the estimate flow (specs/20261101-crm-sales-flow gate, AC-3.4).
 */
export async function markEstimateReady(dealId: string, technicalUserId = "user-tech") {
  const now = new Date();
  await db.dealEstimate.upsert({
    where: { dealId },
    create: {
      dealId,
      estimateId: `est-fixture-${dealId}`,
      estimateName: "Fixture estimate",
      technicalUserId,
      state: "ready",
      requestedBy: "user-admin",
      readyBy: technicalUserId,
      readyAt: now,
    },
    update: { state: "ready", readyBy: technicalUserId, readyAt: now },
  });
}

/** The EstimAI version each fixture estimate is at: a notice carries the next one. */
const estimaiVersions = new Map<string, number>();

/**
 * What estimai-api sends when the deal's estimate is closed or reopened in EstimAI
 * (specs/20261101-crm-sales-flow AC-3.3): `POST /system/estimate-notices` with its service JWT.
 */
export async function estimaiNotice(
  dealId: string,
  event: "closed" | "reopened" = "closed",
  options: { by?: string; version?: number; sub?: string; scope?: string } = {},
) {
  const link = await db.dealEstimate.findUniqueOrThrow({ where: { dealId } });
  const version = options.version ?? (estimaiVersions.get(link.estimateId) ?? 1) + 1;
  estimaiVersions.set(link.estimateId, Math.max(version, estimaiVersions.get(link.estimateId) ?? 0));
  const token = await harness.signServiceToken({
    sub: options.sub ?? "system:estimai-api",
    scope: options.scope ?? "notifications.push estimate-notices.send",
  });
  const res = await app.request("/system/estimate-notices", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ estimateId: link.estimateId, event, version, at: new Date().toISOString(), byUserId: options.by ?? "user-tech" }),
  });
  return { status: res.status };
}

/** A service JWT of another shape, for the credential tests. */
export const signServiceToken = (options: { sub: string; scope: string; audience?: string }) => harness.signServiceToken(options);

export async function makeDeal(companyId: string, overrides: Record<string, unknown> = {}, as: PersonaName = "admin") {
  const res = await call("POST", "/deals", {
    as,
    body: { companyId, title: "Platform rebuild", amountCents: 10_000_00, currency: "CHF", ...overrides },
  });
  if (res.status !== 201) throw new Error(`makeDeal: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/**
 * The generate body a dialog would send after loading the draft of `templateName`
 * (specs/20261102-crm-offer-document): the entity's seeded templates are listed, the draft fetched, the
 * draft's fields mapped onto the body, and `overrides` applied last.
 */
export async function offerBody(
  dealId: string,
  entity: "welld_ch" | "welld_it",
  templateName: string,
  overrides: Record<string, unknown> = {},
  as: PersonaName = "admin",
) {
  const list = await call("GET", `/offer-templates?entity=${entity}`, { as });
  const template = list.json.items.find((t: { name: string }) => t.name === templateName);
  if (!template) throw new Error(`offerBody: no template "${templateName}"`);
  const res = await call("GET", `/deals/${dealId}/offers/draft?templateId=${template.id}`, { as });
  if (res.status !== 200) throw new Error(`offerBody: draft ${res.status} ${JSON.stringify(res.json)}`);
  const d = res.json;
  return {
    templateId: d.templateId,
    salutation: d.salutation,
    clientLines: d.clientLines,
    opening: d.opening,
    sections: d.sections,
    costColumns: d.costColumns,
    showTotal: d.showTotal,
    costLines: d.costLines.map((l: { description: string; kind: string; unitCents: number | null; percentBp: number | null; quantity: number }) => ({
      description: l.description,
      kind: l.kind,
      ...(l.unitCents !== null ? { unitCents: l.unitCents } : {}),
      ...(l.percentBp !== null ? { percentBp: l.percentBp } : {}),
      quantity: l.quantity,
    })),
    acceptanceLabel: d.acceptanceLabel,
    annex: d.annex,
    validityDays: d.validityDays,
    aiAssisted: d.aiAssisted,
    ...overrides,
  };
}

// ─── Wizard templates (specs/20261115-crm-offer-wizard) ──────────────────────

/** The smallest wizard template text that parses with no problem at all. */
export const WIZARD_SOURCE = [
  "@@salutation To",
  "",
  "Dear client.",
  "",
  "## COSTS",
  "@@step costs",
  "@@costs",
  "@@line work one_off | Work | unit=deal | qty=1",
  "@@total **TOTAL**",
  "@@end",
  "",
].join("\n");

/** A valid `POST /offer-templates` body for a wizard template; `overrides` are applied last. */
export const wizardBody = (overrides: Record<string, unknown> = {}) => ({
  entity: "welld_ch",
  name: "Wizard",
  language: "it",
  description: "A wizard template",
  uses: ["Fixed price"],
  source: WIZARD_SOURCE,
  ...overrides,
});

/** Creates a wizard template through the API and returns its body (throws unless 201). */
export async function makeWizardTemplate(overrides: Record<string, unknown> = {}, as: PersonaName = "admin") {
  const res = await call("POST", "/offer-templates", { as, body: wizardBody(overrides) });
  if (res.status !== 201) throw new Error(`makeWizardTemplate: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

// ─── Offers (specs/20261115-crm-offer-wizard T28) ────────────────────────────

/** The letterhead data an entity needs before it can generate an offer (018 AC-2.1). */
export const ENTITY_PROFILE = {
  legalName: "wellD SA",
  addressLines: ["Via Example 1", "6900 Lugano"],
  vatNumber: "CHE-123.456.789 MWST",
  iban: "CH00 0000 0000 0000 0000 0",
  offerTermsEn: "Payment within 30 days.",
  offerTermsIt: "Pagamento a 30 giorni.",
};

// ─── The legal entities registry (specs/20261117-legal-entities T26) ──────────────────────────────────────

/**
 * The legal entities registry as the document paths see it: the fake client of `fakeRegistry.ts`, standing in for the wired
 * `legalEntities` of crm-api in every test that imports this world (the issuer's legal name, address, VAT number and IBAN come
 * from it, never from the CRM's columns). `resetWorld()` puts both entities back to the complete defaults of `ENTITY_PROFILE`
 * (`wellD SA` / `wellD Srl`); a test changes one with `registry.set(...)` (`incompleteEntity`, `completeEntity`) or turns the
 * registry off with `registry.unavailable()`.
 */
export const registry = fakeRegistryClient();
spyOn(legalEntities, "all").mockImplementation(() => registry.all());
spyOn(legalEntities, "get").mockImplementation((entity) => registry.get(entity));
spyOn(legalEntities, "invalidate").mockImplementation(() => registry.invalidate());

/** The complete details the world's issuers have by default: `ENTITY_PROFILE`'s values (the address is the same in both languages). */
export function worldIssuer(entity: "welld_ch" | "welld_it") {
  return completeEntity(entity, {
    legalName: entity === "welld_it" ? "wellD Srl" : ENTITY_PROFILE.legalName,
    address: { it: [...ENTITY_PROFILE.addressLines], en: [...ENTITY_PROFILE.addressLines] },
    vatNumber: ENTITY_PROFILE.vatNumber,
    iban: ENTITY_PROFILE.iban.replace(/\s/g, ""),
    ibanPrint: ENTITY_PROFILE.iban,
    contacts: { it: "", en: "" },
    complete: true,
    missing: [],
    invalid: [],
  });
}

function resetRegistry(): void {
  registry.unavailable(false);
  registry.set(worldIssuer("welld_ch"));
  registry.set(worldIssuer("welld_it"));
}
resetRegistry();


/**
 * Sets the entity's own profile through the API (terms and place of issue; throws unless it lands). The legal details are the
 * registry's, not the profile's (specs/20261117-legal-entities T29, T26): `registry` holds them (`worldIssuer`).
 */
export async function putEntityProfile(entity: "welld_ch" | "welld_it" = "welld_ch") {
  const { legalName: _l, addressLines: _a, vatNumber: _v, iban: _i, ...own } = ENTITY_PROFILE;
  const res = await call("PUT", `/entity-profiles/${entity}`, { as: "admin", body: own });
  if (res.status !== 200) throw new Error(`putEntityProfile: ${res.status} ${JSON.stringify(res.json)}`);
}

/** Writes the retired legal columns of an existing profile, as an operator's SQL would: no document path reads them any more (T26). */
export async function setRetiredLegalColumns(
  entity: "welld_ch" | "welld_it",
  values: { legalName?: string; addressLines?: string[]; vatNumber?: string | null; iban?: string | null },
) {
  await db.entityProfile.update({ where: { entity }, data: values });
}

/**
 * A qualified deal of a company with a full address, whose estimate is ready through the real flow (request,
 * EstimAI document, close notice): Phase 1 = 10 md (Auth), Phase 2 = 20 md (Reports, Billing). It is the deal an
 * offer can be generated for once `putEntityProfile` ran.
 */
export async function makeReadyDeal(overrides: { entity?: "welld_ch" | "welld_it"; title?: string; amountCents?: number | null } = {}) {
  const entity = overrides.entity ?? "welld_ch";
  const company = await makeCompany({
    name: `Acme ${crypto.randomUUID().slice(0, 6)}`,
    entity,
    legalName: "Acme Holding SA",
    street: "Via Roma 1",
    postalCode: "6900",
    city: "Lugano",
    country: "CH",
  });
  const deal = await makeDeal(company.id, {
    stage: "qualified",
    title: overrides.title ?? "Grid analytics",
    amountCents: overrides.amountCents === undefined ? 9_000_050 : overrides.amountCents,
    entity,
  });
  await call("POST", `/deals/${deal.id}/estimate`, { as: "admin", body: { technicalUserId: "user-tech" } });
  const estimate = [...estimai.estimates.values()].at(-1)!;
  const act = (id: string, epic: string, md: number, release: string) => ({ id, epic, o: md, ml: md, p: md, release });
  estimate.content = {
    params: { aiGain: 0.3 },
    releases: [
      { id: "r1", name: "Phase 1" },
      { id: "r2", name: "Phase 2" },
    ],
    acts: [act("1", "Auth", 10, "Phase 1"), act("2", "Reports", 12, "Phase 2"), act("3", "Billing", 8, "Phase 2")],
  };
  await estimaiNotice(deal.id);
  return { deal, company };
}

/**
 * Inserts an offer row straight in the database with the given snapshot — for the origins no route makes any more:
 * a 018-summary `OF-…` offer (no `kind`), or a wizard offer (a contract snapshot with a `wizard` member).
 */
export async function insertOfferRow(dealId: string, snapshot: Record<string, unknown>, over: { number?: number; language?: "en" | "it"; sent?: boolean } = {}) {
  return db.dealOffer.create({
    data: {
      dealId,
      number: over.number ?? 1,
      language: over.language ?? "it",
      priceCents: 100n,
      currency: "CHF",
      validityDays: 30,
      snapshot: snapshot as object,
      objectKey: `offers/${dealId}/${crypto.randomUUID()}.pdf`,
      sizeBytes: 10,
      createdBy: "user-admin",
      ...(over.sent ? { sentAt: new Date(), sentBy: "user-admin" } : {}),
    },
  });
}

/** A wizard offer's snapshot, as little of it as a list or a legacy guard reads. */
export const wizardOfferSnapshot = (over: Record<string, unknown> = {}) => ({
  kind: "contract",
  template: { id: "template-x", name: "Wizard" },
  language: "it",
  reference: "0001/2026",
  issuedOn: "2026-02-09",
  validUntil: "2026-03-11",
  validityDays: 30,
  costs: { currency: "CHF", columns: { position: true, unit: false }, showTotal: true, lines: [], oneOffCents: 100, yearlyCents: 0 },
  annex: null,
  aiAssisted: false,
  wizard: { templateVersion: 1, answers: {} },
  ...over,
});

// ─── Offer drafts (specs/20261115-crm-offer-wizard T29) ──────────────────────

/**
 * A wizard template whose fields take what the estimate gives (epics, phases, timeline, man-days, the deal) and a
 * `default: today` date, with a per-release cost line beside a deal-amount line: what a draft's first answers are made of.
 */
export const DRAFT_SOURCE = [
  "@@salutation Spett.le",
  "",
  "Offerta per **[CLIENTE]**, progetto [PROGETTO], data [DATA_OFFERTA].",
  "",
  "## OGGETTO",
  "@@step scope",
  "Epiche: [EPICI]",
  "",
  "Fasi: [FASI]",
  "",
  "Tempi: [TEMPI]",
  "",
  "Giorni: [GIORNI]",
  "",
  "## COSTI",
  "@@step costs",
  "@@costs",
  "@@line fasi one_off | Fase | unit=perRelease | qty=1",
  "@@line giorni one_off | Giornate | unit=deal | qty=1",
  "@@total **TOTALE**",
  "@@end",
  "",
  "@@field CLIENTE",
  "source: client",
  "",
  "@@field PROGETTO",
  "source: deal",
  "",
  "@@field EPICI",
  "label: Epiche",
  "kind: longtext",
  "source: epics",
  "",
  "@@field FASI",
  "label: Fasi",
  "kind: longtext",
  "source: phases",
  "",
  "@@field TEMPI",
  "label: Tempi",
  "kind: longtext",
  "source: timeline",
  "",
  "@@field GIORNI",
  "label: Giorni",
  "source: manDays",
  "",
  "@@field DATA_OFFERTA",
  "label: Data offerta",
  "kind: date",
  "default: today",
  "",
].join("\n");

/** Both entities' letterheads, and a deal that can have an offer generated (`makeReadyDeal`). */
export async function readyDealWithProfiles(overrides: Parameters<typeof makeReadyDeal>[0] = {}) {
  await putEntityProfile("welld_ch");
  await putEntityProfile("welld_it");
  return makeReadyDeal(overrides);
}

/** Creates a wizard template of `DRAFT_SOURCE` (or `source`) for the entity and language. */
export const makeDraftTemplate = (overrides: Record<string, unknown> = {}) =>
  makeWizardTemplate({ name: `Draft ${crypto.randomUUID().slice(0, 6)}`, source: DRAFT_SOURCE, ...overrides });

/** A stored PDF attachment row of a deal (the bytes are in the in-memory bucket when `bytes` is given). */
export async function storedPdfAttachment(dealId: string, fileName = "brochure.pdf", bytes?: Uint8Array) {
  const objectKey = `attachments/${dealId}/${crypto.randomUUID()}.pdf`;
  if (bytes) bucket.objects.set(objectKey, { bytes, contentType: "application/pdf", sizeBytes: bytes.byteLength });
  return db.dealAttachment.create({
    data: { dealId, fileName, contentType: "application/pdf", sizeBytes: bytes?.byteLength ?? 1000, objectKey, status: "stored", uploadedBy: "user-admin" },
  });
}
