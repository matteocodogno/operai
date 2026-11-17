/**
 * @vitest-environment jsdom
 *
 * CRM Settings on the letterhead service path (specs/20261116-letterhead-service T33; design F14, S10; AC-10.11): with
 * `letterheadService` on, the letterhead upload card is gone and nothing replaces it; with it off or absent, Settings is
 * exactly as before. Real router and shell, fake API.
 */
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import CrmShell from '../components/CrmShell'
import { resetManageableLegalEntities } from '../hooks/useCanManageLegalEntity'
import { createAppRouter } from '../router'
import { en, it as italian, strings } from '../strings'
import { fakeApi, problemAnswer } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const PROFILE = (entity: string) => ({
  entity,
  offerTermsEn: null,
  offerTermsIt: null,
  placeOfIssue: 'Lugano',
  letterhead: null,
  updatedAt: '2026-11-01T09:00:00.000Z',
})

/** `manageable` answers a list of entities, or fails (a handler for the failure). */
type Manageable = string[] | FakeHandler

async function open(service: boolean | undefined, manageable: Manageable = []) {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({
        status: 200,
        body: {
          deal: ['welld_it', 'welld_ch'],
          financials: true,
          managesAll: false,
          canErase: false,
          ...(service === undefined ? {} : { letterheadService: service }),
        },
      }),
      'GET /legal-entities/manageable': typeof manageable === 'function' ? manageable : () => ({ status: 200, body: { entities: manageable } }),
      'GET /entity-profiles': () => ({ status: 200, body: { items: [PROFILE('welld_it'), PROFILE('welld_ch')] } }),
      'GET /offer-numbering/welld_it': () => ({ status: 200, body: { nextNumber: 1, example: '0001/2026' } }),
      'GET /offer-numbering/welld_ch': () => ({ status: 200, body: { nextNumber: 1, example: '0001/2026' } }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [] } }),
    }),
  )
  window.history.pushState(null, '', '/settings')
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  await screen.findByTestId('crm-settings-page')
  // both entities' profile forms are in: the page has loaded, the cards below them with it
  await screen.findAllByRole('heading', { name: strings.settings.profile(strings.badges.entity.welld_it) })
}

beforeEach(() => {
  window.scrollTo = () => undefined
  resetManageableLegalEntities()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  apiFetch.mockReset()
})

describe('Settings on the service path (AC-10.11, design F14)', () => {
  it('has no letterhead card for any entity, and still the profile, the numbering and the templates', async () => {
    await open(true)
    for (const entity of ['welld_it', 'welld_ch']) {
      expect(screen.queryByTestId(`crm-letterhead-${entity}`)).toBeNull()
      expect(screen.queryByTestId(`crm-letterhead-${entity}-upload`)).toBeNull()
    }
    expect(screen.queryByText(strings.templates.letterhead.upload)).toBeNull()
    expect(screen.getAllByRole('heading', { name: strings.settings.profile(strings.badges.entity.welld_ch) })).toHaveLength(1)
    // nothing replaces the card: the description no longer says the letterhead is here
    expect(screen.getByText(strings.settings.descriptionService)).toBeTruthy()
    expect(screen.queryByText(strings.settings.description)).toBeNull()
    // and the upload routes are never called
    expect(apiFetch.mock.calls.map(([url]) => new URL(String(url)).pathname).filter((p) => p.includes('letterhead'))).toEqual([])
  })

  it.each([
    ['off', false],
    ['absent (an older crm-api)', undefined],
  ])('%s: Settings is as it was, with the upload card of each entity', async (_name, service) => {
    await open(service)
    expect(screen.getByTestId('crm-letterhead-welld_it')).toBeTruthy()
    expect(screen.getByTestId('crm-letterhead-welld_ch')).toBeTruthy()
    expect(screen.getByText(strings.settings.description)).toBeTruthy()
  })

  it('says its description in both languages with the same keys', () => {
    expect(en.settings.descriptionService).not.toBe('')
    expect(italian.settings.descriptionService).not.toBe(en.settings.descriptionService)
  })
})

const paths = (method = 'GET') =>
  apiFetch.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([url]) => new URL(String(url)).pathname)

/** The page's axe run: rules that need a real browser (colour contrast, landmarks of a fragment) are off, the rest on. */
async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

