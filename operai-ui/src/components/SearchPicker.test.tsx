/**
 * @vitest-environment jsdom
 *
 * SearchPicker (specs/029, T4; AC-2.2, AC-2.3, AC-2.5, AC-4.4): the server-side search in a
 * `Field`-wrapped `Combobox`. The app's `search` is a hand-resolved promise per call, so a test
 * decides when each answer arrives, in which order, and whether it honours the abort signal.
 * Timers are fake: the debounce is part of the behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { Dialog } from './Dialog'
import { SearchPicker } from './SearchPicker'
import type { SearchPickerProps, SearchResult } from './SearchPicker'

type Project = { id: string; name: string; city?: string }

const ALPHA: Project = { id: 'p1', name: 'Project Alpha', city: 'Lugano' }
const BETA: Project = { id: 'p2', name: 'Project Beta' }
const GAMMA: Project = { id: 'p3', name: 'Project Gamma' }

const messages: SearchPickerProps<Project>['messages'] = {
  searching: 'Searching projects…',
  noMatch: 'No projects match.',
  forbidden: 'You can’t search projects.',
  unavailable: 'The search is unavailable. Try again.',
  count: (n) => `${n} projects found`,
}

type Call = {
  q: string
  signal: AbortSignal
  resolve: (result: SearchResult<Project>) => void
  reject: (reason: unknown) => void
}

/** A `search` whose every call stays pending until the test answers it. */
function pendingSearch() {
  const calls: Call[] = []
  const search = vi.fn(
    (q: string, signal: AbortSignal) =>
      new Promise<SearchResult<Project>>((resolve, reject) => {
        calls.push({ q, signal, resolve, reject })
      }),
  )
  return { calls, search }
}

type HarnessProps = Partial<SearchPickerProps<Project>> & { initial?: Project | null }

