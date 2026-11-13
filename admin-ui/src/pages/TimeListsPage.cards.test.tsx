/**
 * @vitest-environment jsdom
 *
 * Component tests for the three cards of TimeListsPage (T32, specs/029-time-tracking/tasks.md, refs
 * AC-3.1, AC-3.2, AC-3.4, AC-3.7, AC-3.8; plan.md § Lists; design.md S5). T31's own file covers the
 * page's frame and states; this one covers what the loaded page shows and does.
 *
 * hours-api's list routes are not built yet (T12), so the API client is replaced by an in-memory
 * FAKE that answers like plan.md § Lists says: names unique per list on `lower(name)` retired rows
 * included (409 `name_taken`), an unknown id is 404 `not_found`, retire and restore are idempotent
 * `PATCH { retired }`s. The real `ApiError` is kept, as in T31's tests. A test that needs a request
 * to stay in flight takes the fake's answer into its own hands with `hold()`.
 *
 * Covers:
 *   (A) Three cards, each its own table; the seeded A15 rows; "Entries need a note" on categories only.
 *   (B) Retired rows after active ones; status through the badge (text, not colour).
 *   (C) Row actions: Rename + Retire on an active row, Rename + Restore on a retired one; no Delete.
 *   (D) Retire / Restore: one `PATCH { retired }`, busy on that row only, the row takes the server's
 *       answer and moves, focus lands on the same item's new toggle, a success banner says what happened.
 *   (E) Their failures: 403, 503 (Retry re-sends the same PATCH), other, 404.
 *   (F) Add and Rename dialogs.
 *   (G) Empty lists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TimeListsPage from './TimeListsPage'
import type { TimeCategory, TimeLists, WorkType, WorkTypeList } from '../lib/timeListsApi'

vi.mock('../lib/timeListsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/timeListsApi')>()
  return {
    ...original,
    listTimeLists: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    createWorkType: vi.fn(),
    updateWorkType: vi.fn(),
  }
})

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

import * as timeListsApi from '../lib/timeListsApi'
import { ApiError } from '../lib/timeListsApi'
import * as session from 'shell/session'

// ---------------------------------------------------------------------------
// The fake hours-api
// ---------------------------------------------------------------------------

type Scope = 'categories' | WorkTypeList

const MANAGES: ReturnType<typeof session.usePermissions> = {
  epoch: 1,
  apps: ['admin'],
  roles: ['admin'],
  departments: [],
  permissions: [{ resource: 'time-list', action: 'manage', conditions: null }],
}

const problem = (status: number, code: string | undefined, title = 'Problem') =>
  new ApiError({ type: 'about:blank', title, status, code, detail: 'server detail that must not be shown' })

const category = (id: string, name: string, requiresNote = false, retired = false): TimeCategory => ({
  id,
  name,
  requiresNote,
  retired,
})
const workType = (list: WorkTypeList, id: string, name: string, retired = false): WorkType => ({
  id,
  list,
  name,
  retired,
})

/** AC-3.7: what a new installation starts with. */
const seededLists = (): TimeLists => ({
  categories: [
    category('c-training', 'Training'),
    category('c-talk', 'Talk preparation'),
    category('c-admin', 'Administration'),
    category('c-other', 'Other', true),
  ],
  workTypes: {
    project: [
      workType('project', 'wp-dev', 'Development'),
      workType('project', 'wp-analysis', 'Analysis'),
      workType('project', 'wp-pm', 'Project management'),
      workType('project', 'wp-support', 'Support'),
    ],
    deal: [
      workType('deal', 'wd-analysis', 'Analysis'),
      workType('deal', 'wd-estimate', 'Estimate'),
      workType('deal', 'wd-demo', 'Demo'),
      workType('deal', 'wd-offer', 'Offer'),
    ],
  },
})

let server: TimeLists
let nextId = 1

const api = {
  list: () => vi.mocked(timeListsApi.listTimeLists),
  createCategory: () => vi.mocked(timeListsApi.createCategory),
  updateCategory: () => vi.mocked(timeListsApi.updateCategory),
  createWorkType: () => vi.mocked(timeListsApi.createWorkType),
  updateWorkType: () => vi.mocked(timeListsApi.updateWorkType),
}

const lowerName = (name: string) => name.toLowerCase()

/** Wires the five client functions to `server`, answering as plan.md § Lists defines. */
const installFakeApi = () => {
  api.list().mockImplementation(async () => structuredClone(server))

  api.createCategory().mockImplementation(async (input) => {
    if (server.categories.some((c) => lowerName(c.name) === lowerName(input.name))) throw problem(409, 'name_taken')
    const created = category(`c-new-${nextId++}`, input.name, input.requiresNote ?? false)
    server.categories.push(created)
    return structuredClone(created)
  })
  api.updateCategory().mockImplementation(async (id, input) => {
    const found = server.categories.find((c) => c.id === id)
    if (!found) throw problem(404, 'not_found')
    if (
      input.name !== undefined &&
      server.categories.some((c) => c.id !== id && lowerName(c.name) === lowerName(input.name!))
    ) {
      throw problem(409, 'name_taken')
    }
    Object.assign(found, input)
    return structuredClone(found)
  })

  api.createWorkType().mockImplementation(async (input) => {
    if (server.workTypes[input.list].some((w) => lowerName(w.name) === lowerName(input.name))) {
      throw problem(409, 'name_taken')
    }
    const created = workType(input.list, `w-new-${nextId++}`, input.name)
    server.workTypes[input.list].push(created)
    return structuredClone(created)
  })
  api.updateWorkType().mockImplementation(async (id, input) => {
    const all = [...server.workTypes.project, ...server.workTypes.deal]
    const found = all.find((w) => w.id === id)
    if (!found) throw problem(404, 'not_found')
    if (
      input.name !== undefined &&
      server.workTypes[found.list].some((w) => w.id !== id && lowerName(w.name) === lowerName(input.name!))
    ) {
      throw problem(409, 'name_taken')
    }
    Object.assign(found, input)
    return structuredClone(found)
  })
}

