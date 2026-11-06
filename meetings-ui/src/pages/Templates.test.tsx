/**
 * @vitest-environment jsdom
 *
 * The templates pages (specs/021-meetings T74; AC-8.1 to AC-8.4, plan G8; design.md S7, S8): the list,
 * the read view, and the editor on the library `SectionsEditor`, rendered inside the real `./App`
 * router on a memory history, against `fakeApi`.
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  apps: ['meetings'] as string[],
  permissions: [] as { resource: string; action: string }[],
}))

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
  navigateSuite: vi.fn(),
  registerNavigationBlocker: vi.fn(() => () => undefined),
  usePermissions: vi.fn(() => ({
    epoch: 0,
    apps: session.apps,
    roles: [],
    departments: [],
    permissions: session.permissions,
  })),
}))

import { apiFetch } from 'shell/session'
import { createAppRouter } from '../router'
import { en } from '../strings'
import { fakeApi, problem, template } from '../test-support/fakeApi'

const MANAGER = [{ resource: 'template', action: 'manage' }]

beforeEach(() => {
  window.scrollTo = () => undefined
  session.apps = ['meetings']
  session.permissions = []
})

afterEach(() => {
  cleanup()
  vi.mocked(apiFetch).mockReset()
})

const MINUTES = template({
  id: 'builtin:minutes',
  source: 'builtin',
  name: 'Meeting minutes',
  version: 1,
  generalInstructions: 'Be brief.',
})
const WEEKLY = template({ id: 't1', source: 'personal', name: 'Weekly sync', version: 3 })
const HOUSE = template({ id: 't2', source: 'shared', name: 'House style', version: 2 })

const serve = (routes: Parameters<typeof fakeApi>[0] = {}, items = [MINUTES, WEEKLY, HOUSE]) => {
  const api = fakeApi({ 'GET /templates': () => ({ status: 200, body: { items } }), ...routes })
  vi.mocked(apiFetch).mockImplementation(api)
  return api
}

const renderAt = async (url: string, testId: string) => {
  const router = createAppRouter('/meetings', undefined, createMemoryHistory({ initialEntries: [url] }))
  render(<RouterProvider router={router} />)
  await screen.findByTestId(testId)
  return router
}

const calls = (method: string) =>
  vi
    .mocked(apiFetch)
    .mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([input, init]) => ({
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      ifMatch: (init?.headers as Record<string, string> | undefined)?.['If-Match'],
    }))

// ─── S7: the list ───────────────────────────────────────────────────────────

describe('the list (AC-8.5 order; S7)', () => {
  const list = () => renderAt('/meetings/templates', 'meetings-templates-page')

  it('shows personal, shared and built-in templates in three groups, in that order, each marked', async () => {
    serve()
    await list()

    const personal = await screen.findByRole('table', { name: en.templates.groups.personal })
    const shared = screen.getByRole('table', { name: en.templates.groups.shared })
    const builtin = screen.getByRole('table', { name: en.templates.groups.builtin })
    expect(personal.compareDocumentPosition(shared) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(shared.compareDocumentPosition(builtin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const own = within(personal).getByRole('row', { name: /Weekly sync/ })
    expect(within(own).getByRole('link', { name: 'Weekly sync' }).getAttribute('href')).toBe('/meetings/templates/t1')
    expect(within(own).getByText(en.templates.type.personal)).not.toBeNull()
    expect(within(own).getByText('2')).not.toBeNull() // two sections

    expect(
      within(within(shared).getByRole('row', { name: /House style/ })).getByText(en.templates.type.shared),
    ).not.toBeNull()
    const minutes = within(builtin).getByRole('row', { name: /Meeting minutes/ })
    expect(within(minutes).getByText(en.templates.type.builtin)).not.toBeNull()
  })

  it('an empty personal or shared group says so; the built-in group is never empty', async () => {
    serve({}, [MINUTES])
    await list()

    expect(await screen.findByRole('heading', { name: en.templates.empty.personal.title })).not.toBeNull()
    expect(screen.getByText(en.templates.empty.personal.body)).not.toBeNull()
    expect(screen.getByRole('heading', { name: en.templates.empty.shared.title })).not.toBeNull()
    expect(screen.getByRole('table', { name: en.templates.groups.builtin })).not.toBeNull()
  })

  it('New template opens the editor', async () => {
    serve()
    await list()
    expect((await screen.findByRole('link', { name: en.templates.newTemplate })).getAttribute('href')).toBe(
      '/meetings/templates/new',
    )
  })

  it('asks the server for the templates in the page language', async () => {
    serve()
    await list()
    await screen.findByRole('table', { name: en.templates.groups.builtin })
    const init = vi.mocked(apiFetch).mock.calls.find(([input]) => String(input).endsWith('/templates'))?.[1]
    expect((init?.headers as Record<string, string>)['Accept-Language']).toBe('en')
  })

  it('a failed load is a warning with Retry', async () => {
    let attempt = 0
    serve({
      'GET /templates': () => {
        attempt += 1
        return attempt === 1 ? { status: 500, body: problem(500) } : { status: 200, body: { items: [WEEKLY] } }
      },
    })
    await list()
    const banner = await screen.findByTestId('meetings-load-error')
    await userEvent.click(within(banner).getByRole('button', { name: en.common.retry }))
    expect(await screen.findByRole('link', { name: 'Weekly sync' })).not.toBeNull()
  })

  it('403 (no meetings:access) is the permission-denied panel', async () => {
    serve({ 'GET /templates': () => ({ status: 403, body: problem(403, 'meetings_access_required') }) })
    await list()
    expect(await screen.findByTestId('meetings-permission-denied')).not.toBeNull()
  })
})

// ─── S8: the view ───────────────────────────────────────────────────────────

describe('the view (AC-8.1 to AC-8.4; S8)', () => {
  const view = (id: string) => renderAt(`/meetings/templates/${id}`, 'meetings-template-view-page')

  it('a built-in template has no Edit and no Delete, only Duplicate, and says why', async () => {
    serve()
    await view('builtin:minutes')

    expect(await screen.findByRole('heading', { level: 2, name: 'Meeting minutes' })).not.toBeNull()
    expect(screen.getByRole('button', { name: en.templates.view.duplicate })).not.toBeNull()
    expect(screen.queryByRole('link', { name: en.templates.view.edit })).toBeNull()
    expect(screen.queryByRole('button', { name: en.templates.view.edit })).toBeNull()
    expect(screen.queryByRole('button', { name: en.templates.view.delete })).toBeNull()
    expect(screen.getByText(en.templates.view.builtinInfo)).not.toBeNull()
  })

  it('shows the type, the general instructions and the sections in order', async () => {
    serve()
    await view('builtin:minutes')
    await screen.findByRole('heading', { level: 2, name: 'Meeting minutes' })

    expect(screen.getByText('Be brief.')).not.toBeNull()
    const sections = screen.getByRole('list', { name: en.templates.view.sectionsTitle })
    const items = within(sections).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Decisions'),
      expect.stringContaining('Actions'),
    ])
    expect(items[0]!.textContent).toContain('List what was decided.')
  })

  it('a personal template can be edited, duplicated and deleted', async () => {
    serve()
    await view('t1')

    expect((await screen.findByRole('link', { name: en.templates.view.edit })).getAttribute('href')).toBe(
      '/meetings/templates/t1/edit',
    )
    expect(screen.getByRole('button', { name: en.templates.view.delete })).not.toBeNull()
    expect(screen.getByRole('button', { name: en.templates.view.duplicate })).not.toBeNull()
  })

  it('a shared template is read-only without template:manage, and editable with it', async () => {
    serve()
    await view('t2')
    await screen.findByRole('heading', { level: 2, name: 'House style' })
    expect(screen.queryByRole('link', { name: en.templates.view.edit })).toBeNull()
    expect(screen.queryByRole('button', { name: en.templates.view.delete })).toBeNull()
    expect(screen.getByText(en.templates.view.sharedInfo)).not.toBeNull()
    expect(screen.getByRole('button', { name: en.templates.view.duplicate })).not.toBeNull()
    cleanup()

    session.permissions = MANAGER
    await view('t2')
    expect(await screen.findByRole('link', { name: en.templates.view.edit })).not.toBeNull()
    expect(screen.getByRole('button', { name: en.templates.view.delete })).not.toBeNull()
    expect(screen.queryByText(en.templates.view.sharedInfo)).toBeNull()
  })

  it('an unknown template is the not-found panel, not a blank page', async () => {
    serve()
    await view('nope')
    expect(await screen.findByRole('heading', { name: en.templates.notFound.title })).not.toBeNull()
    expect(screen.getByRole('link', { name: en.templates.back })).not.toBeNull()
  })

  describe('delete', () => {
    it('asks first, says existing summaries are not changed, and cancelling deletes nothing', async () => {
      serve()
      await view('t1')
      await userEvent.click(await screen.findByRole('button', { name: en.templates.view.delete }))

      const dialog = screen.getByRole('alertdialog', { name: en.templates.deleteDialog.title })
      expect(within(dialog).getByText(en.templates.deleteDialog.body)).not.toBeNull()
      await userEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(calls('DELETE')).toEqual([])
    })

    it('confirming deletes it, returns to the list and confirms there', async () => {
      serve({ 'DELETE /templates/:id': () => ({ status: 204 }) })
      const router = await view('t1')
      await userEvent.click(await screen.findByRole('button', { name: en.templates.view.delete }))
      await userEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: en.templates.deleteDialog.confirm }),
      )

      await waitFor(() => expect(router.state.location.pathname).toBe('/templates'))
      expect(calls('DELETE')).toEqual([{ path: '/templates/t1', body: undefined, ifMatch: undefined }])
      expect(await screen.findByText(en.templates.notice.deleted)).not.toBeNull()
    })

    it('a refusal stays inside the dialog with the reason', async () => {
      serve({ 'DELETE /templates/:id': () => ({ status: 403, body: problem(403, 'builtin_readonly') }) })
      await view('t1')
      await userEvent.click(await screen.findByRole('button', { name: en.templates.view.delete }))
      await userEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: en.templates.deleteDialog.confirm }),
      )
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText(en.common.errors.builtin_readonly)).not.toBeNull()
    })
  })

  describe('duplicate (AC-8.4)', () => {
    it('a built-in one asks for the language of the copy, then opens the editor on the copy', async () => {
      const copy = template({ id: 't9', source: 'personal', name: 'Meeting minutes (copy)', version: 1 })
      let created = false
      serve({
        'GET /templates': () => ({ status: 200, body: { items: created ? [MINUTES, copy] : [MINUTES] } }),
        'POST /templates/:id/duplicate': () => {
          created = true
          return { status: 201, body: copy }
        },
      })
      const router = await view('builtin:minutes')
      await userEvent.click(await screen.findByRole('button', { name: en.templates.view.duplicate }))

      const dialog = screen.getByRole('dialog', { name: en.templates.duplicateDialog.title })
      expect(
        (within(dialog).getByRole('radio', { name: en.templates.duplicateDialog.en }) as HTMLInputElement).checked,
      ).toBe(true)
      await userEvent.click(within(dialog).getByRole('radio', { name: en.templates.duplicateDialog.it }))
      await userEvent.click(within(dialog).getByRole('button', { name: en.templates.duplicateDialog.submit }))

      await waitFor(() => expect(router.state.location.pathname).toBe('/templates/t9/edit'))
      expect(calls('POST')).toEqual([
        { path: '/templates/builtin%3Aminutes/duplicate', body: { language: 'it' }, ifMatch: undefined },
      ])
      // the editor is open on the copy, and says what to do next
      expect(await screen.findByDisplayValue('Meeting minutes (copy)')).not.toBeNull()
      expect(screen.getByText(en.templates.notice.copied)).not.toBeNull()
    })

    it('a personal or shared one is copied directly, with no dialog', async () => {
      const copy = template({ id: 't9', name: 'Weekly sync (copy)' })
      serve({ 'POST /templates/:id/duplicate': () => ({ status: 201, body: copy }) }, [WEEKLY, copy])
      const router = await view('t1')
      await userEvent.click(await screen.findByRole('button', { name: en.templates.view.duplicate }))

      await waitFor(() => expect(router.state.location.pathname).toBe('/templates/t9/edit'))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(calls('POST')).toEqual([{ path: '/templates/t1/duplicate', body: {}, ifMatch: undefined }])
    })

    it('a refused copy says why and changes nothing', async () => {
      serve({ 'POST /templates/:id/duplicate': () => ({ status: 409, body: problem(409, 'template_name_taken') }) })
      const router = await view('t1')
      await userEvent.click(await screen.findByRole('button', { name: en.templates.view.duplicate }))
      expect(await screen.findByText(en.common.errors.template_name_taken)).not.toBeNull()
      expect(router.state.location.pathname).toBe('/templates/t1')
    })
  })
})

// ─── S8: the editor ─────────────────────────────────────────────────────────

describe('the editor (AC-8.2, AC-8.3, plan G8; S8)', () => {
  const create = () => renderAt('/meetings/templates/new', 'meetings-template-editor-page')
  const edit = (id: string) => renderAt(`/meetings/templates/${id}/edit`, 'meetings-template-editor-page')

  const name = () => screen.getByLabelText(/^Name/) as HTMLInputElement
  const general = () => screen.getByLabelText(/^General instructions/) as HTMLTextAreaElement
  const heading = (n: number) => screen.getByLabelText(new RegExp(`^Heading \\(${n}\\)`)) as HTMLInputElement
  const instruction = (n: number) => screen.getByLabelText(new RegExp(`^Instruction \\(${n}\\)`)) as HTMLTextAreaElement
  const save = () => screen.getByRole('button', { name: en.templates.editor.save })
  const typed = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } })

  describe('scope (AC-8.3)', () => {
    it('without template:manage the shared option is not offered', async () => {
      serve()
      await create()
      // personal is the only choice, so there is nothing to choose
      expect(screen.queryByRole('radiogroup', { name: new RegExp(`^${en.templates.editor.scope}`) })).toBeNull()
      expect(screen.queryByRole('radio', { name: new RegExp(`^${en.templates.editor.scopeShared}`) })).toBeNull()
    })

    it('with template:manage it is offered, and what is chosen is what is sent', async () => {
      session.permissions = MANAGER
      serve({ 'POST /templates': () => ({ status: 201, body: template({ id: 'n1' }) }) })
      await create()
      await userEvent.click(screen.getByRole('radio', { name: new RegExp(`^${en.templates.editor.scopeShared}`) }))
      typed(name(), 'House rules')
      typed(heading(1), 'Decisions')
      await userEvent.click(save())
      await waitFor(() => expect(calls('POST')).toHaveLength(1))
      expect(calls('POST')[0]!.body).toMatchObject({ scope: 'shared', name: 'House rules' })
    })

    it('when editing, the scope is a fact, not a choice', async () => {
      session.permissions = MANAGER
      serve()
      await edit('t2')
      await screen.findByDisplayValue('House style')
      expect(screen.queryByRole('radio', { name: new RegExp(`^${en.templates.editor.scopePersonal}`) })).toBeNull()
      expect(screen.getByText(en.templates.type.shared)).not.toBeNull()
    })
  })

  describe('field limits are validated inline (AC-8.2)', () => {
    it('names an empty name and an empty heading, creates nothing, and focuses the first', async () => {
      serve()
      await create()
      await userEvent.click(save())

      expect(screen.getByText(en.templates.editor.errors.nameRequired)).not.toBeNull()
      expect(screen.getByText(en.templates.editor.errors.headingRequired)).not.toBeNull()
      expect(name().getAttribute('aria-invalid')).toBe('true')
      expect(heading(1).getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(name())
      expect(calls('POST')).toEqual([])
    })

    it('too long: name over 80, general instructions over 2,000, heading over 80, instruction over 500', async () => {
      serve()
      await create()
      typed(name(), 'n'.repeat(81))
      typed(general(), 'g'.repeat(2001))
      typed(heading(1), 'h'.repeat(81))
      typed(instruction(1), 'i'.repeat(501))
      await userEvent.click(save())

      const errors = en.templates.editor.errors
      // the name and the heading share their limit, so the same words appear twice
      expect(screen.getAllByText(errors.nameTooLong)).toHaveLength(2)
      expect(name().getAttribute('aria-invalid')).toBe('true')
      expect(heading(1).getAttribute('aria-invalid')).toBe('true')
      expect(general().getAttribute('aria-invalid')).toBe('true')
      expect(screen.getByText(errors.generalTooLong)).not.toBeNull()
      expect(screen.getByText(errors.instructionTooLong)).not.toBeNull()
      expect(calls('POST')).toEqual([])
    })

    it('the limits themselves are fine: 80, 2,000, 80 and 500 characters', async () => {
      serve({ 'POST /templates': () => ({ status: 201, body: template({ id: 'n1' }) }) })
      await create()
      typed(name(), 'n'.repeat(80))
      typed(general(), 'g'.repeat(2000))
      typed(heading(1), 'h'.repeat(80))
      typed(instruction(1), 'i'.repeat(500))
      await userEvent.click(save())
      await waitFor(() => expect(calls('POST')).toHaveLength(1))
    })

    it('a name that is only spaces is empty', async () => {
      serve()
      await create()
      typed(name(), '    ')
      typed(heading(1), 'Decisions')
      await userEvent.click(save())
      expect(screen.getByText(en.templates.editor.errors.nameRequired)).not.toBeNull()
      expect(calls('POST')).toEqual([])
    })

    it('shows how much of the general instructions is used', async () => {
      serve()
      await create()
      typed(general(), 'abc')
      expect(screen.getByText(en.templates.editor.generalInstructionsHint(3, 2000))).not.toBeNull()
    })

    it('errors follow the edit once shown: fixing a field clears its message before the next save', async () => {
      serve()
      await create()
      await userEvent.click(save())
      expect(screen.getByText(en.templates.editor.errors.nameRequired)).not.toBeNull()
      typed(name(), 'Fixed')
      expect(screen.queryByText(en.templates.editor.errors.nameRequired)).toBeNull()
    })
  })

  describe('sections (SectionsEditor, 1 to 15)', () => {
    it('starts with one blank section that cannot be removed, and adds up to 15', async () => {
      serve()
      await create()
      expect(
        (screen.getByRole('button', { name: en.templates.editor.sections.remove(1) }) as HTMLButtonElement).disabled,
      ).toBe(true)

      const add = screen.getByRole('button', { name: en.templates.editor.sections.add }) as HTMLButtonElement
      for (let n = 2; n <= 15; n += 1) await userEvent.click(add)
      expect(add.disabled).toBe(true)
      expect(screen.getAllByLabelText(/^Heading \(/)).toHaveLength(15)
    })

    it('are sent in the order the person arranged them, with heading and instruction', async () => {
      serve({ 'POST /templates': () => ({ status: 201, body: template({ id: 'n1' }) }) })
      await create()
      typed(name(), 'Ordered')
      typed(heading(1), 'First')
      typed(instruction(1), 'Do first')
      await userEvent.click(screen.getByRole('button', { name: en.templates.editor.sections.add }))
      typed(heading(2), 'Second')
      await userEvent.click(screen.getByRole('button', { name: en.templates.editor.sections.moveUp(2) }))
      await userEvent.click(save())

      await waitFor(() => expect(calls('POST')).toHaveLength(1))
      expect(calls('POST')[0]!.body).toEqual({
        scope: 'personal',
        name: 'Ordered',
        sections: [
          { heading: 'Second', instruction: '' },
          { heading: 'First', instruction: 'Do first' },
        ],
      })
    })
  })

  describe('create', () => {
    it('sends the form, then opens the new template and confirms', async () => {
      const made = template({ id: 'n1', name: 'Fresh' })
      serve({ 'POST /templates': () => ({ status: 201, body: made }) }, [MINUTES, made])
      const router = await create()
      typed(name(), '  Fresh ')
      typed(general(), 'Be kind.')
      typed(heading(1), 'Decisions')
      typed(instruction(1), 'What was decided.')
      await userEvent.click(save())

      await waitFor(() => expect(router.state.location.pathname).toBe('/templates/n1'))
      expect(calls('POST')[0]!.body).toEqual({
        scope: 'personal',
        name: 'Fresh',
        generalInstructions: 'Be kind.',
        sections: [{ heading: 'Decisions', instruction: 'What was decided.' }],
      })
      expect(await screen.findByText(en.templates.notice.saved)).not.toBeNull()
    })

    it('a name the person already uses is a name error and keeps the form (409 template_name_taken)', async () => {
      serve({ 'POST /templates': () => ({ status: 409, body: problem(409, 'template_name_taken') }) })
      const router = await create()
      typed(name(), 'Weekly sync')
      typed(heading(1), 'Decisions')
      await userEvent.click(save())

      expect(await screen.findByText(en.common.errors.template_name_taken)).not.toBeNull()
      expect(name().getAttribute('aria-invalid')).toBe('true')
      expect(name().value).toBe('Weekly sync')
      expect(heading(1).value).toBe('Decisions')
      expect(router.state.location.pathname).toBe('/templates/new')
    })

    it('a 422 naming a section is shown on that section', async () => {
      serve({
        'POST /templates': () => ({
          status: 422,
          body: problem(422, undefined, { errors: [{ field: 'sections[0].heading', message: 'Heading is taken.' }] }),
        }),
      })
      await create()
      typed(name(), 'Anything')
      typed(heading(1), 'Decisions')
      await userEvent.click(save())
      expect(await screen.findByText('Heading is taken.')).not.toBeNull()
      expect(heading(1).getAttribute('aria-invalid')).toBe('true')
    })

    it('403 (not a template manager after all) is the permission-denied panel', async () => {
      serve({ 'POST /templates': () => ({ status: 403, body: problem(403) }) })
      await create()
      typed(name(), 'Anything')
      typed(heading(1), 'Decisions')
      await userEvent.click(save())
      expect(await screen.findByTestId('meetings-permission-denied')).not.toBeNull()
    })

    it('Cancel goes back to the list', async () => {
      serve()
      const router = await create()
      await userEvent.click(screen.getByRole('button', { name: en.templates.editor.cancel }))
      await waitFor(() => expect(router.state.location.pathname).toBe('/templates'))
    })
  })

  describe('edit', () => {
    it('opens on the stored values, and saves with the version it read as If-Match (G8)', async () => {
      serve({
        'PATCH /templates/:id': () => ({ status: 200, body: { ...WEEKLY, name: 'Weekly sync v2', version: 4 } }),
      })
      const router = await edit('t1')
      await screen.findByDisplayValue('Weekly sync')
      expect(heading(1).value).toBe('Decisions')
      expect(instruction(2).value).toBe('Who does what by when.')

      typed(name(), 'Weekly sync v2')
      await userEvent.click(save())

      await waitFor(() => expect(router.state.location.pathname).toBe('/templates/t1'))
      const [patch] = calls('PATCH')
      expect(patch!.path).toBe('/templates/t1')
      expect(patch!.ifMatch).toBe('"3"')
      expect(patch!.body).toEqual({
        name: 'Weekly sync v2',
        generalInstructions: '',
        sections: WEEKLY.sections,
      })
      expect(await screen.findByText(en.templates.notice.saved)).not.toBeNull()
    })

    it.each([
      ['409 version_conflict', { status: 409, body: problem(409, 'version_conflict') }],
      ['428 precondition_required', { status: 428, body: problem(428, 'precondition_required') }],
    ])('%s: shows the stale-write banner, keeps the edits until Reload (G8)', async (_label, answer) => {
      serve({ 'PATCH /templates/:id': () => answer })
      const router = await edit('t1')
      await screen.findByDisplayValue('Weekly sync')
      typed(name(), 'My edit')
      await userEvent.click(save())

      const banner = await screen.findByTestId('meetings-template-stale')
      expect(within(banner).getByText(en.templates.editor.stale.title)).not.toBeNull()
      expect(name().value).toBe('My edit')
      expect(router.state.location.pathname).toBe('/templates/t1/edit')
    })

    it('Reload fetches the latest template, replaces the form with it, and the next save uses its version', async () => {
      let stored = WEEKLY
      serve(
        {
          'GET /templates': () => ({ status: 200, body: { items: [stored] } }),
          'PATCH /templates/:id': (_url, init) => {
            const sent = (init?.headers as Record<string, string>)['If-Match']
            if (sent !== `"${stored.version}"`) return { status: 409, body: problem(409, 'version_conflict') }
            stored = { ...stored, ...JSON.parse(String(init?.body)), version: stored.version + 1 }
            return { status: 200, body: stored }
          },
        },
        [WEEKLY],
      )
      const router = await edit('t1')
      await screen.findByDisplayValue('Weekly sync')
      typed(name(), 'My edit')

      // someone else saves meanwhile
      stored = { ...WEEKLY, name: 'Their edit', version: 7 }
      await userEvent.click(save())
      const banner = await screen.findByTestId('meetings-template-stale')

      await userEvent.click(within(banner).getByRole('button', { name: en.templates.editor.stale.reload }))
      await screen.findByDisplayValue('Their edit')
      expect(screen.queryByTestId('meetings-template-stale')).toBeNull()

      typed(name(), 'Merged by hand')
      await userEvent.click(save())
      await waitFor(() => expect(router.state.location.pathname).toBe('/templates/t1'))
      expect(calls('PATCH').map((patch) => patch.ifMatch)).toEqual(['"3"', '"7"'])
    })

    it('a name conflict on a rename is a name error', async () => {
      serve({ 'PATCH /templates/:id': () => ({ status: 409, body: problem(409, 'template_name_taken') }) })
      await edit('t1')
      await screen.findByDisplayValue('Weekly sync')
      typed(name(), 'Taken')
      await userEvent.click(save())
      expect(await screen.findByText(en.common.errors.template_name_taken)).not.toBeNull()
      expect(screen.queryByTestId('meetings-template-stale')).toBeNull()
    })

    it('403 on a shared template is the permission-denied panel', async () => {
      session.permissions = MANAGER
      serve({ 'PATCH /templates/:id': () => ({ status: 403, body: problem(403) }) })
      await edit('t2')
      await screen.findByDisplayValue('House style')
      typed(name(), 'Renamed')
      await userEvent.click(save())
      expect(await screen.findByTestId('meetings-permission-denied')).not.toBeNull()
    })

    it('a template deleted meanwhile is not found', async () => {
      serve({ 'PATCH /templates/:id': () => ({ status: 404, body: problem(404, 'not_found') }) })
      await edit('t1')
      await screen.findByDisplayValue('Weekly sync')
      typed(name(), 'Late')
      await userEvent.click(save())
      expect(await screen.findByRole('heading', { name: en.templates.notFound.title })).not.toBeNull()
    })

    it('a built-in template, or a shared one without template:manage, has no form at all', async () => {
      serve()
      await edit('builtin:minutes')
      expect(await screen.findByText(en.templates.editor.cannotEdit.builtin)).not.toBeNull()
      expect(screen.queryByRole('button', { name: en.templates.editor.save })).toBeNull()
      cleanup()

      await edit('t2')
      expect(await screen.findByText(en.templates.editor.cannotEdit.shared)).not.toBeNull()
      expect(screen.queryByRole('button', { name: en.templates.editor.save })).toBeNull()
    })

    it('an unknown template is the not-found panel', async () => {
      serve()
      await edit('nope')
      expect(await screen.findByRole('heading', { name: en.templates.notFound.title })).not.toBeNull()
    })

    it('shows the copy notice only when arriving from a duplicate', async () => {
      serve()
      await edit('t1')
      await screen.findByDisplayValue('Weekly sync')
      expect(screen.queryByText(en.templates.notice.copied)).toBeNull()
    })
  })
})
