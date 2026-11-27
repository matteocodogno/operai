/**
 * @vitest-environment jsdom
 *
 * Component tests for TeamFormDialog — S2, create and edit (specs/20261126-teams T4, AC-1.1, AC-1.2, AC-3.3).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TeamFormDialog from './TeamFormDialog'
import type { TeamFormDialogProps } from './TeamFormDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetModules()
  document.documentElement.removeAttribute('lang')
})

const baseProps = (): TeamFormDialogProps => ({
  mode: 'create',
  busy: false,
  error: null,
  existingName: null,
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
})

const nameInput = () => screen.getByTestId('create-team-name-input') as HTMLInputElement
const descriptionInput = () => screen.getByTestId('create-team-description-input') as HTMLTextAreaElement
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })
const submit = () => fireEvent.click(screen.getByTestId('create-team-submit'))

describe('TeamFormDialog (create)', () => {
  it('is a dialog titled "New team", focused on Name, with the two hints', () => {
    render(<TeamFormDialog {...baseProps()} />)

    const dialog = screen.getByRole('dialog')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('New team')
    expect(document.activeElement).toBe(nameInput())
    expect(
      screen.getByText('1 to 80 characters. Unique among all teams, archived ones included, ignoring case.'),
    ).not.toBeNull()
    expect(screen.getByText('Optional, up to 500 characters.')).not.toBeNull()
  })

  it('submits the trimmed values; a blank description goes up as an empty string', () => {
    const props = baseProps()
    render(<TeamFormDialog {...props} />)

    type(nameInput(), '  Backend  ')
    submit()
    expect(props.onSubmit).toHaveBeenLastCalledWith({ name: 'Backend', description: '' })

    type(descriptionInput(), '  Builds it  ')
    submit()
    expect(props.onSubmit).toHaveBeenLastCalledWith({ name: 'Backend', description: 'Builds it' })
  })

  it('an empty name is not submitted: the Name field says so and takes focus', () => {
    const props = baseProps()
    render(<TeamFormDialog {...props} />)

    descriptionInput().focus()
    submit()

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('create-team-name-error').textContent).toBe('Name is required.')
    expect(document.activeElement).toBe(nameInput())
  })

  it('refuses 81 characters in the name and 501 in the description, never truncating, and focuses the first invalid field', () => {
    const props = baseProps()
    render(<TeamFormDialog {...props} />)

    type(nameInput(), 'a'.repeat(81))
    type(descriptionInput(), 'b'.repeat(501))
    submit()

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(nameInput().value).toHaveLength(81)
    expect(descriptionInput().value).toHaveLength(501)
    expect(screen.getByTestId('create-team-name-error').textContent).toBe('Use at most 80 characters.')
    expect(screen.getByTestId('create-team-description-error').textContent).toBe('Use at most 500 characters.')
    expect(document.activeElement).toBe(nameInput())
  })

  it('accepts exactly 80 and 500 characters', () => {
    const props = baseProps()
    render(<TeamFormDialog {...props} />)

    type(nameInput(), 'a'.repeat(80))
    type(descriptionInput(), 'b'.repeat(500))
    submit()

    expect(props.onSubmit).toHaveBeenCalledWith({ name: 'a'.repeat(80), description: 'b'.repeat(500) })
  })

  it('a description over the limit alone focuses the description', () => {
    render(<TeamFormDialog {...baseProps()} />)

    type(nameInput(), 'Backend')
    type(descriptionInput(), 'b'.repeat(501))
    submit()

    expect(document.activeElement).toBe(descriptionInput())
  })

  it('busy disables the fields and shows "Creating…"', () => {
    render(<TeamFormDialog {...baseProps()} busy />)

    expect(nameInput().closest('fieldset')?.disabled).toBe(true)
    expect(screen.getByTestId('create-team-submit').textContent).toBe('Creating…')
  })

  it('a form-level error shows in form-error and keeps the typed values', () => {
    const { rerender } = render(<TeamFormDialog {...baseProps()} />)
    type(nameInput(), 'Backend')

    rerender(<TeamFormDialog {...baseProps()} error="Could not create the team." />)

    expect(screen.getByTestId('create-team-error').textContent).toContain('Could not create the team.')
    expect(nameInput().value).toBe('Backend')
  })

  it('Escape and Cancel call onCancel', () => {
    const props = baseProps()
    render(<TeamFormDialog {...props} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('create-team-cancel'))

    expect(props.onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('TeamFormDialog name clash (AC-1.2, AC-3.3)', () => {
  it('names the existing team, as stored, on the Name field in English and moves focus back to it', () => {
    const { rerender } = render(<TeamFormDialog {...baseProps()} />)
    type(nameInput(), 'backend')
    descriptionInput().focus()

    rerender(<TeamFormDialog {...baseProps()} existingName="Backend" />)

    const error = screen.getByTestId('create-team-name-error')
    expect(error.textContent).toBe('A team named “Backend” already exists. Archived teams count too.')
    expect(nameInput().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(nameInput())
    // The clash is about one field: it is not repeated in the form-level slot, and the typed text is kept.
    expect(screen.queryByTestId('create-team-error')).toBeNull()
    expect(nameInput().value).toBe('backend')
  })

  it('renders the existing name as text, never as markup', () => {
    render(<TeamFormDialog {...baseProps()} existingName={'<img src=x onerror=alert(1)> & Co'} />)

    expect(screen.getByTestId('create-team-name-error').textContent).toContain('<img src=x onerror=alert(1)> & Co')
    expect(document.querySelector('img')).toBeNull()
  })

  it('names it in Italian when the page language is Italian', async () => {
    document.documentElement.setAttribute('lang', 'it')
    const { default: ItalianDialog } = await import('./TeamFormDialog')

    render(<ItalianDialog {...baseProps()} existingName="Backend" />)

    expect(screen.getByTestId('create-team-name-error').textContent).toBe(
      'Esiste già un team chiamato “Backend”. Contano anche i team archiviati.',
    )
    expect(screen.getByTestId('create-team-submit').textContent).toBe('Crea')
  })

  it('typing in the name clears the clash message only for the text it was raised for', () => {
    const { rerender } = render(<TeamFormDialog {...baseProps()} />)
    type(nameInput(), 'backend')
    rerender(<TeamFormDialog {...baseProps()} existingName="Backend" />)
    expect(screen.queryByTestId('create-team-name-error')).not.toBeNull()

    type(nameInput(), 'backend2')

    expect(screen.queryByTestId('create-team-name-error')).toBeNull()
  })

  it('the clash does not stop a resubmit of another name', () => {
    const props = baseProps()
    const { rerender } = render(<TeamFormDialog {...props} />)
    type(nameInput(), 'backend')
    rerender(<TeamFormDialog {...props} existingName="Backend" />)

    type(nameInput(), 'Platform')
    submit()

    expect(props.onSubmit).toHaveBeenCalledWith({ name: 'Platform', description: '' })
  })
})

describe('TeamFormDialog (edit)', () => {
  const editProps = (): TeamFormDialogProps => ({
    ...baseProps(),
    mode: 'edit',
    initial: { name: 'Backend', description: 'Builds it' },
  })

  it('is titled "Edit team", prefilled, with its own test ids and a Save button', () => {
    render(<TeamFormDialog {...editProps()} />)

    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBeTruthy()
    expect((screen.getByTestId('edit-team-name-input') as HTMLInputElement).value).toBe('Backend')
    expect((screen.getByTestId('edit-team-description-input') as HTMLTextAreaElement).value).toBe('Builds it')
    expect(screen.getByTestId('edit-team-submit').textContent).toBe('Save')
  })

  it('a null description opens as an empty field', () => {
    render(<TeamFormDialog {...editProps()} initial={{ name: 'Backend', description: null }} />)

    expect((screen.getByTestId('edit-team-description-input') as HTMLTextAreaElement).value).toBe('')
  })

  it('submitBlocked keeps Save from submitting while the error says why, and the values stay', () => {
    const props = { ...editProps(), submitBlocked: true, error: 'Someone else changed this team.' }
    render(<TeamFormDialog {...props} />)

    fireEvent.change(screen.getByTestId('edit-team-name-input'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByTestId('edit-team-submit'))

    expect(props.onSubmit).not.toHaveBeenCalled()
    expect((screen.getByTestId('edit-team-name-input') as HTMLInputElement).value).toBe('Renamed')
    expect(screen.getByTestId('edit-team-error').textContent).toContain('Someone else changed this team.')
  })
})

describe('no nested form (ADR 20261118)', () => {
  it.each([
    ['idle', {}],
    ['busy', { busy: true }],
    ['error', { error: 'Could not create the team.' }],
    ['clash', { existingName: 'Backend' }],
  ])('the %s dialog holds one form and no form inside a form', (_state, extra) => {
    render(<TeamFormDialog {...baseProps()} {...extra} />)

    expect(document.querySelectorAll('form').length).toBe(1)
    expect(document.querySelectorAll('form form').length).toBe(0)
  })
})
