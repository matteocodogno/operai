/**
 * @vitest-environment jsdom
 *
 * Component tests for NewRuleDialog (T37, specs/015-hardware-inventory; design.md
 * F11, § Irreversible actions "New rule", § Error and conflict catalogue; refs
 * AC-6.2, AC-6.3, AC-6.4, AC-6.5). `rulesApi.createRule` is the data seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { Rule } from '../lib/types'

const { createRule } = vi.hoisted(() => ({ createRule: vi.fn() }))
vi.mock('../lib/rulesApi', () => ({ createRule }))

import NewRuleDialog from './NewRuleDialog'

const IN_FORCE: Rule = {
  id: 'r1',
  entity: 'welld_ch',
  effectiveFrom: '2020-01-01',
  usefulLifeYears: 3,
  firstYearShare: 'full',
  lowValueThresholdCents: null,
  residualCents: 100,
  createdBy: { id: 'system:seed', name: null, status: 'system' },
  createdAt: '2020-01-01T00:00:00Z',
}
const SAVED: Rule = { ...IN_FORCE, id: 'r2', effectiveFrom: '2027-01-01', usefulLifeYears: 4 }

const onSaved = vi.fn()
const onCancel = vi.fn()

const renderDialog = (over: { inForceRule?: Rule | null } = {}) =>
  render(
    <NewRuleDialog
      entity="welld_ch"
      inForceRule={over.inForceRule === undefined ? IN_FORCE : over.inForceRule}
      onSaved={onSaved}
      onCancel={onCancel}
    />,
  )

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const confirm = () => screen.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement
const acknowledge = () =>
  fireEvent.click(screen.getByRole('checkbox', { name: 'I understand this rule cannot be changed afterwards.' }))

/** A valid form: the minimum the server needs. */
const fillValid = () => {
  type(/Effective from/, '2027-01-01')
  type(/Useful life/, '4')
  fireEvent.click(screen.getByRole('radio', { name: 'Half' }))
  type(/Low-value threshold/, '800')
  type(/Residual value/, '1.50')
}

beforeEach(() => {
  createRule.mockResolvedValue(SAVED)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NewRuleDialog — consequence and acknowledgement (AC-6.2, AC-6.5)', () => {
  it('states that assets purchased on or after the date are rescheduled, and that the rule cannot be changed', () => {
    renderDialog()
    type(/Effective from/, '2027-01-01')

    const description = screen.getByRole('alertdialog').getAttribute('aria-describedby') ?? ''
    const text = document.getElementById(description)?.textContent ?? ''
    expect(text).toContain('purchased on or after 01.01.2027')
    expect(text).toContain('WellD CH')
    expect(text).toContain('including assets already registered')
    expect(text).toContain('Assets purchased earlier keep their schedule')
    expect(text).toContain('cannot be edited or deleted')
  })

  it('does not save until the acknowledgement is ticked', () => {
    renderDialog()
    fillValid()

    expect(confirm().disabled).toBe(true)
    fireEvent.click(confirm())
    expect(createRule).not.toHaveBeenCalled()

    acknowledge()
    expect(confirm().disabled).toBe(false)
  })

  it('shows the rule currently in force for comparison, and omits it when there is none', () => {
    const { unmount } = renderDialog()
    expect(screen.getByTestId('new-rule-in-force').textContent).toContain('life 3 y, full first year, no threshold')
    unmount()
    renderDialog({ inForceRule: null })
    expect(screen.queryByTestId('new-rule-in-force')).toBeNull()
  })
})

describe('NewRuleDialog — saving (AC-6.2)', () => {
  it('sends the rule in integer cents and hands the saved rule to the page', async () => {
    renderDialog()
    fillValid()
    acknowledge()
    fireEvent.click(confirm())

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(SAVED))
    expect(createRule).toHaveBeenCalledWith({
      entity: 'welld_ch',
      effectiveFrom: '2027-01-01',
      usefulLifeYears: 4,
      firstYearShare: 'half',
      lowValueThresholdCents: 80000,
      residualCents: 150,
    })
  })

  it('sends a null threshold when the field is left empty, and accepts a residual of 0', async () => {
    renderDialog()
    type(/Effective from/, '2027-01-01')
    type(/Useful life/, '3')
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }))
    type(/Residual value/, '0')
    acknowledge()
    fireEvent.click(confirm())

    await waitFor(() => expect(createRule).toHaveBeenCalled())
    expect(createRule.mock.calls[0][0]).toMatchObject({ lowValueThresholdCents: null, residualCents: 0 })
  })

  it('cancels without a request', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(createRule).not.toHaveBeenCalled()
  })
})

