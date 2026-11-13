/**
 * The `shell/session` module as every hours-ui test that talks to a service mocks it
 * (specs/029-time-tracking T22). `vi.mock` factories are hoisted above the imports, so a test
 * builds the module from the shared `apiFetch` mock through a dynamic import:
 *
 *   const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
 *   vi.mock('shell/session', async () =>
 *     (await import('./test-support/fakeSession')).shellSessionMock(apiFetch, { permissions: HOLDER }))
 *
 * and then `apiFetch.mockImplementation(fakeApi({...}))`. The five origins are distinct, so a request
 * sent to the wrong service (the deal picker asking hours-api, say) reaches no route of `fakeApi`.
 */

/** One origin per service hours-ui calls; `fakeApi` answers a route only on its own service's origin. */
export const ORIGINS = {
  hours: 'http://hours-api.test',
  projects: 'http://projects-api.test',
  crm: 'http://crm-api.test',
  meetings: 'http://meetings-api.test',
  activities: 'http://activities-api.test',
} as const

export type FakeService = keyof typeof ORIGINS

export type FakePermissions = {
  epoch: number
  apps: string[]
  roles: string[]
  departments: string[]
  permissions: { resource: string; action: string; conditions?: unknown }[]
}

/** The shell's answer before `/authz/me` has resolved (and after one that failed): nothing at all. */
export const NOT_RESOLVED: FakePermissions = { epoch: 0, apps: [], roles: [], departments: [], permissions: [] }

/** Signed in with a role and an app, and no `time-entry:read-all`: the usual employee. */
export const EMPLOYEE: FakePermissions = {
  epoch: 2,
  apps: ['meetings'],
  roles: ['employee'],
  departments: [],
  permissions: [{ resource: 'meetings', action: 'access' }],
}

/** Holds `time-entry:read-all` (the admin), so Everyone's hours exists for them. */
export const READ_ALL_HOLDER: FakePermissions = {
  epoch: 5,
  apps: ['admin'],
  roles: ['admin'],
  departments: [],
  permissions: [
    { resource: 'meetings', action: 'access' },
    { resource: 'time-entry', action: 'read-all' },
  ],
}

/** The exports hours-ui uses from `shell/session`, on top of the test's own `apiFetch`. */
export const shellSessionMock = (
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  { permissions = EMPLOYEE }: { permissions?: FakePermissions } = {},
) => ({
  apiFetch,
  getHoursApiBaseUrl: () => ORIGINS.hours,
  getProjectsApiBaseUrl: () => ORIGINS.projects,
  getCrmApiBaseUrl: () => ORIGINS.crm,
  getMeetingsApiBaseUrl: () => ORIGINS.meetings,
  getActivitiesApiBaseUrl: () => ORIGINS.activities,
  usePermissions: () => permissions,
})
