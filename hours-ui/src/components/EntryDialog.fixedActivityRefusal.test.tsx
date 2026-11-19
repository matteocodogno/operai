/**
 * @vitest-environment jsdom
 *
 * QE (specs/20261116-record-hours-in-place AC-4.2): a refusal of the task a fixed dialog points at must be shown.
 *
 * Opened from a task row, the dialog shows the task as a fact (`ActivityField lock="fixed"`) and sends its id. When the
 * task has been deleted or moved since the page was drawn (a shared list: someone else did it), hours-api answers
 * 422 `activity_not_allowed`. My hours' dialog words that on its Activity field; the fixed variant of the field has no
 * place for an error, so `failureOf` puts the sentence in `fields.activity` and nothing on screen shows it: the person
 * presses Save and is told nothing. Reproduced live: project page, Tasks card, delete the task in another tab, Record
 * hours on its row, Save: the dialog stays open, no alert, no invalid field, focus on <body>.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { HoursApiError } from '../lib/errors'
import type { EntryInput } from '../lib/hoursApi.types'
import { strings } from '../strings'
import { fakeApi } from '../test-support/fakeApi'
import { typeDuration } from '../test-support/typeDuration'
import { ENTRY_LISTS } from '../test-support/fixtures/entry'
import EntryDialog from './EntryDialog'
import type { EntryPreset } from './EntryDialogModel'

const e = strings.entry
const f = e.fields

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(fakeApi({}))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const TASK = { id: 't-gone', subject: 'Write the offer' }
const cases: [string, EntryPreset, string][] = [
  [
    'project',
    { on: { kind: 'project', project: { id: 'p1', name: 'Project Alpha', companyName: null } }, activity: TASK },
    e.errors.activityNotAllowed.project,
  ],
  [
    'deal',
    { on: { kind: 'deal', deal: { id: 'd1', title: 'Acme renewal', companyName: null } }, activity: TASK },
    e.errors.activityNotAllowed.deal,
  ],
]

describe('a fixed task that hours-api no longer accepts (AC-4.2)', () => {
  it.each(cases)(
    'on a %s: the refusal is on the screen, in My hours’ words, and every value survives',
    async (_kind, preset, sentence) => {
      const onSubmit = vi.fn<(input: EntryInput) => Promise<void>>(async () => {
        throw new HoursApiError({ status: 422, title: 'Unprocessable Entity', rawCode: 'activity_not_allowed' })
      })
      render(
        <EntryDialog
          lists={{ status: 'loaded', lists: ENTRY_LISTS }}
          onReloadLists={() => {}}
          onCancel={() => {}}
          onSubmit={onSubmit}
          preset={preset}
          fixed
          focus="duration"
        />,
      )
      await typeDuration(screen.getByRole('textbox', { name: f.duration.label }), '1:00')
      await userEvent.click(screen.getByRole('button', { name: e.dialog.save }))

      expect(onSubmit).toHaveBeenCalledTimes(1)
      // The person must be told why nothing was saved: the sentence is somewhere inside the open dialog.
      expect(await screen.findByText(sentence)).not.toBeNull()
      expect(screen.getByRole('dialog')).not.toBeNull()
      expect((screen.getByRole('textbox', { name: f.duration.label }) as HTMLInputElement).value).toBe('1:00')
    },
  )
})
