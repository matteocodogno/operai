/**
 * @vitest-environment jsdom
 *
 * ProjectEditDialog ("Edit details", specs/021 AC-1.6; specs/022 AC-7.1, D53): a refused field — the name
 * empty or too long, the project manager emptied, or either refused by the server — loses its message and
 * its invalid mark as soon as that field changes, even to a value that is still wrong; the next submit
 * checks the whole form again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ADA, fakeApi, problem, projectDetail } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import ProjectEditDialog from './ProjectEditDialog'

const BOB = { id: 'u-bob', name: 'Bob Builder', email: 'bob@welld.ch', entity: 'welld_ch' }

const onSaved = vi.fn()
const onCancel = vi.fn()
const onStale = vi.fn()

const renderDialog = (routes: Record<string, FakeHandler> = {}) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /authz/users/directory': () => ({ status: 200, body: { users: [BOB] } }),
      'PATCH /projects/p1': () => ({ status: 200, body: projectDetail({ version: 4 }) }),
      ...routes,
    }),
  )
  render(
    <ProjectEditDialog
      project={projectDetail({ projectManager: ADA })}
      currentUserId="u-ada"
      onSaved={onSaved}
      onCancel={onCancel}
      onStale={onStale}
    />,
  )
  return screen.getByRole('dialog', { name: 'Edit project' })
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

const nameInput = (dialog: HTMLElement) => within(dialog).getByLabelText(/^Name/)
const manager = (dialog: HTMLElement) => within(dialog).getByRole('combobox', { name: /Project manager/ })
const setName = (dialog: HTMLElement, value: string) => fireEvent.change(nameInput(dialog), { target: { value } })
const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByTestId('project-edit-submit'))
const patches = () =>
  apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH').length

describe('an error ends when the field it was about changes (AC-7.1, D53)', () => {
  const REQUIRED = 'This field is required.'

  it('clears the name’s message and mark on any change, even to a value still wrong; the next submit shows it again', () => {
    const dialog = renderDialog()
    setName(dialog, '')
    submit(dialog)
    expect(within(dialog).getByText(REQUIRED)).not.toBeNull()
    expect(nameInput(dialog).getAttribute('aria-invalid')).toBe('true')

    setName(dialog, '  ')
    expect(within(dialog).queryByText(REQUIRED)).toBeNull()
    expect(nameInput(dialog).getAttribute('aria-invalid')).toBeNull()

    submit(dialog)
    expect(within(dialog).getByText(REQUIRED)).not.toBeNull()
    expect(nameInput(dialog).getAttribute('aria-invalid')).toBe('true')
    expect(patches()).toBe(0)

    setName(dialog, 'Intranet 2')
    expect(within(dialog).queryByText(REQUIRED)).toBeNull()
  })

  it('clears a message the server refused the name with when the name changes', async () => {
    const dialog = renderDialog({
      'PATCH /projects/p1': () => problem(422, 'validation_failed', { field: 'name' }, 'The name is too long.'),
    })
    setName(dialog, 'Intranet 2')
    submit(dialog)
    expect(await within(dialog).findByText('The name is too long.')).not.toBeNull()
    expect(nameInput(dialog).getAttribute('aria-invalid')).toBe('true')

    setName(dialog, 'Intranet 3')
    expect(within(dialog).queryByText('The name is too long.')).toBeNull()
    expect(nameInput(dialog).getAttribute('aria-invalid')).toBeNull()
  })

  it('clears the project manager’s message once a person is picked, and leaves the name’s alone', async () => {
    const dialog = renderDialog()
    // Emptied, then another change alongside it: only then is there something to save, and refuse.
    fireEvent.change(manager(dialog), { target: { value: '' } })
    setName(dialog, '')
    submit(dialog)
    const refusal = 'Choose a person from the list.'
    expect(within(dialog).getByText(refusal)).not.toBeNull()
    expect(manager(dialog).getAttribute('aria-invalid')).toBe('true')
    expect(nameInput(dialog).getAttribute('aria-invalid')).toBe('true')

    fireEvent.focus(manager(dialog))
    fireEvent.click(await within(dialog).findByRole('option', { name: /Bob Builder/ }))
    expect(within(dialog).queryByText(refusal)).toBeNull()
    expect(manager(dialog).getAttribute('aria-invalid')).toBeNull()
    expect(nameInput(dialog).getAttribute('aria-invalid')).toBe('true')
  })

  it('clears a server refusal on the project manager once the field changes', async () => {
    const dialog = renderDialog({ 'PATCH /projects/p1': () => problem(422, 'not_project_user') })
    fireEvent.focus(manager(dialog))
    fireEvent.click(await within(dialog).findByRole('option', { name: /Bob Builder/ }))
    submit(dialog)
    const refusal = 'This person has no access to Projects. Choose someone who does.'
    expect(await within(dialog).findByText(refusal)).not.toBeNull()
    expect(manager(dialog).getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(manager(dialog), { target: { value: 'x' } })
    expect(within(dialog).queryByText(refusal)).toBeNull()
    expect(manager(dialog).getAttribute('aria-invalid')).toBeNull()
  })
})
