import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button'
import { PersonPicker } from './PersonPicker'
import type { Person, PersonChoice, PersonLoadFailure, PersonPickerProps } from './PersonPicker'

/**
 * Choose an Operai user from a list the app loads (`load` is injected: the
 * library cannot call an API). The list is fetched once and filtered in the
 * browser by name or email, so what is typed never leaves it. Built on
 * `Combobox`, so it is fully keyboard operable. A caller the list refuses sees
 * their current choice read-only; a rate-limited list says when to retry.
 * `clearOnSelect` turns it into an "add to a list" control; `exclude` hides
 * people already added.
 */
const meta = {
  title: 'Components/Forms/PersonPicker',
  component: PersonPicker,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="min-h-64 w-96 max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PersonPicker>
export default meta

type Story = StoryObj<typeof meta>

const PEOPLE: Person[] = [
  { id: 'u1', name: 'Anna Rossi', email: 'anna.rossi@welld.ch' },
  { id: 'u2', name: 'Bruno Bianchi', email: 'bruno.bianchi@welld.ch' },
  { id: 'u3', name: 'Chiara Verdi', email: 'chiara.verdi@welld.ch' },
  { id: 'u4', name: null, email: 'new.joiner@welld.ch' },
]

const copy: PersonPickerProps['copy'] = {
  loading: 'Loading people…',
  noMatch: 'No people match.',
  failed: 'The list of people could not be loaded.',
  noName: 'No name',
  results: (count) => (count === 1 ? '1 person' : `${count} people`),
  rateLimited: (seconds) => `Too many lookups. Try again in ${seconds} seconds.`,
  unavailableHint: 'Only people who manage deals can choose someone else.',
}

const loadPeople = () => new Promise<Person[]>((resolve) => setTimeout(() => resolve(PEOPLE), 300))

function Controlled(props: Partial<PersonPickerProps> & { initial?: PersonChoice | null }) {
  const { initial = null, ...rest } = props
  const [value, setValue] = useState<PersonChoice | null>(initial)
  return (
    <PersonPicker
      label="Owner"
      load={loadPeople}
      copy={copy}
      testId="story-person"
      {...rest}
      value={value}
      onChange={setValue}
    />
  )
}

export const Playground: Story = {
  args: { label: 'Owner', load: loadPeople, copy, value: null, onChange: () => {}, testId: 'story-person' },
  render: () => <Controlled />,
}

export const Required: Story = {
  args: Playground.args!,
  render: () => <Controlled required error="Choose a person from the list." />,
}

export const WithExcluded: Story = {
  name: 'Excluding people already chosen',
  args: Playground.args!,
  render: () => <Controlled exclude={['u1', 'u2']} />,
}

/** Each pick is reported and the field empties, ready for the next one. */
export const AddToAList: Story = {
  name: 'Add to a list (clearOnSelect)',
  args: Playground.args!,
  render: function Render() {
    const [chosen, setChosen] = useState<PersonChoice[]>([])
    return (
      <div className="flex flex-col gap-3">
        <PersonPicker
          label="Participants"
          load={loadPeople}
          copy={copy}
          testId="story-participants"
          value={null}
          exclude={chosen.map((person) => person.id)}
          clearOnSelect
          onChange={(next) => next && setChosen((list) => [...list, next])}
        />
        <ul className="flex flex-wrap gap-2">
          {chosen.map((person) => (
            <li
              key={person.id}
              className="flex items-center gap-1 rounded-md border border-rule bg-ink-soft py-0.5 pr-0.5 pl-2 text-sm"
            >
              {person.label}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setChosen((list) => list.filter((p) => p.id !== person.id))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      </div>
    )
  },
}

export const LoadFailed: Story = {
  name: 'Could not load',
  args: Playground.args!,
  render: () => <Controlled load={() => Promise.reject(new Error('down'))} />,
}

export const RateLimited: Story = {
  name: 'Rate limited',
  args: Playground.args!,
  render: () => (
    <Controlled
      load={() => Promise.reject(new Error('429'))}
      classifyError={(): PersonLoadFailure => ({ kind: 'rate_limited', retryAfterSeconds: 30 })}
    />
  ),
}

/** The caller may not list people: the current choice stays, read-only. */
export const Forbidden: Story = {
  args: Playground.args!,
  render: () => (
    <Controlled
      initial={{ id: 'me', label: 'Matteo Codogno' }}
      load={() => Promise.reject(new Error('403'))}
      classifyError={(): PersonLoadFailure => ({ kind: 'forbidden' })}
    />
  ),
}
