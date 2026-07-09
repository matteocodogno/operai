/**
 * @vitest-environment jsdom
 *
 * Component tests for Footer (specs/003-suite-shell, T8, AC-1.5).
 *
 * Asserts the three required content pieces (legal link, version, company info) and
 * the "normal document flow" placement decision from plan.md/design.md: no
 * fixed/sticky positioning class anywhere in the rendered tree, distinguishing this
 * footer from EstimAI's own `position: fixed` "⇧? shortcuts" hint.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Footer from './Footer'
import { APP_AUTHOR, APP_AUTHOR_URL, APP_VERSION, LEGAL_URL } from '../lib/appInfo'

afterEach(() => cleanup())

describe('Footer', () => {
  it('renders a link to legal information', () => {
    render(<Footer />)
    const link = screen.getByRole('link', { name: /legal information/i })
    expect(link.getAttribute('href')).toBe(LEGAL_URL)
  })

  it('renders the version string sourced from appInfo', () => {
    render(<Footer />)
    expect(screen.getByTestId('app-version').textContent).toBe(`v${APP_VERSION}`)
  })

  it('renders company information (wellD) linking to the author URL', () => {
    render(<Footer />)
    const authorLink = screen.getByRole('link', { name: APP_AUTHOR })
    expect(authorLink.getAttribute('href')).toBe(APP_AUTHOR_URL)
  })

  it('renders in normal document flow — no fixed/sticky positioning anywhere in the tree', () => {
    const { container } = render(<Footer />)

    const positioned = container.querySelectorAll('[class*="fixed"], [class*="sticky"]')
    expect(positioned).toHaveLength(0)

    // Belt-and-braces: also assert via computed style, not just class-name
    // absence, so a future inline-style regression would be caught too.
    const root = container.firstElementChild as HTMLElement
    expect(root).not.toBeNull()
    const position = window.getComputedStyle(root).position
    expect(['fixed', 'sticky']).not.toContain(position)
  })
})
