/**
 * Test world for projects-api route tests (specs/20261103-projects): personas with literal
 * permission sets, a request helper over the ASSEMBLED app, fakes for the things outside the
 * system (auth's identity and app-access endpoints, auth's service-token endpoint, auth's
 * `GET /authz/users/holders`, crm-api's `/system/companies`, `/system/deals` and `/system/contacts`,
 * estimai-api's `/system/estimates/{id}/summary`; all but the first three are specs/20261103-projects-handoff), and a
 * reset between tests. Every contact in here is synthetic (T18 L2).
 *
 * The environment is set by the `bun test` preload (./env.ts) before this module, or
 * anything it imports, reads `src/lib/env`.
 */

import { spyOn } from "bun:test";
import { setupTestAuth } from "./testAuth";
import { TEST_CRM_URL, TEST_ESTIMAI_URL, TEST_ISSUER } from "./env";
import type { ResolvedPermission } from "../authz/resolveClient";
import type { Prisma } from "../lib/generated/prisma/client";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");
const { advanceTeamsClockForTests, resetTeamReaderForTests } = await import("../lib/teams");
const { advanceTeamLimitersForTests, resetTeamLimiters } = await import("../lib/rateLimiter");

export { app, db };

/** Forgets cached display names (60 s cache), so the next read asks `auth` again. */
export const forgetIdentities = () => __resetIdentityCacheForTests();

const ENTITY_COND = { attributes: [{ key: "entity", match: "user" }] } as const;
const ACCESS: ResolvedPermission = { resource: "projects", action: "access", conditions: null };
const MANAGE = (scoped: boolean): ResolvedPermission => ({
  resource: "project",
  action: "manage",
  conditions: scoped ? ENTITY_COND : null,
});
const BEXIO: ResolvedPermission = { resource: "purchase-order", action: "bexio", conditions: null };
const TAKE = (scoped: boolean): ResolvedPermission => ({
  resource: "handoff",
  action: "take",
  conditions: scoped ? ENTITY_COND : null,
});
const RECEIVE = (scoped: boolean): ResolvedPermission => ({
  resource: "purchase-order",
  action: "receive",
  conditions: scoped ? ENTITY_COND : null,
});

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
  /** `sales` in wellD IT: manages welld_it projects and takes welld_it deals only. */
  salesIt: { sub: "user-sales-it", entity: "welld_it", permissions: [ACCESS, MANAGE(true), TAKE(true)] },
  /** `sales` in wellD CH: manages welld_ch projects and takes welld_ch deals only (specs/20261103-projects-handoff T24). */
  salesCh: { sub: "user-sales-ch", entity: "welld_ch", permissions: [ACCESS, MANAGE(true), TAKE(true)] },
  /** `ops-manager` in wellD CH: manages welld_ch projects and may receive its purchase orders; takes nothing. */
  opsCh: { sub: "user-ops", entity: "welld_ch", permissions: [ACCESS, MANAGE(true), RECEIVE(true)] },
  /** `accounting`: reads, and writes the Bexio order id; manages nothing. */
  accounting: { sub: "user-accounting", entity: "welld_ch", permissions: [ACCESS, BEXIO] },
  /** Admin: everything, both entities. */
  admin: { sub: "user-admin", entity: null, permissions: [ACCESS, MANAGE(false), BEXIO, TAKE(false), RECEIVE(false)] },
} satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;

const subOf = (authorizationHeader: string): string => {
  const payload = authorizationHeader.slice("Bearer ".length).split(".")[1] ?? "";
  return (JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { sub: string }).sub;
};

/**
 * The fake `GET /authz/resolve` (R13 a). Every call is counted and its Authorization header kept; `hold` keeps a call
 * unanswered until it settles, `delayMs` delays every call, `fail` makes the answer a failure (both after the hold).
 * `resetWorld()` puts it back.
 */
export const authzFake = {
  calls: 0,
  headers: [] as string[],
  hold: null as Promise<void> | null,
  delayMs: 0,
  fail: false,
};

