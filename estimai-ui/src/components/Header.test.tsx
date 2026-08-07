/**
 * @vitest-environment jsdom
 *
 * Component tests for Header — the editor's in-content top bar
 * (specs/003-suite-shell, T14, AC-4.2).
 *
 * The shell now owns the suite-level chrome (logo/About dropdown, the
 * signed-in user's avatar/menu + sign-out, the theme toggle) — Header no
 * longer renders any of it and no longer accepts the props that used to
 * drive it (`user`, `onSignOut`, `theme`, `onCycleTheme`, `onShowAbout`).
 * Header keeps only the tool-scoped controls: the project-name input, the
 * save-status indicator, and the "My Estimates" nav button.
 *
 * Non-vacuous: these assertions would fail if LogoMenu/UserMenu/the theme
 * button were still rendered (or reintroduced), and would fail if the
 * project-name input / save-status / My Estimates button were removed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import Header from './Header'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Header', () => {
  it('does not render suite-level chrome (logo/About menu, user avatar/menu, theme toggle)', () => {
    render(<Header name="My Project" saveStatus="saved" onNameChange={() => {}} />)

    // LogoMenu's trigger has aria-label "<APP_NAME> menu" / aria-haspopup="menu"
    // pointing at a logo image — none of that exists here anymore.
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByLabelText(/menu$/i)).toBeNull()
    // UserMenu's avatar button used aria-haspopup="menu"; the theme toggle used
    // a title/aria-label naming the theme (e.g. "System theme (auto)"). Neither
    // should be present.
    expect(screen.queryByRole('button', { name: /theme/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the tool-scoped controls: project name, save-status, My Estimates', () => {
    render(<Header name="My Project" saveStatus="saving" onNameChange={() => {}} />)

    // Single project-name input — one desktop-only row (no separate mobile row,
    // which used to render a duplicate; see Header.tsx).
    const nameInput = screen.getByPlaceholderText('Project name…') as HTMLInputElement
    expect(nameInput.value).toBe('My Project')

    // Save-status indicator reflects the saveStatus prop.
    expect(screen.getByText('Saving…')).toBeDefined()

    // Exactly one "My Estimates" nav button.
    const myEstimatesButtons = screen.getAllByRole('button', { name: /My Estimates/i })
    expect(myEstimatesButtons.length).toBe(1)
  })

  it('calls onNameChange when the project-name input changes', () => {
    const onNameChange = vi.fn()
    render(<Header name="" saveStatus="idle" onNameChange={onNameChange} />)

    const nameInput = screen.getByPlaceholderText('Project name…')
    fireEvent.change(nameInput, { target: { value: 'New Name' } })

    expect(onNameChange).toHaveBeenCalledWith('New Name')
  })
})

// ---------------------------------------------------------------------------
// T17 (specs/013-estimate-sharing/tasks.md; design.md S5) — readOnly gating.
//
// design.md's table for Header: "name input becomes readOnly; the
// save-status span is omitted entirely (nothing ever autosaves, so there's
// nothing to report — not shown blank)".
// ---------------------------------------------------------------------------

describe('Header — readOnly (viewer) gating (T17, AC-3.1/AC-3.2)', () => {
  it('makes the project-name input readOnly, not disabled, when readOnly', () => {
    render(<Header name="Shared Project" saveStatus="idle" onNameChange={() => {}} readOnly />)

    const nameInput = screen.getByPlaceholderText('Project name…') as HTMLInputElement
    expect(nameInput.readOnly).toBe(true)
    expect(nameInput.disabled).toBe(false)
    expect(nameInput.value).toBe('Shared Project')
  })

  it('omits the save-status indicator entirely when readOnly (not shown blank)', () => {
    render(<Header name="Shared Project" saveStatus="saved" onNameChange={() => {}} readOnly />)

    expect(screen.queryByText('✓ Saved')).toBeNull()
    expect(screen.queryByText('Saving…')).toBeNull()
    expect(screen.queryByText('Save failed')).toBeNull()
  })

  it('keeps the project-name input editable (not readOnly) when readOnly is false (the default)', () => {
    render(<Header name="My Project" saveStatus="saved" onNameChange={() => {}} />)

    const nameInput = screen.getByPlaceholderText('Project name…') as HTMLInputElement
    expect(nameInput.readOnly).toBe(false)
    // The save-status indicator is still present for an editor/owner.
    expect(screen.getByText('✓ Saved')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// T18 (specs/013-estimate-sharing/tasks.md; design.md S4) — the 4th
// save-status state: "Not saving — reload to continue", shown whenever
// autosave is suspended (saveStatus === 'conflict').
// ---------------------------------------------------------------------------

describe('Header — the 4th "conflict" save-status state (T18, AC-4.2)', () => {
  it('renders "Not saving — reload to continue" instead of falling through to "✓ Saved"', () => {
    render(<Header name="My Project" saveStatus="conflict" onNameChange={() => {}} />)

    expect(screen.getByText('Not saving — reload to continue')).toBeDefined()
    expect(screen.queryByText('✓ Saved')).toBeNull()
  })

  it('renders the 4th state in the same error tone (text-org) as "Save failed" (design.md S4)', () => {
    render(<Header name="My Project" saveStatus="conflict" onNameChange={() => {}} />)
    const conflictSpan = screen.getByText('Not saving — reload to continue')

    expect(conflictSpan.className).toContain('text-org')
  })
})
