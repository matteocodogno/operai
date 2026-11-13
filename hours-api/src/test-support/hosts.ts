/**
 * Scriptable fake owners for hours-api tests (specs/029 T11; plan.md § Test strategy, the
 * activities-api `startTestHosts` pattern). ONE `Bun.serve` on port 0 that plays, over real HTTP and
 * through the same client code as production:
 *
 *   projects-api   POST {url}/projects/activity-host/v1/resolve        entity type `project`, `assignees`
 *   crm-api        POST {url}/crm/activity-host/v1/resolve             entity type `deal`, `involved`
 *   activities-api GET  {url}/activities/activities                    `?ids=` and `?dealId=` (paged)
 *   meetings-api   GET  {url}/meetings/meetings                        `?ids=` (the caller's own meetings)
 *                  GET  {url}/meetings/system/meetings/hosts           `?ids=` / `?dealId=`, service JWT only
 *   auth           GET  {url}/auth/authz/resolve                       the caller's permissions
 *                  POST {url}/auth/authz/users/identities              display identities
 *                  POST {url}/auth/system/service-token                hours-api's own 5-minute JWT
 *
 * One instance per test file: `const hosts = startHosts(); afterAll(() => hosts.stop());` (`bun test`
 * runs the files one after the other in one process, and `stop()` puts back what it found, so an
 * instance stops before the next file starts). `beforeEach(() => hosts.reset())`, or `resetWorld`
 * where the file uses the world.
 *
 * `startHosts()` points `env.PROJECTS_API_URL`, `CRM_API_URL`, `ACTIVITIES_API_URL`, `MEETINGS_API_URL`
 * and `AUTH_BASE_URL` at it (the `bun test` preload set them to dead placeholders, so a test that
 * forgot to start the hosts is refused, never answered by the developer's stack) and `stop()` puts
 * them back. It registers its reset with `world.onReset`, so `resetWorld()` empties it too.
 *
 * What a test scripts: who reads what (`setReader`), each project / deal / activity / meeting, who is
 * on which meeting, which deal a meeting is linked to, people and permissions on `auth`, and a
 * FAILURE PER ROUTE (`fail("meetings.system-hosts", { status: 500 })`): a status, a body that breaks
 * the contract, raw text, a delay, a redirect, and `times` to fail only the next N calls.
 * `sever(host)` repoints one owner at a closed port, a real network error. `legacy` plays an owner
 * that predates T6-T9 (plan R7): crm-api that answers 422 to `entityType: "deal"`, activities-api
 * that answers 422 to `ids` alone, meetings-api that ignores `ids` and returns the caller's latest page.
 *
 * `calls` records EVERY request that reached the server, in arrival order, whatever the answer was
 * (a refused body, a scripted failure, a timed-out call), so "the fake recorded no call" means no
 * request left hours-api. Each record carries the `Authorization` it received and the query as
 * URLSearchParams, so an id holding `&`, `#`, `+`, `%` or a space is compared as decoded, which is
 * how the real owners read it.
 *
 * The owners' validation is copied strictly, because the clients must cope with it: bodies are strict
 * (projects 400, crm 422), activities `ids` and meetings `ids` follow the 422 rules of T6 and T8, and
 * the system route answers ONE identical 401 to anything but a service JWT of `system:hours-api` with
 * scope `meetings.hosts.read` and `aud` = `SERVICE_AUDIENCE` (claims are checked, signatures are not:
 * the fake does not verify tokens).
 */

import { env } from "../lib/env";
import { serviceTokens } from "../lib/serviceToken";
import { TEST_SERVICE_AUDIENCE } from "./env";
import { onReset } from "./world";

// ─── Names ───────────────────────────────────────────────────────────────────

export type HostName = "projects" | "crm" | "activities" | "meetings" | "auth";

export type RouteName =
  | "projects.resolve"
  | "crm.resolve"
  | "activities.list"
  | "meetings.list"
  | "meetings.system-hosts"
  | "auth.resolve"
  | "auth.identities"
  | "auth.service-token";

