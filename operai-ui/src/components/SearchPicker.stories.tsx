import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SearchPicker } from './SearchPicker'
import type { SearchPickerProps, SearchResult } from './SearchPicker'

/**
 * Pick one record out of a search the **server** answers — a project, a deal, a company — where
 * `PersonPicker` filters a list it already holds and `Combobox` leaves everything to the caller. It
 * is a `Combobox` in a `Field` that owns the rest of the behaviour: the wait before it searches
 * (250 ms), aborting a request the text has outrun and discarding a late answer, "picked, never
 * typed" (typing after a pick reports `null`; free text is never reported), what the list says
 * while it has no options (searching, no match, forbidden, unavailable — each also announced
 * politely) and the number of results.
 *
 * The app injects `search` (the library cannot call an API; it maps its own 403 and 503 to
 * `forbidden` and `unavailable`), `toOption` and every string. Keyboard as `Combobox`: ↓/↑,
 * Home/End, Enter picks, Escape closes, Tab leaves without picking. Switch the theme in the
 * toolbar to see each state in both themes; the state stories open their list by themselves.
 */
const meta = {
  title: 'Components/Forms/SearchPicker',
  component: SearchPicker,
  tags: ['autodocs'],
  parameters: { controls: { disable: true }, docs: { story: { inline: false, iframeHeight: 380 } } },
  decorators: [
    (Story) => (
      <div className="min-h-72 w-96 max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchPicker>
export default meta

type Story = StoryObj

type Project = { id: string; name: string; client: string }

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Portale clienti', client: 'Banca Ticino' },
  { id: 'p2', name: 'Portale fornitori', client: 'Energia Sud' },
  { id: 'p3', name: 'App di prenotazione', client: 'Clinica Verde' },
  { id: 'p4', name: 'Migrazione cloud', client: 'Banca Ticino' },
  { id: 'p5', name: 'Cruscotto vendite', client: 'Moda Lombarda' },
]

const messages: SearchPickerProps<Project>['messages'] = {
  searching: 'Searching…',
  noMatch: 'No projects match.',
  forbidden: 'You can’t search projects.',
  unavailable: 'The search is unavailable. Try again.',
  count: (n) => (n === 1 ? '1 project' : `${n} projects`),
}

const toOption: SearchPickerProps<Project>['toOption'] = (project) => ({
  id: project.id,
  label: project.name,
  secondaryLabel: project.client,
})

/** A server that answers after half a second and stops when the request is aborted. */
const searchProjects: SearchPickerProps<Project>['search'] = (q, signal) =>
  new Promise<SearchResult<Project>>((resolve, reject) => {
    const needle = q.toLowerCase()
    const timer = setTimeout(
      () =>
        resolve({
          ok: true,
          items: PROJECTS.filter((p) => `${p.name} ${p.client}`.toLowerCase().includes(needle)),
        }),
      500,
    )
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

const never: SearchPickerProps<Project>['search'] = () => new Promise(() => {})
const answers =
  (result: SearchResult<Project>): SearchPickerProps<Project>['search'] =>
  () =>
    Promise.resolve(result)

function Controlled({ initial = null, ...rest }: Partial<SearchPickerProps<Project>> & { initial?: Project | null }) {
  const [value, setValue] = useState<Project | null>(initial)
  return (
    <>
      <SearchPicker<Project>
        label="Project"
        hint="You can record hours on projects where you are the project manager or on the team."
        search={searchProjects}
        toOption={toOption}
        messages={messages}
        testId="story-project"
        {...rest}
        value={value}
        onChange={setValue}
      />
      <p className="mt-3 text-sm text-soft">Picked: {value ? value.name : 'nothing yet'}</p>
    </>
  )
}

/** Opens the list as soon as the story renders, so a state that lives in the popup is on screen. */
const openOnLoad: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus()
}

/** Focus the field to see the first projects, type to narrow them; pick one, then type again to see it clear. */
export const Playground: Story = {
  render: () => <Controlled />,
}

export const Picked: Story = {
  render: () => <Controlled initial={PROJECTS[0]} />,
}

/** Required and invalid, as after a failed save: the error and the red border come from the Field. */
export const RequiredWithError: Story = {
  name: 'Required, with an error',
  render: () => <Controlled required error="Choose a project from the list." />,
}

export const Disabled: Story = {
  name: 'Disabled, while a dialog saves',
  render: () => <Controlled initial={PROJECTS[1]} disabled />,
}

/** The answer for this text has not arrived: the list says so, and screen readers hear it too. */
export const Searching: Story = {
  render: () => <Controlled search={never} />,
  play: openOnLoad,
}

export const NoMatch: Story = {
  name: 'No match',
  render: () => <Controlled search={answers({ ok: true, items: [] })} />,
  play: openOnLoad,
}

/** The caller may not search this kind of record (the app mapped a 403); other targets may still work. */
export const Forbidden: Story = {
  render: () => <Controlled search={answers({ ok: false, reason: 'forbidden' })} />,
  play: openOnLoad,
}

/** The service could not answer (a 503 or a network failure): not an empty result. */
export const Unavailable: Story = {
  render: () => <Controlled search={answers({ ok: false, reason: 'unavailable' })} />,
  play: openOnLoad,
}

/**
 * The app can hand the picker a placeholder as its value, for a record the person may not read: the
 * field shows it, and typing replaces it (the picker reports `null`) like any other picked value.
 */
export const PlaceholderValue: Story = {
  name: 'A value shown as a placeholder',
  render: () => (
    <Controlled
      initial={{ id: 'hidden', name: 'Not visible to you', client: '' }}
      hint="You can’t open this project, so its name isn’t shown. The entry stays on it unless you choose another."
    />
  ),
}
