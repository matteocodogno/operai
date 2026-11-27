/**
 * Test world for activities-api route tests (specs/20261110-activities): a request helper over
 * the ASSEMBLED app with a signed-in persona, the scriptable crm and projects test hosts
 * behind the REAL registry and resolve client (hosts.ts), a stub of the two `auth` endpoints
 * the routes call (identities, app-access-check), and a reset between tests.
 *
 * The environment is set by the `bun test` preload (./env.ts) before this module, or
 * anything it imports, reads `src/lib/env`.
 */

import { spyOn } from "bun:test";
import { setupTestAuth } from "./testAuth";
import { startTestHosts, type ScriptedEntity } from "./hosts";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { db } = await import("../lib/db");
const { env } = await import("../lib/env");
const { setRegistryForTests } = await import("../hosts/registry");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { setNotifierForTests } = await import("../lib/notify");
const { setStorageForTests } = await import("../lib/storage");

export { app, db, env };

// ─── The hosts ───────────────────────────────────────────────────────────────

/** crm-api and projects-api, scripted per test, reached over real HTTP through the real client. */
export const hosts = startTestHosts();
setRegistryForTests(hosts.registry);

let counter = 0;
const next = (prefix: string) => `${prefix}-${++counter}`;

/** A CRM company the crm host knows (any `crm:access` caller reads it). */
export function makeCompany(label = "Acme SA", extra: Partial<ScriptedEntity> = {}) {
  const id = next("co");
  hosts.crm.setEntity(id, { label, href: `/crm/companies/${id}`, ...extra });
  return { id, name: label };
}

/** A contact of `companyId`, as the crm host reports it among the company's related records. */
export function makeContact(companyId: string, name = "Ada Rossi") {
  const id = next("ct");
  hosts.crm.setRelated({ type: "contact", id, parentId: companyId, label: name, href: `/crm/contacts/${id}` });
  return { id, name };
}

export function makeDeal(companyId: string, title = "Website relaunch") {
  const id = next("dl");
  hosts.crm.setRelated({ type: "deal", id, parentId: companyId, label: title, href: `/crm/deals/${id}` });
  return { id, title };
}

/**
 * A project the projects host knows. It is writable; its project manager and team are
 * `user-pm` and `user-member`; only `user-manager` and `user-alice` (the default caller) hold
 * the manage capability for it, everyone else reads. Override any of it through `extra`.
 */
export function makeProject(label = "Smart meter rollout", extra: Partial<ScriptedEntity> = {}) {
  const id = next("pr");
  hosts.projects.setEntity(id, {
    label,
    href: `/projects/${id}`,
    assignees: ["user-pm", "user-member"],
    may: { write: false, manage: false },
    mayFor: { "user-manager": { write: true, manage: true }, "user-alice": { write: true, manage: true } },
    ...extra,
  });
  return { id, name: label };
}

// ─── auth stub: identities and app access ────────────────────────────────────
// Ids starting with "user-" are active people, "user-gone" is deleted, any other id is unknown.
// `authStub.down` simulates an auth outage.

// `onAccessCheck` runs when an app-access-check arrives and BEFORE it answers: a test uses it to
// make that step slow and do something else (an erasure) while a write is mid-validation.
export const authStub = {
  down: false,
  identityCalls: 0,
  /** R13 b: keeps every `POST /authz/users/identities` unanswered until it settles (and, after it, `identityDelayMs` more). */
  identityHold: null as Promise<void> | null,
  identityDelayMs: 0,
  accessChecks: [] as { appId: string; userId: string }[],
  onAccessCheck: null as (() => Promise<void>) | null,
  /** The `redirect` mode of every call to auth, in order: a forwarded Bearer must never follow one. */
  redirects: [] as (RequestInit["redirect"] | undefined)[],
};

/** auth's app access, for `POST /authz/app-access-check`. Tests may edit both sets. */
export const appAccess = { crm: new Set<string>(), projects: new Set<string>() };
function resetAppAccess(): void {
  appAccess.crm = new Set(["user-alice", "user-bob", "user-consultant", "user-colleague", "user-tech", "user-admin"]);
  appAccess.projects = new Set(["user-alice", "user-bob", "user-pm", "user-member", "user-manager", "user-viewer", "user-admin"]);
}
resetAppAccess();