function Harness({ initial = null, onChange, ...rest }: HarnessProps) {
  const [value, setValue] = useState<Project | null>(initial)
  return (
    <SearchPicker<Project>
      label="Project"
      search={() => Promise.resolve({ ok: true, items: [] })}
      toOption={(project) => ({ id: project.id, label: project.name, secondaryLabel: project.city })}
      messages={messages}
      testId="project"
      {...rest}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

const input = () => screen.getByTestId('project-input') as HTMLInputElement
const listbox = () => screen.queryByTestId('project-input-listbox')
const live = () => screen.getByTestId('project-input-live')
const optionLabels = () => screen.queryAllByRole('option').map((option) => option.firstElementChild?.textContent)

const type = (text: string) => fireEvent.change(input(), { target: { value: text } })
// Real focus and blur, as a browser does them: picking an option focuses the input again.
const focus = () => act(() => input().focus())
const blur = () => act(() => input().blur())

/** Moves the fake clock, letting promise callbacks and React effects run. */
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

const answer = (call: Call, result: SearchResult<Project>) =>
  act(async () => {
    call.resolve(result)
  })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SearchPicker: searching', () => {
  it('searches once, with the text, when typing settles (250 ms by default)', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    type('a')
    await wait(100)
    type('al')
    await wait(100)
    type('alp')
    await wait(249)
    expect(search).not.toHaveBeenCalled()
    await wait(1)
    expect(search).toHaveBeenCalledTimes(1)
    expect(calls[0].q).toBe('alp')
    expect(calls[0].signal.aborted).toBe(false)
  })

  it('waits `delayMs` when it is given', async () => {
    const { search } = pendingSearch()
    render(<Harness search={search} delayMs={50} />)
    focus()
    type('al')
    await wait(49)
    expect(search).not.toHaveBeenCalled()
    await wait(1)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('searches with an empty text when the list opens on an empty field', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    await wait(250)
    expect(calls.map((call) => call.q)).toEqual([''])
  })

  it('does not search while the list is closed', async () => {
    const { search } = pendingSearch()
    render(<Harness search={search} />)
    await wait(1000)
    expect(search).not.toHaveBeenCalled()
  })

  it('searches the trimmed text, and typing a space around it asks nothing new', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    type(' alp')
    await wait(250)
    expect(calls.map((call) => call.q)).toEqual(['alp'])
    await answer(calls[0], { ok: true, items: [ALPHA] })
    type(' alp ')
    await wait(1000)
    expect(search).toHaveBeenCalledTimes(1)
    expect(optionLabels()).toEqual(['Project Alpha'])
  })

  it('aborts the previous request on a new query and discards its late answer', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    type('a')
    await wait(250)
    type('ab')
    await wait(250)
    expect(calls.map((call) => call.q)).toEqual(['a', 'ab'])
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[1].signal.aborted).toBe(false)

    // A search that ignores the signal still answers the old query: that answer must not show.
    await answer(calls[0], { ok: true, items: [ALPHA] })
    expect(optionLabels()).toEqual([])
    expect(listbox()).toHaveTextContent('Searching projects…')

    await answer(calls[1], { ok: true, items: [BETA] })
    expect(optionLabels()).toEqual(['Project Beta'])
  })

  it('never lets an old answer that arrives after a newer one replace it', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    type('a')
    await wait(250)
    type('ab')
    await wait(250)
    await answer(calls[1], { ok: true, items: [BETA] })
    await answer(calls[0], { ok: true, items: [ALPHA, GAMMA] })
    expect(optionLabels()).toEqual(['Project Beta'])
    expect(live()).toHaveTextContent('1 projects found')
  })

  it('aborts the request when the list closes and when the picker unmounts', async () => {
    const { calls, search } = pendingSearch()
    const { unmount } = render(<Harness search={search} />)
    focus()
    type('al')
    await wait(250)
    blur()
    expect(calls[0].signal.aborted).toBe(true)
    expect(listbox()).toBeNull()

    focus()
    await wait(250)
    expect(calls).toHaveLength(2)
    unmount()
    expect(calls[1].signal.aborted).toBe(true)
  })

  it('asks again each time the list opens, and says "searching" until that answer comes', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    type('al')
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA] })
    expect(optionLabels()).toEqual(['Project Alpha'])

    blur()
    focus()
    expect(optionLabels()).toEqual([])
    expect(listbox()).toHaveTextContent('Searching projects…')
    await wait(250)
    expect(calls.map((call) => call.q)).toEqual(['al', 'al'])
    await answer(calls[1], { ok: true, items: [ALPHA, BETA] })
    expect(optionLabels()).toEqual(['Project Alpha', 'Project Beta'])
  })

  it('keeps using the latest `search` without restarting the wait when the parent re-renders', async () => {
    const first = pendingSearch()
    const second = pendingSearch()
    const view = render(<Harness search={first.search} />)
    focus()
    type('alp')
    await wait(200)
    view.rerender(<Harness search={second.search} />)
    await wait(49)
    expect(second.search).not.toHaveBeenCalled()
    await wait(1)
    expect(first.search).not.toHaveBeenCalled()
    expect(second.calls.map((call) => call.q)).toEqual(['alp'])
    await wait(2000)
    expect(second.search).toHaveBeenCalledTimes(1)
  })
})

describe('SearchPicker: the options', () => {
  it('lists what the search returned through `toOption`, with its second line', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA, BETA] })
    expect(optionLabels()).toEqual(['Project Alpha', 'Project Beta'])
    expect(within(screen.getAllByRole('option')[0]).getByText('Lugano')).toBeInTheDocument()
  })

  it('reports the picked item itself, shows its label and closes the list', async () => {
    const { calls, search } = pendingSearch()
    const onChange = vi.fn()
    render(<Harness search={search} onChange={onChange} />)
    focus()
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA, BETA] })
    fireEvent.click(screen.getByTestId('project-input-option-p2'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe(BETA)
    expect(input().value).toBe('Project Beta')
    expect(listbox()).toBeNull()
    await wait(1000)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('picks with the keyboard alone: arrow, Enter', async () => {
    const { calls, search } = pendingSearch()
    const onChange = vi.fn()
    render(<Harness search={search} onChange={onChange} />)
    focus()
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA, BETA] })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(BETA)
    expect(input().value).toBe('Project Beta')
  })

  it('in a dialog, the first Escape closes the list and only the next one closes the dialog', async () => {
    const { calls, search } = pendingSearch()
    const onClose = vi.fn()
    render(
      <Dialog title="Record hours" onClose={onClose}>
        <Harness search={search} />
      </Dialog>,
    )
    focus()
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA] })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(listbox()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves with Tab or Escape without picking anything', async () => {
    const { calls, search } = pendingSearch()
    const onChange = vi.fn()
    render(<Harness search={search} onChange={onChange} />)
    focus()
    type('pro')
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA] })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(listbox()).toBeNull()
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('pro')
  })
})

