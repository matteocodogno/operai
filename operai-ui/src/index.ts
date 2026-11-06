/**
 * @operai/ui — the Operai design system (ADR-0050).
 *
 * Consumed as SOURCE: an app aliases `@operai/ui` to this file (vite.config.ts,
 * vitest.config.ts, tsconfig paths) and its own bundler compiles it. The CSS
 * comes separately, from `styles/tokens.css` (through `shell/tokens.css` for a
 * remote). Components carry no copy: every user-visible string is a prop.
 *
 * Usage rules: operai-ui/docs/design-system.md; how to build a page:
 * operai-ui/docs/building-pages.md.
 */

export { Badge } from './components/Badge'
export type { BadgeProps, BadgeTone } from './components/Badge'
export { Banner, CONFIRMATION_DISMISS_MS } from './components/Banner'
export type { BannerProps, BannerTone } from './components/Banner'
export { Button, buttonClassName } from './components/Button'
export type { ButtonClassOptions, ButtonProps, ButtonSize, ButtonVariant } from './components/Button'
export { Card } from './components/Card'
export type { CardProps } from './components/Card'
export { Combobox } from './components/Combobox'
export type { ComboboxOption, ComboboxProps } from './components/Combobox'
export { ConfirmDialog } from './components/ConfirmDialog'
export type { ConfirmDialogProps } from './components/ConfirmDialog'
export { DataTable } from './components/DataTable'
export type { DataTableColumn, DataTableProps, DataTableSort, SortDirection } from './components/DataTable'
export { Dialog } from './components/Dialog'
export type { DialogProps, DialogSize } from './components/Dialog'
export { Drawer } from './components/Drawer'
export type { DrawerProps } from './components/Drawer'
export { FactList } from './components/FactList'
export type { Fact, FactListProps } from './components/FactList'
export { CheckboxGroupField, Field, RadioGroupField, focusFirstInvalid } from './components/Field'
export type {
  CheckboxGroupFieldProps,
  CheckboxOption,
  FieldControlProps,
  FieldProps,
  RadioGroupFieldProps,
} from './components/Field'
export { FilePicker } from './components/FilePicker'
export type { FilePickerProps } from './components/FilePicker'
export { FormDialog } from './components/FormDialog'
export type { FormDialogProps } from './components/FormDialog'
export { LoadMore } from './components/LoadMore'
export type { LoadMoreProps } from './components/LoadMore'
export { DateInput, DateTimeInput, MoneyInput, parseDecimal } from './components/MoneyInput'
export type { DateInputProps, DateTimeInputProps, MoneyInputProps } from './components/MoneyInput'
export { ListRows, listRowClassName, listRowMetaClassName } from './components/ListRows'
export type { ListRowsProps } from './components/ListRows'
export { Menu, MenuItem } from './components/Menu'
export type { MenuItemProps, MenuProps } from './components/Menu'
export { NoticeDialog } from './components/NoticeDialog'
export type { NoticeDialogProps } from './components/NoticeDialog'
export { Pagination } from './components/Pagination'
export type { PaginationProps, PaginationStatus } from './components/Pagination'
export { PageHeader } from './components/PageHeader'
export type { PageHeaderProps } from './components/PageHeader'
export { ProgressBar } from './components/ProgressBar'
export type { ProgressBarProps } from './components/ProgressBar'
export { PersonPicker } from './components/PersonPicker'
export type { Person, PersonChoice, PersonLoadFailure, PersonPickerProps } from './components/PersonPicker'
export { SectionsEditor } from './components/SectionsEditor'
export type { Section, SectionRowErrors, SectionsEditorProps } from './components/SectionsEditor'
export { Skeleton, SkeletonRows } from './components/Skeleton'
export type { SkeletonProps, SkeletonRowsProps } from './components/Skeleton'
export { Spinner } from './components/Spinner'
export type { SpinnerProps } from './components/Spinner'
export { StatePanel } from './components/StatePanel'
export type { StatePanelProps } from './components/StatePanel'
export { TabNav, tabLinkClassName } from './components/TabNav'
export type { TabNavProps } from './components/TabNav'
export { ToolLayout } from './components/ToolLayout'
export type { ToolLayoutProps } from './components/ToolLayout'
export { useDialogBehavior } from './components/useDialogBehavior'
export type { DialogBehaviorOptions } from './components/useDialogBehavior'
export { VisuallyHidden } from './components/VisuallyHidden'
export type { VisuallyHiddenProps } from './components/VisuallyHidden'
export { cx } from './lib/cx'
export { COLOR_TOKENS, FONT_TOKENS } from './foundations/tokens'
export type { ColorToken, FontToken } from './foundations/tokens'
export { Icon, ICON_NAMES } from './components/Icon'
export type { IconName, IconProps } from './components/Icon'
export { Tooltip } from './components/Tooltip'
export type { TooltipProps } from './components/Tooltip'
export { STATUS, StatusBadge } from './components/StatusBadge'
export type { StatusBadgeProps, StatusMeaning } from './components/StatusBadge'
export { Tabs, tabPanelProps } from './components/Tabs'
export type { TabItem, TabsProps } from './components/Tabs'
export { LOCALES, catalogGaps, resolveLocale, selectStrings } from './lib/i18n'
export type { Locale } from './lib/i18n'
export {
  formatAmount,
  formatDate,
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatNumber,
  formatRelative,
} from './lib/format'
export type { DurationStyle } from './lib/format'
export { useFocusOnMount } from './lib/useFocusOnMount'
