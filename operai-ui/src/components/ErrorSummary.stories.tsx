import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { ErrorSummary } from './ErrorSummary'

/**
 * What a refused save refused: an assertive `danger` Banner (`role="alert"`) with the title, an optional hint and
 * one button per problem that moves focus to its control. Show it above the form after a 422, and move focus to
 * the first refused control yourself — the summary is the second way in. Each control also carries `aria-invalid`
 * and its own error text, and says the same sentence. All copy is the app's.
 */
const meta = {
  title: 'Components/Feedback/ErrorSummary',
  component: ErrorSummary,
  tags: ['autodocs'],
  args: {
    title: 'Nothing was saved. 3 values need your attention.',
    hint: 'Choose a value to go to it.',
    items: [
      { id: 'legal-name', text: 'Legal name: enter the legal name.' },
      { id: 'address-it-2', text: 'Address, line 2: use one line, remove the line break.' },
      { id: 'iban', text: 'IBAN: the check digits do not match. Check it for a typing mistake.' },
    ],
    onGo: fn(),
  },
  argTypes: { items: { control: 'object' }, onGo: { control: false } },
} satisfies Meta<typeof ErrorSummary>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** One problem, no hint: the title and the single button are enough. */
export const SingleProblem: Story = {
  args: {
    title: 'Nothing was saved. 1 value needs your attention.',
    hint: undefined,
    items: [{ id: 'iban', text: 'IBAN: the check digits do not match.' }],
  },
}
