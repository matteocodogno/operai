/**
 * Test world for projects-api route tests (specs/021-projects): personas with literal
 * permission sets, a request helper over the ASSEMBLED app, fakes for the three things
 * outside the system (auth's identity and app-access endpoints, auth's service-token
 * endpoint, crm-api's `/system/companies`), and a reset between tests.
 *
 * The environment is set by the `bun test` preload (./env.ts) before this module, or
 * anything it imports, reads `src/lib/env`.
 */

import { spyOn } from "bun:test";
import { setupTestAuth } from "./testAuth";
import { TEST_CRM_URL } from "./env";
import type { ResolvedPermission } from "../authz/resolveClient";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");

export { app };

/** Forgets cached display names (60 s cache), so the next read asks `auth` again. */
export const forgetIdentities = () => __resetIdentityCacheForTests();

const ENTITY_COND = { attributes: [{ key: "entity", match: "user" }] } as const;
const ACCESS: ResolvedPermission = { resource: "projects", action: "access", conditions: null };
const MANAGE = (scoped: boolean): ResolvedPermission => ({
  resource: "project",
  action: "manage",
  conditions: scoped ? ENTITY_COND : null,
});
const BEXIO: ResolvedPermission = { resource: "contract", action: "bexio", conditions: null };

export interface Persona {
  readonly sub: string;
  readonly entity: string | null;
  readonly permissions: readonly ResolvedPermission[];
}

/** The callers every test file uses. Scopes are literals, not computed by the code under test. */
export const PERSONAS = {
  /** No grant of the module at all (an `employee`). */
  outsider: { sub: "user-outsider", entity: "welld_ch", permissions: [] },
  /** `projects:access` only: reads everything, manages nothing. */
  viewer: { sub: "user-viewer", entity: "welld_ch", permissions: [ACCESS] },
  /** A second reader, for concurrency and "someone else" checks. */
  colleague: { sub: "user-colleague", entity: "welld_it", permissions: [ACCESS] },
  /** `project-manager` in wellD CH: manages welld_ch projects only. */
  pmCh: { sub: "user-pm-ch", entity: "welld_ch", permissions: [ACCESS, MANAGE(true)] },
  /** `sales` in wellD IT: manages welld_it projects only. */
  salesIt: { sub: "user-sales-it", entity: "welld_it", permissions: [ACCESS, MANAGE(true)] },
  /** `accounting`: reads, and writes the Bexio order id; manages nothing. */
  accounting: { sub: "user-accounting", entity: "welld_ch", permissions: [ACCESS, BEXIO] },
  /** Admin: everything, both entities. */
  admin: { sub: "user-admin", entity: null, permissions: [ACCESS, MANAGE(false), BEXIO] },
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
  const token = await harness.signToken({ sub: PERSONAS[name].sub, email: `${name}@welld.test`, name: `Name of ${name}` });
  tokens.set(name, token);
  return token;
}

// ─── auth stubs ──────────────────────────────────────────────────────────────
// Identities: ids starting with "user-" are active people; "user-gone" is deleted; any
// other id is unknown. `identities.down` simulates an auth outage for the identity and
// app-access routes; `authSystem.down` for the service-token exchange.

export const identities = { down: false, calls: 0 };
export const authSystem = { down: false, tokenCalls: 0 };

/** Ids auth reports as holding `projects:access` (POST /authz/app-access-check, ADR-0055). Tests may edit it. */
export const appAccess = { projects: new Set<string>() };
function resetAppAccess(): void {
  appAccess.projects = new Set(
    Object.values(PERSONAS)
      .filter((p) => p.permissions.some((perm) => perm.resource === "projects" && perm.action === "access"))
      .map((p) => p.sub),
  );
}
resetAppAccess();

/** The service JWT the fake auth mints, and the only one the fake crm-api accepts. */
export const SERVICE_JWT = "service-jwt-for-projects-api";

/**
 * A fake crm-api `GET /system/companies` (specs/021 T2 contract): `q` is a case-insensitive
 * substring over non-archived names, `ids` are comma-separated and include archived ones,
 * `limit` defaults to 20, or to `ids.length` when only `ids` is given.
 */
export interface FakeCompany {
  readonly id: string;
  readonly name: string;
  readonly entity: "welld_ch" | "welld_it";
  readonly archived: boolean;
}
export const crm = { companies: [] as FakeCompany[], down: false, calls: 0, lastAuthorization: "" };

function fakeCrmCompanies(url: URL, authorization: string): Response {
  crm.calls++;
  crm.lastAuthorization = authorization;
  if (crm.down) return new Response("down", { status: 503 });
  if (authorization !== `Bearer ${SERVICE_JWT}`) return Response.json({ status: 401 }, { status: 401 });
  const q = url.searchParams.get("q")?.toLowerCase();
  const ids = url.searchParams.get("ids")?.split(",");
  const limit = Number(url.searchParams.get("limit") ?? (ids ? ids.length : 20));
  const items = crm.companies
    .filter((company) => (ids ? ids.includes(company.id) : true))
    .filter((company) => (q !== undefined ? !company.archived && company.name.toLowerCase().includes(q) : true))
    .slice(0, limit)
    .map(({ id, name, entity, archived }) => ({ id, name, entity, archived }));
  return Response.json({ items });
}

const realFetch = globalThis.fetch;
spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
  const href = String(url);
  if (href.endsWith("/authz/app-access-check")) {
    if (identities.down) return new Response("down", { status: 503 });
    const { appId, userId } = JSON.parse(String(init?.body)) as { appId: string; userId: string };
    const eligible = appId === "projects" && appAccess.projects.has(userId);
    return Response.json(eligible ? { eligible: true, userId } : { eligible: false });
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
  if (href.endsWith("/system/service-token")) {
    authSystem.tokenCalls++;
    if (authSystem.down) return new Response("down", { status: 503 });
    return Response.json({ token: SERVICE_JWT, expiresInSeconds: 300 });
  }
  if (href.startsWith(`${TEST_CRM_URL}/system/companies`)) {
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return fakeCrmCompanies(new URL(href), authorization);
  }
  return realFetch(url as string, init);
}) as typeof fetch);

// ─── Requests ────────────────────────────────────────────────────────────────

export interface CallOptions {
  readonly as?: PersonaName | null;
  readonly body?: unknown;
  readonly ifMatch?: number | string;
}

export async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  const as = options.as === undefined ? "admin" : options.as;
  if (as) headers["Authorization"] = `Bearer ${await tokenFor(as)}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.ifMatch !== undefined) {
    headers["If-Match"] = typeof options.ifMatch === "number" ? `"${options.ifMatch}"` : options.ifMatch;
  }
  const res = await app.request(path, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = text ? JSON.parse(text) : undefined;
  return { status: res.status, json, headers: res.headers };
}

/** Puts the world back to its start: caches, switches and fakes. The data model arrives with T4. */
export async function resetWorld(): Promise<void> {
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  identities.down = false;
  identities.calls = 0;
  authSystem.down = false;
  authSystem.tokenCalls = 0;
  resetAppAccess();
  crm.companies = [];
  crm.down = false;
  crm.calls = 0;
  crm.lastAuthorization = "";
}
