/**
 * @vitest-environment jsdom
 *
 * RestoreDialog — the protected block, the reading state (Confirm aria-disabled with its reason) and the 429 (T60, specs/20261117-legal-entities, design S7
 * additions and flow F16; AC-9.4, 9.6, 9.17, 8.1). The T39 behaviour (what it makes, the refusals, the conflict, busy)
 * is covered by `LegalEntityHistory.test.tsx` with the real page around the dialog; this file is the dialog alone.
 */
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RestoreDialog from './RestoreDialog'
import type { RestoreDialogProps } from './RestoreDialog'
import { LegalEntityApiError, getVersion, restoreVersion } from '../lib/legalEntitiesApi'
import { entityFixture } from '../pages/LegalEntitiesPage.fixtures'
import type { LegalEntity, LegalEntityVersion } from '../lib/legalEntityModel'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return { ...original, getVersion: vi.fn(), restoreVersion: vi.fn() }
})

/** The version in effect: 8, with an IBAN, a VAT number and an Italian contacts line. */
const CURRENT: LegalEntity = entityFixture('welld_ch', {
  version: 8,
  legalName: 'wellD AG',
  vatNumber: 'CHE-123.456.788 MWST',
  iban: 'CH9300762011623852957',
  ibanPrint: 'CH93 0076 2011 6238 5295 7',
  contacts: { it: 'Tel. 1', en: '' },
})

const versionOf = (over: Partial<LegalEntity>, n = 3): LegalEntityVersion => ({
  ...CURRENT,
  ...over,
  version: n,
  action: 'save',
  restoredFrom: null,
  createdBy: { id: 'u1', name: 'Anna Rossi' },
  createdAt: '2026-11-01T10:00:00.000Z',
})

/** Version 3 differs in the IBAN and the Italian contacts line: one protected detail. */
const OLDER = versionOf({
  iban: 'DE89370400440532013000',
  ibanPrint: 'DE89 3704 0044 0532 0130 00',
  contacts: { it: 'Tel. 2', en: '' },
})

const props = (over: Partial<RestoreDialogProps> = {}): RestoreDialogProps => ({
  entity: CURRENT,
  version: 3,
  target: OLDER,
  baseVersion: 8,
  onRestored: vi.fn(),
  onConflict: vi.fn(),
  onLost: vi.fn(),
  onCancel: vi.fn(),
  ...over,
})

const show = (over: Partial<RestoreDialogProps> = {}) => {
  const p = props(over)
  const view = render(<RestoreDialog {...p} />)
  return { p, user: userEvent.setup(), ...view }
}

const confirm = () => screen.getByTestId('admin-legal-restore-confirm') as HTMLButtonElement
const description = (box: HTMLElement) => document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent ?? ''

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

const refusal = (status: number, extras: ConstructorParameters<typeof LegalEntityApiError>[1] = {}) =>
  new LegalEntityApiError({ type: 'x', title: 'x', status, code: status === 429 ? 'too_many_requests' : 'x' }, extras)

beforeEach(() => {
  vi.mocked(getVersion).mockReset()
  vi.mocked(restoreVersion).mockReset()
})
afterEach(cleanup)

