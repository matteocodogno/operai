/**
 * @vitest-environment jsdom
 *
 * Browser back across suite modules (the guarantee projects-ui added in specs/026 AC-6.1/6.2, D52/D53,
 * which every remote mounted by the shell needs). The shell mounts the remote at `/hours/*`; moving to
 * another module unmounts it and the browser's back button remounts it. Whatever address the browser
 * holds, the remote shows the page of THAT address, never the not-found panel for another module's
 * address, and a remote that is unmounted leaves no history listener behind.
 */
import { StrictMode, Suspense, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { strings } from './strings'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getHoursApiBaseUrl: () => 'http://hours-api.test',
  usePermissions: () => ({
    epoch: 5,
    apps: ['admin'],
    roles: ['admin'],
    departments: [],
    permissions: [{ resource: 'time-entry', action: 'read-all' }],
  }),
}))

import App from './App'

const afterPopState = (move: () => void) =>
  new Promise<void>((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true })
    move()
  })

/** Lets the mounted remote react to an address change, if it is going to. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe.each([
  ['/admin/roles', 'admin'],
  ['/crm/companies', 'crm'],
  ['/notify', 'notify'],
])('App (hours-ui), moving to %s and back', (otherModuleAddress) => {
  it('shows My hours throughout, and never the not-found panel of another module’s address', async () => {
    window.history.pushState(null, '', '/hours')
    const firstMount = render(<App />)
    await screen.findByTestId('hours-my-page')

    // The shell moves the URL to another module; the remote stays on screen while that module loads.
    window.history.pushState(null, '', otherModuleAddress)
    await settle()
    expect(screen.queryByTestId('hours-not-found')).toBeNull()
    expect(screen.getByTestId('hours-my-page')).not.toBeNull()

    // Then the remote unmounts, and the browser's back button mounts it anew.
    firstMount.unmount()
    await afterPopState(() => window.history.back())
    expect(window.location.pathname).toBe('/hours')
    render(<App />)

    expect(await screen.findByTestId('hours-my-page')).not.toBeNull()
    expect(screen.queryByTestId('hours-not-found')).toBeNull()
  })
})

/**
 * Moving inside the module. While the shell's access guard answers, the shell hides the mounted
 * remote behind its pending fallback (a Suspense boundary) and shows it again; under strict mode
 * React then runs the remote's effect cleanups and setups again on the SAME instance with no render
 * in between.
 */
const Gate = ({ block }: { block: Promise<void> | null }) => {
  if (block) throw block
  return null
}

const shellLike = (block: Promise<void> | null) => (
  <StrictMode>
    <Suspense fallback={<p data-testid="shell-pending">pending</p>}>
      <App />
      <Gate block={block} />
    </Suspense>
  </StrictMode>
)

/** The shell hides the mounted remote, then shows it again. */
const hideThenShow = async (view: ReturnType<typeof render>, whileHidden: () => void = () => undefined) => {
  let reveal!: () => void
  view.rerender(shellLike(new Promise<void>((resolve) => (reveal = resolve))))
  await screen.findByTestId('shell-pending')
  whileHidden()
  reveal()
  view.rerender(shellLike(null))
}

describe('App (hours-ui), moving inside the module', () => {
  it('shows the new page when the shell hides the mounted remote and shows it again', async () => {
    window.history.pushState(null, '', '/hours')
    const view = render(shellLike(null))
    await screen.findByTestId('hours-my-page')

    window.history.pushState(null, '', '/hours/all')
    await screen.findByTestId('hours-everyone-page')
    await hideThenShow(view)

    expect(await screen.findByTestId('hours-everyone-page')).not.toBeNull()
    expect(screen.queryByTestId('hours-my-page')).toBeNull()
    expect(screen.queryByTestId('shell-pending')).toBeNull()
  })

  it('shows the module’s own page when it is shown again after the address was elsewhere meanwhile', async () => {
    window.history.pushState(null, '', '/hours/all')
    const view = render(shellLike(null))
    await screen.findByTestId('hours-everyone-page')

    // The shell moves to another module and hides this one; a redirect then brings the address back.
    await hideThenShow(view, () => {
      window.history.pushState(null, '', '/crm/companies')
      window.history.pushState(null, '', '/hours')
    })

    expect(await screen.findByTestId('hours-my-page')).not.toBeNull()
    expect(screen.queryByTestId('hours-not-found')).toBeNull()
  })

  it('shows the new page when the shell unmounts the remote and mounts it again at that address', async () => {
    window.history.pushState(null, '', '/hours')
    const firstMount = render(<App />)
    await screen.findByTestId('hours-my-page')

    window.history.pushState(null, '', '/hours/all')
    await screen.findByTestId('hours-everyone-page')
    firstMount.unmount()
    render(<App />)

    expect(await screen.findByTestId('hours-everyone-page')).not.toBeNull()
  })

  it('shows the same page when the shell unmounts the remote and mounts it again at the same address', async () => {
    window.history.pushState(null, '', '/hours/all')
    const firstMount = render(<App />)
    await screen.findByTestId('hours-everyone-page')

    firstMount.unmount()
    render(<App />)

    expect(await screen.findByTestId('hours-everyone-page')).not.toBeNull()
  })
})

