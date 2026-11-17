/**
 * @vitest-environment jsdom
 *
 * The copy catalogs (INC-24, INC-25): the Italian catalog is complete, and the
 * language is the one `@operai/ui` resolves for the whole suite — the shell
 * sets `<html lang>`, every catalog read follows it, and admin-ui has no
 * language detection of its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { catalogGaps } from '@operai/ui'
import { en, it as itCatalog } from './strings'

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
  vi.resetModules()
})

describe('strings catalogs', () => {
  it('the Italian catalog has every key of the English one, none empty (catalogGaps)', () => {
    expect(catalogGaps(en, itCatalog)).toEqual([])
  })

  it('the Italian catalog is a translation, not a copy of the English one', () => {
    expect(itCatalog.nav.users).not.toBe(en.nav.users)
    expect(itCatalog.common.actions.cancel).toBe('Annulla')
    expect(itCatalog.users.invite.sent('a@welld.ch')).toBe('Invito inviato a a@welld.ch')
  })

  it('the Legal entities area (AC-8.2) is translated with the spec vocabulary, in both catalogs', () => {
    expect(en.nav.legalEntities).toBe('Legal entities')
    expect(itCatalog.nav.legalEntities).toBe('Società del gruppo')
    expect(itCatalog.legalEntities.page.heading).toBe('Società del gruppo')
    expect(catalogGaps(en.legalEntities, itCatalog.legalEntities)).toEqual([])
    expect(en.legalEntities.entity.version(3, 'Ada', 'today')).toBe('Version 3 · saved by Ada · today')
    expect(itCatalog.legalEntities.entity.version(3, 'Ada', 'oggi')).toBe('Versione 3 · salvata da Ada · oggi')
    expect(en.legalEntities.problem.line('it', 2, 'x')).toBe('Line 2 of the Italian address: x')
    expect(itCatalog.legalEntities.problem.line('en', 2, 'x')).toBe('Riga 2 dell’indirizzo inglese: x')
    expect(en.legalEntities.refused.title(1)).toContain('1 value needs')
    expect(itCatalog.legalEntities.refused.title(2)).toContain('2 valori richiedono')
  })

  it('the Audit description says it also lists legal entity changes (DR-8), in both languages', () => {
    expect(en.audit.description).toContain('legal entity')
    expect(itCatalog.audit.description).toContain('società del gruppo')
  })

  it('selects English under an English document (the test default)', async () => {
    document.documentElement.setAttribute('lang', 'en')
    const { strings } = await import('./strings')
    expect(strings.nav.toolTitle).toBe('Admin')
  })

  it('selects Italian when the shell has set <html lang="it">', async () => {
    document.documentElement.setAttribute('lang', 'it')
    const { strings } = await import('./strings')
    expect(strings.nav.toolTitle).toBe('Amministrazione')
    expect(strings.address.field.postalCode).toBe('CAP')
  })
})

describe('a screen rendered in Italian', () => {
  it('renders the bulk-delete result card entirely from the Italian catalog', async () => {
    document.documentElement.setAttribute('lang', 'it')
    const { default: BulkDeleteResultPanel } = await import('./components/BulkDeleteResultPanel')

    render(
      <BulkDeleteResultPanel
        deletedCount={1}
        totalCount={2}
        skipped={[{ userId: 'u1', label: 'bob@welld.ch', reason: 'last remaining admin' }]}
        onDismiss={() => {}}
      />,
    )

    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Esito dell’eliminazione multipla')
    expect(screen.getByTestId('bulk-delete-result-summary').textContent).toBe('Eliminati 1 di 2 utenti selezionati.')
    expect(screen.getByTestId('bulk-delete-result-skipped-u1').textContent).toBe(
      'bob@welld.ch — saltato: last remaining admin',
    )
    expect(screen.getByRole('button', { name: 'Chiudi' })).not.toBeNull()
  })

  it('renders an invitation status badge in Italian', async () => {
    document.documentElement.setAttribute('lang', 'it')
    const { default: InvitationStatusBadge } = await import('./components/InvitationStatusBadge')

    render(<InvitationStatusBadge status="pending" />)

    expect(screen.getByTestId('invitation-status-badge').textContent).toBe('In attesa')
  })
})
