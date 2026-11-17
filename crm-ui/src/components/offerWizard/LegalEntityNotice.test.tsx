/**
 * @vitest-environment jsdom
 *
 * The legal entity notice (specs/20261117-legal-entities T31; design S10; AC-5.5, AC-6.3, AC-8.2): the missing details in
 * words, the link to the entity's tab only for a person who may manage it, the sentence for everyone else (and while
 * `manageable` is unanswered or has failed), assertive when it answers Generate and polite in the pane, Retry when the
 * registry cannot be read. No axe violation.
 */
import axe from 'axe-core'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetManageableLegalEntities } from '../../hooks/useCanManageLegalEntity'
import { legalDetailsInWords } from '../../lib/offerErrors'
import { fakeApi, problemAnswer, type FakeAnswer } from '../../test-support/fakeApi'
import { en, it as italian, strings } from '../../strings'
import LegalEntityNotice from './LegalEntityNotice'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const t = strings.offerWizard.legalEntity
const MISSING = ['vatNumber', 'address.en']

const manageable = (answer: () => FakeAnswer) =>
  apiFetch.mockImplementation(fakeApi({ 'GET /legal-entities/manageable': answer }))
const asked = () => apiFetch.mock.calls.length

beforeEach(() => resetManageableLegalEntities())
afterEach(() => {
  cleanup()
  apiFetch.mockReset()
})

async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  return results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
}