describe('Settings keep only the CRM’s own values; the registry holds the rest (AC-6.1, D5)', () => {
  it('has no legal name, address, VAT number or IBAN field on any entity card', async () => {
    await open(true)
    for (const entity of ['welld_it', 'welld_ch']) {
      const card = screen.getByTestId(`crm-settings-${entity}`)
      for (const gone of ['legal', 'address', 'vat', 'iban']) expect(screen.queryByTestId(`crm-settings-${entity}-${gone}`)).toBeNull()
      expect(within(card).queryByLabelText(/legal name|address|VAT|IBAN|ragione sociale|indirizzo|partita iva/i)).toBeNull()
      // what stays: the place of issue and the two standard-terms fields, and Save
      expect(screen.getByTestId(`crm-settings-${entity}-place`)).toBeTruthy()
      expect(screen.getByTestId(`crm-settings-${entity}-terms-en`)).toBeTruthy()
      expect(screen.getByTestId(`crm-settings-${entity}-terms-it`)).toBeTruthy()
      expect(screen.getByTestId(`crm-settings-${entity}-save`)).toBeTruthy()
    }
  })

  it('opens each card with the note: the link for the entity the person manages, the sentence for the other', async () => {
    await open(true, ['welld_ch'])
    const ch = await screen.findByTestId('crm-settings-welld_ch-legal-link')
    expect(ch.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
    expect(screen.queryByTestId('crm-settings-welld_it-legal-link')).toBeNull()
    expect(screen.getByTestId('crm-settings-welld_it-legal-note').textContent).toContain(strings.settings.legalNoteAdmin)
    expect(screen.getAllByRole('link', { name: strings.settings.legalNoteLink })).toHaveLength(1)
  })

  it('asks auth for `manageable` once for the whole page, however many cards', async () => {
    await open(true, ['welld_it', 'welld_ch'])
    await screen.findAllByTestId(/crm-settings-welld_(it|ch)-legal-link/)
    expect(paths().filter((p) => p === '/legal-entities/manageable')).toHaveLength(1)
  })

  it('shows the sentence on both cards and no link when `manageable` fails (fail closed)', async () => {
    await open(true, () => problemAnswer(503, 'unavailable'))
    await waitFor(() => expect(paths()).toContain('/legal-entities/manageable'))
    expect(screen.getAllByText(strings.settings.legalNoteAdmin)).toHaveLength(2)
    expect(screen.queryByRole('link', { name: strings.settings.legalNoteLink })).toBeNull()
    // the rest of the page works regardless
    expect(screen.getByTestId('crm-settings-welld_it-save')).toBeTruthy()
  })

  it('no longer says an entity without a profile row is "not set up": it blocks no offer', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: { deal: ['welld_it'], financials: true, managesAll: false, canErase: false } }),
        'GET /entity-profiles': () => ({ status: 200, body: { items: [] } }),
        'GET /offer-numbering/welld_it': () => ({ status: 200, body: { nextNumber: 1, example: '0001/2026' } }),
        'GET /offer-templates': () => ({ status: 200, body: { items: [] } }),
      }),
    )
    window.history.pushState(null, '', '/settings')
    render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
    await screen.findByTestId('crm-settings-welld_it')
    expect('notSet' in en.settings).toBe(false)
    expect('notSet' in italian.settings).toBe(false)
    expect(screen.getByTestId('crm-settings-welld_it-legal-note')).toBeTruthy()
    expect(screen.queryByText(/not set up yet|non ancora configurato/i)).toBeNull()
  })

  it('saves with only the terms and the place of issue', async () => {
    const saves: unknown[] = []
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: { deal: ['welld_ch'], financials: true, managesAll: false, canErase: false } }),
        'GET /legal-entities/manageable': () => ({ status: 200, body: { entities: [] } }),
        'GET /entity-profiles': () => ({ status: 200, body: { items: [PROFILE('welld_ch')] } }),
        'PUT /entity-profiles/welld_ch': (_url, init) => {
          saves.push(JSON.parse(String(init?.body)))
          return { status: 200, body: { ...PROFILE('welld_ch'), placeOfIssue: 'Zurich' } }
        },
        'GET /offer-numbering/welld_ch': () => ({ status: 200, body: { nextNumber: 1, example: '0001/2026' } }),
        'GET /offer-templates': () => ({ status: 200, body: { items: [] } }),
      }),
    )
    window.history.pushState(null, '', '/settings')
    render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
    const place = (await screen.findByTestId('crm-settings-welld_ch-place')).querySelector('input')!
    await userEvent.clear(place)
    await userEvent.type(place, 'Zurich')
    await userEvent.click(screen.getByTestId('crm-settings-welld_ch-save'))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(Object.keys(saves[0] as object).sort()).toEqual(['offerTermsEn', 'offerTermsIt', 'placeOfIssue'])
    expect(saves[0]).toMatchObject({ placeOfIssue: 'Zurich' })
  })

  it('has no axe violation on the Settings page, with the link and with the sentence', async () => {
    await open(true, ['welld_it'])
    await screen.findByTestId('crm-settings-welld_it-legal-link')
    const page = screen.getByTestId('crm-settings-page')
    expect(page.querySelector('[data-testid="crm-settings-welld_ch-legal-link"]')).toBeNull()
    expect(await axeViolations(page)).toEqual([])
  })
})
