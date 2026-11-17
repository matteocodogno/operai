/**
 * @vitest-environment jsdom
 *
 * LegalEntityForm (T37, specs/20261117-legal-entities, design S2/S3, flows F3–F5 and F11): four line inputs per
 * language (one per stored line beyond four for a moved address), blanks sent in order, the refusal flow (the
 * library `ErrorSummary`, every control `aria-invalid` and described by the same sentence, focus on the first in
 * page order and on the exact line), the 201 / 200 / 403 / 409 / 5xx outcomes, Save `aria-disabled` with its reason,
 * the IBAN grouped on blur only, the marks of a moved entity, and axe on each state.
 */
import axe from 'axe-core'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LegalEntityForm from './LegalEntityForm'
import { LegalEntityApiError, checkLegalEntity, getVersion, saveLegalEntity } from '../lib/legalEntitiesApi'
import type { SaveResult } from '../lib/legalEntitiesApi'
import { entityFixture } from '../pages/LegalEntitiesPage.fixtures'
import type { LegalEntity, LegalEntityDetails, LegalEntityProblem } from '../lib/legalEntityModel'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return { ...original, saveLegalEntity: vi.fn(), checkLegalEntity: vi.fn(), getVersion: vi.fn() }
})

const save = vi.mocked(saveLegalEntity)

type Spies = { onLost: Mock<() => void>; drafts: (LegalEntityDetails | undefined)[]; entities: LegalEntity[] }

/** The host's part: one entity, one draft, as the page keeps them. */
function Host({
  initial,
  spies,
  initialDraft,
}: {
  initial: LegalEntity
  spies: Spies
  initialDraft?: LegalEntityDetails
}) {
  const [entity, setEntity] = useState(initial)
  const [draft, setDraft] = useState<LegalEntityDetails | undefined>(initialDraft)
  return (
    <LegalEntityForm
      entity={entity}
      draft={draft}
      onDraftChange={(next) => {
        spies.drafts.push(next)
        setDraft(next)
      }}
      onEntityChange={(next) => {
        spies.entities.push(next)
        setEntity(next)
      }}
      onLost={() => spies.onLost()}
    />
  )
}

const open = (entity: LegalEntity = entityFixture('welld_ch'), initialDraft?: LegalEntityDetails) => {
  const spies: Spies = { onLost: vi.fn(), drafts: [], entities: [] }
  const view = render(<Host initial={entity} spies={spies} initialDraft={initialDraft} />)
  return { spies, user: userEvent.setup(), ...view }
}

const problemError = (
  status: number,
  code: string,
  extras: { problems?: LegalEntityProblem[]; currentVersion?: number } = {},
) => new LegalEntityApiError({ type: 'about:blank', title: code, status, code }, extras)

const saved = (entity: LegalEntity, created = true): SaveResult => ({ version: entity.version, created, entity })