const personaResolve = async (authorizationHeader: string) => {
  authzFake.calls++;
  authzFake.headers.push(authorizationHeader);
  if (authzFake.hold) await authzFake.hold;
  if (authzFake.delayMs > 0) await new Promise<void>((done) => setTimeout(done, authzFake.delayMs));
  if (authzFake.fail) throw new Error("auth is down");
  const sub = subOf(authorizationHeader);
  const persona = Object.values(PERSONAS).find((p) => p.sub === sub);
  if (!persona) throw new Error(`no persona for ${sub}`);
  return { sub, epoch: 0, permissions: persona.permissions, entity: persona.entity, jobTitle: null };
};
harness.setResolve(personaResolve);

/**
 * Puts the persona fake back as the process's `GET /authz/resolve` (the harness's resolve is process-wide and some test files
 * swap it for their own fixture). Call it in the `beforeEach` of a test that drives `authzFake`.
 */
export const installAuthzFake = (): void => harness.setResolve(personaResolve);

const tokens = new Map<string, string>();
/** The `Authorization` header value `call()` sends for a persona: what a fake can compare a forwarded header with. */
export const bearerFor = async (name: PersonaName): Promise<string> => `Bearer ${await tokenFor(name)}`;
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

/** Ids auth reports as holding `projects:access` (POST /authz/app-access-check, ADR 20261101-app-access-check-by-user-id-and-directory-app-filter). Tests may edit it. */
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
 * A fake crm-api `GET /system/companies` (specs/20261103-projects T2 contract): `q` is a case-insensitive
 * substring over non-archived names, `ids` are comma-separated and include archived ones,
 * `limit` defaults to 20, or to `ids.length` when only `ids` is given.
 */
export interface FakeCompany {
  readonly id: string;
  readonly name: string;
  readonly entity: "welld_ch" | "welld_it";
  readonly archived: boolean;
}

export type FakeDealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

/**
 * A CRM deal as the fake `GET /system/deals` knows it (specs/20261103-projects-handoff T3 contract). `wonAt` is when it
 * was won; the fake reports it only while `stage` is `won`, as crm-api does, so a test reopens a
 * deal by setting `stage` and wins it again by setting it back.
 */
export interface FakeDeal {
  id: string;
  title: string;
  stage: FakeDealStage;
  entity: "welld_ch" | "welld_it";
  company: { id: string; name: string };
  wonAt: string;
  estimate: { id: string; name: string } | null;
  /** specs/20261101-crm US-10; absent = what an older crm-api sends (a standard deal). */
  kind?: "standard" | "tender";
}

let dealSeq = 0;
/** A won deal of Acme in wellD CH without an estimate; override what the test cares about. */
export function makeDeal(over: Partial<FakeDeal> = {}): FakeDeal {
  dealSeq++;
  return {
    id: `deal-${dealSeq}`,
    title: `Deal ${dealSeq}`,
    stage: "won",
    entity: "welld_ch",
    company: { id: "co-acme", name: "Acme SA" },
    wonAt: new Date(Date.UTC(2026, 10, 1, 9, 0, 0) + dealSeq * 60_000).toISOString(),
    estimate: null,
    ...over,
  };
}

/** crm-api's cap on `stage=won`; a test lowers `wonLimit` to see `truncated`. */
export const CRM_WON_LIMIT = 500;

export const crm = {
  companies: [] as FakeCompany[],
  deals: [] as FakeDeal[],
  contacts: [] as FakeContact[],
  down: false,
  /** Only `GET /system/contacts` is down (companies and deals still answer). */
  contactsDown: false,
  /** Every request to the fake crm-api, companies, deals and contacts. */
  calls: 0,
  /** The requests to `GET /system/deals` alone. */
  dealCalls: 0,
  /** The requests to `GET /system/contacts` alone. */
  contactCalls: 0,
  wonLimit: CRM_WON_LIMIT,
  lastAuthorization: "",
  /** The query string of the last `GET /system/contacts`. */
  lastContactsQuery: "",
  /**
   * A raw replacement of the `200` body of `GET /system/contacts` (either mode), for a test of what the
   * code does with a CRM that answers something other than what was asked (another id, extra members).
   */
  contactsReply: undefined as unknown,
};

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

