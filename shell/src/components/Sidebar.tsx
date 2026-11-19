/**
 * Sidebar — the suite tool switcher (specs/20260709-suite-shell, T7, AC-3.1, AC-5.1).
 *
 * Fills the `sidebar` slot inside ShellLayout's (T5) own `<nav aria-label="Tool
 * navigation">` landmark — this component renders its list *inside* that existing
 * landmark as ordinary content. It deliberately does NOT render its own `<nav>`: per
 * ShellLayout's "Single-main-landmark note" (which applies symmetrically to every
 * landmark type, not just `<main>`), a second nav landmark here would double up the
 * one ShellLayout already provides around the `sidebar` slot.
 *
 * Lists the suite's tools as a flat list — no nested items. Entries come from the
 * `TOOLS` array in ../lib/tools, not individually hand-authored markup, so adding a
 * future tool is a one-line change, not a redesign.
 *
 * App-access filtering (specs/20260713-auth-roles-permissions, T24, AC-7.1/AC-7.2): the
 * rendered list is `TOOLS` filtered down to the ids present in the signed-in user's
 * `usePermissions().apps` (shell/session, T23) — a data-only change, no new markup or
 * interaction. `usePermissions()` resolves synchronously to `EMPTY_PERMISSIONS`
 * (`apps: []`) on first render, before the live `/authz/me` fetch settles, so the
 * filtered list is simply empty for that first tick — never the unfiltered `TOOLS`
 * list flashing before narrowing down. Every index-based computation below (active
 * match, roving tabindex, arrow-key wrap) operates on this filtered list, not the
 * raw `TOOLS` array.
 *
 * Active state (AC-3.1): each entry is a TanStack Router `<Link>`. By default (no
 * `activeOptions.exact`) a `Link` is "active" whenever the current pathname equals or
 * is a sub-path of its `to`, and it then applies `aria-current="page"` itself (see
 * `@tanstack/react-router`'s `link.js`, `STATIC_ACTIVE_PROPS`) — exactly the
 * "TanStack Router's active-link mechanism" design.md calls for, so a deep link like
 * `/estimai/estimates/42` still marks the EstimAI entry active. `useMatchRoute` reads
 * the same fuzzy-matched active state to drive the roving-tabindex default and the
 * active visual style below, without duplicating Link's matching logic.
 *
 * Keyboard operation (design.md Accessibility → "Sidebar keyboard operation"): roving
 * tabindex — only one entry is a tab stop at a time (`tabIndex 0`, the rest `-1`);
 * Arrow Up/Down moves focus (and the roving stop) between entries; Enter/Space
 * activates the focused link via native anchor behavior, no extra handling needed.
 * The roving stop starts on the active tool if one is active, else the first entry.
 *
 * Collapsible (desktop-only; no mobile drawer): a toggle in the always-visible
 * bottom section collapses the rail to icons only. The list scrolls
 * independently (its own scrollbar) between the tool list and that pinned
 * bottom section; the collapse state is the shared `useSidebarCollapsed` (the
 * same state ShellLayout reads to size the rail). Each entry keeps its label in
 * the DOM as `sr-only` when collapsed, so the accessible name (and the
 * roving-tabindex keyboard model) are unchanged — only the visible text hides,
 * with the label surfaced as a hover `title` instead.
 *
 * Settings group: rarely used tools (`SETTINGS_TOOL_IDS`, today Letterheads) leave the scrollable list for a
 * "Settings" disclosure pinned at the bottom, above the divider and Admin. Its button is a standalone tab stop
 * (`aria-expanded` / `aria-controls`); it opens by itself when one of its tools is the current route, and otherwise
 * remembers the last open/closed choice (localStorage, best effort). Collapsed to icons, the group shows its own icon
 * (the wrench), never its tools' icons: a click expands the rail with the group open.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Icon } from '@operai/ui'
import { SETTINGS_TOOL_IDS, TOOLS, type SuiteTool, type ToolId } from '../lib/tools'
import { useSidebarCollapsed } from '../hooks/sidebarCollapsed'
import { readSettingsOpen, writeSettingsOpen } from '../hooks/sidebarSettingsOpen'
import { usePermissions } from '../lib/session'
import { strings } from '../strings'

// TOOLS (id, label, mount path) now lives in ../lib/tools — the single source
// of truth also consumed by the root-landing redirect and the tool-route
// "last used" writer (T10), so the sidebar and the redirect logic can never
// drift on ids/paths. Add a tool there — no other change is needed for it to
// appear here.

const ACTIVE_PROPS = { className: 'bg-acc-lo text-acc hover:bg-acc-lo hover:text-acc' }

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc/50'

// Shared item styling — an icon-then-label row. Collapsed (icons only): the
// label span goes sr-only and the row centers its icon (`justify-center px-0`).
const itemClass = (collapsed: boolean): string =>
  `flex items-center rounded-md py-2 text-sm font-medium text-soft outline-none transition-colors hover:bg-ink-mid hover:text-text ${
    collapsed ? 'justify-center px-0' : 'gap-3 px-3'
  } ${FOCUS_RING}`

// One icon per tool id (aria-hidden — the label span carries the accessible
// name, even when collapsed to sr-only). Keyed by ToolId so adding a tool to
// ../lib/tools forces adding its icon here (a compile error otherwise). All
// from the library's icon set (INC-31).
const TOOL_ICON_SIZE = 20



const TOOL_ICONS: Record<ToolId, ReactNode> = {
  estimai: <Icon name="chart" size={TOOL_ICON_SIZE} className="shrink-0" />,
  refund: <Icon name="banknote" size={TOOL_ICON_SIZE} className="shrink-0" />,
  admin: <Icon name="settings" size={TOOL_ICON_SIZE} className="shrink-0" />,
  inventory: <Icon name="box" size={TOOL_ICON_SIZE} className="shrink-0" />,
  crm: <Icon name="users" size={TOOL_ICON_SIZE} className="shrink-0" />,
  meetings: <Icon name="mic" size={TOOL_ICON_SIZE} className="shrink-0" />,
  projects: <Icon name="calendar" size={TOOL_ICON_SIZE} className="shrink-0" />,
  letterheads: <Icon name="file" size={TOOL_ICON_SIZE} className="shrink-0" />,
  // specs/20261119-accounting (design UX-14, G1): the library has no ledger or book icon; a numbered list is what a chart of
  // accounts is. A "book" icon in @operai/ui is follow-up F-A4.
  accounting: <Icon name="list-ordered" size={TOOL_ICON_SIZE} className="shrink-0" />,
}

export default function Sidebar() {
  const matchRoute = useMatchRoute()
  const { collapsed, toggle } = useSidebarCollapsed()

  // App-access filter (T24, AC-7.1/AC-7.2): only render tools the signed-in
  // user has been granted. `apps` is `[]` both while `/authz/me` is still
  // loading (usePermissions's synchronous EMPTY_PERMISSIONS first value) and
  // when the user genuinely has zero access — either way the correct nav is
  // an empty list, never the full unfiltered TOOLS array.
  const { apps } = usePermissions()
  const visibleTools = TOOLS.filter((tool) => apps.includes(tool.id))
  // Admin is pinned to the bottom section (above the collapse toggle), kept out
  // of the scrollable workflow-tool list — it's an admin-only affordance, not a
  // day-to-day tool. The roving-tabindex arrow-key group covers only the main
  // tools; Admin is a standalone tab stop like the collapse toggle beneath it.
  const mainTools = visibleTools.filter((tool) => tool.id !== 'admin' && !SETTINGS_TOOL_IDS.includes(tool.id))
  const adminTool = visibleTools.find((tool) => tool.id === 'admin')
  const settingsTools = visibleTools.filter((tool) => SETTINGS_TOOL_IDS.includes(tool.id))
  const settingsActive = settingsTools.some((tool) => matchRoute({ to: tool.to, fuzzy: true }) !== false)
  const [settingsOpen, setSettingsOpen] = useState(() => settingsActive || readSettingsOpen())
  const settingsListId = useId()
  // Navigating into a settings tool (a deep link, the last-used redirect) opens the group so its entry is visible.
  // Adjusted while rendering when the route changes (React's "store the previous value" pattern), not in an effect.
  const [wasSettingsActive, setWasSettingsActive] = useState(settingsActive)
  if (settingsActive !== wasSettingsActive) {
    setWasSettingsActive(settingsActive)
    if (settingsActive) setSettingsOpen(true)
  }
  const toggleSettings = () => {
    setSettingsOpen((open) => {
      writeSettingsOpen(!open)
      return !open
    })
  }

  const activeIndex = mainTools.findIndex((tool) => matchRoute({ to: tool.to, fuzzy: true }) !== false)

  const [rovingIndex, setRovingIndex] = useState(() => (activeIndex >= 0 ? activeIndex : 0))
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([])

  // The permitted-tools list can change size after mount (permissions resolve
  // after the initial empty render, or a later revalidation narrows/widens
  // `apps`). Clamp so the roving tab stop always lands on a real entry —
  // without this, a list that shrank out from under a stale `rovingIndex`
  // would leave NO entry with `tabIndex 0`, breaking keyboard operation.
  const safeRovingIndex = mainTools.length === 0 ? -1 : Math.min(rovingIndex, mainTools.length - 1)

  const moveFocus = (nextIndex: number) => {
    if (mainTools.length === 0) {
      return
    }
    const clamped = (nextIndex + mainTools.length) % mainTools.length
    setRovingIndex(clamped)
    itemRefs.current[clamped]?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault()
        moveFocus(index + 1)
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault()
        moveFocus(index - 1)
        break
      case 'Home':
        event.preventDefault()
        moveFocus(0)
        break
      case 'End':
        event.preventDefault()
        moveFocus(mainTools.length - 1)
        break
      default:
        break
    }
  }

  const pinnedLink = (tool: SuiteTool, nested: boolean) => (
    <Link
      to={tool.to}
      title={collapsed ? tool.label : undefined}
      className={`${itemClass(collapsed)}${nested && !collapsed ? ' pl-6' : ''}`}
      activeProps={ACTIVE_PROPS}
    >
      {TOOL_ICONS[tool.id]}
      <span className={collapsed ? 'sr-only' : ''}>{tool.label}</span>
    </Link>
  )

  return (
    // Fills the full height of ShellLayout's rail: the workflow-tool list
    // scrolls (own scrollbar); the pinned, always-visible bottom section
    // (`shrink-0`) holds the Admin entry (admin-only) above the collapse toggle.
    <div className="flex h-full flex-col">
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
        {mainTools.map((tool, index) => (
          <li key={tool.id}>
            <Link
              to={tool.to}
              ref={(node) => {
                itemRefs.current[index] = node
              }}
              tabIndex={index === safeRovingIndex ? 0 : -1}
              onFocus={() => setRovingIndex(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              // Hover tooltip surfaces the label the collapsed rail hides.
              title={collapsed ? tool.label : undefined}
              className={itemClass(collapsed)}
              activeProps={ACTIVE_PROPS}
            >
              {TOOL_ICONS[tool.id]}
              <span className={collapsed ? 'sr-only' : ''}>{tool.label}</span>
            </Link>
          </li>
        ))}
      </ul>

      {settingsTools.length > 0 && (
        <div className="flex shrink-0 flex-col gap-1 px-2 pb-2">
          {collapsed ? (
            // Icons only: the group's own icon. It expands the rail with the group open, so its tools are one click away
            // and read with their names; highlighted while one of them is the current route.
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(true)
                writeSettingsOpen(true)
                toggle()
              }}
              title={strings.sidebar.settings}
              className={`w-full ${itemClass(true)}${settingsActive ? ' bg-acc-lo text-acc hover:bg-acc-lo hover:text-acc' : ''}`}
            >
              <Icon name="wrench" size={TOOL_ICON_SIZE} className="shrink-0" />
              <span className="sr-only">{strings.sidebar.settings}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={toggleSettings}
                aria-expanded={settingsOpen}
                aria-controls={settingsListId}
                className={`w-full ${itemClass(false)}`}
              >
                <Icon name="wrench" size={TOOL_ICON_SIZE} className="shrink-0" />
                <span className="flex-1 text-left">{strings.sidebar.settings}</span>
                <Icon name={settingsOpen ? 'chevron-down' : 'chevron-right'} size={16} className="shrink-0" />
              </button>
              <ul id={settingsListId} hidden={!settingsOpen} className="flex flex-col gap-1">
                {settingsTools.map((tool) => (
                  <li key={tool.id}>{pinnedLink(tool, true)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-1 border-t border-rule px-2 py-2">
        {adminTool && pinnedLink(adminTool, false)}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? strings.sidebar.expand : strings.sidebar.collapse}
          aria-expanded={!collapsed}
          title={collapsed ? strings.sidebar.expand : strings.sidebar.collapse}
          className={`w-full ${itemClass(collapsed)}`}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={TOOL_ICON_SIZE} className="shrink-0" />
          <span className={collapsed ? 'sr-only' : ''}>{strings.sidebar.collapseShort}</span>
        </button>
      </div>
    </div>
  )
}
