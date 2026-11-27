/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/adminApi.ts — typed API client for the auth service's
 * `/admin/*` + `/authz/me` routes (T16, specs/20260713-auth-roles-permissions).
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
  approveAccessRequest,
  bulkDeleteUsers,
  createDepartment,
  createInvitation,
  createRole,
  addTeamMember,
  archiveTeam,
  createTeam,
  deleteDepartment,
  deleteRole,
  deleteUser,
  getCatalog,
  getDepartment,
  getRole,
  getTeam,
  getUser,
  getUserPermissions,
  listAccessRequests,
  listAudit,
  listDepartments,
  isVersionConflict,
  listTeams,
  listInvitations,
  listRoles,
  listUsers,
  patchDepartment,
  patchTeam,
  removeTeamMember,
  restoreTeam,
  patchRole,
  patchUser,
  putDepartmentMembers,
  putDepartmentRoles,
  putRoleRules,
  putUserDepartments,
  putUserRoles,
  rejectAccessRequest,
  resendInvitation,
  revokeInvitation,
  teamNameClash,
} from './adminApi'
import type {
  AccessRequestDetail,
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
  roles: ['Employee'],
  departments: ['Engineering'],
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

const expectApiError = async (fn: () => Promise<unknown>, status: number): Promise<ApiError> => {
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
    const err = await expectApiError(() => createRole({ name: 'accounting' }), 409)
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

    const rules: PermissionRuleInput[] = [{ resource: 'estimate', action: 'edit', conditions: { ownership: 'own' } }]
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
      () => putRoleRules('role-1', [{ resource: 'estimate', action: 'frobnicate', conditions: null }]),
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
      problemResponse(422, 'Unprocessable Entity', 'This is the last administrator; assign another admin first'),
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

  // --- Soft-delete (T10/T11, specs/20260713-user-invitations) ---

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
// Invitations (T12, specs/20260713-user-invitations)
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
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(422, 'Unprocessable Entity', 'Unknown role id(s): role-x'),
    )
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

// ---------------------------------------------------------------------------
// Problem codes + access requests (T8, specs/20261105-signup-gate)
// ---------------------------------------------------------------------------

describe('ApiError problem extensions (specs/20261105-signup-gate T8)', () => {
  it('copies code and allowedDomains from the problem body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(422, {
        type: 'https://httpstatuses.com/422',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Invitations can only be sent to welld.ch, welld.it addresses',
        code: 'domain_not_allowed',
        allowedDomains: ['welld.ch', 'welld.it'],
      }),
    )
    const err = await expectApiError(() => createInvitation({ email: 'x@gmail.com' }), 422)
    expect(err.code).toBe('domain_not_allowed')
    expect(err.allowedDomains).toEqual(['welld.ch', 'welld.it'])
  })

  it('leaves code and allowedDomains undefined when absent, and ignores malformed values', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(409, 'Conflict', 'nope'))
    const plain = await expectApiError(() => createInvitation({ email: 'a@welld.ch' }), 409)
    expect(plain.code).toBeUndefined()
    expect(plain.allowedDomains).toBeUndefined()

    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(422, { title: 'x', status: 422, code: 42, allowedDomains: 'welld.ch' }),
    )
    const bad = await expectApiError(() => createInvitation({ email: 'a@welld.ch' }), 422)
    expect(bad.code).toBeUndefined()
    expect(bad.allowedDomains).toBeUndefined()
  })
})

const fixedAccessRequest: AccessRequestDetail = {
  id: 'ar-1',
  email: 'new@welld.ch',
  name: 'New Person',
  provider: 'google',
  status: 'pending',
  firstRequestedAt: '2026-11-05T08:00:00.000Z',
  requestedAt: '2026-11-05T09:00:00.000Z',
  decidedAt: null,
  decidedBy: null,
  invitationId: null,
}

