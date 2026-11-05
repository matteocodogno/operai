/**
 * @vitest-environment jsdom
 *
 * The Edit details dialog (specs/021-meetings T58; design.md S3c, F7b; AC-1.7, AC-1.8, AC-2.3,
 * AC-3.5): which fields are editable comes from the meeting's `can` flags, Remove link sends
 * `host: null`, and host visibility is NOT here (it lives only in the People and access card).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { Meeting } from '../../lib/types'
import { en } from '../../strings'
import {
  CAN_CREATOR_DRAFT,
  CAN_NONE,
  fakeApi,
  hostView,
  meeting,
  problem,
  readyMeeting,
} from '../../test-support/fakeApi'
import type { FakeHandler } from '../../test-support/fakeApi'
import EditDetailsDialog from './EditDetailsDialog'

const session = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  apiFetch: session.apiFetch,
  getMeetingsApiBaseUrl: () => 'http://meetings-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

beforeEach(() => {
  document.documentElement.removeAttribute('lang')
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
})

const t = en.editDetails

const draft = (overrides: Partial<Meeting> = {}) =>
  meeting({ status: 'draft', source: 'recorded', consent: readyMeeting().consent, ...overrides })

/** A PATCH handler that answers with the meeting patched by the body; returns the bodies it saw. */
const servePatch = (current: Meeting, extra: Record<string, FakeHandler> = {}) => {
  const bodies: Record<string, unknown>[] = []
  const api = fakeApi({
    'PATCH /meetings/:id': (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      return { status: 200, body: { ...current, ...body, host: body['host'] === null ? null : current.host } }
    },
    'GET /meetings/:id': () => ({ status: 200, body: current }),
    ...extra,
  })
  session.apiFetch.mockImplementation(api)
  return { bodies, api }
}

/** Holds the meeting like the page does: what `onChanged` reports replaces the dialog's `meeting`. */
function Page(props: { initial: Meeting; onClose: () => void; onChanged: (m: Meeting) => void }) {
  const [current, setCurrent] = useState(props.initial)
  return (
    <EditDetailsDialog
      meeting={current}
      onClose={props.onClose}
      onChanged={(next) => {
        setCurrent(next)
        props.onChanged(next)
      }}
    />
  )
}

const open = (current: Meeting) => {
  const onClose = vi.fn()
  const onChanged = vi.fn()
  render(<Page initial={current} onClose={onClose} onChanged={onChanged} />)
  return { onClose, onChanged }
}

const save = () => userEvent.click(screen.getByRole('button', { name: t.submit }))

