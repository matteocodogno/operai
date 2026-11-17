/**
 * @vitest-environment jsdom
 *
 * LegalEntitiesPage with the REAL panel (T36, specs/20261117-legal-entities, design S1 and S4): the entity tabs in
 * their fixed order with the status, Read-only and Unsaved marks in their accessible names, the default entity,
 * the Details | History views and the URL they write, the read-only panel (facts, no input, the info Banner), the
 * incomplete / needs-correction / not-moved states, loading and failure, and axe on S1 and S4.
 * The drafts and the leave guard are in LegalEntitiesPage.drafts.test.tsx (it stands the panel in).
 */
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { entityFixture, notMoved, renderPage } from './LegalEntitiesPage.fixtures'
import { ApiError } from '../lib/adminApi'
import { getManageable, getVersion, listLegalEntities } from '../lib/legalEntitiesApi'
import type { LegalEntity, LegalEntityId, LegalEntityVersion } from '../lib/legalEntityModel'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return { ...original, getManageable: vi.fn(), listLegalEntities: vi.fn(), getVersion: vi.fn() }
})

const answer = (it: LegalEntity, ch: LegalEntity, manageable: LegalEntityId[]) => {
  vi.mocked(getManageable).mockResolvedValue(manageable)
  vi.mocked(listLegalEntities).mockResolvedValue([it, ch])
}

const versionOf = (entity: LegalEntity, over: Partial<LegalEntityVersion> = {}): LegalEntityVersion => ({
  ...entity,
  action: 'save',
  restoredFrom: null,
  createdBy: { id: 'u1', name: 'Marco Bianchi' },
  createdAt: '2026-11-12T16:40:00.000Z',
  ...over,
})

const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'Legal entities' }))
    .getAllByRole('tab')
    .map((tab) => tab.textContent)

/** The page's axe run: rules that need a real browser (colour contrast, landmarks of a fragment) are off, the rest on. */
async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

beforeEach(() => {
  vi.mocked(getManageable).mockReset()
  vi.mocked(listLegalEntities).mockReset()
  vi.mocked(getVersion).mockReset()
  vi.mocked(getVersion).mockImplementation(async (entity) => versionOf(entityFixture(entity)))
})

afterEach(cleanup)

describe('the entity tabs (S1, AC-1.1, AC-7.3)', () => {
  it('shows both entities in the fixed order, the selected one first by default for a manager of both', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it', 'welld_ch'])
    renderPage('/legal-entities')

    const tabs = await screen.findAllByRole('tab', { name: /^WellD/ })
    expect(tabs.map((tab) => tab.id)).toEqual(['admin-legal-entity-tab-welld_it', 'admin-legal-entity-tab-welld_ch'])
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'WellD CH, Complete' }).getAttribute('aria-selected')).toBe('false')
  })

  it('carries Complete, Incomplete, Needs correction and Not moved yet, and Read-only, in the accessible names', async () => {
    answer(
      entityFixture('welld_it', { complete: false, missing: ['vatNumber'] }),
      entityFixture('welld_ch', { invalid: [{ field: 'legalName', reason: 'too_long', limit: 200 }] }),
      ['welld_it'],
    )
    renderPage('/legal-entities')

    expect(await screen.findByRole('tab', { name: 'WellD Italia, Incomplete' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'WellD CH, Needs correction, Read-only' })).toBeTruthy()
  })

  it('says Not moved yet for version 0, with Read-only for a person who may not change it', async () => {
    answer(entityFixture('welld_it'), notMoved('welld_ch'), ['welld_it'])
    renderPage('/legal-entities')

    expect(await screen.findByRole('tab', { name: 'WellD CH, Not moved yet, Read-only' })).toBeTruthy()
    // "Incomplete" would be wrong: nothing was moved, and there is no form to fill in.
    expect(tabNames().join()).not.toContain('Incomplete')
  })

  it('marks Read-only with words and a glyph, never colour alone (the mark is text in the tab)', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_ch'])
    renderPage('/legal-entities')

    const tab = await screen.findByRole('tab', { name: 'WellD Italia, Complete, Read-only' })
    expect(within(tab).getByText('Read-only').closest('.badge')).not.toBeNull()
  })

  it('opens on the first entity the person may change, else on WellD IT', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_ch'])
    renderPage('/legal-entities')
    expect((await screen.findByRole('tab', { name: /^WellD CH/ })).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { level: 3, name: 'WellD CH' })).toBeTruthy()
    cleanup()

    answer(entityFixture('welld_it'), entityFixture('welld_ch'), [])
    renderPage('/legal-entities')
    expect((await screen.findByRole('tab', { name: /^WellD Italia/ })).getAttribute('aria-selected')).toBe('true')
  })

  it('opens the entity named in the address, whatever the person may change', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    renderPage('/legal-entities?entity=welld_ch')

    expect((await screen.findByRole('tab', { name: /^WellD CH/ })).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('admin-legal-entity-readonly-note')).toBeTruthy()
  })

  it('has a wrapping list (it never scrolls sideways at 320 px) with one tab stop and the arrow keys', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it', 'welld_ch'])
    const { router } = renderPage('/legal-entities')
    const user = userEvent.setup()

    const list = await screen.findByRole('tablist', { name: 'Legal entities' })
    expect(list.className).toContain('tab-list-wrap')
    const [first, second] = within(list).getAllByRole('tab')
    expect(first.getAttribute('tabindex')).toBe('0')
    expect(second.getAttribute('tabindex')).toBe('-1')

    first.focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch' }))
    expect(document.activeElement).toBe(within(list).getAllByRole('tab')[1])
    await user.keyboard('{Home}')
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_it' }))
  })

  it('replaces the history entry when an entity or a view is selected (Back leaves the page, not the last tab)', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it', 'welld_ch'])
    const { router } = renderPage('/legal-entities')
    const user = userEvent.setup()
    await screen.findByRole('tab', { name: /^WellD CH/ })
    const length = router.history.length

    await user.click(screen.getByRole('tab', { name: /^WellD CH/ }))
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch' }))
    await user.click(screen.getByRole('tab', { name: 'History' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch', view: 'history' }))

    expect(router.history.length).toBe(length)
  })

  it('does not reset the view when the selected entity tab is selected again', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it', 'welld_ch'])
    const { router } = renderPage('/legal-entities?entity=welld_it&view=history')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('tab', { name: /^WellD Italia/ }))
    expect(router.state.location.search).toEqual({ entity: 'welld_it', view: 'history' })
  })
})