const ROUTES: Record<RouteName, { host: HostName; method: "GET" | "POST"; path: string }> = {
  "projects.resolve": { host: "projects", method: "POST", path: "/projects/activity-host/v1/resolve" },
  "crm.resolve": { host: "crm", method: "POST", path: "/crm/activity-host/v1/resolve" },
  "activities.list": { host: "activities", method: "GET", path: "/activities/activities" },
  "meetings.list": { host: "meetings", method: "GET", path: "/meetings/meetings" },
  "meetings.system-hosts": { host: "meetings", method: "GET", path: "/meetings/system/meetings/hosts" },
  "auth.resolve": { host: "auth", method: "GET", path: "/auth/authz/resolve" },
  "auth.identities": { host: "auth", method: "POST", path: "/auth/authz/users/identities" },
  "auth.service-token": { host: "auth", method: "POST", path: "/auth/system/service-token" },
};

const URL_KEYS = {
  projects: "PROJECTS_API_URL",
  crm: "CRM_API_URL",
  activities: "ACTIVITIES_API_URL",
  meetings: "MEETINGS_API_URL",
  auth: "AUTH_BASE_URL",
} as const satisfies Record<HostName, keyof typeof env>;

// ─── What a test scripts ─────────────────────────────────────────────────────

export interface ScriptedProject {
  readonly label: string;
  /** Default `/projects/<id>`. */
  readonly href?: string;
  /** Default true. projects-api: false for a closed or cancelled project; hours-api ignores it (A12). */
  readonly writable?: boolean;
  /** The project manager and the team. Default `[]`. */
  readonly assignees?: readonly string[];
}

export interface ScriptedDeal {
  readonly label: string;
  /** Default `/crm/deals/<id>`. */
  readonly href?: string;
  /** The owner and the technical contact (user ids). Default `[]`. */
  readonly involved?: readonly string[];
}

export interface ScriptedActivity {
  readonly id: string;
  readonly subject: string;
  /** Default `task`. */
  readonly type?: "task" | "note" | "call" | "meeting" | "email";
  /** The project it is a task of (an operational activity). */
  readonly project?: string;
  /** The deal it is about (a pre-sales activity). */
  readonly deal?: string;
  /** A task's assignee (a user id). */
  readonly assignee?: string;
  readonly participants?: readonly string[];
  /** Only these callers (JWT `sub`) read it; absent: everyone who reads at all. */
  readonly readableBy?: readonly string[];
  /** ISO instant; default: later than every activity added before (so the list is newest first). */
  readonly occurredAt?: string;
}

export interface ScriptedMeeting {
  readonly id: string;
  readonly title?: string;
  /** The creator's user id. */
  readonly creator: string;
  /** The Operai participants' user ids. A host-only reader is neither: the list never has the meeting for them. */
  readonly participants?: readonly string[];
  /** The CRM deal it is linked to (host `{crm, deal, dealId}`); null: none. */
  readonly dealId?: string | null;
  /**
   * The host the meeting stores, three strings of ANY value (ADR-0059: a host is data; production has only
   * `crm` / `deal`). Wins over `dealId`. null: none.
   */
  readonly host?: StoredHost | null;
  /** ISO instant; default: later than every meeting added before (so the list is newest first). */
  readonly startsAt?: string;
}

/** What meetings-api stores and its system route returns: three strings. */
export interface StoredHost {
  readonly app: string;
  readonly entityType: string;
  readonly entityId: string;
}

export interface ScriptedIdentity {
  readonly name: string | null;
  /** Default `active`. A name is sent for an active person only, as `auth` does. */
  readonly status?: "active" | "deleted" | "unknown";
}

/** How the next calls of a route behave. `{}` is normal. */
export interface FailureMode {
  /** Answer with this status and a Problem-shaped body. */
  status?: number;
  /**
   * Answer exactly as the route normally would, body included, but under this status (not 204, 205
   * or 304, which carry no body): a perfectly good answer that must still not count, because only
   * a 200 is an answer.
   */
  withStatus?: number;
  /** Answer 200 with JSON that breaks every contract. */
  malformed?: boolean;
  /** Answer 200 with exactly this text, for a body that is not JSON. */
  rawBody?: string;
  /** Answer 200 with exactly this JSON, for the odd answers the real owners never send. */
  body?: unknown;
  /** Wait this long before answering (longer than the client's timeout makes it time out). */
  delayMs?: number;
  /** Answer 302 to `{url}/elsewhere`. */
  redirect?: boolean;
  /** Apply to the next N calls of the route only, then behave normally. Default: every call. */
  times?: number;
  /** Let this many calls through untouched first (a later page that fails). Default 0. */
  after?: number;
}

