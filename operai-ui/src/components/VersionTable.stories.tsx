import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { VersionTable } from './VersionTable'
import type { VersionTableLabels, VersionTableRow } from './VersionTable'

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
    version: 4,
    current: true,
    restoredFrom: 2,
    savedBy: 'Ada Rossi',
    savedAt: '2026-11-17T09:30:00Z',
    changed: 'Same details as version 2',
  },
  {
    version: 3,
    current: false,
    restoredFrom: null,
    savedBy: 'Luca Bianchi',
    savedAt: '2026-11-16T14:05:00Z',
    changed: 'Address, IBAN',
  },
  {
    version: 2,
    current: false,
    restoredFrom: null,
    savedBy: 'Ada Rossi',
    savedAt: '2026-11-15T10:12:00Z',
    changed: 'Legal name',
  },
  {
    version: 1,
    current: false,
    restoredFrom: null,
    savedBy: 'System',
    savedAt: '2026-11-14T08:00:00Z',
    changed: 'Moved from the CRM',
  },
]

/**
 * The history of a record: version (row header, a Current badge on the one in effect, "Restored from version m"
 * under a restored one), who, when, what changed, and Open / Restore buttons whose names carry the version
 * ("Open version 3"). The current row has no Restore. A version that cannot be restored keeps a focusable,
 * `aria-disabled` Restore with its reason beside it. Rows come newest first; the app fetches, words "what changed"
 * and runs the restore (a `ConfirmDialog`). Built on `DataTable`.
 */
const meta = {
  title: 'Components/Data/VersionTable',
  component: VersionTable,
  tags: ['autodocs'],
  args: {
    caption: 'Versions of WellD SA',
    rows,
    labels,
    canRestore: true,
    onOpen: fn(),
    onRestore: fn(),
  },
  argTypes: {
    rows: { control: 'object' },
    labels: { control: false },
    onOpen: { control: false },
    onRestore: { control: false },
  },
} satisfies Meta<typeof VersionTable>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A person who may not change the record sees Open only. */
export const ReadOnly: Story = { args: { canRestore: false } }

/** The version is missing a required value: Restore stays, `aria-disabled`, and says why. */
export const WithBlockedRestore: Story = {
  args: {
    rows: rows.map((row) =>
      row.version === 3
        ? {
            ...row,
            restoreBlockedReason:
              'This version cannot be restored: it is missing a required value. Open it to see which.',
          }
        : row,
    ),
  },
}