describe('the panel header and the views (S2, S4)', () => {
  it('repeats the status and shows the version line from the current version', async () => {
    answer(entityFixture('welld_it', { version: 7 }), entityFixture('welld_ch'), ['welld_it'])
    vi.mocked(getVersion).mockResolvedValue(versionOf(entityFixture('welld_it', { version: 7 })))
    renderPage('/legal-entities')

    const heading = await screen.findByRole('heading', { level: 3, name: 'WellD Italia' })
    const panel = heading.closest('[data-testid="admin-legal-entity-panel-welld_it"]') as HTMLElement
    expect(within(panel).getByText('Complete')).toBeTruthy()
    expect(await within(panel).findByText('Version 7 · saved by Marco Bianchi · 12.11.2026 17:40')).toBeTruthy()
    expect(getVersion).toHaveBeenCalledWith('welld_it', 7)
  })

  it('says the system moved version 1, and System for a version with no author', async () => {
    answer(entityFixture('welld_it', { version: 1 }), entityFixture('welld_ch'), ['welld_it'])
    vi.mocked(getVersion).mockResolvedValue(versionOf(entityFixture('welld_it'), { action: 'import', createdBy: null }))
    renderPage('/legal-entities')

    expect(await screen.findByText('Version 1 · moved from the CRM by the system · 12.11.2026 17:40')).toBeTruthy()
  })

  it('works without the version line when the author cannot be read', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    vi.mocked(getVersion).mockRejectedValue(new Error('down'))
    renderPage('/legal-entities')

    await screen.findByRole('heading', { level: 3, name: 'WellD Italia' })
    expect(screen.queryByTestId('admin-legal-entity-version-line')).toBeNull()
    expect(screen.getByTestId('admin-legal-entity-facts')).toBeTruthy()
  })

  it('has the Details and History views, named for the entity', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    renderPage('/legal-entities')

    const views = await screen.findByRole('tablist', { name: 'Views of WellD Italia' })
    expect(within(views).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Details', 'History'])
    expect(within(views).getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens the History view of a deep link, with its version left to the history component', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    renderPage('/legal-entities?entity=welld_ch&view=history&version=3')

    const views = await screen.findByRole('tablist', { name: 'Views of WellD CH' })
    expect(within(views).getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('admin-legal-entity-history-slot')).toBeTruthy()
  })

  it('gives the page three tab levels with one outline: h2 page, h3 entity, h4 groups', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    renderPage('/legal-entities')

    await screen.findByRole('heading', { level: 3, name: 'WellD Italia' })
    expect(screen.getByRole('heading', { level: 2, name: 'Legal entities' })).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Company',
      'Address',
      'Contacts line',
    ])
    // The outer tabpanel starts with focusable content (the view tabs), so it is not a tab stop of its own.
    const outer = document.getElementById('admin-legal-entity-panel-welld_it')
    expect(outer?.getAttribute('role')).toBe('tabpanel')
    expect(outer?.hasAttribute('tabindex')).toBe(false)
    expect(outer?.getAttribute('aria-labelledby')).toBe('admin-legal-entity-tab-welld_it')
  })
})