export interface RecordedCall {
  readonly host: HostName;
  readonly route: RouteName;
  readonly method: string;
  /** Without the owner's prefix, as the owner's own route sees it. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** The `Authorization` header exactly as received, or null. */
  readonly authorization: string | null;
  /** The parsed JSON body, or null (a GET, or a body that is not JSON). */
  readonly body: unknown;
}

export interface ProjectsHost {
  setProject(id: string, project: ScriptedProject): void;
  /** `who` is a JWT `sub`, or `"*"` for everyone not named (default: everyone reads). */
  setReader(who: string, reader: boolean): void;
}

export interface CrmHost {
  setDeal(id: string, deal: ScriptedDeal): void;
  setReader(who: string, reader: boolean): void;
  /** crm-api before T7: `entityType: "deal"` is a 422 (plan R7). */
  legacy: boolean;
}

export interface ActivitiesHost {
  add(activity: ScriptedActivity): void;
  /** A non-reader gets no activity from `ids` and a 404 from `dealId` (the CRM refuses a non-reader). */
  setReader(who: string, reader: boolean): void;
  /** activities-api before T6: `ids` is not a filter, so `ids` alone is the "exactly one filter" 422 (plan R7). */
  legacy: boolean;
}

export interface MeetingsHost {
  add(meeting: ScriptedMeeting): void;
  /** Links the meeting to the CRM deal `dealId`, or to none: the relink of AC-2.6. */
  relink(id: string, dealId: string | null): void;
  /** Stores any host on the meeting, or none: a host that is not a CRM deal. */
  setHost(id: string, host: StoredHost | null): void;
  /** meetings-api before T8: ignores `ids` and returns the caller's latest page (plan R7). */
  legacy: boolean;
}

export interface AuthHost {
  setIdentity(id: string, identity: ScriptedIdentity): void;
  /** `sub` holds `resource:action`, unconditioned, in what `GET /authz/resolve` answers. */
  grant(sub: string, resource: string, action: string): void;
  /** Tokens `POST /system/service-token` minted since the last reset. */
  readonly mints: number;
}

export interface Hosts {
  readonly url: string;
  readonly projects: ProjectsHost;
  readonly crm: CrmHost;
  readonly activities: ActivitiesHost;
  readonly meetings: MeetingsHost;
  readonly auth: AuthHost;
  /** Every request that reached the server, in arrival order. */
  readonly calls: readonly RecordedCall[];
  callsTo(route: RouteName): RecordedCall[];
  /** What reached `/elsewhere` (the target of `redirect`): a safe client never gets there. */
  readonly elsewhere: readonly { readonly authorization: string | null }[];
  fail(route: RouteName, mode: FailureMode): void;
  heal(route: RouteName): void;
  /** Points `host` at a closed port: a real connection error. Undone by `reset`. */
  sever(host: HostName): void;
  reset(): void;
  stop(): Promise<void>;
}

// ─── Shapes owners and `auth` use ────────────────────────────────────────────

