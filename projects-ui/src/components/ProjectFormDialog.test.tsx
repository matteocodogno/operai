/**
 * @vitest-environment jsdom
 *
 * ProjectFormDialog (AC-1.1, AC-1.6, AC-4.4): the company field only for client
 * types, required-field checks before any request, the body that reaches
 * POST /projects, the entities the caller may create for, and the server's
 * refusals landing on the field they name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ScopeContext } from '../hooks/useScope'
import { fakeApi, problem, projectSummary, scope } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import type { Scope } from '../lib/types'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getProjectsApiBaseUrl: () => 'http://projects-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada', name: 'Ada Lovelace' } } }),
}))

import ProjectFormDialog from './ProjectFormDialog'

const BOB = { id: 'u-bob', name: 'Bob Builder', email: 'bob@welld.ch', entity: 'welld_ch' }
const ACME = { id: 'c-acme', name: 'Acme SA', entity: 'welld_ch' }
const created = { ...projectSummary({ id: 'pNew' }), team: [], contracts: [] }

const onSaved = vi.fn()
const onCancel = vi.fn()

const renderDialog = (
  routes: Record<string, FakeHandler> = {},
  callerScope: Scope = scope({ manage: ['welld_ch', 'welld_it'] }),
) => {
  apiFetch.mockImplementation(
    fakeApi({
      'GET /authz/users/directory': () => ({ status: 200, body: { users: [BOB] } }),
      'GET /companies': () => ({ status: 200, body: { items: [ACME] } }),
      'POST /projects': () => ({ status: 201, body: created }),
      ...routes,
    }),
  )
  render(
    <ScopeContext.Provider value={callerScope}>
      <ProjectFormDialog onSaved={onSaved} onCancel={onCancel} />
    </ScopeContext.Provider>,
  )
  return screen.getByRole('dialog', { name: 'New project' })
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

const posted = () => {
  const call = apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  return call ? (JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>) : null
}

const chooseCompany = async (dialog: HTMLElement) => {
  const input = within(dialog).getByRole('combobox', { name: /Company/ })
  fireEvent.change(input, { target: { value: 'acm' } })
  fireEvent.click(await within(dialog).findByRole('option', { name: /Acme SA/ }))
}

describe('the company field (AC-1.1)', () => {
  it.each(['t_and_m', 'fixed_price', 'maintenance'])('is offered, and required, for a %s project', (type) => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: type } })
    expect(within(dialog).getByRole('combobox', { name: /Company/ })).not.toBeNull()
  })

  it.each(['saas', 'internal'])('is not offered for a %s project', (type) => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: type } })
    expect(within(dialog).queryByRole('combobox', { name: /Company/ })).toBeNull()
  })

  it('is not offered until a type is chosen', () => {
    const dialog = renderDialog()
    expect(within(dialog).queryByRole('combobox', { name: /Company/ })).toBeNull()
  })

  it('looks companies up as the person types, through projects-api', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'fixed_price' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Company/ }), { target: { value: 'acm' } })
    expect(await within(dialog).findByRole('option', { name: /Acme SA/ })).not.toBeNull()
    const lookup = apiFetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/companies')!
    expect(lookup.origin).toBe('http://projects-api.test')
    expect(lookup.searchParams.get('q')).toBe('acm')
  })

  it('says the CRM is unavailable when the lookup answers 503 crm_unavailable', async () => {
    const dialog = renderDialog({ 'GET /companies': () => problem(503, 'crm_unavailable') })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'fixed_price' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Company/ }), { target: { value: 'acm' } })
    expect(
      await within(dialog).findByText('The CRM cannot be reached right now. Try again in a moment.'),
    ).not.toBeNull()
  })
})

describe('creating a project (AC-1.1)', () => {
  it('asks for a name, a type and an entity before calling the API', () => {
    const dialog = renderDialog()
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    expect(within(dialog).getAllByText('This field is required.')).toHaveLength(3)
    expect(posted()).toBeNull()
  })

  it('asks a client project for its company before calling the API', () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Intranet' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 't_and_m' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    expect(within(dialog).getByText('Choose a company from the list.')).not.toBeNull()
    expect(posted()).toBeNull()
  })

  it('sends a client project with its company, the project manager defaulting to the caller', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: '  Intranet  ' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 't_and_m' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_it' } })
    await chooseCompany(dialog)
    expect((within(dialog).getByRole('combobox', { name: /Project manager/ }) as HTMLInputElement).value).toBe(
      'Ada Lovelace',
    )
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created))
    expect(posted()).toEqual({ name: 'Intranet', type: 't_and_m', entity: 'welld_it', companyId: 'c-acme' })
  })

  it('sends a SaaS project with no company', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Koordy' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'saas' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).toEqual({ name: 'Koordy', type: 'saas', entity: 'welld_ch' })
  })

  it('drops a chosen company when the type changes to one that has none', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Koordy' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'maintenance' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    await chooseCompany(dialog)
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'saas' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).not.toHaveProperty('companyId')
  })

  it('sends another project manager when one is picked from the module’s people (ADR-0055)', async () => {
    const dialog = renderDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.focus(within(dialog).getByRole('combobox', { name: /Project manager/ }))
    fireEvent.click(await within(dialog).findByRole('option', { name: /Bob Builder/ }))
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).toEqual({ name: 'Ops tooling', type: 'internal', entity: 'welld_ch', projectManagerId: 'u-bob' })
    const directory = apiFetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === '/authz/users/directory')!
    expect(directory.searchParams.get('appId')).toBe('projects')
  })
})

describe('the project manager field', () => {
  it('shows the caller read-only when the directory refuses them, and still creates with the caller as manager', async () => {
    const dialog = renderDialog({ 'GET /authz/users/directory': () => problem(403, 'forbidden') })
    const field = await within(dialog).findByTestId('projects-form-manager-readonly')
    expect((field as HTMLInputElement).value).toBe('Ada Lovelace')
    expect(within(dialog).getByText('Only people who manage projects can choose someone else.')).not.toBeNull()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).toEqual({ name: 'Ops tooling', type: 'internal', entity: 'welld_ch' })
  })
})

describe('the entity a caller may create for (AC-4.4)', () => {
  it('offers both entities to a caller who manages both', () => {
    const dialog = renderDialog()
    const options = within(within(dialog).getByLabelText(/wellD entity/))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(['Choose…', 'wellD CH', 'wellD IT'])
  })

  it('offers only the managed entity to an entity-scoped caller, and preselects it', async () => {
    const dialog = renderDialog({}, scope({ manage: ['welld_it'] }))
    const select = within(dialog).getByLabelText(/wellD entity/) as HTMLSelectElement
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['wellD IT'])
    expect(select.value).toBe('welld_it')
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(posted()).toMatchObject({ entity: 'welld_it' })
  })
})

describe('the server’s refusals', () => {
  const submitInternal = async (routes: Record<string, FakeHandler>) => {
    const dialog = renderDialog(routes)
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ops tooling' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'internal' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    return dialog
  }

  it('puts a project manager without access on the project manager field (AC-1.6)', async () => {
    const dialog = await submitInternal({
      'POST /projects': () => problem(422, 'not_project_user', { userIds: ['u-ada'] }),
    })
    expect(
      await within(dialog).findByText('This person has no access to Projects. Choose someone who does.'),
    ).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('puts an out-of-scope entity on the entity field (AC-4.4)', async () => {
    const dialog = await submitInternal({ 'POST /projects': () => problem(403, 'out_of_scope') })
    expect(await within(dialog).findByText('You may not create projects for this entity.')).not.toBeNull()
  })

  it('puts a refused company on the company field', async () => {
    const dialog = renderDialog({ 'POST /projects': () => problem(422, 'company_not_found') })
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Intranet' } })
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 't_and_m' } })
    fireEvent.change(within(dialog).getByLabelText(/wellD entity/), { target: { value: 'welld_ch' } })
    await chooseCompany(dialog)
    fireEvent.click(within(dialog).getByTestId('projects-form-submit'))
    expect(await within(dialog).findByText('This company no longer exists in the CRM. Choose another.')).not.toBeNull()
  })

  it('puts a validation error on the field the server names', async () => {
    const dialog = await submitInternal({
      'POST /projects': () => problem(400, 'validation_failed', { field: 'name' }, 'name: Required'),
    })
    expect(await within(dialog).findByText('name: Required')).not.toBeNull()
  })

  it('shows anything else in the dialog, keeping what was typed', async () => {
    const dialog = await submitInternal({ 'POST /projects': () => problem(503, 'authz_unavailable') })
    expect((await within(dialog).findByTestId('projects-form-error')).textContent).toContain(
      'Authorization service unavailable',
    )
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Ops tooling')
  })

  it('Cancel closes without a request', () => {
    const dialog = renderDialog()
    fireEvent.click(within(dialog).getByTestId('projects-form-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(posted()).toBeNull()
  })
})