describe('a read-only entity (S4, AC-4.2, AC-4.3)', () => {
  it('shows the values as facts, no input, no disabled control, and the info Banner', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    renderPage('/legal-entities?entity=welld_ch')

    const note = await screen.findByTestId('admin-legal-entity-readonly-note')
    expect(note.textContent).toContain(
      'You can read these details but not change them. An administrator grants who may change WellD CH.',
    )
    expect(note.getAttribute('role')).toBe('note')
    expect(screen.queryAllByRole('textbox')).toEqual([])
    expect(document.querySelectorAll('input, textarea, select, [disabled]')).toHaveLength(0)

    const facts = screen.getByTestId('admin-legal-entity-facts')
    expect(within(facts).getByText('wellD AG')).toBeTruthy()
    expect(within(facts).getByText('IT60 X054 2811 1010 0000 0123 456')).toBeTruthy()
    // An address prints one line per row, in its own language.
    const lines = within(screen.getByTestId('admin-legal-fact-address.it')).getAllByText(/./)
    expect(lines.map((line) => line.textContent)).toEqual(['Via Esempio 12', '6900 Lugano', 'Svizzera'])
    expect(screen.getByTestId('admin-legal-fact-address.it').getAttribute('lang')).toBe('it')
    expect(screen.getByTestId('admin-legal-fact-address.en').getAttribute('lang')).toBe('en')
    // The History view stays reachable.
    expect(screen.getByRole('tab', { name: 'History' })).toBeTruthy()
  })

  it('says "Not filled in" for a required empty value and "Empty" for an optional one', async () => {
    answer(
      entityFixture('welld_it', { vatNumber: '', complete: false, missing: ['vatNumber'] }),
      entityFixture('welld_ch'),
      [],
    )
    renderPage('/legal-entities')

    expect((await screen.findByTestId('admin-legal-fact-vatNumber')).textContent).toBe('Not filled in')
    expect(screen.getByTestId('admin-legal-fact-contacts.en').textContent).toBe('Empty')
  })

  it('has no axe violation on S1 loaded and on S4 read-only, with every badge variant on the strip', async () => {
    answer(
      entityFixture('welld_it', { complete: false, missing: ['vatNumber'] }),
      entityFixture('welld_ch', { invalid: [{ field: 'iban', reason: 'iban_check_digits' }] }),
      ['welld_it'],
    )
    renderPage('/legal-entities')
    await screen.findByRole('tab', { name: 'WellD Italia, Incomplete' })
    const page = screen.getByTestId('admin-legal-entities-page')
    expect(await axeViolations(page)).toEqual([])

    // S4: the read-only entity, on both views.
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: /^WellD CH/ }))
    await screen.findByTestId('admin-legal-entity-readonly-note')
    expect(await axeViolations(page)).toEqual([])
    await user.click(screen.getByRole('tab', { name: 'History' }))
    expect(await axeViolations(page)).toEqual([])
  })

  it('has no axe violation on a not-moved entity and on a manager of both with Complete tabs', async () => {
    answer(entityFixture('welld_it'), notMoved('welld_ch'), ['welld_it', 'welld_ch'])
    renderPage('/legal-entities?entity=welld_ch')
    await screen.findByTestId('admin-legal-entity-not-moved')
    const page = screen.getByTestId('admin-legal-entities-page')
    expect(await axeViolations(page)).toEqual([])
    await userEvent.setup().click(screen.getByRole('tab', { name: 'History' }))
    expect(await axeViolations(page)).toEqual([])
    cleanup()

    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it', 'welld_ch'])
    renderPage('/legal-entities')
    await screen.findByRole('tab', { name: 'WellD Italia, Complete' })
    expect(await axeViolations(screen.getByTestId('admin-legal-entities-page'))).toEqual([])
  })
})

