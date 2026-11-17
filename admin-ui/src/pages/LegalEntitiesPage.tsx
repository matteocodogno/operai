import { useCallback, useEffect, useMemo, useState } from 'react'
import { useBlocker, useNavigate, useSearch } from '@tanstack/react-router'
import { ConfirmDialog, PageHeader, Tabs, VisuallyHidden, resolveLocale, tabPanelProps } from '@operai/ui'
import ErrorBanner from '../components/ErrorBanner'
import LegalEntityPanel from '../components/LegalEntityPanel'
import type { LegalEntityView } from '../components/LegalEntityPanel'
import { EntityReadOnlyBadge, EntityStatusBadge, EntityUnsavedBadge } from '../components/LegalEntityPanelBadges'
import PermissionDenied from '../components/PermissionDenied'
import SkeletonListRows from '../components/SkeletonListRows'
import { ApiError } from '../lib/adminApi'
import { legalEntityStatus } from '../lib/legalEntityMappings'
import { getManageable, listLegalEntities } from '../lib/legalEntitiesApi'
import { LEGAL_ENTITY_IDS, detailsOf } from '../lib/legalEntityModel'
import type { LegalEntity, LegalEntityDetails, LegalEntityId } from '../lib/legalEntityModel'
import { useEntityDrafts } from '../lib/useEntityDrafts'
import { strings } from '../strings'

const t = strings.legalEntities.page
const labels = strings.legalEntities

/**
 * LegalEntitiesPage — the `/legal-entities` route's host (T35 made the route, T36 fills it; specs/20261117-legal-entities,
 * owner decision Q1=B, design S1 and F3b, plan E7).
 *
 * ONE page for both entities: the entity tabs on top (each with its status badge, a Read-only mark and an
 * "Unsaved changes" mark in its accessible name), the selected entity's panel (`LegalEntityPanel`: header, the
 * Details | History tabs, banners, body) under them. The entity, the view and an open version are the URL
 * (`?entity=&view=&version=`, validated by `validateLegalEntitiesSearch` in ../router.tsx, which drops anything
 * else before this mounts: nothing of an unknown value is rendered here). A value absent from the URL means the
 * default: the first entity the person may change, else WellD IT; Details.
 *
 * Tabs REPLACE the history entry (Back leaves the page, not the last tab). Opening or closing a version PUSHES one
 * (Back returns from the version to the list): that is `onVersionChange`, called by T39's history.
 *
 * Drafts: `useEntityDrafts` keeps one unsaved draft per entity in memory above the panel, so switching entity, view
 * or version never loses typing and never asks anything. Only LEAVING THE PAGE asks (a router blocker for a section
 * tab or any link or Back/Forward out of the route, `beforeunload` for a reload or a closed tab), naming the
 * entities with unsaved changes. The blocker ignores a navigation inside the route, which is what every tab is.
 * It cannot see a navigation that leaves admin-ui's own router (a link handled by the shell's router): that one
 * is outside what a remote can intercept.
 *
 * Data: `GET /legal-entities/manageable` (which entities this person may change) and `GET /legal-entities` (both
 * entities, always, fixed order). Any failure of `manageable` fails closed: the page shows the load error with a
 * Retry rather than guessing read-only or editable. A 403 is `PermissionDenied`. A 403 on a later write
 * (`onLost`) turns that one entity read-only and drops its draft.
 */

type Registry = {
  /** Both entities as last read, by id. */
  entities: Record<LegalEntityId, LegalEntity>
  /** The entities this person may change, from `manageable`. */
  manageable: readonly LegalEntityId[]
}

type Load = { status: 'loading' } | { status: 'denied' } | { status: 'failed' } | { status: 'ready'; registry: Registry }

