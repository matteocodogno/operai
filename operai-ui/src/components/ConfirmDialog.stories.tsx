import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Button } from './Button'
import { ConfirmDialog } from './ConfirmDialog'
import { Field } from './Field'
import { DateInput } from './MoneyInput'
import type { ConfirmDialogProps } from './ConfirmDialog'

/**
 * An `alertdialog` asking to confirm one action; it replaces
 * `window.confirm()`. Cancel takes focus on open (the safe default). `tone`
 * is `danger` (default) for anything destructive or irreversible, `primary`
 * for a positive but consequential confirmation. In flight both buttons are
 * disabled, the confirm button is busy and the dialog cannot be dismissed; a
 * failure comes back inline and the dialog stays open.
 */
const meta = {
  title: 'Components/Dialogs/ConfirmDialog',
  component: ConfirmDialog,
  tags: ['autodocs'],
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
  args: {
    title: 'Delete “Oak desk lamp”?',
    children: 'The item and its history are deleted for everyone. This cannot be undone.',
    confirmLabel: 'Delete item',
    busyLabel: 'Deleting…',
    cancelLabel: 'Cancel',
    closeLabel: 'Close',
    tone: 'danger',
    busy: false,
    error: null,
    onConfirm: fn(),
    onCancel: fn(),
  },
  argTypes: {
    tone: { control: 'inline-radio', options: ['danger', 'primary'] },
    title: { control: 'text' },
    children: { control: 'text' },
    error: { control: 'text' },
  },
} satisfies Meta<typeof ConfirmDialog>
export default meta

type Story = StoryObj<typeof meta>

/** The dialog opens with the story; Cancel or Escape closes it, the trigger reopens it. */
function WithTrigger({ trigger, ...props }: ConfirmDialogProps & { trigger: string }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <Button variant={props.tone === 'primary' ? 'secondary' : 'danger'} onClick={() => setOpen(true)}>
        {trigger}
      </Button>
      {open && (
        <ConfirmDialog
          {...props}
          onCancel={() => {
            props.onCancel()
            setOpen(false)
          }}
          onConfirm={() => {
            props.onConfirm()
            if (!props.busy) setOpen(false)
          }}
        />
      )}
    </>
  )
}

export const Danger: Story = {
  render: (args) => <WithTrigger {...args} trigger="Delete" />,
}

/** A positive confirmation: the confirm button is primary. */
export const Primary: Story = {
  args: {
    tone: 'primary',
    title: 'Publish “Oak desk lamp”?',
    children: 'Everyone with access to the catalogue will see it.',
    confirmLabel: 'Publish',
    busyLabel: 'Publishing…',
  },
  render: (args) => <WithTrigger {...args} trigger="Publish" />,
}

/** In flight: buttons disabled, confirm busy, not dismissible. */
export const Busy: Story = {
  args: { busy: true },
}

/** The request failed: the error is shown inline (role="alert") and the dialog stays open. */
export const WithError: Story = {
  name: 'With an error',
  args: { error: 'The item could not be deleted: the server did not answer. Try again.' },
}

/**
 * An act that cannot be undone and moves money or closes books: Confirm stays
 * disabled until the person ticks the acknowledgement, whose label is the whole
 * sentence. Cancel still takes focus on open, so a stray Space does nothing.
 */
export const Acknowledged: Story = {
  name: 'With an acknowledgement',
  args: {
    tone: 'primary',
    title: 'Mark the March payout as paid?',
    children: '12 requests, CHF 3,480.00. Their status becomes Paid and cannot be changed back.',
    acknowledgeLabel: 'I confirm the bank transfer has been made.',
    confirmLabel: 'Mark as paid',
    busyLabel: 'Marking…',
  },
  render: (args) => <WithTrigger {...args} trigger="Mark as paid" />,
}

/**
 * The act needs input: `fields` sit between the consequence and the
 * acknowledgement, the first one takes focus, Enter confirms, and in flight
 * they are disabled as a group.
 */
