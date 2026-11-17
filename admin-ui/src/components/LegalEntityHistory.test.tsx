/**
 * @vitest-environment jsdom
 *
 * The History view with the real page, panel, table, version view and restore dialog around it (T39,
 * specs/20261117-legal-entities, design S5–S7, flows F8–F10; AC-2.2, AC-2.3, AC-2.4, AC-7.2, AC-8.1): the versions
 * newest first with who, when and what changed ("System" and "Moved from the CRM" for version 1), no Restore on the
 * current row, a non-restorable row's disabled Restore with its reason, Open pushing `&version=n` with the heading
 * focused and Back returning to the row's Open, the restore dialog (what it makes, what changes, its refusals) and
 * a restore ending on Details with the heading focused, a read-only entity with Open only, and axe on each state.
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
import type { LegalEntity, LegalEntityId, LegalEntityVersion, VersionListItem } from '../lib/legalEntityModel'

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

/** WellD CH at version 4. Version 2 cannot be restored (E1); version 1 is the move. */
const CURRENT = entityFixture('welld_ch', { version: 4, vatNumber: 'CHE-123.456.789', iban: 'CH9300762011623852957' })

const listItem = (over: Partial<VersionListItem> & Pick<VersionListItem, 'version'>): VersionListItem => ({
  action: 'save',
  restoredFrom: null,
  createdBy: { id: 'u1', name: 'Anna Rossi' },
  createdAt: '2026-11-14T10:12:00.000Z',
  changedFields: [],
  restorable: true,
  ...over,
})

/** An answer of the versions list; the last page by default. */
const page = (items: VersionListItem[], nextBefore: number | null = null): VersionPage => ({ items, nextBefore })

const LIST: VersionListItem[] = [
  listItem({ version: 4, changedFields: ['address.en'] }),
  listItem({
    version: 3,
    action: 'restore',
    restoredFrom: 1,
    createdAt: '2026-11-10T09:01:00.000Z',
    changedFields: ['iban', 'contacts.it'],
  }),
  listItem({
    version: 2,
    createdBy: { id: 'u2', name: 'Marco Bianchi' },
    createdAt: '2026-11-02T15:20:00.000Z',
    changedFields: ['vatNumber'],
    restorable: false,
  }),
  listItem({
    version: 1,
    action: 'import',
    createdBy: null,
    createdAt: '2026-10-17T08:00:00.000Z',
    changedFields: ['legalName', 'address.it', 'address.en', 'vatNumber', 'iban'],
  }),
]

/** What version n held: version 1 differs from the current one in the VAT number and the IBAN. */
const versionAnswer = (n: number): LegalEntityVersion => {
  const meta = LIST.find((item) => item.version === n) ?? LIST[0]
  const details: Partial<LegalEntity> =
    n === 4
      ? {}
      : n === 2
        ? { vatNumber: '', complete: false, missing: ['vatNumber'] }
        : { vatNumber: 'CHE-000.000.000', iban: 'CH5604835012345678009', ibanPrint: 'CH56 0483 5012 3456 7800 9' }
  return {
    ...CURRENT,
    ...details,
    version: n,
    action: meta.action,
    restoredFrom: meta.restoredFrom,
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
  }
}

const answer = (manageable: LegalEntityId[] = ['welld_it', 'welld_ch']) => {
  vi.mocked(getManageable).mockResolvedValue(manageable)
  vi.mocked(listLegalEntities).mockResolvedValue([entityFixture('welld_it'), CURRENT])
}

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

const rowOf = (n: number) => screen.getByTestId(`admin-legal-version-row-${n}`)
const button = (name: string) => screen.getByRole('button', { name })

beforeEach(() => {
  for (const fn of [getManageable, listLegalEntities, getLegalEntity, listVersions, getVersion, restoreVersion]) {
    vi.mocked(fn).mockReset()
  }
  vi.mocked(listVersions).mockResolvedValue(page(LIST))
  vi.mocked(getVersion).mockImplementation(async (_entity, n) => versionAnswer(n))
  answer()
})

