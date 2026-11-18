/**
 * @vitest-environment jsdom
 *
 * Save asks the read-only check first and confirms a protected change (T60, specs/20261117-legal-entities, design S12,
 * flow F15; AC-9.1 to 9.6, 9.17, 8.1): "Checking…" while it runs, no dialog when nothing protected changes, the dialog
 * with the check's Old / New values and Cancel focused, Cancel / Escape / close sending nothing and returning to Save,
 * Confirm sending ONE save with the checked body, every outcome of that save and of the check taking the existing
 * states, a confirmation never remembered, and the 429 state.
 */
import axe from 'axe-core'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LegalEntityForm from './LegalEntityForm'
import { accessibleDescription } from './ProtectedChangeList.testkit'
import { LegalEntityApiError, checkLegalEntity, getVersion, saveLegalEntity } from '../lib/legalEntitiesApi'
import type { ProtectedChange, SaveCheck, SaveResult } from '../lib/legalEntitiesApi'
import { entityFixture } from '../pages/LegalEntitiesPage.fixtures'
import type { LegalEntity, LegalEntityDetails } from '../lib/legalEntityModel'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return { ...original, saveLegalEntity: vi.fn(), checkLegalEntity: vi.fn(), getVersion: vi.fn() }
})

const save = vi.mocked(saveLegalEntity)
const check = vi.mocked(checkLegalEntity)

const answer = (protectedChanges: ProtectedChange[] = [], outcome: SaveCheck['outcome'] = 'change'): SaveCheck => ({
  baseVersion: 3,
  outcome,
  changedFields: [],
  protectedChanges,
})

const IBAN_CHANGE: ProtectedChange = {
  field: 'iban',
  before: 'IT60 X054 2811 1010 0000 0123 456',
  after: 'CH93 0076 2011 6238 5295 7',
}
const VAT_FILLED: ProtectedChange = { field: 'vatNumber', before: '', after: 'CHE-123.456.788 MWST' }
const IBAN_REMOVED: ProtectedChange = { field: 'iban', before: 'CH93 0076 2011 6238 5295 7', after: '' }

const problemError = (status: number, code: string, extras: ConstructorParameters<typeof LegalEntityApiError>[1] = {}) =>
  new LegalEntityApiError({ type: 'about:blank', title: code, status, code }, extras)

type Spies = { onLost: Mock<() => void>; entities: LegalEntity[] }

/** What the test can do to the page's entity from outside: set by `Host` once it is mounted. */
const page: { setEntity?: (entity: LegalEntity) => void } = {}

function Host({ initial, spies }: { initial: LegalEntity; spies: Spies }) {
  const [entity, setEntity] = useState(initial)
  const [draft, setDraft] = useState<LegalEntityDetails | undefined>(undefined)
  useEffect(() => {
    page.setEntity = setEntity
  }, [])
  return (
    <LegalEntityForm
      entity={entity}
      draft={draft}
      onDraftChange={setDraft}
      onEntityChange={(next) => {
        spies.entities.push(next)
        setEntity(next)
      }}
      onLost={() => spies.onLost()}
    />
  )
}

const open = (entity: LegalEntity = entityFixture('welld_ch')) => {
  const spies: Spies = { onLost: vi.fn(), entities: [] }
  const view = render(<Host initial={entity} spies={spies} />)
  return { spies, user: userEvent.setup(), ...view }
}