describe('the protected block (AC-9.4)', () => {
  it('lists each protected detail that differs, Old = the current version and New = version n, with the legend and who is told', async () => {
    show()
    const box = await screen.findByRole('alertdialog')

    const block = within(box).getByTestId('admin-legal-restore-protected')
    expect(block.textContent).toContain(
      'This restore changes details that are printed on every offer and contract. Once restored, the other people who manage WellD CH and the administrators are told of it.',
    )
    expect(block.textContent).toContain('Old is the current version (8). New is version 3.')
    const rows = within(block).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.querySelector('div')?.textContent).toBe('IBAN')
    expect(within(rows[0] as HTMLElement).getAllByRole('term').map((el) => el.textContent)).toEqual(['Old', 'New'])
    expect(within(rows[0] as HTMLElement).getAllByRole('definition').map((el) => el.textContent)).toEqual([
      'CH93 0076 2011 6238 5295 7',
      'DE89 3704 0044 0532 0130 00',
    ])
    // The change line still names every value that changes, protected or not.
    expect(screen.getByTestId('admin-legal-restore-changes').textContent).toBe(
      'Compared with the current version, these change: IBAN, Contacts line (Italian).',
    )
  })

  it('announces the block with the dialog (it is inside the described content) and puts focus on Cancel', async () => {
    show()
    const box = await screen.findByRole('alertdialog')
    const text = description(box)
    for (const word of ['Old is the current version (8)', 'Old', 'New', 'CH93 0076 2011 6238 5295 7', 'DE89 3704 0044 0532 0130 00'])
      expect(text).toContain(word)
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-restore-cancel'))
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('lists legal name, VAT number and IBAN in the closed order, and says None for an empty side', async () => {
    show({
      entity: { ...CURRENT, legalName: '', vatNumber: '' },
      target: versionOf({ legalName: 'wellD SA', vatNumber: 'CHE-000.000.000' }),
    })
    const box = await screen.findByRole('alertdialog')
    const rows = within(box).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('div')?.textContent)).toEqual(['Legal name', 'VAT number'])
    expect(within(rows[0] as HTMLElement).getAllByRole('definition').map((el) => el.textContent)).toEqual([
      'None',
      'wellD SA',
    ])
  })

  it('lists none and adds no block when no protected detail differs (an address or contacts change only)', async () => {
    show({ target: versionOf({ contacts: { it: 'Tel. 2', en: '' }, address: { it: ['Altro'], en: ['Other'] } }) })
    const box = await screen.findByRole('alertdialog')

    expect(within(box).queryByTestId('admin-legal-restore-protected')).toBeNull()
    expect(within(box).queryByRole('list')).toBeNull()
    expect(screen.getByTestId('admin-legal-restore-changes').textContent).toBe(
      'Compared with the current version, these change: Address (Italian), Address (English), Contacts line (Italian).',
    )
  })

  it('lists none when the IBAN differs only in case or spacing (as a save would not ask either)', async () => {
    show({ target: versionOf({ iban: 'ch93 0076 2011 6238 5295 7', ibanPrint: 'ch93 0076 2011 6238 5295 7' }) })
    const box = await screen.findByRole('alertdialog')
    expect(within(box).queryByTestId('admin-legal-restore-protected')).toBeNull()
  })

  it('is the dialog it was when the two versions are the same (no change line, no block)', async () => {
    show({ target: versionOf({}) })
    const box = await screen.findByRole('alertdialog')
    expect(within(box).queryByTestId('admin-legal-restore-protected')).toBeNull()
    expect(screen.queryByTestId('admin-legal-restore-changes')).toBeNull()
  })

  it('restores nothing on Cancel, Escape or the close control', async () => {
    const { p, user } = show()
    await screen.findByRole('alertdialog')
    await user.click(screen.getByTestId('admin-legal-restore-cancel'))
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('admin-legal-restore-close'))
    expect(p.onCancel).toHaveBeenCalledTimes(3)
    expect(restoreVersion).not.toHaveBeenCalled()
  })
})