afterEach(cleanup)

describe('the versions (S5, AC-2.2, AC-7.2)', () => {
  it('lists every version newest first with who, when and what changed', async () => {
    // The API answers newest first; the table must not depend on it.
    vi.mocked(listVersions).mockResolvedValue(page([...LIST].reverse()))
    const view = renderPage(PATH)

    const table = await screen.findByTestId('admin-legal-history-table')
    expect(within(table).getByText('Versions of WellD CH')).toBeTruthy()
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      '4Current',
      '3Restored from version 1',
      '2',
      '1',
    ])
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Anna Rossi',
      'Anna Rossi',
      'Marco Bianchi',
      'System',
    ])
    expect(rowOf(4).querySelector('time')?.getAttribute('datetime')).toBe('2026-11-14T10:12:00.000Z')
    expect(within(rowOf(4)).getAllByRole('cell')[2]?.textContent).toBe('Address (English)')
    expect(within(rowOf(3)).getAllByRole('cell')[2]?.textContent).toBe(
      'Same details as version 1IBAN, Contacts line (Italian)',
    )
    expect(within(rowOf(2)).getAllByRole('cell')[2]?.textContent).toBe('VAT number')
    expect(within(rowOf(1)).getAllByRole('cell')[2]?.textContent).toBe('Moved from the CRM')
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('offers no Restore on the current row, and Open on every row', async () => {
    renderPage(PATH)
    await screen.findByTestId('admin-legal-history-table')

    expect(within(rowOf(4)).queryByRole('button', { name: /^Restore/ })).toBeNull()
    for (const n of [4, 3, 2, 1]) expect(within(rowOf(n)).getByRole('button', { name: `Open version ${n}` })).toBeTruthy()
    for (const n of [3, 2, 1]) expect(within(rowOf(n)).getByRole('button', { name: `Restore version ${n}` })).toBeTruthy()
  })

  it('keeps a version the registry says is not restorable: Restore is aria-disabled, focusable and described', async () => {
    renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')

    const blocked = button('Restore version 2')
    expect(blocked.getAttribute('aria-disabled')).toBe('true')
    expect(blocked.hasAttribute('disabled')).toBe(false)
    const reason = document.getElementById(blocked.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toBe(
      'This version cannot be restored: it is missing a required value or holds one today’s rules refuse. Open it to see which.',
    )
    expect(button('Restore version 3').getAttribute('aria-disabled')).toBeNull()

    await user.click(blocked)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows a read-only entity’s history with Open only', async () => {
    answer(['welld_it'])
    const view = renderPage(PATH)
    await screen.findByTestId('admin-legal-history-table')

    expect(screen.getAllByRole('button', { name: /^Open version/ })).toHaveLength(4)
    expect(screen.queryAllByRole('button', { name: /^Restore/ })).toEqual([])
    expect(screen.queryByText(/cannot be restored/)).toBeNull()
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('says "No versions yet" for an empty list', async () => {
    vi.mocked(listVersions).mockResolvedValue(page([]))
    renderPage(PATH)
    expect(await screen.findByTestId('admin-legal-entity-history-empty')).toBeTruthy()
  })

  it('announces the load, and says when the list could not be read, with Retry', async () => {
    let settle!: (answer: VersionPage) => void
    vi.mocked(listVersions).mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    renderPage(PATH)
    const user = userEvent.setup()

    expect(await screen.findByText('Loading…')).toBeTruthy()
    expect(screen.getByTestId('skeleton-list-rows')).toBeTruthy()
    settle(page(LIST))
    await screen.findByTestId('admin-legal-history-table')

    // Coming back to History reads the list again; this time it fails.
    await user.click(screen.getByRole('tab', { name: 'Details' }))
    vi.mocked(listVersions).mockRejectedValueOnce(new Error('down'))
    await user.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByTestId('error-banner')).toBeTruthy()
    expect(screen.queryByTestId('admin-legal-history-table')).toBeNull()

    await user.click(screen.getByTestId('error-banner-retry'))
    expect(await screen.findByTestId('admin-legal-history-table')).toBeTruthy()
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('keeps the rows it has when the reload after a conflict fails', async () => {
    renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')

    // Restore → 409 reloads the list; make that reload fail.
    vi.mocked(restoreVersion).mockRejectedValueOnce(
      new LegalEntityApiError(
        { type: 'x', title: 'conflict', status: 409, code: 'version_conflict' },
        { currentVersion: 5 },
      ),
    )
    vi.mocked(listVersions).mockRejectedValueOnce(new Error('down'))
    vi.mocked(getLegalEntity).mockResolvedValue({ ...CURRENT, version: 5 })
    await user.click(button('Restore version 1'))
    await user.click(await screen.findByTestId('admin-legal-restore-confirm'))
    await screen.findByText(/A newer version was saved meanwhile/)

    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy())
    expect(screen.getByTestId('admin-legal-history-table')).toBeTruthy()
  })
})

describe('a version (S6, AC-2.3)', () => {
  it('opens inside the panel with a pushed entry, the heading focused, and Back returns to the row’s Open', async () => {
    const { router, container } = renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    const length = router.history.length

    await user.click(button('Open version 3'))

    const heading = await screen.findByRole('heading', { level: 4, name: 'Viewing version 3 (read-only)' })
    expect(router.state.location.search).toEqual({ entity: 'welld_ch', view: 'history', version: 3 })
    expect(router.history.length).toBe(length + 1)
    await waitFor(() => expect(document.activeElement).toBe(heading))
    // The entity header, the tabs and the facts stay; the table is replaced.
    expect(screen.getByRole('heading', { level: 3, name: 'WellD CH' })).toBeTruthy()
    expect(screen.queryByTestId('admin-legal-history-table')).toBeNull()
    const banner = screen.getByTestId('admin-legal-version-banner')
    expect(banner.textContent).toContain('The current version is 4.')
    expect(banner.textContent).toContain('Saved by Anna Rossi on')
    expect(banner.textContent).toContain('Not current')
    expect(banner.getAttribute('role')).toBe('note')
    expect(screen.getByTestId('admin-legal-fact-iban').textContent).toBe('CH56 0483 5012 3456 7800 9')
    expect(screen.queryAllByRole('textbox')).toEqual([])
    expect(await axeViolations(container)).toEqual([])

    await user.click(screen.getByTestId('admin-legal-version-banner-back'))
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch', view: 'history' }))
    await waitFor(() => expect(document.activeElement).toBe(button('Open version 3')))
  })

  it('also returns focus to the row after the browser’s Back', async () => {
    const { router } = renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    await user.click(button('Open version 1'))
    await screen.findByTestId('admin-legal-version-view')

    router.history.back()
    await waitFor(() => expect(document.activeElement).toBe(button('Open version 1')))
  })

  it('goes to Details when the current row is opened', async () => {
    const { router } = renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')

    await user.click(button('Open version 4'))

    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch' }))
    expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens a linked version without the history having to be asked first, and a version that is the current one without Restore', async () => {
    renderPage('/legal-entities?entity=welld_ch&view=history&version=4')
    const banner = await screen.findByTestId('admin-legal-version-banner')
    expect(banner.textContent).not.toContain('Not current')
    expect(screen.queryByTestId('admin-legal-version-banner-restore')).toBeNull()
  })

  it('offers Restore this version to a person who may change the entity, and not to one who may not', async () => {
    renderPage('/legal-entities?entity=welld_ch&view=history&version=3')
    const restore = await screen.findByTestId('admin-legal-version-banner-restore')
    expect(restore.textContent).toBe('Restore this version')
    expect(restore.getAttribute('aria-haspopup')).toBe('dialog')
    cleanup()

    answer(['welld_it'])
    renderPage('/legal-entities?entity=welld_ch&view=history&version=3')
    await screen.findByTestId('admin-legal-version-banner')
    expect(screen.queryByTestId('admin-legal-version-banner-restore')).toBeNull()
    expect(screen.getByTestId('admin-legal-version-banner-back')).toBeTruthy()
  })

  it('disables Restore with the values that block it when the version’s own answer says it is incomplete', async () => {
    const view = renderPage('/legal-entities?entity=welld_ch&view=history&version=2')
    const user = userEvent.setup()
    const restore = await screen.findByTestId('admin-legal-version-banner-restore')

    expect(restore.getAttribute('aria-disabled')).toBe('true')
    expect(restore.hasAttribute('disabled')).toBe(false)
    expect(document.getElementById(restore.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'This version cannot be restored: VAT number. Restoring it would make WellD CH incomplete again.',
    )
    expect(screen.getByTestId('admin-legal-fact-vatNumber').textContent).toBe('Not filled in')
    await user.click(restore)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('says the version does not exist (404) and offers Back', async () => {
    vi.mocked(getVersion).mockImplementation(async (_entity, n) => {
      if (n === 9) throw new LegalEntityApiError({ type: 'x', title: 'nf', status: 404, code: 'version_not_found' })
      return versionAnswer(n)
    })
    const { router } = renderPage('/legal-entities?entity=welld_ch&view=history&version=9')
    const user = userEvent.setup()

    expect(await screen.findByText('This version does not exist.')).toBeTruthy()
    await user.click(screen.getByTestId('admin-legal-version-back'))
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch', view: 'history' }))
  })

  it('says the version could not be read, with Retry', async () => {
    vi.mocked(getVersion).mockImplementation(async (_entity, n) => {
      if (n === 3 && vi.mocked(getVersion).mock.calls.filter(([, k]) => k === 3).length === 1) throw new Error('down')
      return versionAnswer(n)
    })
    renderPage('/legal-entities?entity=welld_ch&view=history&version=3')
    const user = userEvent.setup()

    await user.click(await screen.findByTestId('error-banner-retry'))
    expect(await screen.findByTestId('admin-legal-version-banner')).toBeTruthy()
  })
})

describe('the restore dialog (S7, AC-2.4)', () => {
  const openRestoreOfVersion1 = async () => {
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    await user.click(button('Restore version 1'))
    const dialog = await screen.findByRole('alertdialog')
    return { user, dialog }
  }
  const confirm = () => screen.getByTestId('admin-legal-restore-confirm')

  it('names the version it makes and the values that change, with Cancel focused', async () => {
    const view = renderPage(PATH)
    const { dialog } = await openRestoreOfVersion1()

    expect(within(dialog).getByRole('heading', { name: 'Restore version 1?' })).toBeTruthy()
    expect(dialog.textContent).toContain(
      'This creates version 5 with the same details as version 1 and makes it the current one. Version 4 and the rest of the history stay as they are.',
    )
    expect(screen.getByTestId('admin-legal-restore-changes').textContent).toBe(
      'Compared with the current version, these change: VAT number, IBAN.',
    )
    expect(confirm().textContent).toBe('Restore version 1')
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-restore-cancel'))
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('gives focus back to the Restore button on Cancel, and restores nothing', async () => {
    renderPage(PATH)
    const { user } = await openRestoreOfVersion1()

    await user.click(screen.getByTestId('admin-legal-restore-cancel'))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(button('Restore version 1'))
    expect(restoreVersion).not.toHaveBeenCalled()
  })

  it('restores, ends on Details with the entity heading focused and says what was made', async () => {
    const restored: LegalEntity = { ...CURRENT, version: 5, vatNumber: 'CHE-000.000.000', iban: 'CH5604835012345678009' }
    vi.mocked(restoreVersion).mockResolvedValue({ version: 5, created: true, entity: restored })
    const { router } = renderPage(PATH)
    const { user } = await openRestoreOfVersion1()

    await user.click(confirm())

    await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith('welld_ch', 1, 4))
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    const heading = screen.getByRole('heading', { level: 3, name: 'WellD CH' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    const notice = screen.getByTestId('admin-legal-restored')
    expect(notice.textContent).toBe('Version 5 created from version 1')
    expect(notice.getAttribute('role')).toBe('status')
    // The form shows the restored values.
    expect((screen.getByRole('textbox', { name: /^VAT number/ }) as HTMLInputElement).value).toBe('CHE-000.000.000')
  })

  it('ends the notice when the person leaves Details', async () => {
    vi.mocked(restoreVersion).mockResolvedValue({ version: 5, created: true, entity: { ...CURRENT, version: 5 } })
    renderPage(PATH)
    const { user } = await openRestoreOfVersion1()
    await user.click(confirm())
    await screen.findByTestId('admin-legal-restored')

    await user.click(screen.getByRole('tab', { name: 'History' }))
    await user.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.queryByTestId('admin-legal-restored')).toBeNull()
  })

  it('restores from the version view too, with the details it already read', async () => {
    vi.mocked(restoreVersion).mockResolvedValue({ version: 5, created: true, entity: { ...CURRENT, version: 5 } })
    renderPage('/legal-entities?entity=welld_ch&view=history&version=1')
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('admin-legal-version-banner-restore'))

    await screen.findByRole('alertdialog')
    expect(screen.getByTestId('admin-legal-restore-changes').textContent).toContain('VAT number, IBAN')
    // The dialog reuses what the view read: version 1 is not fetched again.
    expect(vi.mocked(getVersion).mock.calls.filter(([, n]) => n === 1)).toHaveLength(1)
    await user.click(confirm())
    expect(await screen.findByTestId('admin-legal-restored')).toBeTruthy()
  })

  it('says nothing was created when the details were already the current ones (200 created: false)', async () => {
    vi.mocked(restoreVersion).mockResolvedValue({ version: 4, created: false, entity: CURRENT })
    renderPage(PATH)
    const { user } = await openRestoreOfVersion1()
    await user.click(confirm())

    expect((await screen.findByTestId('admin-legal-restored')).textContent).toBe(
      'Nothing changed. These details are already version 4, so no new version was made.',
    )
  })

  it('is busy while it restores and cannot be left', async () => {
    let settle!: (value: { version: number; created: boolean; entity: LegalEntity }) => void
    vi.mocked(restoreVersion).mockReturnValue(new Promise((resolve) => (settle = resolve)))
    renderPage(PATH)
    const { user, dialog } = await openRestoreOfVersion1()

    await user.click(confirm())
    expect(confirm().textContent).toBe('Restoring…')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    expect(vi.mocked(restoreVersion)).toHaveBeenCalledTimes(1)

    settle({ version: 5, created: true, entity: { ...CURRENT, version: 5 } })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('stays open with the values refused when the version fails today’s rules (422)', async () => {
    vi.mocked(restoreVersion).mockRejectedValue(
      new LegalEntityApiError(
        { type: 'x', title: 'invalid', status: 422, code: 'invalid_legal_entity' },
        {
          problems: [
            { field: 'iban', reason: 'iban_check_digits' },
            { field: 'vatNumber', reason: 'required' },
          ],
        },
      ),
    )
    const view = renderPage(PATH)
    const { user, dialog } = await openRestoreOfVersion1()
    await user.click(confirm())

    const error = await within(dialog).findByRole('alert')
    expect(error.textContent).toBe('Version 1 cannot be restored: VAT number, IBAN. Nothing changed.')
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    expect(confirm().hasAttribute('disabled')).toBe(false)
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('reloads the history behind the dialog on a conflict (409) and restores on the new base the next time', async () => {
    vi.mocked(restoreVersion)
      .mockRejectedValueOnce(
        new LegalEntityApiError(
          { type: 'x', title: 'conflict', status: 409, code: 'version_conflict' },
          { currentVersion: 5 },
        ),
      )
      .mockResolvedValueOnce({ version: 6, created: true, entity: { ...CURRENT, version: 6 } })
    const newer: VersionListItem = listItem({ version: 5, changedFields: ['iban'] })
    const reloaded = { ...CURRENT, version: 5, iban: 'CH4431999123000889012' }
    vi.mocked(getLegalEntity).mockResolvedValue(reloaded)
    vi.mocked(getVersion).mockImplementation(async (_entity, n) => (n === 5 ? { ...versionAnswer(4), ...reloaded } : versionAnswer(n)))
    renderPage(PATH)
    const { user, dialog } = await openRestoreOfVersion1()
    vi.mocked(listVersions).mockResolvedValue(page([newer, ...LIST]))
    await user.click(confirm())

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'A newer version was saved meanwhile. The history was reloaded; check it and try again.',
    )
    await waitFor(() => expect(getLegalEntity).toHaveBeenCalledWith('welld_ch'))
    // The history behind the dialog has the newer row, and the dialog is based on it.
    await waitFor(() => expect(within(screen.getByTestId('admin-legal-history-table')).getByText('5')).toBeTruthy())
    await waitFor(() => expect(dialog.textContent).toContain('This creates version 6'))
    await waitFor(() => expect(confirm().textContent).toBe('Restore version 1'))

    await user.click(confirm())
    await waitFor(() => expect(restoreVersion).toHaveBeenLastCalledWith('welld_ch', 1, 5))
    expect(await screen.findByTestId('admin-legal-restored')).toBeTruthy()
  })

  it('says the person can no longer change the entity on a 403, and the page turns read-only', async () => {
    vi.mocked(restoreVersion).mockRejectedValue(
      new LegalEntityApiError({ type: 'x', title: 'forbidden', status: 403, code: 'forbidden' }),
    )
    renderPage(PATH)
    const { user, dialog } = await openRestoreOfVersion1()
    await user.click(confirm())

    expect((await within(dialog).findByRole('alert')).textContent).toBe('You can no longer change WellD CH')
    expect(screen.getByRole('tab', { name: 'WellD CH, Complete, Read-only' })).toBeTruthy()
    // The dialog stays until it is closed; the history behind it no longer offers Restore.
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    await user.click(screen.getByTestId('admin-legal-restore-cancel'))
    expect(screen.queryAllByRole('button', { name: /^Restore/ })).toEqual([])
  })

  it('says nothing was restored on a server failure (5xx) and lets the person try again', async () => {
    vi.mocked(restoreVersion)
      .mockRejectedValueOnce(new LegalEntityApiError({ type: 'x', title: 'down', status: 500 }))
      .mockResolvedValueOnce({ version: 5, created: true, entity: { ...CURRENT, version: 5 } })
    renderPage(PATH)
    const { user, dialog } = await openRestoreOfVersion1()
    await user.click(confirm())

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Version 1 was not restored. Nothing changed. Try again.',
    )
    await user.click(confirm())
    expect(await screen.findByTestId('admin-legal-restored')).toBeTruthy()
    expect(restoreVersion).toHaveBeenCalledTimes(2)
  })

  it('cannot be confirmed when what it must show cannot be read: the dialog says so with Retry and has no Confirm', async () => {
    vi.mocked(getVersion).mockImplementation(async (_entity, n) => {
      if (n === 1) throw new Error('down')
      return versionAnswer(n)
    })
    renderPage(PATH)
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-history-table')
    await user.click(button('Restore version 1'))

    expect((await screen.findByTestId('admin-legal-restore-details-failed')).textContent).toContain(
      'The details of version 1 could not be read, so the restore cannot be checked.',
    )
    expect(screen.queryByTestId('admin-legal-restore-confirm')).toBeNull()
    expect(restoreVersion).not.toHaveBeenCalled()
  })
})
