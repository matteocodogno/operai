/**
 * @vitest-environment jsdom
 *
 * DeleteEntryDialog — what the confirmation says about an automatic entry (specs/20261112-meeting-hours T10; AC-2.7, D61;
 * design S4, F3). An entry Operai recorded from a meeting (`origin: meeting`) is never recorded again once deleted
 * (AC-2.5), which "This can't be undone" does not say, so the body gains a second paragraph after the existing sentence.
 * The confirmation of an entry typed by hand, and of one from an hours-api that sends no `origin`, says what it always did.
 * The dialog's behaviour (focus, busy, the failure it keeps open) is `DeleteEntryDialog.focus.test.tsx` and the page tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { meetingOn, projectOn, timeEntryView } from '../test-support/fakeApi'
import DeleteEntryDialog from './DeleteEntryDialog'

afterEach(() => cleanup())

const FIRST = "1 h on Weekly sync, 12.11.2026. This can't be undone."
const NOTE = "Operai won't record it again from its meeting. You can still record hours yourself."

const renderDialog = (entry: TimeEntryView) =>
  render(<DeleteEntryDialog entry={entry} onConfirm={vi.fn(() => Promise.resolve())} onCancel={vi.fn()} />)

const dialog = () => screen.getByRole('alertdialog', { name: 'Delete this entry?' })
/** The element the dialog is described by: what a screen reader reads after the title. */
const description = () => document.getElementById(dialog().getAttribute('aria-describedby')!)!

const SYNC = meetingOn('m1', 'Weekly sync')
const automatic = (overrides: Partial<TimeEntryView> = {}) =>
  timeEntryView({ id: 'a1', minutes: 60, origin: 'meeting', on: SYNC, ...overrides })

describe('an automatic entry: the confirmation also says it will not come back (AC-2.7)', () => {
  it('keeps the existing sentence and adds a second paragraph after it', () => {
    renderDialog(automatic())

    const first = within(dialog()).getByText(FIRST)
    const note = within(dialog()).getByText(NOTE)
    expect(first.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the second sentence is a paragraph of its own, in the body the dialog is described by
    expect(note.tagName).toBe('P')
    expect(description().contains(note)).toBe(true)
  })

  it('is part of what the dialog is described by, so a screen reader reads it after the first sentence', () => {
    renderDialog(automatic())
    expect(description().textContent).toBe(`${FIRST}${NOTE}`)
  })

  it('says it for an entry the person moved off the meeting too: it is where the entry came from that decides (AC-2.3)', () => {
    renderDialog(automatic({ on: projectOn('p1', 'Alpenstrom') }))
    expect(within(dialog()).getByText("1 h on Alpenstrom, 12.11.2026. This can't be undone.")).not.toBeNull()
    expect(within(dialog()).getByText(NOTE)).not.toBeNull()
  })

  it('says it for a meeting the viewer cannot read, with the placeholder and never the title (AC-3.6, AC-4.1)', () => {
    const hidden = { ...meetingOn('m1', null, { state: 'none' }, 'hidden'), label: 'Secret board meeting' }
    renderDialog(automatic({ on: hidden }))
    expect(
      within(dialog()).getByText("1 h on a meeting that is not visible to you, 12.11.2026. This can't be undone."),
    ).not.toBeNull()
    expect(within(dialog()).getByText(NOTE)).not.toBeNull()
    expect(dialog().textContent).not.toContain('Secret board meeting')
  })

  it('still opens on Cancel and still offers Delete entry: nothing else about the dialog changes', () => {
    renderDialog(automatic())
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog()).getByRole('button', { name: 'Delete entry' })).not.toBeNull()
    expect(within(dialog()).queryByRole('alert')).toBeNull()
  })
})

describe('an entry that is not automatic is confirmed as it always was (AC-2.7)', () => {
  it.each([
    ['person', 'person' as const],
    ['no origin (an hours-api that does not send it)', undefined],
  ])('says only the existing sentence when the origin is %s', (_label, origin) => {
    renderDialog(timeEntryView({ id: 'h1', minutes: 60, on: SYNC, ...(origin ? { origin } : {}) }))

    expect(description().textContent).toBe(FIRST)
    expect(within(dialog()).queryByText(NOTE)).toBeNull()
    expect(dialog().textContent).not.toMatch(/record it again/i)
  })
})