describe('the dialog opens at once when it holds both versions, and reads what it lacks (AC-9.4)', () => {
  it('opens as the confirmation on the first render when it was handed version n and the entity is the current one', () => {
    show()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(getVersion).not.toHaveBeenCalled()
  })

  it('reads version n when the page does not hold it: the confirmation with Confirm aria-disabled and described by the loading sentence, then available', async () => {
    let settle: (value: LegalEntityVersion) => void = () => undefined
    vi.mocked(getVersion).mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const { user, p } = show({ target: undefined })

    expect(getVersion).toHaveBeenCalledWith('welld_ch', 3)
    const box = screen.getByRole('alertdialog')
    expect(within(box).getByRole('heading', { name: 'Restore version 3?' })).toBeTruthy()
    expect(box.textContent).toContain('This creates version 9 with the same details as version 3')
    // The hidden live sentence of the skeleton, and the same sentence as Confirm's description.
    expect(within(box).getAllByText('Loading the details of version 3…')).toHaveLength(2)
    expect(confirm().getAttribute('aria-disabled')).toBe('true')
    expect(confirm().disabled).toBe(false)
    expect(description(confirm())).toBe('Loading the details of version 3…')
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-restore-cancel'))
    expect(await axeViolations(document.body)).toEqual([])

    // Confirm is still a focus stop (Tab from Cancel), and a press does nothing yet.
    await user.tab()
    expect(document.activeElement).toBe(confirm())
    await user.keyboard('{Enter}')
    await user.click(confirm())
    expect(restoreVersion).not.toHaveBeenCalled()

    settle(OLDER)
    expect(await within(box).findByTestId('admin-legal-restore-protected')).toBeTruthy()
    expect(confirm().textContent).toBe('Restore version 3')
    expect(confirm().hasAttribute('aria-disabled')).toBe(false)
    expect(confirm().hasAttribute('aria-describedby')).toBe(false)
    await user.click(screen.getByTestId('admin-legal-restore-cancel'))
    expect(p.onCancel).toHaveBeenCalledTimes(1)
  })

  it('can be cancelled while it reads, and restores nothing', async () => {
    vi.mocked(getVersion).mockReturnValue(new Promise(() => undefined))
    const { user, p } = show({ target: undefined })
    await user.click(screen.getByTestId('admin-legal-restore-cancel'))
    expect(p.onCancel).toHaveBeenCalledTimes(1)
    expect(restoreVersion).not.toHaveBeenCalled()
  })

  it('reads the version in effect too when the entity the page holds is not it', async () => {
    vi.mocked(getVersion).mockImplementation(async (_entity, n) => (n === 9 ? versionOf({ legalName: 'wellD Group' }, 9) : OLDER))
    show({ baseVersion: 9 })
    const box = await screen.findByRole('alertdialog')
    expect(getVersion).toHaveBeenCalledWith('welld_ch', 9)
    expect(box.textContent).toContain('This creates version 10')
    expect(within(box).getAllByRole('listitem').map((row) => row.querySelector('div')?.textContent)).toContain('Legal name')
  })

  it('cannot be confirmed when the details cannot be read: a warning with Retry, Confirm aria-disabled with the same reason, nothing restored', async () => {
    vi.mocked(getVersion).mockRejectedValue(new TypeError('Failed to fetch'))
    const { user } = show({ target: undefined })

    const warning = await screen.findByTestId('admin-legal-restore-details-failed')
    const sentence =
      'The details of version 3 could not be read, so the restore cannot be checked. Nothing was restored. Try again.'
    expect(warning.textContent).toContain(sentence)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(confirm().getAttribute('aria-disabled')).toBe('true')
    expect(description(confirm())).toBe(sentence)
    await user.click(confirm())
    expect(restoreVersion).not.toHaveBeenCalled()
    expect(await axeViolations(document.body)).toEqual([])

    // Retry reads again, focus lands on Cancel (the Retry button goes with the warning); when it works Confirm is available.
    vi.mocked(getVersion).mockReset().mockResolvedValue(OLDER)
    await user.click(screen.getByTestId('admin-legal-restore-retry'))
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-restore-cancel'))
    await waitFor(() => expect(confirm().hasAttribute('aria-disabled')).toBe(false))
    expect(getVersion).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('admin-legal-restore-protected')).toBeTruthy()
  })

  it('can be cancelled with Escape or the close control after a failed read', async () => {
    vi.mocked(getVersion).mockRejectedValue(new TypeError('Failed to fetch'))
    const { user, p } = show({ target: undefined })
    await screen.findByTestId('admin-legal-restore-details-failed')
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('admin-legal-restore-close'))
    expect(p.onCancel).toHaveBeenCalledTimes(2)
    expect(restoreVersion).not.toHaveBeenCalled()
  })

  it('goes back to reading, with Retry and Confirm aria-disabled, when the re-read after a 409 fails (the conflict message stays)', async () => {
    vi.mocked(restoreVersion).mockRejectedValue(
      new LegalEntityApiError({ type: 'x', title: 'c', status: 409, code: 'version_conflict' }, { currentVersion: 9 }),
    )
    vi.mocked(getVersion).mockRejectedValue(new TypeError('Failed to fetch'))
    const { user, p } = show()
    await user.click(confirm())

    expect(await screen.findByTestId('admin-legal-restore-details-failed')).toBeTruthy()
    expect(p.onConflict).toHaveBeenCalledTimes(1)
    expect(confirm().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('admin-legal-restore-error').textContent).toContain('A newer version was saved meanwhile')
    // Nothing of the old pair is listed.
    expect(screen.queryByTestId('admin-legal-restore-protected')).toBeNull()
    expect(screen.queryByTestId('admin-legal-restore-changes')).toBeNull()
    await user.click(confirm())
    expect(restoreVersion).toHaveBeenCalledTimes(1)
  })

  it('keeps Cancel working while the re-read after a 409 is in flight, with Confirm aria-disabled and no stale list', async () => {
    vi.mocked(restoreVersion).mockRejectedValue(
      new LegalEntityApiError({ type: 'x', title: 'c', status: 409, code: 'version_conflict' }, { currentVersion: 9 }),
    )
    vi.mocked(getVersion).mockReturnValue(new Promise(() => undefined))
    const { user, p } = show()
    await user.click(confirm())

    await waitFor(() => expect(confirm().getAttribute('aria-disabled')).toBe('true'))
    expect(description(confirm())).toBe('Loading the details of version 3…')
    expect(screen.queryByTestId('admin-legal-restore-protected')).toBeNull()
    expect((screen.getByTestId('admin-legal-restore-cancel') as HTMLButtonElement).disabled).toBe(false)
    await user.click(screen.getByTestId('admin-legal-restore-cancel'))
    expect(p.onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('layout (320 px)', () => {
  it('is the wide dialog whose body scrolls and whose footer is outside the scroll', async () => {
    show()
    const box = await screen.findByRole('alertdialog')
    expect(box.className).toContain('dialog-wide')
    expect(box.className).toContain('dialog-scroll')
    const scroll = screen.getByTestId('admin-legal-restore-scroll')
    expect(scroll.contains(screen.getByTestId('admin-legal-restore-protected'))).toBe(true)
    expect(scroll.contains(confirm())).toBe(false)
    expect(scroll.contains(screen.getByTestId('admin-legal-restore-cancel'))).toBe(false)
  })
})

describe('429 too many changes (S7)', () => {
  it.each([
    [150, 'Too many changes in a short time. Nothing was restored. Wait about 3 minutes, then try again.'],
    [30, 'Too many changes in a short time. Nothing was restored. Wait about 1 minute, then try again.'],
    [undefined, 'Too many changes in a short time. Nothing was restored. Wait a few minutes, then try again.'],
  ])('says it inline (Retry-After %s) and keeps Confirm available and the dialog open', async (seconds, sentence) => {
    vi.mocked(restoreVersion).mockRejectedValueOnce(refusal(429, { retryAfterSeconds: seconds }))
    vi.mocked(restoreVersion).mockResolvedValueOnce({ version: 9, created: true, entity: { ...CURRENT, version: 9 } })
    const { user, p } = show()
    const box = await screen.findByRole('alertdialog')
    await user.click(confirm())

    const warning = await within(box).findByTestId('admin-legal-restore-too-many')
    expect(warning.textContent).toBe(sentence)
    expect(screen.getByRole('alertdialog')).toBe(box)
    expect(confirm().disabled).toBe(false)
    expect(within(box).getByTestId('admin-legal-restore-protected')).toBeTruthy()
    expect(await axeViolations(document.body)).toEqual([])

    // After the wait the person tries again, and the warning goes.
    await user.click(confirm())
    await waitFor(() => expect(p.onRestored).toHaveBeenCalledTimes(1))
    expect(restoreVersion).toHaveBeenCalledTimes(2)
  })
})
