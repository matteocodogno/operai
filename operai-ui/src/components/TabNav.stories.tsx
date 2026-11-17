import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge } from './Badge'
import { TabNav, tabLinkClassName } from './TabNav'

/**
 * A tool's section tabs, under the tool title: a `<nav>` of LINKS, each a
 * separate page with its own URL. The active one is the link with
 * `aria-current="page"` (a router `<Link>` sets it). A tab the person may not
 * open is left out, never disabled. Router-agnostic. For views of the SAME
 * page that do not navigate, use `Tabs`.
 */
const meta = {
  title: 'Components/Layout/TabNav',
  component: TabNav,
  tags: ['autodocs'],
  args: { label: 'Catalogue sections', children: null },
  argTypes: { children: { control: false }, end: { control: false } },
} satisfies Meta<typeof TabNav>
export default meta

type Story = StoryObj<typeof meta>

function Demo({ label, withEnd }: { label: string; withEnd: boolean }) {
  const [active, setActive] = useState('items')
  const tab = (id: string, text: string) => (
    <a
      href={`#${id}`}
      className={tabLinkClassName}
      aria-current={active === id ? 'page' : undefined}
      onClick={(event) => {
        event.preventDefault()
        setActive(id)
      }}
    >
      {text}
    </a>
  )
  return (
    <div className="flex flex-col gap-4">
      <div className="border-b border-rule bg-ink-soft px-4">
        <TabNav label={label} end={withEnd ? tab('settings', 'Settings') : undefined}>
          {tab('items', 'Items')}
          {tab('collections', 'Collections')}
          {tab('suppliers', 'Suppliers')}
        </TabNav>
      </div>
      <p className="text-sm text-soft">
        Current section: <strong className="text-text">{active}</strong>
      </p>
    </div>
  )
}

export const Default: Story = {
  render: (args) => <Demo label={args.label} withEnd={false} />,
}

/** `end` pins tabs to the far end of the row: a section outside the main set. */
export const WithEndSlot: Story = {
  name: 'With an end tab',
  render: (args) => <Demo label={args.label} withEnd />,
}

/**
 * `wrap`: the section row reflows onto further rows and breaks a long label instead of needing a sideways scroll
 * (WCAG 1.4.10 reflow at 320 px). Opt-in; without it the list renders exactly as before.
 */
export const WrapsAt320px: Story = {
  name: 'Wraps at 320 px (long labels with badges)',
  render: (args) => (
    <div className="w-[320px] max-w-full border-b border-rule bg-ink-soft px-4">
      <TabNav label={args.label} wrap end={<a href="#audit" className={tabLinkClassName}>Audit</a>}>
        <a href="#roles" className={tabLinkClassName} aria-current="page">
          Roles
        </a>
        <a href="#departments" className={tabLinkClassName}>
          Departments
        </a>
        <a href="#legal" className={tabLinkClassName}>
          Legal entities <Badge tone="warning" glyph="!">Needs correction</Badge>
        </a>
      </TabNav>
    </div>
  ),
}