/**
 * A fake crm-api `GET /system/deals` (specs/20261103-projects-handoff T3 contract): exactly one of `stage=won` (won deals,
 * newest win first, at most `crm.wonLimit`, `truncated` beyond) or `ids` (those deals in any
 * stage, `wonAt` null unless won). A summary has no amount, currency, owner or notes.
 */
function fakeCrmDeals(url: URL, authorization: string): Response {
  crm.calls++;
  crm.dealCalls++;
  crm.lastAuthorization = authorization;
  if (crm.down) return new Response("down", { status: 503 });
  if (authorization !== `Bearer ${SERVICE_JWT}`) return Response.json({ status: 401 }, { status: 401 });
  const stage = url.searchParams.get("stage");
  const ids = url.searchParams.get("ids")?.split(",");
  if ((stage === null) === (ids === undefined)) return Response.json({ status: 400 }, { status: 400 });
  const summary = (deal: FakeDeal) => ({
    id: deal.id,
    title: deal.title,
    stage: deal.stage,
    entity: deal.entity,
    company: deal.company,
    wonAt: deal.stage === "won" ? deal.wonAt : null,
    estimate: deal.estimate,
    ...(deal.kind ? { kind: deal.kind } : {}),
  });
  if (ids) {
    return Response.json({
      items: ids.flatMap((id) => crm.deals.filter((deal) => deal.id === id).map(summary)),
      truncated: false,
    });
  }
  const won = crm.deals.filter((deal) => deal.stage === "won").sort((a, b) => b.wonAt.localeCompare(a.wonAt));
  return Response.json({ items: won.slice(0, crm.wonLimit).map(summary), truncated: won.length > crm.wonLimit });
}

/**
 * A fake estimai-api `GET /system/estimates/{id}/summary` (specs/20261103-projects-handoff T2 contract): `200 { id, name,
 * manDays }` for a known estimate, `404 estimate_not_found` otherwise. `manDays` is the figure
 * EstimAI would compute; a test sets it and "changes the estimate" by setting it again.
 */
export const estimai = {
  estimates: new Map<string, { name: string; manDays: number }>(),
  down: false,
  calls: 0,
  lastAuthorization: "",
};

function fakeEstimaiSummary(id: string, authorization: string): Response {
  estimai.calls++;
  estimai.lastAuthorization = authorization;
  if (estimai.down) return new Response("down", { status: 503 });
  if (authorization !== `Bearer ${SERVICE_JWT}`) return Response.json({ status: 401 }, { status: 401 });
  const estimate = estimai.estimates.get(id);
  if (!estimate) return Response.json({ status: 404, code: "estimate_not_found" }, { status: 404 });
  return Response.json({ id, name: estimate.name, manDays: estimate.manDays });
}

// ─── auth GET /authz/users/holders (specs/20261103-projects-handoff T20) ───────────────────────────

export interface FakeHolder {
  readonly id: string;
  readonly name: string;
  readonly unconditioned: boolean;
}

/** The ops-manager of wellD CH is the `opsCh` persona; the admin is every entity's candidate. */
const defaultHolders = (): Record<"welld_ch" | "welld_it", FakeHolder[]> => ({
  welld_ch: [
    { id: "user-ops", name: "Olga Ops", unconditioned: false },
    { id: "user-admin", name: "Ada Admin", unconditioned: true },
  ],
  welld_it: [
    { id: "user-ops-it", name: "Ivo Ops", unconditioned: false },
    { id: "user-admin", name: "Ada Admin", unconditioned: true },
  ],
});

/**
 * A fake auth `GET /authz/users/holders` (T20 contract): the user Bearer JWT and a strict query of
 * `resource=purchase-order&action=receive&entity=<welld_ch|welld_it>` (anything else is a `400`),
 * answering `{ users: [{ id, name, unconditioned }] }` in the order of `users[entity]`. `down` answers
 * `503`, `status` any other failure (`403`, `429`), `body` a raw replacement of the answer.
 */
