/**
 * @vitest-environment jsdom
 *
 * LegalEntityForm, two people editing (T38, specs/20261117-legal-entities, design S2 "Conflict behaviour", owner
 * decision Q3=B; AC-2.6, 8.1): a 409 keeps the typed values, reads the newer version and its author and offers
 * Reapply and Discard while Save waits; Reapply merges per value, flags a value both people changed ("Use theirs",
 * the address as one value) and puts focus on the first flagged value; Save then makes the next version; Discard
 * loads the newer version; the other entity's draft is never touched; axe finds nothing.
 */
import axe from 'axe-core'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LegalEntityForm from './LegalEntityForm'
import {
  LegalEntityApiError,
  checkLegalEntity,
  getLegalEntity,
  getVersion,
  saveLegalEntity,
} from '../lib/legalEntitiesApi'
import { entityFixture } from '../pages/LegalEntitiesPage.fixtures'
import type { LegalEntity, LegalEntityDetails, LegalEntityId, LegalEntityVersion } from '../lib/legalEntityModel'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return { ...original, saveLegalEntity: vi.fn(), checkLegalEntity: vi.fn(), getVersion: vi.fn(), getLegalEntity: vi.fn() }
})

const save = vi.mocked(saveLegalEntity)
const readVersion = vi.mocked(getVersion)
const readEntity = vi.mocked(getLegalEntity)

const conflict409 = (currentVersion?: number) =>
  new LegalEntityApiError(
    { type: 'about:blank', title: 'version_conflict', status: 409, code: 'version_conflict' },
    { currentVersion },
  )

/** Version 4 by Marco Bianchi, made from version 3 (the fixture) with `over` changed. */
const newer = (over: Partial<LegalEntity> = {}): LegalEntityVersion => ({
  ...entityFixture('welld_ch', { version: 4, ...over }),
  action: 'save',
  restoredFrom: null,
  createdBy: { id: 'u-marco', name: 'Marco Bianchi' },
  createdAt: '2026-11-14T10:03:00.000Z',
})

const THEIR_ADDRESS = ['Via Esempio 14', '6900 Lugano', 'Italy']

type Spies = { drafts: (LegalEntityDetails | undefined)[]; entities: LegalEntity[] }

/** The page's part: both entities' drafts live above the form; only welld_ch is on screen. */
function Host({ spies, otherDraft }: { spies: Spies; otherDraft: LegalEntityDetails }) {
  const [entity, setEntity] = useState(entityFixture('welld_ch'))
  const [drafts, setDrafts] = useState<Partial<Record<LegalEntityId, LegalEntityDetails | undefined>>>({
    welld_it: otherDraft,
  })
  return (
    <>
      <LegalEntityForm
        entity={entity}
        draft={drafts.welld_ch}
        onDraftChange={(next) => {
          spies.drafts.push(next)
          setDrafts((previous) => ({ ...previous, welld_ch: next }))
        }}
        onEntityChange={(next) => {
          spies.entities.push(next)
          setEntity(next)
        }}
        onLost={() => undefined}
      />
      <output data-testid="other-draft">{drafts.welld_it?.legalName}</output>
    </>
  )
}

const OTHER: LegalEntityDetails = {
  legalName: 'Typed on the other entity',
  address: { it: ['x'], en: ['y'] },
  vatNumber: 'v',
  iban: '',
  contacts: { it: '', en: '' },
}

const open = () => {
  const spies: Spies = { drafts: [], entities: [] }
  const view = render(<Host spies={spies} otherDraft={OTHER} />)
  return { spies, user: userEvent.setup(), ...view }
}

