import { Tabs } from '@operai/ui'
import type { TabItem } from '@operai/ui'
import { strings } from '../strings'
import type { MyHoursView } from './HoursFiltersState'

export type ViewSwitchProps = {
  /** The view shown. */
  value: MyHoursView
  /** Prefix of the tab and panel ids; the page draws the panel with `tabPanelProps(idPrefix, value)`. */
  idPrefix: string
  onChange: (view: MyHoursView) => void
}

/**
 * ViewSwitch — Table | List, under My hours' header (specs/20261116-record-hours-in-place T10, T19; design S6; AC-5.1).
 * Table is first because it is the view My hours opens on.
 *
 * Two views of the SAME page, not two pages: the library's `Tabs` (a tablist, one tab stop, the arrow keys), not
 * `TabNav`, which is for sections with an address of their own (plan Decision 5 rejected a route). It keeps no state:
 * the page keeps the view in the address and the panel below it.
 */
export default function ViewSwitch({ value, idPrefix, onChange }: ViewSwitchProps) {
  const t = strings.table.view
  const tabs: readonly TabItem<MyHoursView>[] = [
    { id: 'table', label: t.table },
    { id: 'list', label: t.list },
  ]
  return (
    <Tabs
      label={t.label}
      tabs={tabs}
      value={value}
      onChange={onChange}
      idPrefix={idPrefix}
      testId="hours-view-switch"
    />
  )
}
