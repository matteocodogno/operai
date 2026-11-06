import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button'
import { ICON_NAMES, Icon } from './Icon'

/**
 * One shape from the suite's icon set, drawn in the current text colour at
 * 1em by default. Decorative (`aria-hidden`) unless it gets a `label`. The
 * full set is in Foundations/Icons.
 */
const meta = {
  title: 'Components/Content/Icon',
  component: Icon,
  tags: ['autodocs'],
  args: { name: 'calendar', size: 24 },
  argTypes: {
    name: { control: 'select', options: ICON_NAMES },
    size: { control: { type: 'number', min: 12, max: 64, step: 4 } },
    label: { control: 'text' },
  },
} satisfies Meta<typeof Icon>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Next to text that says the same thing: decorative, no label. */
export const Decorative: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <p className="flex items-center gap-2 text-sm">
      <Icon name="calendar" /> Available from 15.11.2026
    </p>
  ),
}

/** Meaningful on its own: `label` makes it `role="img"` with that name. */
export const Labelled: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <p className="flex items-center gap-2 text-sm">
      Price list <Icon name="lock" label="Locked" />
    </p>
  ),
}

/** The recording controls: each icon-only button carries its own name. */
export const RecordingControls: Story = {
  name: 'Recording controls',
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex gap-2">
      <Button iconOnly aria-label="Start recording">
        <Icon name="mic" />
      </Button>
      <Button iconOnly aria-label="Pause">
        <Icon name="pause" />
      </Button>
      <Button iconOnly aria-label="Resume">
        <Icon name="play" />
      </Button>
      <Button iconOnly aria-label="Stop and save">
        <Icon name="stop" />
      </Button>
    </div>
  ),
}

/** Inside an icon-only button the button has the name; the icon stays decorative. */
export const InAButton: Story = {
  name: 'In a button',
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex gap-2">
      <Button iconOnly aria-label="Download price list">
        <Icon name="download" />
      </Button>
      <Button iconOnly variant="ghost" aria-label="Open in a new tab">
        <Icon name="external" />
      </Button>
    </div>
  ),
}
