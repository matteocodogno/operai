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
 * Desktop-only (no collapsed/drawer/mobile variant) per the spec's explicit non-goal.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { Link, useMatchRoute } from '@tanstack/react-router'

interface SidebarTool {
  id: string
  label: string
  to: string
}

// Flat, ordered list of suite tools (AC-3.1, AC-5.1). Add a tool here — no other
// change is needed for it to appear in the sidebar.
const TOOLS: readonly SidebarTool[] = [
  { id: 'estimai', label: 'EstimAI', to: '/estimai' },
  { id: 'refund', label: 'Refund (Rimborsi)', to: '/refund' },
]

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc/50'

export default function Sidebar() {
  const matchRoute = useMatchRoute()
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
    <ul className="flex flex-col gap-1 px-2 py-3">
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
            className={`block rounded-md px-3 py-2 text-sm font-medium text-soft outline-none transition-colors hover:bg-ink-mid hover:text-text ${FOCUS_RING}`}
            activeProps={{ className: 'bg-acc-lo text-acc hover:bg-acc-lo hover:text-acc' }}
          >
            {tool.label}
          </Link>
        </li>
      ))}
    </ul>
  )
}
