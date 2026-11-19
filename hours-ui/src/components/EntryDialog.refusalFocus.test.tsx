/**
 * @vitest-environment jsdom
 *
 * Where the keyboard is after a refusal (specs/20261116-record-hours-in-place, QE D2; design S4 "Errors" and
 * § Accessibility; AC-4.2). While a save runs Save is `disabled` and so is every field (the library's `fieldset`), and a
 * browser takes focus off a control that stops being focusable: the keyboard is left on <body> and the next Tab lands on the
 * dialog's ×. A refusal on a field sends focus to that field; a refusal that is the dialog's one alert (a fixed dialog's
 * `not_on_project`, `host_unavailable`, "Something went wrong") sends it back to Save, where the person pressed it and
 * where pressing it again is the retry. jsdom does not take focus off a disabled control, so these tests do it as a
 * browser does (`emulateFocusFixup`): without it they would find focus on Save because nothing ever took it away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import { HoursApiError } from '../lib/errors'
import type { EntryInput, EntryPatch } from '../lib/hoursApi.types'
import { strings } from '../strings'
import { fakeApi } from '../test-support/fakeApi'
import { emulateFocusFixup, rejectAfterAFrame } from '../test-support/focusFixup'
import { typeDuration } from '../test-support/typeDuration'
import { DEAL_ROWS, EDIT_PROJECT, ENTRY_LISTS, MEETING_ROWS, PROJECT_ROWS } from '../test-support/fixtures/entry'
import EntryDialog from './EntryDialog'
import type { EntryPreset } from './EntryDialogModel'

const e = strings.entry
const f = e.fields

type Submit = (input: EntryInput) => Promise<void>

let onSubmit: ReturnType<typeof vi.fn<Submit>>
let stopFixup: () => void

const refusedWith = (status: number, rawCode: string | null) =>
  new HoursApiError({ status, title: `Problem ${status}`, rawCode })

/** The next save is refused, after the time a request takes: the page is rendered, and the busy dialog loses focus, first. */
const refuseNext = (error: unknown) => onSubmit.mockImplementationOnce(() => rejectAfterAFrame(error))

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(
    fakeApi({
      'GET /projects': () => ({ status: 200, body: PROJECT_ROWS }),
      'GET /deals': () => ({ status: 200, body: DEAL_ROWS }),
      'GET /meetings': () => ({ status: 200, body: MEETING_ROWS }),
    }),
  )
  onSubmit = vi.fn<Submit>(async () => {})
  // Only the clock: the pickers' debounce and the waits below run on real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'))
  stopFixup = emulateFocusFixup()
})
afterEach(() => {
  stopFixup()
  cleanup()
  vi.useRealTimers()
})

const PROJECT = { id: 'p1', name: 'Project Alpha', companyName: 'Acme' }
const DEAL = { id: 'd1', title: 'Acme renewal', companyName: 'Acme' }
const MEETING = { id: 'm1', title: 'Kick-off with Acme', startsAt: '2026-11-03T09:30:00.000Z' }
const TASK = { id: 'a-offer', subject: 'Write the offer' }

const durationField = () => screen.getByRole('textbox', { name: f.duration.label }) as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: e.dialog.save }) as HTMLButtonElement
const save = () => userEvent.click(saveButton())
const alertText = async () => (await screen.findByRole('alert')).textContent

/** The keyboard has been handed back: Save, enabled, holds it. A browser had taken it off while the save ran. */
const focusIsOnSave = () => waitFor(() => expect(document.activeElement).toBe(saveButton()))

type Recording = { focus?: 'day' | 'duration' } & (
  { preset?: undefined; fixed?: undefined } | { preset: EntryPreset; fixed?: boolean }
)

const renderRecording = (recording: Recording = {}) =>
  render(
    <EntryDialog
      lists={{ status: 'loaded', lists: ENTRY_LISTS }}
      onReloadLists={() => {}}
      onCancel={() => {}}
      onSubmit={onSubmit}
      {...recording}
    />,
  )