export const holders = {
  users: defaultHolders(),
  down: false,
  status: 200,
  body: undefined as unknown,
  calls: 0,
  lastAuthorization: "",
  lastQuery: "",
};

function fakeHolders(url: URL, authorization: string): Response {
  holders.calls++;
  holders.lastAuthorization = authorization;
  holders.lastQuery = url.search;
  if (holders.down) return new Response("down", { status: 503 });
  if (holders.status !== 200) return Response.json({ status: holders.status }, { status: holders.status });
  const keys = [...url.searchParams.keys()].sort().join(",");
  const entity = url.searchParams.get("entity");
  if (
    keys !== "action,entity,resource" ||
    url.searchParams.get("resource") !== "purchase-order" ||
    url.searchParams.get("action") !== "receive" ||
    (entity !== "welld_ch" && entity !== "welld_it")
  ) {
    return Response.json({ status: 400 }, { status: 400 });
  }
  return Response.json(holders.body !== undefined ? holders.body : { users: holders.users[entity] });
}

// ─── crm-api GET /system/contacts (specs/20261103-projects-handoff T21) ────────────────────────────

/** A CRM contact as the fake knows it. Synthetic people only (T18 L2). */
export interface FakeContact {
  id: string;
  companyId: string | null;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  archived: boolean;
}

let contactSeq = 0;
/** A live contact of Acme; override what the test cares about. */
export function makeContact(over: Partial<FakeContact> = {}): FakeContact {
  contactSeq++;
  return {
    id: `contact-${contactSeq}`,
    companyId: "co-acme",
    firstName: `First${contactSeq}`,
    lastName: `Last${contactSeq}`,
    jobTitle: "Purchasing lead",
    email: `contact${contactSeq}@example.test`,
    phone: "+41 00 000 00 00",
    archived: false,
    ...over,
  };
}

/** crm-api's cap on `ids`; the fake refuses more with a `400`, as the real route does. */
export const CRM_CONTACT_IDS_LIMIT = 20;

/**
 * A fake crm-api `GET /system/contacts` (T21 contract), one shape per mode: `companyId` gives that
 * company's non-archived contacts, last then first name, as `{ id, firstName, lastName, jobTitle }`
 * with `truncated`; `ids` (at most 20) gives `{ id, companyId, firstName, lastName, jobTitle, email,
 * phone, archived }` archived or not, in the order asked, an unknown id absent. Neither or both
 * parameters is a `400`.
 */
function fakeCrmContacts(url: URL, authorization: string): Response {
  crm.calls++;
  crm.contactCalls++;
  crm.lastAuthorization = authorization;
  crm.lastContactsQuery = url.search;
  if (crm.down || crm.contactsDown) return new Response("down", { status: 503 });
  if (authorization !== `Bearer ${SERVICE_JWT}`) return Response.json({ status: 401 }, { status: 401 });
  if (crm.contactsReply !== undefined) return Response.json(crm.contactsReply);
  const companyId = url.searchParams.get("companyId");
  const ids = url.searchParams.get("ids")?.split(",");
  if ((companyId === null) === (ids === undefined)) return Response.json({ status: 400 }, { status: 400 });
  if (ids) {
    if (ids.length > CRM_CONTACT_IDS_LIMIT || ids.some((id) => id.length < 1 || id.length > 64)) {
      return Response.json({ status: 400 }, { status: 400 });
    }
    return Response.json({
      items: ids.flatMap((id) =>
        crm.contacts
          .filter((contact) => contact.id === id)
          .map(({ id, companyId, firstName, lastName, jobTitle, email, phone, archived }) => ({
            id,
            companyId,
            firstName,
            lastName,
            jobTitle,
            email,
            phone,
            archived,
          })),
      ),
    });
  }
  const items = crm.contacts
    .filter((contact) => contact.companyId === companyId && !contact.archived)
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))
    .map(({ id, firstName, lastName, jobTitle }) => ({ id, firstName, lastName, jobTitle }));
  return Response.json({ items, truncated: false });
}

// ─── auth GET /system/teams (specs/20261126-teams T11) ─────────────────────────────────────────────────────────────

