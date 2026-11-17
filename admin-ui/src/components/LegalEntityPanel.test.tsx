/**
 * @vitest-environment jsdom
 *
 * LegalEntityPanel with the real page around it and the real form inside (T37, specs/20261117-legal-entities,
 * design S2 to S4): the form for an entity the person may change and the facts for one they may not, a save that
 * moves the whole page (the tab's status, the version line, the Unsaved mark), the loss of the grant (403: danger
 * Banner with focus, the panel read-only, the draft dropped), and a moved entity with its Banner and its marks (S3).
 */
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { entityFixture, renderPage } from '../pages/LegalEntitiesPage.fixtures'
import { ApiError } from '../lib/adminApi'
import {
  LegalEntityApiError,
  getManageable,
  getVersion,
  listLegalEntities,
  listVersions,
  saveLegalEntity,
} from '../lib/legalEntitiesApi'
import type { LegalEntity, LegalEntityId, LegalEntityVersion } from '../lib/legalEntityModel'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return {
    ...original,
    getManageable: vi.fn(),
    listLegalEntities: vi.fn(),
    getVersion: vi.fn(),
    listVersions: vi.fn(),
    saveLegalEntity: vi.fn(),
  }
})

const answer = (it: LegalEntity, ch: LegalEntity, manageable: LegalEntityId[]) => {
  vi.mocked(getManageable).mockResolvedValue(manageable)
  vi.mocked(listLegalEntities).mockResolvedValue([it, ch])
}

const versionOf = (entity: LegalEntity): LegalEntityVersion => ({
  ...entity,
  action: 'save',
  restoredFrom: null,
  createdBy: { id: 'u1', name: 'Anna Rossi' },
  createdAt: '2026-11-12T16:40:00.000Z',
})

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

const legalName = () => screen.getByRole('textbox', { name: /^Legal name/ }) as HTMLInputElement

beforeEach(() => {
  vi.mocked(getManageable).mockReset()
  vi.mocked(listLegalEntities).mockReset()
  vi.mocked(getVersion).mockReset()
  vi.mocked(saveLegalEntity).mockReset()
  vi.mocked(listVersions).mockReset()
  vi.mocked(listVersions).mockResolvedValue([])
  vi.mocked(getVersion).mockImplementation(async (entity, n) => ({ ...versionOf(entityFixture(entity)), version: n }))
})

afterEach(cleanup)

describe('the Details body', () => {
  it('is the form for an entity the person may change and the facts for one they may not', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    renderPage('/legal-entities')
    const user = userEvent.setup()

    expect(await screen.findByTestId('admin-legal-form')).toBeTruthy()
    expect(screen.queryByTestId('admin-legal-entity-facts')).toBeNull()

    await user.click(screen.getByRole('tab', { name: /^WellD CH/ }))
    expect(await screen.findByTestId('admin-legal-entity-facts')).toBeTruthy()
    expect(screen.queryByTestId('admin-legal-form')).toBeNull()
    expect(screen.queryAllByRole('textbox')).toEqual([])
  })

  it('keeps what was typed when the person looks at the other entity and comes back', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it', 'welld_ch'])
    renderPage('/legal-entities')
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-form')

    await user.type(legalName(), ' Group')
    expect(screen.getByRole('tab', { name: /Unsaved changes/ })).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: /^WellD CH/ }))
    await user.click(screen.getByRole('tab', { name: /^WellD Italia/ }))

    expect(legalName().value).toBe('wellD S.r.l. Group')
  })
})

describe('a save moves the page (F3)', () => {
  it('turns Incomplete into Complete, shows the new version line, drops the Unsaved mark and says what happened', async () => {
    const incomplete = entityFixture('welld_it', { vatNumber: '', complete: false, missing: ['vatNumber'] })
    answer(incomplete, entityFixture('welld_ch'), ['welld_it'])
    const user = userEvent.setup()
    const after = entityFixture('welld_it', { version: 4, vatNumber: 'IT 00000000000' })
    vi.mocked(saveLegalEntity).mockResolvedValue({ version: 4, created: true, entity: after })
    vi.mocked(getVersion).mockImplementation(async (entity, n) => ({
      ...versionOf(entityFixture(entity)),
      version: n,
      createdBy: { id: 'u2', name: n === 4 ? 'Marco Bianchi' : 'Anna Rossi' },
    }))
    renderPage('/legal-entities')

    expect(await screen.findByRole('tab', { name: 'WellD Italia, Incomplete' })).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: /^VAT number/ }), 'IT 00000000000')
    expect(screen.getByRole('tab', { name: 'WellD Italia, Incomplete, Unsaved changes' })).toBeTruthy()
    await user.click(screen.getByTestId('admin-legal-save'))

    expect((await screen.findByTestId('admin-legal-saved')).textContent).toBe(
      'Version 4 saved. Every tool uses it within a minute.',
    )
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete' })).toBeTruthy()
    expect(screen.queryByTestId('admin-legal-entity-incomplete')).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId('admin-legal-entity-version-line').textContent).toContain(
        'Version 4 · saved by Marco Bianchi',
      ),
    )
    expect(vi.mocked(saveLegalEntity)).toHaveBeenCalledWith('welld_it', expect.objectContaining({ baseVersion: 3 }))
  })
})

