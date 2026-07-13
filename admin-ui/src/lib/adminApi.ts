/**
 * adminApi — typed API client for the `auth` service's authorization surface
 * (T16, specs/004-auth-roles-permissions/tasks.md): every `/admin/*` route plus the
 * caller-facing `GET /authz/me`, per plan.md's "## API contracts" section.
 *
 * Mirrors `estimai-ui/src/lib/estimatesApi.ts`'s conventions exactly (typed
 * request/response shapes, an `ApiError` built from RFC 7807 Problem JSON, one
 * function per operation) with two differences forced by where this data lives:
 *
 *   • Base URL is `import.meta.env.VITE_AUTH_URL`, not `VITE_API_URL` — `/admin/*`
 *     and `/authz/me` are served by the **auth service** (plan.md "Architecture
 *     decisions | Admin API home"), not estimai-api.
 *   • `apiFetch` is imported directly from the federated `shell/session` module
 *     (ADR-0001/ADR-0006) rather than through a local `./api` facade — admin-ui has
 *     no such facade yet and this task's `touch:` list is this file alone
 *     (specs/004-auth-roles-permissions/tasks.md T16). `shell/session`'s `apiFetch`
 *     already attaches the Bearer JWT to `VITE_AUTH_URL` as a trusted origin (it IS
 *     the auth service) and handles the 401 refresh-retry-redirect transparently —
 *     see `admin-ui/src/federation/remotes.d.ts` for the ambient module shape and
 *     `admin-ui/vitest.config.ts` for how tests resolve the bare specifier.
 *
 * Error handling:
 *   Non-2xx responses are parsed as RFC 7807 Problem JSON (mirrors
 *   estimatesApi.ts's `throwFromResponse` verbatim) and thrown as `ApiError` so
 *   callers can branch on `error.status` — every admin route can return `401`
 *   (no session) and `403` (authenticated but not `admin` — `requireAdmin`,
 *   AC-1.5); individual routes add `404`/`409`/`422` as noted per function below.
 *
 * Request-body shape for every "set the whole collection" PUT (`.../rules`,
 * `.../roles`, `.../members`, `.../departments`) is a **named-field wrapper
 * object** (`{ rules: [...] }`, `{ roleIds: [...] }`, …) rather than a bare JSON
 * array — consistent with this service's existing zod-openapi request-body
 * convention (auth's other routes all validate an object, never a bare array) and
 * easier to extend later without a breaking shape change. Pagination shape
 * (`page`/`pageSize` query params; `{ items, page, pageSize, total }` response) is
 * likewise a plan gap filled here with a conventional REST choice — see the
 * ADR-candidate note in this feature's implementation report.
 */

import { apiFetch } from 'shell/session'

// ---------------------------------------------------------------------------
// Shared shapes (mirrors the plan.md API contracts + Data model section)
// ---------------------------------------------------------------------------

/** Attribute condition targets — plan.md "conditions JSON shape" (AC-2.3). */
export type AttributeConditionKey = 'entity' | 'department' | 'jobTitle'

/** Condition types the catalog can declare as supported per action (AC-2.2/2.3). */
export type ConditionType = 'ownership' | AttributeConditionKey

/** AC-2.2 — "Any records" vs "Own records only". */
export type OwnershipCondition = 'own' | 'any'

/** One attribute constraint — plan.md: `match:"user"` = record attr must equal the actor's. */
export type AttributeCondition = {
  key: AttributeConditionKey
  match: 'user'
}

/** `permission_rule.conditions` — plan.md's "conditions JSON shape" (per rule). */
export type RuleConditions = {
  ownership?: OwnershipCondition
  attributes?: AttributeCondition[]
}

/** One (resource, action, conditions) rule — the unit a role bundles (AC-2.1). */
export type PermissionRule = {
  resource: string
  action: string
  conditions: RuleConditions | null
}

/** Request-body shape for a rule when composing/saving a role's rule set. */
export type PermissionRuleInput = PermissionRule

/** `entity` attribute values — Screen C2's select (design.md F4). */
export type UserEntity = 'welld_ch' | 'welld_it'

// --- Roles -------------------------------------------------------------------

export type Role = {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  /**
   * Number of permission_rules bundled by this role. Additive/optional field,
   * not in plan.md's literal `role` data model (which has no ruleCount
   * column) — added here for Screen A1's "rule count" table column
   * (design.md), pending T8's `GET /admin/roles` actually populating it.
   * List screens must render a `—` placeholder when this is absent rather
   * than assume it is always present (see RolesPage.tsx). Flagged in the
   * T17/T18 implementation report as a plan/design drift to route to the
   * architect: either amend plan.md's `GET /admin/roles` response shape to
   * include it, or drop the rule-count column from design.md.
   */
  ruleCount?: number
  createdAt: string
  updatedAt: string
}