const input = (name: string | RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement
const line = (language: 'Italian' | 'English', n: number) =>
  within(screen.getByRole('group', { name: new RegExp(`^Address \\(${language}\\)`) })).getByRole('textbox', {
    name: new RegExp(`^Line ${n}\\b`),
  }) as HTMLInputElement
const saveButton = () => screen.getByTestId('admin-legal-save') as HTMLButtonElement

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

/** Me: a new English line 1 (the other person changed it too) and a new VAT number (they did not). */
async function editAndConflict(user: ReturnType<typeof userEvent.setup>) {
  save.mockRejectedValueOnce(conflict409(4))
  await user.type(line('English', 1), ' bis')
  await user.type(input(/^VAT number/), ' 9')
  await user.click(saveButton())
  await screen.findByTestId('admin-legal-reapply')
}

beforeEach(() => {
  save.mockReset()
  // The check (T60) finds nothing protected to confirm here: these tests are about what a save's answers do.
  vi.mocked(checkLegalEntity)
    .mockReset()
    .mockResolvedValue({ baseVersion: 3, outcome: 'change', changedFields: [], protectedChanges: [] })
  readVersion.mockReset()
  readEntity.mockReset()
})
afterEach(cleanup)

describe('a 409: the banner (AC-2.6)', () => {
  it('keeps the typed values, reads version n and its author, shows both actions and holds Save', async () => {
    readVersion.mockResolvedValue(
      newer({
        address: { it: ['Via Esempio 12', '6900 Lugano', 'Svizzera'], en: THEIR_ADDRESS },
        iban: 'CH9300762011623852957',
        ibanPrint: 'CH93 0076 2011 6238 5295 7',
      }),
    )
    const { user } = open()
    await editAndConflict(user)

    expect(readVersion).toHaveBeenCalledWith('welld_ch', 4)
    const banner = screen.getByTestId('admin-legal-conflict')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('A newer version was saved')
    expect(banner.textContent).toContain('Marco Bianchi saved version 4 on ')
    expect(banner.textContent).toContain('(changed: Address (English), IBAN)')
    expect(within(banner).getByRole('button', { name: 'Reapply my changes to version 4' })).toBeTruthy()
    expect(within(banner).getByRole('button', { name: 'Discard my changes and load version 4' })).toBeTruthy()

    expect(line('English', 1).value).toBe('Via Esempio 12 bis')
    expect(input(/^VAT number/).value).toBe('IT 00000000000 9')
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    // The action the person needs is where focus is, not three screens up.
    expect(document.activeElement).toBe(screen.getByTestId('admin-legal-reapply'))
    await user.click(saveButton())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('names the system for a version nobody saved', async () => {
    readVersion.mockResolvedValue({ ...newer(), createdBy: null })
    const { user } = open()
    await editAndConflict(user)
    expect(screen.getByTestId('admin-legal-conflict').textContent).toContain('System saved version 4')
  })

  it('reads the newest version itself when the refusal names none', async () => {
    save.mockRejectedValueOnce(conflict409(undefined))
    readEntity.mockResolvedValue(entityFixture('welld_ch', { version: 6 }))
    readVersion.mockResolvedValue({ ...newer(), version: 6 })
    const { user } = open()
    await user.type(input(/^Legal name/), 'x')
    await user.click(saveButton())
    await screen.findByRole('button', { name: 'Reapply my changes to version 6' })
    expect(readVersion).toHaveBeenCalledWith('welld_ch', 6)
  })

  it('offers Retry when the newer version cannot be read, with the values and the wait unchanged', async () => {
    readVersion.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { user } = open()
    save.mockRejectedValueOnce(conflict409(4))
    await user.type(input(/^Legal name/), 'x')
    await user.click(saveButton())

    const banner = await screen.findByTestId('admin-legal-conflict')
    await waitFor(() => expect(banner.textContent).toContain('could not be loaded'))
    expect(screen.queryByTestId('admin-legal-reapply')).toBeNull()
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    expect(input(/^Legal name/).value).toBe('wellD AGx')

    readVersion.mockResolvedValueOnce(newer())
    await user.click(within(banner).getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('admin-legal-reapply')
  })
})

describe('Reapply my changes (Q3=B)', () => {
  const reapplied = async () => {
    readVersion.mockResolvedValue(
      newer({
        address: { it: ['Via Esempio 12', '6900 Lugano', 'Svizzera'], en: THEIR_ADDRESS },
        iban: 'CH9300762011623852957',
        ibanPrint: 'CH93 0076 2011 6238 5295 7',
      }),
    )
    const ctx = open()
    await editAndConflict(ctx.user)
    await ctx.user.click(screen.getByTestId('admin-legal-reapply'))
    return ctx
  }

  it('merges per value: mine where only I changed, theirs where only they did, both flagged where both did', async () => {
    await reapplied()

    expect(screen.queryByTestId('admin-legal-conflict')).toBeNull()
    expect(input(/^VAT number/).value).toBe('IT 00000000000 9')
    expect(input('IBAN').value).toBe('CH93 0076 2011 6238 5295 7')
    expect(line('English', 1).value).toBe('Via Esempio 12 bis')
    expect(screen.getByTestId('admin-legal-applied').textContent).toBe(
      'Your changes were applied to version 4. Address (English) to review, then save as version 5.',
    )
    expect(screen.getByTestId('admin-legal-review-address.en').textContent).toBe(
      'Also changed in version 4 by Marco Bianchi: “Via Esempio 14 / 6900 Lugano / Italy”. Yours is kept. Use theirs',
    )
    // The IBAN came from version 4 because I had not changed it, and says so.
    expect(input('IBAN').getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(`${input('IBAN').id}-hint`)?.textContent).toContain(
      'Taken from version 4 (you had not changed it).',
    )
  })

  it('moves focus to the first flagged value, and Save is then version n+1 with the merged values', async () => {
    const { user } = await reapplied()
    await waitFor(() => expect(document.activeElement).toBe(line('English', 1)))

    expect(saveButton().textContent).toBe('Save as version 5')
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()
    save.mockResolvedValueOnce({ version: 5, created: true, entity: entityFixture('welld_ch', { version: 5 }) })
    await user.click(saveButton())
    await screen.findByTestId('admin-legal-saved')
    expect(save).toHaveBeenCalledTimes(2)
    const sent = save.mock.calls[1]?.[1]
    expect(sent?.baseVersion).toBe(4)
    expect(sent?.details.vatNumber).toBe('IT 00000000000 9')
    expect(sent?.details.address.en.slice(0, 3)).toEqual(['Via Esempio 12 bis', '6900 Lugano', 'Italy'])
    expect(sent?.details.iban).toBe('CH93 0076 2011 6238 5295 7')
  })

  it('"Use theirs" replaces all of that address and takes the note away; focus returns to its first line', async () => {
    const { user } = await reapplied()
    await user.click(screen.getByTestId('admin-legal-use-theirs-address.en'))

    expect(['1', '2', '3', '4'].map((n) => line('English', Number(n)).value)).toEqual([...THEIR_ADDRESS, ''])
    expect(screen.queryByTestId('admin-legal-use-theirs-address.en')).toBeNull()
    expect(screen.queryByTestId('admin-legal-applied')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(line('English', 1)))
  })

  it('flags a text value the same way, with the note as its description', async () => {
    readVersion.mockResolvedValue(newer({ vatNumber: 'IT 777' }))
    const { user } = open()
    save.mockRejectedValueOnce(conflict409(4))
    await user.type(input(/^VAT number/), ' 9')
    await user.click(saveButton())
    await user.click(await screen.findByTestId('admin-legal-reapply'))

    await waitFor(() => expect(document.activeElement).toBe(input(/^VAT number/)))
    const note = document.getElementById(`${input(/^VAT number/).id}-hint`)
    expect(note?.textContent).toContain('Also changed in version 4 by Marco Bianchi: “IT 777”. Yours is kept.')
    await user.click(within(note as HTMLElement).getByRole('button', { name: 'Use theirs' }))
    expect(input(/^VAT number/).value).toBe('IT 777')
    await waitFor(() => expect(document.activeElement).toBe(input(/^VAT number/)))
  })

  it('does not flag a value both people changed to the same thing, and sends focus to Save when nothing is flagged', async () => {
    readVersion.mockResolvedValue(newer({ vatNumber: 'IT 00000000000 9' }))
    const { user } = open()
    save.mockRejectedValueOnce(conflict409(4))
    await user.type(input(/^VAT number/), ' 9')
    await user.click(saveButton())
    await user.click(await screen.findByTestId('admin-legal-reapply'))

    expect(screen.queryByTestId('admin-legal-applied')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use theirs' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(saveButton()))
    // Nothing of mine is left over version 4: no draft, nothing to save.
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
  })

  it("leaves the other entity's draft untouched", async () => {
    await reapplied()
    expect(screen.getByTestId('other-draft').textContent).toBe('Typed on the other entity')
  })
})

describe('Discard my changes', () => {
  it('drops the draft, shows version n, clears the banner and focuses Save; the other draft stays', async () => {
    readVersion.mockResolvedValue(newer({ legalName: 'wellD AG (renamed)' }))
    const { user, spies } = open()
    await editAndConflict(user)
    await user.click(screen.getByTestId('admin-legal-discard'))

    expect(screen.queryByTestId('admin-legal-conflict')).toBeNull()
    expect(input(/^Legal name/).value).toBe('wellD AG (renamed)')
    expect(line('English', 1).value).toBe('Via Esempio 12')
    expect(input(/^VAT number/).value).toBe('IT 00000000000')
    expect(spies.entities.at(-1)?.version).toBe(4)
    expect(spies.drafts.at(-1)).toBeUndefined()
    expect(saveButton().textContent).toBe('Save as version 5')
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(saveButton()))
    expect(screen.getByTestId('other-draft').textContent).toBe('Typed on the other entity')
  })
})

describe('axe', () => {
  it('finds nothing on the banner, after Reapply with a flagged address, and on a failed read', async () => {
    readVersion.mockResolvedValue(
      newer({ address: { it: ['Via Esempio 12', '6900 Lugano', 'Svizzera'], en: THEIR_ADDRESS } }),
    )
    const { user, container } = open()
    await editAndConflict(user)
    expect(await axeViolations(container)).toEqual([])

    await user.click(screen.getByTestId('admin-legal-reapply'))
    await screen.findByTestId('admin-legal-applied')
    expect(await axeViolations(container)).toEqual([])
    cleanup()

    readVersion.mockRejectedValue(new TypeError('Failed to fetch'))
    const second = open()
    save.mockRejectedValueOnce(conflict409(4))
    await second.user.type(input(/^Legal name/), 'x')
    await second.user.click(saveButton())
    await waitFor(() => expect(screen.getByTestId('admin-legal-conflict').textContent).toContain('could not be loaded'))
    expect(await axeViolations(second.container)).toEqual([])
  })
})