export const WithFields: Story = {
  name: 'With fields',
  args: {
    title: 'Retire “Oak desk lamp”?',
    children: 'The item leaves the catalogue for good. Its history is kept.',
    acknowledgeLabel: 'I understand the item cannot be restored.',
    confirmLabel: 'Retire item',
    busyLabel: 'Retiring…',
    fields: (
      <>
        <Field label="Date" required>
          {(control) => <DateInput {...control} defaultValue="2026-10-31" />}
        </Field>
        <Field label="Reason" required>
          {(control) => (
            <select {...control} defaultValue="damaged">
              <option value="damaged">Damaged</option>
              <option value="sold">Sold</option>
            </select>
          )}
        </Field>
      </>
    ),
  },
  argTypes: { fields: { control: false } },
  render: (args) => <WithTrigger {...args} trigger="Retire" />,
}

function LiveDemo({ fail }: { fail: boolean }) {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <div className="flex flex-col items-start gap-3">
      <Button
        variant="danger"
        onClick={() => {
          setDone(false)
          setError(null)
          setOpen(true)
        }}
      >
        Delete
      </Button>
      <p role="status" className="text-sm text-soft">
        {done ? 'Item deleted.' : ''}
      </p>
      {open && (
        <ConfirmDialog
          title="Delete “Oak desk lamp”?"
          confirmLabel="Delete item"
          busyLabel="Deleting…"
          cancelLabel="Cancel"
          closeLabel="Close"
          busy={busy}
          error={error}
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            setBusy(true)
            setError(null)
            timer.current = window.setTimeout(() => {
              setBusy(false)
              if (fail) {
                setError('The item could not be deleted: the server did not answer. Try again.')
              } else {
                setOpen(false)
                setDone(true)
              }
            }, 1200)
          }}
        >
          The item and its history are deleted for everyone. This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  )
}

/** Confirm: 1.2s busy, then the dialog closes and the page confirms. */
export const LiveSuccess: Story = {
  name: 'Live: succeeds',
  parameters: { controls: { disable: true } },
  render: () => <LiveDemo fail={false} />,
}

/** Confirm: 1.2s busy, then the error appears inside the dialog, which stays open. */
export const LiveFailure: Story = {
  name: 'Live: fails',
  parameters: { controls: { disable: true } },
  render: () => <LiveDemo fail />,
}

const LONG_DETAILS = (
  <>
    <p className="m-0">These details are printed on every offer. Check the new values.</p>
    <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
      {[
        ['Legal name', 'Welld Consulting and Engineering Services of Switzerland (Zurich branch) AG in liquidation'],
        ['VAT number', 'CHE-123.456.789 MWST — registered 12 March 2019, replaces CHE-987.654.321 MWST'],
        ['IBAN', 'CH93 0076 2011 6238 5295 7 → DE89 3704 0044 0532 0130 00'],
      ].map(([label, value]) => (
        <li key={label}>
          <strong>{label}</strong>
          <div>{value}</div>
        </li>
      ))}
    </ul>
  </>
)

/**
 * Opt-in `scrollBody`: a long body scrolls between the header and the footer, so Confirm and Cancel are
 * always in view. Shown on a 320 px phone viewport: the footer stays put while the three long details scroll. Without the prop the whole backdrop scrolls, as before.
 */
export const ScrollingBody: Story = {
  name: 'Long body, footer always in view (scrollBody)',
  args: {
    tone: 'primary',
    title: 'Save these changes to WellD CH?',
    children: LONG_DETAILS,
    confirmLabel: 'Save as version 4',
    busyLabel: 'Saving…',
    scrollBody: true,
    size: 'wide',
  },
  // The 320 px phone of the viewport toolbar; the docs page frames it 480 px high.
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  parameters: { docs: { story: { inline: false, iframeHeight: 480 } } },
  render: (args) => <WithTrigger {...args} trigger="Save" />,
}

/**
 * Opt-in `confirmDisabledReason`: Confirm is not available yet — here, the details the question is about are
 * still loading. It is `aria-disabled` (still a focus stop) and described by the reason, which a screen reader
 * reads; Cancel works. Not the same as `busy`, which also disables Cancel and blocks dismissing.
 */
export const ConfirmUnavailable: Story = {
  name: 'Confirm unavailable, with its reason (confirmDisabledReason)',
  args: {
    tone: 'primary',
    title: 'Restore version 3?',
    children: 'Loading the details of version 3 so the changes can be shown first…',
    confirmLabel: 'Restore version 3',
    confirmDisabledReason: 'Loading the details of version 3…',
    size: 'wide',
  },
  render: (args) => <WithTrigger {...args} trigger="Restore" />,
}
