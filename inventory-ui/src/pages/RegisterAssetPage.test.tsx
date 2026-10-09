/**
 * @vitest-environment jsdom
 *
 * Page tests for RegisterAssetPage (T30, specs/015-hardware-inventory;
 * design.md § T3, F1, § Error and conflict catalogue; refs AC-1.1 to AC-1.7).
 *
 * A real TanStack Router on a memory history so "success navigates to ..." is
 * asserted on the router's own location; `registerAssets`, `getScope` and
 * `usePermissions` are mocked at their seams, so the request body is asserted
 * exactly as plan.md defines it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { Permission } from 'shell/session'
import { ApiError } from '../lib/api'
import type { AssetView, Entity } from '../lib/types'

const { usePermissions, registerAssets, getScope } = vi.hoisted(() => ({
  usePermissions: vi.fn(),
  registerAssets: vi.fn(),
  getScope: vi.fn(),
}))
vi.mock('shell/session', () => ({ usePermissions }))
vi.mock('../lib/assetsApi', () => ({ registerAssets }))
vi.mock('../lib/scopeApi', () => ({ getScope }))

import RegisterAssetPage from './RegisterAssetPage'

const ASSETS: Permission = { resource: 'asset', action: 'manage' }
const LEDGER: Permission = { resource: 'ledger', action: 'manage' }

const created = (id: string): AssetView =>
  ({ id, entity: 'welld_ch', currency: 'CHF', status: 'in_stock' }) as unknown as AssetView

const asUser = (permissions: Permission[], scope: { asset: Entity[]; ledger: Entity[] }) => {
  usePermissions.mockReturnValue({ epoch: 0, apps: ['inventory'], roles: [], departments: [], permissions })
  getScope.mockResolvedValue(scope)
}

beforeEach(() => {
  asUser([ASSETS], { asset: ['welld_ch'], ledger: [] })
  registerAssets.mockResolvedValue({ assets: [created('new1')] })
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderPage = async () => {
  const history = createMemoryHistory({ initialEntries: ['/assets/new'] })
  const rootRoute = createRootRoute()
  const route = (path: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component })
  const routeTree = rootRoute.addChildren([
    route('/assets/new', RegisterAssetPage),
    route('/assets', () => <p>list page</p>),
    route('/assets/$id', () => <p>detail page</p>),
  ])
  const router = createRouter({ routeTree, history })
  render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { level: 2, name: 'Register asset' })
  return router
}

/** A field by the start of its accessible name (labels end with "(required)"). */
const field = (name: string) => screen.getByLabelText(new RegExp(`^${name}`)) as HTMLInputElement

const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } })

/** Fills the five required fields with valid values (single entity: preselected). */
const fillRequired = async () => {
  await screen.findByLabelText(/^Description/)
  fireEvent.change(field('Category'), { target: { value: 'laptop' } })
  type('Description', 'MacBook Pro 14')
  type('Purchase date', '2026-09-25')
  type('Total price', '998.15')
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /^Register/ }))

const lastBody = () => registerAssets.mock.calls.at(-1)![0] as Record<string, unknown>

describe('access and scope', () => {
  it('renders PermissionDenied and no form without asset:manage', async () => {
    asUser([LEDGER], { asset: [], ledger: ['welld_ch'] })
    const history = createMemoryHistory({ initialEntries: ['/assets/new'] })
    const rootRoute = createRootRoute()
    const routeTree = rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/assets/new', component: RegisterAssetPage }),
    ])
    render(<RouterProvider router={createRouter({ routeTree, history })} />)

    expect(await screen.findByTestId('permission-denied')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /^Register/ })).toBeNull()
    expect(getScope).not.toHaveBeenCalled()
  })

  it('limits the entity select to the asset scope, not the ledger scope', async () => {
    asUser([ASSETS], { asset: ['welld_it', 'welld_ch'], ledger: ['welld_ch'] })
    await renderPage()

    const select = (await screen.findByLabelText(/^Entity/)) as HTMLSelectElement
    const options = Array.from(select.options).map((option) => option.textContent)
    expect(options).toEqual(['Select an entity', 'WellD Italia', 'WellD CH'])
  })

  it('shows a fixed read-only entity (no select) when the grant covers one entity', async () => {
    asUser([ASSETS], { asset: ['welld_it'], ledger: [] })
    await renderPage()
    await screen.findByLabelText(/^Description/)

    expect(screen.queryByRole('combobox', { name: /^Entity/ })).toBeNull()
    expect(screen.getByTestId('register-entity-fixed').textContent).toContain('WellD Italia')
    expect(screen.getByLabelText(/^Total price, EUR/)).not.toBeNull()
  })

  it('says so when the asset scope is empty, and offers no form', async () => {
    asUser([ASSETS], { asset: [], ledger: ['welld_ch'] })
    await renderPage()

    expect(await screen.findByText(/No entity is in your scope for registering assets/)).not.toBeNull()
    expect(screen.queryByLabelText(/^Description/)).toBeNull()
  })
})