describe('SearchPicker: picked, never typed', () => {
  it('shows the label of the value it starts with', () => {
    render(<Harness initial={ALPHA} />)
    expect(input().value).toBe('Project Alpha')
  })

  it('reports null once when typing after a pick, then keeps the typed text', () => {
    const onChange = vi.fn()
    render(<Harness initial={ALPHA} onChange={onChange} />)
    focus()
    type('Project Alph')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(input().value).toBe('Project Alph')
    type('Project Al')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('Project Al')
  })

  it('lets the person empty the field after a pick', () => {
    const onChange = vi.fn()
    render(<Harness initial={ALPHA} onChange={onChange} />)
    focus()
    type('')
    expect(onChange).toHaveBeenCalledWith(null)
    expect(input().value).toBe('')
  })

  it('never reports free text: typing with nothing picked reports nothing', async () => {
    const { calls, search } = pendingSearch()
    const onChange = vi.fn()
    render(<Harness search={search} onChange={onChange} />)
    focus()
    type('Project Al')
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA] })
    blur()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('follows the value when the app changes it: another item, a reset, a new object for the same item', () => {
    const view = render(<Harness initial={null} />)
    // `Harness` owns its value, so drive the controlled component directly for the app-side changes.
    view.unmount()
    const onChange = vi.fn()
    const toOption = (project: Project) => ({ id: project.id, label: project.name })
    const search = () => Promise.resolve<SearchResult<Project>>({ ok: true, items: [] })
    const props = { label: 'Project', search, toOption, messages, testId: 'project', onChange }
    const controlled = render(<SearchPicker<Project> {...props} value={ALPHA} />)
    expect(input().value).toBe('Project Alpha')
    controlled.rerender(<SearchPicker<Project> {...props} value={BETA} />)
    expect(input().value).toBe('Project Beta')
    controlled.rerender(<SearchPicker<Project> {...props} value={null} />)
    expect(input().value).toBe('')
    // A half-typed text is dropped when the app sets a value (a form reset).
    focus()
    type('zzz')
    expect(input().value).toBe('zzz')
    controlled.rerender(<SearchPicker<Project> {...props} value={GAMMA} />)
    expect(input().value).toBe('Project Gamma')
    // A new object for the same item on every render settles, and a rename shows.
    controlled.rerender(<SearchPicker<Project> {...props} value={{ ...GAMMA }} />)
    controlled.rerender(<SearchPicker<Project> {...props} value={{ ...GAMMA, name: 'Project Gamma 2' }} />)
    expect(input().value).toBe('Project Gamma 2')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('SearchPicker: what the list says', () => {
  const states: Array<[string, SearchResult<Project> | 'rejects' | 'throws', string]> = [
    ['no match', { ok: true, items: [] }, messages.noMatch],
    ['forbidden', { ok: false, reason: 'forbidden' }, messages.forbidden],
    ['unavailable', { ok: false, reason: 'unavailable' }, messages.unavailable],
    ['a rejected search', 'rejects', messages.unavailable],
    ['a search that throws', 'throws', messages.unavailable],
  ]

  it('says it is searching until the answer for this text arrives, in the list and politely', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    type('al')
    expect(listbox()?.textContent).toBe(messages.searching)
    expect(live()).toHaveTextContent(messages.searching)
    await wait(250)
    expect(listbox()?.textContent).toBe(messages.searching)
    await answer(calls[0], { ok: true, items: [ALPHA] })
    expect(listbox()?.textContent).not.toContain(messages.searching)
  })

  it.each(states)('says so for %s, in the list and politely', async (_name, outcome, text) => {
    const { calls, search } = pendingSearch()
    const throwing = vi.fn((): Promise<SearchResult<Project>> => {
      throw new Error('boom')
    })
    render(<Harness search={outcome === 'throws' ? throwing : search} />)
    focus()
    type('al')
    await wait(250)
    if (outcome === 'rejects') await act(async () => calls[0].reject(new Error('503')))
    else if (outcome !== 'throws') await answer(calls[0], outcome)
    expect(listbox()?.textContent).toBe(text)
    expect(live()).toHaveTextContent(text)
    expect(optionLabels()).toEqual([])
  })

  it('announces the number of results politely, and stays silent when the list is closed', async () => {
    const { calls, search } = pendingSearch()
    render(<Harness search={search} />)
    focus()
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA, BETA, GAMMA] })
    expect(live()).toHaveAttribute('aria-live', 'polite')
    expect(live()).toHaveTextContent('3 projects found')
    expect(listbox()?.textContent).not.toContain('3 projects found')
    blur()
    expect(live()).toBeEmptyDOMElement()
  })

  it('takes every word it shows from its props', async () => {
    const italian: SearchPickerProps<Project>['messages'] = {
      searching: 'Ricerca in corso…',
      noMatch: 'Nessun progetto.',
      forbidden: 'Non puoi cercare.',
      unavailable: 'Ricerca non disponibile.',
      count: (n) => `${n} trovati`,
    }
    const { calls, search } = pendingSearch()
    render(<Harness search={search} messages={italian} label="Progetto" hint="Scegli dalla lista." />)
    focus()
    expect(listbox()?.textContent).toBe('Ricerca in corso…')
    await wait(250)
    await answer(calls[0], { ok: true, items: [ALPHA] })
    expect(live()).toHaveTextContent('1 trovati')
    expect(screen.getByLabelText('Progetto')).toBe(input())
    expect(screen.getByText('Scegli dalla lista.')).toBeInTheDocument()
  })
})

