import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button'
import { ProgressBar } from './ProgressBar'

/**
 * Progress of work that takes a while: an upload, "saving audio 3 of 5".
 * `role="progressbar"` with a required accessible name. Determinate when it
 * has a `value`; indeterminate (no `aria-valuenow`) when the length is
 * unknown. `valueText` is the text alternative to the number and is shown
 * beside the bar. It does not announce changes by itself: pair it with a
 * polite live region at coarse steps. The sweep stops under reduced motion.
 */
const meta = {
  title: 'Components/Feedback/ProgressBar',
  component: ProgressBar,
  tags: ['autodocs'],
  args: { label: 'Uploading the recording', value: 40, valueText: '40%' },
  argTypes: { value: { control: { type: 'range', min: 0, max: 100, step: 5 } } },
  decorators: [
    (Story) => (
      <div className="w-96 max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProgressBar>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A count of steps rather than a percentage: `max` sets the scale. */
export const Steps: Story = {
  args: { label: 'Saving audio', value: 3, max: 5, valueText: 'Saving audio: 3 of 5' },
}

/** Running, length unknown. No `aria-valuenow`. */
export const Indeterminate: Story = {
  args: { label: 'Processing the recording', value: undefined, valueText: 'Processing…' },
}

export const Complete: Story = {
  args: { value: 100, valueText: '100%' },
}

/** With a cancel action, the upload shape. */
export const WithCancel: Story = {
  name: 'With a cancel action',
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col gap-3">
      <ProgressBar label="Uploading the recording" value={62} valueText="62%" />
      <div>
        <Button variant="ghost" size="sm">
          Cancel upload
        </Button>
      </div>
    </div>
  ),
}
