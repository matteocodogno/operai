/**
 * @vitest-environment jsdom
 *
 * The letterhead notice (specs/20261116-letterhead-service T32; design F13, S9; AC-10.7, AC-10.8): the link to Letterheads
 * only for a holder of access to it, the frame named for an overflow, polite in the pane and assertive on a refused Generate.
 */
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, it as italian, strings } from '../../strings'
import LetterheadNotice from './LetterheadNotice'

const session = vi.hoisted(() => ({ apps: [] as string[], manages: [] as string[] }))
vi.mock('shell/session', () => ({
  usePermissions: () => ({ epoch: 0, apps: session.apps, roles: [], departments: [], permissions: [] }),
}))

// the entity gate (design DR-18) is its own hook, tested on its own; here it is the person's answer
vi.mock('../../hooks/useCanManageLegalEntity', () => ({
  useCanManageLegalEntity: (entity: string) => session.manages.includes(entity),
}))

const t = strings.offerWizard.letterhead

afterEach(() => {
  cleanup()
  session.apps = []
  session.manages = []
})

describe('LetterheadNotice — no letterhead is set (AC-10.8)', () => {
  it('names the entity and what needs one, and links to its configurator for a holder of access', () => {
    session.apps = ['crm', 'letterheads']
    render(<LetterheadNotice entity="welld_ch" problem="notConfigured" where="preview" />)
    const notice = screen.getByTestId('crm-wizard-letterhead-not-configured')
    expect(notice.textContent).toContain(t.notConfigured.title('wellD CH'))
    expect(notice.textContent).toContain(t.notConfigured.preview)
    const link = screen.getByRole('link', { name: t.open })
    expect(link.getAttribute('href')).toBe('/letterheads?entity=welld_ch')
    expect(notice.textContent).not.toContain(t.askAdmin)
  })

  it('sends everyone else to an administrator and shows no link at all', () => {
    session.apps = ['crm']
    render(<LetterheadNotice entity="welld_it" problem="notConfigured" where="preview" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByTestId('crm-wizard-letterhead-not-configured').textContent).toContain(t.askAdmin)
  })

  it('is a polite status in the pane: announced once, not an alert, not a dialog (AC-10.7)', () => {
    session.apps = ['letterheads']
    render(<LetterheadNotice entity="welld_it" problem="notConfigured" where="preview" />)
    expect(screen.getByRole('status')).toBe(screen.getByTestId('crm-wizard-letterhead-not-configured'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says that no offer was created when it is the answer to Generate, as an alert, with the same link rule', () => {
    session.apps = []
    const { unmount } = render(<LetterheadNotice entity="welld_it" problem="notConfigured" where="generate" />)
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toContain(t.notConfigured.title('wellD IT'))
    expect(notice.textContent).toContain(t.notConfigured.generate)
    expect(notice.textContent).not.toContain(t.notConfigured.preview)
    expect(screen.queryByRole('link')).toBeNull()
    unmount()

    session.apps = ['letterheads']
    render(<LetterheadNotice entity="welld_it" problem="notConfigured" where="generate" />)
    expect(screen.getByRole('link', { name: t.open }).getAttribute('href')).toBe('/letterheads?entity=welld_it')
  })
})

describe('LetterheadNotice — a legal detail does not fit the letterhead (T27, AC-5.3; FU-1, design S10b)', () => {
  it.each([['header' as const], ['footer' as const]])('names the %s and the entity, and is not "profile" any more', (frame) => {
    session.apps = ['letterheads']
    session.manages = ['welld_ch']
    render(<LetterheadNotice entity="welld_ch" problem="overflow" frame={frame} />)
    const notice = screen.getByTestId('crm-wizard-letterhead-overflow')
    expect(notice.textContent).toContain(t.overflow.title('wellD CH', t.overflow[frame]))
    expect(t.overflow.title('wellD CH', t.overflow[frame])).not.toMatch(/profile/i)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toBe(notice)
  })

  // the two gates are independent: managing the entity does not open Letterheads, nor the reverse
  const matrix = [
    { manage: true, open: true, body: 'body', links: ['legal', 'letterheads'] },
    { manage: true, open: false, body: 'bodyValueOnly', links: ['legal'] },
    { manage: false, open: true, body: 'bodyLetterheadOnly', links: ['letterheads'] },
    { manage: false, open: false, body: 'bodyAskAdmin', links: [] },
  ] as const
  it.each(matrix)('manage $manage, open Letterheads $open: $body, links $links', ({ manage, open, body, links }) => {
    session.apps = open ? ['crm', 'letterheads'] : ['crm']
    session.manages = manage ? ['welld_ch'] : ['welld_it']
    render(<LetterheadNotice entity="welld_ch" problem="overflow" frame="footer" />)
    const notice = screen.getByTestId('crm-wizard-letterhead-overflow')
    expect(notice.textContent).toContain(t.overflow[body])
    const found = screen.queryAllByRole('link')
    const legal = screen.queryByRole('link', { name: strings.offerWizard.legalEntity.openNamed('wellD CH') })
    const letterheads = screen.queryByRole('link', { name: t.open })
    expect(found).toHaveLength(links.length)
    expect(legal !== null).toBe(links.includes('legal' as never))
    expect(letterheads !== null).toBe(links.includes('letterheads' as never))
    if (legal) {
      expect(legal.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
      expect(legal.textContent).toBe(strings.offerWizard.legalEntity.open)
    }
    if (letterheads) expect(letterheads.getAttribute('href')).toBe('/letterheads?entity=welld_ch')
    // the legal link comes first when both are there
    if (links.length === 2) expect(found[0]).toBe(legal)
  })

  it('links to the tab of the entity named, not another one', () => {
    session.apps = ['crm']
    session.manages = ['welld_it']
    render(<LetterheadNotice entity="welld_it" problem="overflow" frame="header" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/admin/legal-entities?entity=welld_it')
  })

  it('says the same four bodies in Italian, none of them sending anyone to CRM Settings', () => {
    for (const language of [en, italian]) {
      const o = language.offerWizard.letterhead.overflow
      for (const key of ['body', 'bodyValueOnly', 'bodyLetterheadOnly', 'bodyAskAdmin'] as const) {
        expect(o[key]).not.toMatch(/CRM Settings|Impostazioni CRM/)
        expect(o[key]).toMatch(/Legal entities|Società del gruppo/)
      }
      expect(o.title('X', o.footer)).not.toMatch(/profile|profilo/i)
    }
    expect(italian.offerWizard.letterhead.overflow.bodyAskAdmin).toBe(
      'Chiedi a un amministratore che gestisce la pagina Società del gruppo di accorciare il valore, oppure di modificare la carta intestata in Carte intestate.',
    )
  })

  it.each(matrix)('has no axe violation (manage $manage, open $open)', async ({ manage, open }) => {
    session.apps = open ? ['letterheads'] : []
    session.manages = manage ? ['welld_ch'] : []
    const { container } = render(<LetterheadNotice entity="welld_ch" problem="overflow" frame="footer" />)
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })
})
