/**
 * The host registry (specs/20261110-activities plan.md § Access, ADR 20261110-activities-service-access-delegated-to-host). A host is DATA, never a
 * branch in a route: each rule that differs between the CRM and Projects (who edits, who
 * completes, who may be assigned, which types exist) is a field below, read by the routes of
 * T7-T9 without an `if (app === "crm")`. Same shape as meetings-api `hosts/registry.ts`.
 *
 * Production and test hold the SAME two hosts. A test points them at a scriptable test host by
 * building the registry from the test host's URL (`buildRegistry`, `setRegistryForTests`),
 * which is why there is no `*_TEST_HOSTS` variable here to refuse in production.
 *
 * This file also holds the TYPES of the host contract (`HostEntity`, `ResolveResult`), so
 * `client.ts` exports nothing but its function.
 */

import { env } from "../lib/env";

export type ActivityType = "note" | "call" | "meeting" | "email" | "task";
export type ActivityKind = "pre_sales" | "operational";
export type HostApp = "crm" | "projects";
/** The records a host answers "related" for: CRM contacts and deals of an asked company. */
export type RelatedType = "contact" | "deal";

export interface ActivityHost {
  readonly app: HostApp;
  /** What an activity of this host hangs on: a CRM company, a project. */
  readonly entityType: "company" | "project";
  readonly kind: ActivityKind;
  /** CRM_API_URL / PROJECTS_API_URL, no trailing slash. */
  readonly baseUrl: string;
  /** The app whose access `auth app-access-check` tests for participants and CRM assignees. */
  readonly accessAppId: HostApp;
  readonly types: readonly ActivityType[];
  /** crm: the author (017 AC-4.2); projects: a manager of the entity (028 AC-3.2). */
  readonly editBy: "author" | "manager";
  /** crm: any reader (017 AC-4.3); projects: the assignee or a manager (028 AC-3.3). */
  readonly completeBy: "reader" | "assignee_or_manager";
  /** crm: any CRM user; projects: the list the host sends (PM + team, AC-3.1). */
  readonly assignees: "app_users" | "host_list";
  readonly relatedTypes: readonly RelatedType[];
  /** US-9: whether the author may restrict who sees the details (the CRM); else every activity is `everyone`. */
  readonly restrictsDetails: boolean;
  readonly links: {
    /** Where a notice about a TASK of entity `hostId` points. */
    readonly task: (hostId: string) => string;
    /** The entity's own page. */
    readonly entity: (hostId: string) => string;
  };
}

// ─── The host contract's types (plan.md § Host contract) ────────────────────

export interface HostMay {
  readonly write: boolean;
  readonly manage: boolean;
}

/** What a host answers about one entity, for one caller. */
export type HostEntity =
  | { readonly state: "missing" }
  | {
      readonly state: "open";
      /** false: a closed or cancelled project (AC-3.8); create/edit/reassign/delete are refused. */
      readonly writable: boolean;
      readonly label: string;
      /** A path inside the suite. */
      readonly href: string;
      readonly may: HostMay;
      /**
       * Only from a host with `assignees: "host_list"`; null from every other. `"unavailable"`: that
       * host said `assignees: null`, "could not find out" (specs/20261126-teams AC-5.4), which is
       * not an empty list: an assignment is refused on it, nothing else is.
       */
      readonly assignees: readonly string[] | "unavailable" | null;
    };

/** A contact or deal the host found under one of the companies asked about. */
export interface HostRelated {
  readonly type: RelatedType;
  readonly id: string;
  readonly parentId: string;
  readonly label: string;
  readonly href: string;
}

/**
 * - `unavailable`: timeout, transport error, any status but 200, a body that breaks the
 *   contract, an incomplete answer. Callers fail CLOSED (503 `host_unavailable`), AC-8.2.
 * - `not_reader`: the host answered 200 `reader:false`. Every entity is then a 404, AC-8.3.
 * - `ok`: the caller is a reader and every asked id has an entity (open or missing).
 */
export type ResolveResult =
  | { readonly state: "unavailable" }
  | { readonly state: "not_reader" }
  | {
      readonly state: "ok";
      readonly entities: ReadonlyMap<string, HostEntity>;
      readonly related: readonly HostRelated[];
      /** US-9: the host says the caller is in its sales team. Absent from the host = false (fail closed). */
      readonly salesTeam: boolean;
    };

// ─── The registry ───────────────────────────────────────────────────────────

const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, "");

const crmHost = (baseUrl: string): ActivityHost => ({
  app: "crm",
  entityType: "company",
  kind: "pre_sales",
  baseUrl,
  accessAppId: "crm",
  types: ["note", "call", "meeting", "email", "task"],
  editBy: "author",
  completeBy: "reader",
  assignees: "app_users",
  relatedTypes: ["contact", "deal"],
  restrictsDetails: true,
  links: {
    // As crm-api sends today: a task points at the task list.
    task: () => "/crm/tasks",
    entity: (hostId) => `/crm/companies/${hostId}`,
  },
});

const projectsHost = (baseUrl: string): ActivityHost => ({
  app: "projects",
  entityType: "project",
  kind: "operational",
  baseUrl,
  accessAppId: "projects",
  types: ["task"],
  editBy: "manager",
  completeBy: "assignee_or_manager",
  assignees: "host_list",
  relatedTypes: [],
  restrictsDetails: false,
  links: {
    task: (hostId) => `/projects/${hostId}`,
    entity: (hostId) => `/projects/${hostId}`,
  },
});

export interface HostRegistry {
  all(): readonly ActivityHost[];
  get(app: string, entityType: string): ActivityHost | undefined;
  forKind(kind: ActivityKind): ActivityHost | undefined;
}

export interface RegistryOptions {
  readonly crmApiUrl: string;
  readonly projectsApiUrl: string;
}

export function buildRegistry(options: RegistryOptions): HostRegistry {
  const hosts: readonly ActivityHost[] = [
    crmHost(stripTrailingSlashes(options.crmApiUrl)),
    projectsHost(stripTrailingSlashes(options.projectsApiUrl)),
  ];
  return {
    all: () => hosts,
    get: (app, entityType) => hosts.find((h) => h.app === app && h.entityType === entityType),
    forKind: (kind) => hosts.find((h) => h.kind === kind),
  };
}

let current: HostRegistry | null = null;

/** The registry for this process, built once from the environment. */
export function hostRegistry(): HostRegistry {
  current ??= buildRegistry({ crmApiUrl: env.CRM_API_URL, projectsApiUrl: env.PROJECTS_API_URL });
  return current;
}

/** Tests only: replace the registry (e.g. with the test hosts' URLs), or `null` to rebuild from env. */
export function setRegistryForTests(registry: HostRegistry | null): void {
  current = registry;
}