/** A member of a fake team. `appAccess` left out follows `appAccess.projects` (the people who hold Projects access). */
export interface FakeTeamMember {
  id: string;
  name?: string;
  /** Default true. A deactivated member is reported with `name: null` and `appAccess: false`, as auth does. */
  active?: boolean;
  appAccess?: boolean;
}

/** A team as the fake auth knows it. Tests edit `teamsAuth.teams` (or the object `makeTeam` returned) in place. */
export interface FakeTeam {
  id: string;
  name: string;
  archived: boolean;
  members: FakeTeamMember[];
}

/** auth's cap on the options answer; the fake returns at most this many with `truncated` beyond. */
export const TEAMS_OPTIONS_LIMIT = 50;
/** auth's cap on `ids`; the fake refuses more with a `400`, as the real route does. */
export const TEAMS_IDS_LIMIT = 50;

/**
 * A fake auth `GET /system/teams` (plan § API contracts), for the service JWT only (`SERVICE_JWT`, anything else is a
 * `401`). `ids` mode: the teams in request order, an unknown id omitted, members by name with deactivated ones last
 * (`name: null`, `appAccess: false`). Options mode (`state=active[&q=]`): active teams, names only; with `q` a literal,
 * case-insensitive substring match ranked exact name, then prefix, then the rest (each by name then id); at most 50 and
 * `truncated` beyond. Anything else is a `400`.
 *
 * Settable: `down` (`503`), `status` (any other failure, e.g. `429`), `body` (a raw replacement of a `200`),
 * `failNext` (the next N requests answer `503`, then it recovers) and `unauthorizedNext` (the next N answer `401`, the
 * way a cached service token that lacks the scope does). Counted: `calls`, `idsCalls`, `optionsCalls`, and every request
 * in `requests` (its mode, `ids` or `q`, and the Authorization header it carried). `resetWorld()` puts all of it back.
 */
export const teamsAuth = {
  teams: new Map<string, FakeTeam>(),
  down: false,
  status: 200,
  body: undefined as unknown,
  failNext: 0,
  unauthorizedNext: 0,
  /** While set, `GET /system/teams` holds its answer until it resolves (specs/20261126-teams D16: a slow auth, not a failing one). */
  hold: null as Promise<void> | null,
  /** Every `GET /system/teams` answers this many ms late (D16). */
  delayMs: 0,
  calls: 0,
  idsCalls: 0,
  optionsCalls: 0,
  requests: [] as { mode: "ids" | "options"; ids: string[]; q: string | null; authorization: string }[],
};

let teamSeq = 0;
/** Registers a team with the fake auth (`teamsAuth.teams`) and returns it: active, named `Team N`, no members. */
export function makeTeam(over: Partial<FakeTeam> = {}): FakeTeam {
  teamSeq++;
  const team: FakeTeam = { id: `team-${teamSeq}`, name: `Team ${teamSeq}`, archived: false, members: [], ...over };
  teamsAuth.teams.set(team.id, team);
  return team;
}

/** Attaches a team to a project, straight in the database (the route that does it is tested in its own file). */
export async function attachTeam(projectId: string, teamId: string): Promise<void> {
  await db.attachedTeam.create({ data: { projectId, teamId } });
}

/** Lets time pass for everything that counts it: the team cache's clock and the team windows' (10 min, 30 s, 60 s…). */
export function advanceTime(ms: number): void {
  advanceTeamsClockForTests(ms);
  advanceTeamLimitersForTests(ms);
}

const strictTeamIds = /^[A-Za-z0-9_-]{1,64}$/;