const realFetch = globalThis.fetch;
spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
  const href = String(url);
  if (href.startsWith(env.AUTH_BASE_URL)) {
    authStub.redirects.push(init?.redirect);
    if (authStub.down) return new Response("down", { status: 503 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { ids?: string[]; appId?: "crm" | "projects"; userId?: string };
    if (href.endsWith("/authz/app-access-check")) {
      authStub.accessChecks.push({ appId: body.appId!, userId: body.userId! });
      await authStub.onAccessCheck?.();
      const eligible = appAccess[body.appId!]?.has(body.userId!) ?? false;
      return Response.json(eligible ? { eligible: true, userId: body.userId } : { eligible: false });
    }
    if (href.endsWith("/authz/users/identities")) {
      authStub.identityCalls++;
      if (authStub.identityHold) await authStub.identityHold;
      if (authStub.identityDelayMs > 0) await new Promise<void>((done) => setTimeout(done, authStub.identityDelayMs));
      return Response.json({
        users: (body.ids ?? []).map((id) =>
          id === "user-gone"
            ? { id, status: "deleted", name: null }
            : id.startsWith("user-")
              ? { id, status: "active", name: `Name of ${id}` }
              : { id, status: "unknown", name: null },
        ),
      });
    }
  }
  return realFetch(url as string, init);
}) as typeof fetch);

// ─── Personas and requests ───────────────────────────────────────────────────

export interface Persona {
  readonly sub: string;
}

/** The callers every test file uses. */
export const PERSONAS = {
  alice: { sub: "user-alice" },
  bob: { sub: "user-bob" },
  // CRM (specs/20261101-crm personas): all hold crm access.
  consultant: { sub: "user-consultant" },
  colleague: { sub: "user-colleague" },
  tech: { sub: "user-tech" },
  admin: { sub: "user-admin" },
  // Active, but with access to neither tool.
  outsider: { sub: "user-outsider" },
  // Projects: its manager, a team member, another manager, and a reader who manages nothing.
  pm: { sub: "user-pm" },
  member: { sub: "user-member" },
  manager: { sub: "user-manager" },
  viewer: { sub: "user-viewer" },
} satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;

const tokens = new Map<string, string>();
async function tokenFor(name: PersonaName): Promise<string> {
  const cached = tokens.get(name);
  if (cached) return cached;
  const token = await harness.signToken({ sub: PERSONAS[name].sub, email: `${name}@welld.test`, name: `Name of ${name}` });
  tokens.set(name, token);
  return token;
}

export interface CallOptions {
  /** A persona, or null for no Authorization header. Default alice. */
  readonly as?: PersonaName | null;
  readonly body?: unknown;
}

export async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  const as = options.as === undefined ? "alice" : options.as;
  if (as) headers["Authorization"] = `Bearer ${await tokenFor(as)}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
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

/** The Authorization header a persona's request carries, for asserting what a host received. */
export async function bearerOf(name: PersonaName): Promise<string> {
  return `Bearer ${await tokenFor(name)}`;
}

/** Runs `fn` with the maintenance switch on and puts it back afterwards, whatever happens. */
export async function withMaintenance<T>(fn: () => Promise<T>): Promise<T> {
  const before = env.ACTIVITIES_MAINTENANCE;
  env.ACTIVITIES_MAINTENANCE = true;
  try {
    return await fn();
  } finally {
    env.ACTIVITIES_MAINTENANCE = before;
  }
}

/** Puts the world back to its start: the tables (children first), the hosts, the auth stub and the switches. */
export async function resetWorld(): Promise<void> {
  await db.activityFile.deleteMany();
  await db.taskBlocker.deleteMany();
  await db.activityParticipant.deleteMany();
  await db.meetingMirrorState.deleteMany();
  await db.activity.deleteMany();
  await db.erasedContact.deleteMany();
  env.ACTIVITIES_MAINTENANCE = false;
  hosts.reset();
  // An active user with access to neither tool reads nothing from either host.
  hosts.crm.setReader("user-outsider", false);
  hosts.projects.setReader("user-outsider", false);
  // Another test file may have swapped the registry; the routes must see the test hosts.
  setRegistryForTests(hosts.registry);
  authStub.down = false;
  authStub.onAccessCheck = null;
  authStub.redirects.length = 0;
  authStub.identityCalls = 0;
  authStub.identityHold = null;
  authStub.identityDelayMs = 0;
  authStub.accessChecks.length = 0;
  resetAppAccess();
  __resetIdentityCacheForTests();
  setNotifierForTests(null);
  setStorageForTests(null);
}
