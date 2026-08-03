/**
 * @vitest-environment jsdom
 *
 * Tests for AboutModal — shows the suite's info (name, description), the author
 * (linked), and the version, and closes on Escape / backdrop.
 *
 * Ported from estimai-ui/src/components/AboutModal.test.tsx (T6, specs/003-suite-shell,
 * AC-1.4). Behavior is unchanged; APP_NAME/APP_VERSION now resolve to the suite's
 * values via the relocated, suite-level ../lib/appInfo.
 *
 * "Components" section (version-bump plan §C/§F): AboutModal additionally lists
 * each mounted remote's own version, resolved via a dynamic `import('<remote>/version')`
 * raced against a timeout (../hooks/useRemoteVersions.ts). Exercising the real bare MF
 * specifiers (`estimai/version` etc.) here would mean mocking Module Federation's
 * runtime-only import resolution — fragile in a unit test (aliasing + ES module-cache
 * interactions make per-test mock overrides unreliable). Instead, AboutModal accepts an
 * optional `remoteVersionSources` prop (defaulting to the real suite remotes) purely as
 * a test seam — the same shape RemoteMount's `loader` prop already establishes
 * elsewhere in this codebase for deterministically testing async remote-loading states.
 * Each test below builds a small fake source list with plain, directly-controllable
 * loader functions. The three cases marked (§F) are the three DISTINCT failure shapes a
 * remote's `./version` import can present — a rejected import, a timed-out import, and a
 * resolved-but-malformed export — each proven to degrade to a muted "—" without
 * throwing, without blocking the modal, and without affecting the OTHER remotes' real
 * versions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import AboutModal from './AboutModal'
import { APP_NAME, APP_AUTHOR, APP_AUTHOR_URL, APP_VERSION } from '../lib/appInfo'
import { REMOTE_VERSION_TIMEOUT_MS, type RemoteVersionSource } from '../hooks/useRemoteVersions'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A four-remote fixture mirroring the real REMOTE_VERSION_SOURCES shape, with all-resolving default loaders. */
function fourRemoteFixture(
  overrides: Partial<Record<RemoteVersionSource['id'], RemoteVersionSource['loader']>> = {},
): RemoteVersionSource[] {
  const defaults: Record<RemoteVersionSource['id'], RemoteVersionSource['loader']> = {
    estimai: () => Promise.resolve({ REMOTE_VERSION: '1.2.3' }),
    refund: () => Promise.resolve({ REMOTE_VERSION: '4.5.6' }),
    admin: () => Promise.resolve({ REMOTE_VERSION: '7.8.9' }),
    notify: () => Promise.resolve({ REMOTE_VERSION: '0.1.0' }),
  }
  return [
    { id: 'estimai', label: 'EstimAI', loader: overrides.estimai ?? defaults.estimai },
    { id: 'refund', label: 'Refund', loader: overrides.refund ?? defaults.refund },
    { id: 'admin', label: 'Admin', loader: overrides.admin ?? defaults.admin },
    { id: 'notify', label: 'Notify', loader: overrides.notify ?? defaults.notify },
  ]
}

