import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Badge } from './Badge'
import { VersionBanner } from './VersionBanner'

/**
 * What heads a page while an older version of a record is open: an info Banner whose heading takes focus when it
 * appears (give it a `key` per version so it takes focus again), the app's sentence about who saved it and when,
 * **Back** and, for a person who may restore, **Restore** (primary). It is static (`role="note"`): the focus move
 * is the announcement. A version that cannot be restored keeps Restore focusable and `aria-disabled`, with the reason
 * under the message. The app fetches who and when, and runs the restore dialog.
 */
const meta = {
  title: 'Components/Feedback/VersionBanner',
  component: VersionBanner,
  tags: ['autodocs'],
  args: {
    title: 'Viewing version 2 (read-only)',
    headingLevel: 3,
    children: 'Saved by Ada Rossi on 16.11.2026 10:30. The current version is 4.',
    badge: <Badge tone="warning">Not current</Badge>,
    backLabel: 'Back to history',
    onBack: fn(),
    restoreLabel: 'Restore this version',
    onRestore: fn(),
  },
  argTypes: {
    headingLevel: { control: 'inline-radio', options: [2, 3, 4, 5, 6] },
    badge: { control: false },
    onBack: { control: false },
    onRestore: { control: false },
    restoreRef: { control: false },
  },
} satisfies Meta<typeof VersionBanner>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A person who may not change the record: Back only. */
export const ReadOnly: Story = { args: { restoreLabel: undefined, onRestore: undefined } }

export const RestoreBlocked: Story = {
  args: {
    restoreBlockedReason:
      'This version cannot be restored: the IBAN is missing. Restoring it would make the entity incomplete again.',
  },
}
