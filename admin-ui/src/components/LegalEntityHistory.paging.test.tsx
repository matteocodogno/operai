/**
 * @vitest-environment jsdom
 *
 * The History view in pages (T61, specs/20261117-legal-entities, design S5 paging, plan G5 and G11; AC-2.2, AC-8.1,
 * AC-8.2): the newest 50, "Show older versions" while the answer carries `nextBefore`, the rows kept when a page is
 * appended, the loading state that keeps the button and its focus, focus on the first new row's Open, the last page
 * without the button, a failed page that keeps the rows and puts focus on Retry, the pages kept when a version is
 * opened and closed, Open and Restore on an appended row, and axe on each state.
 */
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { entityFixture, renderPage } from '../pages/LegalEntitiesPage.fixtures'
import {
  LegalEntityApiError,
  getLegalEntity,
  getManageable,
  getVersion,
  listLegalEntities,
  listVersions,
  restoreVersion,
} from '../lib/legalEntitiesApi'
import type { VersionPage } from '../lib/legalEntitiesApi'
import type { LegalEntityVersion, VersionListItem } from '../lib/legalEntityModel'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return {
    ...original,
    getManageable: vi.fn(),
    listLegalEntities: vi.fn(),
    getLegalEntity: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    restoreVersion: vi.fn(),
  }
})

const PATH = '/legal-entities?entity=welld_ch&view=history'
const TOTAL = 130
const CURRENT = entityFixture('welld_ch', { version: TOTAL, vatNumber: 'CHE-123.456.789', iban: 'CH9300762011623852957' })

const item = (version: number): VersionListItem => ({
  version,
  action: 'save',
  restoredFrom: null,
  createdBy: { id: 'u1', name: 'Anna Rossi' },
  createdAt: '2026-11-14T10:12:00.000Z',
  changedFields: ['iban'],
  restorable: true,
})

/** What the registry answers: versions `TOTAL` down to 1, `limit` at a time, those below `before`. */
const answerPage = (query: { limit?: number; before?: number } = {}): VersionPage => {
  const limit = query.limit ?? 50
  const top = query.before === undefined ? TOTAL : query.before - 1
  const items: VersionListItem[] = []
  for (let version = top; version >= 1 && items.length < limit; version -= 1) items.push(item(version))
  const oldest = items.length === 0 ? 1 : items[items.length - 1].version
  return { items, nextBefore: oldest > 1 ? oldest : null }
}

const versionOf = (n: number): LegalEntityVersion => ({
  ...CURRENT,
  version: n,
  vatNumber: 'CHE-000.000.000',
  action: 'save',
  restoredFrom: null,
  createdBy: { id: 'u1', name: 'Anna Rossi' },
  createdAt: '2026-11-14T10:12:00.000Z',
})

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

const rowCount = () => within(screen.getByTestId('admin-legal-history-table')).getAllByRole('row').length - 1
const open = (n: number) => screen.getByRole('button', { name: `Open version ${n}` })
const more = () => screen.getByTestId('admin-legal-history-more')
const sentence = () => screen.getByTestId('admin-legal-history-showing').textContent
const status = () => screen.getByTestId('admin-legal-history-status').textContent

/** An answer the test settles by hand, for the state in between. */
const deferred = () => {
  let resolve!: (page: VersionPage) => void
  let reject!: (error: Error) => void
  const promise = new Promise<VersionPage>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  for (const fn of [getManageable, listLegalEntities, getLegalEntity, listVersions, getVersion, restoreVersion]) {
    vi.mocked(fn).mockReset()
  }
  vi.mocked(getManageable).mockResolvedValue(['welld_it', 'welld_ch'])
  vi.mocked(listLegalEntities).mockResolvedValue([entityFixture('welld_it'), CURRENT])
  vi.mocked(listVersions).mockImplementation(async (_entity, query) => answerPage(query))
  vi.mocked(getVersion).mockImplementation(async (_entity, n) => versionOf(n))
})

afterEach(cleanup)

