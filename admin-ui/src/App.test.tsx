/**
 * @vitest-environment jsdom
 *
 * Component tests for App.tsx — admin-ui's exposed `./App` placeholder
 * (T13, specs/004-auth-roles-permissions).
 *
 * Proves:
 *   (a) the placeholder renders — a heading identifying the tool and a
 *       short coming-soon / proof-of-concept message, and nothing else (no
 *       forms, tables, or Roles/Departments/Users/Audit content — those are
 *       later tasks, T14+).
 *   (b) with a mocked SIGNED-IN user (`shell/session`'s useSession), the
 *       shared-session demonstration line shows that user's name — proving
 *       this remote reads the ONE suite-wide session (ADR-0001/ADR-0006)
 *       rather than holding its own.
 *   (c) when the session hook has no user data yet (e.g. useSession still
 *       pending), the component still renders the placeholder without
 *       crashing and simply omits the "Signed in as" line — defensive
 *       coverage since useSession is a separate reactive subscription from
 *       the shell's one-shot `_authed` guard (mirrors refund-ui/src/App.test.tsx's
 *       reasoning exactly).
 *
 * `shell/session` is a federated module (bare specifier `shell/session`,
 * only resolvable at runtime via @module-federation/vite) — vitest.config.ts
 * aliases it to a local stub purely to satisfy Vite's import-analysis; this
 * test overrides its content with vi.mock (hoisted above the App import).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const mockUseSession = vi.fn()

vi.mock('shell/session', () => ({
  useSession: () => mockUseSession(),
}))

// App.tsx also does a side-effect `import 'shell/tokens.css'` — left
// unmocked here: vitest.config.ts's `resolve.alias` already points the bare
// `shell/tokens.css` specifier at a real (empty) local stub, which is enough
// to satisfy the import with nothing to assert on (visual consistency is an
// e2e/design concern, out of scope for this smoke test).

const { default: App } = await import('./App')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App (admin-ui placeholder)', () => {
  it('renders a heading identifying the tool and a coming-soon message', () => {
    mockUseSession.mockReturnValue({ data: null })

    render(<App />)

    expect(screen.getByRole('heading', { name: /admin/i })).not.toBeNull()
    expect(screen.getByText(/coming soon/i)).not.toBeNull()
    expect(screen.getByText(/proof-of-concept/i)).not.toBeNull()
  })

  it('renders no forms, tables, or roles/departments/users/audit content (placeholder only)', () => {
    mockUseSession.mockReturnValue({ data: null })

    render(<App />)

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the signed-in user\'s name, demonstrating the shared shell session', () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@welld.ch' } },
    })

    render(<App />)

    const signedInAs = screen.getByTestId('admin-signed-in-as')
    expect(signedInAs.textContent).toMatch(/Ada Lovelace/)
  })

  it('falls back to the email when the session has no name', () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: 'u2', email: 'consultant@welld.ch' } },
    })

    render(<App />)

    const signedInAs = screen.getByTestId('admin-signed-in-as')
    expect(signedInAs.textContent).toMatch(/consultant@welld\.ch/)
  })

  it('omits the "signed in as" line when the session has no user yet (still renders the placeholder)', () => {
    mockUseSession.mockReturnValue({ data: null })

    render(<App />)

    expect(screen.queryByTestId('admin-signed-in-as')).toBeNull()
    // The placeholder itself still renders — a pending/absent session read
    // does not crash the component (it is not this component's job to gate
    // on auth; the shell's `_authed` guard already did that before mounting).
    expect(screen.getByRole('heading', { name: /admin/i })).not.toBeNull()
  })
})
