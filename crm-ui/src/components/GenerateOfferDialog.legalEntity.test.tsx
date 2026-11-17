/**
 * @vitest-environment jsdom
 *
 * The classic Generate dialog and the offers card with an incomplete legal entity (specs/20261117-legal-entities T63;
 * FU-2; AC-6.3, AC-8.1, AC-8.2): a 409 `legal_entity_incomplete` shows the registry's notice — with the link to the
 * entity's tab for a person who may manage it, the sentence for everyone else — instead of only the refusal's line.
 * Through the real router, the deal page and the real request code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import axe from 'axe-core'
import CrmShell from './CrmShell'
import { resetManageableLegalEntities } from '../hooks/useCanManageLegalEntity'
import { createAppRouter } from '../router'
import { en, it as italian, strings } from '../strings'
import { ADA, fakeApi, page, problemAnswer, type FakeAnswer, type FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getActivitiesApiBaseUrl: () => 'http://activities-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))
vi.mock('shell/extensions', () => ({ HostExtension: () => null }))

const t = strings.offerWizard

const DEAL = {
  id: 'd1',
  title: 'Platform rebuild',
  company: { id: 'c1', name: 'Acme SA' },
  stage: 'proposal',
  amountCents: 10_000_000,
  currency: 'CHF',
  entity: 'welld_ch',
  expectedCloseDate: null,
  owner: ADA,
  closedAt: null,
  updatedAt: '2026-10-30T10:00:00.000Z',
  lostReason: null,
  notes: null,
  version: 4,
  createdAt: '2026-10-01T10:00:00.000Z',
  estimateState: 'ready',
  estimateOverridden: false,
  estimate: {
    estimateId: 'est-1',
    state: 'ready',
    name: 'E',
    technical: ADA,
    requestedBy: ADA,
    requestedAt: '2026-10-30T10:00:00.000Z',
    readyAt: '2026-10-31T10:00:00.000Z',
  },
  estimateOverride: null,
}

const TEMPLATE = { id: 't-en', entity: 'welld_ch', name: 'Standard EN', language: 'en', archived: false, version: 1 }
const DRAFT = {
  templateId: 't-en',
  templateName: 'Standard EN',
  language: 'en',
  currency: 'CHF',
  salutation: 'Dear Sir or Madam,',
  clientLines: ['Acme SA', 'Via Nassa 1'],
  opening: 'Following our meeting on {deal}.',
  sections: [
    { heading: 'Object', body: 'Rebuild.', costs: false },
    { heading: 'Costs', body: '', costs: true },
  ],
  costColumns: { position: true, unit: true },
  showTotal: true,
  costLines: [{ description: 'Development', kind: 'one_off', unitCents: 1_000_000, percentBp: null, quantity: 10 }],
  acceptanceLabel: null,
  annex: true,
  validityDays: 30,
  aiAssisted: false,
  manDays: 12.5,
}
const OFFER = {
  id: 'o2',
  number: 2,
  reference: 'OF-2026-ABC123-2',
  language: 'en',
  priceCents: 9_000_000,
  currency: 'CHF',
  validityDays: 30,
  validUntil: '2026-12-01',
  aiAssisted: false,
  manDaysTenths: 125,
  sizeBytes: 1000,
  createdBy: ADA,
  createdAt: '2026-11-01T09:00:00.000Z',
  deleted: false,
  templateName: 'Standard EN',
  sent: null,
  version: 3,
  origin: 'classic',
}

const incomplete = (extras: Record<string, unknown> = { entity: 'welld_ch', missing: ['vatNumber', 'address.en'] }) =>
  problemAnswer(409, 'legal_entity_incomplete', extras)

async function mount(manages: string[], routes: Record<string, FakeHandler> = {}, offers: unknown[] = []) {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({
        status: 200,
        body: { deal: ['welld_ch'], financials: true, managesAll: false, canErase: false },
      }),
      'GET /deals/d1': () => ({ status: 200, body: DEAL }),
      'GET /pipeline': () => ({ status: 200, body: { probabilities: {}, year: 2026, stages: [] } }),
      'GET /activities': () => ({ status: 200, body: page([]) }),
      'GET /deals/d1/offers': () => ({ status: 200, body: { items: offers } }),
      'GET /deals/d1/offer-draft/summary': () => ({ status: 200, body: { draft: null } }),
      'GET /deals/d1/attachments': () => ({ status: 200, body: { items: [] } }),
      'GET /offer-templates': () => ({ status: 200, body: { items: [TEMPLATE] } }),
      'GET /contacts': () => ({ status: 200, body: page([]) }),
      'GET /deals/d1/offers/draft': () => ({ status: 200, body: DRAFT }),
      'GET /legal-entities/manageable': () => ({ status: 200, body: { entities: manages } }),
      ...routes,
    }),
  )
  window.history.pushState(null, '', '/deals/d1')
  render(<RouterProvider router={createAppRouter(undefined, CrmShell)} />)
  await screen.findByTestId('crm-offers-card')
}

/** Opens the classic Generate dialog, picks the template and presses Generate. */
async function generate(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('crm-offer-generate'))
  const dialog = await screen.findByRole('dialog', { name: 'Generate an offer' })
  await within(dialog).findByRole('option', { name: 'Standard EN (English)' })
  fireEvent.change(within(dialog).getByLabelText('Template'), { target: { value: 't-en' } })
  await within(dialog).findByTestId('crm-offer-form')
  fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
  return dialog
}

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