describe('the first page', () => {
  it('asks for the newest 50 and, with older ones left, shows the sentence and Show older versions', async () => {
    const view = renderPage(PATH)
    await screen.findByTestId('admin-legal-history-table')

    expect(listVersions).toHaveBeenCalledWith('welld_ch', { limit: 50 })
    expect(rowCount()).toBe(50)
    expect(sentence()).toBe('Showing the 50 newest versions.')
    expect(more().textContent).toBe('Show older versions')
    expect(more().getAttribute('aria-describedby')).toBe(screen.getByTestId('admin-legal-history-showing').id)
    expect(more().getAttribute('aria-disabled')).toBeNull()
    expect(status()).toBe('')
    // Current is on the first row of the first page.
    expect(within(screen.getByTestId('admin-legal-version-row-130')).getByText('Current')).toBeTruthy()
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('shows no sentence and no button when the whole history fits in the page', async () => {
    vi.mocked(listVersions).mockResolvedValue({ items: [item(3), item(2), item(1)], nextBefore: null })
    renderPage(PATH)
    await screen.findByTestId('admin-legal-history-table')

    expect(screen.queryByTestId('admin-legal-history-showing')).toBeNull()
    expect(screen.queryByTestId('admin-legal-history-more')).toBeNull()
    expect(status()).toBe('')
  })
})

describe('Show older versions', () => {
  it('keeps the button and its focus while it loads, then appends, announces and focuses the first new Open', async () => {
    const next = deferred()
    renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    vi.mocked(listVersions).mockReturnValueOnce(next.promise)

    await user.click(more())

    // Loading more: the same button, aria-disabled and busy, still focused; the rows stay.
    expect(listVersions).toHaveBeenLastCalledWith('welld_ch', { limit: 50, before: 81 })
    expect(more().textContent).toContain('Loading older versions…')
    expect(more().getAttribute('aria-disabled')).toBe('true')
    expect(more().getAttribute('aria-busy')).toBe('true')
    expect(more().hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(more())
    expect(rowCount()).toBe(50)
    await user.click(more())
    expect(listVersions).toHaveBeenCalledTimes(2)

    next.resolve(answerPage({ limit: 50, before: 81 }))

    await waitFor(() => expect(rowCount()).toBe(100))
    await waitFor(() => expect(document.activeElement).toBe(open(80)))
    expect(status()).toBe('50 older versions loaded.')
    expect(sentence()).toBe('Showing the 100 newest versions.')
    expect(more().textContent).toBe('Show older versions')
    expect(more().getAttribute('aria-disabled')).toBeNull()
    // Nothing already shown was replaced.
    expect(within(screen.getByTestId('admin-legal-version-row-130')).getByText('Current')).toBeTruthy()
    expect(screen.getByTestId('admin-legal-version-row-81')).toBeTruthy()
  })

  it('removes the button on the last page and says how many versions there are', async () => {
    const view = renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')

    await user.click(more())
    await waitFor(() => expect(rowCount()).toBe(100))
    await user.click(more())

    await waitFor(() => expect(rowCount()).toBe(130))
    expect(listVersions).toHaveBeenLastCalledWith('welld_ch', { limit: 50, before: 31 })
    expect(screen.queryByTestId('admin-legal-history-more')).toBeNull()
    expect(sentence()).toBe('Showing all 130 versions.')
    expect(status()).toBe('30 older versions loaded.')
    await waitFor(() => expect(document.activeElement).toBe(open(30)))
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('says "1 older version loaded." for one', async () => {
    vi.mocked(listVersions)
      .mockResolvedValueOnce({ items: [item(3), item(2)], nextBefore: 2 })
      .mockResolvedValueOnce({ items: [item(1)], nextBefore: null })
    renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')

    await user.click(more())

    await waitFor(() => expect(status()).toBe('1 older version loaded.'))
    expect(sentence()).toBe('Showing all 3 versions.')
  })

  it('keeps the rows when the page fails, moves focus to Retry, and carries on as loaded on success', async () => {
    const view = renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    vi.mocked(listVersions).mockRejectedValueOnce(new Error('down'))

    await user.click(more())

    const banner = await screen.findByText('Older versions could not be loaded. The versions above are still shown.')
    expect(banner).toBeTruthy()
    expect(rowCount()).toBe(50)
    expect(screen.queryByTestId('admin-legal-history-more')).toBeNull()
    const retry = within(screen.getByTestId('admin-legal-history-paging')).getByRole('button', { name: 'Retry' })
    await waitFor(() => expect(document.activeElement).toBe(retry))
    expect(await axeViolations(view.container)).toEqual([])

    const next = deferred()
    vi.mocked(listVersions).mockReturnValueOnce(next.promise)
    await user.click(retry)
    // Retry is gone while it loads: the loading button has the focus.
    await waitFor(() => expect(more().getAttribute('aria-busy')).toBe('true'))
    expect(document.activeElement).toBe(more())
    expect(listVersions).toHaveBeenLastCalledWith('welld_ch', { limit: 50, before: 81 })
    expect(screen.queryByText('Older versions could not be loaded. The versions above are still shown.')).toBeNull()

    next.resolve(answerPage({ limit: 50, before: 81 }))
    await waitFor(() => expect(rowCount()).toBe(100))
    await waitFor(() => expect(document.activeElement).toBe(open(80)))
    expect(status()).toBe('50 older versions loaded.')
  })

  it('treats a page that brings nothing new but says more remain as a failure, not a loop', async () => {
    renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    // The same versions again, with a cursor that still points past them.
    vi.mocked(listVersions).mockResolvedValueOnce(answerPage())

    await user.click(more())

    await screen.findByText('Older versions could not be loaded. The versions above are still shown.')
    expect(rowCount()).toBe(50)
    expect(status()).toBe('')
  })
})

describe('the pages are kept', () => {
  it('finds the same rows after opening a version and coming back, with focus on that row’s Open', async () => {
    const { router } = renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    await user.click(more())
    await waitFor(() => expect(rowCount()).toBe(100))
    expect(listVersions).toHaveBeenCalledTimes(2)

    // Open on an appended row works.
    await user.click(open(60))
    const heading = await screen.findByRole('heading', { level: 4, name: 'Viewing version 60 (read-only)' })
    expect(router.state.location.search).toEqual({ entity: 'welld_ch', view: 'history', version: 60 })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    await user.click(screen.getByTestId('admin-legal-version-banner-back'))

    await waitFor(() => expect(rowCount()).toBe(100))
    await waitFor(() => expect(document.activeElement).toBe(open(60)))
    expect(sentence()).toBe('Showing the 100 newest versions.')
    expect(listVersions).toHaveBeenCalledTimes(2)
  })

  it('puts focus on the table when Back finds no row for the version (a link to an old one)', async () => {
    const { router } = renderPage(`${PATH}&version=5`)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-version-banner')

    await user.click(screen.getByTestId('admin-legal-version-banner-back'))

    await screen.findByTestId('admin-legal-history-table')
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch', view: 'history' }))
    const region = screen.getByTestId('admin-legal-history-table').closest('[role="region"]')
    await waitFor(() => expect(document.activeElement).toBe(region))
  })

  it('restores an appended row and, after a conflict, starts again from the first page', async () => {
    renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    await user.click(more())
    await waitFor(() => expect(rowCount()).toBe(100))

    vi.mocked(restoreVersion).mockRejectedValueOnce(
      new LegalEntityApiError(
        { type: 'x', title: 'conflict', status: 409, code: 'version_conflict' },
        { currentVersion: TOTAL + 1 },
      ),
    )
    vi.mocked(getLegalEntity).mockResolvedValue({ ...CURRENT, version: TOTAL + 1 })
    await user.click(screen.getByRole('button', { name: 'Restore version 60' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('heading', { name: 'Restore version 60?' })).toBeTruthy()
    await user.click(await screen.findByTestId('admin-legal-restore-confirm'))
    await within(dialog).findByText(/A newer version was saved meanwhile/)

    expect(restoreVersion).toHaveBeenCalledWith('welld_ch', 60, TOTAL)
    // The reload is the first page again.
    await waitFor(() => expect(rowCount()).toBe(50))
    expect(sentence()).toBe('Showing the 50 newest versions.')
    expect(more().textContent).toBe('Show older versions')
  })
})
