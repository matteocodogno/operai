/**
 * @vitest-environment jsdom
 *
 * Component tests for TimeListItemDialog — the Add / Rename form of a time-list item (T32,
 * specs/029-time-tracking/tasks.md, refs AC-3.1, AC-3.8; plan.md § Lists; design.md S5 "Add /
 * Rename"). The page owns the request; the dialog owns the form, its validation and the way a
 * failed request reads. Here `onSubmit` is the page's answer, faked.
 *
 * Covers:
 *   (A) What it opens as: title per list and mode, focus on Name, the category-only checkbox, the
 *       prefill of a rename, the hint that a name is shown exactly as typed.
 *   (B) The Name check: empty, over 80 characters AFTER trimming, counted in Unicode code points
 *       (plan amendment 2, 2026-11-13: 80 emoji pass, 81 do not), no NUL.
 *   (C) What it sends: the trimmed name, and the note flag for a category only.
 *   (D) How a failed request reads: 409 as the Name's field error, 403 / 503 / other inline; the
 *       dialog stays open with every value kept.
 *   (E) While it saves: busy, not dismissible.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TimeListItemDialog from './TimeListItemDialog'
import type { TimeListItemFailure, TimeListItemValues } from './TimeListItemDialog'
import type { TimeListRow, TimeListScope } from './TimeListCard'

afterEach(() => {
  cleanup()
})

type SubmitResult = TimeListItemFailure | null

const setup = (
  props: {
    scope?: TimeListScope
    item?: TimeListRow
    onSubmit?: (values: TimeListItemValues) => Promise<SubmitResult>
  } = {},
) => {
  const onSubmit =
    props.onSubmit ?? vi.fn<(values: TimeListItemValues) => Promise<SubmitResult>>().mockResolvedValue(null)
  const onCancel = vi.fn()
  render(
    <TimeListItemDialog
      scope={props.scope ?? 'categories'}
      item={props.item}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  )
  return { onSubmit: vi.mocked(onSubmit), onCancel }
}

const nameInput = () => screen.getByRole('textbox', { name: /^Name/ }) as HTMLInputElement
const noteCheckbox = () => screen.queryByRole('checkbox', { name: 'Entries in this category need a note' })
const submitButton = () => screen.getByTestId('time-lists-dialog-submit')
const type = (value: string) => fireEvent.change(nameInput(), { target: { value } })
const submit = () => fireEvent.click(submitButton())

const training: TimeListRow = { id: 'c-1', name: 'Training', retired: false, requiresNote: true }
const demo: TimeListRow = { id: 'wd-1', name: 'Demo', retired: false }

// ---------------------------------------------------------------------------
// (A) What it opens as
// ---------------------------------------------------------------------------

describe('opening', () => {
  it.each([
    ['categories', undefined, 'Add category'],
    ['project', undefined, 'Add project work type'],
    ['deal', undefined, 'Add deal work type'],
    ['categories', training, 'Rename category'],
    ['project', demo, 'Rename project work type'],
    ['deal', demo, 'Rename deal work type'],
  ] as const)('a %s dialog for %o is titled "%s"', (scope, item, title) => {
    setup({ scope, item })

    expect(screen.getByRole('dialog', { name: title })).not.toBeNull()
  })

  it('puts focus in Name, which is required and says it is shown exactly as typed, in both languages', () => {
    setup()

    expect(document.activeElement).toBe(nameInput())
    expect(nameInput().getAttribute('aria-required')).toBe('true')
    expect(screen.getByText('Shown exactly as you type it, in English and Italian.')).not.toBeNull()
  })

  it('a category form has the "Entries in this category need a note" checkbox, a work-type form does not', () => {
    setup({ scope: 'categories' })
    expect(noteCheckbox()).not.toBeNull()
    cleanup()

    setup({ scope: 'project' })
    expect(noteCheckbox()).toBeNull()
    cleanup()

    setup({ scope: 'deal' })
    expect(noteCheckbox()).toBeNull()
  })

  it('an add form starts empty with the checkbox clear', () => {
    setup()

    expect(nameInput().value).toBe('')
    expect((noteCheckbox() as HTMLInputElement).checked).toBe(false)
  })

  it('a rename starts from the item: its name exactly as stored, and its note flag', () => {
    setup({ item: training })

    expect(nameInput().value).toBe('Training')
    expect((noteCheckbox() as HTMLInputElement).checked).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (B) The Name check
// ---------------------------------------------------------------------------

describe('the Name check', () => {
  it.each([
    ['nothing', ''],
    ['only spaces', '   '],
    ['only a tab and spaces', ' \t  '],
  ])('refuses %s with a field error, sends nothing and puts focus back in Name', (_label, value) => {
    const { onSubmit } = setup()
    type(value)
    act(() => screen.getByTestId('time-lists-dialog-cancel').focus())

    submit()

    expect(screen.getByTestId('time-lists-dialog-name-error').textContent).toBe('Name is required.')
    expect(nameInput().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(nameInput())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('accepts exactly 80 characters and refuses 81', async () => {
    const { onSubmit } = setup()

    type('a'.repeat(81))
    submit()
    expect(screen.getByTestId('time-lists-dialog-name-error').textContent).toBe('Use 80 characters at most.')
    expect(onSubmit).not.toHaveBeenCalled()

    type('a'.repeat(80))
    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })

  it('counts AFTER trimming: 80 characters with spaces around them pass, 81 with spaces around them do not', async () => {
    const { onSubmit } = setup()

    type(`  ${'a'.repeat(81)}  `)
    submit()
    expect(screen.getByTestId('time-lists-dialog-name-error')).not.toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()

    type(`  ${'a'.repeat(80)}  `)
    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].name).toBe('a'.repeat(80))
  })

  it('counts Unicode code points, not UTF-16 units: 80 emoji pass, 81 emoji are refused (plan amendment 2)', async () => {
    const { onSubmit } = setup()
    // One emoji is two UTF-16 units, so 80 of them are 160 units: a `.length` check would refuse them.
    expect('🙂'.repeat(80).length).toBe(160)

    type('🙂'.repeat(81))
    submit()
    expect(screen.getByTestId('time-lists-dialog-name-error').textContent).toBe('Use 80 characters at most.')
    expect(onSubmit).not.toHaveBeenCalled()

    type('🙂'.repeat(80))
    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].name).toBe('🙂'.repeat(80))
  })

  it('refuses a NUL character, which the server cannot store, as a field error', () => {
    const { onSubmit } = setup()

    type('Train\u0000ing')
    submit()

    expect(screen.getByTestId('time-lists-dialog-name-error').textContent).toBe(
      'The name can’t contain a null character. Remove it.',
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('clears the field error as soon as the person types', () => {
    setup()
    submit()
    expect(screen.getByTestId('time-lists-dialog-name-error')).not.toBeNull()

    type('T')

    expect(screen.queryByTestId('time-lists-dialog-name-error')).toBeNull()
    expect(nameInput().getAttribute('aria-invalid')).toBeNull()
  })

  it('checks a typed Name when the person leaves the field, without moving focus back into it', () => {
    setup()
    type('a'.repeat(81))

    act(() => screen.getByTestId('time-lists-dialog-cancel').focus())

    expect(screen.getByTestId('time-lists-dialog-name-error').textContent).toBe('Use 80 characters at most.')
    expect(document.activeElement).toBe(screen.getByTestId('time-lists-dialog-cancel'))
  })

  it('does not scold a field the person has not typed in', () => {
    setup()

    act(() => screen.getByTestId('time-lists-dialog-cancel').focus())

    expect(screen.queryByTestId('time-lists-dialog-name-error')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (C) What it sends
// ---------------------------------------------------------------------------

describe('submitting', () => {
  it('sends the trimmed name and the note flag of a category', async () => {
    const { onSubmit } = setup()
    type('  Seminars  ')
    fireEvent.click(noteCheckbox()!)

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Seminars', requiresNote: true })
  })

  it('sends the name alone for a work type: it has no note flag', async () => {
    const { onSubmit } = setup({ scope: 'deal' })
    type('Demo')

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toEqual({ name: 'Demo' })
  })

  it('sends the name exactly as typed inside: case, accents and inner spaces untouched (AC-3.8)', async () => {
    const { onSubmit } = setup()
    type('Formazione  e   Aggiornamento — è già ÀÈ')

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].name).toBe('Formazione  e   Aggiornamento — è già ÀÈ')
  })

  it('Enter in Name submits', async () => {
    const { onSubmit } = setup({ scope: 'project' })
    type('Support')

    fireEvent.submit(nameInput().closest('form')!)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })

  it('a rename sends what the form says, however much of it changed; the page decides what to PATCH', async () => {
    const { onSubmit } = setup({ item: training })

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'Training', requiresNote: true }))
  })

  it('the submit button says Add for an add and Save for a rename', () => {
    setup()
    expect(submitButton().textContent).toBe('Add')
    cleanup()

    setup({ item: training })
    expect(submitButton().textContent).toBe('Save')
  })

  it('Cancel closes without sending', () => {
    const { onSubmit, onCancel } = setup()
    type('Seminars')

    fireEvent.click(screen.getByTestId('time-lists-dialog-cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// (D) How a failed request reads
// ---------------------------------------------------------------------------

describe('a failed request', () => {
  const failWith = (failure: TimeListItemFailure) =>
    vi.fn<(values: TimeListItemValues) => Promise<SubmitResult>>().mockResolvedValue(failure)

  it('409 name_taken on a category: the Name field error, aria-invalid, focus back in Name, nothing lost', async () => {
    setup({ onSubmit: failWith('name_taken') })
    type('Seminars')
    fireEvent.click(noteCheckbox()!)

    submit()

    expect((await screen.findByTestId('time-lists-dialog-name-error')).textContent).toBe(
      'A category with this name already exists. It may be retired.',
    )
    expect(nameInput().getAttribute('aria-invalid')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(nameInput()))
    expect(nameInput().value).toBe('Seminars')
    expect((noteCheckbox() as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.queryByTestId('time-lists-dialog-error')).toBeNull()
  })

  it('409 name_taken on a work type says so for the list', async () => {
    setup({ scope: 'deal', onSubmit: failWith('name_taken') })
    type('Demo')

    submit()

    expect((await screen.findByTestId('time-lists-dialog-name-error')).textContent).toBe(
      'A work type with this name already exists in this list. It may be retired.',
    )
  })

  it('the field error goes when the person edits the name, and a second try goes to the server again', async () => {
    const onSubmit = failWith('name_taken')
    setup({ onSubmit })
    type('Seminars')
    submit()
    await screen.findByTestId('time-lists-dialog-name-error')

    type('Seminars 2')
    expect(screen.queryByTestId('time-lists-dialog-name-error')).toBeNull()
    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1][0].name).toBe('Seminars 2')
  })

  it.each([
    [
      'forbidden',
      "You can't manage the time lists. Managing the categories and work types needs a permission your role does not have.",
    ],
    [
      'authz',
      'Authorization service unavailable. Your permissions could not be checked just now. Nothing was changed.',
    ],
    ['other', 'Something went wrong. Nothing was changed.'],
  ] as const)('%s: one alert line above the buttons, the dialog open, every value kept', async (failure, message) => {
    setup({ onSubmit: failWith(failure) })
    type('Seminars')
    fireEvent.click(noteCheckbox()!)

    submit()

    const alert = await screen.findByTestId('time-lists-dialog-error')
    expect(alert.textContent).toBe(message)
    expect(alert.getAttribute('role')).toBe('alert')
    expect(screen.queryByTestId('time-lists-dialog-name-error')).toBeNull()
    expect(nameInput().value).toBe('Seminars')
    expect((noteCheckbox() as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('dialog')).not.toBeNull()
    // Idle again, so the person can try again.
    expect(submitButton().getAttribute('aria-busy')).toBeNull()
    expect(nameInput().matches(':disabled')).toBe(false)
  })

  it('the alert line goes when the person tries again', async () => {
    const onSubmit = vi
      .fn<(values: TimeListItemValues) => Promise<SubmitResult>>()
      .mockResolvedValueOnce('other')
      .mockReturnValueOnce(new Promise(() => {}))
    setup({ onSubmit })
    type('Seminars')
    submit()
    await screen.findByTestId('time-lists-dialog-error')

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('time-lists-dialog-error')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (E) While it saves
// ---------------------------------------------------------------------------

describe('while the request is in flight', () => {
  it('the submit button is busy and reads "Adding…", the fields and Cancel cannot be used, and a second submit sends nothing', async () => {
    const onSubmit = vi
      .fn<(values: TimeListItemValues) => Promise<SubmitResult>>()
      .mockReturnValue(new Promise(() => {}))
    setup({ onSubmit })
    type('Seminars')

    submit()

    await waitFor(() => expect(submitButton().getAttribute('aria-busy')).toBe('true'))
    expect(submitButton().textContent).toBe('Adding…')
    expect(nameInput().matches(':disabled')).toBe(true)
    expect((screen.getByTestId('time-lists-dialog-cancel') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(nameInput().closest('form')!)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('a rename says "Saving…"', async () => {
    const onSubmit = vi
      .fn<(values: TimeListItemValues) => Promise<SubmitResult>>()
      .mockReturnValue(new Promise(() => {}))
    setup({ item: training, onSubmit })

    submit()

    await waitFor(() => expect(submitButton().textContent).toBe('Saving…'))
  })

  it('Escape does not close it while it saves', async () => {
    const pending = vi
      .fn<(values: TimeListItemValues) => Promise<SubmitResult>>()
      .mockReturnValueOnce(new Promise(() => {}))
    const { onCancel } = setup({ onSubmit: pending })
    type('Seminars')
    submit()
    await waitFor(() => expect(submitButton().getAttribute('aria-busy')).toBe('true'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })
})
