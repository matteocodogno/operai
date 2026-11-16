/**
 * @vitest-environment jsdom
 *
 * Component tests for SettingsPage — the Settings tab of the hours screens, the page for the
 * categories and the two work-type lists (T31, moved here from admin-ui by T43 / D51;
 * specs/20261112-time-tracking/tasks.md, refs AC-3.3, AC-5.5; design.md S5 "States of the page").
 * T31 is the page's frame and its states; the three cards are T32.
 *
 * The API client is faked at the module level (the real `HoursApiError` kept); capabilities come
 * from a mocked `shell/session` `usePermissions()`.
 *
 * Covers:
 *   (A) Loading: three skeleton cards and one polite "Loading time lists…".
 *   (B) Loaded: the request is `listTimeLists()` (retired included), the skeleton is gone and no
 *       banner shows.
 *   (C) Without `time-list:manage`: `PermissionDenied` (role="alert", focused) in place of the
 *       cards, and nothing is fetched. A 403 from the API gives the same, as does a permission that
 *       is withdrawn while the page is open. Until the permissions have resolved the page waits
 *       (loading, nothing fetched) and, if they never do, ends in the denial (T43, D51).
 *   (D) `503 authz_unavailable`: the "Authorization service unavailable" banner with Retry.
 *   (E) Any other load failure: the warning banner with Retry, and no authorization wording.
 *   (F) Retry asks again, and a good answer replaces the banner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import SettingsPage from './SettingsPage'
import type { TimeListsView } from '../lib/hoursApi.types'

vi.mock('../lib/timeListsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/timeListsApi')>()
  return { ...original, listTimeLists: vi.fn() }
})

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

import * as timeListsApi from '../lib/timeListsApi'
import { HoursApiError } from '../lib/errors'
import * as session from 'shell/session'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Permissions = ReturnType<typeof session.usePermissions>

// The shell's EMPTY_PERMISSIONS: what usePermissions() yields when /authz/me failed or has not resolved yet.
const NO_GRANTS: Permissions = { epoch: 0, apps: [], roles: [], departments: [], permissions: [] }

const MANAGES: Permissions = {
  epoch: 1,
  apps: [],
  roles: ['admin'],
  departments: [],
  permissions: [{ resource: 'time-list', action: 'manage', conditions: null }],
}

// Resolved, with another hours permission but not this one: seeing everyone's hours is not managing the lists.
const RESOLVED_WITHOUT_MANAGE: Permissions = {
  epoch: 1,
  apps: ['meetings'],
  roles: ['auditor'],
  departments: [],
  permissions: [{ resource: 'time-entry', action: 'read-all', conditions: null }],
}

const lists: TimeListsView = {
  categories: [{ id: 'tc-training', name: 'Training', requiresNote: false, retired: false }],
  workTypes: {
    project: [{ id: 'wt-project-analysis', list: 'project', name: 'Analysis', retired: false }],
    deal: [],
  },
}

const problem = (status: number, code: string | undefined, title = 'Problem') =>
  new HoursApiError({ status, title, rawCode: code, detail: 'server detail that must not be shown' })

const listTimeLists = () => vi.mocked(timeListsApi.listTimeLists)

beforeEach(() => {
  vi.mocked(session.usePermissions).mockReturnValue(MANAGES)
  listTimeLists().mockResolvedValue(lists)
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

/** Renders the page and waits for its first answer to settle. */
const renderLoaded = async () => {
  const utils = render(<SettingsPage />)
  await waitFor(() => expect(screen.queryByTestId('time-lists-skeleton')).toBeNull())
  return utils
}

// ---------------------------------------------------------------------------
// (A) Loading
// ---------------------------------------------------------------------------

describe('loading', () => {
  it('shows three skeleton cards and one polite announcement while the lists are coming', async () => {
    listTimeLists().mockReturnValue(new Promise(() => {}))

    render(<SettingsPage />)

    expect(await screen.findAllByTestId('time-lists-skeleton')).toHaveLength(3)
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Categories',
      'Project work types',
      'Deal work types',
    ])
    const announcements = screen.getAllByText('Loading time lists…')
    expect(announcements).toHaveLength(1)
    expect(announcements[0].closest('[aria-live="polite"]')).not.toBeNull()
  })

  it('has one h2, the page heading, with the description under it', async () => {
    listTimeLists().mockReturnValue(new Promise(() => {}))

    render(<SettingsPage />)

    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings.map((h) => h.textContent)).toEqual(['Time lists'])
    expect(screen.getByText('Categories and work types people pick from when they record hours.')).not.toBeNull()
    expect(screen.getByTestId('time-lists-page').getAttribute('aria-labelledby')).toBe(headings[0].id)
  })
})

// ---------------------------------------------------------------------------
// (B) Loaded
// ---------------------------------------------------------------------------