const input = (name: string | RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement
const line = (language: 'Italian' | 'English', n: number) =>
  within(screen.getByRole('group', { name: new RegExp(`^Address \\(${language}\\)`) })).getByRole('textbox', {
    name: new RegExp(`^Line ${n}\\b`),
  }) as HTMLInputElement
const saveButton = () => screen.getByTestId('admin-legal-save') as HTMLButtonElement
const edited = (entity: LegalEntity, over: Partial<LegalEntity>): LegalEntity => ({ ...entity, ...over })

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

beforeEach(() => {
  save.mockReset()
  // The check (T60) finds nothing protected to confirm here: these tests are about what a save's answers do.
  vi.mocked(checkLegalEntity)
    .mockReset()
    .mockResolvedValue({ baseVersion: 3, outcome: 'change', changedFields: [], protectedChanges: [] })
  vi.mocked(getVersion).mockReset().mockRejectedValue(new TypeError('Failed to fetch'))
})
afterEach(cleanup)

describe('the controls (S2, Q2=B)', () => {
  it('has four line inputs per language in a fieldset, Line 1 required, the shared hint on every line', () => {
    open()
    for (const language of ['Italian', 'English'] as const) {
      const group = screen.getByRole('group', { name: new RegExp(`^Address \\(${language}\\)`) })
      const lines = within(group).getAllByRole('textbox')
      expect(lines.map((el) => el.id)).toHaveLength(4)
      for (const n of [1, 2, 3, 4]) expect(within(group).getByRole('textbox', { name: `Line ${n}` })).toBe(lines[n - 1])
      expect(lines[0]?.getAttribute('aria-required')).toBe('true')
      expect(lines[1]?.getAttribute('aria-required')).toBeNull()
      const hint = within(group).getByText(/^Up to 4 lines of 120 characters/)
      for (const el of lines) expect(el.getAttribute('aria-describedby')).toContain(hint.id)
    }
    expect(line('Italian', 1).value).toBe('Via Esempio 12')
    expect(line('Italian', 4).value).toBe('')
  })

  it('carries the language of the text on the Italian and English inputs, not on the labels', () => {
    open()
    expect(line('Italian', 1).lang).toBe('it')
    expect(line('English', 1).lang).toBe('en')
    expect(input('Contacts line (Italian)').lang).toBe('it')
    expect(input('Contacts line (English)').lang).toBe('en')
    expect(screen.getByRole('group', { name: /^Address \(Italian\)/ }).closest('[lang]')).toBeNull()
  })

  it('shows a neutral "n / 120" count per line, counted the way the server judges (trimmed, code points)', async () => {
    const { user } = open()
    expect(within(line('Italian', 1).closest('.field') as HTMLElement).getByText('14 / 120')).toBeTruthy()
    await user.type(line('Italian', 4), '  😀😀  ')
    expect(within(line('Italian', 4).closest('.field') as HTMLElement).getByText('2 / 120')).toBeTruthy()
  })

  it('labels every control and marks the required ones', () => {
    open()
    expect(input(/^Legal name/).getAttribute('aria-required')).toBe('true')
    expect(input(/^VAT number/).getAttribute('aria-required')).toBe('true')
    expect(input('IBAN').getAttribute('aria-required')).toBeNull()
    expect(input('IBAN').getAttribute('spellcheck')).toBe('false')
  })
})

describe('Save is aria-disabled with its reason (F5)', () => {
  it('is not `disabled`, says "There is nothing to save." and sends nothing when pressed untouched', async () => {
    const { user } = open()
    expect(saveButton().disabled).toBe(false)
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    expect(saveButton().textContent).toBe('Save as version 4')
    expect(document.getElementById(saveButton().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'There is nothing to save.',
    )
    expect(screen.getByTestId('admin-legal-status').textContent).toBe('No changes')

    await user.click(saveButton())
    await user.type(input(/^Legal name/), '{Enter}')
    expect(save).not.toHaveBeenCalled()
  })

  it('opens up once something is typed, and a difference of spaces or blank lines alone is not a change', async () => {
    const { user } = open()
    await user.type(input(/^Legal name/), ' Group')
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByTestId('admin-legal-status').textContent).toBe(
      'Unsaved changes. Every tool uses a saved version within a minute.',
    )

    await user.clear(input(/^Legal name/))
    await user.type(input(/^Legal name/), '  wellD AG  ')
    await user.type(line('Italian', 4), '   ')
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
  })
})

describe('what a save sends (E5)', () => {
  it('sends the inputs in order, blanks included, with the version it was read at', async () => {
    const entity = entityFixture('welld_ch')
    save.mockResolvedValue(saved(edited(entity, { version: 4 })))
    const { user } = open(entity)

    await user.clear(line('Italian', 2))
    await user.type(line('English', 4), 'Fourth')
    await user.click(saveButton())

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('welld_ch', {
      baseVersion: 3,
      details: {
        legalName: 'wellD AG',
        address: {
          it: ['Via Esempio 12', '', 'Svizzera', ''],
          en: ['Via Esempio 12', '6900 Lugano', 'Italy', 'Fourth'],
        },
        vatNumber: 'IT 00000000000',
        iban: 'IT60 X054 2811 1010 0000 0123 456',
        contacts: { it: 'Tel. +39 02 0000 0000', en: '' },
      },
    })
  })

  it('sends one entry per input for a moved address of five lines, in order', async () => {
    const entity = entityFixture('welld_it', { address: { it: ['1', '2', '3', '4', '5'], en: ['a'] } })
    save.mockResolvedValue(saved(entity))
    const { user } = open(entity)

    await user.clear(line('Italian', 3))
    await user.click(screen.getByTestId('admin-legal-save'))

    expect(save.mock.calls[0]?.[1].details.address).toEqual({ it: ['1', '2', '', '4', '5'], en: ['a', '', '', ''] })
  })

  it('does not send twice while a save runs, and shows "Saving…" without disabling a control', async () => {
    let resolve: (value: SaveResult) => void = () => undefined
    save.mockReturnValue(new Promise((r) => (resolve = r)))
    const { user } = open()
    await user.type(input(/^Legal name/), ' X')

    await user.click(saveButton())
    await user.click(saveButton())
    expect(save).toHaveBeenCalledTimes(1)
    expect(saveButton().textContent).toBe('Saving…')
    expect(saveButton().getAttribute('aria-busy')).toBe('true')
    expect(input(/^Legal name/).disabled).toBe(false)

    await act(async () => resolve(saved(entityFixture('welld_ch', { version: 4 }))))
  })
})

describe('201: saved (F3)', () => {
  it('says "Version n saved…", reloads the normalised values, drops the draft and keeps focus on Save', async () => {
    const entity = entityFixture('welld_ch')
    const result = edited(entity, {
      version: 4,
      legalName: 'wellD SA',
      address: { it: ['Via Esempio 12', 'Svizzera'], en: entity.address.en },
      iban: 'CH9300762011623852957',
      ibanPrint: 'CH93 0076 2011 6238 5295 7',
    })
    save.mockResolvedValue(saved(result))
    const { user, spies } = open(entity)

    await user.clear(input(/^Legal name/))
    await user.type(input(/^Legal name/), ' wellD SA ')
    await user.clear(line('Italian', 2))
    await user.clear(input('IBAN'))
    await user.type(input('IBAN'), 'ch93 0076 2011 6238 5295 7')
    saveButton().focus()
    await user.click(saveButton())

    const note = await screen.findByTestId('admin-legal-saved')
    expect(note.textContent).toBe('Version 4 saved. Every tool uses it within a minute.')
    expect(note.getAttribute('role')).toBe('status')
    expect(spies.entities).toEqual([result])
    expect(spies.drafts.at(-1)).toBeUndefined()
    // Reloaded from the answer: the blank line closed up, the IBAN in groups, the next version offered.
    expect(input(/^Legal name/).value).toBe('wellD SA')
    expect(line('Italian', 2).value).toBe('Svizzera')
    expect(line('Italian', 3).value).toBe('')
    expect(input('IBAN').value).toBe('CH93 0076 2011 6238 5295 7')
    expect(saveButton().textContent).toBe('Save as version 5')
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(saveButton())
  })

  it('goes by itself after a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      save.mockResolvedValue(saved(entityFixture('welld_ch', { version: 4 })))
      const { user } = open()
      await user.type(input(/^Legal name/), 'x')
      await user.click(saveButton())
      await screen.findByTestId('admin-legal-saved')
      await act(async () => {
        vi.advanceTimersByTime(3100)
      })
      expect(screen.queryByTestId('admin-legal-saved')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps what was typed while the request ran as a draft against the new version', async () => {
    let resolve: (value: SaveResult) => void = () => undefined
    save.mockReturnValue(new Promise((r) => (resolve = r)))
    const { user, spies } = open()
    await user.type(input(/^Legal name/), ' A')
    await user.click(saveButton())
    await user.type(input('Contacts line (English)'), 'later')

    await act(async () => resolve(saved(entityFixture('welld_ch', { version: 4, legalName: 'wellD AG A' }))))

    expect(spies.drafts.at(-1)?.contacts.en).toBe('later')
    expect(input('Contacts line (English)').value).toBe('later')
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()
  })

  it('hands the page the entity even when the form is gone by then', async () => {
    let resolve: (value: SaveResult) => void = () => undefined
    save.mockReturnValue(new Promise((r) => (resolve = r)))
    const { user, spies, unmount } = open()
    await user.type(input(/^Legal name/), ' A')
    await user.click(saveButton())
    unmount()

    const result = entityFixture('welld_ch', { version: 4 })
    await act(async () => resolve(saved(result)))
    expect(spies.entities).toEqual([result])
  })
})

describe('200 created:false: nothing changed (F5)', () => {
  it('says so politely and reloads the normalised values', async () => {
    const entity = entityFixture('welld_ch')
    save.mockResolvedValue(saved(entity, false))
    const { user, spies } = open(entity)
    // The server judges it equal to the current version (for instance someone saved the same values just before).
    await user.type(input(/^VAT number/), '1')
    await user.click(saveButton())

    const note = await screen.findByTestId('admin-legal-noop')
    expect(note.textContent).toBe('Nothing changed. These details are already version 3, so no new version was made.')
    expect(spies.drafts.at(-1)).toBeUndefined()
    expect(input(/^VAT number/).value).toBe('IT 00000000000')
    expect(saveButton().textContent).toBe('Save as version 4')
  })
})

describe('422: refused (F4, AC-1.2 to 1.4)', () => {
  const longLine = 'x'.repeat(143)
  const refuse = (problems: LegalEntityProblem[], times = 1) => {
    for (let n = 0; n < times; n += 1)
      save.mockRejectedValueOnce(problemError(422, 'invalid_legal_entity', { problems }))
  }

  it('lists every problem in page order in the library summary, marks each control with the same sentence, focuses the first', async () => {
    const entity = entityFixture('welld_ch', { address: { it: ['Via Esempio 12', 'old', 'Svizzera'], en: ['Via'] } })
    refuse([
      { field: 'address.it', line: 1, reason: 'too_long', limit: 120 },
      { field: 'address.en', reason: 'required' },
      { field: 'iban', reason: 'iban_check_digits' },
      { field: 'vatNumber', reason: 'required' },
    ])
    const { user, spies } = open(entity)
    await user.clear(input(/^VAT number/))
    await user.clear(line('English', 1))
    await user.clear(line('Italian', 2))
    await user.click(line('Italian', 2))
    await user.paste(longLine)
    await user.click(saveButton())

    const summary = await screen.findByTestId('admin-legal-summary')
    expect(summary.getAttribute('role')).toBe('alert')
    expect(within(summary).getByTestId('admin-legal-summary-title').textContent).toBe(
      'Nothing was saved. 4 values need your attention.',
    )
    expect(
      within(summary)
        .getAllByTestId('admin-legal-summary-item')
        .map((b) => b.textContent),
    ).toEqual([
      'VAT number: Enter the VAT number.',
      'IBAN: The check digits do not match. Check it for a typing mistake.',
      'Line 2 of the Italian address: Too long: at most 120 characters, you have 143.',
      'Line 1 of the English address: Enter the address.',
    ])
    // The same sentence under each control, which is invalid and described by it.
    for (const [control, sentence] of [
      [input(/^VAT number/), 'Enter the VAT number.'],
      [input('IBAN'), 'The check digits do not match. Check it for a typing mistake.'],
      [line('Italian', 2), 'Too long: at most 120 characters, you have 143.'],
      [line('English', 1), 'Enter the address.'],
    ] as const) {
      expect(control.getAttribute('aria-invalid')).toBe('true')
      const described = (control.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
      expect(described.some((text) => text?.includes(sentence))).toBe(true)
    }
    // The counter says what the sentence says (not 158 against 143).
    expect(within(line('Italian', 2).closest('.field') as HTMLElement).getByText('143 / 120')).toBeTruthy()
    // Untouched controls are not marked.
    expect(line('Italian', 1).getAttribute('aria-invalid')).toBeNull()
    // Focus: the first refused control in page order (VAT number), after the summary was on screen.
    expect(document.activeElement).toBe(input(/^VAT number/))
    // Nothing was kept as saved: the typed values stay and no entity or draft change was reported.
    expect(spies.entities).toEqual([])
    expect(line('Italian', 2).value).toBe(longLine)
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()
  })

  it('focuses the exact address line when only an address line is refused (positions are the submitted ones)', async () => {
    refuse([{ field: 'address.it', line: 2, reason: 'line_break' }])
    const entity = entityFixture('welld_ch', { address: { it: ['a', 'b', 'c'], en: ['x'] } })
    const { user } = open(entity)
    await user.clear(line('Italian', 2))
    await user.click(saveButton())

    await screen.findByTestId('admin-legal-summary')
    expect(document.activeElement).toBe(line('Italian', 3))
    expect(save.mock.calls[0]?.[1].details.address.it).toEqual(['a', '', 'c', ''])
    expect(line('Italian', 3).getAttribute('aria-invalid')).toBe('true')
    expect(line('Italian', 2).getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByTestId('admin-legal-summary-item').textContent).toBe(
      'Line 3 of the Italian address: Use one line: remove the line break.',
    )
  })

  it('lands too_many_lines on Line 5 of a moved address, counted in non-blank lines', async () => {
    refuse([{ field: 'address.it', reason: 'too_many_lines', limit: 4 }])
    const entity = entityFixture('welld_it', { version: 1, address: { it: ['1', '2', '3', '4', '5', '6'], en: ['a'] } })
    const { user } = open(entity)
    await user.type(line('Italian', 1), ' x')
    await user.click(saveButton())

    await screen.findByTestId('admin-legal-summary')
    expect(document.activeElement).toBe(line('Italian', 5))
    expect(screen.getByTestId('admin-legal-summary-item').textContent).toBe(
      'Line 5 of the Italian address: Too many lines: at most 4, you have 6.',
    )
  })

  it('takes a problem away the moment its control is changed, and the summary with the last one', async () => {
    refuse([
      { field: 'vatNumber', reason: 'required' },
      { field: 'iban', reason: 'iban_format' },
    ])
    const { user } = open()
    await user.clear(input(/^VAT number/))
    await user.type(input('IBAN'), 'x')
    await user.click(saveButton())
    await screen.findByTestId('admin-legal-summary')

    await user.type(input(/^VAT number/), 'IT1')
    expect(input(/^VAT number/).getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByTestId('admin-legal-summary-title').textContent).toBe(
      'Nothing was saved. 1 value needs your attention.',
    )
    await user.type(input('IBAN'), 'y')
    expect(screen.queryByTestId('admin-legal-summary')).toBeNull()
  })

  it('goes to a control from its summary item', async () => {
    refuse([
      { field: 'legalName', reason: 'too_long', limit: 200 },
      { field: 'contacts.en', reason: 'control_character' },
    ])
    const { user } = open()
    await user.type(input('Contacts line (English)'), 'a')
    await user.click(saveButton())
    await screen.findByTestId('admin-legal-summary')
    expect(document.activeElement).toBe(input(/^Legal name/))

    await user.click(screen.getAllByTestId('admin-legal-summary-item')[1] as HTMLElement)
    expect(document.activeElement).toBe(input('Contacts line (English)'))
  })

  it('refuses again on the next save and focuses again', async () => {
    refuse([{ field: 'vatNumber', reason: 'required' }], 2)
    const { user } = open()
    await user.type(input(/^Legal name/), 'x')
    await user.click(saveButton())
    await screen.findByTestId('admin-legal-summary')
    input(/^Legal name/).focus()
    await user.click(saveButton())
    await waitFor(() => expect(document.activeElement).toBe(input(/^VAT number/)))
    expect(save).toHaveBeenCalledTimes(2)
  })
})

describe('403, 409 and a failure (F6, grant lost, could not save)', () => {
  it('reports a 403 to the page, which turns the panel read-only', async () => {
    save.mockRejectedValueOnce(problemError(403, 'forbidden'))
    const { user, spies } = open()
    await user.type(input(/^Legal name/), 'x')
    await user.click(saveButton())

    await waitFor(() => expect(spies.onLost).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('admin-legal-summary')).toBeNull()
  })

  it('keeps the typed values on a 409 and holds Save until the person chooses how to continue (the choice itself: LegalEntityForm.conflict.test.tsx)', async () => {
    save.mockRejectedValueOnce(problemError(409, 'version_conflict', { currentVersion: 4 }))
    const { user } = open()
    await user.type(input(/^Legal name/), ' mine')
    await user.click(saveButton())

    const banner = await screen.findByTestId('admin-legal-conflict')
    expect(banner.textContent).toContain('A newer version was saved')
    expect(input(/^Legal name/).value).toBe('wellD AG mine')
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(saveButton().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'A newer version exists. Choose how to continue.',
    )
    await user.click(saveButton())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a server error', problemError(500, 'internal_error')],
    ['an unavailable registry', problemError(503, 'legal_entities_unavailable')],
    ['a network failure', new TypeError('Failed to fetch')],
    ['an answer without readable problems', problemError(422, 'invalid_legal_entity')],
  ])('keeps the values and the base version on %s, and Retry sends the same save again', async (_name, failure) => {
    save.mockRejectedValueOnce(failure)
    const { user, spies } = open()
    await user.type(input(/^Legal name/), ' mine')
    await user.click(saveButton())

    const banner = await screen.findByTestId('admin-legal-save-failed')
    expect(banner.textContent).toContain('The details could not be saved')
    expect(banner.textContent).toContain('Nothing changed. Your changes are still here. Try again.')
    expect(input(/^Legal name/).value).toBe('wellD AG mine')
    expect(spies.entities).toEqual([])
    expect(saveButton().textContent).toBe('Save as version 4')

    save.mockResolvedValueOnce(saved(entityFixture('welld_ch', { version: 4 })))
    await user.click(within(banner).getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('admin-legal-saved')
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[1]).toEqual(save.mock.calls[0]?.[1])
    expect(save.mock.calls[1]?.[1].baseVersion).toBe(3)
  })
})

describe('the IBAN (AC-1.4)', () => {
  it('is grouped and upper-cased on blur, never while typing, and an untouched field makes no draft', async () => {
    const { user, spies } = open()
    expect(input('IBAN').value).toBe('IT60 X054 2811 1010 0000 0123 456')
    input('IBAN').focus()
    await user.tab()
    expect(spies.drafts).toEqual([])

    await user.clear(input('IBAN'))
    await user.type(input('IBAN'), 'ch9300762011623852957')
    expect(input('IBAN').value).toBe('ch9300762011623852957')
    await user.tab()
    expect(input('IBAN').value).toBe('CH93 0076 2011 6238 5295 7')
  })

  it('is described by its hint, in the monospace font', () => {
    open()
    const hint = document.getElementById(input('IBAN').getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toContain('Spaces and lower case are fine')
    expect(input('IBAN').className).toContain('font-mono')
  })
})

describe('an entity moved incomplete or out of limits (S3, F11, AC-7.3, D3)', () => {
  const moved = () =>
    entityFixture('welld_it', {
      version: 1,
      vatNumber: '',
      complete: false,
      missing: ['vatNumber'],
      address: {
        it: ['Via Esempio 12', 'Palazzo', 'Interno 4', '6900 Lugano', 'Svizzera'],
        en: ['Via Esempio 12', 'x'.repeat(121)],
      },
      invalid: [
        { field: 'address.it', reason: 'too_many_lines', limit: 4 },
        { field: 'address.en', line: 1, reason: 'too_long', limit: 120 },
      ],
    })

  it('shows one input per stored line, the fifth marked in place and the others not, values exactly as moved', () => {
    open(moved())
    const group = screen.getByRole('group', { name: /^Address \(Italian\)/ })
    expect(within(group).getAllByRole('textbox')).toHaveLength(5)
    expect(line('Italian', 5).value).toBe('Svizzera')
    expect(line('Italian', 5).getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(
      line('Italian', 5)
        .getAttribute('aria-describedby')
        ?.split(' ')
        .find((id) => id.endsWith('-error')) ?? '',
    )
    expect(error?.textContent).toBe(
      'Too many lines: at most 4. Join it to a line above or remove it. (Kept as moved from the CRM.)',
    )
    for (let n = 1; n <= 4; n += 1) expect(line('Italian', n).getAttribute('aria-invalid')).toBeNull()
    expect(within(screen.getByRole('group', { name: /^Address \(English\)/ })).getAllByRole('textbox')).toHaveLength(4)
  })

  it('says in the hint, described by every line, that the address was moved with more than four lines (FU-7)', () => {
    open(moved())
    const note = screen.getByTestId('admin-legal-address-it-note')
    expect(note.textContent).toBe(
      'This address was moved from the CRM with 5 lines. Only 4 can be saved: join the extra lines to the ones above, or remove them.',
    )
    const noteId = note.querySelector('span')?.id ?? ''
    expect(noteId).not.toBe('')
    for (let n = 1; n <= 5; n += 1) {
      expect(line('Italian', n).getAttribute('aria-describedby')?.split(' ')).toContain(noteId)
    }
    // The English address has two stored lines: no hint.
    expect(screen.queryByTestId('admin-legal-address-en-note')).toBeNull()
  })

  it('shows a moved line over 120 with its real count and its own sentence on its own input', () => {
    open(moved())
    expect(line('English', 2).getAttribute('aria-invalid')).toBe('true')
    expect(within(line('English', 2).closest('.field') as HTMLElement).getByText('121 / 120')).toBeTruthy()
    expect(
      within(line('English', 2).closest('.field') as HTMLElement).getByText(
        'Too long: at most 120 characters, you have 121. (Kept as moved from the CRM.)',
      ),
    ).toBeTruthy()
  })

  it('marks the empty required value "Not filled in", described and invalid, without announcing anything', () => {
    open(moved())
    expect(input(/^VAT number/).getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(input(/^VAT number/).getAttribute('aria-describedby') ?? '')
    expect(error?.textContent).toBe('Not filled in. Enter the VAT number.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
  })

  it('drops the mark when the control is changed, and the extra input goes after a save that leaves four lines', async () => {
    const entity = moved()
    const result = edited(entity, {
      version: 2,
      vatNumber: 'IT 1',
      complete: true,
      missing: [],
      invalid: [],
      address: {
        it: ['Via Esempio 12', 'Palazzo Interno 4', '6900 Lugano', 'Svizzera'],
        en: ['Via Esempio 12', 'x'.repeat(100)],
      },
    })
    save.mockResolvedValue(saved(result))
    const { user } = open(entity)

    await user.type(input(/^VAT number/), 'IT 1')
    expect(input(/^VAT number/).getAttribute('aria-invalid')).toBeNull()

    await user.clear(line('Italian', 3))
    await user.clear(line('Italian', 5))
    await user.click(saveButton())
    await screen.findByTestId('admin-legal-saved')
    expect(within(screen.getByRole('group', { name: /^Address \(Italian\)/ })).getAllByRole('textbox')).toHaveLength(4)
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0)
  })

  it('refuses a refused moved address again with the refusal sentence, not the moved one', async () => {
    save.mockRejectedValueOnce(
      problemError(422, 'invalid_legal_entity', {
        problems: [{ field: 'address.it', reason: 'too_many_lines', limit: 4 }],
      }),
    )
    const { user } = open(moved())
    await user.type(input(/^VAT number/), 'IT1')
    await user.click(saveButton())

    await screen.findByTestId('admin-legal-summary')
    expect(screen.getByTestId('admin-legal-summary-item').textContent).toBe(
      'Line 5 of the Italian address: Too many lines: at most 4, you have 5.',
    )
    expect(document.activeElement).toBe(line('Italian', 5))
  })
})

describe('axe (AC-8.1)', () => {
  const clean = async (container: Element) => expect(await axeViolations(container)).toEqual([])

  it('finds nothing on the clean form, the dirty form and the saved form', async () => {
    save.mockResolvedValue(saved(entityFixture('welld_ch', { version: 4 })))
    const { container, user } = open()
    await clean(container)
    await user.type(input(/^Legal name/), 'x')
    await clean(container)
    await user.click(saveButton())
    await screen.findByTestId('admin-legal-saved')
    await clean(container)
  })

  it('finds nothing on the refused form (summary, invalid controls, two sentences on one line)', async () => {
    save.mockRejectedValueOnce(
      problemError(422, 'invalid_legal_entity', {
        problems: [
          { field: 'vatNumber', reason: 'required' },
          { field: 'address.it', line: 0, reason: 'line_break' },
          { field: 'address.it', line: 0, reason: 'control_character' },
          { field: 'address.en', reason: 'required' },
        ],
      }),
    )
    const { container, user } = open()
    await user.type(input(/^Legal name/), 'x')
    await user.click(saveButton())
    await screen.findByTestId('admin-legal-summary')
    await clean(container)
  })

  it('finds nothing on the could-not-save, no-op and conflict states', async () => {
    save.mockRejectedValueOnce(problemError(500, 'internal_error'))
    const { container, user } = open()
    await user.type(input(/^Legal name/), 'x')
    await user.click(saveButton())
    await screen.findByTestId('admin-legal-save-failed')
    await clean(container)

    save.mockResolvedValueOnce(saved(entityFixture('welld_ch'), false))
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('admin-legal-noop')
    await clean(container)
  })

  it('finds nothing on a moved entity with a fifth line, a long line and a missing value (S3)', async () => {
    const entity = entityFixture('welld_it', {
      version: 1,
      vatNumber: '',
      complete: false,
      missing: ['vatNumber'],
      address: { it: ['1', '2', '3', '4', '5'], en: ['a', 'x'.repeat(130)] },
      invalid: [
        { field: 'address.it', reason: 'too_many_lines', limit: 4 },
        { field: 'address.en', line: 1, reason: 'too_long', limit: 120 },
        { field: 'iban', reason: 'iban_check_digits' },
      ],
    })
    const { container } = open(entity)
    await clean(container)
  })
})