describe('currency and the per-unit breakdown (AC-1.2, AC-1.3)', () => {
  it('shows the currency of the chosen entity in the price label and never as an input', async () => {
    asUser([ASSETS], { asset: ['welld_ch', 'welld_it'], ledger: [] })
    await renderPage()
    await screen.findByLabelText(/^Entity/)

    expect(screen.getByLabelText(/^Total price/)).not.toBeNull()
    fireEvent.change(field('Entity'), { target: { value: 'welld_ch' } })
    expect(screen.getByLabelText(/^Total price, CHF/)).not.toBeNull()
    fireEvent.change(field('Entity'), { target: { value: 'welld_it' } })
    expect(screen.getByLabelText(/^Total price, EUR/)).not.toBeNull()
    expect(screen.queryByLabelText(/^Currency/)).toBeNull()
  })

  it('shows the live breakdown from splitPrice for N > 1, remainder on the last unit', async () => {
    await renderPage()
    await fillRequired()

    expect(screen.queryByTestId('register-breakdown')?.textContent ?? '').toBe('')
    type('Total price', '2946.35')
    type('Quantity', '13')

    const line = screen.getByTestId('register-breakdown')
    expect(line.getAttribute('aria-live')).toBe('polite')
    expect(line.textContent).toBe('13 assets, 226,64 CHF each, last one 226,67 CHF')
  })

  it('omits "last one" when the total divides evenly', async () => {
    await renderPage()
    await fillRequired()
    type('Total price', '1000')
    type('Quantity', '4')

    expect(screen.getByTestId('register-breakdown').textContent).toBe('4 assets, 250,00 CHF each')
  })
})

describe('validation (AC-1.6)', () => {
  it('lists every missing required field in a summary, links to the fields, sends nothing and focuses the summary', async () => {
    await renderPage()
    await screen.findByLabelText(/^Description/)

    submit()

    const summary = await screen.findByTestId('register-summary')
    expect(summary.getAttribute('role')).toBe('alert')
    for (const label of ['Category', 'Description', 'Purchase date', 'Total price']) {
      expect(within(summary).getByText(new RegExp(`^${label}`))).not.toBeNull()
    }
    expect(registerAssets).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(summary)

    fireEvent.click(within(summary).getByRole('link', { name: /^Description/ }))
    expect(document.activeElement).toBe(field('Description'))
  })

  it('marks each invalid field aria-invalid and describes it by its inline error', async () => {
    await renderPage()
    await screen.findByLabelText(/^Description/)
    submit()

    const description = field('Description')
    await waitFor(() => expect(description.getAttribute('aria-invalid')).toBe('true'))
    const describedBy = description.getAttribute('aria-describedby')!
    expect(document.getElementById(describedBy)?.textContent).toBe('This field is required.')
  })

  it('marks required fields in text, not only by an asterisk', async () => {
    await renderPage()

    expect(screen.getByLabelText(/^Description \(required\)/)).not.toBeNull()
    expect(screen.getByLabelText(/^Supplier \(optional\)/)).not.toBeNull()
  })

  it.each([['0'], ['0.00'], ['-5'], ['abc'], ['12.345'], ['']])('rejects a price of "%s"', async (price) => {
    await renderPage()
    await fillRequired()
    type('Total price', price)
    submit()

    const summary = await screen.findByTestId('register-summary')
    expect(within(summary).getByText(/^Total price/)).not.toBeNull()
    expect(registerAssets).not.toHaveBeenCalled()
  })

  it.each([['0'], ['201'], ['2.5'], ['']])('rejects a quantity of "%s"', async (quantity) => {
    await renderPage()
    await fillRequired()
    type('Quantity', quantity)
    submit()

    const summary = await screen.findByTestId('register-summary')
    expect(within(summary).getByText(/^Quantity/)).not.toBeNull()
    expect(registerAssets).not.toHaveBeenCalled()
  })

  it('accepts a comma decimal and sends integer cents', async () => {
    await renderPage()
    await fillRequired()
    type('Total price', '998,15')
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody().totalPriceCents).toBe(99815)
  })

  it('clears the summary once the form is corrected and submitted', async () => {
    await renderPage()
    await screen.findByLabelText(/^Description/)
    submit()
    await screen.findByTestId('register-summary')

    await fillRequired()
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('register-summary')).toBeNull()
  })
})

