/**
 * @vitest-environment jsdom
 *
 * PickProjectManagerDialog (specs/022 AC-4.8, AC-4.9): the first project manager of a project awaiting one,
 * picked among the holders of access to the module (the same people as the project's own manager picker,
 * ADR-0055) and sent as `PATCH /projects/{id}` `{ projectManagerId }` with the project's version as If-Match.
 * Each refusal has its own message: not the ops-manager (403 `not_ops_manager`), no access (422
 * `not_project_user`), a stale project (409 `version_conflict`, the page's reload prompt), the directory down.
 * Nothing in it clears the project manager: a person must be chosen to save (AC-4.9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fakeApi, problem, projectDetail, purchaseOrderOf } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Project } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import PickProjectManagerDialog from './PickProjectManagerDialog'

const BOB = { id: 'u-bob', name: 'Bob Builder', email: 'bob@welld.ch', entity: 'welld_ch' }
const CARA = { id: 'u-cara', name: 'Cara Coder', email: 'cara@welld.ch', entity: 'welld_ch' }

const awaiting = (): Project =>
  projectDetail({
    state: 'planned',
    type: 'fixed_price',
    projectManager: null,
    awaitingProjectManager: true,
    purchaseOrder: purchaseOrderOf(),
    version: 5,
  })

const onSaved = vi.fn()
const onCancel = vi.fn()
const onStale = vi.fn()

const renderDialog = (routes: Record<string, FakeHandler> = {}) => {
  apiFetch.mockImplementation(
    fakeApi({ 'GET /authz/users/directory': () => ({ status: 200, body: { users: [BOB, CARA] } }), ...routes }),
  )
  render(<PickProjectManagerDialog project={awaiting()} onSaved={onSaved} onCancel={onCancel} onStale={onStale} />)
  return screen.getByRole('dialog', { name: 'Pick project manager' })
}

beforeEach(() => {
  window.scrollTo = () => undefined
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const writes = () =>
  apiFetch.mock.calls
    .filter(([, init]) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((init as RequestInit | undefined)?.method ?? ''))
    .map(([input, init]) => ({
      method: (init as RequestInit).method!,
      path: new URL(String(input)).pathname,
      ifMatch: ((init as RequestInit).headers as Record<string, string>)['If-Match'],
      body: JSON.parse(String((init as RequestInit).body ?? 'null')) as unknown,
    }))

const choose = async (dialog: HTMLElement, name: RegExp) => {
  fireEvent.focus(within(dialog).getByRole('combobox', { name: /Project manager/ }))
  fireEvent.click(await within(dialog).findByRole('option', { name }))
}
const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByTestId('project-pick-manager-submit'))

describe('picking the project manager (AC-4.8)', () => {
  it('offers the people with access to the module and PATCHes the chosen one with the project’s version', async () => {
    const next = projectDetail({ projectManager: { id: 'u-bob', name: 'Bob Builder', deleted: false }, version: 6 })
    const dialog = renderDialog({ 'PATCH /projects/p1': () => ({ status: 200, body: next }) })
    fireEvent.focus(within(dialog).getByRole('combobox', { name: /Project manager/ }))
    expect((await within(dialog).findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Bob Builderbob@welld.ch',
      'Cara Codercara@welld.ch',
    ])
    const directory = apiFetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/authz/users/directory')!
    expect(directory.searchParams.get('appId')).toBe('projects')
    fireEvent.click(within(dialog).getByRole('option', { name: /Bob Builder/ }))
    submit(dialog)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next))
    expect(writes()).toEqual([
      { method: 'PATCH', path: '/projects/p1', ifMatch: '"5"', body: { projectManagerId: 'u-bob' } },
    ])
  })

  it('cannot be saved until someone is chosen, and has no way to leave the project without a manager (AC-4.9)', async () => {
    const dialog = renderDialog()
    expect((within(dialog).getByTestId('project-pick-manager-submit') as HTMLButtonElement).disabled).toBe(true)
    submit(dialog)
    expect(writes()).toEqual([])
    expect(within(dialog).queryByRole('button', { name: /clear|remove|none|unassign/i })).toBeNull()
    // Choosing and then emptying the field is the same as choosing nobody: still nothing to save.
    await choose(dialog, /Bob Builder/)
    expect((within(dialog).getByTestId('project-pick-manager-submit') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Project manager/ }), { target: { value: '' } })
    expect((within(dialog).getByTestId('project-pick-manager-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says it is the ops manager’s to pick when the server refuses (403 not_ops_manager), and keeps the dialog', async () => {
    const dialog = renderDialog({ 'PATCH /projects/p1': () => problem(403, 'not_ops_manager') })
    await choose(dialog, /Bob Builder/)
    submit(dialog)
    expect((await within(dialog).findByTestId('project-pick-manager-error')).textContent).toContain(
      'Only the ops manager of this purchase order, or an administrator, can pick the project manager.',
    )
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('refuses a person without access to the module on the field (422 not_project_user), choice kept', async () => {
    const dialog = renderDialog({
      'PATCH /projects/p1': () => problem(422, 'not_project_user', { userIds: ['u-bob'] }),
    })
    await choose(dialog, /Bob Builder/)
    submit(dialog)
    expect(
      await within(dialog).findByText('This person has no access to Projects. Choose someone who does.'),
    ).not.toBeNull()
    expect((within(dialog).getByRole('combobox', { name: /Project manager/ }) as HTMLInputElement).value).toBe(
      'Bob Builder',
    )
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('a stale save (409 version_conflict) is the page’s reload prompt', async () => {
    const dialog = renderDialog({ 'PATCH /projects/p1': () => problem(409, 'version_conflict', { currentVersion: 9 }) })
    await choose(dialog, /Cara Coder/)
    submit(dialog)
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('says so when the user directory is down for the check (503 identity_unavailable), nothing changed', async () => {
    const dialog = renderDialog({ 'PATCH /projects/p1': () => problem(503, 'identity_unavailable') })
    await choose(dialog, /Bob Builder/)
    submit(dialog)
    expect((await within(dialog).findByTestId('project-pick-manager-error')).textContent).toContain(
      'The user directory cannot be reached right now',
    )
  })

  it('Cancel closes it without a request', () => {
    const dialog = renderDialog()
    fireEvent.click(within(dialog).getByTestId('project-pick-manager-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(writes()).toEqual([])
  })
})