const saveButton = () => screen.getByTestId('admin-legal-save') as HTMLButtonElement
const input = (name: RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement
const dialog = () => screen.getByRole('alertdialog')
const dialogDescription = () =>
  document.getElementById(dialog().getAttribute('aria-describedby') ?? '')?.textContent ?? ''
const saved = (version = 4): SaveResult => ({
  version,
  created: true,
  entity: entityFixture('welld_ch', { version }),
})

/** Edit the IBAN (a protected detail) and press Save: the check answers `changes`. */
async function pressSave(
  user: ReturnType<typeof userEvent.setup>,
  changes: ProtectedChange[] = [IBAN_CHANGE],
) {
  check.mockResolvedValue(answer(changes))
  await user.clear(input(/^IBAN/))
  await user.type(input(/^IBAN/), 'CH93 0076 2011 6238 5295 7')
  await user.click(saveButton())
}

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

beforeEach(() => {
  save.mockReset()
  check.mockReset().mockResolvedValue(answer())
  vi.mocked(getVersion).mockReset().mockRejectedValue(new TypeError('Failed to fetch'))
})
afterEach(cleanup)

describe('Save checks first (S2 state 11)', () => {
  it('sends the checked body: exactly the save body, with the version it was read at', async () => {
    save.mockResolvedValue(saved())
    const { user } = open()
    await user.type(input(/^Legal name/), ' Group')
    await user.click(saveButton())

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(check).toHaveBeenCalledTimes(1)
    expect(check.mock.calls[0]).toEqual(save.mock.calls[0])
    expect(check.mock.calls[0]?.[1].baseVersion).toBe(3)
  })

  it('shows "Checking…" on Save and in the bar while the check runs, with every control still enabled, and asks once', async () => {
    let settle: (value: SaveCheck) => void = () => undefined
    check.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    save.mockResolvedValue(saved())
    const { user } = open()
    await user.type(input(/^Legal name/), ' Group')

    await user.click(saveButton())
    expect(saveButton().textContent).toBe('Checking…')
    expect(saveButton().getAttribute('aria-busy')).toBe('true')
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('admin-legal-status').textContent).toBe('Checking…')
    expect(input(/^Legal name/).disabled).toBe(false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await user.click(saveButton())
    expect(check).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()

    await act(async () => settle(answer()))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  })
})

describe('no protected change: no dialog (AC-9.5, 9.17)', () => {
  it.each([
    ['an address or contacts change', answer([])],
    ['an IBAN typed with other spacing or case only', answer([])],
    ['a save that would change nothing (outcome same)', answer([], 'same')],
  ])('sends the save at once for %s', async (_name, checked) => {
    check.mockResolvedValue(checked)
    save.mockResolvedValue(saved())
    const { user } = open()
    await user.type(input(/^Contacts line \(English\)/), 'Tel. 1')
    await user.click(saveButton())

    expect(await screen.findByTestId('admin-legal-saved')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('the confirmation (S12, AC-9.1, 9.6)', () => {
  it('opens with the entity, only the changing details, Old and New words, None and the IBAN as the check answered it', async () => {
    const { user } = open()
    await pressSave(user, [VAT_FILLED, IBAN_REMOVED])

    const box = await screen.findByRole('alertdialog')
    expect(within(box).getByRole('heading', { name: 'Save these changes to WellD CH?' })).toBeTruthy()
    const rows = within(box).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('div')?.textContent)).toEqual(['VAT number', 'IBAN'])
    const [vat, iban] = rows
    expect(within(vat as HTMLElement).getAllByRole('term').map((el) => el.textContent)).toEqual(['Old', 'New'])
    expect(within(vat as HTMLElement).getAllByRole('definition').map((el) => el.textContent)).toEqual([
      'None',
      'CHE-123.456.788 MWST',
    ])
    expect(within(iban as HTMLElement).getAllByRole('definition').map((el) => el.textContent)).toEqual([
      'CH93 0076 2011 6238 5295 7',
      'None',
    ])
    expect(within(box).getByText('Save as version 4')).toBeTruthy()
    // Nothing is sent, and there is no acknowledge checkbox.
    expect(save).not.toHaveBeenCalled()
    expect(within(box).queryByRole('checkbox')).toBeNull()
  })

  it('puts focus on Cancel', async () => {
    const { user } = open()
    await pressSave(user)
    await screen.findByRole('alertdialog')
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-protected-cancel'))
    expect(screen.getByTestId('admin-legal-protected-cancel').textContent).toBe('Cancel')
  })

  it('has an accessible description that covers the intro, the whole list with every Old and New value, and the note', async () => {
    const { user } = open()
    await pressSave(user, [
      { field: 'legalName', before: 'wellD AG', after: 'wellD SA' },
      VAT_FILLED,
      IBAN_CHANGE,
    ])
    const box = await screen.findByRole('alertdialog')

    const description = dialogDescription()
    expect(box.getAttribute('aria-describedby')).not.toBeNull()
    expect(description).toContain('You are changing details that are printed on every offer and contract.')
    for (const word of ['Legal name', 'VAT number', 'IBAN', 'Old', 'New', 'None']) expect(description).toContain(word)
    for (const value of ['wellD AG', 'wellD SA', 'CHE-123.456.788 MWST', 'IT60 X054 2811 1010 0000 0123 456', 'CH93 0076 2011 6238 5295 7'])
      expect(description).toContain(value)
    expect(description).toContain('the other people who manage WellD CH and the administrators are told of this change.')
    // The title names it (aria-labelledby), so the entity is read on opening.
    expect(document.getElementById(box.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Save these changes to WellD CH?',
    )
    // The list is a real list; its words are content (not an aria-label, which would replace the items, D3).
    expect(within(box).getByRole('list')).toBeTruthy()
    expect(description).toContain('Details that change')
  })

  it('has an accessible description, as accname computes it, holding each detail with its Old and New values (D-T68-2)', async () => {
    const { user } = open()
    await pressSave(user, [{ field: 'legalName', before: 'wellD AG', after: 'wellD SA' }, VAT_FILLED, IBAN_CHANGE])
    const description = accessibleDescription(await screen.findByRole('alertdialog'))
    for (const value of [
      'Legal name',
      'Old',
      'New',
      'wellD AG',
      'wellD SA',
      'None',
      'CHE-123.456.788 MWST',
      'IT60 X054 2811 1010 0000 0123 456',
      'CH93 0076 2011 6238 5295 7',
    ])
      expect(description).toContain(value)
  })

  it('has no accessibility violations open and busy', async () => {
    let settle: (value: SaveResult) => void = () => undefined
    save.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const { user, container } = open()
    await pressSave(user, [VAT_FILLED, IBAN_REMOVED])
    await screen.findByRole('alertdialog')
    expect(await axeViolations(document.body)).toEqual([])

    await user.click(screen.getByTestId('admin-legal-protected-confirm'))
    expect(screen.getByTestId('admin-legal-protected-confirm').textContent).toBe('Saving…')
    expect(await axeViolations(document.body)).toEqual([])
    expect(await axeViolations(container)).toEqual([])
    await act(async () => settle(saved()))
  })
})

describe('cancelling (AC-9.2)', () => {
  const cancelWays: [string, (user: ReturnType<typeof userEvent.setup>) => Promise<void>][] = [
    ['Cancel', (user) => user.click(screen.getByTestId('admin-legal-protected-cancel'))],
    ['Escape', (user) => user.keyboard('{Escape}')],
    ['the close control', (user) => user.click(screen.getByTestId('admin-legal-protected-close'))],
  ]

  it.each(cancelWays)('%s sends nothing, keeps every typed value and returns focus to Save', async (_name, cancel) => {
    const { user } = open()
    await pressSave(user)
    await screen.findByRole('alertdialog')

    await cancel(user)

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(save).not.toHaveBeenCalled()
    expect(input(/^IBAN/).value).toBe('CH93 0076 2011 6238 5295 7')
    expect(document.activeElement).toBe(saveButton())
    // No message: the person cancelled.
    expect(screen.queryByTestId('admin-legal-save-failed')).toBeNull()
    expect(screen.queryByTestId('admin-legal-saved')).toBeNull()
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()
  })

  it('keeps Tab inside the dialog', async () => {
    const { user } = open()
    await pressSave(user)
    await screen.findByRole('alertdialog')
    await user.tab()
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-protected-confirm'))
    await user.tab()
    expect(dialog().contains(document.activeElement)).toBe(true)
    await user.tab({ shift: true })
    expect(dialog().contains(document.activeElement)).toBe(true)
  })
})

describe('confirming (AC-9.3)', () => {
  it('sends ONE save with the checked body, is busy and not dismissible until the answer, then shows it saved', async () => {
    let settle: (value: SaveResult) => void = () => undefined
    save.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const { user } = open()
    await pressSave(user)
    await screen.findByRole('alertdialog')
    const checked = check.mock.calls[0]?.[1]

    await user.click(screen.getByTestId('admin-legal-protected-confirm'))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]?.[1]).toEqual(checked)
    expect(screen.getByTestId('admin-legal-protected-confirm').textContent).toBe('Saving…')
    expect((screen.getByTestId('admin-legal-protected-cancel') as HTMLButtonElement).disabled).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBe(dialog())
    expect(save).toHaveBeenCalledTimes(1)

    await act(async () => settle(saved()))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect((await screen.findByTestId('admin-legal-saved')).textContent).toBe(
      'Version 4 saved. Every tool uses it within a minute.',
    )
    expect(document.activeElement).toBe(saveButton())
  })

  it('never remembers: after a saved version, the next Save checks again', async () => {
    save.mockResolvedValue(saved())
    const { user } = open()
    await pressSave(user)
    await user.click(await screen.findByTestId('admin-legal-protected-confirm'))
    await screen.findByTestId('admin-legal-saved')

    check.mockResolvedValue(answer([IBAN_REMOVED]))
    await user.clear(input(/^IBAN/))
    await user.click(saveButton())

    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(check).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('takes the 200 "nothing changed" answer as before', async () => {
    save.mockResolvedValue({ version: 3, created: false, entity: entityFixture('welld_ch') })
    const { user } = open()
    await pressSave(user)
    await user.click(await screen.findByTestId('admin-legal-protected-confirm'))
    expect((await screen.findByTestId('admin-legal-noop')).textContent).toContain('Nothing changed.')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a 422 after Confirm: the refusal summary and the first refused control; the next Save checks and asks again', async () => {
    save.mockRejectedValueOnce(
      problemError(422, 'invalid_legal_entity', { problems: [{ field: 'iban', reason: 'iban_check_digits' }] }),
    )
    const { user } = open()
    await pressSave(user)
    await user.click(await screen.findByTestId('admin-legal-protected-confirm'))

    expect(await screen.findByTestId('admin-legal-summary')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(input(/^IBAN/))
    await user.type(input(/^IBAN/), ' ')
    await user.click(saveButton())
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('a 409 after Confirm: the conflict banner, no dialog, and the next Save checks again', async () => {
    save.mockRejectedValueOnce(problemError(409, 'version_conflict', { currentVersion: 4 }))
    vi.mocked(getVersion).mockResolvedValue({
      ...entityFixture('welld_ch', { version: 4 }),
      action: 'save',
      restoredFrom: null,
      createdBy: { id: 'u2', name: 'Marco Bianchi' },
      createdAt: '2026-11-14T10:03:00.000Z',
    })
    const { user } = open()
    await pressSave(user)
    await user.click(await screen.findByTestId('admin-legal-protected-confirm'))

    expect(await screen.findByText('A newer version was saved')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a 403 after Confirm: the page is told, no dialog', async () => {
    save.mockRejectedValueOnce(problemError(403, 'forbidden'))
    const { user, spies } = open()
    await pressSave(user)
    await user.click(await screen.findByTestId('admin-legal-protected-confirm'))

    await waitFor(() => expect(spies.onLost).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a 5xx after Confirm: "could not be saved" with Retry; Retry checks again and asks again', async () => {
    save.mockRejectedValueOnce(problemError(500, 'boom'))
    const { user } = open()
    await pressSave(user)
    await user.click(await screen.findByTestId('admin-legal-protected-confirm'))

    const banner = await screen.findByTestId('admin-legal-save-failed')
    expect(banner.textContent).toContain('The details could not be saved')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(input(/^IBAN/).value).toBe('CH93 0076 2011 6238 5295 7')
    expect(document.activeElement).toBe(saveButton())

    await user.click(within(banner).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('a 429 after Confirm: the too-many-saves banner with the wait, values kept, Save available', async () => {
    save.mockRejectedValueOnce(problemError(429, 'too_many_requests', { retryAfterSeconds: 150 }))
    const { user } = open()
    await pressSave(user)
    await user.click(await screen.findByTestId('admin-legal-protected-confirm'))

    const banner = await screen.findByTestId('admin-legal-too-many')
    expect(banner.textContent).toContain('Too many saves in a short time')
    expect(banner.textContent).toContain('Nothing was saved and your changes are still here. Wait about 3 minutes, then try again.')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()
    expect(input(/^IBAN/).value).toBe('CH93 0076 2011 6238 5295 7')
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the check is refused or fails: never a dialog (S12 table)', () => {
  const press = async (rejection: unknown) => {
    check.mockRejectedValue(rejection)
    const view = open()
    await view.user.type(input(/^Legal name/), ' Group')
    await view.user.click(saveButton())
    return view
  }

  it('422: the refusal state (summary, focus on the first refused control), nothing saved', async () => {
    await press(problemError(422, 'invalid_legal_entity', { problems: [{ field: 'legalName', reason: 'too_long', limit: 120 }] }))
    expect(await screen.findByTestId('admin-legal-summary')).toBeTruthy()
    expect(document.activeElement).toBe(input(/^Legal name/))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('409: the conflict state, nothing saved', async () => {
    vi.mocked(getVersion).mockResolvedValue({
      ...entityFixture('welld_ch', { version: 4 }),
      action: 'save',
      restoredFrom: null,
      createdBy: { id: 'u2', name: 'Marco Bianchi' },
      createdAt: '2026-11-14T10:03:00.000Z',
    })
    await press(problemError(409, 'version_conflict', { currentVersion: 4 }))
    expect(await screen.findByText('A newer version was saved')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('403: the page is told, nothing saved', async () => {
    const { spies } = await press(problemError(403, 'forbidden'))
    await waitFor(() => expect(spies.onLost).toHaveBeenCalledTimes(1))
    expect(save).not.toHaveBeenCalled()
  })

  it.each([
    [150, 'Wait about 3 minutes, then try again.'],
    [61, 'Wait about 2 minutes, then try again.'],
    [0, 'Wait about 1 minute, then try again.'],
    [undefined, 'Wait a few minutes, then try again.'],
  ])('429 (Retry-After %s): the too-many-saves state with Retry, values kept, Save available', async (seconds, sentence) => {
    await press(problemError(429, 'too_many_requests', { retryAfterSeconds: seconds }))
    const banner = await screen.findByTestId('admin-legal-too-many')
    expect(banner.textContent).toContain('Too many saves in a short time')
    expect(banner.textContent).toContain(sentence)
    expect(within(banner).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()
    expect(input(/^Legal name/).value).toBe('wellD AG Group')
    expect(save).not.toHaveBeenCalled()
  })

  it.each([
    ['a network failure', new TypeError('Failed to fetch')],
    ['a 500', problemError(500, 'boom')],
    ['a 404 while the services are updated one after the other', problemError(404, 'not_found')],
    ['an answer this build cannot read', new Error('contract')],
  ])('%s: "could not be checked" with Retry, nothing saved, values kept', async (_name, failure) => {
    await press(failure)
    const banner = await screen.findByTestId('admin-legal-check-failed')
    expect(banner.textContent).toContain('The changes could not be checked')
    expect(banner.textContent).toContain('Nothing was saved. The page could not check whether these changes need your confirmation.')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(save).not.toHaveBeenCalled()
    expect(input(/^Legal name/).value).toBe('wellD AG Group')
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('Retry on the failed check runs Save again, and asks when the check then answers a protected change', async () => {
    const { user } = await press(new TypeError('Failed to fetch'))
    const banner = await screen.findByTestId('admin-legal-check-failed')
    check.mockResolvedValue(answer([IBAN_CHANGE]))

    await user.click(within(banner).getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(screen.queryByTestId('admin-legal-check-failed')).toBeNull()
    expect(check).toHaveBeenCalledTimes(2)
  })
})

describe('the form goes away while it checks', () => {
  it('does not send a save that needs a confirmation nobody can give', async () => {
    let settle: (value: SaveCheck) => void = () => undefined
    check.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const { user, unmount } = open()
    await user.type(input(/^Legal name/), ' Group')
    await user.click(saveButton())

    unmount()
    await act(async () => settle(answer([IBAN_CHANGE])))

    expect(save).not.toHaveBeenCalled()
  })

  it('still sends a save that needs none, as it did before the check existed', async () => {
    let settle: (value: SaveCheck) => void = () => undefined
    check.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    save.mockResolvedValue(saved())
    const { user, unmount, spies } = open()
    await user.type(input(/^Legal name/), ' Group')
    await user.click(saveButton())

    unmount()
    await act(async () => settle(answer([])))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(spies.entities.at(-1)?.version).toBe(4)
  })
})

describe('the entity moves while the confirmation is open', () => {
  it('drops the confirmation (its Old values belong to the version it was asked on), sends nothing, and Save works again', async () => {
    const { user } = open()
    await pressSave(user)
    await screen.findByRole('alertdialog')

    act(() => page.setEntity?.(entityFixture('welld_ch', { version: 4 })))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(save).not.toHaveBeenCalled()
    check.mockResolvedValue(answer([IBAN_CHANGE]))
    await user.click(saveButton())
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(check).toHaveBeenCalledTimes(2)
    expect(check.mock.calls[1]?.[1].baseVersion).toBe(4)
  })
})

describe('Confirm saves, and the dialog is not inside the form (D3, AC-9.3)', () => {
  /** Every submit the document sees, with whether the page's own handler prevented the browser's default navigation. */
  const submits: Event[] = []
  const record = (event: Event) => {
    // Bubble phase on the document: React's handlers (on the root) have run, so `defaultPrevented` is final.
    submits.push(event)
  }
  beforeEach(() => {
    submits.length = 0
    document.addEventListener('submit', record)
  })
  afterEach(() => document.removeEventListener('submit', record))

  it('has no form inside a form with the confirmation open, and the dialog is not a descendant of the page form', async () => {
    const { user, container } = open()
    expect(container.querySelectorAll('form form')).toHaveLength(0)
    await pressSave(user)
    await screen.findByRole('alertdialog')
    expect(document.querySelectorAll('form form')).toHaveLength(0)
    expect(dialog().closest('form')).toBeNull()
    expect(screen.getByTestId('admin-legal-form').contains(dialog())).toBe(false)
  })

  it.each([
    ['pressing Confirm', async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByTestId('admin-legal-protected-confirm'))],
    [
      'Enter on Confirm',
      async (user: ReturnType<typeof userEvent.setup>) => {
        screen.getByTestId('admin-legal-protected-confirm').focus()
        await user.keyboard('{Enter}')
      },
    ],
    [
      'a requestSubmit of the dialog form',
      async () => {
        const form = screen.getByTestId('admin-legal-protected-confirm').closest('form')
        if (form === null) throw new Error('Confirm is in no form')
        form.requestSubmit()
      },
    ],
  ])('saves exactly once and never lets the browser submit (%s)', async (_name, confirm) => {
    save.mockResolvedValue(saved())
    const { user } = open()
    await pressSave(user)
    await screen.findByRole('alertdialog')
    expect(save).not.toHaveBeenCalled()
    submits.length = 0

    await act(async () => {
      await confirm(user)
    })

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]?.[1].baseVersion).toBe(3)
    expect(submits.length).toBeGreaterThan(0)
    for (const event of submits) expect(event.defaultPrevented).toBe(true)
    expect(check).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(save).toHaveBeenCalledTimes(1)
  })
})
