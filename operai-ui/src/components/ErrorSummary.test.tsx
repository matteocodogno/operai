import { afterEach, describe, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorSummary } from './ErrorSummary'

afterEach(cleanup)

const items = [
  { id: 'name', text: 'Legal name: enter the legal name.' },
  { id: 'iban', text: 'IBAN: the check digits do not match.' },
  { id: 'iban', text: 'IBAN: too long.' },
]

describe('ErrorSummary', () => {
  it('is an assertive alert with the title, the hint and one button per item, in order', () => {
    render(
      <ErrorSummary
        title="Nothing was saved. 3 values need your attention."
        hint="Choose one to go to it."
        items={items}
        onGo={vi.fn()}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Nothing was saved. 3 values need your attention.')).toBeInTheDocument()
    expect(within(alert).getByText('Choose one to go to it.')).toBeInTheDocument()
    expect(
      within(alert)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(items.map((item) => item.text))
  })

  it('calls onGo with the id of the item clicked, also when two items share an id', async () => {
    const onGo = vi.fn()
    render(<ErrorSummary title="Nothing was saved." items={items} onGo={onGo} />)
    await userEvent.click(screen.getByRole('button', { name: 'IBAN: too long.' }))
    await userEvent.click(screen.getByRole('button', { name: 'Legal name: enter the legal name.' }))
    expect(onGo.mock.calls).toEqual([['iban'], ['name']])
  })

  it('is reachable and operable with the keyboard', async () => {
    const onGo = vi.fn()
    render(<ErrorSummary title="Nothing was saved." items={items} onGo={onGo} />)
    await userEvent.tab()
    expect(screen.getByRole('button', { name: items[0].text })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onGo).toHaveBeenCalledWith('name')
  })

  it('renders nothing without items, and no hint line without a hint', () => {
    const { container, rerender } = render(<ErrorSummary title="Nothing was saved." items={[]} onGo={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<ErrorSummary title="Nothing was saved." items={items} onGo={vi.fn()} />)
    expect(screen.getByRole('alert').querySelectorAll('p')).toHaveLength(0)
  })

  it('derives test ids from testId', () => {
    render(<ErrorSummary title="T" items={items} onGo={vi.fn()} testId="sum" />)
    expect(screen.getByTestId('sum')).toBe(screen.getByRole('alert'))
    expect(screen.getByTestId('sum-title')).toHaveTextContent('T')
    expect(screen.getAllByTestId('sum-item')).toHaveLength(3)
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <ErrorSummary title="Nothing was saved." hint="Choose one." items={items} onGo={vi.fn()} />,
    )
    const { violations } = await axe.run(container)
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })
})
