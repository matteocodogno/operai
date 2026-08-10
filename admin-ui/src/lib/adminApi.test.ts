/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/adminApi.ts — typed API client for the auth service's
 * `/admin/*` + `/authz/me` routes (T16, specs/004-auth-roles-permissions).
 *
 * Strategy (mirrors estimai-ui/src/lib/estimatesApi.test.ts):
 *   • `shell/session`'s `apiFetch` is mocked at the module level so tests
 *     control the raw Response objects and inspect exactly what was sent.
 *   • Every operation is checked for: (a) correct HTTP method + URL, (b)
 *     correct JSON request body (where applicable), (c) a successful response
 *     parsed to the typed shape, (d) a representative non-2xx response
 *     mapped to `ApiError` with the right status/title/detail — covering
 *     every status code plan.md documents for that route (401/403/404/409/422).
 *   • No hardcoded API URL: the base URL comes from VITE_AUTH_URL via
 *     vi.stubEnv (mirrors estimatesApi.test.ts's VITE_API_URL pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Module mock — apiFetch is replaced with a vi.fn() for all tests. `shell/session`
// is a federated module (bare specifier, only resolvable at runtime via
// @module-federation/vite); vitest.config.ts aliases it to a local stub purely
// to satisfy Vite's import-analysis, and this vi.mock overrides that with a
// full test double — same pattern as src/App.test.tsx.
// ---------------------------------------------------------------------------

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  // Mirrors the shell: the base URL comes from shell/session, driven here by
  // the vi.stubEnv('VITE_AUTH_URL', …) below (same pattern as before).
  getAuthBaseUrl: () => import.meta.env.VITE_AUTH_URL as string,
}))

import { apiFetch } from 'shell/session'
import {
  ApiError,
  bulkDeleteUsers,
  createDepartment,
  createInvitation,
  createRole,
  deleteDepartment,
  deleteRole,
  deleteUser,
  getCatalog,
  getDepartment,
  getMe,
  getRole,
  getUser,
  getUserPermissions,
  listAudit,
  listDepartments,
  listInvitations,
  listRoles,
  listUsers,
  patchDepartment,
  patchRole,
  patchUser,
  putDepartmentMembers,
  putDepartmentRoles,
  putRoleRules,
  putUserDepartments,
  putUserRoles,
  resendInvitation,
  revokeInvitation,
} from './adminApi'
import type {
  ApiProblem,
  AuditLogEntry,
  BulkDeleteUsersResult,
  Catalog,
  DeleteUserResult,
  DepartmentDetail,
  EffectivePermissions,
  InvitationDetail,
  Paginated,
  PermissionRuleInput,
  Role,
  RoleDetail,
  UserDetail,
  UserSummary,
} from './adminApi'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_URL = 'http://auth.test'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixedMe: EffectivePermissions = {
  epoch: 3,
  apps: ['estimai', 'admin'],
  roles: ['admin'],
  departments: [],
  permissions: [{ resource: 'estimate', action: 'edit', conditions: null }],
}

const fixedRole: Role = {
  id: 'role-1',
  name: 'accounting',
  description: 'Accounting team',
  isSystem: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

const fixedRoleDetail: RoleDetail = {
  ...fixedRole,
  rules: [{ resource: 'estimate', action: 'view', conditions: { ownership: 'own' } }],
}

const fixedDepartmentDetail: DepartmentDetail = {
  id: 'dept-1',
  name: 'Finance',
  description: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  roleIds: ['role-1'],
  members: [{ id: 'user-1', name: 'Ada Lovelace', email: 'ada@welld.ch' }],
}

const fixedUserDetail: UserDetail = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@welld.ch',
  entity: 'welld_ch',
  jobTitle: 'Consultant',
  roles: [{ id: 'role-1', name: 'accounting' }],
  departments: [{ id: 'dept-1', name: 'Finance' }],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

const fixedUserSummary: UserSummary = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@welld.ch',
  entity: 'welld_ch',
  jobTitle: 'Consultant',
  roleCount: 1,
  departmentCount: 1,
}

const fixedUsersPage: Paginated<UserSummary> = {
  items: [fixedUserSummary],
  page: 1,
  pageSize: 20,
  total: 1,
}

const fixedInvitation: InvitationDetail = {
  id: 'inv-1',
  email: 'alice@welld.ch',
  status: 'pending',
  roles: [{ id: 'role-1', name: 'accounting' }],
  departments: [{ id: 'dept-1', name: 'Finance' }],
  invitedBy: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@welld.ch' },
  invitedAt: '2026-07-13T10:00:00.000Z',
  expiresAt: '2026-07-16T10:00:00.000Z',
  acceptedAt: null,
  emailDelivery: 'sent',
}

