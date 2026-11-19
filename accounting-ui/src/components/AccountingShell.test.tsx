/**
 * @vitest-environment jsdom
 *
 * AccountingShell (T28; design AS1, AS2, UX-2, UX-4, UX-12, UX-15; AC-8.2, AC-3.5, AC-3.6): the frame reads `GET /v1/me`
 * once and shows exactly one state — loading, denied (403 or no covered entity), the authorization-unavailable banner (503),
 * the other-failure banner, the not-found view, or the page — with the title on screen in every one, and axe finds nothing in
 * any of them. The entity in the address is resolved against what `/v1/me` says, never against the browser's own idea.
 * A probe page stands in for the cards (T29 to T31), to drive what a card tells the frame: a 404, a refused write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { useEntity } from '../hooks/useEntity'
import { validateAccountingSearch } from '../router'
import { fakeApi, meAnswer, meEntity, meItalia, problem } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'
import AccountingShell from './AccountingShell'
import EntitySwitch from './EntitySwitch'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getAccountingApiBaseUrl: () => 'http://accounting-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

/** What a card does with the frame: shows the entity and what it may do, and reports what it learned. */
function Probe() {
  const { entity, entityGone, writeRefused } = useEntity()
  return (
    <section aria-labelledby="probe-heading">
      <h2 id="probe-heading">Probe</h2>
      <EntitySwitch />
      <p data-testid="probe-entity">{entity.entity}</p>
      <p data-testid="probe-manage">{entity.canManage ? 'manager' : 'reader'}</p>
      <button type="button" onClick={entityGone}>
        a list answered 404
      </button>
      <button type="button" onClick={writeRefused}>
        a write answered 403
      </button>
    </section>
  )
}

const renderFrame = (url: string) => {
  window.history.pushState(null, '', url)
  const rootRoute = createRootRoute({ component: AccountingShell })
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/ledger-accounts',
      validateSearch: validateAccountingSearch,
      component: Probe,
    }),
  ])
  const router = createRouter({ routeTree, basepath: '/accounting' })
  return { router, ...render(<RouterProvider router={router} />) }
}

const meRoute = (...answers: FakeAnswer[]) => {
  let call = 0
  return { 'GET /v1/me': () => answers[Math.min(call++, answers.length - 1)]! }
}

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const title = () => screen.getByRole('heading', { level: 1, name: 'Accounting' })
const meCalls = () => apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/me')).length

describe('AccountingShell — one state at a time, the title in every one', () => {
  it('loading: a polite line and skeleton rows, with the tabs already there', async () => {
    let answer!: (value: FakeAnswer) => void
    apiFetch.mockImplementation(
      fakeApi({
        'GET /v1/me': () => new Promise<FakeAnswer>((resolve) => (answer = resolve)),
      }),
    )
    const { container } = renderFrame('/accounting/ledger-accounts')
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Loading Accounting…')
    expect(title()).not.toBeNull()
    expect(screen.getByRole('navigation', { name: 'Accounting sections' })).not.toBeNull()
    expect(screen.queryByTestId('probe-entity')).toBeNull()
    await expectNoAxeViolations(container)
    answer(meAnswer(meEntity()))
    expect(await screen.findByTestId('probe-entity')).not.toBeNull()
  })

  it('403: PermissionDenied, an alert whose heading has focus, no retry, no tabs (none of the views can open)', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute(problem(403, 'accounting_forbidden'))))
    const { container } = renderFrame('/accounting/ledger-accounts')
    const heading = await screen.findByRole('heading', { name: 'No access to Accounting' })
    expect(screen.getByRole('alert')).not.toBeNull()
    expect(document.activeElement).toBe(heading)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(title()).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('an empty entity list reads as denied (AC-3.6): never an empty page', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute({ status: 200, body: { entities: [] } })))
    renderFrame('/accounting/ledger-accounts')
    expect(await screen.findByRole('heading', { name: 'No access to Accounting' })).not.toBeNull()
    expect(screen.queryByTestId('probe-entity')).toBeNull()
  })

  it('503: the authorization-unavailable banner with Retry, which asks again and then shows the page', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(
      fakeApi(meRoute(problem(503, 'auth_unavailable', {}, 'secret detail'), meAnswer(meEntity()))),
    )
    const { container } = renderFrame('/accounting/ledger-accounts')
    expect(await screen.findByText('Authorization service unavailable')).not.toBeNull()
    expect(screen.getByText('We cannot verify your access right now. Nothing was changed.')).not.toBeNull()
    expect(screen.queryByText('secret detail')).toBeNull()
    expect(title()).not.toBeNull()
    await expectNoAxeViolations(container)
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('probe-entity')).not.toBeNull()
    expect(meCalls()).toBe(2)
  })

  it('any other failure: a warning banner with the Problem detail and Retry', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute(problem(500, 'internal', {}, 'The ledger is unavailable.'))))
    const { container } = renderFrame('/accounting/ledger-accounts')
    expect(await screen.findByText('The ledger is unavailable.')).not.toBeNull()
    expect(screen.getByText('Could not load')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('a failure that is not a Problem (the network) says so, with Retry', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    renderFrame('/accounting/ledger-accounts')
    expect(
      await screen.findByText('The server could not be reached. Check your connection and try again.'),
    ).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
  })

  it('reads /v1/me once for a page that is shown (not once per render or per tab)', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity(), meItalia()))))
    renderFrame('/accounting/ledger-accounts')
    await screen.findByTestId('probe-entity')
    expect(meCalls()).toBe(1)
  })
})

