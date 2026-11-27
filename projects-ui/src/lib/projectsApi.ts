/**
 * projectsApi — typed calls for every projects-api route the UI uses, of
 * specs/20261103-projects and of specs/20261103-projects-handoff (tasks.md § API contracts
 * "projects-api — routes", T23–T28), plus the directory read on `auth`. Every
 * write of an existing project, its terms or its purchase order passes the
 * record's `version` (sent as `If-Match`, specs/20261103-projects AC-1.7); creating a project,
 * its terms or taking a deal has no precondition.
 *
 * There is deliberately no call that attaches a deal to a project, changes a
 * project's type, or creates or deletes a purchase order (D38, D39, AC-1.10): a
 * PO is born with its project, by `takeDealAsProject`, and is never deleted. Terms
 * are the exception: a hand-made project's may be removed (`deleteTerms`).
 *
 * Not here on purpose: `GET /system/purchase-orders` (service-to-service, for crm-api).
 * The referent's candidates are asked by the deal / the project, never by a company id the
 * client names (the server derives the company: T18); referent data is read on open and not
 * cached or stored anywhere by this client (T18).
 */
import { getAuthBaseUrl } from 'shell/session'
import { getJson, query, requestJson, sendJson } from './api'
import type {
  AttachableTeam,
  CompanyChoice,
  ContactChoice,
  DealProjectType,
  DirectoryUser,
  Entity,
  OpsManagerList,
  Page,
  Person,
  Project,
  ProjectState,
  ProjectSummary,
  ProjectType,
  PurchaseOrder,
  QueueList,
  Scope,
  TeamFilterOption,
  Terms,
  TermsInput,
  TermsPatch,
} from './types'

type Init = { signal?: AbortSignal }