function useRegistry() {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    Promise.all([getManageable(), listLegalEntities()]).then(
      ([manageable, list]) => {
        if (!current) return
        const entities = Object.fromEntries(list.map((entity) => [entity.entity, entity])) as Record<
          LegalEntityId,
          LegalEntity
        >
        setLoad({ status: 'ready', registry: { entities, manageable } })
      },
      (error: unknown) => {
        if (!current) return
        setLoad({ status: error instanceof ApiError && error.status === 403 ? 'denied' : 'failed' })
      },
    )
    return () => {
      current = false
    }
  }, [attempt])

  const retry = useCallback(() => {
    setLoad({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const replaceEntity = useCallback((entity: LegalEntity) => {
    setLoad((previous) =>
      previous.status === 'ready'
        ? {
            status: 'ready',
            registry: {
              ...previous.registry,
              entities: { ...previous.registry.entities, [entity.entity]: entity },
            },
          }
        : previous,
    )
  }, [])

  return { load, retry, replaceEntity }
}

/** Names for a sentence ("WellD Italia and WellD CH"), in the language of the page. */
const nameList = (entities: readonly LegalEntityId[]): string =>
  new Intl.ListFormat(resolveLocale(), { style: 'long', type: 'conjunction' }).format(
    entities.map((entity) => strings.common.entities[entity]),
  )

const ENTITY_PREFIX = 'admin-legal-entity'

/**
 * The label of an entity's tab: its name, then its marks. The visible marks are badges (glyph + words); the
 * accessible name is ONE string, "WellD CH, Incomplete, Read-only, Unsaved changes", so it reads the same in every
 * browser (a badge is a flex item, and engines differ on the space between flex items) and the entity comes first.
 */
function EntityTabLabel({ entity, readOnly, unsaved }: { entity: LegalEntity; readOnly: boolean; unsaved: boolean }) {
  const name = strings.common.entities[entity.entity]
  const spoken = [name, legalEntityStatus(entity).label, readOnly && labels.status.readOnly, unsaved && labels.tab.unsaved]
    .filter((part) => part !== false)
    .join(', ')
  return (
    <>
      <span aria-hidden="true" className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{name}</span>
        <EntityStatusBadge entity={entity} />
        {readOnly && <EntityReadOnlyBadge />}
        {unsaved && <EntityUnsavedBadge />}
      </span>
      <VisuallyHidden>{spoken}</VisuallyHidden>
    </>
  )
}

export default function LegalEntitiesPage() {
  const search = useSearch({ from: '/legal-entities' })
  const navigate = useNavigate()
  const { load, retry, replaceEntity } = useRegistry()
  // Entities whose grant was lost this session (a 403 on a write): read-only from then on.
  const [lost, setLost] = useState<readonly LegalEntityId[]>([])

  const registry = load.status === 'ready' ? load.registry : null
  const bases = useMemo(() => {
    const result: Partial<Record<LegalEntityId, LegalEntityDetails>> = {}
    if (registry) for (const id of LEGAL_ENTITY_IDS) result[id] = detailsOf(registry.entities[id])
    return result
  }, [registry])
  const drafts = useEntityDrafts(bases)

  // The guard: only leaving the page asks. A navigation to another search of this same route (every tab) never does.
  const hasUnsaved = drafts.unsaved.length > 0
  const shouldBlockFn = useCallback(
    ({ current, next }: { current: { routeId: string }; next: { routeId: string } }) => current.routeId !== next.routeId,
    [],
  )
  const blocker = useBlocker({
    shouldBlockFn,
    enableBeforeUnload: hasUnsaved,
    disabled: !hasUnsaved,
    withResolver: true,
  })

  const canChange = (entity: LegalEntityId) =>
    registry !== null && registry.manageable.includes(entity) && !lost.includes(entity)

  const defaultEntity: LegalEntityId = registry
    ? (LEGAL_ENTITY_IDS.find((id) => registry.manageable.includes(id)) ?? 'welld_it')
    : 'welld_it'
  const selected: LegalEntityId = search.entity ?? defaultEntity
  const view: LegalEntityView = search.view ?? 'details'

  const go = useCallback(
    (to: { entity: LegalEntityId; view?: LegalEntityView; version?: number }, push: boolean) => {
      void navigate({
        to: '/legal-entities',
        search: {
          entity: to.entity,
          ...(to.view === 'history' ? { view: 'history' as const } : {}),
          ...(to.view === 'history' && to.version !== undefined ? { version: to.version } : {}),
        },
        replace: !push,
      })
    },
    [navigate],
  )

  const onLost = useCallback(
    (entity: LegalEntityId) => {
      setLost((previous) => (previous.includes(entity) ? previous : [...previous, entity]))
      drafts.discard(entity)
    },
    [drafts],
  )

  return (
    <section aria-labelledby="admin-legal-entities-heading" data-testid="admin-legal-entities-page">
      <PageHeader title={t.heading} titleId="admin-legal-entities-heading" description={t.description} />

      {load.status === 'loading' && <SkeletonListRows rows={3} />}
      {load.status === 'denied' && <PermissionDenied headingLevel={3} />}
      {load.status === 'failed' && <ErrorBanner message={labels.load.failed} onRetry={retry} />}

      {registry && (
        <>
          <Tabs
            label={labels.tabs.entities}
            wrap
            idPrefix={ENTITY_PREFIX}
            testId="admin-legal-entity-tabs"
            tabs={LEGAL_ENTITY_IDS.map((id) => ({
              id,
              label: (
                <EntityTabLabel
                  entity={registry.entities[id]}
                  readOnly={!canChange(id)}
                  unsaved={drafts.isUnsaved(id)}
                />
              ),
            }))}
            value={selected}
            // Selecting another entity opens its Details; the tab replaces the history entry. The selected one is left alone.
            onChange={(entity) => {
              if (entity !== selected) go({ entity }, false)
            }}
          />

          {/* The tabpanel starts with focusable content (the view tabs), so it is not a tab stop of its own. */}
          <div {...tabPanelProps(ENTITY_PREFIX, selected)} tabIndex={undefined} className="pt-4">
            <LegalEntityPanel
              key={selected}
              entity={registry.entities[selected]}
              canChange={canChange(selected)}
              view={view}
              version={search.version}
              draft={drafts.draftOf(selected)}
              onViewChange={(next) => go({ entity: selected, view: next }, false)}
              onVersionChange={(version) => go({ entity: selected, view: 'history', version }, true)}
              onDraftChange={(draft) => (draft === undefined ? drafts.discard(selected) : drafts.setDraft(selected, draft))}
              onEntityChange={replaceEntity}
              onLost={() => onLost(selected)}
            />
          </div>
        </>
      )}

      {blocker.status === 'blocked' && (
        <ConfirmDialog
          title={labels.leave.title}
          confirmLabel={labels.leave.discard}
          cancelLabel={labels.leave.keep}
          closeLabel={strings.common.actions.cancel}
          busyLabel={labels.leave.discard}
          busy={false}
          error={null}
          testIdPrefix="admin-legal-leave"
          onCancel={blocker.reset}
          onConfirm={() => {
            blocker.proceed()
            drafts.discardAll()
          }}
        >
          {labels.leave.body(nameList(drafts.unsaved))}
        </ConfirmDialog>
      )}
    </section>
  )
}