/** `GET /admin/roles/:id` — a role plus its full rule set (Screen A2). */
export type RoleDetail = Role & {
  rules: PermissionRule[]
}

export type RoleCreateInput = {
  name: string
  description?: string | null
}

export type RolePatchInput = {
  name?: string
  description?: string | null
}

// --- Departments ---------------------------------------------------------------

export type Department = {
  id: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
}

/** A department member as embedded on `GET /admin/departments/:id` (design drift fix). */
export type DepartmentMember = {
  id: string
  name: string | null
  email: string
}

/** `GET /admin/departments/:id` embeds members — plan.md drift fix (T9). */
export type DepartmentDetail = Department & {
  roleIds: string[]
  members: DepartmentMember[]
}

export type DepartmentCreateInput = {
  name: string
  description?: string | null
}

export type DepartmentPatchInput = {
  name?: string
  description?: string | null
}

// --- Users -----------------------------------------------------------------

export type UserRoleRef = { id: string; name: string }
export type UserDepartmentRef = { id: string; name: string }

/** `GET /admin/users` list row. */
export type UserSummary = {
  id: string
  name: string | null
  email: string
  entity: UserEntity | null
  jobTitle: string | null
  roleCount: number
  departmentCount: number
}

/** `GET /admin/users/:id` — full detail (Screen C2). */
export type UserDetail = {
  id: string
  name: string | null
  email: string
  entity: UserEntity | null
  jobTitle: string | null
  roles: UserRoleRef[]
  departments: UserDepartmentRef[]
  createdAt: string
  updatedAt: string
}

export type UserPatchInput = {
  entity?: UserEntity | null
  jobTitle?: string | null
}

// --- Effective permissions (GET /authz/me + GET /admin/users/:id/permissions) --

/**
 * `GET /authz/me` response (AC-4.1) — also what `GET /admin/users/:id/permissions`
 * returns for an arbitrary user ("same shape as `/authz/me` minus identity" —
 * plan.md; there is no identity field in either response, the `:id` in the URL
 * is the only identity carried).
 */
export type EffectivePermissions = {
  epoch: number
  apps: string[]
  roles: string[]
  departments: string[]
  permissions: PermissionRule[]
}

// --- Catalog (GET /admin/catalog) -------------------------------------------

export type CatalogAction = {
  key: string
  label: string
  supportedConditions: ConditionType[]
}

export type CatalogResource = {
  key: string
  label: string
  actions: CatalogAction[]
}

/** One app's registered catalog entry (`catalog_resource`/`catalog_action`). */
export type CatalogApp = {
  appId: string
  resources: CatalogResource[]
}

/** `GET /admin/catalog` response — every registered app's resources/actions (AC-3.1). */
export type Catalog = CatalogApp[]

// --- Audit (GET /admin/audit) ------------------------------------------------

export type AuditLogEntry = {
  id: string
  actorUserId: string | null
  action: string
  targetType: string
  targetId: string | null
  summary: string
  data: { before?: unknown; after?: unknown } | null
  createdAt: string
}

// --- Pagination --------------------------------------------------------------

