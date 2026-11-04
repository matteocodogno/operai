/**
 * Host extensions (specs/021-meetings, T51, AC-11.6, ADR-0060) — exposed as
 * `shell/extensions`.
 *
 * A host app (today: crm-ui's deal page) embeds a panel owned by another remote
 * (Meetings' `./HostMeetings`) with `<HostExtension name="meetings.hostMeetings"
 * props={…} fallback={…} />`. The shell owns the seam so the host never declares
 * the other remote as its own Module Federation remote (composition belongs to
 * the shell, ADR-0006).
 *
 * The one rule (ADR-0030, restated by ADR-0060): the other side's code failure
 * must never become the host page's failure. A rejected import (remote down,
 * version skew), a 5 s timeout, a module without the export, and a render-time
 * throw (error boundary) ALL render the host's own `fallback`; nothing is ever
 * rethrown. Each host keeps its own fallback copy — this module has no strings.
 *
 * The prop contract is declared ONCE here (`ExtensionProps`): three plain
 * strings and nothing else crosses the boundary. crm-ui keeps a hand-written
 * ambient copy (`crm-ui/src/federation/remotes.d.ts`) — keep them in sync, and
 * crm-ui imports this module dynamically so a shell that predates the expose
 * degrades to the host's fallback.
 */
import { Component, useEffect, useState } from 'react'
import type { ComponentType, JSX, ReactNode } from 'react'

/** How long the federated panel is given to load before the fallback takes over. */
export const EXTENSION_TIMEOUT_MS = 5000

/** The extensions this shell can load, with the props each one takes. */
export interface ExtensionProps {
  'meetings.hostMeetings': { hostApp: string; entityType: string; entityId: string }
}

type ExtensionName = keyof ExtensionProps

type ExtensionLoader<K extends ExtensionName> = () => Promise<{ default?: ComponentType<ExtensionProps[K]> }>

/** One loader per extension; a name missing here is a host newer than this shell → fallback. */
const LOADERS: { [K in ExtensionName]: ExtensionLoader<K> } = {
  'meetings.hostMeetings': () => import('meetings/HostMeetings'),
}

export interface HostExtensionProps<K extends ExtensionName> {
  name: K
  props: ExtensionProps[K]
  /** The host's own "unavailable" rendering — shown for every failure. */
  fallback: ReactNode
  /** Shown while the remote loads; nothing when omitted. */
  loading?: ReactNode
}

/** A usable component: a function, or an object (memo / forwardRef / lazy). */
const isComponent = (value: unknown): value is ComponentType<never> => value instanceof Object

/** `null` = still loading, `false` = failed (→ fallback), otherwise the loaded panel. */
type LoadState<K extends ExtensionName> = null | false | ComponentType<ExtensionProps[K]>

export function HostExtension<K extends ExtensionName>(props: HostExtensionProps<K>): JSX.Element {
  // Keyed by name so switching extension restarts the load from a clean state.
  return <HostExtensionLoader<K> key={props.name} {...props} />
}

function HostExtensionLoader<K extends ExtensionName>({
  name,
  props,
  fallback,
  loading,
}: HostExtensionProps<K>): JSX.Element {
  const [state, setState] = useState<LoadState<K>>(null)

  useEffect(() => {
    let settled = false
    const settle = (next: LoadState<K>) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      // An updater function, because `next` may itself be a component (a function),
      // which `setState(next)` would call as an updater instead of storing.
      setState(() => next)
    }

    // The race: whichever of the import and the clock finishes first decides,
    // and the other is ignored (a late module never replaces the fallback).
    const timer = setTimeout(() => settle(false), EXTENSION_TIMEOUT_MS)

    const loader = LOADERS[name] as ExtensionLoader<K> | undefined
    if (loader === undefined) {
      settle(false)
    } else {
      // `Promise.resolve().then` so a loader that throws synchronously is a rejection too.
      // Reading `.default` is its own step so a throwing module (a getter, a
      // proxy) is a rejection too — nothing in this chain can escape unhandled.
      Promise.resolve()
        .then(loader)
        .then((module) => module?.default)
        .then(
          (Component) => {
            settle(isComponent(Component) ? (Component as ComponentType<ExtensionProps[K]>) : false)
          },
          (error: unknown) => {
            console.error(`[HostExtension] could not load "${name}"`, error)
            settle(false)
          },
        )
    }

    return () => {
      // Unmounted (or the extension changed): stop the clock and drop any late result.
      settled = true
      clearTimeout(timer)
    }
  }, [name])

  if (state === false) {
    return <>{fallback}</>
  }
  if (state === null) {
    return <>{loading ?? null}</>
  }

  const Panel = state
  return (
    // Reset the boundary when the entity changes: a throw for one deal must not
    // blank the panel for the next one the host navigates to.
    <ExtensionErrorBoundary key={JSON.stringify(props)} name={name} fallback={fallback}>
      <Panel {...props} />
    </ExtensionErrorBoundary>
  )
}

interface ExtensionErrorBoundaryProps {
  name: string
  fallback: ReactNode
  children: ReactNode
}

/**
 * A render-time throw inside the federated panel is caught here and swapped for
 * the host's fallback. Hand-rolled (a boundary must be a class component), like
 * RemoteMount's.
 */
class ExtensionErrorBoundary extends Component<ExtensionErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error(`[HostExtension] "${this.props.name}" threw while rendering`, error)
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}
