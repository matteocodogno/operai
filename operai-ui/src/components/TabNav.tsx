import { Children } from 'react'
import type { ReactNode } from 'react'

export type TabNavProps = {
  /** The nav landmark's accessible name ("Refund sections"). */
  label: string
  /**
   * One link per tab, each with `className="tab-link"` — a router <Link>
   * (active = its `aria-current="page"`) or an <a aria-current="page">. A tab
   * the user may not open is left out, never disabled.
   */
  children: ReactNode
  /** Tabs pinned to the far end of the row (a section that is not part of the main set, like Audit). */
  end?: ReactNode
  /**
   * Let the tab row reflow onto further rows and break a long label, so it never needs a sideways scroll
   * (WCAG 1.4.10 reflow at 320 px). Opt-in; unset, the list renders exactly as before.
   */
  wrap?: boolean
}

/** TabNav — a tool's section tabs, under the tool title. Router-agnostic. */
export function TabNav({ label, children, end, wrap }: TabNavProps) {
  return (
    <nav aria-label={label}>
      <ul className={wrap ? 'tab-list tab-list-wrap' : 'tab-list'}>
        {Children.toArray(children).map((child, index) => (
          <li key={index}>{child}</li>
        ))}
        {Children.toArray(end).map((child, index) => (
          <li key={`end-${index}`} className={index === 0 ? 'tab-list-end' : undefined}>
            {child}
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** The class a tab link carries. */
export const tabLinkClassName = 'tab-link'