describe('EditDetailsDialog: form and save', () => {
  it('opens as a labelled dialog with the current title, date and time, format', () => {
    const current = draft({ title: 'Kick-off with Acme', format: 'in_person' })
    open(current)
    const dialog = screen.getByRole('dialog', { name: t.title })
    expect((within(dialog).getByLabelText(new RegExp(t.fields.title)) as HTMLInputElement).value).toBe(
      'Kick-off with Acme',
    )
    expect((within(dialog).getByLabelText(t.fields.format) as HTMLSelectElement).value).toBe('in_person')
    expect((within(dialog).getByLabelText(new RegExp(t.fields.startsAt)) as HTMLInputElement).type).toBe('datetime-local')
  })

  it('sends only what changed, then reports the server meeting and closes', async () => {
    const current = draft()
    const { bodies } = servePatch(current)
    const { onChanged, onClose } = open(current)

    const title = screen.getByLabelText(new RegExp(t.fields.title))
    await userEvent.clear(title)
    await userEvent.type(title, 'Renamed meeting')
    await save()

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(bodies).toEqual([{ title: 'Renamed meeting' }])
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onChanged.mock.calls[0]![0].title).toBe('Renamed meeting')
  })

  it('a changed date-time goes as an ISO instant, a changed format as its value', async () => {
    const current = draft({ format: 'online' })
    const { bodies } = servePatch(current)
    open(current)

    fireEvent.change(screen.getByLabelText(new RegExp(t.fields.startsAt)), { target: { value: '2026-11-05T10:15' } })
    await userEvent.selectOptions(screen.getByLabelText(t.fields.format), 'in_person')
    await save()

    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ startsAt: new Date('2026-11-05T10:15').toISOString(), format: 'in_person' })
  })

  it('saving without a change sends nothing and just closes', async () => {
    const current = draft()
    const { api } = servePatch(current)
    const { onClose, onChanged } = open(current)
    await save()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('an empty or over-long title is refused before any request, with the error on the field', async () => {
    const current = draft()
    const { api } = servePatch(current)
    open(current)

    const title = screen.getByLabelText(new RegExp(t.fields.title))
    await userEvent.clear(title)
    await save()
    expect(await screen.findByText(t.errors.titleRequired)).not.toBeNull()
    expect(title.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(title, { target: { value: 'x'.repeat(201) } })
    await save()
    expect(await screen.findByText(t.errors.titleTooLong)).not.toBeNull()
    expect(api).not.toHaveBeenCalled()
  })

  it('a 422 that names fields puts each message under its field (AC-1.3)', async () => {
    const current = draft()
    servePatch(current, {
      'PATCH /meetings/:id': () => ({
        status: 422,
        body: problem(422, undefined, {
          errors: [
            { field: 'title', message: 'Title is too long' },
            { field: 'startsAt', message: 'Not a date' },
          ],
        }),
      }),
    })
    open(current)
    const title = screen.getByLabelText(new RegExp(t.fields.title))
    await userEvent.type(title, '!')
    await save()
    expect(await screen.findByText('Title is too long')).not.toBeNull()
    expect(screen.getByText('Not a date')).not.toBeNull()
  })

  it('any other failure shows inline in the dialog and keeps what was typed', async () => {
    const current = draft()
    servePatch(current, {
      'PATCH /meetings/:id': () => ({ status: 503, body: problem(503, 'host_unavailable') }),
    })
    const { onClose, onChanged } = open(current)
    const title = screen.getByLabelText(new RegExp(t.fields.title)) as HTMLInputElement
    await userEvent.type(title, '!')
    await save()
    expect(await screen.findByText(en.common.errors.host_unavailable)).not.toBeNull()
    expect(title.value).toBe('Kick-off with Acme!')
    expect(onClose).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('Cancel closes without a request', async () => {
    const current = draft()
    const { api } = servePatch(current)
    const { onClose } = open(current)
    await userEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api).not.toHaveBeenCalled()
  })
})

describe('EditDetailsDialog: locked fields follow the server (AC-1.8, G1)', () => {
  it('language is a control only while can.changeLanguage; otherwise read-only text with the reason', () => {
    open(draft({ can: { ...CAN_CREATOR_DRAFT, changeLanguage: true } }))
    expect(screen.getByLabelText(t.fields.language)).not.toBeNull()
    expect(screen.queryByText(t.languageFixed)).toBeNull()
    cleanup()

    open(draft({ language: 'it', can: { ...CAN_CREATOR_DRAFT, changeLanguage: false } }))
    expect(screen.queryByLabelText(t.fields.language)).toBeNull()
    expect(screen.getByText(t.languageFixed)).not.toBeNull()
    expect(screen.getByText(en.meeting.language.it)).not.toBeNull()
  })

  it('source is a choice only while can.changeSource; otherwise read-only text', () => {
    open(draft({ can: { ...CAN_CREATOR_DRAFT, changeSource: true } }))
    expect(screen.getByRole('radiogroup', { name: t.fields.source })).not.toBeNull()
    cleanup()

    open(draft({ source: 'uploaded', can: { ...CAN_CREATOR_DRAFT, changeSource: false } }))
    expect(screen.queryByRole('radiogroup', { name: t.fields.source })).toBeNull()
    expect(screen.getByText(t.sourceFixed)).not.toBeNull()
    expect(screen.getByText(en.meeting.source.uploaded)).not.toBeNull()
  })

  it('switching the source sends it; choosing text says the confirmation is removed (F7b)', async () => {
    const current = draft({ source: 'recorded' })
    const { bodies } = servePatch(current)
    open(current)

    expect(screen.queryByText(t.textClearsConsent)).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: t.sourceOptions.text }))
    expect(screen.getByText(t.textClearsConsent)).not.toBeNull()
    await save()
    await vi.waitFor(() => expect(bodies).toEqual([{ source: 'text' }]))
  })

  it('choosing text before any consent was given does not mention a removal', async () => {
    open(draft({ consent: null }))
    await userEvent.click(screen.getByRole('radio', { name: t.sourceOptions.text }))
    expect(screen.queryByText(t.textClearsConsent)).toBeNull()
  })

  it('leaving a text meeting for recording says the confirmation will be asked for again', async () => {
    open(draft({ source: 'text', consent: null }))
    await userEvent.click(screen.getByRole('radio', { name: t.sourceOptions.recorded }))
    expect(screen.getByText(t.consentAskedAgain)).not.toBeNull()
  })

  it('a language change is sent only while it is allowed', async () => {
    const current = draft({ language: 'en', can: { ...CAN_CREATOR_DRAFT, changeLanguage: true } })
    const { bodies } = servePatch(current)
    open(current)
    await userEvent.selectOptions(screen.getByLabelText(t.fields.language), 'it')
    await save()
    await vi.waitFor(() => expect(bodies).toEqual([{ language: 'it' }]))
  })

  it.each(['language_locked', 'source_locked'] as const)('a 409 %s shows inline, reloads the meeting and locks the field', async (code) => {
    const current = draft({ can: { ...CAN_CREATOR_DRAFT, changeLanguage: true, changeSource: true } })
    const locked = draft({ can: { ...CAN_CREATOR_DRAFT, changeLanguage: false, changeSource: false } })
    servePatch(current, {
      'PATCH /meetings/:id': () => ({ status: 409, body: problem(409, code) }),
      'GET /meetings/:id': () => ({ status: 200, body: locked }),
    })
    const { onChanged, onClose } = open(current)

    await userEvent.type(screen.getByLabelText(new RegExp(t.fields.title)), '!')
    await userEvent.selectOptions(screen.getByLabelText(t.fields.language), 'it')
    await save()

    expect(await screen.findByText(en.common.errors[code])).not.toBeNull()
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(locked))
    expect(onClose).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(screen.queryByLabelText(t.fields.language)).toBeNull())
    expect(screen.getByRole('dialog', { name: t.title })).not.toBeNull()
  })
})