/** A JWT-shaped bearer carrying `claims`: enough for this server, which reads claims and verifies nothing. */
export function tokenShaped(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.sig`;
}

/** The claims of a JWT-shaped bearer (not verified), or null. */
export function claimsOf(authorization: string | null): Record<string, unknown> | null {
  const payload = authorization?.startsWith("Bearer ") ? authorization.slice(7).split(".")[1] : undefined;
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const subOf = (authorization: string | null): string | null => {
  const sub = claimsOf(authorization)?.["sub"];
  return typeof sub === "string" ? sub : null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What every owner and `auth` call a malformed id: 1..64 characters, no NUL. */
const isOwnerId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 64 && !value.includes("\u0000");

const isIdList = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(isOwnerId);

const problem = (status: number, code?: string) =>
  Response.json({ type: `https://httpstatuses.com/${status}`, title: "scripted", status, ...(code ? { code } : {}) }, { status });

/** The one body the system route answers to every credential failure. */
const unauthorized = () => problem(401);

const person = (id: string) => ({ id, name: null, status: "active" as const });

function readerOf(readers: ReadonlyMap<string, boolean>, sub: string | null): boolean {
  if (sub !== null && readers.has(sub)) return readers.get(sub)!;
  return readers.get("*") ?? true;
}

const dealHost = (dealId: string): StoredHost => ({ app: "crm", entityType: "deal", entityId: dealId });

/** A meeting as the fake keeps it: its host resolved to what is stored, and its place in the order it was added. */
type StoredMeeting = Omit<ScriptedMeeting, "dealId" | "host" | "startsAt"> & {
  readonly host: StoredHost | null;
  readonly startsAt: string;
  readonly order: number;
};

/** `limit` of elements, each 1..64 characters: the comma list of `ids` / `dealId`. `null`: refuse (422). */
function commaList(raw: string, options: { max: number; trim: boolean }): string[] | null {
  if (raw.length > options.max * 65) return null;
  const members = raw.split(",").map((member) => (options.trim ? member.trim() : member));
  if (members.length > options.max) return null;
  if (members.some((member) => member.length < 1 || member.length > 64)) return null;
  return members;
}

// ─── The server ──────────────────────────────────────────────────────────────

export function startHosts(): Hosts {
  const calls: RecordedCall[] = [];
  const elsewhere: { authorization: string | null }[] = [];
  const modes = new Map<RouteName, { mode: FailureMode; remaining: number; letThrough: number }>();
  const minted: string[] = [];
  const severed = new Set<HostName>();

  const projects = new Map<string, ScriptedProject>();
  const projectReaders = new Map<string, boolean>();
  const deals = new Map<string, ScriptedDeal>();
  const crmReaders = new Map<string, boolean>();
  const activities: ScriptedActivity[] = [];
  const activityReaders = new Map<string, boolean>();
  const meetings: StoredMeeting[] = [];
  const identities = new Map<string, ScriptedIdentity>();
  const grants = new Map<string, { resource: string; action: string }[]>();
  const flags = { crmLegacy: false, activitiesLegacy: false, meetingsLegacy: false };
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const tick = () => new Date((clock += 60_000)).toISOString();

  // ── projects-api ────────────────────────────────────────────────────────────

  function projectsResolve(body: unknown, sub: string | null): Response {
    const valid =
      typeof body === "object" &&
      body !== null &&
      Object.keys(body).every((key) => ["entityType", "ids", "related"].includes(key)) &&
      (body as Record<string, unknown>)["entityType"] === "project" &&
      isIdList((body as Record<string, unknown>)["ids"], 25);
    if (!valid) return problem(400, "validation_failed");
    const distinct = [...new Set((body as { ids: string[] }).ids)];
    if (!readerOf(projectReaders, sub)) {
      return Response.json({ reader: false, items: distinct.map((id) => ({ id, state: "missing" })) });
    }
    const items = distinct.map((id) => {
      const project = projects.get(id);
      if (!project) return { id, state: "missing" };
      return {
        id,
        state: "open",
        writable: project.writable ?? true,
        label: project.label,
        href: project.href ?? `/projects/${id}`,
        may: { write: true, manage: true },
        assignees: [...(project.assignees ?? [])],
      };
    });
    return Response.json({ reader: true, items });
  }

  // ── crm-api ─────────────────────────────────────────────────────────────────

  function crmResolve(body: unknown, sub: string | null): Response {
    if (typeof body !== "object" || body === null) return problem(422, "validation_failed");
    const record = body as Record<string, unknown>;
    // crm-api before T7 knew `company` only; since T7 a deal body is strict `{ entityType, ids }`.
    const entityType = record["entityType"];
    const knownTypes = flags.crmLegacy ? ["company"] : ["company", "deal"];
    if (typeof entityType !== "string" || !knownTypes.includes(entityType)) return problem(422, "validation_failed");
    const allowedKeys = entityType === "deal" ? ["entityType", "ids"] : ["entityType", "ids", "related"];
    if (!Object.keys(record).every((key) => allowedKeys.includes(key)) || !isIdList(record["ids"], 25)) {
      return problem(422, "validation_failed");
    }
    if (entityType === "company") return Response.json({ reader: readerOf(crmReaders, sub), items: [], related: [] });
    const distinct = [...new Set(record["ids"])];
    const reader = readerOf(crmReaders, sub);
    // No grant: no lookup, so nothing leaks, not even whether a deal exists.
    if (!reader) return Response.json({ reader: false, items: [] });
    const items = distinct.map((id) => {
      const deal = deals.get(id);
      if (!deal) return { id, state: "missing" };
      return {
        id,
        state: "open",
        writable: true,
        label: deal.label,
        href: deal.href ?? `/crm/deals/${id}`,
        may: { write: true, manage: true },
        involved: [...(deal.involved ?? [])],
      };
    });
    return Response.json({ reader: true, items });
  }

  // ── activities-api ──────────────────────────────────────────────────────────

  const activityView = (activity: ScriptedActivity) => ({
    id: activity.id,
    kind: activity.project !== undefined ? "operational" : "pre_sales",
    type: activity.type ?? "task",
    subject: activity.subject,
    body: null,
    occurredAt: activity.occurredAt as string,
    company: activity.deal !== undefined ? { id: "company-of-deal", name: null } : null,
    project: activity.project !== undefined ? { id: activity.project, name: null } : null,
    contact: null,
    deal: activity.deal !== undefined ? { id: activity.deal, title: null } : null,
    author: person("user-author"),
    participants: (activity.participants ?? []).map(person),
    meeting: null,
    task:
      (activity.type ?? "task") === "task"
        ? {
            dueDate: null,
            assignee: activity.assignee !== undefined ? person(activity.assignee) : null,
            completedAt: null,
            completedBy: null,
            blockedBy: [],
            blocked: false,
          }
        : null,
    may: { edit: false, delete: false, complete: false },
    createdAt: activity.occurredAt as string,
    updatedAt: activity.occurredAt as string,
  });

  function activitiesList(query: URLSearchParams, sub: string | null): Response {
    const invalid = () => problem(422, "validation_failed");
    const idsParams = query.getAll("ids");
    if (idsParams.length > 1) return invalid();
    // An empty value counts as absent, as an empty `companyId` always did.
    const present = ["companyId", "contactId", "dealId", "projectId", ...(flags.activitiesLegacy ? [] : ["ids"])].filter(
      (key) => (query.get(key) ?? "") !== "",
    );
    if (present.length !== 1) return invalid();

    const reader = readerOf(activityReaders, sub);
    const readable = (activity: ScriptedActivity) => reader && (activity.readableBy === undefined || (sub !== null && activity.readableBy.includes(sub)));
    const newestFirst = (a: ScriptedActivity, b: ScriptedActivity) =>
      b.occurredAt!.localeCompare(a.occurredAt!) || b.id.localeCompare(a.id);

    if (present[0] === "ids") {
      const ids = commaList(idsParams[0]!, { max: 50, trim: false });
      if (ids === null || ids.some((id) => id.includes("\u0000"))) return invalid();
      const asked = new Set(ids);
      const items = activities.filter((activity) => asked.has(activity.id) && readable(activity)).sort(newestFirst);
      // ALWAYS ONE PAGE: `page` / `pageSize` are ignored.
      return Response.json({ items: items.map(activityView), total: items.length, page: 1, pageSize: 50 });
    }

    const page = Number(query.get("page") ?? "1");
    const pageSize = Number(query.get("pageSize") ?? "25");
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return invalid();
    if (present[0] !== "dealId") return Response.json({ items: [], total: 0, page, pageSize });
    // The CRM refuses a caller who cannot read it, with the same 404 whatever the deal.
    if (!reader) return problem(404, "not_found");
    const dealId = query.get("dealId")!;
    if (dealId.length > 64 || dealId.includes("\u0000")) return invalid();
    const all = activities.filter((activity) => activity.deal === dealId && readable(activity)).sort(newestFirst);
    return Response.json({ items: all.slice((page - 1) * pageSize, page * pageSize).map(activityView), total: all.length, page, pageSize });
  }

  // ── meetings-api ────────────────────────────────────────────────────────────

  const newestFirstMeetings = (a: StoredMeeting, b: StoredMeeting) => b.startsAt.localeCompare(a.startsAt) || b.order - a.order;

  function meetingsList(query: URLSearchParams, sub: string | null): Response {
    const invalid = () => problem(422, "validation_failed");
    const idsParams = query.getAll("ids");
    if (idsParams.length > 1) return invalid();
    const page = Number(query.get("page") ?? "1");
    if (!Number.isInteger(page) || page < 1) return invalid();

    let asked: Set<string> | null = null;
    if (idsParams.length === 1 && !flags.meetingsLegacy) {
      // `ids=` and `ids=%20` are an empty member: a 422, never "no filter".
      const ids = commaList(idsParams[0]!, { max: 25, trim: true });
      if (ids === null) return invalid();
      // A member holding a NUL names no meeting: absent.
      asked = new Set(ids.filter((id) => !id.includes("\u0000")));
    }
    const mine = meetings
      .filter((meeting) => sub !== null && (meeting.creator === sub || (meeting.participants ?? []).includes(sub)))
      .filter((meeting) => asked === null || asked.has(meeting.id))
      .sort(newestFirstMeetings);
    const rows = mine.slice((page - 1) * 25, page * 25).map((meeting) => ({
      id: meeting.id,
      title: meeting.title ?? `Meeting ${meeting.id}`,
      startsAt: meeting.startsAt,
      format: "online",
      status: "ready",
      host: meeting.host === null ? null : { ...meeting.host, state: "open", title: null, href: null },
      role: meeting.creator === sub ? "creator" : "participant",
      summaryCount: 0,
      creator: person(meeting.creator),
    }));
    return Response.json({ items: rows, total: mine.length, page, pageSize: 25 });
  }

  function meetingsSystemHosts(query: URLSearchParams, authorization: string | null): Response {
    // One identical 401 for no credential, a user JWT, another subject, another scope, another audience, an expired one.
    const claims = claimsOf(authorization);
    const audiences = ([] as unknown[]).concat(claims?.["aud"] ?? []);
    const scopes = typeof claims?.["scope"] === "string" ? claims["scope"].split(" ") : [];
    const exp = claims?.["exp"];
    if (
      claims === null ||
      claims["sub"] !== "system:hours-api" ||
      !audiences.includes(TEST_SERVICE_AUDIENCE) ||
      !scopes.includes("meetings.hosts.read") ||
      (typeof exp === "number" && exp * 1000 <= Date.now())
    ) {
      return unauthorized();
    }
    const invalid = () => problem(422, "validation_failed");
    const idsParams = query.getAll("ids");
    const dealIds = query.getAll("dealId");
    if (idsParams.length + dealIds.length !== 1) return invalid();
    // Id ascending, whatever the question (T9).
    const byId = (a: StoredMeeting, b: StoredMeeting) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const row = (meeting: StoredMeeting) => ({ id: meeting.id, host: meeting.host });

    if (dealIds.length === 1) {
      // One id, ≤ 128 characters raw, trimmed, then 1..64; a NUL names no deal: nothing is linked to it.
      const raw = dealIds[0]!;
      const dealId = raw.trim();
      if (raw.length > 128 || dealId.length < 1 || dealId.length > 64) return invalid();
      if (dealId.includes("\u0000")) return Response.json({ items: [] });
      // The meetings whose stored host is EXACTLY { crm, deal, dealId }: never paged, never capped.
      const linked = meetings.filter(
        (meeting) => meeting.host?.app === "crm" && meeting.host.entityType === "deal" && meeting.host.entityId === dealId,
      );
      return Response.json({ items: linked.sort(byId).map(row) });
    }
    // ≤ 6500 characters raw, ≤ 100 members as sent, each trimmed then 1..64; a NUL member names no meeting.
    const ids = commaList(idsParams[0]!, { max: 100, trim: true });
    if (ids === null) return invalid();
    const asked = new Set(ids);
    // Unknown ids are omitted.
    return Response.json({ items: meetings.filter((meeting) => asked.has(meeting.id)).sort(byId).map(row) });
  }

  // ── auth ────────────────────────────────────────────────────────────────────

  function authResolve(authorization: string | null): Response {
    const claims = claimsOf(authorization);
    const sub = typeof claims?.["sub"] === "string" ? claims["sub"] : null;
    if (sub === null) return problem(401);
    const epoch = claims?.["perm_epoch"];
    return Response.json({
      sub,
      epoch: typeof epoch === "number" ? epoch : 0,
      permissions: (grants.get(sub) ?? []).map(({ resource, action }) => ({ resource, action, conditions: null })),
      entity: null,
      jobTitle: null,
    });
  }

  function authIdentities(body: unknown): Response {
    const valid =
      typeof body === "object" &&
      body !== null &&
      Object.keys(body).every((key) => key === "ids") &&
      isIdList((body as Record<string, unknown>)["ids"], 100) &&
      (body as { ids: string[] }).ids.length >= 1;
    if (!valid) return problem(400, "validation_failed");
    const users = [...new Set((body as { ids: string[] }).ids)].map((id) => {
      const scripted = identities.get(id);
      const status = scripted?.status ?? (scripted ? "active" : "unknown");
      return { id, status, name: status === "active" ? (scripted?.name ?? null) : null };
    });
    return Response.json({ users });
  }

  function authServiceToken(body: unknown): Response {
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    if (record === null || !Object.keys(record).every((key) => key === "clientId" || key === "clientSecret")) return problem(400);
    // Unknown client and wrong secret are one answer.
    if (record["clientId"] !== env.SERVICE_CLIENT_ID || record["clientSecret"] !== env.SERVICE_CLIENT_SECRET) return problem(401);
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = tokenShaped({
      iss: "http://auth.test",
      sub: `system:${env.SERVICE_CLIENT_ID}`,
      aud: env.SERVICE_AUDIENCE,
      scope: "meetings.hosts.read",
      iat: issuedAt,
      exp: issuedAt + 300,
      jti: crypto.randomUUID(),
    });
    minted.push(token);
    return Response.json({ token, expiresInSeconds: 300 });
  }

  // ── dispatch ────────────────────────────────────────────────────────────────

  async function handle(route: RouteName, req: Request, origin: string): Promise<Response> {
    const url = new URL(req.url);
    const authorization = req.headers.get("Authorization");
    const body: unknown = req.method === "GET" ? null : await req.json().catch(() => null);
    calls.push({
      host: ROUTES[route].host,
      route,
      method: req.method,
      path: url.pathname.slice(ROUTES[route].path.indexOf("/", 1)),
      query: url.searchParams,
      authorization,
      body,
    });

    const scripted = modes.get(route);
    let mode: FailureMode | undefined;
    if (scripted && scripted.letThrough > 0) {
      scripted.letThrough -= 1;
    } else if (scripted && scripted.remaining > 0) {
      if (scripted.remaining !== Infinity) scripted.remaining -= 1;
      mode = scripted.mode;
      if (mode.delayMs) await sleep(mode.delayMs);
      if (mode.redirect) return new Response(null, { status: 302, headers: { Location: `${origin}/elsewhere` } });
      if (mode.status) return problem(mode.status);
      if (mode.rawBody !== undefined) return new Response(mode.rawBody, { headers: { "Content-Type": "application/json" } });
      if (mode.body !== undefined) return Response.json(mode.body);
      if (mode.malformed) return Response.json({ reader: "yes", items: "nope", users: "nope", permissions: "nope" });
    }

    const normal = answer(route, { body, authorization, query: url.searchParams, sub: subOf(authorization) });
    if (!mode?.withStatus) return normal;
    // The route's own good answer under another status: only a 200 may count.
    return new Response(normal.body, { status: mode.withStatus, headers: normal.headers });
  }

  function answer(
    route: RouteName,
    request: { body: unknown; authorization: string | null; query: URLSearchParams; sub: string | null },
  ): Response {
    const { body, authorization, query, sub } = request;
    switch (route) {
      case "meetings.system-hosts":
        // Its own credential check comes first: the 401 is the same whatever else is wrong.
        return meetingsSystemHosts(query, authorization);
      case "auth.service-token":
        return authServiceToken(body);
      default:
        if (!authorization) return problem(401);
    }
    switch (route) {
      case "projects.resolve":
        return projectsResolve(body, sub);
      case "crm.resolve":
        return crmResolve(body, sub);
      case "activities.list":
        return activitiesList(query, sub);
      case "meetings.list":
        return meetingsList(query, sub);
      case "auth.resolve":
        return authResolve(authorization);
      case "auth.identities":
        return authIdentities(body);
      default:
        return problem(404);
    }
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/elsewhere") {
        elsewhere.push({ authorization: req.headers.get("Authorization") });
        return Response.json({ reader: true, items: [] });
      }
      const route = (Object.keys(ROUTES) as RouteName[]).find((name) => ROUTES[name].path === url.pathname);
      // A route this server does not play, or the wrong method: what an owner that has not deployed it answers.
      if (route === undefined || ROUTES[route].method !== req.method) return problem(404);
      return handle(route, req, url.origin);
    },
  });
  // A test file that forgot `stop()` must not keep `bun test` alive.
  server.unref();

  const url = `http://127.0.0.1:${server.port}`;
  const original = {
    projects: env.PROJECTS_API_URL,
    crm: env.CRM_API_URL,
    activities: env.ACTIVITIES_API_URL,
    meetings: env.MEETINGS_API_URL,
    auth: env.AUTH_BASE_URL,
  } satisfies Record<HostName, string>;
  const prefixes: Record<HostName, string> = {
    projects: `${url}/projects`,
    crm: `${url}/crm`,
    activities: `${url}/activities`,
    meetings: `${url}/meetings`,
    auth: `${url}/auth`,
  };
  const point = (host: HostName, to: string) => {
    env[URL_KEYS[host]] = to;
  };
  for (const host of Object.keys(prefixes) as HostName[]) point(host, prefixes[host]);

  /** The service token provider caches for minutes: forget what this server minted so the next test mints again. */
  const forgetTokens = () => {
    for (const token of minted.splice(0)) serviceTokens.invalidate(token);
  };

  let stopped = false;
  const reset = () => {
    calls.length = 0;
    elsewhere.length = 0;
    modes.clear();
    projects.clear();
    projectReaders.clear();
    deals.clear();
    crmReaders.clear();
    activities.length = 0;
    activityReaders.clear();
    meetings.length = 0;
    identities.clear();
    grants.clear();
    flags.crmLegacy = flags.activitiesLegacy = flags.meetingsLegacy = false;
    clock = Date.parse("2026-01-01T00:00:00Z");
    forgetTokens();
    for (const host of severed) point(host, prefixes[host]);
    severed.clear();
  };
  // After `stop()` the hook is a no-op: `onReset` keeps what it was given for the process's life.
  onReset(() => {
    if (!stopped) reset();
  });

  return {
    url,
    projects: {
      setProject: (id, project) => void projects.set(id, project),
      setReader: (who, reader) => void projectReaders.set(who, reader),
    },
    crm: {
      setDeal: (id, deal) => void deals.set(id, deal),
      setReader: (who, reader) => void crmReaders.set(who, reader),
      get legacy() {
        return flags.crmLegacy;
      },
      set legacy(value: boolean) {
        flags.crmLegacy = value;
      },
    },
    activities: {
      add: (activity) => void activities.push({ ...activity, occurredAt: activity.occurredAt ?? tick() }),
      setReader: (who, reader) => void activityReaders.set(who, reader),
      get legacy() {
        return flags.activitiesLegacy;
      },
      set legacy(value: boolean) {
        flags.activitiesLegacy = value;
      },
    },
    meetings: {
      add({ dealId, host, ...meeting }) {
        meetings.push({
          ...meeting,
          host: host !== undefined ? host : dealId != null ? dealHost(dealId) : null,
          startsAt: meeting.startsAt ?? tick(),
          order: meetings.length,
        });
      },
      relink(id, dealId) {
        this.setHost(id, dealId === null ? null : dealHost(dealId));
      },
      setHost(id, host) {
        const index = meetings.findIndex((meeting) => meeting.id === id);
        if (index === -1) throw new Error(`hosts.meetings: no meeting ${id}`);
        meetings[index] = { ...meetings[index]!, host };
      },
      get legacy() {
        return flags.meetingsLegacy;
      },
      set legacy(value: boolean) {
        flags.meetingsLegacy = value;
      },
    },
    auth: {
      setIdentity: (id, identity) => void identities.set(id, identity),
      grant(sub, resource, action) {
        grants.set(sub, [...(grants.get(sub) ?? []), { resource, action }]);
      },
      get mints() {
        return minted.length;
      },
    },
    calls,
    callsTo: (route) => calls.filter((call) => call.route === route),
    elsewhere,
    fail(route, mode) {
      modes.set(route, { mode, remaining: mode.times ?? Infinity, letThrough: mode.after ?? 0 });
    },
    heal(route) {
      modes.delete(route);
    },
    sever(host) {
      severed.add(host);
      point(host, original[host]);
    },
    reset,
    async stop() {
      stopped = true;
      forgetTokens();
      for (const host of Object.keys(original) as HostName[]) point(host, original[host]);
      await server.stop(true);
    },
  };
}