function fakeAuthTeams(url: URL, authorization: string): Response {
  teamsAuth.calls++;
  const idsParam = url.searchParams.get("ids");
  const state = url.searchParams.get("state");
  const q = url.searchParams.get("q");
  teamsAuth.requests.push({ mode: idsParam !== null ? "ids" : "options", ids: idsParam?.split(",") ?? [], q, authorization });
  if (idsParam !== null) teamsAuth.idsCalls++;
  else teamsAuth.optionsCalls++;
  if (teamsAuth.unauthorizedNext > 0) {
    teamsAuth.unauthorizedNext--;
    return Response.json({ status: 401 }, { status: 401 });
  }
  if (authorization !== `Bearer ${SERVICE_JWT}`) return Response.json({ status: 401 }, { status: 401 });
  if (teamsAuth.failNext > 0) {
    teamsAuth.failNext--;
    return new Response("down", { status: 503 });
  }
  if (teamsAuth.down) return new Response("down", { status: 503 });
  if (teamsAuth.status !== 200) return Response.json({ status: teamsAuth.status }, { status: teamsAuth.status });
  if (teamsAuth.body !== undefined) return Response.json(teamsAuth.body);

  const bad = () => Response.json({ status: 400, code: "validation_failed" }, { status: 400 });
  if ((idsParam === null) === (state === null)) return bad();
  const known = new Set(["ids", "state", "q"]);
  if ([...url.searchParams.keys()].some((key) => !known.has(key))) return bad();

  if (idsParam !== null) {
    if (q !== null) return bad();
    const ids = idsParam.split(",");
    if (ids.length > TEAMS_IDS_LIMIT || new Set(ids).size !== ids.length || ids.some((id) => !strictTeamIds.test(id))) return bad();
    const items = ids.flatMap((id) => {
      const team = teamsAuth.teams.get(id);
      if (!team) return [];
      const members = team.members
        .map((member) => {
          const active = member.active !== false;
          return {
            id: member.id,
            name: active ? (member.name ?? `Name of ${member.id}`) : null,
            active,
            appAccess: active && (member.appAccess ?? appAccess.projects.has(member.id)),
          };
        })
        .sort((a, b) => Number(b.active) - Number(a.active) || (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id));
      return [{ id: team.id, name: team.name, archived: team.archived, members }];
    });
    return Response.json({ items });
  }

  if (state !== "active") return bad();
  const text = q === null ? null : q.trim();
  if (q !== null && (text === "" || text!.length > 80 || q.length > 200)) return bad();
  const rank = (name: string): number => {
    const lower = name.toLowerCase();
    return text === null ? 0 : lower === text.toLowerCase() ? 0 : lower.startsWith(text.toLowerCase()) ? 1 : 2;
  };
  const matching = [...teamsAuth.teams.values()]
    .filter((team) => !team.archived && (text === null || team.name.toLowerCase().includes(text.toLowerCase())))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return Response.json({
    items: matching.slice(0, TEAMS_OPTIONS_LIMIT).map(({ id, name }) => ({ id, name })),
    truncated: matching.length > TEAMS_OPTIONS_LIMIT,
  });
}

const realFetch = globalThis.fetch;
spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
  const href = String(url);
  if (href.startsWith(`${TEST_ISSUER}/system/teams`)) {
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    const response = fakeAuthTeams(new URL(href), authorization);
    if (teamsAuth.hold !== null || teamsAuth.delayMs > 0) {
      const wait = teamsAuth.hold ?? new Promise<void>((done) => setTimeout(done, teamsAuth.delayMs));
      await new Promise<void>((resolve, reject) => {
        void wait.then(resolve);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return response;
  }
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
  if (href.startsWith(`${TEST_CRM_URL}/system/deals`)) {
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return fakeCrmDeals(new URL(href), authorization);
  }
  if (href.startsWith(`${TEST_CRM_URL}/system/contacts`)) {
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return fakeCrmContacts(new URL(href), authorization);
  }
  if (href.startsWith(`${TEST_ISSUER}/authz/users/holders`)) {
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return fakeHolders(new URL(href), authorization);
  }
  if (href.startsWith(`${TEST_ESTIMAI_URL}/system/estimates/`)) {
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    const id = decodeURIComponent(new URL(href).pathname.split("/")[3] ?? "");
    return fakeEstimaiSummary(id, authorization);
  }
  return realFetch(url as string, init);
}) as typeof fetch);

// ─── Seeds ───────────────────────────────────────────────────────────────────

