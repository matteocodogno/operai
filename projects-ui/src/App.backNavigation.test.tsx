/**
 * @vitest-environment jsdom
 *
 * Browser back across suite modules (specs/022 AC-6.1, D52). The shell mounts the
 * remote at `/projects/*`; moving to another module unmounts it and the browser's
 * back button remounts it. Whatever address the browser holds, the remote shows the
 * page of THAT address (the list for `/projects`) and sends no request derived from
 * another module's address (`GET /projects/admin`, `GET /projects/crm`,
 * `GET /projects/notify`) — and a remote that is unmounted leaves no history listener.
 */
import { StrictMode, Suspense, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fakeApi, page, scope } from './test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

import App from './App'

const afterPopState = (move: () => void) =>
  new Promise<void>((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true })
    move()
  })

/** Lets the mounted remote react to an address change, if it is going to. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const requestedPaths = () =>
  apiFetch.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)

beforeEach(() => {
  window.scrollTo = () => undefined
  apiFetch.mockImplementation(
    fakeApi({
      'GET /scope': () => ({ status: 200, body: scope() }),
      'GET /projects': () => ({ status: 200, body: page([]) }),
      'GET /project-managers': () => ({ status: 200, body: { items: [] } }),
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

describe.each([
  ['/admin/roles', 'admin'],
  ['/crm/companies', 'crm'],
  ['/notify', 'notify'],
])('App (projects-ui), moving to %s and back', (otherModuleAddress, otherModule) => {
  it(`shows the projects list throughout, and never asks for a project named ${otherModule}`, async () => {
    window.history.pushState(null, '', '/projects')
    const firstMount = render(<App />)
    await screen.findByTestId('projects-page')

    // The shell moves the URL to another module; the remote stays on screen while that module loads.
    window.history.pushState(null, '', otherModuleAddress)
    await settle()
    expect(screen.queryByTestId('projects-not-found')).toBeNull()
    expect(screen.queryByTestId('project-detail-page')).toBeNull()
    expect(screen.getByTestId('projects-page')).not.toBeNull()

    // Then the remote unmounts, and the browser's back button mounts it anew.
    firstMount.unmount()
    await afterPopState(() => window.history.back())
    expect(window.location.pathname).toBe('/projects')
    render(<App />)

    expect(await screen.findByTestId('projects-page')).not.toBeNull()
    expect(screen.queryByTestId('projects-not-found')).toBeNull()
    expect(screen.queryByTestId('project-detail-page')).toBeNull()
    expect(requestedPaths().filter((request) => request.includes(`/projects/${otherModule}`))).toEqual([])
  })
})

/**
 * Moving inside the module (list -> `/projects/queue`). While the shell's access guard
 * answers, the shell hides the mounted remote behind its pending fallback (a Suspense
 * boundary) and shows it again; under strict mode (the shell's own, in development)
 * React then runs the remote's effect cleanups and setups again on the SAME instance,
 * with no render in between (specs/022 AC-6.1, QE round 2: the to-start page came back
 * blank).
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

describe('App (projects-ui), moving inside the module', () => {
  beforeEach(() => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: scope({ take: ['welld_ch'] }) }),
        'GET /projects': () => ({ status: 200, body: page([]) }),
        'GET /project-managers': () => ({ status: 200, body: { items: [] } }),
        'GET /queue': () => ({ status: 200, body: { items: [], truncated: false } }),
      }),
    )
  })

  it('shows the new page when the shell hides the mounted remote and shows it again', async () => {
    window.history.pushState(null, '', '/projects')
    const view = render(shellLike(null))
    await screen.findByTestId('projects-page')

    window.history.pushState(null, '', '/projects/queue')
    await screen.findByTestId('queue-page')
    await hideThenShow(view)

    expect(await screen.findByTestId('queue-page')).not.toBeNull()
    expect(screen.queryByTestId('projects-page')).toBeNull()
    expect(screen.queryByTestId('shell-pending')).toBeNull()
  })

  it('shows the module’s own page when it is shown again after the address was elsewhere meanwhile', async () => {
    window.history.pushState(null, '', '/projects/queue')
    const view = render(shellLike(null))
    await screen.findByTestId('queue-page')

    // The shell moves to another module and hides this one; a redirect then brings the address back.
    await hideThenShow(view, () => {
      window.history.pushState(null, '', '/crm/companies')
      window.history.pushState(null, '', '/projects')
    })

    expect(await screen.findByTestId('projects-page')).not.toBeNull()
    expect(screen.queryByTestId('projects-not-found')).toBeNull()
    expect(requestedPaths().filter((request) => request.includes('/projects/crm'))).toEqual([])
  })

  it('shows the new page when the shell unmounts the remote and mounts it again at that address', async () => {
    window.history.pushState(null, '', '/projects')
    const firstMount = render(<App />)
    await screen.findByTestId('projects-page')

    window.history.pushState(null, '', '/projects/queue')
    await screen.findByTestId('queue-page')
    firstMount.unmount()
    render(<App />)

    expect(await screen.findByTestId('queue-page')).not.toBeNull()
  })

  it('shows the same page when the shell unmounts the remote and mounts it again at the same address', async () => {
    window.history.pushState(null, '', '/projects/queue')
    const firstMount = render(<App />)
    await screen.findByTestId('queue-page')

    firstMount.unmount()
    render(<App />)

    expect(await screen.findByTestId('queue-page')).not.toBeNull()
  })
})

describe('App (projects-ui), once unmounted', () => {
  it('leaves no history listener behind, strict mode included', async () => {
    window.history.pushState(null, '', '/projects')
    const pushState = window.history.pushState
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const popstateCalls = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === 'popstate').length

    const mounted = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    await screen.findByTestId('projects-page')
    mounted.unmount()

    expect(popstateCalls(added)).toBeGreaterThan(0)
    expect(popstateCalls(removed)).toBe(popstateCalls(added))
    expect(window.history.pushState).toBe(pushState)
    added.mockRestore()
    removed.mockRestore()
  })
})

/**
 * Back and forward inside the module (specs/022 AC-6.2, D53). The shell's own router
 * listens to the same browser history, BEFORE the remote does, and answers every address
 * change with its access guard; while it answers it hides the mounted remote behind its
 * pending fallback. React renders that between the two listeners, so the remote's
 * layout effects (TanStack Router's history subscription among them) are cleaned up
 * before the remote's own listener hears the same change — and on the way back in they
 * do not load what they missed (QE round 2: back changed the address, not the page).
 */