beforeEach(() => {
  resetManageableLegalEntities()
  window.scrollTo = () => undefined
})
afterEach(() => {
  cleanup()
  apiFetch.mockReset()
})

describe('the classic Generate dialog — a 409 legal_entity_incomplete (FU-2, AC-6.3)', () => {
  it('shows the notice with the link to the entity’s tab for a manager, in place of the one-line error', async () => {
    await mount(['welld_ch'], { 'POST /deals/d1/offers': () => incomplete() })
    const dialog = await generate()
    const notice = await within(dialog).findByTestId('crm-wizard-legal-entity-incomplete')
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toContain(t.legalEntity.incomplete.title('wellD CH'))
    expect(notice.textContent).toContain(t.legalEntity.incomplete.noOffer)
    expect(notice.textContent).toContain(t.legalEntity.incomplete.missing('VAT number, Address (English)'))
    const link = await within(notice).findByRole('link', { name: t.legalEntity.openNamed('wellD CH') })
    expect(link.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
    // said once: the dialog's own error line is not also showing it
    expect(within(dialog).queryByTestId('crm-offer-dialog-error')).toBeNull()
    // nothing was created: the dialog and what was typed stay
    expect(within(dialog).getByTestId('crm-offer-form')).not.toBeNull()
  })

  it('tells everyone else to ask an administrator, with no link', async () => {
    await mount(['welld_it'], { 'POST /deals/d1/offers': () => incomplete() })
    const dialog = await generate()
    const notice = await within(dialog).findByTestId('crm-wizard-legal-entity-incomplete')
    expect(notice.textContent).toContain(t.legalEntity.incomplete.askAdmin)
    expect(within(notice).queryByRole('link')).toBeNull()
  })

  it('names the deal’s own entity for a body that names none we know', async () => {
    await mount(['welld_ch'], { 'POST /deals/d1/offers': () => incomplete({ missing: ['legalName'] }) })
    const dialog = await generate()
    const notice = await within(dialog).findByTestId('crm-wizard-legal-entity-incomplete')
    expect(notice.textContent).toContain(t.legalEntity.incomplete.title('wellD CH'))
    expect(notice.textContent).toContain(t.legalEntity.incomplete.missing('Legal name'))
  })

  it('goes away with the next submit, which may now succeed, and gives way to another failure’s line', async () => {
    let asked = 0
    await mount(['welld_ch'], {
      'POST /deals/d1/offers': (): FakeAnswer => {
        asked += 1
        return asked === 1 ? incomplete() : problemAnswer(422, 'attachment_unreadable', { fileName: 'scope.pdf' })
      },
    })
    const dialog = await generate()
    await within(dialog).findByTestId('crm-wizard-legal-entity-incomplete')
    fireEvent.click(within(dialog).getByTestId('crm-offer-dialog-submit'))
    await waitFor(() => expect(within(dialog).queryByTestId('crm-wizard-legal-entity-incomplete')).toBeNull())
    expect((await within(dialog).findByTestId('crm-offer-dialog-error')).textContent).toContain('scope.pdf')
  })

  it('keeps the one-line error for every other refusal', async () => {
    await mount(['welld_ch'], { 'POST /deals/d1/offers': () => problemAnswer(409, 'estimate_not_ready') })
    const dialog = await generate()
    expect((await within(dialog).findByTestId('crm-offer-dialog-error')).textContent).toBe(
      strings.offers.errors.estimateNotReady,
    )
    expect(within(dialog).queryByTestId('crm-wizard-legal-entity-incomplete')).toBeNull()
  })

  it('has no axe violation with the link and with the sentence', async () => {
    for (const manages of [['welld_ch'], []]) {
      resetManageableLegalEntities()
      await mount(manages, { 'POST /deals/d1/offers': () => incomplete() })
      const dialog = await generate()
      const notice = await within(dialog).findByTestId('crm-wizard-legal-entity-incomplete')
      if (manages.length > 0) await within(notice).findByRole('link')
      expect(await axeViolations(dialog)).toEqual([])
      cleanup()
      apiFetch.mockReset()
    }
  })
})

describe('the offers card — a 409 legal_entity_incomplete (FU-2, AC-8.2)', () => {
  const download = async () => {
    fireEvent.click(await screen.findByRole('button', { name: `Download ${OFFER.reference}` }))
  }

  it('shows the notice with the link for a manager, and it can be dismissed', async () => {
    await mount(['welld_ch'], { 'GET /deals/d1/offers/o2/download': () => incomplete() }, [OFFER])
    await download()
    const notice = await screen.findByTestId('crm-wizard-legal-entity-incomplete')
    expect(notice.textContent).toContain(t.legalEntity.incomplete.title('wellD CH'))
    const link = await within(notice).findByRole('link', { name: t.legalEntity.openNamed('wellD CH') })
    expect(link.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
    expect(screen.queryByTestId('crm-offers-notice')).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: strings.common.dismiss }))
    expect(screen.queryByTestId('crm-wizard-legal-entity-incomplete')).toBeNull()
  })

  it('tells everyone else to ask an administrator, with no link, and has no axe violation', async () => {
    await mount([], { 'GET /deals/d1/offers/o2/download': () => incomplete() }, [OFFER])
    await download()
    const notice = await screen.findByTestId('crm-wizard-legal-entity-incomplete')
    expect(notice.textContent).toContain(t.legalEntity.incomplete.askAdmin)
    expect(within(notice).queryByRole('link')).toBeNull()
    expect(await axeViolations(screen.getByTestId('crm-offers-card'))).toEqual([])
  })

  it('keeps the plain banner for any other failure', async () => {
    await mount(['welld_ch'], { 'GET /deals/d1/offers/o2/download': () => problemAnswer(409, 'storage_unconfigured') }, [OFFER])
    await download()
    expect((await screen.findByTestId('crm-offers-notice')).textContent).toContain(
      strings.offers.errors.storageUnconfigured,
    )
    expect(screen.queryByTestId('crm-wizard-legal-entity-incomplete')).toBeNull()
  })
})

describe('the words of the refusal, in English and in Italian', () => {
  it('has the notice in both catalogs, with the link’s name starting with its visible words', () => {
    for (const catalog of [en, italian]) {
      const e = catalog.offerWizard.legalEntity
      expect(e.openNamed('X').startsWith(e.open)).toBe(true)
      expect(e.incomplete.askAdmin).not.toBe('')
    }
    expect(italian.offerWizard.legalEntity.open).not.toBe(en.offerWizard.legalEntity.open)
  })
})