describe('the request (AC-1.1, AC-1.4)', () => {
  it('sends the required fields only, with the default quantity and no serials, as received', async () => {
    await renderPage()
    await fillRequired()
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody()).toEqual({
      entity: 'welld_ch',
      category: 'laptop',
      description: 'MacBook Pro 14',
      purchaseDate: '2026-09-25',
      totalPriceCents: 99815,
      quantity: 1,
    })
  })

  it('"Not yet received" sends received:false', async () => {
    await renderPage()
    await fillRequired()
    fireEvent.click(field('Not yet received'))
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody().received).toBe(false)
  })

  it('sends the optional fields trimmed, and leaves blank ones out', async () => {
    await renderPage()
    await fillRequired()
    type('Supplier', '  Apple  ')
    type('Invoice reference', 'INV-77')
    type('Location', '   ')
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody()).toMatchObject({ supplier: 'Apple', invoiceRef: 'INV-77' })
    expect(lastBody()).not.toHaveProperty('locationNote')
  })

  it('trims the description', async () => {
    await renderPage()
    await fillRequired()
    type('Description', '  Dell U2723QE ')
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody().description).toBe('Dell U2723QE')
  })

  it('needs the chosen entity when the grant covers two', async () => {
    asUser([ASSETS], { asset: ['welld_ch', 'welld_it'], ledger: [] })
    await renderPage()
    await fillRequired()
    submit()

    expect((await screen.findAllByText('Select an entity.')).length).toBeGreaterThan(0)
    expect(registerAssets).not.toHaveBeenCalled()

    fireEvent.change(field('Entity'), { target: { value: 'welld_it' } })
    submit()
    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody().entity).toBe('welld_it')
  })
})