describe('NewRuleDialog — validation before any request (AC-6.4)', () => {
  const submitWith = (changes: () => void) => {
    renderDialog()
    fillValid()
    changes()
    acknowledge()
    fireEvent.click(confirm())
  }

  it.each([
    [
      'a useful life below 1 year',
      () => type(/Useful life/, '0'),
      /Useful life/,
      'Useful life must be a whole number of at least 1 year.',
    ],
    [
      'a fractional useful life',
      () => type(/Useful life/, '2.5'),
      /Useful life/,
      'Useful life must be a whole number of at least 1 year.',
    ],
    [
      'a negative threshold',
      () => type(/Low-value threshold/, '-1'),
      /Low-value threshold/,
      'Enter a threshold of 0 or more',
    ],
    [
      'a negative residual value',
      () => type(/Residual value/, '-5'),
      /Residual value/,
      'Enter a residual value of 0 or more',
    ],
    [
      'a missing residual value',
      () => type(/Residual value/, ''),
      /Residual value/,
      'Enter a residual value of 0 or more',
    ],
    ['a missing date', () => type(/Effective from/, ''), /Effective from/, 'Enter the effective date.'],
  ])('rejects %s on that field and sends nothing', (_name, change, label, message) => {
    submitWith(change)

    expect(createRule).not.toHaveBeenCalled()
    const field = screen.getByLabelText(label)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(field.getAttribute('aria-describedby') ?? '')
    expect(error?.textContent).toContain(message)
  })

  it('asks for a first-year share when none is chosen', () => {
    renderDialog()
    type(/Effective from/, '2027-01-01')
    type(/Useful life/, '3')
    type(/Residual value/, '1')
    acknowledge()
    fireEvent.click(confirm())

    expect(createRule).not.toHaveBeenCalled()
    expect(screen.getByText('Choose the first-year share.')).toBeTruthy()
  })
})

describe('NewRuleDialog — server errors (AC-6.3, AC-6.4)', () => {
  const submitRejected = async (error: unknown) => {
    createRule.mockRejectedValue(error)
    renderDialog()
    fillValid()
    acknowledge()
    fireEvent.click(confirm())
    await waitFor(() => expect(createRule).toHaveBeenCalled())
  }

  it.each([
    ['effectiveFrom', /Effective from/, 'Enter a valid effective date.'],
    ['usefulLifeYears', /Useful life/, 'Useful life must be a whole number of at least 1 year.'],
    ['lowValueThresholdCents', /Low-value threshold/, 'Enter a threshold of 0 or more'],
    ['residualCents', /Residual value/, 'Enter a residual value of 0 or more'],
  ])('puts a 422 on %s under that field', async (field, label, message) => {
    await submitRejected(new ApiError({ status: 422, title: 'x', detail: 'technical', extras: { field } }))

    const input = await screen.findByLabelText(label)
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'))
    const error = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(error?.textContent).toContain(message)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('shows a general message for a 422 that names no field', async () => {
    await submitRejected(new ApiError({ status: 422, title: 'x' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Check the highlighted fields and try again.')
  })

  it('shows fiscal_year_closed on the date field, naming the year and the entity', async () => {
    await submitRejected(new ApiError({ status: 409, title: 'x', code: 'fiscal_year_closed', extras: { year: 2025 } }))

    const input = await screen.findByLabelText(/Effective from/)
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'))
    const error = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(error?.textContent).toBe('2025 is closed for WellD CH. Choose a date in an open year.')
  })

  it('keeps the dialog open with every typed value on a 503', async () => {
    await submitRejected(new ApiError({ status: 503, title: 'x' }))

    expect((await screen.findByRole('alert')).textContent).toContain('We cannot verify your access right now.')
    expect((screen.getByLabelText(/Residual value/) as HTMLInputElement).value).toBe('1.50')
    expect((screen.getByLabelText(/Effective from/) as HTMLInputElement).value).toBe('2027-01-01')
    expect(onSaved).not.toHaveBeenCalled()
    expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Add rule' })).toBeTruthy()
  })

  it('says it could not reach the server on a network failure, keeping the form', async () => {
    await submitRejected(new TypeError('Failed to fetch'))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the server.')
  })
})
