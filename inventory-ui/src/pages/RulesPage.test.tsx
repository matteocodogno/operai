/**
 * @vitest-environment jsdom
 *
 * Page tests for RulesPage (T37, specs/015-hardware-inventory; design.md T4, F11,
 * § Accessibility "T4 rules"; refs AC-6.1, AC-6.2, AC-6.5). `rulesApi`, `getScope`
 * and `usePermissions` are mocked at their seams; the New rule dialog is the real
 * one (it has its own tests) so the add flow is asserted end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Permission } from 'shell/session'
import { ApiError } from '../lib/api'
import type { Entity, Rule } from '../lib/types'

const { usePermissions, listRules, createRule, getScope } = vi.hoisted(() => ({
  usePermissions: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  getScope: vi.fn(),
}))
vi.mock('shell/session', () => ({ usePermissions }))
vi.mock('../lib/rulesApi', () => ({ listRules, createRule }))
vi.mock('../lib/scopeApi', () => ({ getScope }))

import RulesPage from './RulesPage'

const ASSETS: Permission = { resource: 'asset', action: 'manage' }
const LEDGER: Permission = { resource: 'ledger', action: 'manage' }

const SEED = { id: 'system:seed', name: null, status: 'system' as const }
const ANNA = { id: 'u1', name: 'Anna Rossi', status: 'active' as const }

const rule = (id: string, effectiveFrom: string, over: Partial<Rule> = {}): Rule => ({
  id,
  entity: 'welld_ch',
  effectiveFrom,
  usefulLifeYears: 3,
  firstYearShare: 'full',
  lowValueThresholdCents: null,
  residualCents: 100,
  createdBy: SEED,
  createdAt: '2020-01-01T08:30:00Z',
  ...over,
})

const PAST = rule('past', '2018-01-01')
const CURRENT = rule('current', '2021-01-01', {
  usefulLifeYears: 4,
  firstYearShare: 'half',
  lowValueThresholdCents: 80000,
  residualCents: 150,
  createdBy: ANNA,
  createdAt: '2020-12-15T08:30:00Z',
})
const FUTURE = rule('future', '2999-01-01', { createdBy: ANNA, createdAt: '2026-10-01T08:30:00Z' })

const asUser = (permissions: Permission[], ledger: Entity[]) => {
  usePermissions.mockReturnValue({ epoch: 0, apps: ['inventory'], roles: [], departments: [], permissions })
  getScope.mockResolvedValue({ asset: [], ledger })
}

const rowOf = (text: string) => screen.getByRole('rowheader', { name: text }).closest('tr') as HTMLTableRowElement

beforeEach(() => {
  asUser([LEDGER], ['welld_ch'])
  listRules.mockResolvedValue({ rules: [PAST, CURRENT, FUTURE], inForceId: 'current' })
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RulesPage — access', () => {
  it('shows PermissionDenied and calls nothing for a caller without ledger:manage', async () => {
    asUser([ASSETS], ['welld_ch'])
    render(<RulesPage />)

    expect(await screen.findByTestId('permission-denied')).toBeTruthy()
    expect(getScope).not.toHaveBeenCalled()
    expect(listRules).not.toHaveBeenCalled()
  })
})

describe('RulesPage — rules per entity (AC-6.1)', () => {
  it('lists past, current and future rules with their figures, status, who added them and when', async () => {
    render(<RulesPage />)

    const table = await screen.findByRole('table', { name: 'Depreciation rules for WellD CH' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Effective from',
      'Useful life (years)',
      'First-year share',
      'Low-value threshold',
      'Residual value',
      'Added by',
      'Added on',
      'Status',
    ])

    const current = within(rowOf('01.01.2021'))
    expect(current.getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      '4',
      'Half',
      '800,00 CHF',
      '1,50 CHF',
      'Anna Rossi',
      '15.12.2020',
      expect.stringContaining('In force'),
    ])

    const past = within(rowOf('01.01.2018'))
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
    expect(past).toEqual([
      '3',
      'Full',
      'None',
      '1,00 CHF',
      'System',
      '01.01.2020',
      expect.stringContaining('Superseded'),
    ])

    const future = within(rowOf('01.01.2999'))
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
    expect(future.at(-1)).toContain('Scheduled')
  })

  it('marks the rule in force with text, and only that one', async () => {
    render(<RulesPage />)
    await screen.findByRole('table')

    expect(screen.getAllByText('In force')).toHaveLength(1)
    expect(within(rowOf('01.01.2021')).getByText('In force')).toBeTruthy()
  })

  it('shows one section per entity in scope, each with its own button and its own currency', async () => {
    asUser([LEDGER], ['welld_ch', 'welld_it'])
    listRules.mockImplementation((entity: Entity) =>
      Promise.resolve({
        rules: [rule(`r-${entity}`, '2021-01-01', { entity, residualCents: 250 })],
        inForceId: `r-${entity}`,
      }),
    )
    render(<RulesPage />)

    expect(await screen.findByRole('table', { name: 'Depreciation rules for WellD CH' })).toBeTruthy()
    expect(await screen.findByRole('table', { name: 'Depreciation rules for WellD Italia' })).toBeTruthy()
    expect(listRules.mock.calls.map((call) => call[0]).sort()).toEqual(['welld_ch', 'welld_it'])
    expect(screen.getByRole('button', { name: 'New rule for WellD CH' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New rule for WellD Italia' })).toBeTruthy()
    expect(within(screen.getByRole('table', { name: /Italia/ })).getByText('2,50 €')).toBeTruthy()
  })

  it('only lists entities in the caller’s ledger scope', async () => {
    asUser([LEDGER], ['welld_it'])
    render(<RulesPage />)

    await screen.findByRole('table')
    expect(listRules).toHaveBeenCalledTimes(1)
    expect(listRules.mock.calls[0][0]).toBe('welld_it')
    expect(screen.queryByRole('button', { name: /WellD CH/ })).toBeNull()
  })

  it('says so when no entity is in scope', async () => {
    asUser([LEDGER], [])
    render(<RulesPage />)

    expect(await screen.findByText(/No entity is in your scope/)).toBeTruthy()
    expect(listRules).not.toHaveBeenCalled()
  })

  it('has no edit, delete or remove affordance anywhere (AC-6.5)', async () => {
    render(<RulesPage />)
    await screen.findByRole('table')

    expect(screen.queryByRole('button', { name: /edit|delete|remove|change/i })).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['New rule for WellD CH'])
  })
})

describe('RulesPage — states', () => {
  it('shows a loading state for the sections while they load', async () => {
    listRules.mockReturnValue(new Promise(() => undefined))
    render(<RulesPage />)

    expect(await screen.findByText('Loading rules for WellD CH')).toBeTruthy()
    expect(screen.getByTestId('skeleton-list-rows')).toBeTruthy()
  })

  it('shows an empty section with its New rule button', async () => {
    listRules.mockResolvedValue({ rules: [], inForceId: '' })
    render(<RulesPage />)

    expect(await screen.findByText('No rule is configured for WellD CH.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New rule for WellD CH' })).toBeTruthy()
  })

  it('shows a section error with Retry that loads again', async () => {
    listRules
      .mockRejectedValueOnce(new ApiError({ status: 500, title: 'x', detail: 'Rules are down.' }))
      .mockResolvedValueOnce({ rules: [CURRENT], inForceId: 'current' })
    render(<RulesPage />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Rules are down.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('table')).toBeTruthy()
  })

  it('uses the authorization-unavailable presentation on a 503', async () => {
    listRules.mockRejectedValue(new ApiError({ status: 503, title: 'x' }))
    render(<RulesPage />)

    expect((await screen.findByTestId('error-banner-heading')).textContent).toBe('Authorization service unavailable')
  })

  it('shows PermissionDenied in the section on a 403', async () => {
    listRules.mockRejectedValue(new ApiError({ status: 403, title: 'x' }))
    render(<RulesPage />)

    expect(await screen.findByTestId('permission-denied')).toBeTruthy()
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('shows an error when the scope cannot be loaded', async () => {
    getScope.mockRejectedValue(new ApiError({ status: 500, title: 'x', detail: 'Scope is down.' }))
    render(<RulesPage />)

    expect((await screen.findByRole('alert')).textContent).toContain('Scope is down.')
  })
})

describe('RulesPage — adding a rule (AC-6.2)', () => {
  const NEW = rule('new', '2027-01-01', { usefulLifeYears: 5, createdBy: ANNA, createdAt: '2026-10-07T08:30:00Z' })

  const addRule = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'New rule for WellD CH' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.change(within(dialog).getByLabelText(/Effective from/), { target: { value: '2027-01-01' } })
    fireEvent.change(within(dialog).getByLabelText(/Useful life/), { target: { value: '5' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Full' }))
    fireEvent.change(within(dialog).getByLabelText(/Residual value/), { target: { value: '1' } })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }))
  }

  it('opens the dialog for that entity with the rule in force beside it', async () => {
    render(<RulesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'New rule for WellD CH' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByTestId('new-rule-in-force').textContent).toContain('life 4 y, half first year')
  })

  it('reloads, announces the rule, shows it and moves focus to its row header', async () => {
    let added = false
    createRule.mockImplementation(() => {
      added = true
      return Promise.resolve(NEW)
    })
    listRules.mockImplementation(() =>
      Promise.resolve({ rules: added ? [PAST, CURRENT, NEW, FUTURE] : [PAST, CURRENT, FUTURE], inForceId: 'current' }),
    )
    render(<RulesPage />)
    await addRule()
    await waitFor(() => expect(createRule).toHaveBeenCalled())

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Rule added. It applies to purchases from 01.01.2027.'),
    )
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('rowheader', { name: '01.01.2027' })))
    expect(listRules.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the dialog open and the list untouched when the save fails', async () => {
    createRule.mockRejectedValue(new ApiError({ status: 503, title: 'x' }))
    render(<RulesPage />)
    await addRule()

    expect(await screen.findByText(/We cannot verify your access right now/)).toBeTruthy()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(listRules).toHaveBeenCalledTimes(1)
  })

  it('closes the dialog on Cancel without a request', async () => {
    render(<RulesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'New rule for WellD CH' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(createRule).not.toHaveBeenCalled()
  })
})