describe('AboutModal', () => {
  it('renders the suite name, version, and a linked author', () => {
    render(<AboutModal onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: `About ${APP_NAME}` })
    expect(dialog.textContent).toContain(APP_NAME)
    expect(dialog.textContent).toContain(APP_VERSION)

    const authorLink = screen.getByRole('link', { name: APP_AUTHOR }) as HTMLAnchorElement
    expect(authorLink.href).toContain(APP_AUTHOR_URL)
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<AboutModal onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the backdrop is clicked but not the panel', () => {
    const onClose = vi.fn()
    render(<AboutModal onClose={onClose} />)

    // Clicking the dialog panel does NOT close.
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    // Clicking the close button does.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  describe('Components section — per-remote versions', () => {
    it("shows each mounted remote's own version once its import resolves", async () => {
      render(<AboutModal onClose={() => {}} remoteVersionSources={fourRemoteFixture()} />)

      await waitFor(() => {
        expect(screen.getByTestId('remote-version-estimai').textContent).toBe('1.2.3')
      })
      expect(screen.getByTestId('remote-version-refund').textContent).toBe('4.5.6')
      expect(screen.getByTestId('remote-version-admin').textContent).toBe('7.8.9')
      expect(screen.getByTestId('remote-version-notify').textContent).toBe('0.1.0')
    })

    it('renders the modal and the other remotes’ real versions when one remote’s import REJECTS', async () => {
      const sources = fourRemoteFixture({
        refund: () => Promise.reject(new Error('network error fetching remoteEntry.js')),
      })

      render(<AboutModal onClose={() => {}} remoteVersionSources={sources} />)

      await waitFor(() => {
        expect(screen.getByTestId('remote-version-estimai').textContent).toBe('1.2.3')
      })
      // The rejected remote degrades to a muted em dash, never a thrown error.
      expect(screen.getByTestId('remote-version-refund').textContent).toBe('—')
      expect(screen.getByTestId('remote-version-admin').textContent).toBe('7.8.9')
      expect(screen.getByTestId('remote-version-notify').textContent).toBe('0.1.0')
      // The modal itself is still fully rendered and interactive.
      expect(screen.getByRole('dialog', { name: `About ${APP_NAME}` })).not.toBeNull()
    })

    it('renders the modal and the other remotes’ real versions when one remote’s import TIMES OUT (never settles)', async () => {
      vi.useFakeTimers()
      const sources = fourRemoteFixture({
        // A remote that's unreachable / mid cold-start: the import promise
        // never settles at all — only the timeout race leg can resolve this.
        admin: () => new Promise(() => {}),
      })

      render(<AboutModal onClose={() => {}} remoteVersionSources={sources} />)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REMOTE_VERSION_TIMEOUT_MS + 50)
      })

      expect(screen.getByTestId('remote-version-admin').textContent).toBe('—')
      // The remotes whose imports resolve promptly are unaffected by admin's
      // stalled import — each row settles independently, none blocks another.
      expect(screen.getByTestId('remote-version-estimai').textContent).toBe('1.2.3')
      expect(screen.getByTestId('remote-version-refund').textContent).toBe('4.5.6')
      expect(screen.getByTestId('remote-version-notify').textContent).toBe('0.1.0')
      expect(screen.getByRole('dialog', { name: `About ${APP_NAME}` })).not.toBeNull()
    })

    it('renders the modal and the other remotes’ real versions when one remote’s export is MALFORMED (not a string)', async () => {
      // Simulates a remote that predates this feature and exposes SOMETHING
      // at `./version`, but not the expected shape — e.g. an accidental
      // re-export, or a REMOTE_VERSION that isn't a string.
      const sources = fourRemoteFixture({
        notify: () => Promise.resolve({ REMOTE_VERSION: 12345 }),
      })

      render(<AboutModal onClose={() => {}} remoteVersionSources={sources} />)

      await waitFor(() => {
        expect(screen.getByTestId('remote-version-estimai').textContent).toBe('1.2.3')
      })
      expect(screen.getByTestId('remote-version-notify').textContent).toBe('—')
      expect(screen.getByTestId('remote-version-refund').textContent).toBe('4.5.6')
      expect(screen.getByTestId('remote-version-admin').textContent).toBe('7.8.9')
      expect(screen.getByRole('dialog', { name: `About ${APP_NAME}` })).not.toBeNull()
    })

    it('renders the modal and the other remotes’ real versions when one remote’s export is UNDEFINED', async () => {
      // A remote that predates this feature entirely typically resolves its
      // `./version` specifier to *something* MF-shaped but without the
      // named export at all — modeled here as an explicit undefined.
      const sources = fourRemoteFixture({
        estimai: () => Promise.resolve({ REMOTE_VERSION: undefined }),
      })

      render(<AboutModal onClose={() => {}} remoteVersionSources={sources} />)

      await waitFor(() => {
        expect(screen.getByTestId('remote-version-refund').textContent).toBe('4.5.6')
      })
      expect(screen.getByTestId('remote-version-estimai').textContent).toBe('—')
      expect(screen.getByTestId('remote-version-admin').textContent).toBe('7.8.9')
      expect(screen.getByTestId('remote-version-notify').textContent).toBe('0.1.0')
    })
  })
})
