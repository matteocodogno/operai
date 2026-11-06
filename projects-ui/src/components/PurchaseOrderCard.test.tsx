/**
 * @vitest-environment jsdom
 *
 * PurchaseOrderCard (specs/022 AC-2.3, AC-2.4, AC-3.1 – AC-3.3, specs/021 AC-3.1): the purchase order of a
 * project made from a deal — the deal as a link to the CRM, the "no longer won" notice, the estimate link
 * into EstimAI, the Bexio order id (editable only with the `bexio` scope) and its terms, which only a
 * holder of manage projects changes. There is no control that detaches, moves or deletes it (D38, D39).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ScopeContext } from '../hooks/useScope'
import { fakeApi, problem, projectDetail, purchaseOrderOf, referentOf, scope, termsOf } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Project, PurchaseOrder, Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import PurchaseOrderCard from './PurchaseOrderCard'

const FIXED = { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 }

const projectWith = (po: Partial<PurchaseOrder> = {}, over: Partial<Project> = {}): Project =>
  projectDetail({
    type: 'fixed_price',
    purchaseOrder: purchaseOrderOf(po),
    terms: termsOf('fixed_price', FIXED),
    startDate: '2026-02-01',
    ...over,
  })

const onChanged = vi.fn()
const onStale = vi.fn()

const renderCard = (
  project: Project,
  callerScope: Scope = scope({ manage: ['welld_ch'] }),
  routes: Record<string, FakeHandler> = {},
) => {
  apiFetch.mockImplementation(fakeApi(routes))
  render(
    <ScopeContext.Provider value={callerScope}>
      <PurchaseOrderCard
        project={project}
        canManage={callerScope.manage.includes('welld_ch')}
        onChanged={onChanged}
        onStale={onStale}
      />
    </ScopeContext.Provider>,
  )
  return screen.getByTestId('project-purchase-order')
}

beforeEach(() => {
  window.scrollTo = () => undefined
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const writes = () =>
  apiFetch.mock.calls
    .filter(([, init]) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((init as RequestInit | undefined)?.method ?? ''))
    .map(([input, init]) => ({
      method: (init as RequestInit).method!,
      path: new URL(String(input)).pathname,
      ifMatch: ((init as RequestInit).headers as Record<string, string>)['If-Match'],
      body: JSON.parse(String((init as RequestInit).body ?? 'null')) as unknown,
    }))

describe('the card (AC-3.3)', () => {
  it('is titled "Purchase order", with its terms below a "Terms" heading', () => {
    const card = renderCard(projectWith())
    expect(within(card).getByRole('heading', { level: 3, name: 'Purchase order' })).not.toBeNull()
    expect(within(card).getByRole('heading', { level: 4, name: 'Terms' })).not.toBeNull()
    expect(card.textContent).toContain('01.12.2026')
    expect(card.textContent).toContain('12.5 man-days')
    expect(card.textContent).toContain('40 man-days')
  })

  it('shows the deal’s title as a link to the CRM, and no "origin": every PO is from a deal', () => {
    const card = renderCard(projectWith({ deal: { id: 'd1', title: 'Website relaunch', won: true } }))
    expect(within(card).getByRole('link', { name: 'Website relaunch' }).getAttribute('href')).toBe('/crm/deals/d1')
    expect(card.textContent).not.toMatch(/origin|entered by hand|from a deal/i)
  })

  it('keeps the link to the deal when the CRM could not name it', () => {
    const card = renderCard(projectWith({ deal: { id: 'd1', title: null, won: null } }))
    expect(within(card).getByRole('link', { name: 'Deal title unavailable' }).getAttribute('href')).toBe(
      '/crm/deals/d1',
    )
  })

  it('renders no amount, price or rate', () => {
    const card = renderCard(projectWith())
    expect(card.textContent).not.toMatch(/\b(price|rate|amount|fee|budget|cost)\b|CHF|EUR|€/i)
  })

  it('shows the terms of its type: positions for time and material', () => {
    const card = renderCard(
      projectWith(
        {},
        {
          type: 't_and_m',
          terms: termsOf('t_and_m', { positions: [{ profile: 'Senior developer', plannedManDays: 20 }] }),
        },
      ),
    )
    expect(card.textContent).toContain('Senior developer')
  })
})

describe('the ops manager (D42, D46)', () => {
  it('names the ops manager the purchase order was assigned to', () => {
    const card = renderCard(projectWith({ opsManager: { id: 'u-ops', name: 'Olga Ops', deleted: false } }))
    expect(within(card).getByText('Ops manager')).not.toBeNull()
    expect(within(card).getByText('Olga Ops')).not.toBeNull()
  })

  it('marks the signed-in user as "You", as everywhere on the page', () => {
    const card = renderCard(projectWith({ opsManager: { id: 'u-ada', name: 'Ada Lovelace', deleted: false } }))
    expect(card.textContent).toContain('Ada Lovelace (You)')
  })
})

describe('the referent (AC-3.8, AC-3.9, AC-3.10; T18 M5, L9)', () => {
  const referentBlock = (card: HTMLElement) => within(card).getByTestId('purchase-order-referent')

  it('shows the referent’s name, job title, email and phone, the email and phone as mailto: and tel: links', () => {
    const card = renderCard(projectWith({ referent: referentOf() }))
    const block = referentBlock(card)
    expect(block.textContent).toContain('Jane Roe')
    expect(block.textContent).toContain('CTO')
    expect(within(block).getByRole('link', { name: 'jane.roe@acme.example' }).getAttribute('href')).toBe(
      'mailto:jane.roe@acme.example',
    )
    expect(within(block).getByRole('link', { name: '+41 44 123 45 67' }).getAttribute('href')).toBe('tel:+41441234567')
    expect(block.textContent).not.toMatch(/unavailable|No referent/i)
  })

  it('leaves a detail the contact lacks blank, with no link for it', () => {
    const card = renderCard(projectWith({ referent: referentOf({ jobTitle: null, email: null, phone: null }) }))
    const block = referentBlock(card)
    expect(block.textContent).toContain('Jane Roe')
    expect(within(block).queryAllByRole('link')).toEqual([])
    expect(block.textContent).not.toMatch(/null|undefined/)
  })

  it('renders a contact’s fields as text, and the scheme of a link is the one this page chooses', () => {
    const card = renderCard(
      projectWith({
        referent: referentOf({ name: '<img src=x onerror=alert(1)>', email: 'javascript:alert(1)', phone: 'tel:evil' }),
      }),
    )
    const block = referentBlock(card)
    expect(block.querySelector('img')).toBeNull()
    expect(block.textContent).toContain('<img src=x onerror=alert(1)>')
    const hrefs = within(block)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
    for (const href of hrefs) expect(href).toMatch(/^(mailto|tel):/)
    expect(hrefs.some((href) => href!.startsWith('javascript:'))).toBe(false)
  })

  it('says "Referent unavailable" and shows none of the contact when the CRM could not answer (AC-3.10)', () => {
    const card = renderCard(
      projectWith({
        referent: referentOf({ status: 'unavailable', name: null, jobTitle: null, email: null, phone: null }),
      }),
    )
    const block = referentBlock(card)
    expect(block.textContent).toContain('Referent unavailable')
    expect(block.textContent).not.toContain('Jane Roe')
    expect(within(block).queryAllByRole('link')).toEqual([])
    // The rest of the card is still there.
    expect(card.textContent).toContain('Website relaunch')
  })

  it('shows no referent when there is none, or when the CRM no longer has the contact (AC-3.9)', () => {
    const card = renderCard(projectWith({ referent: null }))
    const block = referentBlock(card)
    expect(block.textContent).toContain('No referent')
    expect(block.textContent).not.toMatch(/unavailable/i)
    expect(within(block).queryAllByRole('link')).toEqual([])
  })
})

describe('who may set, change or clear the referent (AC-3.7)', () => {
  it.each([
    ['one is set', referentOf(), 'Change referent'],
    ['none is set', null, 'Set referent'],
  ])('a holder of manage for the entity is offered the edit when %s', (_name, referent, label) => {
    const card = renderCard(projectWith({ referent }), scope({ manage: ['welld_ch'] }))
    expect(within(card).getByRole('button', { name: label })).not.toBeNull()
  })

  it.each<[string, Scope]>([
    ['reads only', scope()],
    ['manages only the other entity', scope({ manage: ['welld_it'] })],
    ['may only write the Bexio order id', scope({ bexio: true })],
    ['oversees the purchase orders without managing projects', scope({ oversees: true })],
  ])('a caller who %s gets no control to edit the referent', (_name, callerScope) => {
    const card = renderCard(projectWith({ referent: referentOf() }), callerScope)
    expect(within(card).queryByRole('button', { name: /referent/i })).toBeNull()
    expect(within(card).getByTestId('purchase-order-referent').textContent).toContain('Jane Roe')
  })
})

describe('editing the referent (AC-3.6, AC-3.7; T18 M1, M5)', () => {
  const JANE = { id: 'k1', name: 'Jane Roe', jobTitle: 'CTO' }
  const MAX = { id: 'k2', name: 'Max Mustermann', jobTitle: null }
  const contactsRoute = {
    'GET /projects/p1/purchase-order/contacts': () => ({ status: 200, body: { items: [JANE, MAX] } }),
  }
  const MANAGER = scope({ manage: ['welld_ch'] })

  const openDialog = async (card: HTMLElement, label = 'Change referent') => {
    fireEvent.click(within(card).getByRole('button', { name: label }))
    const dialog = await screen.findByRole('dialog', { name: 'Referent' })
    await waitFor(() => expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(1))
    return dialog
  }
  const picker = (dialog: HTMLElement) => within(dialog).getByLabelText(/^Referent/) as HTMLSelectElement
  const save = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByTestId('purchase-order-referent-dialog-submit'))
  const contactReads = () =>
    apiFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/projects/p1/purchase-order/contacts')

  it('lists the contacts of the project’s own company, read from the project’s route, with the current one chosen', async () => {
    const card = renderCard(projectWith({ referent: referentOf() }), MANAGER, contactsRoute)
    const dialog = await openDialog(card)
    expect(Array.from(picker(dialog).options).map((option) => option.textContent)).toEqual([
      'No referent',
      'Jane Roe — CTO',
      'Max Mustermann',
    ])
    expect(picker(dialog).value).toBe('k1')
    // The client never names a company: the only reads are the project's own contacts.
    const reads = apiFetch.mock.calls.map(([input]) => new URL(String(input)))
    expect(reads.map((url) => url.pathname)).toEqual(['/projects/p1/purchase-order/contacts'])
    expect(reads[0]!.search).toBe('')
  })

  it('changing the referent PATCHes the contact id with the purchase order’s version and tells the page', async () => {
    const card = renderCard(projectWith({ version: 7, referent: referentOf() }), MANAGER, {
      ...contactsRoute,
      'PATCH /projects/p1/purchase-order': () => ({ status: 200, body: purchaseOrderOf({ version: 8 }) }),
    })
    const dialog = await openDialog(card)
    expect((within(dialog).getByTestId('purchase-order-referent-dialog-submit') as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.change(picker(dialog), { target: { value: 'k2' } })
    save(dialog)
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Referent saved.'))
    expect(writes()).toEqual([
      { method: 'PATCH', path: '/projects/p1/purchase-order', ifMatch: '"7"', body: { referentContactId: 'k2' } },
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sets a referent on a purchase order that has none', async () => {
    const card = renderCard(projectWith({ referent: null }), MANAGER, {
      ...contactsRoute,
      'PATCH /projects/p1/purchase-order': () => ({ status: 200, body: purchaseOrderOf({ version: 3 }) }),
    })
    const dialog = await openDialog(card, 'Set referent')
    expect(picker(dialog).value).toBe('')
    fireEvent.change(picker(dialog), { target: { value: 'k1' } })
    save(dialog)
    await waitFor(() => expect(writes().length).toBe(1))
    expect(writes()[0]!.body).toEqual({ referentContactId: 'k1' })
  })

  it('"No referent" clears it: the id goes out as null', async () => {
    const card = renderCard(projectWith({ referent: referentOf() }), MANAGER, {
      ...contactsRoute,
      'PATCH /projects/p1/purchase-order': () => ({ status: 200, body: purchaseOrderOf({ version: 3 }) }),
    })
    const dialog = await openDialog(card)
    fireEvent.change(picker(dialog), { target: { value: '' } })
    save(dialog)
    await waitFor(() => expect(writes().length).toBe(1))
    expect(writes()[0]!.body).toEqual({ referentContactId: null })
    expect(onChanged).toHaveBeenCalledWith('Referent saved.')
  })

  it('reads the contacts again every time the dialog opens, and keeps them nowhere else (T18 M5)', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const card = renderCard(projectWith({ referent: referentOf() }), MANAGER, contactsRoute)
    const first = await openDialog(card)
    fireEvent.click(within(first).getByTestId('purchase-order-referent-dialog-cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    await openDialog(card)
    expect(contactReads().length).toBe(2)
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('a refused contact (422 referent_invalid) is one fixed message on the field, never the server’s text', async () => {
    const card = renderCard(projectWith({ referent: null }), MANAGER, {
      ...contactsRoute,
      'PATCH /projects/p1/purchase-order': () =>
        problem(422, 'referent_invalid', { field: 'referentContactId' }, 'contact k2 belongs to Other Corp'),
    })
    const dialog = await openDialog(card, 'Set referent')
    fireEvent.change(picker(dialog), { target: { value: 'k2' } })
    save(dialog)
    expect(await within(dialog).findByText(/cannot be the referent of this purchase order/)).not.toBeNull()
    expect(dialog.textContent).not.toContain('Other Corp')
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('a stale save (409 version_conflict) closes the dialog and is the page’s reload prompt', async () => {
    const card = renderCard(projectWith({ referent: null }), MANAGER, {
      ...contactsRoute,
      'PATCH /projects/p1/purchase-order': () => problem(409, 'version_conflict', { currentVersion: 9 }),
    })
    const dialog = await openDialog(card, 'Set referent')
    fireEvent.change(picker(dialog), { target: { value: 'k1' } })
    save(dialog)
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says when the CRM cannot be reached for the save (503 crm_unavailable), values kept', async () => {
    const card = renderCard(projectWith({ referent: null }), MANAGER, {
      ...contactsRoute,
      'PATCH /projects/p1/purchase-order': () => problem(503, 'crm_unavailable'),
    })
    const dialog = await openDialog(card, 'Set referent')
    fireEvent.change(picker(dialog), { target: { value: 'k1' } })
    save(dialog)
    expect((await within(dialog).findByTestId('purchase-order-referent-dialog-error')).textContent).toContain(
      'The CRM cannot be reached',
    )
    expect(picker(dialog).value).toBe('k1')
  })

  it.each([
    ['crm_unavailable', 503, 'The contacts could not be loaded. The CRM cannot be reached right now.'],
    ['out_of_scope', 403, 'The contacts could not be loaded. You may not change the purchase orders of this entity.'],
    ['purchase_order_not_found', 404, 'The contacts could not be loaded. This project has no purchase order.'],
  ])(
    'a contact list that cannot be read (%s) is said in the purchase order’s words, with Retry',
    async (code, status, text) => {
      const card = renderCard(projectWith({ referent: null }), MANAGER, {
        'GET /projects/p1/purchase-order/contacts': () => problem(status, code),
      })
      fireEvent.click(within(card).getByRole('button', { name: 'Set referent' }))
      const dialog = await screen.findByRole('dialog', { name: 'Referent' })
      const banner = await within(dialog).findByTestId('purchase-order-referent-picker-error')
      expect(banner.textContent).toContain(text)
      // Nothing about taking a deal leaks into the purchase order's wording.
      expect(banner.textContent).not.toMatch(/deal/i)
      expect(within(banner).getByRole('button', { name: 'Retry' })).not.toBeNull()
    },
  )
})

describe('the estimate (AC-3.2)', () => {
  it('shows the estimate as a link that opens it in EstimAI', () => {
    const card = renderCard(projectWith({ estimate: { id: 'est-1' } }))
    expect(within(card).getByRole('link', { name: 'Open the estimate' }).getAttribute('href')).toBe(
      '/estimai/estimates/est-1',
    )
  })

  it('has no estimate link when the deal had no estimate', () => {
    const card = renderCard(projectWith({ estimate: null }))
    expect(within(card).queryByRole('link', { name: 'Open the estimate' })).toBeNull()
  })
})

describe('the "no longer won" notice (AC-2.3, AC-2.4)', () => {
  it('says "the deal is no longer won" when the deal was reopened, and changes nothing else', () => {
    const card = renderCard(projectWith({ deal: { id: 'd1', title: 'Website relaunch', won: false } }))
    expect(within(card).getByTestId('purchase-order-deal-not-won').textContent).toContain('The deal is no longer won')
    expect(within(card).getByRole('button', { name: 'Edit' })).not.toBeNull()
    expect(card.textContent).toContain('12.5 man-days')
  })

  it.each([
    ['won again (AC-2.4)', true],
    ['not known because the CRM could not answer', null],
  ])('has no notice when the deal is %s', (_name, won) => {
    const card = renderCard(projectWith({ deal: { id: 'd1', title: won === null ? null : 'Website relaunch', won } }))
    expect(within(card).queryByTestId('purchase-order-deal-not-won')).toBeNull()
    expect(card.textContent).not.toContain('no longer won')
  })
})

describe('who may change its terms (AC-4.4)', () => {
  it('a manager can edit and set an end date, and has no way to detach, move or delete the PO (D38, D39)', () => {
    const card = renderCard(projectWith(), scope({ manage: ['welld_ch'], bexio: true }))
    const controls = [...within(card).queryAllByRole('button'), ...within(card).queryAllByRole('link')]
      .map((control) => control.textContent)
      .join(' | ')
    expect(controls).toContain('Edit')
    expect(controls).toContain('Set end date')
    expect(controls).not.toMatch(/detach|unlink|move|reassign|delet|remove|attach|scollega|sposta|elimin/i)
    expect(card.querySelector('[data-testid*="delete"]')).toBeNull()
  })

  it('a reader gets neither Edit nor a date control', () => {
    const card = renderCard(projectWith(), scope())
    expect(within(card).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Set end date' })).toBeNull()
  })

  it('editing the terms PATCHes them with the terms version (not the purchase order’s) and tells the page', async () => {
    const card = renderCard(
      projectWith({ version: 9 }, { terms: termsOf('fixed_price', FIXED, { version: 4 }) }),
      scope({ manage: ['welld_ch'] }),
      { 'PATCH /projects/p1/terms': () => ({ status: 200, body: termsOf('fixed_price', FIXED, { version: 5 }) }) },
    )
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit terms' })
    fireEvent.change(within(dialog).getByLabelText(/^Max effort/), { target: { value: '55' } })
    fireEvent.click(within(dialog).getByTestId('terms-form-submit'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Terms saved.'))
    expect(writes().map((write) => [write.method, write.path, write.ifMatch])).toEqual([
      ['PATCH', '/projects/p1/terms', '"4"'],
    ])
  })

  it('the man-days of an estimate-backed PO are read-only in the terms edit and not sent (AC-3.1)', async () => {
    const card = renderCard(projectWith({ estimate: { id: 'est-1' } }), scope({ manage: ['welld_ch'] }), {
      'PATCH /projects/p1/terms': () => ({ status: 200, body: termsOf('fixed_price', FIXED, { version: 5 }) }),
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit terms' })
    expect((within(dialog).getByLabelText(/^Estimated man-days/) as HTMLInputElement).readOnly).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/^Max effort/), { target: { value: '55' } })
    fireEvent.click(within(dialog).getByTestId('terms-form-submit'))
    await waitFor(() => expect(writes().length).toBe(1))
    expect(writes()[0]!.body).not.toHaveProperty('estimatedManDays')
  })
})

describe('the Bexio order id (AC-3.1)', () => {
  it('a project manager reads it and has no field; accounting gets the field', () => {
    const project = projectWith({ bexioOrderId: 'AB-100' })
    const card = renderCard(project, scope({ manage: ['welld_ch'] }))
    expect(within(card).queryByLabelText('Bexio order')).toBeNull()
    expect(card.textContent).toContain('AB-100')
    cleanup()
    const accounting = renderCard(project, scope({ bexio: true }))
    expect((within(accounting).getByLabelText('Bexio order') as HTMLInputElement).value).toBe('AB-100')
  })

  it('saving it PUTs it with the purchase order version and tells the page', async () => {
    const card = renderCard(projectWith({ version: 7 }), scope({ manage: ['welld_ch'], bexio: true }), {
      'PUT /projects/p1/purchase-order/bexio-order': () => ({
        status: 200,
        body: purchaseOrderOf({ bexioOrderId: 'AB-200', version: 8 }),
      }),
    })
    fireEvent.change(within(card).getByLabelText('Bexio order'), { target: { value: 'AB-200' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Bexio order saved.'))
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/projects/p1/purchase-order/bexio-order',
        ifMatch: '"7"',
        body: { bexioOrderId: 'AB-200' },
      },
    ])
  })

  it('a stale Bexio save (the purchase order changed meanwhile) is the page’s to handle', async () => {
    const card = renderCard(projectWith(), scope({ bexio: true }), {
      'PUT /projects/p1/purchase-order/bexio-order': () => problem(409, 'version_conflict', { currentVersion: 9 }),
    })
    fireEvent.change(within(card).getByLabelText('Bexio order'), { target: { value: 'AB-200' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
  })
})
