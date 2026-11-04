/**
 * hostLinks — how the list, the new-meeting page and the host panel talk about a host record
 * (specs/021-meetings design.md S1, S2, S6): the registry's labels, the "<Entity> · <title>"
 * text, and a link that leaves this remote through the shell's router (`navigateSuite`).
 *
 * The registry (`GET /hosts`) is decoration: a failed or slow load degrades to the raw app and
 * entity type, never to an error (design.md S1 "host-label failures degrade silently").
 */
import type { MouseEvent } from 'react'
import { resolveLocale } from '@operai/ui'
import { navigateSuite } from 'shell/session'
import { useResource } from '../hooks/useResource'
import { listHosts } from './meetingsApi'
import type { HostInfo, HostView } from './types'

/**
 * Props for an `<a>` that goes to another app: a real `href` (open in a new tab, copy the
 * address, middle-click) whose plain click goes through the shell's router instead of a reload.
 */
export function suiteLinkProps(href: string) {
  return {
    href,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      event.preventDefault()
      navigateSuite(href)
    },
  }
}

const fetchHosts = (signal: AbortSignal) => listHosts({ signal })

/** The registered hosts, or null until (or unless) `GET /hosts` answers. */
export function useHosts(): HostInfo[] | null {
  const { data } = useResource(fetchHosts)
  return data?.items ?? null
}

/** The app and entity words of a host kind, in the page language; the raw ids when the registry is not known. */
export function hostNames(hosts: HostInfo[] | null, app: string, entityType: string): { app: string; entity: string } {
  const labels = hosts?.find((host) => host.app === app && host.entityType === entityType)?.labels[resolveLocale()]
  return { app: labels?.app ?? app, entity: labels?.entity ?? entityType }
}

export type HostText =
  /** The caller can open the record: "Deal · Acme renewal" and where it lives. */
  | { kind: 'open'; text: string; href: string }
  /** The record is there but not openable (or the host did not answer): "CRM · deal" (AC-10.3). */
  | { kind: 'plain'; text: string }
  /** The record no longer exists (AC-10.3). */
  | { kind: 'missing' }

export function describeHost(host: HostView, hosts: HostInfo[] | null): HostText {
  if (host.state === 'missing') return { kind: 'missing' }
  const names = hostNames(hosts, host.app, host.entityType)
  if (host.state === 'open' && host.title !== null && host.href !== null) {
    return { kind: 'open', text: `${names.entity} · ${host.title}`, href: host.href }
  }
  return { kind: 'plain', text: `${names.app} · ${names.entity.toLocaleLowerCase(resolveLocale())}` }
}