describe('EditDetailsDialog: a lock that appears while open', () => {
  it('after the language locks, the value picked before is no longer sent', async () => {
    const current = draft({ can: { ...CAN_CREATOR_DRAFT, changeLanguage: true } })
    const locked = draft({ can: { ...CAN_CREATOR_DRAFT, changeLanguage: false } })
    const bodies: Record<string, unknown>[] = []
    let refuse = true
    session.apiFetch.mockImplementation(
      fakeApi({
        'PATCH /meetings/:id': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return refuse
            ? { status: 409, body: problem(409, 'language_locked') }
            : { status: 200, body: { ...locked, title: 'Renamed' } }
        },
        'GET /meetings/:id': () => ({ status: 200, body: locked }),
      }),
    )
    const { onClose } = open(current)

    await userEvent.type(screen.getByLabelText(new RegExp(t.fields.title)), '!')
    await userEvent.selectOptions(screen.getByLabelText(t.fields.language), 'it')
    await save()
    await vi.waitFor(() => expect(screen.queryByLabelText(t.fields.language)).toBeNull())

    refuse = false
    await save()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(bodies[0]).toEqual({ title: 'Kick-off with Acme!', language: 'it' })
    expect(bodies[1]).toEqual({ title: 'Kick-off with Acme!' })
  })
})

describe('EditDetailsDialog: Remove link (AC-1.7) and no host visibility', () => {
  const linked = (overrides: Partial<Meeting> = {}) =>
    readyMeeting({
      host: hostView(),
      hostVisibleOffered: true,
      hostVisible: false,
      can: { ...readyMeeting().can, setVisibility: true, link: true },
      ...overrides,
    })

  it('does not offer host visibility: that control lives only in the People and access card (S3/F13)', () => {
    open(linked())
    expect(screen.queryByRole('checkbox', { name: /visible/i })).toBeNull()
    expect(screen.getByRole('checkbox', { name: t.removeLink })).not.toBeNull()
  })

  it('Remove link sends host: null', async () => {
    const current = linked({ hostVisible: true })
    const { bodies } = servePatch(current)
    open(current)

    await userEvent.click(screen.getByRole('checkbox', { name: t.removeLink }))
    await save()
    await vi.waitFor(() => expect(bodies).toEqual([{ host: null }]))
  })

  it('Remove link is offered only for a linked meeting the caller may re-link', () => {
    open(readyMeeting({ host: null }))
    expect(screen.queryByRole('checkbox', { name: t.removeLink })).toBeNull()
    cleanup()
    open(linked({ can: { ...readyMeeting().can, link: false } }))
    expect(screen.queryByRole('checkbox', { name: t.removeLink })).toBeNull()
  })

  it('a creator with no editing right at all gets only read-only values, no source or language control', () => {
    open(draft({ can: CAN_NONE }))
    expect(screen.queryByLabelText(t.fields.language)).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: t.fields.source })).toBeNull()
  })
})