describe('AccountingShell — the entity (AC-8.2, AC-3.5, UX-2, UX-12)', () => {
  it('one covered entity: no switch, the entity shown, the address untouched', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity({ canManage: false })))))
    const { container } = renderFrame('/accounting/ledger-accounts')
    expect(await screen.findByTestId('probe-entity')).toHaveProperty('textContent', 'welld_ch')
    expect(screen.getByTestId('probe-manage').textContent).toBe('reader')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(window.location.search).toBe('')
    await expectNoAxeViolations(container)
  })

  it('two covered entities: the switch appears, writes ?entity= with replace, announces it and keeps focus', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity(), meItalia({ canManage: false })))))
    const { container } = renderFrame('/accounting/ledger-accounts?month=2026-03')
    const select = await screen.findByRole('combobox', { name: 'Entity' })
    expect(screen.getByTestId('probe-entity').textContent).toBe('welld_ch')
    await expectNoAxeViolations(container)

    const historyLength = window.history.length
    await user.selectOptions(select, 'welld_it')
    await waitFor(() => expect(screen.getByTestId('probe-entity').textContent).toBe('welld_it'))
    // `replace`, not a new history entry; `?month=` belongs to the entity it was addressed to.
    expect(window.history.length).toBe(historyLength)
    expect(window.location.search).toBe('?entity=welld_it')
    expect(screen.getByTestId('probe-manage').textContent).toBe('reader')
    expect(screen.getByRole('status', { name: '' }).textContent).toBe('Showing WellD Italia')
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Entity' }))
    expect(meCalls()).toBe(1)
    await expectNoAxeViolations(container)
  })

  it('?entity=xyz falls back to the first covered entity, and the address is replaced', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity(), meItalia()))))
    const historyLength = window.history.length
    renderFrame('/accounting/ledger-accounts?entity=xyz')
    expect(await screen.findByTestId('probe-entity')).toHaveProperty('textContent', 'welld_ch')
    await waitFor(() => expect(window.location.search).toBe('?entity=welld_ch'))
    // `replace`: the one entry is the test's own pushState, the rewrite adds none.
    expect(window.history.length).toBe(historyLength + 1)
    expect(screen.queryByTestId('accounting-not-found')).toBeNull()
  })

  it('?entity=welld_it for a person who covers only WellD CH: the not-found view, focus on its heading, never the other data', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity()))))
    const { container } = renderFrame('/accounting/ledger-accounts?entity=welld_it')
    const heading = await screen.findByRole('heading', { name: 'This page does not exist' })
    expect(document.activeElement).toBe(heading)
    expect(screen.getByRole('alert')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to ledger accounts' }).getAttribute('href')).toBe('/accounting/')
    expect(screen.queryByTestId('probe-entity')).toBeNull()
    // Not a silent substitution: the address keeps what was asked.
    expect(window.location.search).toBe('?entity=welld_it')
    expect(title()).not.toBeNull()
    // The tabs stay, and they do not carry the entity that cannot be shown.
    const nav = screen.getByRole('navigation', { name: 'Accounting sections' })
    expect(within(nav).getByRole('link', { name: 'VAT codes' }).getAttribute('href')).toBe('/accounting/vat-codes')
    await expectNoAxeViolations(container)
  })

  it('?entity=welld_it for a person who covers it shows it', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity(), meItalia()))))
    renderFrame('/accounting/ledger-accounts?entity=welld_it')
    expect(await screen.findByTestId('probe-entity')).toHaveProperty('textContent', 'welld_it')
    expect(screen.getByRole('combobox', { name: 'Entity' })).toHaveProperty('value', 'welld_it')
  })

  it('a person who covers only WellD Italia sees it by default, with no switch', async () => {
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meItalia()))))
    renderFrame('/accounting/ledger-accounts')
    expect(await screen.findByTestId('probe-entity')).toHaveProperty('textContent', 'welld_it')
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

