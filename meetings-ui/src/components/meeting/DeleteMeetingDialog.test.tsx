/**
 * @vitest-environment jsdom
 *
 * The Delete meeting dialog (specs/021-meetings T75; design.md S3c, F14; AC-4.6, AC-5.12): says what
 * is deleted and that it cannot be undone, needs the acknowledgement, and keeps the dialog open
 * (with "Nothing was deleted") when storage is unavailable.
 */
import { formatDate } from '@operai/ui'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../../strings'
import { ADA, GONE, fakeApi, problem, readyMeeting } from '../../test-support/fakeApi'
import DeleteMeetingDialog from './DeleteMeetingDialog'

const session = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  apiFetch: session.apiFetch,
  getMeetingsApiBaseUrl: () => 'http://meetings-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

beforeEach(() => {
  session.apiFetch.mockReset()
})

afterEach(() => {
  cleanup()
})

const t = en.erase.delete

const open = (meeting = readyMeeting()) => {
  const onClose = vi.fn()
  const onDeleted = vi.fn()
  render(<DeleteMeetingDialog meeting={meeting} onClose={onClose} onDeleted={onDeleted} />)
  return { onClose, onDeleted }
}

const confirm = () => screen.getByRole('button', { name: t.confirm }) as HTMLButtonElement
const acknowledge = () => userEvent.click(screen.getByRole('checkbox', { name: t.acknowledge }))

describe('DeleteMeetingDialog', () => {
  it('names the meeting, its date and its creator, and lists what is deleted and that it cannot be undone (AC-4.6)', () => {
    open()
    const dialog = screen.getByRole('alertdialog', { name: t.title })
    expect(
      within(dialog).getByText(t.facts('Kick-off with Acme', formatDate('2026-11-03T09:30:00.000Z'), 'Ada Lovelace')),
    ).not.toBeNull()
    for (const item of t.items) expect(within(dialog).getByText(item)).not.toBeNull()
    expect(within(dialog).getByText(t.cannotUndo)).not.toBeNull()
  })

  it('names a deleted creator as "Deleted user"', () => {
    open(readyMeeting({ creator: GONE }))
    expect(screen.getByText(new RegExp(`created by ${en.erase.deletedUser}`))).not.toBeNull()
  })

  it('needs the acknowledgement: Delete is disabled until it is ticked, and nothing is sent before', async () => {
    const api = fakeApi({})
    session.apiFetch.mockImplementation(api)
    open()
    expect(confirm().disabled).toBe(true)
    await userEvent.click(confirm())
    expect(api).not.toHaveBeenCalled()

    await acknowledge()
    expect(confirm().disabled).toBe(false)
  })

  it('deletes the meeting and reports it gone', async () => {
    const api = fakeApi({ 'DELETE /meetings/:id': () => ({ status: 204 }) })
    session.apiFetch.mockImplementation(api)
    const { onDeleted } = open()
    await acknowledge()
    await userEvent.click(confirm())

    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    const [url, init] = api.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/meetings/m1')
    expect(init?.method).toBe('DELETE')
  })

  it('a meeting that is already gone (404) counts as deleted', async () => {
    session.apiFetch.mockImplementation(fakeApi({}))
    const { onDeleted } = open()
    await acknowledge()
    await userEvent.click(confirm())
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it('storage unavailable keeps the dialog open and says nothing was deleted', async () => {
    session.apiFetch.mockImplementation(
      fakeApi({ 'DELETE /meetings/:id': () => ({ status: 503, body: problem(503, 'storage_unavailable') }) }),
    )
    const { onDeleted, onClose } = open()
    await acknowledge()
    await userEvent.click(confirm())

    expect(await screen.findByText(en.common.errors.storage_unavailable)).not.toBeNull()
    expect(en.common.errors.storage_unavailable).toBe('Nothing was deleted. Try again.')
    expect(onDeleted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog', { name: t.title })).not.toBeNull()
  })

  it('a refusal (the creator was frozen meanwhile) shows its message and can be retried', async () => {
    let refuse = true
    session.apiFetch.mockImplementation(
      fakeApi({
        'DELETE /meetings/:id': () => (refuse ? { status: 403, body: problem(403, 'frozen') } : { status: 204 }),
      }),
    )
    const { onDeleted } = open()
    await acknowledge()
    await userEvent.click(confirm())
    expect(await screen.findByText(en.common.errors.frozen)).not.toBeNull()

    refuse = false
    await userEvent.click(confirm())
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it('cannot be sent twice while it runs', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const api = fakeApi({
      'DELETE /meetings/:id': async () => {
        await gate
        return { status: 204 }
      },
    })
    session.apiFetch.mockImplementation(api)
    open()
    await acknowledge()
    await userEvent.click(confirm())
    await userEvent.click(screen.getByRole('button', { name: t.busy }))
    expect(api).toHaveBeenCalledTimes(1)
    release()
  })

  it('Cancel closes without a request', async () => {
    const api = fakeApi({})
    session.apiFetch.mockImplementation(api)
    const { onClose } = open(readyMeeting({ creator: ADA }))
    await userEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api).not.toHaveBeenCalled()
  })
})
