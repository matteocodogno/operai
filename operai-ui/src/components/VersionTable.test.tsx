import { afterEach, describe, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VersionTable } from './VersionTable'
import type { VersionTableLabels, VersionTableProps, VersionTableRow } from './VersionTable'

afterEach(cleanup)

const labels: VersionTableLabels = {
  version: 'Version',
  savedBy: 'Saved by',
  savedAt: 'Saved on',
  changed: 'What changed',
  actions: 'Actions',
  current: 'Current',
  restoredFrom: (version) => `Restored from version ${version}`,
  open: 'Open',
  restore: 'Restore',
  openName: (version) => `Open version ${version}`,
  restoreName: (version) => `Restore version ${version}`,
}

const rows: VersionTableRow[] = [
  {
    version: 3,
    current: true,
    restoredFrom: 1,
    savedBy: 'Ada Rossi',
    savedAt: '2026-11-17T09:30:00Z',
    changed: 'Same details as version 1',
  },
  {
    version: 2,
    current: false,
    restoredFrom: null,
    savedBy: 'Luca Bianchi',
    savedAt: '2026-11-16T09:30:00Z',
    changed: 'Address, IBAN',
    restoreBlockedReason: 'This version cannot be restored: it is missing a required value.',
  },
  {
    version: 1,
    current: false,
    restoredFrom: null,
    savedBy: 'System',
    savedAt: '2026-11-15T09:30:00Z',
    changed: 'Moved from the CRM',
  },
]

function view(props: Partial<VersionTableProps> = {}) {
  const onOpen = vi.fn()
  const onRestore = vi.fn()
  const utils = render(
    <VersionTable
      caption="Versions of WellD SA"
      rows={rows}
      labels={labels}
      canRestore
      onOpen={onOpen}
      onRestore={onRestore}
      {...props}
    />,
  )
  return { ...utils, onOpen, onRestore }
}

describe('VersionTable', () => {
  it('is a table with a caption, column headers and the version as row header', () => {
    view()
    const table = screen.getByRole('table', { name: 'Versions of WellD SA' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Version', 'Saved by', 'Saved on', 'What changed', 'Actions'])
    const rowHeaders = within(table).getAllByRole('rowheader')
    expect(rowHeaders).toHaveLength(3)
    expect(rowHeaders[0]).toHaveTextContent('3')
    expect(rowHeaders[0]).toHaveTextContent('Current')
    expect(rowHeaders[0]).toHaveTextContent('Restored from version 1')
    expect(rowHeaders[1]).not.toHaveTextContent('Current')
  })

  it('keeps the order it is given and shows who, when (a time element) and what changed', () => {
    view()
    const [, ...body] = screen.getAllByRole('row')
    expect(body.map((row) => within(row).getAllByRole('rowheader')[0].textContent?.[0])).toEqual(['3', '2', '1'])
    expect(body[0]).toHaveTextContent('Ada Rossi')
    expect(body[2]).toHaveTextContent('System')
    expect(body[2]).toHaveTextContent('Moved from the CRM')
    const time = body[0].querySelector('time')
    expect(time).toHaveAttribute('datetime', '2026-11-17T09:30:00Z')
    expect(time?.textContent).toMatch(/^17\.11\.2026 \d\d:\d\d$/)
  })

  it('names every button after its row and offers no Restore on the current one', () => {
    view()
    expect(screen.getAllByRole('button', { name: /^Open version/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open version 3',
      'Open version 2',
      'Open version 1',
    ])
    expect(screen.queryByRole('button', { name: 'Restore version 3' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Restore version 1' })).toBeInTheDocument()
  })

  it('calls onOpen and onRestore with the row version', async () => {
    const { onOpen, onRestore } = view()
    await userEvent.click(screen.getByRole('button', { name: 'Open version 3' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restore version 1' }))
    expect(onOpen).toHaveBeenCalledWith(3)
    expect(onRestore).toHaveBeenCalledWith(1)
  })

  it('keeps a blocked Restore focusable, aria-disabled, described by its reason, and inert', async () => {
    const { onRestore } = view()
    const restore = screen.getByRole('button', { name: 'Restore version 2' })
    expect(restore).toHaveAttribute('aria-disabled', 'true')
    expect(restore).not.toBeDisabled()
    expect(restore).toHaveAccessibleDescription('This version cannot be restored: it is missing a required value.')
    restore.focus()
    expect(restore).toHaveFocus()
    await userEvent.click(restore)
    await userEvent.keyboard('{Enter}')
    expect(onRestore).not.toHaveBeenCalled()
    // A restorable row has no aria-disabled and no description.
    const other = screen.getByRole('button', { name: 'Restore version 1' })
    expect(other).not.toHaveAttribute('aria-disabled')
    expect(other).not.toHaveAttribute('aria-describedby')
  })

  it('offers Open only when the person cannot restore, and hides the reasons then', () => {
    view({ canRestore: false })
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Open version/ })).toHaveLength(3)
    expect(screen.queryByText(/cannot be restored/)).toBeNull()
  })

  it('ignores a blocked reason on the current row', () => {
    view({ rows: [{ ...rows[0], restoreBlockedReason: 'never shown' }] })
    expect(screen.queryByText('never shown')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull()
  })

  it('formats with formatSavedAt and shows a dash for a date it cannot read', () => {
    view({ formatSavedAt: () => 'FORMATTED', rows: [rows[0], { ...rows[2], savedAt: '' }] })
    expect(screen.getByText('FORMATTED')).toBeInTheDocument()
    const last = screen.getAllByRole('row')[2]
    expect(last.querySelector('time')).toBeNull()
    expect(last).toHaveTextContent('–')
  })

  it('derives test ids per row', () => {
    view({ testId: 'vt', rowTestIdPrefix: 'vt-row' })
    expect(screen.getByTestId('vt')).toBeInTheDocument()
    expect(screen.getByTestId('vt-row-2')).toBeInTheDocument()
    expect(screen.getByTestId('vt-row-2-open')).toHaveAccessibleName('Open version 2')
    expect(screen.getByTestId('vt-row-2-restore')).toHaveAccessibleName('Restore version 2')
  })

  it.each([
    ['manager', true],
    ['read-only', false],
  ])('has no axe violations (%s)', async (_name, canRestore) => {
    const { container } = view({ canRestore })
    const { violations } = await axe.run(container)
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })
})