describe('AccountingShell — a grant that changed during the session (UX-12, UX-15)', () => {
  it('a list answering 404 re-reads /v1/me, falls back and says so once, dismissibly', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity(), meItalia()), meAnswer(meEntity()))))
    const { container } = renderFrame('/accounting/ledger-accounts?entity=welld_it')
    await screen.findByTestId('probe-entity')
    expect(screen.getByTestId('probe-entity').textContent).toBe('welld_it')

    await user.click(screen.getByRole('button', { name: 'a list answered 404' }))
    expect(await screen.findByText('You no longer have access to WellD Italia. Showing WellD CH.')).not.toBeNull()
    expect(screen.getByTestId('probe-entity').textContent).toBe('welld_ch')
    expect(screen.queryByRole('combobox')).toBeNull()
    await waitFor(() => expect(window.location.search).toBe('?entity=welld_ch'))
    expect(screen.queryByTestId('accounting-not-found')).toBeNull()
    expect(meCalls()).toBe(2)
    await expectNoAxeViolations(container)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('accounting-notice')).toBeNull()
    // Dismissing does not make the address a typed one again.
    expect(screen.getByTestId('probe-entity').textContent).toBe('welld_ch')
  })

  it('a 404 while /v1/me still lists the entity says nothing and changes nothing', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity(), meItalia()))))
    renderFrame('/accounting/ledger-accounts?entity=welld_it')
    await screen.findByTestId('probe-entity')
    await user.click(screen.getByRole('button', { name: 'a list answered 404' }))
    await waitFor(() => expect(meCalls()).toBe(2))
    expect(screen.queryByTestId('accounting-notice')).toBeNull()
    expect(screen.getByTestId('probe-entity').textContent).toBe('welld_it')
  })

  it('a write answering 403 re-reads /v1/me so a control that should not be there goes, and says the access changed', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity()), meAnswer(meEntity({ canManage: false })))))
    const { container } = renderFrame('/accounting/ledger-accounts')
    await screen.findByTestId('probe-entity')
    expect(screen.getByTestId('probe-manage').textContent).toBe('manager')

    await user.click(screen.getByRole('button', { name: 'a write answered 403' }))
    expect(await screen.findByText('Your access to Accounting changed. The page was updated.')).not.toBeNull()
    expect(screen.getByTestId('probe-manage').textContent).toBe('reader')
    await expectNoAxeViolations(container)
  })

  it('a refused write that does not change what /v1/me says adds no note', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(fakeApi(meRoute(meAnswer(meEntity()))))
    renderFrame('/accounting/ledger-accounts')
    await screen.findByTestId('probe-entity')
    await user.click(screen.getByRole('button', { name: 'a write answered 403' }))
    await waitFor(() => expect(meCalls()).toBe(2))
    expect(screen.queryByTestId('accounting-notice')).toBeNull()
    expect(screen.getByTestId('probe-manage').textContent).toBe('manager')
  })

  it('a re-read that is refused (every grant removed) shows denied, through the same ladder', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(
      fakeApi(
        meRoute(meAnswer(meEntity()), problem(403, 'accounting_forbidden'), problem(403, 'accounting_forbidden')),
      ),
    )
    renderFrame('/accounting/ledger-accounts')
    await screen.findByTestId('probe-entity')
    await user.click(screen.getByRole('button', { name: 'a write answered 403' }))
    expect(await screen.findByRole('heading', { name: 'No access to Accounting' })).not.toBeNull()
    expect(screen.queryByTestId('probe-entity')).toBeNull()
  })

  it('a re-read that finds the authorization service down shows its banner, with Retry', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(
      fakeApi(meRoute(meAnswer(meEntity()), problem(503, 'auth_unavailable'), problem(503, 'auth_unavailable'))),
    )
    renderFrame('/accounting/ledger-accounts')
    await screen.findByTestId('probe-entity')
    await user.click(screen.getByRole('button', { name: 'a list answered 404' }))
    expect(await screen.findByText('Authorization service unavailable')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
  })
})
