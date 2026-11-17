import { useId, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Badge } from './Badge'
import { Card } from './Card'
import { FactList } from './FactList'
import { Tabs, tabPanelProps } from './Tabs'

/**
 * Switches between views of the SAME page without navigating. A real
 * tablist: one tab stop, ←/→ move and select, Home/End jump to the ends,
 * `aria-selected` marks the current tab. Give each panel
 * `tabPanelProps(idPrefix, id)` so tab and panel point at each other. Same
 * look as `TabNav`, which is for sections with their own URL.
 */
const meta = {
  title: 'Components/Layout/Tabs',
  component: Tabs,
  tags: ['autodocs'],
  args: {
    label: 'Item views',
    idPrefix: 'tabs',
    value: 'overview',
    onChange: fn(),
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'history', label: 'History' },
    ],
  },
  argTypes: { tabs: { control: false }, value: { control: false } },
} satisfies Meta<typeof Tabs>
export default meta

type Story = StoryObj<typeof meta>

type View = 'overview' | 'history' | 'files'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'history', label: 'History' },
  { id: 'files', label: 'Files' },
] as const

function Demo({ label }: { label: string }) {
  const idPrefix = useId()
  const [view, setView] = useState<View>('overview')
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Tabs label={label} tabs={TABS} value={view} onChange={setView} idPrefix={idPrefix} />
      <div {...tabPanelProps(idPrefix, view)}>
        {view === 'overview' && (
          <Card title="Details">
            <FactList
              items={[
                { id: 'category', term: 'Category', value: 'Lighting' },
                { id: 'owner', term: 'Owner', value: 'Giulia Bianchi' },
              ]}
            />
          </Card>
        )}
        {view === 'history' && (
          <Card title="History">
            <p className="text-sm text-soft">Four changes since 30.09.2026.</p>
          </Card>
        )}
        {view === 'files' && (
          <Card title="Files">
            <p className="text-sm text-soft">No files attached.</p>
          </Card>
        )}
      </div>
      <p className="text-xs text-soft">
        Keyboard: Tab reaches the selected tab only; ←/→ move between tabs, Home/End jump; Tab again enters the panel.
      </p>
    </div>
  )
}

export const InPageViews: Story = {
  name: 'In-page views',
  render: (args) => <Demo label={args.label} />,
}

const ENTITY_TABS = [
  {
    id: 'welld_it',
    label: (
      <>
        Welld Italia S.r.l. <Badge tone="warning" glyph="!">Needs correction</Badge>
      </>
    ),
  },
  {
    id: 'welld_ch',
    label: (
      <>
        Welld Switzerland GmbH <Badge tone="muted" glyph="–">Not moved yet</Badge>
      </>
    ),
  },
] as const

type Entity = (typeof ENTITY_TABS)[number]['id']

function WrapDemo({ label }: { label: string }) {
  const idPrefix = useId()
  const [entity, setEntity] = useState<Entity>('welld_it')
  return (
    // A 320 px frame: the strip wraps onto a second row and the page never scrolls sideways.
    <div className="w-[320px] max-w-full">
      <Tabs label={label} tabs={ENTITY_TABS} value={entity} onChange={setEntity} idPrefix={idPrefix} wrap />
      <div {...tabPanelProps(idPrefix, entity)}>
        <p className="mt-3 text-sm text-soft">Panel for {entity}.</p>
      </div>
    </div>
  )
}

/**
 * `wrap`: long labels carrying badges reflow onto further rows (and break inside a label) instead of needing a
 * sideways scroll: WCAG 1.4.10 reflow at 320 px. Opt-in; without it the list renders exactly as before.
 */
export const WrapsAt320px: Story = {
  name: 'Wraps at 320 px (long labels with badges)',
  render: (args) => <WrapDemo label={args.label} />,
}
