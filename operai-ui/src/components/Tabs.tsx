import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

export type TabItem<Id extends string> = {
  id: Id
  label: ReactNode
}

export type TabsProps<Id extends string> = {
  /** The tab list's accessible name ("Estimate views"). */
  label: string
  tabs: readonly TabItem<Id>[]
  value: Id
  onChange: (id: Id) => void
  /** Prefix for the tab and panel ids; pair each panel with `tabPanelProps(idPrefix, id)`. */
  idPrefix: string
  testId?: string
  /**
   * Let the tab list reflow onto further rows and break a long label, so it never needs a sideways scroll
   * (WCAG 1.4.10 reflow at 320 px). Opt-in; unset, the list renders exactly as before.
   */
  wrap?: boolean
}

/**
 * Tabs — switches between views of the SAME page without navigating (INC-30,
 * INC-32): EstimAI's Activities / Summary / Parameters. A real tablist: one tab
 * stop, arrow keys, Home and End move between tabs, `aria-selected` marks the
 * current one. Sections of a tool that are separate pages with their own URL
 * use `TabNav` (links) instead. Same look as `TabNav`. `wrap` lets the list reflow at narrow widths.
 */
export function Tabs<Id extends string>({ label, tabs, value, onChange, idPrefix, testId, wrap }: TabsProps<Id>) {
  const listRef = useRef<HTMLDivElement>(null)

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === value)
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    onChange(tabs[next].id)
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} className={wrap ? 'tab-list tab-list-wrap' : 'tab-list'} onKeyDown={move} data-testid={testId}>
      {tabs.map((tab) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className="tab-link"
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

/** Props for the panel a tab shows: spread them on the panel's container. */
export const tabPanelProps = (idPrefix: string, id: string) => ({
  role: 'tabpanel' as const,
  id: `${idPrefix}-panel-${id}`,
  'aria-labelledby': `${idPrefix}-tab-${id}`,
  tabIndex: 0,
})
