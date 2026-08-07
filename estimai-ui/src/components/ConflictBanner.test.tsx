/**
 * @vitest-environment jsdom
 *
 * Component tests for ConflictBanner (T18, specs/013-estimate-sharing/
 * tasks.md; design.md S4/Accessibility).
 *
 * Covers the done-when: renders on the three ConflictInfo shapes with their
 * distinct copy, exposes both actions, has NO dismiss control, does not move
 * focus on appear, is `role="alert"`, and invokes the two callback props
 * (onReloadLatest/onSaveAsCopy — EstimatorApp.tsx wires these to the real
 * router.invalidate() / estimatesApi.create() calls, verified separately in
 * EstimatorApp.conflict.test.tsx since this component is presentational).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ConflictBanner from './ConflictBanner'
import type { ConflictInfo } from '../context/EstimatorContext'
import { strings } from '../strings'

afterEach(() => cleanup())

const conflict409Attributable: ConflictInfo = {
  status: 409,
  currentVersion: 5,
  updatedAt: '2026-08-07T12:00:00.000Z',
  lastModifiedBy: { status: 'active', name: 'Jane Doe' },
}

const conflict409Unattributable: ConflictInfo = {
  status: 409,
  currentVersion: 5,
  updatedAt: '2026-08-07T12:00:00.000Z',
  lastModifiedBy: { status: 'unknown', name: null },
}

const conflict409NoLastModifiedBy: ConflictInfo = {
  status: 409,
  currentVersion: 5,
  updatedAt: '2026-08-07T12:00:00.000Z',
  lastModifiedBy: undefined,
}

const conflict428: ConflictInfo = {
  status: 428,
  currentVersion: undefined,
  updatedAt: undefined,
  lastModifiedBy: undefined,
}

describe('ConflictBanner — copy variants (design.md S4)', () => {
  it('409, attributable: names the last editor and shows the reassurance line', () => {
    render(<ConflictBanner conflict={conflict409Attributable} onReloadLatest={vi.fn()} onSaveAsCopy={vi.fn()} />)

    expect(screen.getByText('Jane Doe saved changes to this estimate since you opened it.')).toBeDefined()
    expect(screen.getByText(strings.conflict.reassurance)).toBeDefined()
  })

  it('409, unattributable (identity resolution failed): generic "Someone else…" copy', () => {
    render(<ConflictBanner conflict={conflict409Unattributable} onReloadLatest={vi.fn()} onSaveAsCopy={vi.fn()} />)

    expect(screen.getByText(strings.conflict.title409Unknown)).toBeDefined()
    expect(screen.getByText(strings.conflict.reassurance)).toBeDefined()
  })

  it('409 with no lastModifiedBy at all: falls back to the same generic "Someone else…" copy', () => {
    render(<ConflictBanner conflict={conflict409NoLastModifiedBy} onReloadLatest={vi.fn()} onSaveAsCopy={vi.fn()} />)

    expect(screen.getByText(strings.conflict.title409Unknown)).toBeDefined()
  })

  it('428 (stale client): the "this tab needs to reload" framing, no reassurance line', () => {
    render(<ConflictBanner conflict={conflict428} onReloadLatest={vi.fn()} onSaveAsCopy={vi.fn()} />)

    expect(screen.getByText(strings.conflict.title428)).toBeDefined()
    expect(screen.queryByText(strings.conflict.reassurance)).toBeNull()
  })
})

describe('ConflictBanner — accessibility and actions (design.md "## Accessibility")', () => {
  it('is role="alert"', () => {
    render(<ConflictBanner conflict={conflict409Attributable} onReloadLatest={vi.fn()} onSaveAsCopy={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeDefined()
  })

  it('exposes both actions — "Reload latest" primary, "Save as a copy instead" secondary, in that order', () => {
    render(<ConflictBanner conflict={conflict409Attributable} onReloadLatest={vi.fn()} onSaveAsCopy={vi.fn()} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(2)
    expect(buttons[0].textContent).toBe(strings.conflict.reloadButton)
    expect(buttons[1].textContent).toBe(strings.conflict.saveAsCopyButton)
  })

  it('never renders a dismiss "×" control', () => {
    render(<ConflictBanner conflict={conflict409Attributable} onReloadLatest={vi.fn()} onSaveAsCopy={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull()
    expect(screen.queryByText('×')).toBeNull()
  })

  it('does not move focus on appear', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    render(<ConflictBanner conflict={conflict409Attributable} onReloadLatest={vi.fn()} onSaveAsCopy={vi.fn()} />)

    expect(document.activeElement).toBe(input)
    document.body.removeChild(input)
  })

  it('calls onReloadLatest when "Reload latest" is clicked', () => {
    const onReloadLatest = vi.fn()
    render(<ConflictBanner conflict={conflict409Attributable} onReloadLatest={onReloadLatest} onSaveAsCopy={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: strings.conflict.reloadButton }))
    expect(onReloadLatest).toHaveBeenCalledTimes(1)
  })

  it('calls onSaveAsCopy when "Save as a copy instead" is clicked', () => {
    const onSaveAsCopy = vi.fn()
    render(<ConflictBanner conflict={conflict409Attributable} onReloadLatest={vi.fn()} onSaveAsCopy={onSaveAsCopy} />)

    fireEvent.click(screen.getByRole('button', { name: strings.conflict.saveAsCopyButton }))
    expect(onSaveAsCopy).toHaveBeenCalledTimes(1)
  })
})