const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`
const termsPath = (projectId: string) => `${projectPath(projectId)}/terms`
const purchaseOrderPath = (projectId: string) => `${projectPath(projectId)}/purchase-order`
const queuePath = (dealId: string) => `/queue/${encodeURIComponent(dealId)}`

// ─── Scope ──────────────────────────────────────────────────────────────────

export const getScope = (init?: Init) => getJson<Scope>('/scope', init)

// ─── Companies (CRM, through projects-api; needs project:manage) ────────────

export const listCompanies = (q: string, init?: Init) =>
  getJson<{ items: CompanyChoice[] }>(`/companies${query({ q })}`, init)

// ─── Projects ───────────────────────────────────────────────────────────────

export type ProjectListQuery = {
  page?: number
  q?: string
  type?: ProjectType | ''
  state?: ProjectState | ''
  /** A person's id, or `none` for the projects awaiting a project manager (AC-4.5). */
  projectManagerId?: string
  /** A team attached to the project (specs/20261126-teams AC-4.8). */
  teamId?: string
}

/** A hand-made project (AC-5.1 – AC-5.3): any type, never a purchase order; `terms` are optional as a whole. */
export type CreateProjectInput = {
  name: string
  type: ProjectType
  entity: Entity
  /** Required for every client type, `saas` included; refused for `internal` (D40). */
  companyId?: string
  /** Defaults to the caller. */
  projectManagerId?: string
  /** Refused for `internal`. */
  terms?: TermsInput
}

/** The type of a project never changes (A30): there is no `type` member. `projectManagerId` is the pick (T27). */
export type UpdateProjectInput = { name?: string; projectManagerId?: string }

export const listProjects = (params: ProjectListQuery, init?: Init) =>
  getJson<Page<ProjectSummary>>(`/projects${query(params)}`, init)
/** The distinct project managers of all projects, by name: feeds the list's filter for every reader (AC-1.4). */
export const getProjectManagers = (init?: Init) => getJson<{ items: Person[] }>('/project-managers', init)
/**
 * The distinct teams attached to at least one project, by name, archived ones included, an unreadable one last: feeds
 * the list's Team filter for every reader (AC-4.8). Named for what it feeds: the D38 guard rejects any call whose name
 * says it attaches.
 */
export const getTeamFilterOptions = (init?: Init) => getJson<{ items: TeamFilterOption[] }>('/attached-teams', init)
export const getProject = (id: string, init?: Init) => getJson<Project>(projectPath(id), init)
export const createProject = (input: CreateProjectInput) => sendJson<Project>('/projects', 'POST', input)
export const updateProject = (id: string, version: number, input: UpdateProjectInput) =>
  sendJson<Project>(projectPath(id), 'PATCH', input, version)
export const transitionProject = (id: string, version: number, to: ProjectState) =>
  sendJson<Project>(`${projectPath(id)}/transitions`, 'POST', { to }, version)
export const replaceTeam = (id: string, version: number, memberIds: string[]) =>
  sendJson<Project>(`${projectPath(id)}/team`, 'PUT', { memberIds }, version)

// ─── Teams attached to a project (specs/20261126-teams, plan § API contracts "projects-api (step 2)") ──────────────────

/**
 * Replaces the whole set of attached teams (AC-4.1; at most 10), with the project's version as If-Match. Only the
 * teams being added are judged: 422 `team_not_found` / `team_archived` (both with `teamIds`), 503 `teams_unavailable`,
 * 429 `rate_limited` (with `retryAfterSeconds` in the body, the browser cannot read `Retry-After`); an unchanged or
 * only-removing save never meets the last two. The answer is the project with its new teams.
 */
export const replaceTeams = (id: string, version: number, teamIds: string[]) =>
  sendJson<Project>(`${projectPath(id)}/teams`, 'PUT', { teamIds }, version)

/**
 * The attach picker's server-side search (D13): active teams by a case-insensitive part of the name, the exact name
 * first, at most 50 (`truncated` when more matched). `q` is the trimmed text (at most 80 characters, which the
 * caller checks); empty lists the first active teams. Needs `project:manage` for any entity: 403 otherwise.
 * (Named without "attach": `api.test.ts` keeps this client free of any call that attaches a DEAL to a project, D38.)
 */
export const searchActiveTeams = (q: string, init?: Init) =>
  getJson<{ items: AttachableTeam[]; truncated: boolean }>(`/attachable-teams${query({ q })}`, init)

// ─── Terms (0..1 per project: a PO project always has them, a hand-made one may) ───

/** 409 `terms_exist`, `terms_not_allowed` (`internal`), `project_not_open`. */
export const createTerms = (projectId: string, input: TermsInput) =>
  sendJson<Terms>(termsPath(projectId), 'POST', input)
/** Partial; 404 `terms_not_found`; estimate-backed `estimatedManDays` are the server's → 422 `estimated_man_days_from_estimate`. */
export const updateTerms = (projectId: string, version: number, input: TermsPatch) =>
  sendJson<Terms>(termsPath(projectId), 'PATCH', input, version)
/** `204` on a hand-made project; 409 `terms_required` on one with a purchase order. */
export const deleteTerms = (projectId: string, version: number) =>
  sendJson<undefined>(termsPath(projectId), 'DELETE', undefined, version)

// ─── Purchase order (0..1 per project: only a won deal brings one) ──────────

/** Needs `purchase-order:bexio` (`Scope.bexio`); `null` clears the id; 404 `purchase_order_not_found` on a hand-made project. */
export const setBexioOrderId = (projectId: string, version: number, bexioOrderId: string | null) =>
  sendJson<PurchaseOrder>(`${purchaseOrderPath(projectId)}/bexio-order`, 'PUT', { bexioOrderId }, version)

/** Set, change or clear the referent (AC-3.7); 422 `referent_invalid`, 503 `crm_unavailable`. */
export const updatePurchaseOrder = (projectId: string, version: number, input: { referentContactId: string | null }) =>
  sendJson<PurchaseOrder>(purchaseOrderPath(projectId), 'PATCH', input, version)

/** The non-archived contacts of the PO's company, which the server derives (T18); read on every open. */
export const listPurchaseOrderContacts = (projectId: string, init?: Init) =>
  getJson<{ items: ContactChoice[] }>(`${purchaseOrderPath(projectId)}/contacts`, init)

// ─── The to-start queue and taking a deal (specs/20261103-projects-handoff) ───────────────────────

export type QueueQuery = { q?: string; entity?: Entity | '' }

/**
 * AC-1.2, AC-1.8, AC-4.1: sales fills everything. A standard deal names its ops-manager and never a project
 * manager (D42; 422 `only_for_tenders`); a public tender (US-10) names its project manager and never an
 * ops-manager or a referent (422 `not_for_tenders`), because it has no purchase order.
 */
export type TakeDealAsProjectInput = {
  name: string
  type: DealProjectType
  terms: TermsInput
} & (
  | {
      /** Required: one of `listOpsManagers`'s items (422 `ops_manager_required` without). */
      opsManagerId: string
      referentContactId?: string | null
      projectManagerId?: never
    }
  | {
      /** A tender only, required (422 `project_manager_required`): a person who can use Projects. */
      projectManagerId: string
      opsManagerId?: never
      referentContactId?: never
    }
)

/** Won deals no project has taken, newest won first; read live from the CRM, so 503 `crm_unavailable` when it is down. */
export const listQueue = (params: QueueQuery, init?: Init) => getJson<QueueList>(`/queue${query(params)}`, init)

/** The ops-manager role's holders for the deal's entity, then the admins; `prefillId` when exactly one holder. */
export const listOpsManagers = (dealId: string, init?: Init) =>
  getJson<OpsManagerList>(`${queuePath(dealId)}/ops-managers`, init)

/** The non-archived contacts of the deal's company, which the server derives (T18); read on every open. */
export const listQueueContacts = (dealId: string, init?: Init) =>
  getJson<{ items: ContactChoice[] }>(`${queuePath(dealId)}/contacts`, init)

/**
 * A new `planned` project with the deal's company and entity, no project manager, its terms and
 * one purchase order, in one transaction (AC-1.2, AC-1.3). A take creates: no `If-Match`.
 */
export const takeDealAsProject = (dealId: string, input: TakeDealAsProjectInput) =>
  sendJson<Project>(`${queuePath(dealId)}/project`, 'POST', input)

// ─── auth: the user directory (PM and team pickers, ADR 20261101-user-directory-gate-widened-to-deal-manage/0055) ──────────

/** Only users who hold `(projects, "access")` (ADR 20261101-app-access-check-by-user-id-and-directory-app-filter): a PM and a member must hold it (AC-1.6). */
export const listDirectory = (init?: Init) =>
  requestJson<{ users: DirectoryUser[] }>(
    getAuthBaseUrl(),
    `/authz/users/directory${query({ appId: 'projects' })}`,
    init,
  )