/** Shared paginated-list envelope for `GET /admin/users` and `GET /admin/audit`. */
export type Paginated<T> = {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export type PageParams = {
  page?: number
  pageSize?: number
}

export type UserListParams = PageParams & {
  /** Name/email search — plan.md drift fix (T10): "`?q=` search on name/email". */
  q?: string
}

/**
 * RFC 7807 Problem JSON shape — returned by the auth service for all non-2xx
 * responses (mirrors estimatesApi.ts's `ApiProblem` verbatim).
 */
export type ApiProblem = {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
}

// ---------------------------------------------------------------------------
// Typed error class
// ---------------------------------------------------------------------------

/**
 * Thrown by every adminApi function on a non-2xx response.
 *
 * Callers can check `error.status` to distinguish specific cases:
 *   • 401 — unauthenticated (handled upstream by apiFetch's refresh-retry, but
 *            included for completeness in case the redirect is suppressed)
 *   • 403 — authenticated but not an admin (`requireAdmin` — AC-1.5)
 *   • 404 — role/department/user not found
 *   • 409 — duplicate role/department name
 *   • 422 — off-catalog rule, unknown role, system-role delete, or the
 *            last-admin guard (AC-6.4)
 */
export class ApiError extends Error {
  readonly status: number
  readonly title: string
  readonly detail: string | undefined
  readonly instance: string | undefined

  constructor(problem: ApiProblem) {
    super(problem.title)
    this.name = 'ApiError'
    this.status = problem.status
    this.title = problem.title
    this.detail = problem.detail
    this.instance = problem.instance
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the base URL for the auth service — never hardcoded. */
const authBase = (): string => import.meta.env.VITE_AUTH_URL as string

/** Builds a `?a=1&b=2` query string, omitting undefined/empty values. */
const buildQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Parses a non-2xx Response as an RFC 7807 Problem and throws an `ApiError`.
 * If the response body cannot be parsed as a Problem object, a synthetic
 * Problem is constructed from the HTTP status (mirrors estimatesApi.ts).
 */
const throwFromResponse = async (response: Response): Promise<never> => {
  let problem: ApiProblem
  try {
    const body = (await response.json()) as Partial<ApiProblem>
    problem = {
      type: body.type ?? `https://httpstatuses.com/${response.status}`,
      title: body.title ?? response.statusText,
      status: body.status ?? response.status,
      detail: body.detail,
      instance: body.instance,
    }
  } catch {
    problem = {
      type: `https://httpstatuses.com/${response.status}`,
      title: response.statusText || String(response.status),
      status: response.status,
    }
  }
  throw new ApiError(problem)
}

const jsonHeaders = { 'Content-Type': 'application/json' }

/** GET helper — no body, throws ApiError on non-2xx. */
const getJson = async <T>(path: string): Promise<T> => {
  const response = await apiFetch(`${authBase()}${path}`)
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<T>
}

/** POST/PATCH/PUT helper — JSON body, throws ApiError on non-2xx. */
const sendJson = async <T>(path: string, method: string, body: unknown): Promise<T> => {
  const response = await apiFetch(`${authBase()}${path}`, {
    method,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Caller-facing
// ---------------------------------------------------------------------------

/**
 * GET /authz/me
 * The caller's own live effective permissions (AC-4.1, AC-3.3, AC-4.4).
 * Throws ApiError on 401 (no session).
 */
export const getMe = async (): Promise<EffectivePermissions> => getJson<EffectivePermissions>('/authz/me')

// ---------------------------------------------------------------------------
// Admin — roles
// ---------------------------------------------------------------------------

/** GET /admin/roles — list every role (system + custom). */
export const listRoles = async (): Promise<Role[]> => getJson<Role[]>('/admin/roles')

/**
 * POST /admin/roles
 * Creates a role. Returns the created role (201).
 * Throws ApiError on 409 (duplicate name), 403, or 401.
 */
export const createRole = async (body: RoleCreateInput): Promise<Role> =>
  sendJson<Role>('/admin/roles', 'POST', body)

/**
 * GET /admin/roles/:id
 * Returns the role plus its full rule set. Throws ApiError on 404, 403, or 401.
 */
export const getRole = async (id: string): Promise<RoleDetail> =>
  getJson<RoleDetail>(`/admin/roles/${id}`)

/**
 * PATCH /admin/roles/:id
 * Renames / redescribes a role. Throws ApiError on 404, 409, 403, or 401.
 */
export const patchRole = async (id: string, body: RolePatchInput): Promise<Role> =>
  sendJson<Role>(`/admin/roles/${id}`, 'PATCH', body)

/**
 * DELETE /admin/roles/:id
 * Deletes a custom role. Throws ApiError on 422 (isSystem role — AC-1.1),
 * 404, 403, or 401.
 */
export const deleteRole = async (id: string): Promise<void> => {
  const response = await apiFetch(`${authBase()}/admin/roles/${id}`, { method: 'DELETE' })
  if (!response.ok) {
    return throwFromResponse(response)
  }
}

/**
 * PUT /admin/roles/:id/rules
 * Sets the role's full rule set (from the catalog). Returns the updated role
 * detail. Throws ApiError on 422 (off-catalog resource/action pair, or a
 * condition not in `supportedConditions` — AC-2.1/3.2), 404, 403, or 401.
 */
export const putRoleRules = async (id: string, rules: PermissionRuleInput[]): Promise<RoleDetail> =>
  sendJson<RoleDetail>(`/admin/roles/${id}/rules`, 'PUT', { rules })

// ---------------------------------------------------------------------------
// Admin — departments
// ---------------------------------------------------------------------------

/** GET /admin/departments — list every department. */
export const listDepartments = async (): Promise<Department[]> =>
  getJson<Department[]>('/admin/departments')

/**
 * POST /admin/departments
 * Creates a department. Returns the created department (201).
 * Throws ApiError on 409 (duplicate name), 403, or 401.
 */
export const createDepartment = async (body: DepartmentCreateInput): Promise<Department> =>
  sendJson<Department>('/admin/departments', 'POST', body)

/**
 * GET /admin/departments/:id
 * Returns the department with its conferred roleIds and embedded member list
 * (design drift fix, T9). Throws ApiError on 404, 403, or 401.
 */
export const getDepartment = async (id: string): Promise<DepartmentDetail> =>
  getJson<DepartmentDetail>(`/admin/departments/${id}`)

/**
 * PATCH /admin/departments/:id
 * Renames / redescribes a department. Throws ApiError on 404, 409, 403, or 401.
 */
export const patchDepartment = async (
  id: string,
  body: DepartmentPatchInput,
): Promise<Department> => sendJson<Department>(`/admin/departments/${id}`, 'PATCH', body)

/**
 * DELETE /admin/departments/:id
 * Throws ApiError on 404, 403, or 401.
 */
export const deleteDepartment = async (id: string): Promise<void> => {
  const response = await apiFetch(`${authBase()}/admin/departments/${id}`, { method: 'DELETE' })
  if (!response.ok) {
    return throwFromResponse(response)
  }
}

/**
 * PUT /admin/departments/:id/roles
 * Sets the roles this department confers to its members. Throws ApiError on
 * 422 (unknown role), 404, 403, or 401.
 */
export const putDepartmentRoles = async (id: string, roleIds: string[]): Promise<DepartmentDetail> =>
  sendJson<DepartmentDetail>(`/admin/departments/${id}/roles`, 'PUT', { roleIds })

/**
 * PUT /admin/departments/:id/members
 * Sets the department's members from the department side (design drift fix,
 * T9 — symmetric with the user-side `putUserDepartments`). Bumps affected
 * epochs. Throws ApiError on 404, 403, or 401.
 */
export const putDepartmentMembers = async (id: string, userIds: string[]): Promise<DepartmentDetail> =>
  sendJson<DepartmentDetail>(`/admin/departments/${id}/members`, 'PUT', { userIds })

// ---------------------------------------------------------------------------
// Admin — users
// ---------------------------------------------------------------------------

/**
 * GET /admin/users
 * Paginated user list, optionally filtered by name/email (`?q=` — design
 * drift fix, T10). Throws ApiError on 403 or 401.
 */
export const listUsers = async (params: UserListParams = {}): Promise<Paginated<UserSummary>> =>
  getJson<Paginated<UserSummary>>(
    `/admin/users${buildQuery({ q: params.q, page: params.page, pageSize: params.pageSize })}`,
  )

/**
 * GET /admin/users/:id
 * Returns a user's attributes, roles, and departments. Throws ApiError on
 * 404, 403, or 401.
 */
export const getUser = async (id: string): Promise<UserDetail> =>
  getJson<UserDetail>(`/admin/users/${id}`)

/**
 * PATCH /admin/users/:id
 * Sets `entity`/`jobTitle`. Throws ApiError on 404, 400 (invalid `entity`
 * enum), 403, or 401.
 */
export const patchUser = async (id: string, body: UserPatchInput): Promise<UserDetail> =>
  sendJson<UserDetail>(`/admin/users/${id}`, 'PATCH', body)

/**
 * PUT /admin/users/:id/roles
 * (Re)assigns the user's direct roles. Throws ApiError on 422 (last-admin
 * guard — AC-6.4), 404, 403, or 401.
 */
export const putUserRoles = async (id: string, roleIds: string[]): Promise<UserDetail> =>
  sendJson<UserDetail>(`/admin/users/${id}/roles`, 'PUT', { roleIds })

/**
 * PUT /admin/users/:id/departments
 * (Re)assigns the user's departments. Throws ApiError on 422 (last-admin
 * guard, if the user's only admin path was department-derived — AC-6.4),
 * 404, 403, or 401.
 */
export const putUserDepartments = async (id: string, departmentIds: string[]): Promise<UserDetail> =>
  sendJson<UserDetail>(`/admin/users/${id}/departments`, 'PUT', { departmentIds })

/**
 * GET /admin/users/:id/permissions
 * A user's resolved effective permissions (the resolver output for any user —
 * design drift fix, T10; lets an admin verify what an assignment produces).
 * Admin-only. Throws ApiError on 404, 403, or 401.
 */
export const getUserPermissions = async (id: string): Promise<EffectivePermissions> =>
  getJson<EffectivePermissions>(`/admin/users/${id}/permissions`)

// ---------------------------------------------------------------------------
// Admin — catalog
// ---------------------------------------------------------------------------

/**
 * GET /admin/catalog
 * Every registered app's resources, actions, and supported condition types —
 * feeds the rule-builder's catalog-driven selects (AC-3.1, AC-3.3). Throws
 * ApiError on 403 or 401.
 */
export const getCatalog = async (): Promise<Catalog> => getJson<Catalog>('/admin/catalog')

// ---------------------------------------------------------------------------
// Admin — audit
// ---------------------------------------------------------------------------

/**
 * GET /admin/audit
 * Paginated, reverse-chronological authorization-change history (AC-5.2).
 * Read-only — no mutate route exists (AC-5.3). Throws ApiError on 403 or 401.
 */
export const listAudit = async (params: PageParams = {}): Promise<Paginated<AuditLogEntry>> =>
  getJson<Paginated<AuditLogEntry>>(
    `/admin/audit${buildQuery({ page: params.page, pageSize: params.pageSize })}`,
  )
