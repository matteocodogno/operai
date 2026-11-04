/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: () => 'http://meetings.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

import { apiFetch } from 'shell/session'
import { en } from '../../strings'
import type { Summary } from '../../lib/types'
import { fakeApi, problem, readyMeeting, summary, type FakeHandler } from '../../test-support/fakeApi'
import SummariesPanel from './SummariesPanel'

const serve = (routes: Record<string, FakeHandler>) => {
  const api = fakeApi(routes)
  vi.mocked(apiFetch).mockImplementation(api as unknown as typeof apiFetch)
  return api
}

const list = (items: Summary[]): Record<string, FakeHandler> => ({
  'GET /meetings/:id/summaries': () => ({ status: 200, body: { items } }),
})

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body))

const panel = () => render(<SummariesPanel meeting={readyMeeting()} hostInfo={null} onChanged={vi.fn()} />)

const openMenu = async (index = 0) => {
  await userEvent.click((await screen.findAllByRole('button', { name: en.summaries.moreActions }))[index]!)
  return screen.getByRole('menu')
}

const methodCalls = (api: ReturnType<typeof fakeApi>, method: string) =>
  api.mock.calls.filter(([, init]) => init?.method === method)

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
afterEach(cleanup)

describe('More actions follow the summary’s own can (AC-7.7, AC-7.8, G4)', () => {
  it.each([
    [{ edit: true, delete: true, retry: false }, [en.common.edit, en.common.delete]],
    [{ edit: true, delete: false, retry: false }, [en.common.edit]],
    [{ edit: false, delete: true, retry: false }, [en.common.delete]],
  ])('can %j shows %j', async (can, expected) => {
    serve(list([summary({ can })]))
    panel()
    const menu = await openMenu()
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(expected)
  })

  it('with neither, there is no menu at all', async () => {
    serve(list([summary({ can: { edit: false, delete: false, retry: false } })]))
    panel()
    await screen.findByRole('region', { name: 'Sales discovery' })
    expect(screen.queryByRole('button', { name: en.summaries.moreActions })).toBeNull()
  })

  it('the meeting’s own can does not matter: a summary the caller authored can be edited by a participant', async () => {
    serve(list([summary({ can: { edit: true, delete: true, retry: false } })]))
    render(
      <SummariesPanel
        meeting={readyMeeting({ role: 'participant', can: { ...readyMeeting().can, edit: false, summarise: false } })}
        hostInfo={null}
        onChanged={vi.fn()}
      />,
    )
    expect((await openMenu()).textContent).toContain(en.common.edit)
  })
})