describe('serial numbers (AC-1.4, design Resolutions G7)', () => {
  it('N = 1 with a serial sends one; with none sends no serialNumbers key', async () => {
    await renderPage()
    await fillRequired()
    type('Serial number', ' SN123 ')
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody().serialNumbers).toEqual(['SN123'])
  })

  it('N > 1 shows a textarea and sends one serial per unit, in order', async () => {
    await renderPage()
    await fillRequired()
    type('Quantity', '3')

    const textarea = field('Serial numbers')
    expect(textarea.tagName).toBe('TEXTAREA')
    type('Serial numbers', 'A1\nB2\nC3')
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody()).toMatchObject({ quantity: 3, serialNumbers: ['A1', 'B2', 'C3'] })
  })

  it('N > 1 with no serials omits them entirely', async () => {
    await renderPage()
    await fillRequired()
    type('Quantity', '3')
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody()).not.toHaveProperty('serialNumbers')
  })

  it('N > 1 with the wrong number of serials is rejected before sending, naming the count', async () => {
    await renderPage()
    await fillRequired()
    type('Quantity', '3')
    type('Serial numbers', 'A1\nB2')
    submit()

    const summary = await screen.findByTestId('register-summary')
    expect(within(summary).getByText(/each of the 3 assets/)).not.toBeNull()
    expect(registerAssets).not.toHaveBeenCalled()
  })

  it('ignores blank lines when counting serials', async () => {
    await renderPage()
    await fillRequired()
    type('Quantity', '2')
    type('Serial numbers', 'A1\n\n  \nB2\n')
    submit()

    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(1))
    expect(lastBody().serialNumbers).toEqual(['A1', 'B2'])
  })

  it('rejects the same serial twice in one registration', async () => {
    await renderPage()
    await fillRequired()
    type('Quantity', '2')
    type('Serial numbers', 'A1\nA1')
    submit()

    const summary = await screen.findByTestId('register-summary')
    expect(within(summary).getByText(/once only/)).not.toBeNull()
    expect(registerAssets).not.toHaveBeenCalled()
  })

  it('serial_conflict names the serial and links to the conflicting asset (AC-1.5)', async () => {
    registerAssets.mockRejectedValueOnce(
      new ApiError({
        status: 409,
        title: 'Conflict',
        code: 'serial_conflict',
        extras: { serialNumber: 'SN123', assetId: 'a9' },
      }),
    )
    await renderPage()
    await fillRequired()
    type('Serial number', 'SN123')
    submit()

    const error = await screen.findByTestId('register-error-serials')
    expect(error.textContent).toContain('Serial number SN123 is already used by an active asset of this entity.')
    expect(within(error).getByRole('link', { name: 'View the asset that uses it' }).getAttribute('href')).toBe(
      '/assets/a9',
    )
    expect(field('Serial number').getAttribute('aria-invalid')).toBe('true')
    expect(field('Description').value).toBe('MacBook Pro 14')
  })

  it('serial_conflict without an asset id shows the message and no link', async () => {
    registerAssets.mockRejectedValueOnce(
      new ApiError({ status: 409, title: 'Conflict', code: 'serial_conflict', extras: { serialNumber: 'SN123' } }),
    )
    await renderPage()
    await fillRequired()
    type('Serial number', 'SN123')
    submit()

    const error = await screen.findByTestId('register-error-serials')
    expect(within(error).queryByRole('link')).toBeNull()
  })

  it('serial_count_mismatch from the server lands on the serial field', async () => {
    registerAssets.mockRejectedValueOnce(
      new ApiError({ status: 422, title: 'Unprocessable', code: 'serial_count_mismatch' }),
    )
    await renderPage()
    await fillRequired()
    submit()

    expect((await screen.findByTestId('register-error-serials')).textContent).toContain('one serial number per unit')
  })
})