const shellThatAnswersAddressChanges = () => {
  let hold!: (block: Promise<void> | null) => void
  let release: (() => void) | null = null
  const Shell = () => {
    const [block, setBlock] = useState<Promise<void> | null>(null)
    useEffect(() => {
      hold = setBlock
    }, [])
    // No strict mode here: its extra effect round on a shown boundary makes a new router, which
    // reads the address and would hide the defect. The live dev stack shows no such round on back.
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

describe('App (projects-ui), browser back and forward inside the module', () => {
  const shell = shellThatAnswersAddressChanges()
  beforeEach(() => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /scope': () => ({ status: 200, body: scope({ take: ['welld_ch'] }) }),
        'GET /projects': () => ({ status: 200, body: page([]) }),
        'GET /project-managers': () => ({ status: 200, body: { items: [] } }),
        'GET /queue': () => ({ status: 200, body: { items: [], truncated: false } }),
      }),
    )
    shell.listen()
  })
  afterEach(() => shell.stopListening())

  it('shows the list when back leaves "To start", and "To start" again when forward returns to it', async () => {
    window.history.pushState(null, '', '/projects')
    render(<shell.Shell />)
    await screen.findByTestId('projects-page')
    fireEvent.click(screen.getAllByRole('link', { name: /to start/i })[0]!)
    await screen.findByTestId('queue-page')

    await shell.move(() => window.history.back())
    expect(window.location.pathname).toBe('/projects')
    expect(await screen.findByTestId('projects-page')).not.toBeNull()
    expect(screen.queryByTestId('queue-page')).toBeNull()

    await shell.move(() => window.history.forward())
    expect(window.location.pathname).toBe('/projects/queue')
    expect(await screen.findByTestId('queue-page')).not.toBeNull()
    expect(screen.queryByTestId('projects-page')).toBeNull()
  })
})