/** A request the test answers itself, so the page can be looked at while it is in flight. */
const hold = <T,>() => {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  server = seededLists()
  nextId = 1
  vi.mocked(session.usePermissions).mockReturnValue(MANAGES)
  installFakeApi()
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers on the screen
// ---------------------------------------------------------------------------

const renderLoaded = async () => {
  const utils = render(<TimeListsPage />)
  await screen.findByTestId('time-lists-loaded')
  return utils
}

const card = (scope: Scope) => screen.getByTestId(`time-lists-card-${scope}`)
const table = (scope: Scope) => within(card(scope)).getByRole('table')
const rowNames = (scope: Scope) =>
  within(table(scope))
    .getAllByRole('rowheader')
    .map((th) => th.textContent)
const row = (scope: Scope, id: string) => screen.getByTestId(`time-lists-row-${scope}-${id}`)

// ---------------------------------------------------------------------------
// (A) The three cards
// ---------------------------------------------------------------------------

describe('the cards', () => {
  it('shows Categories, Project work types and Deal work types, each with its own table', async () => {
    await renderLoaded()

    const loaded = screen.getByTestId('time-lists-loaded')
    expect(
      within(loaded)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Categories', 'Project work types', 'Deal work types'])
    expect(within(loaded).getAllByRole('table')).toHaveLength(3)
    expect(within(card('categories')).getByRole('table', { name: 'Categories' })).not.toBeNull()
    expect(within(card('project')).getByRole('table', { name: 'Project work types' })).not.toBeNull()
    expect(within(card('deal')).getByRole('table', { name: 'Deal work types' })).not.toBeNull()
  })

  it('categories have the "Entries need a note" column, the work-type lists do not', async () => {
    await renderLoaded()

    const headers = (scope: Scope) =>
      within(table(scope))
        .getAllByRole('columnheader')
        .map((th) => th.textContent)
    expect(headers('categories')).toEqual(['Name', 'Entries need a note', 'Status', 'Actions'])
    expect(headers('project')).toEqual(['Name', 'Status', 'Actions'])
    expect(headers('deal')).toEqual(['Name', 'Status', 'Actions'])
  })

  it('renders the seeded lists of a new installation (AC-3.7)', async () => {
    await renderLoaded()

    expect(rowNames('categories')).toEqual(['Training', 'Talk preparation', 'Administration', 'Other'])
    expect(rowNames('project')).toEqual(['Development', 'Analysis', 'Project management', 'Support'])
    expect(rowNames('deal')).toEqual(['Analysis', 'Estimate', 'Demo', 'Offer'])
  })

  it('says in words whether a category needs a note: only Other does among the seeded ones', async () => {
    await renderLoaded()

    const needsNote = (id: string) => within(row('categories', id)).getAllByRole('cell')[0].textContent
    expect(needsNote('c-training')).toBe('No')
    expect(needsNote('c-talk')).toBe('No')
    expect(needsNote('c-admin')).toBe('No')
    expect(needsNote('c-other')).toBe('Yes')
  })
})

// ---------------------------------------------------------------------------
// (B) Retired after active; status as text
// ---------------------------------------------------------------------------

describe('retired items', () => {
  it('lists retired rows after the active ones, each group in the server’s order (AC-3.4)', async () => {
    server.categories = [
      category('c-1', 'Seminars', false, true),
      category('c-2', 'Training'),
      category('c-3', 'Archive', false, true),
      category('c-4', 'Other', true),
    ]
    server.workTypes.project = [workType('project', 'p-1', 'Old', true), workType('project', 'p-2', 'Development')]
    server.workTypes.deal = [workType('deal', 'd-1', 'Only retired', true)]

    await renderLoaded()

    expect(rowNames('categories')).toEqual(['Training', 'Other', 'Seminars', 'Archive'])
    expect(rowNames('project')).toEqual(['Development', 'Old'])
    // A list with only retired rows shows them; it is not the empty state.
    expect(rowNames('deal')).toEqual(['Only retired'])
  })

  it('shows each row’s status as a badge with its text: Active, or Retired', async () => {
    server.categories = [category('c-1', 'Training'), category('c-2', 'Seminars', false, true)]

    await renderLoaded()

    const badge = (id: string) => within(row('categories', id)).getByTestId('time-list-status-badge')
    expect(badge('c-1').textContent).toBe('Active')
    expect(badge('c-1').className).toContain('badge-success')
    expect(badge('c-2').textContent).toBe('Retired')
    expect(badge('c-2').className).toContain('badge-muted')
  })
})

// ---------------------------------------------------------------------------
// (C) Row actions
// ---------------------------------------------------------------------------

describe('row actions', () => {
  beforeEach(() => {
    server.categories = [category('c-1', 'Training'), category('c-2', 'Seminars', false, true)]
  })

  const buttonLabels = (scope: Scope, id: string) =>
    within(row(scope, id))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))

  it('an active row offers Rename and Retire; a retired row Rename and Restore, each named after the item', async () => {
    await renderLoaded()

    expect(buttonLabels('categories', 'c-1')).toEqual(['Rename Training', 'Retire Training'])
    expect(buttonLabels('categories', 'c-2')).toEqual(['Rename Seminars', 'Restore Seminars'])
  })

  it('the buttons read Rename, Retire and Restore, as small ghost buttons', async () => {
    await renderLoaded()

    const retire = within(row('categories', 'c-1')).getByRole('button', { name: 'Retire Training' })
    expect(retire.textContent).toBe('Retire')
    expect(retire.className).toContain('btn-ghost')
    expect(retire.className).toContain('btn-sm')
    expect(within(row('categories', 'c-2')).getByRole('button', { name: 'Restore Seminars' }).textContent).toBe(
      'Restore',
    )
    expect(within(row('categories', 'c-1')).getByRole('button', { name: 'Rename Training' }).textContent).toBe('Rename')
  })

  it('offers the same actions on the work-type lists, which name the item and not the list', async () => {
    server.workTypes.deal = [workType('deal', 'd-1', 'Demo'), workType('deal', 'd-2', 'Offer', true)]

    await renderLoaded()

    expect(buttonLabels('deal', 'd-1')).toEqual(['Rename Demo', 'Retire Demo'])
    expect(buttonLabels('deal', 'd-2')).toEqual(['Rename Offer', 'Restore Offer'])
  })

  it('has no Delete control anywhere, retired rows included (AC-3.2)', async () => {
    await renderLoaded()

    const everyButton = screen.getAllByRole('button')
    expect(everyButton.length).toBeGreaterThan(0)
    for (const button of everyButton) {
      const name = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`
      expect(name).not.toMatch(/delete|remove|elimin/i)
    }
  })
})

// ---------------------------------------------------------------------------
// (D) Retire and Restore
// ---------------------------------------------------------------------------

describe('Retire and Restore', () => {
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

  it('Retire sends one PATCH { retired: true }; the row takes the answer and moves after the active ones, with no refetch', async () => {
    await renderLoaded()

    click('Retire Training')

    await waitFor(() => expect(within(row('categories', 'c-training')).getByText('Retired')).not.toBeNull())
    expect(api.updateCategory()).toHaveBeenCalledTimes(1)
    expect(api.updateCategory()).toHaveBeenCalledWith('c-training', { retired: true })
    expect(rowNames('categories')).toEqual(['Talk preparation', 'Administration', 'Other', 'Training'])
    expect(
      within(row('categories', 'c-training'))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Rename Training', 'Restore Training'])
    // The page shows the server's answer; it does not ask for the lists again.
    expect(api.list()).toHaveBeenCalledTimes(1)
  })

  it('Restore sends one PATCH { retired: false } and the row returns among the active ones', async () => {
    server.categories = [
      category('c-1', 'Training'),
      category('c-2', 'Seminars', false, true),
      category('c-3', 'Other'),
    ]
    await renderLoaded()
    expect(rowNames('categories')).toEqual(['Training', 'Other', 'Seminars'])

    click('Restore Seminars')

    await waitFor(() => expect(within(row('categories', 'c-2')).getByText('Active')).not.toBeNull())
    expect(api.updateCategory()).toHaveBeenCalledTimes(1)
    expect(api.updateCategory()).toHaveBeenCalledWith('c-2', { retired: false })
    expect(rowNames('categories')).toEqual(['Training', 'Seminars', 'Other'])
    expect(api.list()).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['project', 'wp-dev', 'Development'],
    ['deal', 'wd-demo', 'Demo'],
  ] as const)('retires a %s work type through the work-type route, never the category one', async (scope, id, name) => {
    await renderLoaded()

    click(`Retire ${name}`)

    await waitFor(() => expect(within(row(scope, id)).getByText('Retired')).not.toBeNull())
    expect(api.updateWorkType()).toHaveBeenCalledTimes(1)
    expect(api.updateWorkType()).toHaveBeenCalledWith(id, { retired: true })
    expect(api.updateCategory()).not.toHaveBeenCalled()
  })

  describe('while the request is in flight', () => {
    const toggle = (scope: Scope, id: string) => screen.getByTestId(`time-lists-toggle-${scope}-${id}`)
    const rename = (scope: Scope, id: string) => screen.getByTestId(`time-lists-rename-${scope}-${id}`)

    it('only that row is busy: aria-busy and "Retiring…", not disabled (focus stays), its Rename aria-disabled', async () => {
      const pending = hold<TimeCategory>()
      api.updateCategory().mockReturnValueOnce(pending.promise)
      await renderLoaded()

      click('Retire Training')

      const busy = toggle('categories', 'c-training')
      expect(busy.getAttribute('aria-busy')).toBe('true')
      expect(busy.textContent).toBe('Retiring…')
      expect(busy.getAttribute('aria-label')).toBe('Retiring Training')
      expect(busy.hasAttribute('disabled')).toBe(false)
      expect(rename('categories', 'c-training').getAttribute('aria-disabled')).toBe('true')

      // Every other button of every card is idle.
      for (const button of screen.getAllByRole('button')) {
        if (button === busy || button === rename('categories', 'c-training')) continue
        expect(button.getAttribute('aria-busy')).toBeNull()
        expect(button.getAttribute('aria-disabled')).toBeNull()
        expect(button.hasAttribute('disabled')).toBe(false)
      }

      await act(async () => pending.resolve(category('c-training', 'Training', false, true)))
      expect(toggle('categories', 'c-training').getAttribute('aria-busy')).toBeNull()
    })

    it('says "Restoring…" for a Restore', async () => {
      server.categories = [category('c-1', 'Seminars', false, true)]
      const pending = hold<TimeCategory>()
      api.updateCategory().mockReturnValueOnce(pending.promise)
      await renderLoaded()

      click('Restore Seminars')

      expect(toggle('categories', 'c-1').textContent).toBe('Restoring…')
      expect(toggle('categories', 'c-1').getAttribute('aria-label')).toBe('Restoring Seminars')
      await act(async () => pending.resolve(category('c-1', 'Seminars')))
    })

    it('other rows stay usable: a second Retire on another row sends its own PATCH', async () => {
      const pending = hold<TimeCategory>()
      api.updateCategory().mockReturnValueOnce(pending.promise)
      await renderLoaded()

      click('Retire Training')
      click('Retire Administration')

      await waitFor(() => expect(within(row('categories', 'c-admin')).getByText('Retired')).not.toBeNull())
      expect(api.updateCategory()).toHaveBeenCalledTimes(2)
      expect(api.updateCategory()).toHaveBeenLastCalledWith('c-admin', { retired: true })
      // The first is still in flight and still busy.
      expect(toggle('categories', 'c-training').getAttribute('aria-busy')).toBe('true')

      await act(async () => pending.resolve(category('c-training', 'Training', false, true)))
      expect(within(row('categories', 'c-training')).getByText('Retired')).not.toBeNull()
    })

    it('a second click on the busy button sends nothing more (a double click is one request)', async () => {
      const pending = hold<TimeCategory>()
      api.updateCategory().mockReturnValueOnce(pending.promise)
      await renderLoaded()

      click('Retire Training')
      fireEvent.click(toggle('categories', 'c-training'))
      fireEvent.click(toggle('categories', 'c-training'))

      expect(api.updateCategory()).toHaveBeenCalledTimes(1)
      await act(async () => pending.resolve(category('c-training', 'Training', false, true)))
      expect(api.updateCategory()).toHaveBeenCalledTimes(1)
    })
  })

  describe('after it succeeds', () => {
    it('says what happened in a polite success banner: Retire, where the way back is', async () => {
      await renderLoaded()

      click('Retire Training')

      const message = await screen.findByTestId('time-lists-notice')
      expect(message.textContent).toBe(
        '“Training” retired. Entries that have it keep it. You can restore it from this list.',
      )
      const banner = screen.getByTestId('time-lists-notice-banner')
      expect(banner.getAttribute('role')).toBe('status')
      expect(banner.className).toContain('banner-success')
    })

    it('says what happened: Restore', async () => {
      server.categories = [category('c-1', 'Seminars', false, true)]
      await renderLoaded()

      click('Restore Seminars')

      expect((await screen.findByTestId('time-lists-notice')).textContent).toBe(
        '“Seminars” restored. People can pick it again.',
      )
    })

    it('a work type is named by its own name, whichever list it is in', async () => {
      await renderLoaded()

      click('Retire Demo')

      expect((await screen.findByTestId('time-lists-notice')).textContent).toBe(
        '“Demo” retired. Entries that have it keep it. You can restore it from this list.',
      )
    })

    it('the banner follows the latest action: a second success replaces the first', async () => {
      await renderLoaded()

      click('Retire Training')
      await screen.findByTestId('time-lists-notice')
      click('Retire Administration')

      await waitFor(() =>
        expect(screen.getByTestId('time-lists-notice').textContent).toContain('“Administration” retired.'),
      )
      expect(screen.getAllByTestId('time-lists-notice')).toHaveLength(1)
    })

    it('moves focus to the same item’s new toggle: Restore after a Retire, Retire after a Restore', async () => {
      await renderLoaded()
      const retire = screen.getByRole('button', { name: 'Retire Training' })
      retire.focus()

      fireEvent.click(retire)

      await waitFor(() => expect(screen.getByRole('button', { name: 'Restore Training' })).not.toBeNull())
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restore Training' }))

      fireEvent.click(screen.getByRole('button', { name: 'Restore Training' }))

      await waitFor(() => expect(screen.getByRole('button', { name: 'Retire Training' })).not.toBeNull())
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retire Training' }))
    })

    it('puts focus there even when the press left it on the page (a mouse click does not focus a button in Safari)', async () => {
      // jsdom keeps focus on a reused element when its row is moved; a browser drops it. Starting
      // from <body> is the case where only a deliberate move can satisfy the design.
      await renderLoaded()
      expect(document.activeElement).toBe(document.body)

      click('Retire Training')

      await waitFor(() => expect(screen.getByRole('button', { name: 'Restore Training' })).not.toBeNull())
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restore Training' }))
    })

    it('does the same for a work type, in its own card, although Analysis exists in both lists', async () => {
      await renderLoaded()
      const retire = within(row('deal', 'wd-analysis')).getByRole('button', { name: 'Retire Analysis' })
      retire.focus()

      fireEvent.click(retire)

      await waitFor(() => expect(within(row('deal', 'wd-analysis')).getByText('Retired')).not.toBeNull())
      expect(document.activeElement).toBe(
        within(row('deal', 'wd-analysis')).getByRole('button', { name: 'Restore Analysis' }),
      )
      // The project list's Analysis is untouched.
      expect(within(row('project', 'wp-analysis')).getByText('Active')).not.toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// (E) When Retire or Restore fails
// ---------------------------------------------------------------------------

describe('a failed Retire or Restore', () => {
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

  it('403 time_list_manage_required: PermissionDenied in place of the cards, nothing changed', async () => {
    api.updateCategory().mockRejectedValueOnce(problem(403, 'time_list_manage_required', 'Forbidden'))
    await renderLoaded()

    click('Retire Training')

    const denied = await screen.findByTestId('permission-denied')
    expect(denied.getAttribute('role')).toBe('alert')
    expect(screen.queryByTestId('time-lists-loaded')).toBeNull()
    expect(screen.queryByTestId('time-lists-card-categories')).toBeNull()
    expect(screen.queryByTestId('error-banner')).toBeNull()
    expect(server.categories.find((c) => c.id === 'c-training')?.retired).toBe(false)
  })

  describe('503 authz_unavailable', () => {
    it('shows the authorization banner with Retry; the row is unchanged and its button idle again', async () => {
      api.updateCategory().mockRejectedValueOnce(problem(503, 'authz_unavailable', 'Service Unavailable'))
      await renderLoaded()

      click('Retire Training')

      const banner = await screen.findByTestId('error-banner')
      expect(banner.getAttribute('role')).toBe('alert')
      expect(banner.className).toContain('banner-warning')
      expect(screen.getByTestId('error-banner-title').textContent).toBe('Authorization service unavailable')
      expect(banner.textContent).toContain('Nothing was changed.')
      expect(banner.textContent).not.toContain('server detail that must not be shown')
      expect(within(banner).getByTestId('error-banner-retry')).not.toBeNull()
      // Nothing moved, and the button is the idle Retire again.
      expect(rowNames('categories')).toEqual(['Training', 'Talk preparation', 'Administration', 'Other'])
      const toggle = screen.getByTestId('time-lists-toggle-categories-c-training')
      expect(toggle.getAttribute('aria-busy')).toBeNull()
      expect(toggle.textContent).toBe('Retire')
      expect(screen.queryByTestId('time-lists-notice')).toBeNull()
      // The cards stay; this is not the permission-denied state.
      expect(screen.queryByTestId('permission-denied')).toBeNull()
    })

    it('Retry re-sends the same PATCH; a good answer moves the row, replaces the banner and says what happened', async () => {
      api.updateCategory().mockRejectedValueOnce(problem(503, 'authz_unavailable'))
      await renderLoaded()
      click('Retire Training')
      await screen.findByTestId('error-banner')

      fireEvent.click(screen.getByTestId('error-banner-retry'))

      await waitFor(() => expect(within(row('categories', 'c-training')).getByText('Retired')).not.toBeNull())
      expect(api.updateCategory()).toHaveBeenCalledTimes(2)
      expect(api.updateCategory()).toHaveBeenNthCalledWith(1, 'c-training', { retired: true })
      expect(api.updateCategory()).toHaveBeenNthCalledWith(2, 'c-training', { retired: true })
      expect(screen.queryByTestId('error-banner')).toBeNull()
      expect(screen.getByTestId('time-lists-notice').textContent).toContain('“Training” retired.')
    })

    it('Retry of a Restore re-sends the Restore, to the work-type route for a work type', async () => {
      server.workTypes.deal = [workType('deal', 'd-1', 'Offer', true)]
      api.updateWorkType().mockRejectedValueOnce(problem(503, 'authz_unavailable'))
      await renderLoaded()
      click('Restore Offer')
      await screen.findByTestId('error-banner')

      fireEvent.click(screen.getByTestId('error-banner-retry'))

      await waitFor(() => expect(within(row('deal', 'd-1')).getByText('Active')).not.toBeNull())
      expect(api.updateWorkType()).toHaveBeenNthCalledWith(1, 'd-1', { retired: false })
      expect(api.updateWorkType()).toHaveBeenNthCalledWith(2, 'd-1', { retired: false })
    })

    it('a Retry that fails again keeps the banner, and the row stays as it was', async () => {
      api.updateCategory().mockRejectedValue(problem(503, 'authz_unavailable'))
      await renderLoaded()
      click('Retire Training')
      fireEvent.click(await screen.findByTestId('error-banner-retry'))

      await waitFor(() => expect(api.updateCategory()).toHaveBeenCalledTimes(2))
      expect(await screen.findByTestId('error-banner-title')).not.toBeNull()
      expect(rowNames('categories')[0]).toBe('Training')
    })
  })

  describe.each([
    ['a 500', () => problem(500, undefined, 'Internal Server Error')],
    ['a 503 that is not authz_unavailable', () => problem(503, 'host_unavailable')],
    ['a network failure', () => new TypeError('Failed to fetch')],
    ['a 409 (not reachable from these buttons, but never a crash)', () => problem(409, 'name_taken')],
  ])('%s', (_label, failure) => {
    it('shows the danger banner "Something went wrong. Nothing was changed." with Retry, no authorization wording', async () => {
      api.updateCategory().mockRejectedValueOnce(failure())
      await renderLoaded()

      click('Retire Training')

      const banner = await screen.findByTestId('error-banner')
      expect(banner.className).toContain('banner-danger')
      expect(banner.textContent).toContain('Something went wrong. Nothing was changed.')
      expect(banner.textContent).not.toContain('Authorization service unavailable')
      expect(banner.textContent).not.toContain('server detail that must not be shown')
      expect(rowNames('categories')[0]).toBe('Training')
      expect(screen.getByTestId('time-lists-toggle-categories-c-training').getAttribute('aria-busy')).toBeNull()
    })

    it('Retry re-sends the same PATCH', async () => {
      api.updateCategory().mockRejectedValueOnce(failure())
      await renderLoaded()
      click('Retire Training')

      fireEvent.click(await screen.findByTestId('error-banner-retry'))

      await waitFor(() => expect(within(row('categories', 'c-training')).getByText('Retired')).not.toBeNull())
      expect(api.updateCategory()).toHaveBeenNthCalledWith(2, 'c-training', { retired: true })
    })
  })

  it('leaves focus on the button the person pressed, idle again, so a keyboard user can press it again', async () => {
    api.updateCategory().mockRejectedValueOnce(problem(500, undefined))
    await renderLoaded()
    const retire = screen.getByRole('button', { name: 'Retire Training' })
    retire.focus()

    fireEvent.click(retire)
    await screen.findByTestId('error-banner')

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retire Training' }))
  })

  it('takes a stale success banner away: an error is never shown beside "retired"', async () => {
    await renderLoaded()
    click('Retire Training')
    await screen.findByTestId('time-lists-notice')
    api.updateCategory().mockRejectedValueOnce(problem(500, undefined))

    click('Retire Administration')

    await screen.findByTestId('error-banner')
    expect(screen.queryByTestId('time-lists-notice')).toBeNull()
  })

  it('takes the error banner away when the same item later succeeds, so it never outlives its cause', async () => {
    api.updateCategory().mockRejectedValueOnce(problem(500, undefined))
    await renderLoaded()
    click('Retire Training')
    await screen.findByTestId('error-banner')

    click('Retire Training')

    await waitFor(() => expect(within(row('categories', 'c-training')).getByText('Retired')).not.toBeNull())
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('the error banner can be dismissed', async () => {
    api.updateCategory().mockRejectedValueOnce(problem(500, undefined))
    await renderLoaded()
    click('Retire Training')

    fireEvent.click(await screen.findByTestId('error-banner-dismiss'))

    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  describe('404 not_found: the item no longer exists', () => {
    it('reloads the lists and says so in an info banner', async () => {
      api.updateCategory().mockRejectedValueOnce(problem(404, 'not_found', 'Not Found'))
      await renderLoaded()
      // The item is gone from the server (only after a database reset, plan.md § Lists).
      server.categories = server.categories.filter((c) => c.id !== 'c-training')

      click('Retire Training')

      // The banner is up as soon as the 404 lands; the reload then swaps the lists, so wait for it.
      await waitFor(() => expect(rowNames('categories')).toEqual(['Talk preparation', 'Administration', 'Other']))
      const message = await screen.findByTestId('time-lists-notice')
      expect(message.textContent).toBe('That item no longer exists, so the lists were reloaded.')
      expect(screen.getByTestId('time-lists-notice-banner').className).not.toContain('banner-success')
      expect(screen.getByTestId('time-lists-notice-banner').getAttribute('role')).toBe('status')
      expect(api.list()).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('error-banner')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// (F) Add
// ---------------------------------------------------------------------------

const addButton = (scope: Scope) => within(card(scope)).getByTestId(`time-lists-add-${scope}`)
const dialog = () => screen.getByRole('dialog')
const nameField = () => within(dialog()).getByRole('textbox', { name: /^Name/ }) as HTMLInputElement
const typeName = (value: string) => fireEvent.change(nameField(), { target: { value } })
const submitDialog = () => fireEvent.click(within(dialog()).getByTestId('time-lists-dialog-submit'))

/** Opens the Add dialog the way a keyboard user does: focus on the button, then press it. */
const openAdd = (scope: Scope) => {
  const button = addButton(scope)
  button.focus()
  fireEvent.click(button)
}

describe('Add', () => {
  it('each card has its own secondary small Add button: "Add category", and "Add work type" for each work-type list', async () => {
    await renderLoaded()

    expect(addButton('categories').textContent).toBe('Add category')
    expect(addButton('project').textContent).toBe('Add work type')
    expect(addButton('deal').textContent).toBe('Add work type')
    for (const scope of ['categories', 'project', 'deal'] as const) {
      expect(addButton(scope).className).toContain('btn-secondary')
      expect(addButton(scope).className).toContain('btn-sm')
      expect(addButton(scope).getAttribute('aria-haspopup')).toBe('dialog')
    }
  })

  it.each([
    ['categories', 'Add category'],
    ['project', 'Add project work type'],
    ['deal', 'Add deal work type'],
  ] as const)('the %s Add button opens "%s" with focus in Name', async (scope, title) => {
    await renderLoaded()

    openAdd(scope)

    expect(screen.getByRole('dialog', { name: title })).not.toBeNull()
    expect(document.activeElement).toBe(nameField())
    expect(nameField().value).toBe('')
  })

  it('a new category goes to the server trimmed, with its note flag, and the row joins the active ones with a banner', async () => {
    server.categories = [category('c-1', 'Training'), category('c-2', 'Old', false, true)]
    await renderLoaded()
    openAdd('categories')

    typeName('  Seminars  ')
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'Entries in this category need a note' }))
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.createCategory()).toHaveBeenCalledTimes(1)
    expect(api.createCategory()).toHaveBeenCalledWith({ name: 'Seminars', requiresNote: true })
    // After the active ones, before the retired ones; no refetch.
    expect(rowNames('categories')).toEqual(['Training', 'Seminars', 'Old'])
    const created = server.categories.find((c) => c.name === 'Seminars')!
    expect(within(row('categories', created.id)).getAllByRole('cell')[0].textContent).toBe('Yes')
    expect(api.list()).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('time-lists-notice').textContent).toBe('Category “Seminars” added.')
    expect(screen.getByTestId('time-lists-notice-banner').getAttribute('role')).toBe('status')
  })

  it.each([
    ['project', 'Project work type'],
    ['deal', 'Deal work type'],
  ] as const)('a new %s work type is created in its own list, by name alone', async (scope, noun) => {
    await renderLoaded()
    openAdd(scope)

    typeName('Workshop')
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.createWorkType()).toHaveBeenCalledTimes(1)
    expect(api.createWorkType()).toHaveBeenCalledWith({ list: scope, name: 'Workshop' })
    expect(api.createCategory()).not.toHaveBeenCalled()
    expect(rowNames(scope).at(-1)).toBe('Workshop')
    // The other list is untouched.
    expect(rowNames(scope === 'project' ? 'deal' : 'project')).not.toContain('Workshop')
    expect(screen.getByTestId('time-lists-notice').textContent).toBe(`${noun} “Workshop” added.`)
  })

  it('returns focus to the button that opened the dialog', async () => {
    await renderLoaded()
    openAdd('categories')
    typeName('Seminars')

    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(addButton('categories'))
  })

  it('Cancel closes it and sends nothing', async () => {
    await renderLoaded()
    openAdd('categories')
    typeName('Seminars')

    fireEvent.click(within(dialog()).getByTestId('time-lists-dialog-cancel'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.createCategory()).not.toHaveBeenCalled()
    expect(screen.queryByTestId('time-lists-notice')).toBeNull()
  })

  it('an empty name is refused in the dialog and never reaches the server', async () => {
    await renderLoaded()
    openAdd('categories')

    submitDialog()

    expect(within(dialog()).getByTestId('time-lists-dialog-name-error').textContent).toBe('Name is required.')
    expect(api.createCategory()).not.toHaveBeenCalled()
  })

  it('80 emoji are sent; 81 are refused (plan amendment 2, code points after trimming)', async () => {
    await renderLoaded()
    openAdd('categories')

    typeName(` ${'🙂'.repeat(81)} `)
    submitDialog()
    expect(within(dialog()).getByTestId('time-lists-dialog-name-error')).not.toBeNull()
    expect(api.createCategory()).not.toHaveBeenCalled()

    typeName(` ${'🙂'.repeat(80)} `)
    submitDialog()

    await waitFor(() =>
      expect(api.createCategory()).toHaveBeenCalledWith({ name: '🙂'.repeat(80), requiresNote: false }),
    )
  })

  describe('when the server refuses', () => {
    it('409 name_taken is the Name field’s error, case-insensitively and for a retired one too; the dialog stays open', async () => {
      server.categories = [category('c-1', 'Seminars', false, true)]
      await renderLoaded()
      openAdd('categories')

      typeName('SEMINARS')
      submitDialog()

      const error = await within(dialog()).findByTestId('time-lists-dialog-name-error')
      expect(error.textContent).toBe('A category with this name already exists. It may be retired.')
      expect(nameField().getAttribute('aria-invalid')).toBe('true')
      expect(nameField().value).toBe('SEMINARS')
      expect(rowNames('categories')).toEqual(['Seminars'])
    })

    it('a work-type name is unique per list: Analysis exists in both, Workshop in neither', async () => {
      await renderLoaded()
      openAdd('project')
      typeName('analysis')
      submitDialog()
      expect((await within(dialog()).findByTestId('time-lists-dialog-name-error')).textContent).toBe(
        'A work type with this name already exists in this list. It may be retired.',
      )
    })

    it('403 is an inline error in the dialog, not the permission-denied page', async () => {
      api.createCategory().mockRejectedValueOnce(problem(403, 'time_list_manage_required', 'Forbidden'))
      await renderLoaded()
      openAdd('categories')
      typeName('Seminars')

      submitDialog()

      const alert = await within(dialog()).findByTestId('time-lists-dialog-error')
      expect(alert.textContent).toContain("You can't manage the time lists.")
      expect(screen.queryByTestId('permission-denied')).toBeNull()
      expect(nameField().value).toBe('Seminars')
    })

    it('503 authz_unavailable is an inline error in the dialog, values kept, ready to try again', async () => {
      api.createCategory().mockRejectedValueOnce(problem(503, 'authz_unavailable'))
      await renderLoaded()
      openAdd('categories')
      typeName('Seminars')

      submitDialog()

      const alert = await within(dialog()).findByTestId('time-lists-dialog-error')
      expect(alert.textContent).toContain('Authorization service unavailable.')
      expect(nameField().value).toBe('Seminars')

      submitDialog()

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(rowNames('categories')).toContain('Seminars')
    })

    it.each([
      ['a 500', () => problem(500, undefined, 'Internal Server Error')],
      ['a network failure', () => new TypeError('Failed to fetch')],
    ])('%s is "Something went wrong. Nothing was changed." in the dialog', async (_label, failure) => {
      api.createWorkType().mockRejectedValueOnce(failure())
      await renderLoaded()
      openAdd('deal')
      typeName('Workshop')

      submitDialog()

      const alert = await within(dialog()).findByTestId('time-lists-dialog-error')
      expect(alert.textContent).toBe('Something went wrong. Nothing was changed.')
      expect(rowNames('deal')).not.toContain('Workshop')
      expect(screen.queryByTestId('time-lists-notice')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// (F) Rename
// ---------------------------------------------------------------------------

/** Opens the Rename dialog the way a keyboard user does. */
const openRename = (name: string) => {
  const button = screen.getByRole('button', { name: `Rename ${name}` })
  button.focus()
  fireEvent.click(button)
}
const noteCheckbox = () =>
  within(dialog()).getByRole('checkbox', { name: 'Entries in this category need a note' }) as HTMLInputElement

describe('Rename', () => {
  it('opens "Rename category" with the item’s name and note flag, and focus in Name', async () => {
    await renderLoaded()

    openRename('Other')

    expect(screen.getByRole('dialog', { name: 'Rename category' })).not.toBeNull()
    expect(nameField().value).toBe('Other')
    expect(noteCheckbox().checked).toBe(true)
    expect(document.activeElement).toBe(nameField())
  })

  it('a work type opens its own title, with no note checkbox', async () => {
    await renderLoaded()

    openRename('Demo')

    expect(screen.getByRole('dialog', { name: 'Rename deal work type' })).not.toBeNull()
    expect(within(dialog()).queryByRole('checkbox')).toBeNull()
  })

  it('a new name sends only the name; the row shows it where it was, a banner says so, focus returns to its Rename', async () => {
    await renderLoaded()
    openRename('Training')

    typeName('  Formazione  ')
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.updateCategory()).toHaveBeenCalledTimes(1)
    expect(api.updateCategory()).toHaveBeenCalledWith('c-training', { name: 'Formazione' })
    expect(rowNames('categories')).toEqual(['Formazione', 'Talk preparation', 'Administration', 'Other'])
    expect(screen.getByTestId('time-lists-notice').textContent).toBe('Renamed to “Formazione”.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Formazione' }))
    expect(api.list()).toHaveBeenCalledTimes(1)
  })

  it('only the note flag changed: PATCH { requiresNote } and nothing else, and the banner says what that means', async () => {
    await renderLoaded()
    openRename('Training')

    fireEvent.click(noteCheckbox())
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.updateCategory()).toHaveBeenCalledWith('c-training', { requiresNote: true })
    expect(within(row('categories', 'c-training')).getAllByRole('cell')[0].textContent).toBe('Yes')
    expect(screen.getByTestId('time-lists-notice').textContent).toBe('“Training” updated: entries now need a note.')
  })

  it('clearing the flag says entries no longer need one', async () => {
    await renderLoaded()
    openRename('Other')

    fireEvent.click(noteCheckbox())
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.updateCategory()).toHaveBeenCalledWith('c-other', { requiresNote: false })
    expect(screen.getByTestId('time-lists-notice').textContent).toBe('“Other” updated: entries no longer need a note.')
  })

  it('both changed: both members in one PATCH', async () => {
    await renderLoaded()
    openRename('Training')

    typeName('Formazione')
    fireEvent.click(noteCheckbox())
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.updateCategory()).toHaveBeenCalledTimes(1)
    expect(api.updateCategory()).toHaveBeenCalledWith('c-training', { name: 'Formazione', requiresNote: true })
  })

  it('nothing changed: no request, the dialog just closes and nothing is announced', async () => {
    await renderLoaded()
    openRename('Training')

    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.updateCategory()).not.toHaveBeenCalled()
    expect(screen.queryByTestId('time-lists-notice')).toBeNull()
  })

  it('a change of case alone is a rename', async () => {
    await renderLoaded()
    openRename('Training')

    typeName('TRAINING')
    submitDialog()

    await waitFor(() => expect(api.updateCategory()).toHaveBeenCalledWith('c-training', { name: 'TRAINING' }))
  })

  it('a work type is renamed through the work-type route, by name alone', async () => {
    await renderLoaded()
    openRename('Demo')

    typeName('Product demo')
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.updateWorkType()).toHaveBeenCalledTimes(1)
    expect(api.updateWorkType()).toHaveBeenCalledWith('wd-demo', { name: 'Product demo' })
    expect(api.updateCategory()).not.toHaveBeenCalled()
    expect(rowNames('deal')).toEqual(['Analysis', 'Estimate', 'Product demo', 'Offer'])
  })

  it('a retired item renamed stays among the retired ones, and Restore stays on its row', async () => {
    server.categories = [category('c-1', 'Training'), category('c-2', 'Seminars', false, true)]
    await renderLoaded()
    openRename('Seminars')

    typeName('Workshops')
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(rowNames('categories')).toEqual(['Training', 'Workshops'])
    expect(within(row('categories', 'c-2')).getByRole('button', { name: 'Restore Workshops' })).not.toBeNull()
  })

  it('names render exactly as typed: accents, case, inner spaces and quotes are not touched', async () => {
    await renderLoaded()
    openRename('Training')

    typeName('Formazione “e” Aggiornamento — è già ÀÈ')
    submitDialog()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(row('categories', 'c-training')).getByRole('rowheader').textContent).toBe(
      'Formazione “e” Aggiornamento — è già ÀÈ',
    )
  })

  describe('when the server refuses', () => {
    it('409 name_taken, also onto a retired item’s name: the Name field’s error, the row unchanged, the dialog open', async () => {
      server.categories = [category('c-1', 'Training'), category('c-2', 'Seminars', false, true)]
      await renderLoaded()
      openRename('Training')

      typeName('seminars')
      submitDialog()

      const error = await within(dialog()).findByTestId('time-lists-dialog-name-error')
      expect(error.textContent).toBe('A category with this name already exists. It may be retired.')
      expect(nameField().getAttribute('aria-invalid')).toBe('true')
      expect(rowNames('categories')).toEqual(['Training', 'Seminars'])
      expect(screen.queryByTestId('time-lists-notice')).toBeNull()
    })

    it('403 and 503 are inline in the dialog, the row unchanged', async () => {
      api.updateCategory().mockRejectedValueOnce(problem(403, 'time_list_manage_required', 'Forbidden'))
      api.updateCategory().mockRejectedValueOnce(problem(503, 'authz_unavailable'))
      await renderLoaded()
      openRename('Training')
      typeName('Formazione')

      submitDialog()
      expect((await within(dialog()).findByTestId('time-lists-dialog-error')).textContent).toContain(
        "You can't manage the time lists.",
      )
      submitDialog()
      await waitFor(() =>
        expect(within(dialog()).getByTestId('time-lists-dialog-error').textContent).toContain(
          'Authorization service unavailable.',
        ),
      )

      expect(screen.queryByTestId('permission-denied')).toBeNull()
      expect(rowNames('categories')[0]).toBe('Training')
    })

    it('404 not_found: the item is gone, so the dialog closes, the lists reload and an info banner says so', async () => {
      await renderLoaded()
      openRename('Training')
      typeName('Formazione')
      server.categories = server.categories.filter((c) => c.id !== 'c-training')
      api.updateCategory().mockRejectedValueOnce(problem(404, 'not_found', 'Not Found'))

      submitDialog()

      // The banner is up as soon as the 404 lands; the reload then swaps the lists, so wait for it.
      await waitFor(() => expect(rowNames('categories')).toEqual(['Talk preparation', 'Administration', 'Other']))
      expect((await screen.findByTestId('time-lists-notice')).textContent).toBe(
        'That item no longer exists, so the lists were reloaded.',
      )
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(api.list()).toHaveBeenCalledTimes(2)
    })
  })

  describe('beside a Retire or Restore', () => {
    it('Rename does nothing while its own row’s Retire is in flight', async () => {
      const pending = hold<TimeCategory>()
      api.updateCategory().mockReturnValueOnce(pending.promise)
      await renderLoaded()
      fireEvent.click(screen.getByRole('button', { name: 'Retire Training' }))

      fireEvent.click(screen.getByTestId('time-lists-rename-categories-c-training'))

      expect(screen.queryByRole('dialog')).toBeNull()
      await act(async () => pending.resolve(category('c-training', 'Training', false, true)))
      // Idle again: now it opens.
      fireEvent.click(screen.getByTestId('time-lists-rename-categories-c-training'))
      expect(screen.getByRole('dialog', { name: 'Rename category' })).not.toBeNull()
    })

    it('a Retire that finishes while another row’s dialog is open does not take focus out of the dialog', async () => {
      const pending = hold<TimeCategory>()
      api.updateCategory().mockReturnValueOnce(pending.promise)
      await renderLoaded()
      const retire = screen.getByRole('button', { name: 'Retire Training' })
      retire.focus()
      fireEvent.click(retire)
      openRename('Administration')
      expect(document.activeElement).toBe(nameField())

      await act(async () => pending.resolve(category('c-training', 'Training', false, true)))

      expect(within(row('categories', 'c-training')).getByText('Retired')).not.toBeNull()
      expect(document.activeElement).toBe(nameField())
    })
  })
})

// ---------------------------------------------------------------------------
// (G) Empty lists
// ---------------------------------------------------------------------------

describe('an empty list', () => {
  it('an empty Categories card says so in its own panel, keeps its Add button and shows no table', async () => {
    server.categories = []
    await renderLoaded()

    const empty = within(card('categories')).getByTestId('time-lists-empty-categories')
    expect(within(empty).getByRole('heading', { level: 4 }).textContent).toBe('No categories yet')
    expect(empty.textContent).toContain('Add one so people can record hours on work that is not in Operai.')
    expect(within(card('categories')).queryByRole('table')).toBeNull()
    expect(addButton('categories')).not.toBeNull()
    // The other cards are unaffected.
    expect(rowNames('project')).toHaveLength(4)
  })

  it('an empty work-type card says entries can be recorded without one', async () => {
    server.workTypes.deal = []
    await renderLoaded()

    const empty = within(card('deal')).getByTestId('time-lists-empty-deal')
    expect(within(empty).getByRole('heading', { level: 4 }).textContent).toBe('No work types yet')
    expect(empty.textContent).toContain('Entries can be recorded without one.')
    expect(within(card('deal')).queryByRole('table')).toBeNull()
  })

  it('a list that holds only retired rows shows them, not the empty state', async () => {
    server.workTypes.deal = [workType('deal', 'd-1', 'Old', true)]
    await renderLoaded()

    expect(within(card('deal')).queryByTestId('time-lists-empty-deal')).toBeNull()
    expect(rowNames('deal')).toEqual(['Old'])
  })

  it('adding the first item replaces the empty state with the table, and the page has had no empty state before it', async () => {
    server.categories = []
    await renderLoaded()
    openAdd('categories')

    typeName('Seminars')
    submitDialog()

    await waitFor(() => expect(rowNames('categories')).toEqual(['Seminars']))
    expect(within(card('categories')).queryByTestId('time-lists-empty-categories')).toBeNull()
  })

  it('each card says in a footnote why its items can be retired and restored but never deleted', async () => {
    await renderLoaded()

    expect(
      within(card('categories')).getByText(
        'Entries keep their category, so it can be retired and restored but not deleted.',
      ),
    ).not.toBeNull()
    expect(
      within(card('project')).getByText(
        'Entries keep their work type, so it can be retired and restored but not deleted.',
      ),
    ).not.toBeNull()
    expect(
      within(card('deal')).getByText(
        'Entries keep their work type, so it can be retired and restored but not deleted.',
      ),
    ).not.toBeNull()
  })
})
