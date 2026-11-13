/**
 * @vitest-environment jsdom
 *
 * PersonFilter — the Person select of Everyone's hours (specs/029-time-tracking T29; AC-4.4, AC-4.8; design S4
 * "Filters card"). Presentational: the page hands it the state of the read that gives it its options (the
 * `person` groups of the totals). "Everyone" first, the people in the order the server sent them, the current
 * choice always kept, and while the options load or when they failed the select stays reachable and says why
 * it does nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { strings } from '../strings'
import PersonFilter from './PersonFilter'
import type { PeopleView, PersonFilterProps } from './PersonFilter'

afterEach(() => cleanup())

const f = strings.filters.person

const ADA = { id: 'u-ada', label: 'Ada Lovelace' }
const GRACE = { id: 'u-grace', label: 'Grace Hopper' }
const GONE = { id: 'u-gone', label: 'Unknown user (deactivated)' }

const loaded = (...options: { id: string; label: string }[]): PeopleView => ({ status: 'loaded', options })

const renderFilter = (props: Partial<PersonFilterProps> & Pick<PersonFilterProps, 'people'>) => {
  const onChange = vi.fn()
  const view = render(<PersonFilter value="" onChange={onChange} {...props} />)
  return { onChange, ...view }
}

const select = () => screen.getByRole('combobox', { name: f.label }) as HTMLSelectElement
const optionTexts = () =>
  within(select())
    .getAllByRole('option')
    .map((option) => option.textContent)

describe('the options', () => {
  it('is a labelled select: "Everyone" first, then the people in the order the server sent them', () => {
    renderFilter({ people: loaded(GRACE, ADA, GONE) })
    expect(f.label).toBe('Person')
    expect(optionTexts()).toEqual(['Everyone', 'Grace Hopper', 'Ada Lovelace', 'Unknown user (deactivated)'])
  })

  it('shows Everyone when no one is chosen, and the chosen person otherwise', () => {
    const { rerender } = renderFilter({ people: loaded(ADA, GRACE) })
    expect(select().value).toBe('')
    rerender(<PersonFilter value="u-grace" people={loaded(ADA, GRACE)} onChange={vi.fn()} />)
    expect(select().value).toBe('u-grace')
  })

  it('reports the id of the person chosen, and "" for Everyone', async () => {
    const { onChange } = renderFilter({ people: loaded(ADA, GRACE) })
    await userEvent.selectOptions(select(), 'Grace Hopper')
    expect(onChange).toHaveBeenLastCalledWith('u-grace')
    await userEvent.selectOptions(select(), 'Everyone')
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('shows no id: an option is a name, its id only the value', () => {
    renderFilter({ people: loaded(ADA) })
    expect(optionTexts().join(' ')).not.toContain('u-ada')
  })

  it('has no hint while the options are there', () => {
    renderFilter({ people: loaded(ADA) })
    expect(select().getAttribute('aria-disabled')).toBeNull()
    expect(select().getAttribute('aria-describedby')).toBeNull()
  })
})

describe('the current choice is kept (a person who drops out of a narrowed list is not silently reset)', () => {
  it('stays an option, under the name it had, when a narrower answer no longer lists them', () => {
    const onChange = vi.fn()
    const { rerender } = render(<PersonFilter value="u-ada" people={loaded(ADA, GRACE)} onChange={onChange} />)
    rerender(<PersonFilter value="u-ada" people={loaded(GRACE)} onChange={onChange} />)
    expect(optionTexts()).toEqual(['Everyone', 'Ada Lovelace', 'Grace Hopper'])
    expect(select().value).toBe('u-ada')
  })

  it('is "Unknown user" when the page never had a name for them (a pasted link)', () => {
    renderFilter({ value: 'u-new', people: loaded(GRACE) })
    expect(optionTexts()).toEqual(['Everyone', 'Unknown user', 'Grace Hopper'])
    expect(select().value).toBe('u-new')
  })

  it('shows the new name once the answer carries one: a person renamed meanwhile (AC-4.8)', () => {
    const onChange = vi.fn()
    const { rerender } = render(<PersonFilter value="u-ada" people={loaded(ADA, GRACE)} onChange={onChange} />)
    rerender(
      <PersonFilter value="u-ada" people={loaded({ id: 'u-ada', label: 'Ada King' }, GRACE)} onChange={onChange} />,
    )
    expect(optionTexts()).toEqual(['Everyone', 'Ada King', 'Grace Hopper'])
    rerender(<PersonFilter value="u-ada" people={loaded(GRACE)} onChange={onChange} />)
    expect(optionTexts()).toEqual(['Everyone', 'Ada King', 'Grace Hopper'])
  })

  it('is not duplicated when the answer lists them', () => {
    renderFilter({ value: 'u-ada', people: loaded(ADA, GRACE) })
    expect(optionTexts().filter((text) => text === 'Ada Lovelace')).toHaveLength(1)
  })
})

describe('while the options load, and when they could not be loaded', () => {
  it('loading: Everyone and the current choice, aria-disabled, hint "Loading people…", the choice does nothing', async () => {
    const { onChange } = renderFilter({ value: 'u-ada', people: { status: 'loading' } })
    expect(optionTexts()).toEqual(['Everyone', 'Unknown user'])
    expect(select().getAttribute('aria-disabled')).toBe('true')
    expect(select().disabled).toBe(false)
    expect(screen.getByText(f.loading)).not.toBeNull()
    expect(select().getAttribute('aria-describedby')).toBe(screen.getByText(f.loading).id)
    await userEvent.selectOptions(select(), '')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('failed: Everyone and the current choice, aria-disabled, hint "People could not be loaded."', async () => {
    const { onChange } = renderFilter({ people: { status: 'error' } })
    expect(optionTexts()).toEqual(['Everyone'])
    expect(select().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText(f.error)).not.toBeNull()
    expect(f.error).toBe('People could not be loaded.')
    await userEvent.click(select())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('loading keeps the name the page had for the current choice', () => {
    const { rerender } = render(<PersonFilter value="u-ada" people={loaded(ADA, GRACE)} onChange={vi.fn()} />)
    rerender(<PersonFilter value="u-ada" people={{ status: 'loading' }} onChange={vi.fn()} />)
    expect(optionTexts()).toEqual(['Everyone', 'Ada Lovelace'])
  })

  it('nothing in it is an alert: the rest of the view works without it', () => {
    renderFilter({ people: { status: 'error' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
