/**
 * projectsApi — typed calls for every projects-api route the UI uses, of
 * specs/021-projects and of specs/022-projects-handoff (tasks.md § API contracts
 * "projects-api — routes", T23–T28), plus the directory read on `auth`. Every
 * write of an existing project, its terms or its purchase order passes the
 * record's `version` (sent as `If-Match`, specs/021 AC-1.7); creating a project,
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
export const getProject = (id: string, init?: Init) => getJson<Project>(projectPath(id), init)
export const createProject = (input: CreateProjectInput) => sendJson<Project>('/projects', 'POST', input)
export const updateProject = (id: string, version: number, input: UpdateProjectInput) =>
  sendJson<Project>(projectPath(id), 'PATCH', input, version)
export const transitionProject = (id: string, version: number, to: ProjectState) =>
  sendJson<Project>(`${projectPath(id)}/transitions`, 'POST', { to }, version)
export const replaceTeam = (id: string, version: number, memberIds: string[]) =>
  sendJson<Project>(`${projectPath(id)}/team`, 'PUT', { memberIds }, version)

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

// ─── The to-start queue and taking a deal (specs/022) ───────────────────────

export type QueueQuery = { q?: string; entity?: Entity | '' }

/** AC-1.2, AC-1.8, AC-4.1: sales fills everything; there is no `projectManagerId` (D42, strict → 400). */
export type TakeDealAsProjectInput = {
  name: string
  type: DealProjectType
  terms: TermsInput
  /** Required: one of `listOpsManagers`'s items. */
  opsManagerId: string
  referentContactId?: string | null
}

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

// ─── auth: the user directory (PM and team pickers, ADR-0053/0055) ──────────

/** Only users who hold `(projects, "access")` (ADR-0055): a PM and a member must hold it (AC-1.6). */
export const listDirectory = (init?: Init) =>
  requestJson<{ users: DirectoryUser[] }>(
    getAuthBaseUrl(),
    `/authz/users/directory${query({ appId: 'projects' })}`,
    init,
  )