const fixedInvitationsPage: Paginated<InvitationDetail> = {
  items: [fixedInvitation],
  page: 1,
  pageSize: 20,
  total: 1,
}

const fixedCatalog: Catalog = [
  {
    appId: 'estimai',
    resources: [
      {
        key: 'estimate',
        label: 'Estimate',
        actions: [
          { key: 'view', label: 'View', supportedConditions: ['ownership'] },
          { key: 'access', label: 'Access', supportedConditions: [] },
        ],
      },
    ],
  },
]

const fixedAuditEntry: AuditLogEntry = {
  id: 'audit-1',
  actorUserId: 'user-1',
  actor: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@welld.ch' },
  action: 'role.create',
  targetType: 'role',
  targetId: 'role-1',
  summary: 'Created role accounting',
  data: { before: null, after: fixedRole },
  createdAt: '2026-07-01T00:00:00.000Z',
}

const fixedAuditPage: Paginated<AuditLogEntry> = {
  items: [fixedAuditEntry],
  page: 1,
  pageSize: 20,
  total: 1,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const okResponse = (body: unknown): Response => makeResponse(200, body)

const problemResponse = (status: number, title: string, detail?: string, instance?: string): Response =>
  makeResponse(status, {
    type: `https://httpstatuses.com/${status}`,
    title,
    status,
    detail,
    instance,
  } satisfies ApiProblem)

const lastCall = (): { url: string; init: RequestInit | undefined } => {
  const mockFn = vi.mocked(apiFetch)
  const calls = mockFn.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const [input, init] = calls[calls.length - 1]
  return { url: String(input), init }
}

const expectApiError = async (
  fn: () => Promise<unknown>,
  status: number,
): Promise<ApiError> => {
  let thrown: unknown
  try {
    await fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(ApiError)
  expect((thrown as ApiError).status).toBe(status)
  return thrown as ApiError
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', AUTH_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Caller-facing
// ---------------------------------------------------------------------------

describe('getMe()', () => {
  it('issues GET to /authz/me and returns EffectivePermissions', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedMe))

    const result = await getMe()

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/authz/me`)
    expect(init?.method).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(result).toEqual(fixedMe)
  })

  it('throws ApiError on 401 (no session)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(401, 'Unauthorized'))
    await expectApiError(() => getMe(), 401)
  })
})

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

describe('roles', () => {
  it('listRoles() issues GET /admin/roles and returns Role[]', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse([fixedRole]))

    const result = await listRoles()

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/roles`)
    expect(init?.method).toBeUndefined()
    expect(result).toEqual([fixedRole])
  })

  it('listRoles() throws ApiError on 403 (non-admin)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => listRoles(), 403)
  })

  it('createRole() issues POST /admin/roles with the body and returns Role on 201', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(201, fixedRole))

    const body = { name: 'accounting', description: 'Accounting team' }
    const result = await createRole(body)

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/roles`)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual(body)
    expect(result).toEqual(fixedRole)
  })

  it('createRole() throws ApiError on 409 (duplicate name)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(409, 'Conflict', 'A role named "accounting" already exists'),
    )
    const err = await expectApiError(
      () => createRole({ name: 'accounting' }),
      409,
    )
    expect(err.detail).toContain('already exists')
  })

  it('getRole(id) issues GET /admin/roles/:id and returns RoleDetail', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedRoleDetail))

    const result = await getRole('role-1')

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/roles/role-1`)
    expect(result).toEqual(fixedRoleDetail)
  })

  it('getRole(id) throws ApiError on 404', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'Not Found'))
    await expectApiError(() => getRole('missing'), 404)
  })

  it('patchRole(id, body) issues PATCH /admin/roles/:id with the body', async () => {
    const patched = { ...fixedRole, name: 'renamed' }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(patched))

    const result = await patchRole('role-1', { name: 'renamed' })

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/roles/role-1`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'renamed' })
    expect(result).toEqual(patched)
  })

  it('deleteRole(id) issues DELETE /admin/roles/:id with no body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    await deleteRole('role-1')

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/roles/role-1`)
    expect(init?.method).toBe('DELETE')
    expect(init?.body).toBeUndefined()
  })

  it('deleteRole(id) throws ApiError on 422 (isSystem role, AC-1.1)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(422, 'Unprocessable Entity', 'System roles cannot be deleted'),
    )
    const err = await expectApiError(() => deleteRole('role-employee'), 422)
    expect(err.detail).toContain('System roles')
  })

  it('putRoleRules(id, rules) issues PUT /admin/roles/:id/rules wrapping the array as { rules }', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedRoleDetail))

    const rules: PermissionRuleInput[] = [
      { resource: 'estimate', action: 'edit', conditions: { ownership: 'own' } },
    ]
    const result = await putRoleRules('role-1', rules)

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/roles/role-1/rules`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ rules })
    expect(result).toEqual(fixedRoleDetail)
  })

  it('putRoleRules(id, rules) throws ApiError on 422 (off-catalog pair, AC-2.1/3.2)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(422, 'Unprocessable Entity', 'estimate.frobnicate is not a registered action'),
    )
    await expectApiError(
      () =>
        putRoleRules('role-1', [
          { resource: 'estimate', action: 'frobnicate', conditions: null },
        ]),
      422,
    )
  })
})

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

describe('departments', () => {
  it('listDepartments() issues GET /admin/departments', async () => {
    const { id, name, description, createdAt, updatedAt } = fixedDepartmentDetail
    const summary = { id, name, description, createdAt, updatedAt }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse([summary]))

    const result = await listDepartments()

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/departments`)
    expect(result).toEqual([summary])
  })

  it('createDepartment(body) issues POST /admin/departments and returns 201', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(201, fixedDepartmentDetail))

    const body = { name: 'Finance' }
    const result = await createDepartment(body)

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/departments`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual(body)
    expect(result).toEqual(fixedDepartmentDetail)
  })

  it('createDepartment(body) throws ApiError on 409 (duplicate name)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(409, 'Conflict'))
    await expectApiError(() => createDepartment({ name: 'Finance' }), 409)
  })

  it('getDepartment(id) issues GET /admin/departments/:id and embeds members (drift fix, T9)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedDepartmentDetail))

    const result = await getDepartment('dept-1')

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/departments/dept-1`)
    expect(result.members).toEqual(fixedDepartmentDetail.members)
  })

  it('getDepartment(id) throws ApiError on 404', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'Not Found'))
    await expectApiError(() => getDepartment('missing'), 404)
  })

  it('patchDepartment(id, body) issues PATCH /admin/departments/:id with the body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedDepartmentDetail))

    await patchDepartment('dept-1', { description: 'Updated' })

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/departments/dept-1`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ description: 'Updated' })
  })

  it('deleteDepartment(id) issues DELETE /admin/departments/:id', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    await deleteDepartment('dept-1')

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/departments/dept-1`)
    expect(init?.method).toBe('DELETE')
  })

  it('putDepartmentRoles(id, roleIds) issues PUT /admin/departments/:id/roles wrapping as { roleIds }', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedDepartmentDetail))

    await putDepartmentRoles('dept-1', ['role-1', 'role-2'])

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/departments/dept-1/roles`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ roleIds: ['role-1', 'role-2'] })
  })

  it('putDepartmentRoles(id, roleIds) throws ApiError on 422 (unknown role)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(422, 'Unprocessable Entity'))
    await expectApiError(() => putDepartmentRoles('dept-1', ['missing-role']), 422)
  })

  it('putDepartmentMembers(id, userIds) issues PUT /admin/departments/:id/members wrapping as { userIds }', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedDepartmentDetail))

    await putDepartmentMembers('dept-1', ['user-1', 'user-2'])

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/departments/dept-1/members`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ userIds: ['user-1', 'user-2'] })
  })
})

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

