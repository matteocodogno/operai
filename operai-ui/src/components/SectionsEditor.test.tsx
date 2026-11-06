import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { SectionsEditor } from './SectionsEditor'
import type { SectionsEditorProps } from './SectionsEditor'

afterEach(cleanup)

type Row = { heading: string; body: string; marked?: boolean }

const copy: SectionsEditorProps<Row>['copy'] = {
  legend: 'Sections',
  hint: '1 to 3 sections.',
  item: (n) => `Section ${n}`,
  headingLabel: (n) => `Heading (${n})`,
  bodyLabel: (n) => `Text (${n})`,
  moveUp: (n) => `Move section ${n} up`,
  moveDown: (n) => `Move section ${n} down`,
  remove: (n) => `Remove section ${n}`,
  add: 'Add section',
}

const rows = (...headings: string[]): Row[] => headings.map((heading) => ({ heading, body: `${heading} body` }))

function Harness({
  initial = rows('Scope', 'Costs', 'Terms'),
  onChange,
  ...rest
}: { initial?: Row[]; onChange?: (next: Row[]) => void } & Partial<SectionsEditorProps<Row>>) {
  const [sections, setSections] = useState(initial)
  return (
    <SectionsEditor<Row>
      sections={sections}
      onChange={(next) => {
        setSections(next)
        onChange?.(next)
      }}
      createSection={() => ({ heading: '', body: '' })}
      min={1}
      max={3}
      copy={copy}
      testIdPrefix="tpl"
      {...rest}
    />
  )
}

const headings = () =>
  screen.getAllByRole('textbox', { name: /^Heading/ }).map((input) => (input as HTMLInputElement).value)