/** The terms each type is seeded with: the smallest set that meets the type's rules. */
const SEED_TERMS = {
  fixed_price: { deadline: new Date("2027-03-31T00:00:00Z"), estimatedManDays: 40, maxEffortManDays: 55.5 },
  maintenance: { slaHighDays: 1, slaNormalDays: 3 },
  saas: {},
  t_and_m: {},
} as const;

export interface DealProjectSeed {
  readonly type?: "t_and_m" | "fixed_price" | "maintenance" | "saas";
  readonly project?: Partial<Prisma.ProjectUncheckedCreateInput>;
  readonly terms?: Partial<Prisma.ProjectTermsUncheckedCreateInput>;
  readonly order?: Partial<Prisma.PurchaseOrderUncheckedCreateInput>;
}

/**
 * A project made from a deal, straight in the database (the take that makes it is tested in
 * queue/take.test.ts): planned, no project manager, its terms and its purchase order, the shape of
 * specs/20261103-projects-handoff T23. Defaults: a fixed price project of Acme in wellD CH, deal `deal-seed`, ops-manager
 * `user-ops`; a T&M project gets one position.
 */
export async function seedDealProject(seed: DealProjectSeed = {}) {
  const type = seed.type ?? "fixed_price";
  const project = await db.project.create({
    data: {
      name: `Project ${type}`,
      type,
      entity: "welld_ch",
      companyId: "co-acme",
      projectManagerId: null,
      createdById: "user-sales-it",
      ...seed.project,
      terms: {
        create: {
          type,
          startDate: new Date("2026-12-01T00:00:00Z"),
          ...SEED_TERMS[type],
          ...(type === "t_and_m" ? { positions: { create: [{ profile: "Senior developer", plannedManDays: 120, position: 0 }] } } : {}),
          ...seed.terms,
        },
      },
      purchaseOrder: {
        create: { dealId: "deal-seed", opsManagerId: "user-ops", createdById: "user-sales-it", ...seed.order },
      },
    },
    include: { terms: true, purchaseOrder: true },
  });
  return { project, terms: project.terms!, order: project.purchaseOrder! };
}

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

/** Puts the world back to its start: the tables (children first), caches, switches and fakes. */
export async function resetWorld(): Promise<void> {
  await db.attachedTeam.deleteMany();
  await db.projectTermsPosition.deleteMany();
  await db.projectTerms.deleteMany();
  await db.purchaseOrder.deleteMany();
  await db.projectMember.deleteMany();
  await db.project.deleteMany();
  __resetAuthzCacheForTests();
  authzFake.calls = 0;
  authzFake.headers = [];
  authzFake.hold = null;
  authzFake.delayMs = 0;
  authzFake.fail = false;
  __resetIdentityCacheForTests();
  identities.down = false;
  identities.calls = 0;
  authSystem.down = false;
  authSystem.tokenCalls = 0;
  resetAppAccess();
  crm.companies = [];
  crm.deals = [];
  crm.contacts = [];
  crm.down = false;
  crm.contactsDown = false;
  crm.calls = 0;
  crm.dealCalls = 0;
  crm.contactCalls = 0;
  crm.wonLimit = CRM_WON_LIMIT;
  crm.lastAuthorization = "";
  crm.lastContactsQuery = "";
  crm.contactsReply = undefined;
  holders.users = defaultHolders();
  holders.down = false;
  holders.status = 200;
  holders.body = undefined;
  holders.calls = 0;
  holders.lastAuthorization = "";
  holders.lastQuery = "";
  estimai.estimates = new Map();
  estimai.down = false;
  estimai.calls = 0;
  estimai.lastAuthorization = "";
  teamsAuth.teams = new Map();
  teamsAuth.down = false;
  teamsAuth.status = 200;
  teamsAuth.body = undefined;
  teamsAuth.failNext = 0;
  teamsAuth.unauthorizedNext = 0;
  teamsAuth.hold = null;
  teamsAuth.delayMs = 0;
  teamsAuth.calls = 0;
  teamsAuth.idsCalls = 0;
  teamsAuth.optionsCalls = 0;
  teamsAuth.requests = [];
  // the team cache, its clock, and every team window (the attach search's and both page-read windows)
  resetTeamReaderForTests();
  resetTeamLimiters();
}
