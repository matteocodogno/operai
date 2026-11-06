import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { PersonPicker } from './PersonPicker'
import type { Person, PersonChoice, PersonLoadFailure, PersonPickerProps } from './PersonPicker'

afterEach(cleanup)

const PEOPLE: Person[] = [
  { id: 'u1', name: 'Anna Rossi', email: 'anna.rossi@welld.ch' },
  { id: 'u2', name: 'Bruno Bianchi', email: 'bruno@welld.ch' },
  { id: 'u3', name: null, email: 'nameless@welld.ch' },
]

const copy: PersonPickerProps['copy'] = {
  loading: 'Loading people…',
  noMatch: 'No people match.',
  failed: 'The list could not be loaded.',
  noName: 'No name',
  results: (count) => `${count} found`,
  rateLimited: (seconds) => `Too many lookups. Try again in ${seconds} seconds.`,
  unavailableHint: 'Only managers can choose someone else.',
}

type HarnessProps = Partial<PersonPickerProps> & { initial?: PersonChoice | null }

function Harness({ initial = null, ...rest }: HarnessProps) {
  const [value, setValue] = useState<PersonChoice | null>(initial)
  return (
    <PersonPicker
      label="Owner"
      copy={copy}
      load={() => Promise.resolve(PEOPLE)}
      value={value}
      onChange={(next) => {
        setValue(next)
        rest.onChange?.(next)
      }}
      testId="owner"
      {...rest}
    />
  )
}

const input = () => screen.getByTestId('owner-input') as HTMLInputElement

/** Renders, lets the loader settle, and opens the list. */
async function open(props: HarnessProps = {}) {
  render(<Harness {...props} />)
  await act(async () => {})
  fireEvent.focus(input())
}

const optionLabels = () => screen.queryAllByRole('option').map((o) => o.textContent)

