/**
 * @vitest-environment jsdom
 *
 * LegalEntitiesPage, the host's own work (T36, design S1 "Drafts", flow F3b, AC-1.1 "no data loss"): one draft per
 * entity that survives a switch of entity, of view or of version and never prompts; the "Unsaved changes" mark in
 * the tab's name; the leave dialog only when LEAVING THE PAGE (a link out, `beforeunload`), naming the entities
 * with unsaved changes; the loss of a grant turning one entity read-only and dropping its draft.
 *
 * The panel is stood in by a small fake that edits the draft the way T37's form will (a controlled input on
 * `draft` / `onDraftChange`) and calls the callbacks the host hands it; the real panel is covered by
 * LegalEntitiesPage.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { entityFixture, renderPage } from './LegalEntitiesPage.fixtures'
import { getManageable, listLegalEntities } from '../lib/legalEntitiesApi'
import { detailsOf } from '../lib/legalEntityModel'
import type { LegalEntityPanelProps } from '../components/LegalEntityPanel'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return { ...original, getManageable: vi.fn(), listLegalEntities: vi.fn(), getVersion: vi.fn() }
})

vi.mock('../components/LegalEntityPanel', () => ({
  default: (props: LegalEntityPanelProps) => {
    const shown = props.draft ?? detailsOf(props.entity)
    return (
      <div data-testid="fake-panel" data-entity={props.entity.entity} data-view={props.view} data-can-change={String(props.canChange)}>
        <label>
          Legal name
          <input
            value={shown.legalName}
            onChange={(event) => props.onDraftChange({ ...shown, legalName: event.target.value })}
          />
        </label>
        <button onClick={() => props.onViewChange(props.view === 'details' ? 'history' : 'details')}>toggle view</button>
        <button onClick={() => props.onVersionChange(2)}>open version 2</button>
        <button onClick={() => props.onVersionChange(undefined)}>close version</button>
        <button onClick={() => props.onLost()}>lose grant</button>
        <button onClick={() => props.onDraftChange(undefined)}>drop draft</button>
        <button
          onClick={() =>
            props.onEntityChange({ ...props.entity, version: props.entity.version + 1, complete: false, missing: ['vatNumber'] })
          }
        >
          reload entity
        </button>
        <span data-testid="fake-version">{String(props.version)}</span>
      </div>
    )
  },
}))

const tab = (entity: 'IT' | 'CH') => screen.getByRole('tab', { name: new RegExp(entity === 'IT' ? '^WellD Italia' : '^WellD CH') })
const nameInput = () => within(screen.getByTestId('fake-panel')).getByLabelText('Legal name') as HTMLInputElement

const open = async (path = '/legal-entities', options: { browserHistory?: boolean } = {}) => {
  vi.mocked(getManageable).mockResolvedValue(['welld_it', 'welld_ch'])
  vi.mocked(listLegalEntities).mockResolvedValue([entityFixture('welld_it'), entityFixture('welld_ch')])
  const view = renderPage(path, options)
  await screen.findByTestId('fake-panel')
  return view
}

beforeEach(() => {
  vi.mocked(getManageable).mockReset()
  vi.mocked(listLegalEntities).mockReset()
})

afterEach(cleanup)

describe('per-entity drafts (S1, F3b)', () => {
  it('marks only the entity with a draft "Unsaved changes", in words, in the name of its tab', async () => {
    const user = userEvent.setup()
    await open()

    await user.type(nameInput(), ' Group')

    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete, Unsaved changes' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'WellD CH, Complete' })).toBeTruthy()
    // A visible mark as well, not only a name.
    expect(within(tab('IT')).getAllByText('Unsaved changes').length).toBeGreaterThan(0)
  })

  it('keeps each entity\'s draft when the other tab is selected and back, and never asks', async () => {
    const user = userEvent.setup()
    await open()

    await user.type(nameInput(), ' Group')
    await user.click(tab('CH'))
    expect(screen.getByTestId('fake-panel').getAttribute('data-entity')).toBe('welld_ch')
    expect(nameInput().value).toBe('wellD AG')
    await user.type(nameInput(), ' Holding')

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete, Unsaved changes' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'WellD CH, Complete, Unsaved changes' })).toBeTruthy()

    await user.click(tab('IT'))
    expect(nameInput().value).toBe('wellD S.r.l. Group')
    await user.click(tab('CH'))
    expect(nameInput().value).toBe('wellD AG Holding')
  })

  it('keeps a draft across the Details | History switch and across opening and closing a version', async () => {
    const user = userEvent.setup()
    const { router } = await open('/legal-entities?entity=welld_it')

    await user.type(nameInput(), ' Group')
    await user.click(screen.getByText('toggle view'))
    await waitFor(() => expect(screen.getByTestId('fake-panel').getAttribute('data-view')).toBe('history'))
    expect(router.state.location.search).toEqual({ entity: 'welld_it', view: 'history' })

    await user.click(screen.getByText('open version 2'))
    await waitFor(() => expect(screen.getByTestId('fake-version').textContent).toBe('2'))
    expect(router.state.location.search).toEqual({ entity: 'welld_it', view: 'history', version: 2 })
    await user.click(screen.getByText('close version'))
    await waitFor(() => expect(screen.getByTestId('fake-version').textContent).toBe('undefined'))
    await user.click(screen.getByText('toggle view'))

    expect(await screen.findByDisplayValue('wellD S.r.l. Group')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('pushes a history entry for a version, and replaces it for an entity or a view', async () => {
    const user = userEvent.setup()
    const { router } = await open('/legal-entities?entity=welld_it')
    const length = router.history.length

    await user.click(screen.getByText('toggle view'))
    await user.click(tab('CH'))
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch' }))
    expect(router.history.length).toBe(length)

    await user.click(screen.getByText('toggle view'))
    await user.click(screen.getByText('open version 2'))
    await waitFor(() => expect(router.state.location.search).toEqual({ entity: 'welld_ch', view: 'history', version: 2 }))
    expect(router.history.length).toBe(length + 1)
  })

  it('does not count a draft that is the saved details once normalised (blanks only) as unsaved', async () => {
    const user = userEvent.setup()
    await open()

    await user.type(nameInput(), '   ')
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete' })).toBeTruthy()

    await user.type(nameInput(), 'X')
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete, Unsaved changes' })).toBeTruthy()
    await user.clear(nameInput())
    await user.type(nameInput(), 'wellD S.r.l.')
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete' })).toBeTruthy()
  })

  it('drops the draft and the mark when the panel says so (a save, Discard)', async () => {
    const user = userEvent.setup()
    await open()

    await user.type(nameInput(), ' Group')
    await user.click(screen.getByText('drop draft'))

    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete' })).toBeTruthy()
    expect(nameInput().value).toBe('wellD S.r.l.')
  })

  it('takes a re-read entity from the panel: the tab shows its new status', async () => {
    const user = userEvent.setup()
    await open()

    await user.click(screen.getByText('reload entity'))

    expect(await screen.findByRole('tab', { name: 'WellD Italia, Incomplete' })).toBeTruthy()
  })

  it('turns an entity read-only and drops its draft when the grant is lost (403), the other keeps its draft', async () => {
    const user = userEvent.setup()
    await open()

    await user.type(nameInput(), ' Group')
    await user.click(tab('CH'))
    await user.type(nameInput(), ' Holding')
    await user.click(screen.getByText('lose grant'))

    expect(screen.getByRole('tab', { name: 'WellD CH, Complete, Read-only' })).toBeTruthy()
    expect(screen.getByTestId('fake-panel').getAttribute('data-can-change')).toBe('false')
    expect(nameInput().value).toBe('wellD AG')
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete, Unsaved changes' })).toBeTruthy()
  })
})

describe('leaving the page (S2 state 10, AC-1.1 no data loss)', () => {
  it('leaves without a question when nothing is unsaved', async () => {
    const user = userEvent.setup()
    await open()

    await user.click(screen.getByTestId('to-roles'))

    expect(await screen.findByTestId('roles-page')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('asks "Leave without saving?", naming the entity, when a link out is followed with a draft', async () => {
    const user = userEvent.setup()
    const { router } = await open()
    await user.type(nameInput(), ' Group')

    await user.click(screen.getByTestId('to-roles'))

    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' })
    expect(dialog.textContent).toContain('Your changes to WellD Italia have not been saved and will be lost.')
    expect(router.state.location.pathname).toBe('/legal-entities')
    expect(screen.queryByTestId('roles-page')).toBeNull()
  })

  it('names every entity with unsaved changes', async () => {
    const user = userEvent.setup()
    await open()
    await user.type(nameInput(), ' Group')
    await user.click(tab('CH'))
    await user.type(nameInput(), ' Holding')

    await user.click(screen.getByTestId('to-roles'))

    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' })
    expect(dialog.textContent).toContain('Your changes to WellD Italia and WellD CH have not been saved')
  })

  it('keeps everything on "Keep editing" and goes on, dropping the drafts, on "Discard changes"', async () => {
    const user = userEvent.setup()
    await open()
    await user.type(nameInput(), ' Group')

    await user.click(screen.getByTestId('to-roles'))
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(nameInput().value).toBe('wellD S.r.l. Group')
    expect(screen.getByRole('tab', { name: 'WellD Italia, Complete, Unsaved changes' })).toBeTruthy()

    await user.click(screen.getByTestId('to-roles'))
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }))
    expect(await screen.findByTestId('roles-page')).toBeTruthy()
  })

  it('does not ask again after a draft was dropped', async () => {
    const user = userEvent.setup()
    await open()
    await user.type(nameInput(), ' Group')
    await user.click(screen.getByText('drop draft'))

    await user.click(screen.getByTestId('to-roles'))

    expect(await screen.findByTestId('roles-page')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('asks before a reload or a closed tab (beforeunload) only while something is unsaved', async () => {
    const user = userEvent.setup()
    const { router } = await open('/legal-entities', { browserHistory: true })
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(false)

    await user.type(nameInput(), ' Group')
    await waitFor(() => expect(unload()).toBe(true))

    await user.click(screen.getByText('drop draft'))
    await waitFor(() => expect(unload()).toBe(false))
    router.history.destroy()
  })

  it('never asks for what is not leaving the page: entity tabs, view tabs, a search change', async () => {
    const user = userEvent.setup()
    const { router } = await open()
    await user.type(nameInput(), ' Group')

    await user.click(tab('CH'))
    await user.click(screen.getByText('toggle view'))
    await router.navigate({ to: '/legal-entities', search: { entity: 'welld_it' } })

    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.keyDown(screen.getByRole('tablist', { name: 'Legal entities' }), { key: 'ArrowLeft' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
