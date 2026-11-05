import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { FilePicker } from './FilePicker'
import type { FilePickerProps } from './FilePicker'

/**
 * Choose one file. A hidden `<input type="file">` behind a `Button`, so it is
 * reachable and operable by keyboard; the chosen name and size are shown (and
 * announced politely) with a clear button. It only picks: the app checks the
 * type, size and length, uploads, shows progress (`ProgressBar`) and passes a
 * failed check back as `error`. All copy is a prop.
 *
 * Naming: the field label names the row as a `group`, and clicking it opens the
 * dialog; the button's accessible name is its own visible text ("Choose file"),
 * so a voice-control user can say what they see (WCAG 2.5.3).
 */
const meta = {
  title: 'Components/Forms/FilePicker',
  component: FilePicker,
  tags: ['autodocs'],
  args: {
    label: 'Recording',
    chooseLabel: 'Choose file',
    clearLabel: 'Remove file',
    emptyText: 'No file chosen',
    hint: 'm4a, mp3, wav or webm, up to 500 MiB',
    accept: 'audio/*,.m4a,.mp3,.wav,.webm',
    file: null,
    onChange: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-[28rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FilePicker>
export default meta

type Story = StoryObj<typeof meta>

/** Stateful wrapper: the picker is controlled. */
function Controlled(props: Omit<FilePickerProps, 'file' | 'onChange'> & { initial?: File | null }) {
  const { initial = null, ...rest } = props
  const [file, setFile] = useState<File | null>(initial)
  return <FilePicker {...rest} file={file} onChange={setFile} />
}

const sample = () => {
  const file = new File(['x'], 'weekly-standup-2026-11-05.m4a', { type: 'audio/mp4' })
  Object.defineProperty(file, 'size', { value: 48_300_000 })
  return file
}

export const Playground: Story = {
  render: (args) => <Controlled {...args} />,
}

export const WithSelection: Story = {
  name: 'With a selection',
  render: (args) => <Controlled {...args} initial={sample()} />,
}

export const WithError: Story = {
  name: 'With an error',
  render: (args) => <Controlled {...args} initial={sample()} error="This file type is not supported" required />,
}

export const Disabled: Story = {
  render: (args) => <Controlled {...args} initial={sample()} disabled />,
}