describe('LegalEntityNotice — the issuer’s details are incomplete (AC-6.3)', () => {
  it('names the entity and the missing details in words, and says no offer was created, when it answers Generate', async () => {
    manageable(() => ({ status: 200, body: { entities: [] } }))
    render(<LegalEntityNotice entity="welld_ch" problem="incomplete" missing={MISSING} where="generate" />)
    await waitFor(() => expect(asked()).toBe(1))
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toContain(t.incomplete.title('wellD CH'))
    expect(notice.textContent).toContain(t.incomplete.noOffer)
    expect(notice.textContent).toContain(t.incomplete.missing('VAT number, Address (English)'))
  })

  it('links to the entity’s tab of the Legal entities page for a person who may manage it, the destination in the name', async () => {
    manageable(() => ({ status: 200, body: { entities: ['welld_ch'] } }))
    render(<LegalEntityNotice entity="welld_ch" problem="incomplete" missing={MISSING} where="generate" />)
    const link = await screen.findByRole('link', { name: t.openNamed('wellD CH') })
    expect(link.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
    expect(link.textContent).toBe(t.open)
    expect(link.getAttribute('aria-label')!.startsWith(link.textContent!)).toBe(true)
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toContain(t.incomplete.fillIn)
    expect(notice.textContent).not.toContain(t.incomplete.askAdmin)
  })

  it('tells a person who may manage another entity only to ask an administrator, with no link', async () => {
    manageable(() => ({ status: 200, body: { entities: ['welld_it'] } }))
    render(<LegalEntityNotice entity="welld_ch" problem="incomplete" missing={MISSING} where="generate" />)
    await waitFor(() => expect(asked()).toBe(1))
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(t.incomplete.askAdmin)
  })

  it('shows the sentence, never the link, while `manageable` is pending and when it fails', async () => {
    apiFetch.mockImplementation(() => new Promise(() => undefined))
    const { unmount } = render(<LegalEntityNotice entity="welld_ch" problem="incomplete" missing={MISSING} where="generate" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(t.incomplete.askAdmin)
    unmount()
    resetManageableLegalEntities()
    apiFetch.mockReset()
    manageable(() => problemAnswer(500, 'boom'))
    render(<LegalEntityNotice entity="welld_ch" problem="incomplete" missing={MISSING} where="generate" />)
    await waitFor(() => expect(asked()).toBe(1))
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('is a compact polite warning in the pane, without "No offer was created"', async () => {
    manageable(() => ({ status: 200, body: { entities: ['welld_ch'] } }))
    render(<LegalEntityNotice entity="welld_ch" problem="incomplete" missing={MISSING} where="preview" />)
    const notice = await screen.findByTestId('crm-wizard-legal-entity-incomplete')
    expect(notice.getAttribute('role')).toBe('status')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(notice.textContent).toContain(t.incomplete.title('wellD CH'))
    expect(notice.textContent).not.toContain(t.incomplete.noOffer)
    expect(notice.textContent).toContain('VAT number, Address (English)')
  })

  it('shows a value it has no word for as received, and says nothing about a list that is empty', () => {
    manageable(() => ({ status: 200, body: { entities: [] } }))
    expect(legalDetailsInWords(['legalName', 'swift', 'address.it'])).toBe('Legal name, swift, Address (Italian)')
    render(<LegalEntityNotice entity="welld_it" problem="incomplete" missing={[]} where="generate" />)
    expect(screen.getByRole('alert').textContent).not.toContain('Missing')
  })

  it('has no axe violation, with the link and with the sentence, in the pane and on Generate', async () => {
    manageable(() => ({ status: 200, body: { entities: ['welld_ch'] } }))
    const { container, rerender } = render(
      <LegalEntityNotice entity="welld_ch" problem="incomplete" missing={MISSING} where="generate" />,
    )
    await screen.findByRole('link')
    expect(await axeViolations(container)).toEqual([])
    rerender(<LegalEntityNotice entity="welld_ch" problem="incomplete" missing={MISSING} where="preview" />)
    expect(await axeViolations(container)).toEqual([])
    rerender(<LegalEntityNotice entity="welld_it" problem="incomplete" missing={MISSING} where="generate" />)
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull())
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('LegalEntityNotice — the registry cannot be read (AC-5.5)', () => {
  it('says nothing was created and no number was used, and Retry asks again', async () => {
    manageable(() => ({ status: 200, body: { entities: [] } }))
    const retry = vi.fn()
    render(<LegalEntityNotice entity="welld_ch" problem="unavailable" onRetry={retry} />)
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toContain(t.unavailable.title)
    expect(notice.textContent).toContain(t.unavailable.body)
    await userEvent.setup().click(within(notice).getByRole('button', { name: strings.offerWizard.generate.fail.retryAction }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('has no axe violation', async () => {
    manageable(() => ({ status: 200, body: { entities: [] } }))
    const { container } = render(<LegalEntityNotice entity="welld_ch" problem="unavailable" onRetry={() => undefined} />)
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('LegalEntityNotice — the same words in English and in Italian (AC-8.2)', () => {
  it('has every key in both catalogs, translated, and a word for every detail the registry can name', () => {
    const [english, translated] = [en.offerWizard.legalEntity, italian.offerWizard.legalEntity]
    expect(Object.keys(translated.missingWords).sort()).toEqual(Object.keys(english.missingWords).sort())
    for (const key of Object.keys(english.missingWords)) {
      expect(translated.missingWords[key]).not.toBe('')
      expect(translated.missingWords[key]).not.toBe(english.missingWords[key])
    }
    expect(translated.incomplete.title('wellD CH')).not.toBe(english.incomplete.title('wellD CH'))
    expect(translated.incomplete.title('wellD CH')).toContain('wellD CH')
    expect(translated.incomplete.missing('X')).toContain('X')
    expect(translated.openNamed('wellD CH')).toContain('wellD CH')
    for (const [a, b] of [
      [english.incomplete.noOffer, translated.incomplete.noOffer],
      [english.incomplete.fillIn, translated.incomplete.fillIn],
      [english.incomplete.askAdmin, translated.incomplete.askAdmin],
      [english.unavailable.title, translated.unavailable.title],
      [english.unavailable.body, translated.unavailable.body],
      [english.open, translated.open],
      [en.offers.errors.legalEntitiesUnavailable, italian.offers.errors.legalEntitiesUnavailable],
    ]) {
      expect(b).not.toBe('')
      expect(b).not.toBe(a)
    }
    expect(italian.offers.errors.legalEntityIncomplete('wellD CH', 'X')).toContain('X')
    expect(italian.offers.errors.legalEntityIncomplete('wellD CH', 'X')).not.toBe(
      en.offers.errors.legalEntityIncomplete('wellD CH', 'X'),
    )
  })
})
