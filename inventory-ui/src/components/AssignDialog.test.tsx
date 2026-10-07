/**
 * @vitest-environment jsdom
 *
 * Component tests for AssignDialog (T33, specs/015-hardware-inventory; design.md
 * F3, § Dialogs, § Accessibility "Holder picker"; refs AC-2.1, AC-2.2, AC-2.10).
 * `directoryApi` and `assignmentsApi` are the data seams.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { AssetView, DirectoryUser } from '../lib/types'

const { listDirectory, createAssignment } = vi.hoisted(() => ({ listDirectory: vi.fn(), createAssignment: vi.fn() }))
vi.mock('../lib/directoryApi', () => ({ listDirectory }))
vi.mock('../lib/assignmentsApi', () => ({ createAssignment }))

import AssignDialog from './AssignDialog'

const asset: AssetView = {
  id: 'a1',
  entity: 'welld_ch',
  currency: 'CHF',
  category: 'laptop',
  description: 'MacBook Pro 14',
  serialNumber: 'SN123',
  purchaseDate: '2026-09-25',
  purchasePriceCents: 99815,
  status: 'in_stock',
  holder: null,
  pendingAssignment: null,
  locationNote: null,
  supplier: null,
  invoiceRef: null,
  invoiceFile: null,
  toVerify: false,
  disposal: null,
}

const USERS: DirectoryUser[] = [
  { id: 'u1', name: 'Anna Rossi', email: 'anna@welld.ch', entity: 'welld_ch' },
  { id: 'u2', name: 'Marco Bianchi', email: 'marco@welld.it', entity: 'welld_it' },
  { id: 'u3', name: null, email: 'noname@welld.ch', entity: null },
]

const onAssigned = vi.fn()
const onCancel = vi.fn()
const onConflict = vi.fn()

const renderDialog = async () => {
  render(<AssignDialog asset={asset} onAssigned={onAssigned} onCancel={onCancel} onConflict={onConflict} />)
  return await screen.findByRole('dialog')
}
const picker = () => screen.getByRole('combobox', { name: 'Holder' }) as HTMLInputElement
const submit = () => screen.getByRole('button', { name: 'Assign' }) as HTMLButtonElement
const pick = async (name: string) => {
  fireEvent.focus(picker())
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }))
}

beforeEach(() => {
  listDirectory.mockResolvedValue({ users: USERS })
  createAssignment.mockResolvedValue({ ...asset, pendingAssignment: { id: 'p1' } })
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the picker', () => {
  it('is a labelled dialog whose description names the asset and the consequence, with the picker focused', async () => {
    const dialog = await renderDialog()

    expect(within(dialog).getByRole('heading', { name: 'Assign asset' })).not.toBeNull()
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull()
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toContain('MacBook Pro 14')
    expect(document.activeElement).toBe(picker())
  })

  it('shows a loading line inside the list while the directory loads, and announces it', async () => {
    listDirectory.mockReturnValue(new Promise(() => undefined))
    await renderDialog()
    fireEvent.focus(picker())

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('Loading users…')).not.toBeNull()
    expect(screen.getByTestId('assign-holder-live').textContent).toBe('Loading users…')
  })

  it('lists the active users as "name, email, entity" options', async () => {
    await renderDialog()
    fireEvent.focus(picker())

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0].textContent).toContain('Anna Rossi')
    expect(options[0].textContent).toContain('anna@welld.ch, WellD CH')
    expect(options[1].textContent).toContain('marco@welld.it, WellD Italia')
    // A user with no display name and no entity still has a usable option.
    expect(options[2].textContent).toContain('noname@welld.ch')
    expect(options[2].textContent).not.toContain(', null')
  })

  it('requests the directory once', async () => {
    await renderDialog()
    fireEvent.focus(picker())
    await screen.findAllByRole('option')
    expect(listDirectory).toHaveBeenCalledTimes(1)
  })

  it('filters by what is typed, in the name or the email, ignoring case', async () => {
    await renderDialog()
    fireEvent.change(picker(), { target: { value: 'MARCO' } })
    expect(await screen.findAllByRole('option')).toHaveLength(1)

    fireEvent.change(picker(), { target: { value: 'noname@' } })
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain('noname@welld.ch')
  })

  it('says "No active users match" in the list, and announces it, when nothing matches', async () => {
    await renderDialog()
    fireEvent.change(picker(), { target: { value: 'zzz' } })

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('No active users match')).not.toBeNull()
    await waitFor(() => expect(screen.getByTestId('assign-holder-live').textContent).toBe('No active users match'))
  })

  it('says the same when the directory itself is empty', async () => {
    listDirectory.mockResolvedValue({ users: [] })
    await renderDialog()
    fireEvent.focus(picker())

    expect(within(await screen.findByRole('listbox')).getByText('No active users match')).not.toBeNull()
  })

  it('a 429 shows the wait in the list with Retry, which loads the directory again', async () => {
    listDirectory.mockRejectedValueOnce(new ApiError({ status: 429, title: 'Too Many', retryAfterSeconds: 12 }))
    await renderDialog()
    fireEvent.focus(picker())

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('Too many lookups. Try again in 12 seconds.')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect((await screen.findAllByRole('option')).length).toBe(3)
    expect(listDirectory).toHaveBeenCalledTimes(2)
  })

  it('a 429 without Retry-After still shows a message', async () => {
    listDirectory.mockRejectedValueOnce(new ApiError({ status: 429, title: 'Too Many' }))
    await renderDialog()
    fireEvent.focus(picker())

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('Too many lookups. Try again shortly.')).not.toBeNull()
  })

  it('a network failure shows the connection message with Retry', async () => {
    listDirectory.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderDialog()
    fireEvent.focus(picker())

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText(/Could not reach the server/)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
  })
})

describe('assigning (AC-2.1)', () => {
  it('keeps Assign disabled until a person is picked', async () => {
    await renderDialog()
    expect(submit().disabled).toBe(true)

    await pick('Anna Rossi')

    expect(picker().value).toBe('Anna Rossi')
    expect(submit().disabled).toBe(false)
  })

  it('typing again after a pick clears the choice', async () => {
    await renderDialog()
    await pick('Anna Rossi')

    fireEvent.change(picker(), { target: { value: 'Anna Ros' } })

    expect(submit().disabled).toBe(true)
  })

  it('assigns the picked person and hands the updated asset to onAssigned', async () => {
    const updated = { ...asset, pendingAssignment: { id: 'p1' } }
    createAssignment.mockResolvedValue(updated)
    await renderDialog()
    await pick('Marco Bianchi')

    fireEvent.click(submit())

    await waitFor(() => expect(onAssigned).toHaveBeenCalledWith(updated))
    expect(createAssignment).toHaveBeenCalledWith('a1', 'u2')
  })

  it('shows the in-flight state: Assign is busy and the picker is locked', async () => {
    createAssignment.mockReturnValue(new Promise(() => undefined))
    await renderDialog()
    await pick('Anna Rossi')
    fireEvent.click(submit())

    const busy = await screen.findByRole('button', { name: 'Assigning…' })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(picker().matches(':disabled')).toBe(true)
  })

  it('Cancel calls onCancel without a request', async () => {
    await renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(createAssignment).not.toHaveBeenCalled()
  })
})

describe('failures', () => {
  const failWith = async (error: unknown) => {
    createAssignment.mockRejectedValue(error)
    await renderDialog()
    await pick('Anna Rossi')
    fireEvent.click(submit())
  }

  it('unknown_user says the person can no longer receive devices and keeps the dialog for another pick', async () => {
    await failWith(new ApiError({ status: 422, title: 'Unprocessable', code: 'unknown_user' }))

    expect((await screen.findByTestId('assign-asset-error')).textContent).toBe(
      'That person can no longer receive devices.',
    )
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(onConflict).not.toHaveBeenCalled()
    expect(submit().disabled).toBe(false)
  })

  it.each([
    ['invalid_transition', { status: 409, code: 'invalid_transition', extras: { from: 'assigned' } }],
    ['assignment_pending', { status: 409, code: 'assignment_pending' }],
    ['asset_disposed', { status: 409, code: 'asset_disposed' }],
    ['a 404', { status: 404 }],
  ])('%s is handed to the page', async (_name, init) => {
    const error = new ApiError({ title: 'Conflict', ...init })
    await failWith(error)

    await waitFor(() => expect(onConflict).toHaveBeenCalledWith(error))
  })

  it('a 503 says authorization is unavailable and nothing was changed', async () => {
    await failWith(new ApiError({ status: 503, title: 'Unavailable' }))
    expect((await screen.findByTestId('assign-asset-error')).textContent).toContain('Authorization service unavailable')
  })

  it('a network failure shows the connection message and keeps the choice', async () => {
    await failWith(new TypeError('Failed to fetch'))

    expect((await screen.findByTestId('assign-asset-error')).textContent).toContain('Could not reach the server')
    expect(picker().value).toBe('Anna Rossi')
    expect(submit().disabled).toBe(false)
  })
})
