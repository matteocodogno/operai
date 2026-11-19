import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, Outlet, useNavigate, useSearch } from '@tanstack/react-router'
import { Banner, TabNav, ToolLayout, tabLinkClassName } from '@operai/ui'
import { AccountingContext, noticeAfterReread, resolveEntity } from '../hooks/useEntity'
import type { AccountingContextValue, EntityResolution, Notice, RereadReason } from '../hooks/useEntity'
import { useLoadedResource } from '../hooks/useLoadedResource'
import { getMe, isEntityId } from '../lib/meApi'
import type { EntityId, MeEntity } from '../lib/meApi'
import NotFoundPage from '../pages/NotFoundPage'
import { strings } from '../strings'
import { LoadFailure, Loading } from './LoadState'
import PermissionDenied from './PermissionDenied'

/**
 * AccountingShell — accounting-ui's root layout (specs/20261119-accounting, design AS1, AS2, UX-1, UX-2, UX-12, UX-15):
 * the tool title (h1), the `TabNav` of its three views, and the routed page. No suite chrome and no auth guard: the shell
 * owns both and mounts this remote only for `apps ∋ accounting` (AC-8.1, ADR 20261117-an-app-is-reachable-…); inside the
 * remote nothing re-checks that grant, and accounting-api enforces every route anyway.
 *
 * It reads `GET /v1/me` once and hands the covered entities, the DISPLAYED entity and its `canManage` to the pages through
 * `AccountingContext` (`useEntity`). Exactly one state at a time, the title on screen in every one:
 *
 *   loading                      a polite line + skeleton rows in the page area (the nav is already there)
 *   403, or no covered entity    `PermissionDenied` (alert, focus, no retry); the nav is left out: no view of it can open
 *   503                          the "authorization service unavailable" warning banner with Retry
 *   any other failure            a warning banner with the Problem detail and Retry
 *   a known entity not covered   the not-found view with focus on its heading (`?entity=welld_it` for a CH-only manager)
 *   loaded                       the page
 *
 * `?entity=` follows `resolveEntity`; a value that is not an entity id is rewritten to the first covered entity with `replace`.
 * The tabs carry `?entity=` (only a covered one) and drop `?month=`, which belongs to Exchange rates. A page that learns the
 * grant changed (a list answers 404, a write answers 403) asks the frame to re-read `/v1/me`, which falls back and says so once.
 */

const NO_ENTITIES: readonly MeEntity[] = []

export default function AccountingShell() {
  const me = useLoadedResource(() => getMe())
  const raw = useSearch({ strict: false }) as { entity?: unknown }
  const navigate = useNavigate()
  const [notice, setNotice] = useState<Notice | null>(null)

  const entities = me.status === 'loaded' ? me.data.entities : NO_ENTITIES
  const resolved: EntityResolution = resolveEntity(entities, raw.entity)
  // A page said the displayed entity is gone: its address still names it, which is NOT a typed address (UX-12). Fall back.
  const resolution: EntityResolution =
    resolved.kind === 'not_found' && notice?.kind === 'lost' && notice.was === resolved.requested
      ? { kind: 'fallback', entity: entities[0]! }
      : resolved

  // A value that is not an entity id (or an entity that is gone) is replaced in the address by the first covered entity.
  const fallbackId = resolution.kind === 'fallback' ? resolution.entity.entity : null
  useEffect(() => {
    if (fallbackId === null) return
    void navigate({
      to: '.',
      search: (previous: Record<string, unknown>) => ({ ...previous, entity: fallbackId }),
      replace: true,
    })
  }, [fallbackId, navigate])

  const displayed =
    resolution.kind === 'given' || resolution.kind === 'default' || resolution.kind === 'fallback'
      ? resolution.entity
      : null
  const { replace, reload } = me
  // `before` is the entity displayed when the page asked, so the note compares with what the person was looking at.
  const reread = useCallback(
    (reason: RereadReason, before: MeEntity) => {
      getMe().then(
        (fresh) => {
          replace(fresh)
          setNotice(noticeAfterReread(reason, { entity: before.entity, canManage: before.canManage }, fresh))
        },
        // The re-read failed: let the one failure ladder say why (403 → denied, 503 → the banner, else Retry).
        () => reload(),
      )
    },
    [replace, reload],
  )

  const selectEntity = useCallback(
    (id: EntityId) => {
      void navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => ({ ...previous, entity: id, month: undefined }),
        replace: true,
      })
    },
    [navigate],
  )

  const value = useMemo<AccountingContextValue | null>(
    () =>
      displayed === null
        ? null
        : {
            entities,
            entity: displayed,
            selectEntity,
            entityGone: () => reread('gone', displayed),
            writeRefused: () => reread('refused', displayed),
          },
    [displayed, entities, selectEntity, reread],
  )

  const denied = me.status === 'forbidden' || (me.status === 'loaded' && entities.length === 0)

  // Only a covered entity is carried from tab to tab; before `/v1/me` answers, a well-formed one is.
  const carried: EntityId | undefined =
    resolution.kind === 'given'
      ? resolution.entity.entity
      : me.status !== 'loaded' && isEntityId(raw.entity)
        ? raw.entity
        : undefined

  let content: ReactNode
  if (me.status === 'loading') content = <Loading label={strings.nav.loading} />
  else if (denied) content = <PermissionDenied />
  else if (me.status === 'error') content = <LoadFailure error={me.error} onRetry={me.reload} />
  else if (resolution.kind === 'not_found') content = <NotFoundPage />
  else if (value !== null)
    content = (
      <AccountingContext.Provider value={value}>
        {notice !== null && (
          <Banner
            tone="info"
            onDismiss={() => setNotice(null)}
            dismissLabel={strings.common.dismiss}
            data-testid="accounting-notice"
          >
            {notice.kind === 'lost'
              ? strings.entity.lost(strings.entity[notice.was], strings.entity[notice.now])
              : strings.common.accessChanged}
          </Banner>
        )}
        <Outlet />
      </AccountingContext.Provider>
    )

  return (
    <ToolLayout
      title={strings.appTitle}
      testId="accounting-shell"
      nav={
        denied ? undefined : (
          <TabNav label={strings.nav.landmarkLabel} wrap>
            <Link
              to="/ledger-accounts"
              search={{ entity: carried }}
              activeOptions={{ includeSearch: false }}
              className={tabLinkClassName}
            >
              {strings.nav.ledgerAccounts}
            </Link>
            <Link
              to="/vat-codes"
              search={{ entity: carried }}
              activeOptions={{ includeSearch: false }}
              className={tabLinkClassName}
            >
              {strings.nav.vatCodes}
            </Link>
            <Link
              to="/exchange-rates"
              search={{ entity: carried }}
              activeOptions={{ includeSearch: false }}
              className={tabLinkClassName}
            >
              {strings.nav.exchangeRates}
            </Link>
          </TabNav>
        )
      }
    >
      {content}
    </ToolLayout>
  )
}