describe('SearchPicker: the field', () => {
  it('is a combobox named by its label and described by its hint', () => {
    render(<Harness hint="You can record hours on your projects." />)
    const combobox = screen.getByRole('combobox', { name: 'Project' })
    expect(combobox).toBe(input())
    const hint = screen.getByText('You can record hours on your projects.')
    expect(combobox.getAttribute('aria-describedby')).toContain(hint.id)
    expect(combobox).not.toHaveAttribute('aria-invalid')
    expect(combobox).not.toHaveAttribute('aria-required')
  })

  it('marks a required field and shows its error on the field', () => {
    render(<Harness required error="Choose a project from the list." hint="A hint." />)
    const combobox = screen.getByRole('combobox', { name: /Project/ })
    expect(combobox).toHaveAttribute('aria-required', 'true')
    expect(combobox).toHaveAttribute('aria-invalid', 'true')
    const error = screen.getByText('Choose a project from the list.')
    expect(combobox.getAttribute('aria-describedby')).toContain(error.id)
    expect(screen.getByTestId('project')).toContainElement(error)
  })

  it('has no error text when the error is null', () => {
    render(<Harness error={null} />)
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-invalid')
  })

  it('does not open, search or take text while disabled', async () => {
    const { search } = pendingSearch()
    const onChange = vi.fn()
    const view = render(<Harness search={search} onChange={onChange} disabled initial={ALPHA} />)
    expect(input()).toHaveAttribute('aria-disabled', 'true')
    focus()
    type('zzz')
    await wait(1000)
    expect(listbox()).toBeNull()
    expect(search).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('Project Alpha')

    // Enabled again (a dialog that has finished saving): nothing was asked for, so nothing opens by itself.
    view.rerender(<Harness search={search} onChange={onChange} initial={ALPHA} />)
    await wait(1000)
    expect(listbox()).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })

  it('closes and aborts when it becomes disabled with the list open', async () => {
    const { calls, search } = pendingSearch()
    const view = render(<Harness search={search} />)
    focus()
    await wait(250)
    expect(listbox()).not.toBeNull()
    view.rerender(<Harness search={search} disabled />)
    expect(listbox()).toBeNull()
    expect(calls[0].signal.aborted).toBe(true)
  })
})