describe('App (hours-ui), once unmounted', () => {
  it('leaves no history listener behind, strict mode included', async () => {
    window.history.pushState(null, '', '/hours')
    const pushState = window.history.pushState
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const popstateCalls = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === 'popstate').length

    const mounted = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    await screen.findByTestId('hours-my-page')
    mounted.unmount()

    expect(popstateCalls(added)).toBeGreaterThan(0)
    expect(popstateCalls(removed)).toBe(popstateCalls(added))
    expect(window.history.pushState).toBe(pushState)
    added.mockRestore()
    removed.mockRestore()
  })
})

/**
 * Back and forward inside the module. The shell's own router listens to the same browser history,
 * BEFORE the remote does, and answers every address change with its access guard; while it answers it
 * hides the mounted remote behind its pending fallback. React renders that between the two listeners,
 * so the remote's layout effects (TanStack Router's history subscription among them) are cleaned up
 * before the remote's own listener hears the same change, and on the way back in they do not load
 * what they missed: back changed the address, not the page.
 */
const shellThatAnswersAddressChanges = () => {
  let hold!: (block: Promise<void> | null) => void
  let release: (() => void) | null = null
  const Shell = () => {
    const [block, setBlock] = useState<Promise<void> | null>(null)
    useEffect(() => {
      hold = setBlock
    }, [])
    // No strict mode here: its extra effect round on a shown boundary makes a new router, which reads
    // the address and would hide the defect.
    return (
      <Suspense fallback={<p data-testid="shell-pending">pending</p>}>
        <App />
        <Gate block={block} />
      </Suspense>
    )
  }
  const onAddressChange = () =>
    act(() => {
      hold(new Promise<void>((resolve) => (release = resolve)))
    })
  return {
    Shell,
    listen: () => window.addEventListener('popstate', onAddressChange),
    stopListening: () => window.removeEventListener('popstate', onAddressChange),
    /** The browser moves through its history; the shell answers once the module has heard it. */
    move: async (go: () => void) => {
      await afterPopState(go)
      await screen.findByTestId('shell-pending')
      await act(async () => {
        release?.()
        hold(null)
      })
    },
  }
}

describe('App (hours-ui), browser back and forward inside the module', () => {
  const shell = shellThatAnswersAddressChanges()
  beforeEach(() => shell.listen())
  afterEach(() => shell.stopListening())

  it('shows My hours when back leaves Everyone’s hours, and Everyone’s hours again on forward', async () => {
    window.history.pushState(null, '', '/hours')
    render(<shell.Shell />)
    await screen.findByTestId('hours-my-page')
    fireEvent.click(screen.getByRole('link', { name: strings.common.nav.everyone }))
    await screen.findByTestId('hours-everyone-page')

    await shell.move(() => window.history.back())
    expect(window.location.pathname).toBe('/hours')
    expect(await screen.findByTestId('hours-my-page')).not.toBeNull()
    expect(screen.queryByTestId('hours-everyone-page')).toBeNull()

    await shell.move(() => window.history.forward())
    expect(window.location.pathname).toBe('/hours/all')
    expect(await screen.findByTestId('hours-everyone-page')).not.toBeNull()
    expect(screen.queryByTestId('hours-my-page')).toBeNull()
  })
})