describe('PersonPicker', () => {
  it('shows the loading line until the list arrives, then the people with their email', async () => {
    let resolve!: (people: Person[]) => void
    const load = () => new Promise<Person[]>((r) => (resolve = r))
    render(<Harness load={load} />)
    fireEvent.focus(input())
    expect(screen.getByText('Loading people…')).toBeInTheDocument()
    await act(async () => resolve(PEOPLE))
    expect(optionLabels()).toEqual([
      'Anna Rossianna.rossi@welld.ch',
      'Bruno Bianchibruno@welld.ch',
      'No namenameless@welld.ch',
    ])
  })

  it('filters by name or email, ignoring case, client-side', async () => {
    const load = vi.fn(() => Promise.resolve(PEOPLE))
    await open({ load })
    fireEvent.change(input(), { target: { value: 'BRUNO' } })
    expect(optionLabels()).toEqual(['Bruno Bianchibruno@welld.ch'])
    fireEvent.change(input(), { target: { value: 'rossi@welld' } })
    expect(optionLabels()).toEqual(['Anna Rossianna.rossi@welld.ch'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('says nothing matches, and announces the count politely', async () => {
    await open()
    expect(screen.getByTestId('owner-input-live')).toHaveTextContent('3 found')
    fireEvent.change(input(), { target: { value: 'zzz' } })
    expect(screen.getByText('No people match.')).toBeInTheDocument()
    expect(screen.getByTestId('owner-input-live')).toHaveTextContent('0 found')
  })

  it('does not offer excluded people', async () => {
    await open({ exclude: ['u1', 'u3'] })
    expect(optionLabels()).toEqual(['Bruno Bianchibruno@welld.ch'])
  })

  it('offers at most maxOptions people', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, email: `p${i}@welld.ch` }))
    await open({ load: () => Promise.resolve(many) })
    expect(screen.getAllByRole('option')).toHaveLength(20)
  })

  it('reports the chosen person as {id, label} and keeps the name in the field', async () => {
    const onChange = vi.fn()
    await open({ onChange })
    fireEvent.click(screen.getByTestId('owner-input-option-u2'))
    expect(onChange).toHaveBeenCalledWith({ id: 'u2', label: 'Bruno Bianchi' })
    expect(input().value).toBe('Bruno Bianchi')
  })

  it('labels a person with no name from the copy', async () => {
    const onChange = vi.fn()
    await open({ onChange })
    fireEvent.click(screen.getByTestId('owner-input-option-u3'))
    expect(onChange).toHaveBeenCalledWith({ id: 'u3', label: 'No name' })
  })

  it('empties the field after a choice with clearOnSelect (a picker that adds to a list)', async () => {
    const onChange = vi.fn()
    await open({ onChange, clearOnSelect: true })
    fireEvent.click(screen.getByTestId('owner-input-option-u1'))
    expect(onChange).toHaveBeenCalledWith({ id: 'u1', label: 'Anna Rossi' })
    expect(input().value).toBe('')
  })

  it('clears the choice as soon as the text no longer matches it', async () => {
    const onChange = vi.fn()
    await open({ onChange, initial: { id: 'u1', label: 'Anna Rossi' } })
    expect(input().value).toBe('Anna Rossi')
    fireEvent.change(input(), { target: { value: 'Anna Ros' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('selects with the keyboard alone', async () => {
    const onChange = vi.fn()
    await open({ onChange })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ id: 'u2', label: 'Bruno Bianchi' })
  })

  it('wires the field error and required marker to the input', async () => {
    await open({ error: 'Choose a person from the list.', required: true })
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(input()).toHaveAttribute('aria-required', 'true')
    expect(screen.getByText('Choose a person from the list.')).toBeInTheDocument()
  })

  it('shows the failure line when the list cannot be loaded', async () => {
    await open({ load: () => Promise.reject(new Error('boom')) })
    expect(screen.getByText('The list could not be loaded.')).toBeInTheDocument()
    expect(screen.getByTestId('owner-input-live')).toHaveTextContent('')
  })

  it('says when to retry for a rate-limited load, as classified by the app', async () => {
    const classifyError = (): PersonLoadFailure => ({ kind: 'rate_limited', retryAfterSeconds: 30 })
    await open({ load: () => Promise.reject(new Error('429')), classifyError })
    expect(screen.getByText('Too many lookups. Try again in 30 seconds.')).toBeInTheDocument()
  })

  it('falls back to the plain failure line when the app classifier does not recognise the error', async () => {
    await open({ load: () => Promise.reject(new Error('x')), classifyError: () => ({ kind: 'failed' }) })
    expect(screen.getByText('The list could not be loaded.')).toBeInTheDocument()
  })

  it('shows the current choice read-only, with the hint, when the app says the list is forbidden', async () => {
    render(
      <Harness
        initial={{ id: 'me', label: 'Me Myself' }}
        load={() => Promise.reject(new Error('403'))}
        classifyError={() => ({ kind: 'forbidden' })}
      />,
    )
    await act(async () => {})
    const readonly = screen.getByTestId('owner-readonly') as HTMLInputElement
    expect(readonly).toHaveAttribute('readonly')
    expect(readonly.value).toBe('Me Myself')
    expect(screen.getByText('Only managers can choose someone else.')).toBeInTheDocument()
    expect(screen.queryByTestId('owner-input')).not.toBeInTheDocument()
  })

  it('loads once, even when the app passes a new loader function on every render', async () => {
    const load = vi.fn(() => Promise.resolve(PEOPLE))
    const { rerender } = render(<Harness load={() => load()} />)
    await act(async () => {})
    rerender(<Harness load={() => load()} />)
    rerender(<Harness load={() => load()} />)
    await act(async () => {})
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('loads again when loadKey changes (another audience), using the latest loader', async () => {
    const first = vi.fn(() => Promise.resolve(PEOPLE))
    const second = vi.fn(() => Promise.resolve([PEOPLE[1]!]))
    const { rerender } = render(<Harness load={first} loadKey="crm" />)
    await act(async () => {})
    rerender(<Harness load={second} loadKey="estimai" />)
    await act(async () => {})
    fireEvent.focus(input())
    expect(second).toHaveBeenCalledTimes(1)
    expect(optionLabels()).toEqual(['Bruno Bianchibruno@welld.ch'])
  })

  it('aborts the request on unmount and ignores a late answer', async () => {
    let signal!: AbortSignal
    let resolve!: (people: Person[]) => void
    const load = (s: AbortSignal) => {
      signal = s
      return new Promise<Person[]>((r) => (resolve = r))
    }
    const { unmount } = render(<Harness load={load} />)
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(PEOPLE))
  })
})