describe('server errors', () => {
  it('fiscal_year_closed names the year and the entity on the purchase date (AC-1.7)', async () => {
    registerAssets.mockRejectedValueOnce(
      new ApiError({ status: 409, title: 'Conflict', code: 'fiscal_year_closed', extras: { year: 2024 } }),
    )
    await renderPage()
    await fillRequired()
    submit()

    const error = await screen.findByTestId('register-error-purchaseDate')
    expect(error.textContent).toBe('2024 is closed for WellD CH. Choose a date in an open year.')
    expect(field('Purchase date').getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(screen.getByTestId('register-summary'))
  })

  it('fiscal_year_closed without a year does not print a placeholder', async () => {
    registerAssets.mockRejectedValueOnce(new ApiError({ status: 409, title: 'Conflict', code: 'fiscal_year_closed' }))
    await renderPage()
    await fillRequired()
    submit()

    const error = await screen.findByTestId('register-error-purchaseDate')
    expect(error.textContent).not.toContain('{')
    expect(error.textContent).toContain('closed year')
  })

  it('a 422 naming a field shows its message under that field', async () => {
    registerAssets.mockRejectedValueOnce(
      new ApiError({
        status: 422,
        title: 'Unprocessable',
        detail: 'description is too long',
        extras: { field: 'description' },
      }),
    )
    await renderPage()
    await fillRequired()
    submit()

    expect((await screen.findByTestId('register-error-description')).textContent).toBe('description is too long')
  })

  it('a 422 naming a field the form does not have becomes a form-level alert', async () => {
    registerAssets.mockRejectedValueOnce(
      new ApiError({ status: 422, title: 'Unprocessable', detail: 'Something odd', extras: { field: 'bogus' } }),
    )
    await renderPage()
    await fillRequired()
    submit()

    expect((await screen.findByTestId('register-form-error')).textContent).toContain('Something odd')
  })

  it('403 (entity out of scope) is a form-level alert and the form is kept', async () => {
    registerAssets.mockRejectedValueOnce(new ApiError({ status: 403, title: 'Forbidden' }))
    await renderPage()
    await fillRequired()
    submit()

    const alert = await screen.findByTestId('register-form-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('You cannot register assets for this entity.')
    expect(field('Description').value).toBe('MacBook Pro 14')
  })

  it('503 shows the authorization-unavailable banner, keeps every value and Retry submits again', async () => {
    registerAssets.mockRejectedValueOnce(new ApiError({ status: 503, title: 'Unavailable' }))
    await renderPage()
    await fillRequired()
    submit()

    expect((await screen.findByTestId('error-banner-heading')).textContent).toBe('Authorization service unavailable')
    expect(field('Description').value).toBe('MacBook Pro 14')

    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await waitFor(() => expect(registerAssets).toHaveBeenCalledTimes(2))
  })

  it('a network failure says the registration is unconfirmed and to check the list first; the form is kept', async () => {
    registerAssets.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderPage()
    await fillRequired()
    submit()

    const alert = await screen.findByTestId('register-form-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe('We could not confirm the registration. Check the asset list before trying again.')
    expect(field('Description').value).toBe('MacBook Pro 14')
    expect(field('Total price').value).toBe('998.15')
    // the form is usable again
    expect(screen.getByRole('button', { name: /^Register/ }).getAttribute('aria-busy')).toBeNull()
  })

  it('a gateway timeout (502) is just as unconfirmed as a network failure', async () => {
    registerAssets.mockRejectedValueOnce(new ApiError({ status: 502, title: 'Bad gateway' }))
    await renderPage()
    await fillRequired()
    submit()

    expect((await screen.findByTestId('register-form-error')).textContent).toContain('Check the asset list')
  })
})

describe('submitting', () => {
  it('is aria-busy, locks the fields and sends one request however often it is clicked', async () => {
    let resolve: (value: { assets: AssetView[] }) => void = () => undefined
    registerAssets.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    await renderPage()
    await fillRequired()

    submit()
    const button = await screen.findByRole('button', { name: 'Registering…' })
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    fireEvent.submit(button.closest('form')!)
    expect(field('Description').matches(':disabled')).toBe(true)
    expect(registerAssets).toHaveBeenCalledTimes(1)

    resolve({ assets: [created('new1')] })
    await screen.findByText('detail page')
  })
})

describe('success', () => {
  it('N = 1 navigates to the new asset', async () => {
    const router = await renderPage()
    await fillRequired()
    submit()

    await screen.findByText('detail page')
    expect(router.state.location.pathname).toBe('/assets/new1')
    expect(router.state.location.state).toMatchObject({ registeredCount: 1 })
  })

  it('N > 1 navigates to the list filtered by the invoice reference, announcing the count', async () => {
    registerAssets.mockResolvedValueOnce({ assets: [created('a'), created('b'), created('c')] })
    const router = await renderPage()
    await fillRequired()
    type('Quantity', '3')
    type('Invoice reference', 'INV-77')
    submit()

    await screen.findByText('list page')
    expect(router.state.location.pathname).toBe('/assets')
    expect(router.state.location.search).toEqual({ invoiceRef: 'INV-77' })
    expect(router.state.location.state).toMatchObject({ registeredCount: 3 })
  })

  it('N > 1 without an invoice reference goes to the unfiltered list', async () => {
    registerAssets.mockResolvedValueOnce({ assets: [created('a'), created('b')] })
    const router = await renderPage()
    await fillRequired()
    type('Quantity', '2')
    submit()

    await screen.findByText('list page')
    expect(router.state.location.search).toEqual({})
  })
})

describe('cancel', () => {
  it('returns to the list, asking it to focus the Register asset button', async () => {
    const router = await renderPage()
    await screen.findByLabelText(/^Description/)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await screen.findByText('list page')
    expect(router.state.location.state).toMatchObject({ focusRegister: true })
  })
})
