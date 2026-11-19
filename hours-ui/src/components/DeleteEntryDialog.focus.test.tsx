/**
 * @vitest-environment jsdom
 *
 * Where the keyboard is after a delete that failed (specs/20261116-record-hours-in-place, QE round 1; design S3, S8 and
 * § Accessibility; AC-5.17). While the request runs Confirm is `disabled` (and so is Cancel), and a browser takes focus off a
 * control that stops being focusable: the keyboard is left on <body> and the next Tab lands on the dialog's ×. A delete that
 * fails with anything but a 404 keeps the dialog open with its alert, and gives the keyboard back to Confirm, where the person
 * pressed and where pressing it again is the retry. jsdom does not take focus off a disabled control, so these tests do it as
 * a browser does (`emulateFocusFixup`) and answer a frame later, as a request does: without it they would find focus on Confirm
 * because nothing ever took it away. The same dialog is used by the List and by the Week's cell dialog; both are tested through
 * the page (`MyHoursPage.edit.test.tsx`, `MyHoursPage.cells.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { strings } from '../strings'
import { projectOn, timeEntryView } from '../test-support/fakeApi'
import { emulateFocusFixup, rejectAfterAFrame } from '../test-support/focusFixup'
import DeleteEntryDialog from './DeleteEntryDialog'

const d = strings.entry.delete

let stopFixup: () => void
beforeEach(() => {
  stopFixup = emulateFocusFixup()
})
afterEach(() => {
  stopFixup()
  cleanup()
})

type Confirm = () => Promise<void>

const renderDialog = (onConfirm: Confirm) =>
  render(
    <DeleteEntryDialog
      entry={timeEntryView({ id: 'e1', minutes: 240, on: projectOn('p1', 'Alpenstrom') })}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />,
  )

const dialog = () => screen.getByRole('alertdialog', { name: d.title })
const confirmButton = () => within(dialog()).getByRole('button', { name: d.confirm }) as HTMLButtonElement
const pressConfirm = () => userEvent.click(confirmButton())

/** The keyboard has been handed back: Confirm, enabled, holds it. A browser had taken it off while the request ran. */
const focusIsOnConfirm = () => waitFor(() => expect(document.activeElement).toBe(confirmButton()))

describe('a delete that fails gives the keyboard back to Confirm', () => {
  it('after a refusal: the alert, the dialog open, Confirm enabled and focused (the keyboard is not left on <body>)', async () => {
    const onConfirm = vi.fn<Confirm>(() => rejectAfterAFrame(new Error('503')))
    renderDialog(onConfirm)

    await pressConfirm()
    // while it runs: busy, Confirm disabled, and the browser has taken focus off it
    expect(within(dialog()).getByRole('button', { name: d.busy })).toHaveProperty('disabled', true)
    await waitFor(() => expect(document.activeElement).toBe(document.body))

    expect((await within(dialog()).findByRole('alert')).textContent).toBe(d.error)
    expect(confirmButton().disabled).toBe(false)
    await focusIsOnConfirm()
  })

  it('after a network failure: the same alert and the same Confirm', async () => {
    renderDialog(() => rejectAfterAFrame(new TypeError('Failed to fetch')))

    await pressConfirm()

    expect((await within(dialog()).findByRole('alert')).textContent).toBe(d.error)
    await focusIsOnConfirm()
  })

  it('and Confirm, with the keyboard back on it, is the retry: Enter asks again, and a second failure gives it back again', async () => {
    const onConfirm = vi
      .fn<Confirm>()
      .mockImplementationOnce(() => rejectAfterAFrame(new Error('503')))
      .mockImplementationOnce(() => rejectAfterAFrame(new Error('503')))
    renderDialog(onConfirm)
    await pressConfirm()
    await focusIsOnConfirm()

    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(document.activeElement).toBe(document.body))
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await focusIsOnConfirm()
    expect(within(dialog()).getAllByRole('alert')).toHaveLength(1)
  })
})
