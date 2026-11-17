import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Badge } from './Badge'
import { Banner, CONFIRMATION_DISMISS_MS } from './Banner'
import { Button, buttonClassName } from './Button'
import { DataTable } from './DataTable'
import { Field } from './Field'
import { StatePanel } from './StatePanel'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { TabNav } from './TabNav'
import { Tabs } from './Tabs'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Button', () => {
  it('defaults to a secondary type="button"', () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass('btn', 'btn-secondary')
  })

  it('ignores clicks and is aria-busy while busy', async () => {
    const onClick = vi.fn()
    render(
      <Button variant="primary" busy onClick={onClick}>
        Saving…
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Saving…' })
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('builds the class string for a link', () => {
    expect(buttonClassName({ variant: 'primary', size: 'sm' })).toBe('btn btn-primary btn-sm')
  })
})

describe('Badge', () => {
  it('pairs a decorative glyph with its label', () => {
    render(
      <Badge tone="success" glyph="✓">
        Approved
      </Badge>,
    )
    const badge = screen.getByText('Approved').parentElement
    expect(badge).toHaveClass('badge', 'badge-success')
    expect(screen.getByText('✓')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('Banner', () => {
  it('is an alert for warning and danger, a polite status otherwise', () => {
    const { rerender } = render(<Banner tone="warning">Could not load</Banner>)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load')
    rerender(<Banner tone="success">Saved</Banner>)
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })

  it('live overrides the announcement without changing the tone', () => {
    const { rerender } = render(
      <Banner tone="warning" live="off" aria-label="Heads up" data-testid="b">
        Persistent notice
      </Banner>,
    )
    const banner = screen.getByTestId('b')
    expect(banner).toHaveAttribute('role', 'note')
    expect(banner).not.toHaveAttribute('aria-live')
    expect(banner).toHaveClass('banner-warning')
    expect(screen.getByRole('note', { name: 'Heads up' })).toBe(banner)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(
      <Banner tone="warning" live="polite" data-testid="b">
        Persistent notice
      </Banner>,
    )
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(
      <Banner tone="info" live="assertive" data-testid="b">
        Urgent
      </Banner>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Urgent')
  })

  it('renders Retry and Dismiss when given handlers', async () => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    render(
      <Banner tone="warning" onRetry={onRetry} retryLabel="Retry" onDismiss={onDismiss} dismissLabel="Dismiss">
        Could not load
      </Banner>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('auto-dismisses after CONFIRMATION_DISMISS_MS', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(
      <Banner tone="success" onDismiss={onDismiss} dismissLabel="Dismiss" autoDismiss>
        Saved
      </Banner>,
    )
    act(() => vi.advanceTimersByTime(CONFIRMATION_DISMISS_MS - 1))
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('Field', () => {
  it('labels the control and describes it with hint and error', () => {
    render(
      <Field label="Amount" hint="In euro" error="Required" required>
        {(control) => <input {...control} />}
      </Field>,
    )
    const input = screen.getByRole('textbox', { name: 'Amount' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(input).toHaveAccessibleDescription('In euro Required')
  })

  it('is valid and undescribed without hint or error', () => {
    render(<Field label="Note">{(control) => <input {...control} />}</Field>)
    const input = screen.getByRole('textbox', { name: 'Note' })
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input).not.toHaveAttribute('aria-describedby')
  })
})

describe('DataTable', () => {
  const rows = [
    { id: 'a', name: 'Laptop', price: 'EUR 1,200.00' },
    { id: 'b', name: 'Monitor', price: 'EUR 300.00' },
  ]

  it('renders a captioned table with row headers and numeric cells', () => {
    render(
      <DataTable
        caption="Assets"
        rows={rows}
        getRowKey={(row) => row.id}
        columns={[
          { id: 'name', header: 'Name', rowHeader: true, render: (row) => row.name },
          { id: 'price', header: 'Price', numeric: true, render: (row) => row.price },
        ]}
      />,
    )
    expect(screen.getByRole('table', { name: 'Assets' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Assets' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('rowheader', { name: 'Laptop' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'EUR 300.00' })).toHaveClass('is-numeric')
  })

  it('sortable headers report the order asked for and show the current one with aria-sort', async () => {
    const user = userEvent.setup()
    const onSortChange = vi.fn()
    const columns = [
      { id: 'name', header: 'Name', rowHeader: true, sortable: true, render: (row: (typeof rows)[number]) => row.name },
      { id: 'price', header: 'Price', numeric: true, sortable: true, firstSortDirection: 'desc' as const, render: (row: (typeof rows)[number]) => row.price },
      { id: 'note', header: 'Note', render: () => '' },
    ]
    const { rerender } = render(
      <DataTable caption="Assets" rows={rows} getRowKey={(row) => row.id} columns={columns} sort={{ columnId: 'name', direction: 'asc' }} onSortChange={onSortChange} />,
    )
    const [name, price, note] = screen.getAllByRole('columnheader')
    expect(name).toHaveAttribute('aria-sort', 'ascending')
    expect(price).toHaveAttribute('aria-sort', 'none')
    expect(note).not.toHaveAttribute('aria-sort')
    expect(within(note!).queryByRole('button')).toBeNull()

    await user.click(within(name!).getByRole('button', { name: 'Name' }))
    expect(onSortChange).toHaveBeenLastCalledWith({ columnId: 'name', direction: 'desc' })
    await user.click(within(price!).getByRole('button', { name: 'Price' }))
    expect(onSortChange).toHaveBeenLastCalledWith({ columnId: 'price', direction: 'desc' })

    rerender(
      <DataTable caption="Assets" rows={rows} getRowKey={(row) => row.id} columns={columns} sort={{ columnId: 'price', direction: 'desc' }} onSortChange={onSortChange} />,
    )
    expect(screen.getAllByRole('columnheader')[1]).toHaveAttribute('aria-sort', 'descending')
  })

  it('without onSortChange a sortable column is a plain header', () => {
    render(
      <DataTable caption="Assets" rows={rows} getRowKey={(row) => row.id} columns={[{ id: 'name', header: 'Name', sortable: true, render: (row) => row.name }]} />,
    )
    expect(screen.queryByRole('button', { name: 'Name' })).toBeNull()
  })
})

describe('StatePanel', () => {
  it('focuses its heading when asked', () => {
    render(<StatePanel title="No access" role="alert" focusOnMount headingLevel={2} />)
    expect(screen.getByRole('heading', { level: 2, name: 'No access' })).toHaveFocus()
  })
})

describe('TabNav', () => {
  it('wraps each link in a list item inside a labelled nav, skipping absent tabs', () => {
    const canReview = false
    render(
      <TabNav label="Sections">
        <a className="tab-link" href="/a" aria-current="page">
          A
        </a>
        {canReview && <a href="/b">B</a>}
      </TabNav>,
    )
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })
})

const tabsMarkup = (wrap?: boolean) => (
  <Tabs
    label="Views"
    idPrefix="t"
    value="a"
    onChange={() => {}}
    wrap={wrap}
    tabs={[
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ]}
  />
)

const tabNavMarkup = (wrap?: boolean) => (
  <TabNav label="Sections" wrap={wrap} end={<a className="tab-link" href="/z">Audit</a>}>
    <a className="tab-link" href="/a" aria-current="page">
      A
    </a>
    <a className="tab-link" href="/b">
      B
    </a>
  </TabNav>
)

describe('Tabs and TabNav wrap (opt-in)', () => {
  it('Tabs: without wrap the markup is unchanged', () => {
    const { container } = render(tabsMarkup())
    expect(container.innerHTML).toMatchInlineSnapshot(`"<div role="tablist" aria-label="Views" class="tab-list"><button type="button" role="tab" id="t-tab-a" aria-selected="true" aria-controls="t-panel-a" tabindex="0" class="tab-link">Alpha</button><button type="button" role="tab" id="t-tab-b" aria-selected="false" aria-controls="t-panel-b" tabindex="-1" class="tab-link">Beta</button></div>"`)
    expect(screen.getByRole('tablist')).toHaveAttribute('class', 'tab-list')
  })

  it('TabNav: without wrap the markup is unchanged', () => {
    const { container } = render(tabNavMarkup())
    expect(container.innerHTML).toMatchInlineSnapshot(`"<nav aria-label="Sections"><ul class="tab-list"><li><a class="tab-link" href="/a" aria-current="page">A</a></li><li><a class="tab-link" href="/b">B</a></li><li class="tab-list-end"><a class="tab-link" href="/z">Audit</a></li></ul></nav>"`)
    expect(screen.getByRole('list')).toHaveAttribute('class', 'tab-list')
  })

  it('wrap only adds the opt-in class; nothing else changes', () => {
    const plain = render(tabsMarkup()).container.innerHTML
    cleanup()
    const wrapped = render(tabsMarkup(true)).container.innerHTML
    expect(wrapped).toBe(plain.replace('class="tab-list"', 'class="tab-list tab-list-wrap"'))
    cleanup()
    const plainNav = render(tabNavMarkup()).container.innerHTML
    cleanup()
    const wrappedNav = render(tabNavMarkup(true)).container.innerHTML
    expect(wrappedNav).toBe(plainNav.replace('class="tab-list"', 'class="tab-list tab-list-wrap"'))
  })

  it('wrap is false-y safe: wrap={false} renders like the default', () => {
    const plain = render(tabsMarkup()).container.innerHTML
    cleanup()
    expect(render(tabsMarkup(false)).container.innerHTML).toBe(plain)
  })

  it('a wrapped list has no horizontal scroll container around it', () => {
    render(tabNavMarkup(true))
    const list = screen.getByRole('list')
    for (let node: HTMLElement | null = list; node; node = node.parentElement) {
      expect(node.style.overflowX).toBe('')
      expect(node.className).not.toMatch(/overflow-x|table-region/)
    }
  })

  it('keeps arrow-key navigation when wrapped', async () => {
    function Harness() {
      const [value, setValue] = useState<'a' | 'b'>('a')
      return (
        <Tabs
          label="Views"
          idPrefix="h"
          value={value}
          onChange={setValue}
          wrap
          tabs={[
            { id: 'a', label: 'Alpha' },
            { id: 'b', label: 'Beta' },
          ]}
        />
      )
    }
    render(<Harness />)
    screen.getByRole('tab', { name: 'Alpha' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true')
  })

  it('the stylesheet wraps the list and never scrolls it sideways', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8')
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`)
      expect(start, `${selector} rule`).toBeGreaterThan(-1)
      return css.slice(start, css.indexOf('}', start))
    }
    expect(rule('.tab-list')).toMatch(/flex-wrap:\s*wrap/)
    for (const selector of ['.tab-list', '.tab-list-wrap .tab-link']) {
      expect(rule(selector)).not.toMatch(/overflow(-x)?:\s*(auto|scroll)/)
    }
  })
})

describe('Banner auto-dismiss timer', () => {
  it('does not restart when the same message re-renders, and restarts for a new one', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    const { rerender } = render(
      <Banner tone="success" autoDismiss onDismiss={onDismiss} dismissLabel="Dismiss">
        Saved
      </Banner>,
    )
    act(() => vi.advanceTimersByTime(2000))
    // A parent re-render passes the same text again (and a fresh onDismiss).
    rerender(
      <Banner tone="success" autoDismiss onDismiss={() => onDismiss()} dismissLabel="Dismiss">
        Saved
      </Banner>,
    )
    act(() => vi.advanceTimersByTime(1000))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    rerender(
      <Banner tone="success" autoDismiss onDismiss={onDismiss} dismissLabel="Dismiss">
        Deleted
      </Banner>,
    )
    act(() => vi.advanceTimersByTime(2999))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(1))
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })
})

describe('DataTable detail rows', () => {
  it('renders a full-width detail row only where renderDetail returns content', () => {
    const rows = [
      { id: 'a', name: 'Alpha', open: true },
      { id: 'b', name: 'Beta', open: false },
    ]
    const { container } = render(
      <DataTable
        caption="Entries"
        rows={rows}
        getRowKey={(row) => row.id}
        columns={[
          { id: 'name', header: 'Name', rowHeader: true, render: (row) => row.name },
          { id: 'other', header: 'Other', render: () => '—' },
        ]}
        renderDetail={(row) => (row.open ? `Details of ${row.name}` : null)}
      />,
    )
    const details = container.querySelectorAll('tr.data-table-detail')
    expect(details).toHaveLength(1)
    expect(details[0].querySelector('td')).toHaveAttribute('colspan', '2')
    expect(details[0]).toHaveTextContent('Details of Alpha')
  })
})

describe('Button keeps a typing field focused on mouse press', () => {
  it('prevents the mousedown blur while a text field has focus, and still clicks', async () => {
    const onClick = vi.fn()
    const onBlur = vi.fn()
    render(
      <>
        <input aria-label="Name" onBlur={onBlur} />
        <Button onClick={onClick}>Save</Button>
      </>,
    )
    const input = screen.getByRole('textbox', { name: 'Name' })
    input.focus()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onBlur).not.toHaveBeenCalled()
    expect(input).toHaveFocus()
  })

  it('leaves the default alone when no field is being edited', async () => {
    render(<Button>Open</Button>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus()
  })
})