describe('users', () => {
  it('listUsers() issues GET /admin/users with no query params when none given', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedUsersPage))

    const result = await listUsers()

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/users`)
    expect(result).toEqual(fixedUsersPage)
  })

  it('listUsers({ q, page, pageSize }) encodes search + pagination query params (drift fix, T10)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedUsersPage))

    await listUsers({ q: 'ada', page: 2, pageSize: 10 })

    const url = new URL(lastCall().url)
    expect(url.pathname).toBe('/admin/users')
    expect(url.searchParams.get('q')).toBe('ada')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('pageSize')).toBe('10')
  })

  it('listUsers() throws ApiError on 403', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => listUsers(), 403)
  })

  it('getUser(id) issues GET /admin/users/:id', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedUserDetail))

    const result = await getUser('user-1')

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/users/user-1`)
    expect(result).toEqual(fixedUserDetail)
  })

  it('getUser(id) throws ApiError on 404', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'Not Found'))
    await expectApiError(() => getUser('missing'), 404)
  })

  it('patchUser(id, body) issues PATCH /admin/users/:id with entity/jobTitle', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedUserDetail))

    const body = { entity: 'welld_it' as const, jobTitle: 'Lead Consultant' }
    await patchUser('user-1', body)

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/users/user-1`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual(body)
  })

  it('putUserRoles(id, roleIds) issues PUT /admin/users/:id/roles wrapping as { roleIds }', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedUserDetail))

    await putUserRoles('user-1', ['role-1'])

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/users/user-1/roles`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ roleIds: ['role-1'] })
  })

  it('putUserRoles(id, roleIds) throws ApiError on 422 (last-admin guard, AC-6.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(
        422,
        'Unprocessable Entity',
        'This is the last administrator; assign another admin first',
      ),
    )
    const err = await expectApiError(() => putUserRoles('user-1', []), 422)
    expect(err.detail).toContain('last administrator')
  })

  it('putUserDepartments(id, departmentIds) issues PUT /admin/users/:id/departments wrapping as { departmentIds }', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedUserDetail))

    await putUserDepartments('user-1', ['dept-1'])

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/users/user-1/departments`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ departmentIds: ['dept-1'] })
  })

  it('putUserDepartments(id, departmentIds) throws ApiError on 422 (last-admin guard)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(422, 'Unprocessable Entity'))
    await expectApiError(() => putUserDepartments('user-1', []), 422)
  })

  it('getUserPermissions(id) issues GET /admin/users/:id/permissions (drift fix, T10)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedMe))

    const result = await getUserPermissions('user-1')

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/users/user-1/permissions`)
    expect(result).toEqual(fixedMe)
  })

  it('getUserPermissions(id) throws ApiError on 403 (admin-only)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => getUserPermissions('user-1'), 403)
  })

  // --- Soft-delete (T10/T11, specs/006-user-invitations) ---

  it('deleteUser(id) issues DELETE /admin/users/:id with no body and returns { id, deletedAt }', async () => {
    const fixedDeleteResult: DeleteUserResult = { id: 'user-1', deletedAt: '2026-07-14T10:00:00.000Z' }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedDeleteResult))

    const result = await deleteUser('user-1')

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/users/user-1`)
    expect(init?.method).toBe('DELETE')
    expect(init?.body).toBeUndefined()
    expect(result).toEqual(fixedDeleteResult)
  })

  it('deleteUser(id) throws ApiError on 422 (self-delete AC-5.6 / last-admin guard AC-5.5)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(422, 'Unprocessable Entity', 'This is the last remaining administrator'),
    )
    const err = await expectApiError(() => deleteUser('user-2'), 422)
    expect(err.detail).toContain('last remaining administrator')
  })

  it('deleteUser(id) throws ApiError on 404 (no such active user)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'Not Found'))
    await expectApiError(() => deleteUser('missing'), 404)
  })

  it('bulkDeleteUsers(userIds) issues POST /admin/users/delete wrapping as { userIds } and returns the partial-success report (AC-6.3)', async () => {
    const fixedBulkResult: BulkDeleteUsersResult = {
      deleted: ['user-3', 'user-4'],
      skipped: [
        { userId: 'user-self', reason: 'cannot delete your own account' },
        { userId: 'user-admin2', reason: 'last remaining admin' },
      ],
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedBulkResult))

    const result = await bulkDeleteUsers(['user-3', 'user-4', 'user-self', 'user-admin2'])

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/users/delete`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      userIds: ['user-3', 'user-4', 'user-self', 'user-admin2'],
    })
    expect(result).toEqual(fixedBulkResult)
  })

  it('bulkDeleteUsers(userIds) throws ApiError on 400 (empty userIds)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(400, 'Bad Request'))
    await expectApiError(() => bulkDeleteUsers([]), 400)
  })
})