describe('loaded', () => {
  it('asks for the lists once, and replaces the skeleton with the content, with no banner', async () => {
    await renderLoaded()

    expect(listTimeLists()).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('time-lists-loaded')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Loading time lists…')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (C) Without time-list:manage
// ---------------------------------------------------------------------------

describe('without time-list:manage', () => {
  it('shows PermissionDenied, focused, and fetches nothing, for a person whose permissions are resolved', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(RESOLVED_WITHOUT_MANAGE)

    render(<SettingsPage />)

    const denied = await screen.findByTestId('hours-permission-denied')
    expect(denied.getAttribute('role')).toBe('alert')
    // The page's own words, not the tool's generic "You do not have access to this".
    expect(screen.getByTestId('hours-permission-denied-heading').textContent).toBe("You can't manage the time lists")
    expect(denied.textContent).toContain(
      'Managing the categories and work types needs a permission your role does not have.',
    )
    expect(document.activeElement).toBe(screen.getByTestId('hours-permission-denied-heading'))
    expect(listTimeLists()).not.toHaveBeenCalled()
    expect(screen.queryByTestId('time-lists-skeleton')).toBeNull()
    expect(screen.queryByTestId('time-lists-loaded')).toBeNull()
  })

  it('keeps the page header, so the person still sees where they are (one h2, PermissionDenied is an h3)', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(RESOLVED_WITHOUT_MANAGE)

    render(<SettingsPage />)

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Time lists'])
    expect(within(screen.getByTestId('hours-permission-denied')).getByRole('heading', { level: 3 })).not.toBeNull()
  })

  describe('while the shell has not said what the person may do', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    const settle = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })

    it('says it is loading, asks nothing and shows no denial yet', async () => {
      vi.mocked(session.usePermissions).mockReturnValue(NO_GRANTS)

      render(<SettingsPage />)
      await settle(100)

      expect(screen.getAllByTestId('time-lists-skeleton')).toHaveLength(3)
      expect(screen.getAllByText('Loading time lists…')).toHaveLength(1)
      expect(screen.queryByTestId('hours-permission-denied')).toBeNull()
      expect(listTimeLists()).not.toHaveBeenCalled()
    })

    it('does not wait for ever: permissions that never arrive end in the denial, still asking nothing', async () => {
      vi.mocked(session.usePermissions).mockReturnValue(NO_GRANTS)

      render(<SettingsPage />)
      await settle(3000)

      expect(screen.getByTestId('hours-permission-denied')).not.toBeNull()
      expect(screen.queryByTestId('time-lists-skeleton')).toBeNull()
      expect(listTimeLists()).not.toHaveBeenCalled()
    })
  })

  it('a 403 from hours-api, although the permission looked held, switches to PermissionDenied', async () => {
    listTimeLists().mockRejectedValue(problem(403, 'time_list_manage_required', 'Forbidden'))

    render(<SettingsPage />)

    expect(await screen.findByTestId('hours-permission-denied')).not.toBeNull()
    expect(screen.queryByTestId('hours-error-banner')).toBeNull()
    expect(screen.queryByTestId('time-lists-loaded')).toBeNull()
  })

  it('a permission withdrawn while the page is open replaces the content with PermissionDenied', async () => {
    const { rerender } = await renderLoaded()
    expect(screen.getByTestId('time-lists-loaded')).not.toBeNull()

    vi.mocked(session.usePermissions).mockReturnValue(RESOLVED_WITHOUT_MANAGE)
    rerender(<SettingsPage />)

    expect(await screen.findByTestId('hours-permission-denied')).not.toBeNull()
    expect(screen.queryByTestId('time-lists-loaded')).toBeNull()
  })

  it('a permission that arrives after the first render starts the load then, not before', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(NO_GRANTS)
    const { rerender } = render(<SettingsPage />)
    expect(listTimeLists()).not.toHaveBeenCalled()

    vi.mocked(session.usePermissions).mockReturnValue(MANAGES)
    rerender(<SettingsPage />)

    expect(await screen.findByTestId('time-lists-loaded')).not.toBeNull()
    expect(listTimeLists()).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('hours-permission-denied')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (D) 503 authz_unavailable
// ---------------------------------------------------------------------------

describe('503 authz_unavailable', () => {
  it('shows the authorization banner with a Retry, and neither the cards nor PermissionDenied', async () => {
    listTimeLists().mockRejectedValue(problem(503, 'authz_unavailable', 'Service Unavailable'))

    render(<SettingsPage />)

    const banner = await screen.findByTestId('hours-error-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('hours-error-banner-title').textContent).toBe('Authorization service unavailable')
    expect(within(banner).getByTestId('hours-error-banner-retry')).not.toBeNull()
    expect(screen.queryByTestId('hours-permission-denied')).toBeNull()
    expect(screen.queryByTestId('time-lists-loaded')).toBeNull()
  })

  it('does not show the server’s detail text: the copy is the catalog’s, in the viewer’s language', async () => {
    listTimeLists().mockRejectedValue(problem(503, 'authz_unavailable'))

    render(<SettingsPage />)

    const banner = await screen.findByTestId('hours-error-banner')
    expect(banner.textContent).not.toContain('server detail that must not be shown')
  })
})

// ---------------------------------------------------------------------------
// (E) Any other load failure
// ---------------------------------------------------------------------------

describe('a load failure', () => {
  it.each([
    ['a 500', problem(500, undefined, 'Internal Server Error')],
    ['a 503 that is not authz_unavailable', problem(503, 'host_unavailable', 'Service Unavailable')],
    ['a 503 with no code at all (a proxy’s)', problem(503, undefined, 'Service Unavailable')],
    ['a 404', problem(404, 'not_found', 'Not Found')],
    ['a network failure', new TypeError('Failed to fetch')],
    ['an answer that is not the lists shape', problem(200, undefined, 'Unexpected response')],
  ])('%s is the warning banner with Retry, without authorization wording', async (_label, failure) => {
    listTimeLists().mockRejectedValue(failure)

    render(<SettingsPage />)

    const banner = await screen.findByTestId('hours-error-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('Could not load the time lists.')
    expect(banner.textContent).not.toContain('Authorization service unavailable')
    expect(banner.textContent).not.toContain('server detail that must not be shown')
    expect(within(banner).getByTestId('hours-error-banner-retry')).not.toBeNull()
    expect(screen.queryByTestId('hours-permission-denied')).toBeNull()
    expect(screen.queryByTestId('time-lists-loaded')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (F) Retry
// ---------------------------------------------------------------------------

describe('Retry', () => {
  it('asks again, shows the loading state meanwhile, and a good answer replaces the banner', async () => {
    listTimeLists().mockRejectedValueOnce(problem(500, undefined))
    let answer: (value: TimeListsView) => void = () => {}
    listTimeLists().mockReturnValueOnce(
      new Promise<TimeListsView>((resolve) => {
        answer = resolve
      }),
    )

    render(<SettingsPage />)
    fireEvent.click(await screen.findByTestId('hours-error-banner-retry'))

    expect(await screen.findAllByTestId('time-lists-skeleton')).toHaveLength(3)
    expect(screen.queryByTestId('hours-error-banner')).toBeNull()
    expect(listTimeLists()).toHaveBeenCalledTimes(2)

    await act(async () => answer(lists))

    expect(await screen.findByTestId('time-lists-loaded')).not.toBeNull()
    expect(screen.queryByTestId('hours-error-banner')).toBeNull()
  })

  it('keeps the keyboard user on the page: focus moves to the page heading when Retry takes its banner away', async () => {
    // Found by rendering: the banner (and the button the person pressed) is replaced by the loading
    // state, and focus fell to <body>, so the next Tab started from the top of the document.
    listTimeLists().mockRejectedValueOnce(problem(500, undefined))
    listTimeLists().mockReturnValueOnce(new Promise(() => {}))

    render(<SettingsPage />)
    const retry = await screen.findByTestId('hours-error-banner-retry')
    retry.focus()
    fireEvent.click(retry)

    await waitFor(() => expect(screen.queryByTestId('hours-error-banner')).toBeNull())
    const heading = screen.getByRole('heading', { level: 2 })
    expect(document.activeElement).toBe(heading)
    expect(heading.getAttribute('tabindex')).toBe('-1')
  })

  it('a failed retry shows the banner again (never a stale success)', async () => {
    listTimeLists().mockRejectedValue(problem(503, 'authz_unavailable'))

    render(<SettingsPage />)
    fireEvent.click(await screen.findByTestId('hours-error-banner-retry'))

    await waitFor(() => expect(listTimeLists()).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('hours-error-banner-title')).not.toBeNull()
    expect(screen.queryByTestId('time-lists-loaded')).toBeNull()
  })

  it('an answer to a request the page has since outrun is dropped, whatever it says', async () => {
    // Request 1 starts while the permission is held; the permission is withdrawn and then comes
    // back, which starts request 2; request 1's late FAILURE must not overwrite request 2's lists.
    let failFirst: (reason: unknown) => void = () => {}
    listTimeLists().mockReturnValueOnce(
      new Promise<TimeListsView>((_resolve, reject) => {
        failFirst = reject
      }),
    )
    listTimeLists().mockResolvedValueOnce(lists)

    const { rerender } = render(<SettingsPage />)
    vi.mocked(session.usePermissions).mockReturnValue(NO_GRANTS)
    rerender(<SettingsPage />)
    vi.mocked(session.usePermissions).mockReturnValue(MANAGES)
    rerender(<SettingsPage />)
    expect(await screen.findByTestId('time-lists-loaded')).not.toBeNull()

    await act(async () => failFirst(problem(500, undefined)))

    expect(screen.getByTestId('time-lists-loaded')).not.toBeNull()
    expect(screen.queryByTestId('hours-error-banner')).toBeNull()
  })
})
