/**
 * @vitest-environment jsdom
 *
 * The protected-change dialogs in Italian (T60; AC-9.6, AC-8.2): every word of the save confirmation and of the
 * restore dialog's protected block comes from the Italian catalog, and axe finds nothing. The language is the one the
 * shell sets on `<html lang>`, read when the catalog module loads, hence the late imports.
 */
import axe from 'axe-core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return { ...original, getVersion: vi.fn(), restoreVersion: vi.fn() }
})

beforeAll(() => {
  document.documentElement.setAttribute('lang', 'it')
})
afterEach(() => {
  cleanup()
})

const axeIds = async (container: Element) =>
  (await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map(
    (v) => v.id,
  )

describe('in Italian', () => {
  it('shows the save confirmation entirely in Italian, Cancel focused, with no axe violation', async () => {
    const { default: ProtectedChangeDialog } = await import('./ProtectedChangeDialog')
    render(
      <ProtectedChangeDialog
        entityName="WellD CH"
        changes={[
          { field: 'vatNumber', before: '', after: 'CHE-123.456.788 MWST' },
          { field: 'iban', before: 'CH93 0076 2011 6238 5295 7', after: '' },
        ]}
        nextVersion={8}
        busy={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    )
    const box = screen.getByRole('alertdialog')
    expect(within(box).getByRole('heading', { name: 'Salvare queste modifiche a WellD CH?' })).toBeTruthy()
    expect(within(box).getByRole('list', { name: 'Dati che cambiano' })).toBeTruthy()
    expect(within(box).getAllByRole('term').map((el) => el.textContent)).toEqual(['Precedente', 'Nuovo', 'Precedente', 'Nuovo'])
    expect(within(box).getAllByRole('definition').map((el) => el.textContent)).toEqual([
      'Nessun valore',
      'CHE-123.456.788 MWST',
      'CH93 0076 2011 6238 5295 7',
      'Nessun valore',
    ])
    expect(within(box).getByText('Salva come versione 8')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-protected-cancel'))
    expect(screen.getByTestId('admin-legal-protected-cancel').textContent).toBe('Annulla')
    expect(box.textContent).toContain('Dopo il salvataggio, le altre persone che gestiscono WellD CH e gli amministratori vengono informati della modifica.')
    expect(await axeIds(document.body)).toEqual([])
  })

  it('shows the busy save confirmation in Italian', async () => {
    const { default: ProtectedChangeDialog } = await import('./ProtectedChangeDialog')
    render(
      <ProtectedChangeDialog
        entityName="WellD CH"
        changes={[{ field: 'iban', before: '', after: 'CH93 0076 2011 6238 5295 7' }]}
        nextVersion={8}
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    )
    expect(screen.getByTestId('admin-legal-protected-confirm').textContent).toBe('Salvataggio…')
    expect(await axeIds(document.body)).toEqual([])
  })

  it('shows the restore dialog’s protected block, its reading and failed states and the 429 in Italian', async () => {
    const { default: RestoreDialog } = await import('./RestoreDialog')
    const { entityFixture } = await import('../pages/LegalEntitiesPage.fixtures')
    const { getVersion, restoreVersion, LegalEntityApiError } = await import('../lib/legalEntitiesApi')
    const current = entityFixture('welld_ch', { version: 8, iban: 'CH9300762011623852957', ibanPrint: 'CH93 0076 2011 6238 5295 7' })
    const target = {
      ...current,
      version: 3,
      iban: 'DE89370400440532013000',
      ibanPrint: 'DE89 3704 0044 0532 0130 00',
      action: 'save' as const,
      restoredFrom: null,
      createdBy: null,
      createdAt: '2026-11-01T10:00:00.000Z',
    }
    const base = { entity: current, version: 3, baseVersion: 8, onRestored: () => undefined, onConflict: () => undefined, onLost: () => undefined, onCancel: () => undefined }

    // The block.
    vi.mocked(restoreVersion).mockRejectedValue(
      new LegalEntityApiError({ type: 'x', title: 'x', status: 429, code: 'too_many_requests' }, { retryAfterSeconds: 150 }),
    )
    const first = render(<RestoreDialog {...base} target={target} />)
    const box = screen.getByRole('alertdialog')
    expect(box.textContent).toContain('Questo ripristino modifica dati che vengono stampati su ogni offerta e contratto.')
    expect(box.textContent).toContain('Precedente è la versione corrente (8). Nuovo è la versione 3.')
    expect(within(box).getAllByRole('term').map((el) => el.textContent)).toEqual(['Precedente', 'Nuovo'])
    expect(await axeIds(document.body)).toEqual([])

    // The 429.
    screen.getByTestId('admin-legal-restore-confirm').click()
    const warning = await screen.findByTestId('admin-legal-restore-too-many')
    expect(warning.textContent).toBe('Troppe modifiche in poco tempo. Non è stato ripristinato nulla. Aspetta circa 3 minuti, poi riprova.')
    expect(await axeIds(document.body)).toEqual([])
    first.unmount()

    // Reading, then failed.
    vi.mocked(getVersion).mockReturnValue(new Promise(() => undefined))
    const second = render(<RestoreDialog {...base} />)
    expect(screen.getByText('Caricamento dei dati della versione 3…')).toBeTruthy()
    expect(await axeIds(document.body)).toEqual([])
    second.unmount()

    vi.mocked(getVersion).mockReset().mockRejectedValue(new TypeError('Failed to fetch'))
    render(<RestoreDialog {...base} />)
    const failed = await screen.findByTestId('admin-legal-restore-details-failed')
    expect(failed.textContent).toContain('Non è stato possibile leggere i dati della versione 3, quindi il ripristino non si può verificare.')
    expect(within(failed).getByRole('button', { name: 'Riprova' })).toBeTruthy()
    expect(await axeIds(document.body)).toEqual([])
  })

  it('shows the check-failed and too-many-saves banners in Italian', async () => {
    const { default: LegalEntityForm } = await import('./LegalEntityForm')
    const { entityFixture } = await import('../pages/LegalEntitiesPage.fixtures')
    const api = await import('../lib/legalEntitiesApi')
    const userEvent = (await import('@testing-library/user-event')).default
    const checkSpy = vi.spyOn(api, 'checkLegalEntity').mockRejectedValue(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    render(
      <LegalEntityForm
        entity={entityFixture('welld_ch')}
        draft={{ ...entityFixture('welld_ch'), legalName: 'wellD AG Group' }}
        onDraftChange={() => undefined}
        onEntityChange={() => undefined}
        onLost={() => undefined}
      />,
    )
    await user.click(screen.getByTestId('admin-legal-save'))
    const banner = await screen.findByTestId('admin-legal-check-failed')
    expect(banner.textContent).toContain('Non è stato possibile verificare le modifiche')
    expect(await axeIds(document.body)).toEqual([])

    checkSpy.mockRejectedValue(
      new api.LegalEntityApiError({ type: 'x', title: 'x', status: 429, code: 'too_many_requests' }, { retryAfterSeconds: 61 }),
    )
    await user.click(within(banner).getByRole('button', { name: 'Riprova' }))
    const tooMany = await screen.findByTestId('admin-legal-too-many')
    expect(tooMany.textContent).toContain('Troppi salvataggi in poco tempo')
    expect(tooMany.textContent).toContain('Aspetta circa 2 minuti, poi riprova.')
    expect(await axeIds(document.body)).toEqual([])
    checkSpy.mockRestore()
  })
})