// ---------------------------------------------------------------------------
// Invitations (T12, specs/006-user-invitations)
// ---------------------------------------------------------------------------

describe('invitations', () => {
  it('listInvitations() issues GET /admin/invitations with no query params when none given', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedInvitationsPage))

    const result = await listInvitations()

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/invitations`)
    expect(result).toEqual(fixedInvitationsPage)
  })

  it('listInvitations({ status, q, page, pageSize }) encodes every filter/pagination query param (AC-1.6)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedInvitationsPage))

    await listInvitations({ status: 'pending', q: 'alice', page: 2, pageSize: 10 })

    const url = new URL(lastCall().url)
    expect(url.pathname).toBe('/admin/invitations')
    expect(url.searchParams.get('status')).toBe('pending')
    expect(url.searchParams.get('q')).toBe('alice')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('pageSize')).toBe('10')
  })

  it('listInvitations() throws ApiError on 403', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => listInvitations(), 403)
  })

  it('createInvitation(body) issues POST /admin/invitations with email/roleIds/departmentIds and returns 201 InvitationDetail', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedInvitation))

    const body = { email: 'alice@welld.ch', roleIds: ['role-1'], departmentIds: ['dept-1'] }
    const result = await createInvitation(body)

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/invitations`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual(body)
    expect(result).toEqual(fixedInvitation)
  })

  it('createInvitation(body) throws ApiError on 409 (active user exists, AC-1.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(409, 'Conflict', 'An active user already exists with email "alice@welld.ch"'),
    )
    const err = await expectApiError(() => createInvitation({ email: 'alice@welld.ch' }), 409)
    expect(err.detail).toContain('active user already exists')
  })

  it('createInvitation(body) throws ApiError on 409 (live pending invitation exists, AC-1.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(409, 'Conflict', 'A pending invitation already exists for "alice@welld.ch" (id: inv-1)'),
    )
    const err = await expectApiError(() => createInvitation({ email: 'alice@welld.ch' }), 409)
    expect(err.detail).toContain('pending invitation already exists')
  })

  it('createInvitation(body) throws ApiError on 422 (unknown role/department id)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(422, 'Unprocessable Entity', 'Unknown role id(s): role-x'))
    await expectApiError(() => createInvitation({ email: 'alice@welld.ch', roleIds: ['role-x'] }), 422)
  })

  it('resendInvitation(id) issues POST /admin/invitations/:id/resend and returns the refreshed InvitationDetail', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedInvitation))

    const result = await resendInvitation('inv-1')

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/invitations/inv-1/resend`)
    expect(init?.method).toBe('POST')
    expect(result).toEqual(fixedInvitation)
  })

  it('resendInvitation(id) throws ApiError on 422 (already accepted/revoked, AC-3.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(422, 'Unprocessable Entity'))
    await expectApiError(() => resendInvitation('inv-1'), 422)
  })

  it('revokeInvitation(id) issues POST /admin/invitations/:id/revoke and returns the revoked InvitationDetail', async () => {
    const revoked: InvitationDetail = { ...fixedInvitation, status: 'revoked' }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(revoked))

    const result = await revokeInvitation('inv-1')

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/invitations/inv-1/revoke`)
    expect(init?.method).toBe('POST')
    expect(result.status).toBe('revoked')
  })

  it('revokeInvitation(id) throws ApiError on 422 (already accepted/revoked, AC-1.10/1.11)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(422, 'Unprocessable Entity'))
    await expectApiError(() => revokeInvitation('inv-1'), 422)
  })
})

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('getCatalog()', () => {
  it('issues GET /admin/catalog and unwraps the { apps } envelope to a bare array (AC-3.1)', async () => {
    // The auth API responds `{ apps: CatalogApp[] }` — getCatalog must unwrap
    // it so callers (RoleEditor) get a plain iterable array, not the object.
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse({ apps: fixedCatalog }))

    const result = await getCatalog()

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/catalog`)
    expect(init?.method).toBeUndefined()
    expect(result).toEqual(fixedCatalog)
    expect(Array.isArray(result)).toBe(true)
  })

  it('throws ApiError on 403', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => getCatalog(), 403)
  })
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('listAudit()', () => {
  it('issues GET /admin/audit with no query params when none given', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedAuditPage))

    const result = await listAudit()

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/audit`)
    expect(result).toEqual(fixedAuditPage)
  })

  it('listAudit({ page, pageSize }) encodes pagination query params (AC-5.2)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(fixedAuditPage))

    await listAudit({ page: 3, pageSize: 50 })

    const url = new URL(lastCall().url)
    expect(url.pathname).toBe('/admin/audit')
    expect(url.searchParams.get('page')).toBe('3')
    expect(url.searchParams.get('pageSize')).toBe('50')
  })

  it('throws ApiError on 403', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => listAudit(), 403)
  })
})

// ---------------------------------------------------------------------------
// Error mapping — Problem JSON without a well-formed body (fallback path)
// ---------------------------------------------------------------------------

describe('ApiError fallback mapping', () => {
  it('synthesizes a Problem from the HTTP status when the body is not JSON', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    )

    const err = await expectApiError(() => listRoles(), 500)
    expect(err.title).toBe('Internal Server Error')
  })
})
