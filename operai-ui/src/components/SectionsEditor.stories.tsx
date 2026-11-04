import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SectionsEditor } from './SectionsEditor'
import type { Section, SectionsEditorProps } from './SectionsEditor'

/**
 * An ordered list of headed text rows: heading, text, move up/down, remove and
 * add. Controlled and generic over the row type, so a row can carry fields the
 * editor does not know. The app owns copy and validation (`rowErrors`,
 * `listError`) and can put its own control in each row with `renderRowExtra`.
 * Focus follows the work: after a move, a removal or an add it lands on the
 * row the person was working on.
 */
const meta = {
  title: 'Components/Forms/SectionsEditor',
  component: SectionsEditor,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[36rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SectionsEditor>
export default meta

type Story = StoryObj<typeof meta>

const copy: SectionsEditorProps['copy'] = {
  legend: 'Sections',
  hint: 'Between 1 and 5 sections, in the order they appear.',
  item: (n) => `Section ${n}`,
  headingLabel: (n) => `Heading (${n})`,
  bodyLabel: (n) => `Text (${n})`,
  moveUp: (n) => `Move section ${n} up`,
  moveDown: (n) => `Move section ${n} down`,
  remove: (n) => `Remove section ${n}`,
  add: 'Add section',
}

const initial: Section[] = [
  { heading: 'Scope', body: 'What is in and out of the engagement.' },
  { heading: 'Deliverables', body: 'The list of things handed over.' },
  { heading: 'Terms', body: '' },
]

const args = {
  sections: initial,
  onChange: () => {},
  createSection: () => ({ heading: '', body: '' }),
  copy,
  testIdPrefix: 'story',
} satisfies SectionsEditorProps

function Controlled(props: Partial<SectionsEditorProps>) {
  const [sections, setSections] = useState<Section[]>(initial)
  return <SectionsEditor {...args} min={1} max={5} {...props} sections={sections} onChange={setSections} />
}

export const Playground: Story = {
  args,
  render: () => <Controlled />,
}

export const WithErrors: Story = {
  name: 'With errors',
  args,
  render: () => (
    <Controlled
      rowErrors={[null, { heading: 'A heading is required' }, { body: 'The text is too long (4,000 at most)' }]}
      listError="Add between 1 and 5 sections."
    />
  ),
}

/** `renderRowExtra`: here a radio that marks exactly one row, kept by the app, not the editor. */
export const WithRowExtra: Story = {
  name: 'With a row extra',
  args,
  render: function Render() {
    type Marked = Section & { marked: boolean }
    const [sections, setSections] = useState<Marked[]>(initial.map((s, i) => ({ ...s, marked: i === 1 })))
    return (
      <SectionsEditor<Marked>
        sections={sections}
        onChange={setSections}
        createSection={() => ({ heading: '', body: '', marked: false })}
        copy={copy}
        min={1}
        max={5}
        testIdPrefix="story-marked"
        renderRowExtra={(section, index) => (
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name="story-marked"
              checked={section.marked}
              onChange={() => setSections(sections.map((s, at) => ({ ...s, marked: at === index })))}
            />
            Carries the cost table
          </label>
        )}
      />
    )
  },
}

export const Disabled: Story = {
  args,
  render: () => <Controlled disabled />,
}
