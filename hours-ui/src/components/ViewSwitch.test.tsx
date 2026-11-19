/**
 * @vitest-environment jsdom
 *
 * ViewSwitch — Table | List (specs/20261116-record-hours-in-place T10, T19; design S6 "Control: Tabs", Table first because
 * it is the default; AC-5.1). Two views of the SAME page, so a real tablist, not links: one tab stop, the arrow keys,
 * `aria-selected`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { strings } from '../strings'
import ViewSwitch from './ViewSwitch'
import type { ViewSwitchProps } from './ViewSwitch'

afterEach(() => cleanup())

const v = strings.table.view

const renderSwitch = (props: Partial<ViewSwitchProps> = {}) => {
  const onChange = vi.fn()
  const view = render(<ViewSwitch value="table" idPrefix="hours-view" onChange={onChange} {...props} />)
  return { onChange, ...view }
}

const table = () => screen.getByRole('tab', { name: v.table })
const list = () => screen.getByRole('tab', { name: v.list })

describe('the tablist (AC-5.1)', () => {
  it('is named "View of your hours" and has two tabs, Table then List: the default view first', () => {
    renderSwitch()
    const tablist = screen.getByRole('tablist', { name: v.label })
    expect(tablist).not.toBeNull()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([v.table, v.list])
  })

  it('marks the current view with aria-selected, and only that one', () => {
    renderSwitch({ value: 'table' })
    expect(table().getAttribute('aria-selected')).toBe('true')
    expect(list().getAttribute('aria-selected')).toBe('false')
    cleanup()
    renderSwitch({ value: 'list' })
    expect(table().getAttribute('aria-selected')).toBe('false')
    expect(list().getAttribute('aria-selected')).toBe('true')
  })

  it('has one tab stop: the selected tab', () => {
    renderSwitch({ value: 'list' })
    expect(list().getAttribute('tabindex')).toBe('0')
    expect(table().getAttribute('tabindex')).toBe('-1')
  })

  it('points each tab at the panel the page draws with the same prefix', () => {
    renderSwitch({ idPrefix: 'hours-view' })
    expect(table().getAttribute('aria-controls')).toBe('hours-view-panel-table')
    expect(list().getAttribute('aria-controls')).toBe('hours-view-panel-list')
  })
})

describe('choosing a view', () => {
  it('a click on the other tab reports it', async () => {
    const { onChange } = renderSwitch({ value: 'table' })
    await userEvent.click(list())
    expect(onChange).toHaveBeenCalledExactlyOnceWith('list')
  })

  it('the arrow keys move between the two and report the one reached', async () => {
    const { onChange } = renderSwitch({ value: 'table' })
    table().focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('list')
    expect(document.activeElement).toBe(list())
  })
})
