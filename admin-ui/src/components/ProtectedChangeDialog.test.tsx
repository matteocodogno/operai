/**
 * @vitest-environment jsdom
 *
 * ProtectedChangeDialog — the layout (T73, specs/20261117-legal-entities, design S12; AC-9.1, 9.6): the dialog is the
 * library's wide `ConfirmDialog` with a scrolling body, so with three long details the footer (Cancel, Save as version
 * n) is outside what scrolls and in view at 320 px. The CSS that does it is asserted in `@operai/ui`'s
 * `ConfirmDialog.test.tsx`; here the markup is the one the CSS needs, and the S12 behaviour (Cancel focused, the
 * description, Cancel and busy) is unchanged (`LegalEntityForm.protected.test.tsx` has the page-level flow).
 */
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProtectedChangeDialog from './ProtectedChangeDialog'
import { accessibleDescription } from './ProtectedChangeList.testkit'
import type { ProtectedChange } from '../lib/legalEntitiesApi'

afterEach(cleanup)

const LONG_NAME = 'Società Fiduciaria Internazionale per le Partecipazioni e i Servizi Finanziari Svizzera Italiana SA'
const CHANGES: ProtectedChange[] = [
  { field: 'legalName', before: 'wellD AG', after: LONG_NAME },
  { field: 'vatNumber', before: 'CHE-123.456.788 MWST', after: 'CHE-987.654.321 MWST' },
  { field: 'iban', before: 'CH93 0076 2011 6238 5295 7', after: 'DE89 3704 0044 0532 0130 00' },
]

const show = (over: { busy?: boolean } = {}) => {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ProtectedChangeDialog
      entityName="WellD CH"
      changes={CHANGES}
      nextVersion={9}
      busy={over.busy ?? false}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  )
  return { onConfirm, onCancel, user: userEvent.setup() }
}

describe('ProtectedChangeDialog layout', () => {
  it('is the wide dialog with a scrolling body that holds all three details, and a footer outside the scroll', () => {
    show()
    const box = screen.getByRole('alertdialog')
    expect(box.className).toContain('dialog-wide')
    expect(box.className).toContain('dialog-scroll')
    const scroll = screen.getByTestId('admin-legal-protected-scroll')
    expect(scroll.querySelectorAll('li')).toHaveLength(3)
    expect(scroll.textContent).toContain(LONG_NAME)
    expect(scroll.contains(screen.getByTestId('admin-legal-protected-confirm'))).toBe(false)
    expect(scroll.contains(screen.getByTestId('admin-legal-protected-cancel'))).toBe(false)
  })

  it('keeps Cancel focused, the whole content described, Escape as Cancel and busy as before', async () => {
    const { user, onCancel, onConfirm } = show()
    const box = screen.getByRole('alertdialog')
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-protected-cancel'))
    const description = document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent ?? ''
    for (const word of ['WellD CH', 'Old', 'New', LONG_NAME, 'DE89 3704 0044 0532 0130 00']) expect(description).toContain(word)
    expect(screen.getByTestId('admin-legal-protected-confirm').textContent).toBe('Save as version 9')
    expect(screen.getByTestId('admin-legal-protected-confirm').hasAttribute('aria-disabled')).toBe(false)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    cleanup()
    const busy = show({ busy: true })
    await busy.user.keyboard('{Escape}')
    expect(busy.onCancel).not.toHaveBeenCalled()
    expect((screen.getByTestId('admin-legal-protected-cancel') as HTMLButtonElement).disabled).toBe(true)
  })

  it('has no axe violations', async () => {
    show()
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(results.violations.map((v) => v.id)).toEqual([])
  })
})

describe('ProtectedChangeDialog accessible description (D3, AC-9.6)', () => {
  it('holds every detail with its Old and New values, as accname computes it (a list label must not replace them)', () => {
    show()
    const description = accessibleDescription(screen.getByRole('alertdialog'))
    for (const value of [
      'Legal name',
      'VAT number',
      'IBAN',
      'Old',
      'New',
      'wellD AG',
      LONG_NAME,
      'CHE-123.456.788 MWST',
      'CHE-987.654.321 MWST',
      'CH93 0076 2011 6238 5295 7',
      'DE89 3704 0044 0532 0130 00',
    ])
      expect(description).toContain(value)
  })

  it('renders no form of its own inside another form, and its own form is the only one', () => {
    show()
    expect(document.querySelectorAll('form form')).toHaveLength(0)
    expect(document.querySelectorAll('form')).toHaveLength(1)
  })
})