describe('edit (AC-7.7)', () => {
  const startEdit = async () => {
    await userEvent.click(within(await openMenu()).getByRole('menuitem', { name: en.common.edit }))
  }

  it('edits each body (headings stay read-only), sends If-Match, and marks the summary edited', async () => {
    let seen: { ifMatch: string | null; body: unknown } | null = null
    let saved: Summary | null = null
    serve({
      'GET /meetings/:id/summaries': () => ({ status: 200, body: { items: [saved ?? summary()] } }),
      'PATCH /meetings/:id/summaries/:sid': (_url, init) => {
        seen = { ifMatch: new Headers(init?.headers).get('If-Match'), body: bodyOf(init) }
        saved = summary({
          edited: true,
          version: 2,
          sections: [
            { heading: 'Decisions', body: 'Ship on Thursday.' },
            { heading: 'Risks', body: 'Not discussed.', notDiscussed: true },
          ],
        })
        return { status: 200, body: saved }
      },
    })
    panel()
    await startEdit()
    const box = screen.getByRole('textbox', { name: 'Decisions' })
    expect(document.activeElement).toBe(box)
    await userEvent.clear(box)
    await userEvent.type(box, 'Ship on Thursday.')
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect(await screen.findByText('Ship on Thursday.')).not.toBeNull()
    expect(seen).toEqual({
      ifMatch: '"1"',
      body: {
        sections: [
          { heading: 'Decisions', body: 'Ship on Thursday.' },
          { heading: 'Risks', body: 'Not discussed.' },
        ],
      },
    })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(en.summaries.edited)).not.toBeNull()
  })

  it('Cancel closes the editor without a request and returns focus to the card', async () => {
    const api = serve(list([summary()]))
    panel()
    await startEdit()
    await userEvent.type(screen.getByRole('textbox', { name: 'Decisions' }), ' more')
    await userEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Ship on Friday.')).not.toBeNull()
    expect(methodCalls(api, 'PATCH')).toHaveLength(0)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('meetings-summary-s1')))
  })

  it.each([
    [409, 'version_conflict'],
    [428, 'precondition_required'],
  ])('%i shows the reload banner; Reload loads the list again', async (status, code) => {
    let loads = 0
    serve({
      'GET /meetings/:id/summaries': () => {
        loads++
        return { status: 200, body: { items: [summary()] } }
      },
      'PATCH /meetings/:id/summaries/:sid': () => ({ status, body: problem(status, code) }),
    })
    panel()
    await startEdit()
    await userEvent.type(screen.getByRole('textbox', { name: 'Decisions' }), '!')
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect(await screen.findByText(en.common.staleWrite.title)).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en.common.reload }))
    await waitFor(() => expect(loads).toBe(2))
    await waitFor(() => expect(screen.queryByText(en.common.staleWrite.title)).toBeNull())
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('another failure stays in the editor with its message and the typed text', async () => {
    serve({
      ...list([summary()]),
      'PATCH /meetings/:id/summaries/:sid': () => ({ status: 403, body: problem(403, 'author_only') }),
    })
    panel()
    await startEdit()
    await userEvent.type(screen.getByRole('textbox', { name: 'Decisions' }), ' more')
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.common.errors.author_only)
    expect((screen.getByRole('textbox', { name: 'Decisions' }) as HTMLTextAreaElement).value).toBe(
      'Ship on Friday. more',
    )
  })

  it('refuses a body over 8,000 characters without calling the server', async () => {
    const api = serve(list([summary()]))
    panel()
    await startEdit()
    await userEvent.click(screen.getByRole('textbox', { name: 'Decisions' }))
    await userEvent.paste('x'.repeat(8_001))
    await userEvent.click(screen.getByRole('button', { name: en.common.save }))
    expect(screen.getByText(en.summaries.bodyTooLong)).not.toBeNull()
    expect(methodCalls(api, 'PATCH')).toHaveLength(0)
  })
})

describe('delete (AC-7.8)', () => {
  const startDelete = async (index = 0) => {
    await userEvent.click(within(await openMenu(index)).getByRole('menuitem', { name: en.common.delete }))
    return screen.getByRole('alertdialog')
  }

  it('asks to confirm and deletes nothing on Cancel', async () => {
    const api = serve(list([summary()]))
    panel()
    const dialog = await startDelete()
    expect(within(dialog).getByText(en.summaries.deleteDialog.body('Sales discovery'))).not.toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(methodCalls(api, 'DELETE')).toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Sales discovery' })).not.toBeNull()
  })

  it('confirming deletes it, and the card goes while the others stay', async () => {
    const other = summary({ id: 's2', template: { name: 'Minutes', source: 'builtin' } })
    let deleted = false
    const api = serve({
      'GET /meetings/:id/summaries': () => ({ status: 200, body: { items: deleted ? [other] : [summary(), other] } }),
      'DELETE /meetings/:id/summaries/:sid': () => {
        deleted = true
        return { status: 204 }
      },
    })
    panel()
    const dialog = await startDelete(0)
    await userEvent.click(within(dialog).getByRole('button', { name: en.summaries.deleteDialog.confirm }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Sales discovery' })).toBeNull())
    expect(screen.getByRole('region', { name: 'Minutes' })).not.toBeNull()
    expect(String(methodCalls(api, 'DELETE')[0]![0])).toMatch(/\/meetings\/m1\/summaries\/s1$/)
  })

  it('a failure keeps the dialog open with its message', async () => {
    serve({
      ...list([summary()]),
      'DELETE /meetings/:id/summaries/:sid': () => ({ status: 403, body: problem(403, 'author_only') }),
    })
    panel()
    const dialog = await startDelete()
    await userEvent.click(within(dialog).getByRole('button', { name: en.summaries.deleteDialog.confirm }))
    expect(await within(dialog).findByText(en.common.errors.author_only)).not.toBeNull()
    expect(screen.getByRole('alertdialog')).not.toBeNull()
  })

  it('a failed summary can be deleted too', async () => {
    serve(list([summary({ status: 'failed', sections: undefined, can: { edit: false, delete: true, retry: false } })]))
    panel()
    const menu = await openMenu()
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([en.common.delete])
  })
})