describe('the grant is lost (403, S2 state 8)', () => {
  it('says so in a danger Banner that takes focus, turns the panel read-only and drops the draft', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it', 'welld_ch'])
    vi.mocked(saveLegalEntity).mockRejectedValueOnce(
      new LegalEntityApiError({ type: 'about:blank', title: 'forbidden', status: 403, code: 'forbidden' }),
    )
    renderPage('/legal-entities')
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-form')
    await user.type(legalName(), ' x')
    await user.click(screen.getByTestId('admin-legal-save'))

    const banner = await screen.findByTestId('admin-legal-entity-lost')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toBe(
      'You can no longer change WellD ItaliaYour changes were not saved. The details are now read-only.',
    )
    expect(document.activeElement).toBe(banner)
    expect(screen.queryByTestId('admin-legal-form')).toBeNull()
    expect(screen.getByTestId('admin-legal-entity-facts')).toBeTruthy()
    expect(screen.getByTestId('admin-legal-entity-readonly-note')).toBeTruthy()
    // The typed value is not kept anywhere: not on screen, not as an Unsaved mark.
    expect(screen.getByTestId('admin-legal-entity-facts').textContent).not.toContain(' x')
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete, Read-only' })).toBeTruthy()
    expect(await axeViolations(screen.getByTestId('admin-legal-entities-page'))).toEqual([])
  })

  it('does not pull focus again when the person comes back to Details from History', async () => {
    answer(entityFixture('welld_it'), entityFixture('welld_ch'), ['welld_it'])
    vi.mocked(saveLegalEntity).mockRejectedValueOnce(
      new LegalEntityApiError({ type: 'about:blank', title: 'forbidden', status: 403, code: 'forbidden' }),
    )
    renderPage('/legal-entities')
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-form')
    await user.type(legalName(), ' x')
    await user.click(screen.getByTestId('admin-legal-save'))
    await screen.findByTestId('admin-legal-entity-lost')

    await user.click(screen.getByRole('tab', { name: 'History' }))
    await user.click(screen.getByRole('tab', { name: 'Details' }))
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Details' }))
  })
})

describe('an entity moved incomplete or out of limits (S3, AC-7.3)', () => {
  const moved = () =>
    entityFixture('welld_it', {
      version: 1,
      vatNumber: '',
      complete: false,
      missing: ['vatNumber'],
      address: { it: ['Via Esempio 12', 'Palazzo', 'Interno 4', '6900 Lugano', 'Svizzera'], en: ['Via Esempio 12'] },
      invalid: [{ field: 'address.it', reason: 'too_many_lines', limit: 4 }],
    })

  it('shows the warning Banner (not announced) above a form whose values are marked in place', async () => {
    answer(moved(), entityFixture('welld_ch'), ['welld_it'])
    vi.mocked(getVersion).mockResolvedValue({ ...versionOf(moved()), action: 'import', createdBy: null })
    const view = renderPage('/legal-entities')

    const banner = await screen.findByTestId('admin-legal-entity-incomplete')
    expect(banner.getAttribute('role')).toBe('note')
    expect(banner.textContent).toContain('Missing: VAT number.')
    expect(banner.textContent).toContain('To correct before the next save: Address (Italian).')
    expect(screen.getByRole('tab', { name: 'WellD Italia, Incomplete' })).toBeTruthy()

    const italian = screen.getByRole('group', { name: /^Address \(Italian\)/ })
    expect(within(italian).getAllByRole('textbox')).toHaveLength(5)
    expect(within(italian).getByRole('textbox', { name: 'Line 5' }).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('textbox', { name: /^VAT number/ }).getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByTestId('admin-legal-summary')).toBeNull()
    expect(screen.getByTestId('admin-legal-save').getAttribute('aria-disabled')).toBe('true')
    await waitFor(() =>
      expect(screen.getByTestId('admin-legal-entity-version-line').textContent).toContain('moved from the CRM'),
    )
    expect(await axeViolations(view.container)).toEqual([])
  })

  it('names what was refused and where, after a refused save of the moved entity', async () => {
    answer(moved(), entityFixture('welld_ch'), ['welld_it'])
    vi.mocked(saveLegalEntity).mockRejectedValueOnce(
      new LegalEntityApiError(
        { type: 'about:blank', title: 'invalid', status: 422, code: 'invalid_legal_entity' },
        {
          problems: [
            { field: 'vatNumber', reason: 'required' },
            { field: 'address.it', reason: 'too_many_lines', limit: 4 },
          ],
        },
      ),
    )
    const view = renderPage('/legal-entities')
    const user = userEvent.setup()
    await screen.findByTestId('admin-legal-form')
    await user.type(screen.getByRole('textbox', { name: /^Legal name/ }), '!')
    await user.click(screen.getByTestId('admin-legal-save'))

    const summary = await screen.findByTestId('admin-legal-summary')
    expect(
      within(summary)
        .getAllByTestId('admin-legal-summary-item')
        .map((b) => b.textContent),
    ).toEqual([
      'VAT number: Enter the VAT number.',
      'Line 5 of the Italian address: Too many lines: at most 4, you have 5.',
    ])
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /^VAT number/ }))
    expect(await axeViolations(view.container)).toEqual([])
  })
})

describe('a failure to read stays the page’s', () => {
  it('shows no form while the entities are not loaded', async () => {
    vi.mocked(getManageable).mockRejectedValue(new ApiError({ type: 'x', title: 'down', status: 500 }))
    vi.mocked(listLegalEntities).mockResolvedValue([entityFixture('welld_it'), entityFixture('welld_ch')])
    renderPage('/legal-entities')
    await screen.findByText('The legal entities could not be loaded')
    expect(screen.queryByTestId('admin-legal-form')).toBeNull()
  })
})