describe('a dialog opened from a page: its refusals with no field to blame give the keyboard back to Save', () => {
  const FIXED: [string, number, string | null, EntryPreset, string][] = [
    ['not_on_project', 403, 'not_on_project', { on: { kind: 'project', project: PROJECT } }, e.errors.notOnProject],
    [
      'not_involved_in_deal',
      403,
      'not_involved_in_deal',
      { on: { kind: 'deal', deal: DEAL } },
      e.errors.notInvolvedInDeal,
    ],
    [
      'a 404 on the project',
      404,
      'not_found',
      { on: { kind: 'project', project: PROJECT } },
      e.errors.targetGoneFixed.project,
    ],
    ['a 404 on the deal', 404, 'not_found', { on: { kind: 'deal', deal: DEAL } }, e.errors.targetGoneFixed.deal],
    [
      'a 404 on the meeting',
      404,
      'not_found',
      { on: { kind: 'meeting', meeting: MEETING } },
      e.errors.targetGoneFixed.meeting,
    ],
    [
      'host_unavailable',
      503,
      'host_unavailable',
      { on: { kind: 'project', project: PROJECT } },
      e.errors.hostUnavailable.project,
    ],
    ['something went wrong', 500, null, { on: { kind: 'project', project: PROJECT } }, e.errors.generic],
    [
      'a task that hours-api no longer accepts (QE D1)',
      422,
      'activity_not_allowed',
      { on: { kind: 'project', project: PROJECT }, activity: TASK },
      e.errors.activityNotAllowed.project,
    ],
  ]

  it.each(FIXED)('%s', async (_name, status, code, preset, sentence) => {
    refuseNext(refusedWith(status, code))
    renderRecording({ preset, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '2:30')
    await save()

    expect(await alertText()).toBe(sentence)
    await focusIsOnSave()
  })

  it('and Save, with the keyboard back on it, is the retry: Enter asks again with the values kept', async () => {
    refuseNext(refusedWith(503, 'host_unavailable'))
    renderRecording({
      preset: { on: { kind: 'project', project: PROJECT }, activity: TASK },
      fixed: true,
      focus: 'duration',
    })
    await typeDuration(durationField(), '2:30')
    await save()
    await focusIsOnSave()

    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1]![0]).toEqual(onSubmit.mock.calls[0]![0])
  })

  it('when the save was made with Enter in a field, the keyboard also comes back to Save, not to the field that was disabled', async () => {
    refuseNext(refusedWith(403, 'not_on_project'))
    renderRecording({ preset: { on: { kind: 'project', project: PROJECT } }, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '2:30')

    await userEvent.keyboard('{Enter}')

    expect(await alertText()).toBe(e.errors.notOnProject)
    await focusIsOnSave()
  })

  it('a refusal on a field still goes to that field: Duration, not Save', async () => {
    refuseNext(refusedWith(422, 'invalid_minutes'))
    renderRecording({ preset: { on: { kind: 'project', project: PROJECT } }, fixed: true, focus: 'duration' })
    await typeDuration(durationField(), '2:30')
    await save()

    await waitFor(() => expect(document.activeElement).toBe(durationField()))
    expect(screen.queryByTestId('hours-entry-dialog-error')).toBeNull()
  })
})

describe('My hours’ own dialog: the same, and the picker where it already was', () => {
  const chooseProject = async () => {
    await userEvent.click(
      within(screen.getByRole('radiogroup', { name: f.on.label })).getByRole('radio', { name: f.on.options.project }),
    )
    await userEvent.type(screen.getByRole('combobox', { name: f.project.label }), 'a')
    await userEvent.click(await screen.findByRole('option', { name: /Project Alpha/ }))
  }

  it.each([
    ['host_unavailable', 503, 'host_unavailable', e.errors.hostUnavailable.project],
    ['something went wrong', 500, null, e.errors.generic],
  ] as const)('%s: Save', async (_name, status, code, sentence) => {
    refuseNext(refusedWith(status, code))
    renderRecording()
    await typeDuration(durationField(), '1:00')
    await chooseProject()
    await save()

    expect(await alertText()).toBe(sentence)
    await focusIsOnSave()
  })

  it('a network failure is the same alert, and the same Save', async () => {
    refuseNext(new TypeError('Failed to fetch'))
    renderRecording()
    await typeDuration(durationField(), '1:00')
    await chooseProject()
    await save()

    expect(await alertText()).toBe(e.errors.generic)
    await focusIsOnSave()
  })

  it('an entity refusal has the picker to blame, and the keyboard goes there as it always did (not to Save)', async () => {
    refuseNext(refusedWith(403, 'not_on_project'))
    renderRecording()
    await typeDuration(durationField(), '1:00')
    await chooseProject()
    await save()

    const picker = await screen.findByRole('combobox', { name: f.project.label })
    await waitFor(() => expect(document.activeElement).toBe(picker))
    expect(screen.queryByTestId('hours-entry-dialog-error')).toBeNull()
  })
})

describe('editing an entry: its alert too', () => {
  it('"this entry can no longer be found" gives the keyboard back to Save', async () => {
    const onPatch = vi
      .fn<(patch: EntryPatch) => Promise<void>>()
      .mockImplementationOnce(() => rejectAfterAFrame(refusedWith(404, null)))
    render(
      <EntryDialog
        entry={EDIT_PROJECT}
        lists={{ status: 'loaded', lists: ENTRY_LISTS }}
        onReloadLists={() => {}}
        onCancel={() => {}}
        onSubmit={onPatch}
      />,
    )
    await typeDuration(durationField(), '1:00')
    await save()

    expect(await alertText()).toBe(e.errors.entryGone)
    await focusIsOnSave()
  })
})
