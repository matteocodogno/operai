/**
 * @vitest-environment jsdom
 *
 * The note that replaced the four legal fields of the CRM's entity settings (specs/20261117-legal-entities AC-6.1, D5; design S9):
 * a link to `/admin/legal-entities?entity={entity}` for a person who may manage that entity, the sentence for everyone else,
 * and the sentence, never the link, while `manageable` is unanswered or has failed (plan E2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import LegalEntitySettingsNote from './LegalEntitySettingsNote'
import { resetManageableLegalEntities } from '../hooks/useCanManageLegalEntity'
import { fakeApi, problemAnswer } from '../test-support/fakeApi'
import type { FakeAnswer } from '../test-support/fakeApi'
import { en, it as italian, strings } from '../strings'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getCrmApiBaseUrl: () => 'http://crm-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const t = strings.settings
const answerWith = (answer: () => FakeAnswer) =>
  apiFetch.mockImplementation(fakeApi({ 'GET /legal-entities/manageable': answer }))
const asked = () => apiFetch.mock.calls.length

beforeEach(() => resetManageableLegalEntities())
afterEach(() => {
  cleanup()
  apiFetch.mockReset()
})

describe('LegalEntitySettingsNote', () => {
  it('links to the entity’s tab of the Legal entities page for a manager of that entity', async () => {
    answerWith(() => ({ status: 200, body: { entities: ['welld_ch'] } }))
    render(<LegalEntitySettingsNote entity="welld_ch" />)
    const link = await screen.findByRole('link', { name: t.legalNoteLink })
    expect(link.getAttribute('href')).toBe('/admin/legal-entities?entity=welld_ch')
    const note = screen.getByTestId('crm-settings-welld_ch-legal-note')
    expect(note.textContent).toContain(t.legalNote)
    expect(note.textContent).not.toContain(t.legalNoteAdmin)
  })

  it('shows the sentence and no link for a person who manages another entity only', async () => {
    answerWith(() => ({ status: 200, body: { entities: ['welld_ch'] } }))
    render(<LegalEntitySettingsNote entity="welld_it" />)
    await waitFor(() => expect(asked()).toBe(1))
    expect(screen.getByTestId('crm-settings-welld_it-legal-note').textContent).toContain(t.legalNoteAdmin)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('shows the sentence for a person who manages none (a deal:financials holder)', async () => {
    answerWith(() => ({ status: 200, body: { entities: [] } }))
    render(<LegalEntitySettingsNote entity="welld_ch" />)
    await waitFor(() => expect(asked()).toBe(1))
    expect(screen.getByText(t.legalNoteAdmin)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('shows the sentence while the answer is pending and when `manageable` fails, never the link', async () => {
    answerWith(() => problemAnswer(503, 'unavailable'))
    render(<LegalEntitySettingsNote entity="welld_ch" />)
    expect(screen.getByText(t.legalNoteAdmin)).toBeTruthy()
    await waitFor(() => expect(asked()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText(t.legalNoteAdmin)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('is a static note: not announced, and nothing to dismiss', async () => {
    answerWith(() => ({ status: 200, body: { entities: ['welld_it'] } }))
    render(<LegalEntitySettingsNote entity="welld_it" />)
    await screen.findByRole('link')
    expect(screen.getByRole('note')).toBe(screen.getByTestId('crm-settings-welld_it-legal-note'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has its three strings in both languages, the Italian saying the page’s Italian name', () => {
    for (const key of ['legalNote', 'legalNoteLink', 'legalNoteAdmin'] as const) {
      expect(en.settings[key]).not.toBe('')
      expect(italian.settings[key]).not.toBe(en.settings[key])
    }
    expect(italian.settings.legalNoteLink).toContain('Società del gruppo')
    expect(italian.settings.legalNoteAdmin).toContain('Società del gruppo')
  })
})