describe('access requests client (specs/20261105-signup-gate T8)', () => {
  it('listAccessRequests() defaults to no query and returns the page', async () => {
    const page = { items: [fixedAccessRequest], page: 1, pageSize: 20, total: 1 }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(page))
    const result = await listAccessRequests()
    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/access-requests`)
    expect(init?.method).toBeUndefined()
    expect(result).toEqual(page)
  })

  it('listAccessRequests(params) sends status, page and pageSize', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse({ items: [], page: 2, pageSize: 50, total: 0 }))
    await listAccessRequests({ status: 'rejected', page: 2, pageSize: 50 })
    const url = new URL(lastCall().url)
    expect(url.pathname).toBe('/admin/access-requests')
    expect(url.searchParams.get('status')).toBe('rejected')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('pageSize')).toBe('50')
  })

  it('listAccessRequests() maps 403 to ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => listAccessRequests(), 403)
  })

  it('approveAccessRequest(id, body) POSTs roleIds/departmentIds and returns request + invitation', async () => {
    const approved = { ...fixedAccessRequest, status: 'approved' as const, invitationId: 'inv-1' }
    const result = { request: approved, invitation: fixedInvitation }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(result))
    const out = await approveAccessRequest('ar-1', { roleIds: ['role-1'], departmentIds: ['dept-1'] })
    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/access-requests/ar-1/approve`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ roleIds: ['role-1'], departmentIds: ['dept-1'] })
    expect(out).toEqual(result)
  })

  it('approveAccessRequest(id) with no selection sends an empty object body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse({ request: fixedAccessRequest, invitation: fixedInvitation }))
    await approveAccessRequest('ar-1')
    expect(JSON.parse(lastCall().init?.body as string)).toEqual({})
  })

  it.each(['already_decided', 'active_user_exists', 'pending_invitation_exists'])(
    'approveAccessRequest() exposes the 409 code %s',
    async (code) => {
      vi.mocked(apiFetch).mockResolvedValueOnce(
        makeResponse(409, { title: 'Conflict', status: 409, detail: 'prose', code }),
      )
      const err = await expectApiError(() => approveAccessRequest('ar-1'), 409)
      expect(err.code).toBe(code)
    },
  )

  it('approveAccessRequest() exposes the defensive 422 domain_not_allowed with allowedDomains', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(422, {
        title: 'Unprocessable Entity',
        status: 422,
        code: 'domain_not_allowed',
        allowedDomains: ['welld.ch'],
      }),
    )
    const err = await expectApiError(() => approveAccessRequest('ar-1'), 422)
    expect(err.code).toBe('domain_not_allowed')
    expect(err.allowedDomains).toEqual(['welld.ch'])
  })

  it('approveAccessRequest() maps 404 to ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'Not Found'))
    await expectApiError(() => approveAccessRequest('nope'), 404)
  })

  it('rejectAccessRequest(id) POSTs with no body and returns the decided request', async () => {
    const rejected = { ...fixedAccessRequest, status: 'rejected' as const }
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(rejected))
    const out = await rejectAccessRequest('ar-1')
    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/access-requests/ar-1/reject`)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
    expect(out).toEqual(rejected)
  })

  it('rejectAccessRequest() exposes 409 already_decided and maps 404', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(409, { title: 'Conflict', status: 409, code: 'already_decided' }),
    )
    const err = await expectApiError(() => rejectAccessRequest('ar-1'), 409)
    expect(err.code).toBe('already_decided')
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(404, 'Not Found'))
    await expectApiError(() => rejectAccessRequest('nope'), 404)
  })
})

describe('teams (specs/20261126-teams T4)', () => {
  const summary = {
    id: 't1',
    name: 'Backend',
    description: null,
    archived: false,
    activeMemberCount: 2,
    version: 1,
  }
  const detail = { ...summary, createdAt: '2026-11-26T09:00:00.000Z', updatedAt: '2026-11-26T09:00:00.000Z', members: [] }

  it('listTeams issues GET /admin/teams and returns the items, archived included', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse({ items: [summary, { ...summary, id: 't2', archived: true }] }))

    const result = await listTeams()

    expect(lastCall().url).toBe(`${AUTH_URL}/admin/teams`)
    expect(lastCall().init?.method ?? 'GET').toBe('GET')
    expect(result.map((team) => team.id)).toEqual(['t1', 't2'])
  })

  it('createTeam issues POST /admin/teams with the body and returns the 201 detail', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(201, detail))

    const result = await createTeam({ name: 'Backend', description: 'Builds it' })

    const { url, init } = lastCall()
    expect(url).toBe(`${AUTH_URL}/admin/teams`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'Backend', description: 'Builds it' })
    expect(result).toEqual(detail)
  })

  it('a 409 team_name_taken carries code and existingName on the ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(409, {
        type: 'x',
        title: 'Conflict',
        status: 409,
        code: 'team_name_taken',
        detail: 'English only',
        existingName: 'BACKEND',
      }),
    )
    const err = await expectApiError(() => createTeam({ name: 'backend' }), 409)
    expect(err.code).toBe('team_name_taken')
    expect(err.existingName).toBe('BACKEND')
  })

  it('a 409 without a string existingName leaves it undefined, and currentVersion is read only as an integer', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(409, { title: 'Conflict', status: 409, code: 'team_name_taken', existingName: 7, currentVersion: '3' }),
    )
    const err = await expectApiError(() => createTeam({ name: 'x' }), 409)
    expect(err.existingName).toBeUndefined()
    expect(err.currentVersion).toBeUndefined()

    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(409, { title: 'Conflict', status: 409, code: 'version_conflict', currentVersion: 4 }))
    const stale = await expectApiError(() => createTeam({ name: 'x' }), 409)
    expect(stale.currentVersion).toBe(4)
  })

  it('teamNameClash returns the existing name only for a 409 team_name_taken that carries one', () => {
    const problem = { type: 't', title: 'Conflict', status: 409, code: 'team_name_taken', existingName: 'Backend' }
    expect(teamNameClash(new ApiError(problem))).toBe('Backend')
    expect(teamNameClash(new ApiError({ ...problem, existingName: undefined }))).toBeNull()
    expect(teamNameClash(new ApiError({ ...problem, code: 'version_conflict' }))).toBeNull()
    expect(teamNameClash(new ApiError({ ...problem, status: 400 }))).toBeNull()
    expect(teamNameClash(new TypeError('network'))).toBeNull()
  })

  it('getTeam, patchTeam, archiveTeam, restoreTeam: method, URL and body (baseVersion in the body)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okResponse(detail))
      .mockResolvedValueOnce(okResponse(detail))
      .mockResolvedValueOnce(okResponse(detail))
      .mockResolvedValueOnce(okResponse(detail))

    await getTeam('t/1')
    expect(lastCall().url).toBe(`${AUTH_URL}/admin/teams/${encodeURIComponent('t/1')}`)
    expect(lastCall().init?.method ?? 'GET').toBe('GET')

    await patchTeam('t1', { baseVersion: 3, name: 'Core', description: null })
    expect(lastCall().url).toBe(`${AUTH_URL}/admin/teams/t1`)
    expect(lastCall().init?.method).toBe('PATCH')
    expect(JSON.parse(lastCall().init?.body as string)).toEqual({ baseVersion: 3, name: 'Core', description: null })

    await archiveTeam('t1', 4)
    expect(lastCall().url).toBe(`${AUTH_URL}/admin/teams/t1/archive`)
    expect(lastCall().init?.method).toBe('POST')
    expect(JSON.parse(lastCall().init?.body as string)).toEqual({ baseVersion: 4 })

    await restoreTeam('t1', 5)
    expect(lastCall().url).toBe(`${AUTH_URL}/admin/teams/t1/restore`)
    expect(JSON.parse(lastCall().init?.body as string)).toEqual({ baseVersion: 5 })
  })

  it('addTeamMember POSTs { userId }; removeTeamMember DELETEs the member and both return the team detail', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(detail)).mockResolvedValueOnce(okResponse(detail))

    const added = await addTeamMember('t1', 'u/1')
    expect(lastCall().url).toBe(`${AUTH_URL}/admin/teams/t1/members`)
    expect(lastCall().init?.method).toBe('POST')
    expect(JSON.parse(lastCall().init?.body as string)).toEqual({ userId: 'u/1' })
    expect(added).toEqual(detail)

    const removed = await removeTeamMember('t1', 'u/1')
    expect(lastCall().url).toBe(`${AUTH_URL}/admin/teams/t1/members/${encodeURIComponent('u/1')}`)
    expect(lastCall().init?.method).toBe('DELETE')
    expect(removed).toEqual(detail)
  })

  it('the member refusals keep their code on the ApiError (422 user_not_active, team_full) and a 404 stays a 404', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(422, { title: 'Unprocessable', status: 422, code: 'user_not_active' }),
    )
    expect((await expectApiError(() => addTeamMember('t1', 'u1'), 422)).code).toBe('user_not_active')
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(422, { title: 'Unprocessable', status: 422, code: 'team_full' }),
    )
    expect((await expectApiError(() => addTeamMember('t1', 'u1'), 422)).code).toBe('team_full')
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(404, { title: 'Not Found', status: 404, code: 'team_not_found' }),
    )
    expect((await expectApiError(() => getTeam('nope'), 404)).code).toBe('team_not_found')
  })

  it('isVersionConflict is true only for a 409 version_conflict', () => {
    const problem = { type: 't', title: 'Conflict', status: 409, code: 'version_conflict', currentVersion: 4 }
    expect(isVersionConflict(new ApiError(problem))).toBe(true)
    expect(isVersionConflict(new ApiError({ ...problem, code: 'team_name_taken' }))).toBe(false)
    expect(isVersionConflict(new ApiError({ ...problem, status: 400 }))).toBe(false)
    expect(isVersionConflict(new TypeError('network'))).toBe(false)
  })

  it('a 403 is an ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problemResponse(403, 'Forbidden'))
    await expectApiError(() => listTeams(), 403)
  })
})

describe('path ids are URL-encoded (specs/20261105-signup-gate T14)', () => {
  const hostile = 'a/../b?x=1#y'
  const encoded = encodeURIComponent(hostile)

  const cases: Array<[string, (id: string) => Promise<unknown>, string]> = [
    ['approveAccessRequest', (id) => approveAccessRequest(id), `/admin/access-requests/${encoded}/approve`],
    ['rejectAccessRequest', (id) => rejectAccessRequest(id), `/admin/access-requests/${encoded}/reject`],
    ['getRole', getRole, `/admin/roles/${encoded}`],
    ['getDepartment', getDepartment, `/admin/departments/${encoded}`],
    ['getUser', getUser, `/admin/users/${encoded}`],
    ['getUserPermissions', getUserPermissions, `/admin/users/${encoded}/permissions`],
    ['deleteUser', deleteUser, `/admin/users/${encoded}`],
    ['resendInvitation', resendInvitation, `/admin/invitations/${encoded}/resend`],
    ['revokeInvitation', revokeInvitation, `/admin/invitations/${encoded}/revoke`],
  ]

  it.each(cases)('%s', async (_name, call, path) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse({}))
    await call(hostile)
    expect(lastCall().url).toBe(`${AUTH_URL}${path}`)
  })
})