describe('SectionsEditor', () => {
  it('lists the rows in order with numbered labels, the legend and the hint', () => {
    render(<Harness />)
    expect(screen.getByRole('group', { name: 'Sections' })).toBeInTheDocument()
    expect(screen.getByText('1 to 3 sections.')).toBeInTheDocument()
    expect(headings()).toEqual(['Scope', 'Costs', 'Terms'])
    expect(screen.getByRole('textbox', { name: /Text \(2\)/ })).toHaveValue('Costs body')
    expect(screen.getByText('Section 3')).toBeInTheDocument()
  })

  it('edits a heading and a body, keeping the row’s other fields', async () => {
    const onChange = vi.fn()
    render(<Harness initial={[{ heading: 'A', body: 'x', marked: true }]} onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: /Heading \(1\)/ }), 'b')
    expect(onChange).toHaveBeenLastCalledWith([{ heading: 'Ab', body: 'x', marked: true }])
    await userEvent.type(screen.getByRole('textbox', { name: /Text \(1\)/ }), 'y')
    expect(onChange).toHaveBeenLastCalledWith([{ heading: 'Ab', body: 'xy', marked: true }])
  })

  it('moves a row up and down, and disables the moves that go nowhere', async () => {
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'Move section 1 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move section 3 down' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Move section 2 up' }))
    expect(headings()).toEqual(['Costs', 'Scope', 'Terms'])
    await userEvent.click(screen.getByRole('button', { name: 'Move section 2 down' }))
    expect(headings()).toEqual(['Costs', 'Terms', 'Scope'])
  })

  it('keeps keyboard focus on the moved row, on the other move when this one can go no further', async () => {
    render(<Harness />)
    const second = screen.getByTestId('tpl-section-1')
    await userEvent.click(within(second).getByRole('button', { name: /up/ }))
    // The row is now first: its "up" is disabled, so focus lands on its "down".
    expect(screen.getByRole('button', { name: 'Move section 1 down' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    // Back to the middle: "down" stays focused.
    expect(screen.getByRole('button', { name: 'Move section 2 down' })).toHaveFocus()
  })

  it('removes a row, but not below the minimum', async () => {
    render(<Harness initial={rows('Scope', 'Terms')} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove section 1' }))
    expect(headings()).toEqual(['Terms'])
    expect(screen.getByRole('button', { name: 'Remove section 1' })).toBeDisabled()
  })

  it('moves focus to the next row’s heading after a removal, else the previous, else Add', async () => {
    render(<Harness initial={rows('A', 'B', 'C')} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove section 2' }))
    expect(screen.getByRole('textbox', { name: /Heading \(2\)/ })).toHaveFocus()
    expect(headings()).toEqual(['A', 'C'])
    await userEvent.click(screen.getByRole('button', { name: 'Remove section 2' }))
    expect(screen.getByRole('textbox', { name: /Heading \(1\)/ })).toHaveFocus()
  })

  it('adds a blank row, focuses its heading, and stops at the maximum', async () => {
    render(<Harness initial={rows('A', 'B')} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }))
    expect(headings()).toEqual(['A', 'B', ''])
    expect(screen.getByRole('textbox', { name: /Heading \(3\)/ })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Add section' })).toBeDisabled()
  })

  it('shows each row’s errors on its own field, and the list error as an alert', () => {
    render(
      <Harness
        listError="Add between 1 and 3 sections."
        rowErrors={[null, { heading: 'A heading is required' }, { body: 'The text is too long' }]}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Add between 1 and 3 sections.')
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'tpl-sections-error')
    const heading2 = screen.getByRole('textbox', { name: /Heading \(2\)/ })
    expect(heading2).toHaveAttribute('aria-invalid', 'true')
    expect(heading2).toHaveAccessibleDescription('A heading is required')
    expect(screen.getByRole('textbox', { name: /Heading \(1\)/ })).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('textbox', { name: /Text \(3\)/ })).toHaveAccessibleDescription('The text is too long')
  })

  it('renders the app’s extra control inside each row, with the row and its index', async () => {
    const onChange = vi.fn()
    render(
      <Harness
        onChange={onChange}
        renderRowExtra={(section, index) => <p data-testid={`extra-${index}`}>{`extra for ${section.heading}`}</p>}
      />,
    )
    expect(within(screen.getByTestId('tpl-section-1')).getByTestId('extra-1')).toHaveTextContent('extra for Costs')
  })

  it('lets the extra control change other rows through the app’s own state', async () => {
    function Exclusive() {
      const [sections, setSections] = useState<Row[]>(rows('A', 'B').map((r, i) => ({ ...r, marked: i === 0 })))
      return (
        <SectionsEditor<Row>
          sections={sections}
          onChange={setSections}
          createSection={() => ({ heading: '', body: '' })}
          copy={copy}
          testIdPrefix="tpl"
          renderRowExtra={(section, index) => (
            <input
              type="radio"
              aria-label={`mark ${index + 1}`}
              checked={!!section.marked}
              onChange={() => setSections(sections.map((s, at) => ({ ...s, marked: at === index })))}
            />
          )}
        />
      )
    }
    render(<Exclusive />)
    await userEvent.click(screen.getByRole('radio', { name: 'mark 2' }))
    expect(screen.getByRole('radio', { name: 'mark 2' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'mark 1' })).not.toBeChecked()
  })

  it('disables every control while disabled', () => {
    render(<Harness disabled />)
    for (const control of [...screen.getAllByRole('textbox'), ...screen.getAllByRole('button')]) {
      expect(control).toBeDisabled()
    }
  })

  it('has no maximum or minimum unless given', async () => {
    render(<Harness initial={rows('A')} min={undefined} max={undefined} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove section 1' }))
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Add section' })).toBeEnabled()
  })

  it('keeps the per-row test ids the e2e suite addresses', () => {
    render(<Harness />)
    for (const id of [
      'tpl-sections',
      'tpl-section-0',
      'tpl-section-0-up',
      'tpl-section-0-down',
      'tpl-section-0-remove',
      'tpl-section-add',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })
})
