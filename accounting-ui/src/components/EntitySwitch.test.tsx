/**
 * @vitest-environment jsdom
 *
 * EntitySwitch (design UX-2, AS2, AC-8.2): one labelled native select, only with two or more covered entities; its
 * change goes to the frame, one polite status says what is shown, and focus stays on the select.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccountingContext } from '../hooks/useEntity'
import type { AccountingContextValue } from '../hooks/useEntity'
import type { MeEntity } from '../lib/meApi'
import { expectNoAxeViolations } from '../test-support/axe'
import EntitySwitch from './EntitySwitch'

afterEach(cleanup)

const ch: MeEntity = { entity: 'welld_ch', ownCurrency: 'CHF', canManage: true, rateSource: 'bazg' }
const italia: MeEntity = { entity: 'welld_it', ownCurrency: 'EUR', canManage: false, rateSource: null }

const renderSwitch = (entities: MeEntity[], shown = entities[0]!) => {
  const selectEntity = vi.fn()
  const value: AccountingContextValue = {
    entities,
    entity: shown,
    selectEntity,
    entityGone: vi.fn(),
    writeRefused: vi.fn(),
  }
  const view = render(
    <AccountingContext.Provider value={value}>
      <EntitySwitch />
    </AccountingContext.Provider>,
  )
  return { ...view, selectEntity }
}

describe('EntitySwitch', () => {
  it('shows nothing for one covered entity', () => {
    const { container } = renderSwitch([ch])
    expect(container.textContent).toBe('')
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('is one labelled select of the covered entities, WellD CH first, showing the displayed one', async () => {
    const { container } = renderSwitch([ch, italia], italia)
    const select = screen.getByRole('combobox', { name: 'Entity' }) as HTMLSelectElement
    expect(select.value).toBe('welld_it')
    expect([...select.options].map((option) => option.textContent)).toEqual(['WellD CH', 'WellD Italia'])
    await expectNoAxeViolations(container)
  })

  it('hands the choice to the frame, announces it politely and keeps focus on the select', async () => {
    const user = userEvent.setup()
    const { selectEntity, container } = renderSwitch([ch, italia])
    // Arriving on the page announces nothing.
    expect(screen.getByRole('status').textContent).toBe('')
    const select = screen.getByRole('combobox', { name: 'Entity' })
    await user.selectOptions(select, 'welld_it')
    expect(selectEntity).toHaveBeenCalledWith('welld_it')
    expect(screen.getByRole('status').textContent).toBe('Showing WellD Italia')
    expect(document.activeElement).toBe(select)
    await expectNoAxeViolations(container)
  })
})
