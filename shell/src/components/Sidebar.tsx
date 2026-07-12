/**
 * Sidebar — the suite tool switcher (specs/003-suite-shell, T7, AC-3.1, AC-5.1).
 *
 * Fills the `sidebar` slot inside ShellLayout's (T5) own `<nav aria-label="Tool
 * navigation">` landmark — this component renders its list *inside* that existing
 * landmark as ordinary content. It deliberately does NOT render its own `<nav>`: per
 * ShellLayout's "Single-main-landmark note" (which applies symmetrically to every
 * landmark type, not just `<main>`), a second nav landmark here would double up the
 * one ShellLayout already provides around the `sidebar` slot.
 *
 * Lists the suite's tools as a flat two-item list (EstimAI, Refund (Rimborsi)) — no
 * nested items, no role-based filtering (explicit spec non-goal). Entries come from
 * the `TOOLS` array below, not individually hand-authored markup, so adding a future
 * tool is a one-line change, not a redesign.
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
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { TOOLS, type ToolId } from '../lib/tools'
import { useSidebarCollapsed } from '../hooks/sidebarCollapsed'

// TOOLS (id, label, mount path) now lives in ../lib/tools — the single source
// of truth also consumed by the root-landing redirect and the tool-route
// "last used" writer (T10), so the sidebar and the redirect logic can never
// drift on ids/paths. Add a tool there — no other change is needed for it to
// appear here.

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc/50'

// Shared item styling — an icon-then-label row. Collapsed (icons only): the
// label span goes sr-only and the row centers its icon (`justify-center px-0`).
const itemClass = (collapsed: boolean): string =>
  `flex items-center rounded-md py-2 text-sm font-medium text-soft outline-none transition-colors hover:bg-ink-mid hover:text-text ${
    collapsed ? 'justify-center px-0' : 'gap-3 px-3'
  } ${FOCUS_RING}`

const ICON_PROPS = {
  className: 'h-5 w-5 shrink-0',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

// One icon per tool id (aria-hidden — the label span carries the accessible
// name, even when collapsed to sr-only). Keyed by ToolId so adding a tool to
// ../lib/tools forces adding its icon here (a compile error otherwise).
const TOOL_ICONS: Record<ToolId, ReactNode> = {
  estimai: (
    // bar chart — estimation / metrics
    <svg {...ICON_PROPS}>
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="1" />
      <rect x="12" y="8" width="3" height="10" rx="1" />
      <rect x="17" y="5" width="3" height="13" rx="1" />
    </svg>
  ),
  refund: (
    // receipt — expense reimbursement
    <svg {...ICON_PROPS}>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 17.5v-11" />
    </svg>
  ),
}

// chevrons-left (can collapse) / chevrons-right (can expand) for the toggle.
function ChevronsIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg {...ICON_PROPS}>
      {direction === 'left' ? (
        <>
          <path d="m11 17-5-5 5-5" />
          <path d="m18 17-5-5 5-5" />
        </>
      ) : (
        <>
          <path d="m6 17 5-5-5-5" />
          <path d="m13 17 5-5-5-5" />
        </>
      )}
    </svg>
  )
}

export default function Sidebar() {
  const matchRoute = useMatchRoute()
  const { collapsed, toggle } = useSidebarCollapsed()
  const activeIndex = TOOLS.findIndex(tool => matchRoute({ to: tool.to, fuzzy: true }) !== false)

  const [rovingIndex, setRovingIndex] = useState(() => (activeIndex >= 0 ? activeIndex : 0))
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([])

  const moveFocus = (nextIndex: number) => {
    const clamped = (nextIndex + TOOLS.length) % TOOLS.length
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
        moveFocus(TOOLS.length - 1)
        break
      default:
        break
    }
  }

  return (
    // Fills the full height of ShellLayout's rail: the tool list scrolls
    // (own scrollbar), the collapse toggle sits in a pinned, always-visible
    // bottom section (`shrink-0`).
    <div className="flex h-full flex-col">
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
        {TOOLS.map((tool, index) => (
          <li key={tool.id}>
            <Link
              to={tool.to}
              ref={node => {
                itemRefs.current[index] = node
              }}
              tabIndex={index === rovingIndex ? 0 : -1}
              onFocus={() => setRovingIndex(index)}
              onKeyDown={event => handleKeyDown(event, index)}
              // Hover tooltip surfaces the label the collapsed rail hides.
              title={collapsed ? tool.label : undefined}
              className={itemClass(collapsed)}
              activeProps={{ className: 'bg-acc-lo text-acc hover:bg-acc-lo hover:text-acc' }}
            >
              {TOOL_ICONS[tool.id]}
              <span className={collapsed ? 'sr-only' : ''}>{tool.label}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="shrink-0 border-t border-rule px-2 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`w-full ${itemClass(collapsed)}`}
        >
          <ChevronsIcon direction={collapsed ? 'right' : 'left'} />
          <span className={collapsed ? 'sr-only' : ''}>Collapse</span>
        </button>
      </div>
    </div>
  )
}
