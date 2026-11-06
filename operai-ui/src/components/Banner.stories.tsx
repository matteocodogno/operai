import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Banner } from './Banner'
import { Button } from './Button'

/**
 * An inline message about the page or a section of it. Choose the tone by
 * meaning: `warning` (orange) for a recoverable failure the person can retry,
 * `danger` (red) for something that failed and needs them, `success` for a
 * confirmation, `info` for a neutral notice. `warning` and `danger` are
 * `role="alert"`; `info` and `success` a polite `role="status"`. The body
 * stays in the text colour; the tone is in the border, tint and title.
 */
const meta = {
  title: 'Components/Feedback/Banner',
  component: Banner,
  tags: ['autodocs'],
  args: {
    tone: 'warning',
    title: 'Items unavailable',
    children: 'The items could not be loaded. Check your connection and try again.',
    retryLabel: 'Retry',
    onRetry: fn(),
    compact: false,
  },
  argTypes: {
    tone: { control: 'inline-radio', options: ['info', 'success', 'warning', 'danger'] },
    title: { control: 'text' },
    children: { control: 'text' },
    actions: { control: false },
  },
} satisfies Meta<typeof Banner>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const Tones: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex max-w-2xl flex-col gap-3">
      <Banner tone="info">Prices change on 01.12.2026.</Banner>
      <Banner tone="success">Item saved.</Banner>
      <Banner tone="warning">The items could not be loaded.</Banner>
      <Banner tone="danger">The item could not be saved: the name is already taken.</Banner>
    </div>
  ),
}

/** A bold first line in the tone's text colour. */
export const WithTitle: Story = {
  name: 'With a title',
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex max-w-2xl flex-col gap-3">
      <Banner tone="warning" title="Service unavailable">
        The catalogue service did not answer. Your changes are kept.
      </Banner>
      <Banner tone="danger" title="Some fields need attention">
        <ul className="list-disc pl-5">
          <li>Enter a name.</li>
          <li>Enter a price with at most two decimals.</li>
        </ul>
      </Banner>
    </div>
  ),
}

/** A failed load: warning tone with a Retry button (`secondary`, `sm`). */
export const WithRetry: Story = {
  args: { tone: 'warning', title: undefined, onDismiss: undefined },
}

export const Dismissible: Story = {
  args: {
    tone: 'info',
    title: undefined,
    children: 'Prices change on 01.12.2026.',
    onRetry: undefined,
    onDismiss: fn(),
    dismissLabel: 'Dismiss',
  },
}

/** Other actions go in the `actions` slot, before Retry and ×. */
export const WithActions: Story = {
  name: 'With actions',
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="max-w-2xl">
      <Banner
        tone="warning"
        title="Someone else changed this item"
        actions={
          <>
            <Button size="sm" onClick={fn()}>
              Reload latest
            </Button>
            <Button size="sm" variant="ghost" onClick={fn()}>
              Save as a copy
            </Button>
          </>
        }
      >
        Your version is out of date.
      </Banner>
    </div>
  ),
}

/**
 * In a narrow container (a phone at 360px) the actions wrap below the message, which keeps its readable
 * width, instead of being squeezed to a word per line beside them.
 */
export const NarrowWithActions: Story = {
  name: 'With actions, narrow',
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="w-80">
      <Banner
        tone="info"
        title="Awaiting project manager"
        actions={
          <Button size="sm" variant="primary" onClick={fn()}>
            Pick project manager
          </Button>
        }
      >
        Ada Rossi is the ops manager for this purchase order and will pick the project manager.
      </Banner>
    </div>
  ),
}

function TransientSave({ dismissible }: { dismissible: boolean }) {
  const [shown, setShown] = useState(true)
  const [count, setCount] = useState(1)
  return (
    <div className="flex max-w-2xl flex-col items-start gap-3">
      <Button
        variant="primary"
        onClick={() => {
          setShown(true)
          setCount(count + 1)
        }}
      >
        Save item
      </Button>
      {shown && (
        <Banner
          key={count}
          tone="success"
          compact
          autoDismiss
          dismissible={dismissible}
          onDismiss={() => setShown(false)}
          dismissLabel="Dismiss"
        >
          Item saved.
        </Banner>
      )}
    </div>
  )
}

/** A transient save confirmation: `compact`, auto-dismissed after 3s. Click Save to show it again. */
export const CompactAutoDismiss: Story = {
  name: 'Compact, auto-dismiss',
  parameters: { controls: { disable: true } },
  render: () => <TransientSave dismissible />,
}

/** `dismissible={false}` hides the × while `onDismiss` still runs for the auto-dismiss. */
export const NotDismissible: Story = {
  name: 'Auto-dismiss without ×',
  parameters: { controls: { disable: true } },
  render: () => <TransientSave dismissible={false} />,
}