describe('incomplete, needs correction and not moved yet (S3)', () => {
  it('lists what is missing and what is out of rule, in words, in a persistent warning', async () => {
    answer(
      entityFixture('welld_it', {
        complete: false,
        missing: ['vatNumber'],
        invalid: [{ field: 'address.it', reason: 'too_many_lines' }],
      }),
      entityFixture('welld_ch'),
      ['welld_it'],
    )
    renderPage('/legal-entities')

    const banner = await screen.findByTestId('admin-legal-entity-incomplete')
    expect(banner.textContent).toContain('These details are incomplete')
    expect(banner.textContent).toContain(
      'Missing: VAT number. Offers and contracts for WellD Italia are refused until they are filled in and saved.',
    )
    expect(banner.textContent).toContain('To correct before the next save: Address (Italian).')
    // Persistent, not announced on arrival.
    expect(banner.getAttribute('role')).toBe('note')
    expect(banner.getAttribute('aria-live')).toBeNull()
  })

  it('says only "needs correction" when nothing required is missing (it blocks nothing)', async () => {
    answer(
      entityFixture('welld_it', { invalid: [{ field: 'legalName', reason: 'too_long', limit: 200 }] }),
      entityFixture('welld_ch'),
      ['welld_it'],
    )
    renderPage('/legal-entities')

    const banner = await screen.findByTestId('admin-legal-entity-to-correct')
    expect(banner.textContent).toContain('These details need correction')
    expect(banner.textContent).toContain('To correct before the next save: Legal name.')
    expect(screen.queryByTestId('admin-legal-entity-incomplete')).toBeNull()
  })

  it('shows no banner for a complete entity', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    renderPage('/legal-entities')

    await screen.findByTestId('admin-legal-entity-facts')
    expect(screen.queryByTestId('admin-legal-entity-incomplete')).toBeNull()
    expect(screen.queryByTestId('admin-legal-entity-to-correct')).toBeNull()
  })

  it('shows one sentence for an entity not moved yet, no values, and "No versions yet" under History', async () => {
    answer(entityFixture('welld_it'), notMoved('welld_ch'), ['welld_it', 'welld_ch'])
    renderPage('/legal-entities?entity=welld_ch')
    const user = userEvent.setup()

    const note = await screen.findByTestId('admin-legal-entity-not-moved')
    expect(note.textContent).toBe(
      'The details have not been moved into the registry yet. They can be edited once the move has run.',
    )
    expect(screen.queryByTestId('admin-legal-entity-facts')).toBeNull()
    expect(screen.queryByTestId('admin-legal-entity-incomplete')).toBeNull()
    expect(getVersion).not.toHaveBeenCalled()

    await user.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText('No versions yet')).toBeTruthy()
  })
})

describe('loading and failure (S1 states)', () => {
  it('announces the load while the skeleton shows, then shows the tabs', async () => {
    let resolve!: (list: LegalEntity[]) => void
    vi.mocked(getManageable).mockResolvedValue(['welld_it'])
    vi.mocked(listLegalEntities).mockReturnValue(new Promise((res) => (resolve = res)))
    renderPage('/legal-entities')

    expect(await screen.findByTestId('skeleton-list-rows')).toBeTruthy()
    expect(screen.getByText('Loading…').getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Legal entities' })).toBeTruthy()

    resolve([entityFixture('welld_it'), entityFixture('welld_ch')])
    expect(await screen.findByRole('tablist', { name: 'Legal entities' })).toBeTruthy()
    expect(screen.queryByTestId('skeleton-list-rows')).toBeNull()
  })

  it('shows a warning with Retry and no tabs when the entities cannot be read, and recovers on Retry', async () => {
    vi.mocked(getManageable).mockResolvedValue(['welld_it'])
    vi.mocked(listLegalEntities).mockRejectedValueOnce(new Error('down'))
    vi.mocked(listLegalEntities).mockResolvedValue([entityFixture('welld_it'), entityFixture('welld_ch')])
    renderPage('/legal-entities')
    const user = userEvent.setup()

    expect((await screen.findByTestId('error-banner')).textContent).toContain('The legal entities could not be loaded')
    expect(screen.queryByRole('tablist')).toBeNull()

    await user.click(screen.getByTestId('error-banner-retry'))
    expect(await screen.findByRole('tablist', { name: 'Legal entities' })).toBeTruthy()
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('fails closed when "manageable" cannot be read: no tabs, no guess between editable and read-only', async () => {
    vi.mocked(getManageable).mockRejectedValue(new Error('down'))
    vi.mocked(listLegalEntities).mockResolvedValue([entityFixture('welld_it'), entityFixture('welld_ch')])
    renderPage('/legal-entities')

    expect(await screen.findByTestId('error-banner')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('shows the permission-denied state on a 403', async () => {
    vi.mocked(getManageable).mockResolvedValue([])
    vi.mocked(listLegalEntities).mockRejectedValue(new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }))
    renderPage('/legal-entities')

    expect(await screen.findByTestId('permission-denied')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })
})
