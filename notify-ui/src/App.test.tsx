/**
 * @vitest-environment jsdom
 *
 * Component tests for App.tsx — notify-ui's exposed `./App` (T14,
 * specs/005-notification-center/tasks.md). Mirrors
 * admin-ui/src/App.test.tsx's split: this file proves the EXACT exposed
 * component — with its hardcoded `/notify` basepath — mounts and resolves
 * under that prefix; src/router.test.tsx separately covers the router's
 * structure using the basepath-less factory.
 *
 * `shell/tokens.css` is a side-effect-only import — vitest.config.ts's
 * `resolve.alias` points the bare specifier at a real (empty) local stub so
 * Vite's import-analysis is satisfied; nothing to assert on for it here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const { default: App } = await import('./App')

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('App (notify-ui, mounted under /notify)', () => {
  it('landing on /notify renders the notification center page shell', async () => {
    window.history.pushState(null, '', '/notify')

    render(<App />)

    const heading = await screen.findByTestId('notify-center-heading')
    expect(heading.textContent).toBe('Notifications')
    expect(window.location.pathname).toBe('/notify')
  })

  it('an unmatched path under /notify renders the not-found fallback', async () => {
    window.history.pushState(null, '', '/notify/whatever')

    render(<App />)

    expect(await screen.findByTestId('notify-not-found-page')).not.toBeNull()
  })
})
