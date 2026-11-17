/**
 * LegalEntityHistory — the History view of one entity's panel (T39, specs/20261117-legal-entities, design S5–S7,
 * flows F8–F10; AC-2.2, AC-2.3, AC-2.4, AC-7.2, AC-8.1). It is what the panel mounts at `HistoryBody`.
 *
 * Two things live here, switched by `version` (the URL's `&version=n`, owned by the host):
 *
 *   no version   the table (`VersionTable`, lifted): every version newest first, who ("System" for the move), when and
 *                what changed, Open on every row, Restore on every row but the current one and only for a person who
 *                may change the entity. A row the list calls `restorable: false` keeps a focusable `aria-disabled`
 *                Restore with its reason (E1). Open on the current row goes to Details; on any other pushes
 *                `&version=n`. Loading, failed (the rows read before stay, with Retry) and empty are states of it.
 *   a version    `LegalEntityVersionView`, keyed per version so its heading takes focus each time. Back clears the
 *                version (push) and focus returns to that row's Open button, also on the browser's Back. A link to
 *                the version in effect shows it too (no "Not current", no Restore): only the Open of the current
 *                ROW goes to Details, as the design says.
 *
 * Restore (from a row or from the version view) opens `RestoreDialog`. A success is handed to the panel
 * (`onRestored`): it shows the notice on Details and puts focus on the entity heading, because the row that had it
 * may be gone. A 409 reloads this list and the entity (`onEntityChange`) so the next Confirm has the new base.
 *
 * The list is read when the view opens and again on a 409 or Retry; it is not polled (a registry of two entities).
 *
 * Paging (T61, design S5, plan G11; AC-2.2, AC-8.1, AC-8.2): the table shows the newest 50 versions. While the
 * answer carries `nextBefore`, a sentence and "Show older versions" follow it; pressing it appends the next page
 * (nothing shown is replaced). Loading keeps the button, `aria-disabled` and busy, with the focus on it. Loaded
 * announces politely and moves focus to the first new row's Open. A failure keeps the rows and replaces the button
 * with a warning and Retry, which takes the focus. The pages read are kept while this view is mounted (opening a
 * version and coming back finds them); a reload (409, Retry of the first page) starts again from the first page.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button, StatePanel, VersionTable, VisuallyHidden } from '@operai/ui'
import type { VersionTableLabels, VersionTableRow } from '@operai/ui'
import ErrorBanner from './ErrorBanner'
import { appendPage, latestVersion, newestFirst } from './LegalEntityHistoryModel'
import LegalEntityVersionView from './LegalEntityVersionView'
import RestoreDialog from './RestoreDialog'
import SkeletonListRows from './SkeletonListRows'
import { getLegalEntity, listVersions } from '../lib/legalEntitiesApi'
import type { SaveResult } from '../lib/legalEntitiesApi'
import { valueNameList } from '../lib/legalEntityMappings'
import type { LegalEntity, LegalEntityVersion, VersionListItem } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

export type LegalEntityHistoryProps = {
  entity: LegalEntity
  canChange: boolean
  /** The open version of the URL, when there is one. */
  version: number | undefined
  /** Opening or closing a version pushes an entry (Back returns from the version to the list). */
  onVersionChange: (version: number | undefined) => void
  /** Replaces the entry: "Open" on the current version goes to Details. */
  onOpenCurrent: () => void
  /** The entity as read again (after a 409). */
  onEntityChange: (entity: LegalEntity) => void
  /** A 403 on the restore. */
  onLost: () => void
  /** A restore succeeded (`result.created` is false when the details were already the current ones). */
  onRestored: (result: SaveResult, from: number) => void
}

const ROW_PREFIX = 'admin-legal-version-row'
const TABLE_ID = 'admin-legal-history-table'
const PAGING_ID = 'admin-legal-history-paging'

const tableLabels: VersionTableLabels = {
  version: t.history.version,
  savedBy: t.history.savedBy,
  savedAt: t.history.savedAt,
  changed: t.history.changed,
  actions: t.history.actions,
  current: t.history.current,
  restoredFrom: t.history.restoredFrom,
  open: t.history.openLabel,
  restore: t.history.restoreLabel,
  openName: t.history.open,
  restoreName: t.history.restore,
}

/** What changed, in words: the move says so, a restore says which version it copies and which values it changed. */
function changedCell(item: VersionListItem) {
  const values = item.changedFields.length > 0 ? valueNameList(item.changedFields) : null
  if (item.action === 'import') return t.history.moved
  if (item.action === 'restore' && item.restoredFrom !== null) {
    return (
      <>
        {t.history.sameAs(item.restoredFrom)}
        {values !== null && <span className="block text-xs text-soft">{t.history.changedList(values)}</span>}
      </>
    )
  }
  return values ?? strings.common.emptyValue
}

/** The versions asked for at a time: the newest 50 first, then 50 older ones each time. */
const PAGE_SIZE = 50

type ListState = {
  id: string
  items: VersionListItem[] | null
  nextBefore: number | null
  /** Pages read since the first one; more than one makes "Showing all n versions" true on the last page. */
  pages: number
  failed: boolean
}
type MoreState = { id: string; status: 'loading' | 'failed' }
/** The last page that arrived: `firstNew` is the version of its first (newest) row, `seq` tells one from the next. */
type Arrived = { id: string; seq: number; firstNew: number; count: number }

/**
 * The versions of an entity, a page at a time. The first page is read with the entity (and again on `reload`; a
 * reload that fails keeps the rows read before, with `failed`). `loadMore` appends the page before the oldest shown.
 * What belongs to one read (`more`, `arrived`) is keyed by its id, so a reload drops it without an effect.
 */
function useVersionList(entity: LegalEntity['entity']) {
  const [attempt, setAttempt] = useState(0)
  const readId = `${entity}:${attempt}`
  const [state, setState] = useState<ListState | null>(null)
  const [more, setMore] = useState<MoreState | null>(null)
  const [arrived, setArrived] = useState<Arrived | null>(null)
  const seq = useRef(0)
  const loadingMore = useRef(false)

  useEffect(() => {
    let current = true
    listVersions(entity, { limit: PAGE_SIZE }).then(
      (page) => {
        if (current) setState({ id: readId, items: page.items, nextBefore: page.nextBefore, pages: 1, failed: false })
      },
      () => {
        if (current) setState((previous) => ({ ...(previous ?? EMPTY), id: readId, failed: true }))
      },
    )
    return () => {
      current = false
    }
  }, [entity, readId])

  const loadMore = useCallback(() => {
    if (state === null || state.id !== readId || state.items === null || state.nextBefore === null) return
    if (loadingMore.current) return
    loadingMore.current = true
    const { items, nextBefore } = state
    setMore({ id: readId, status: 'loading' })
    listVersions(entity, { limit: PAGE_SIZE, before: nextBefore }).then(
      (page) => {
        loadingMore.current = false
        const next = appendPage(items, page.items)
        // A page that adds nothing new while it says more remain would repeat: treat it as a failure.
        if (next.added.length === 0 && page.nextBefore !== null) {
          setMore((previous) => (previous?.id === readId ? { id: readId, status: 'failed' } : previous))
          return
        }
        setState((previous) =>
          previous !== null && previous.id === readId
            ? { ...previous, items: next.items, nextBefore: page.nextBefore, pages: previous.pages + 1 }
            : previous,
        )
        setMore((previous) => (previous?.id === readId ? null : previous))
        if (next.added.length > 0) {
          seq.current += 1
          setArrived({
            id: readId,
            seq: seq.current,
            firstNew: Math.max(...next.added.map((item) => item.version)),
            count: next.added.length,
          })
        }
      },
      () => {
        loadingMore.current = false
        setMore((previous) => (previous?.id === readId ? { id: readId, status: 'failed' } : previous))
      },
    )
  }, [entity, readId, state])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return {
    items: state?.items ?? null,
    nextBefore: state?.nextBefore ?? null,
    pages: state?.pages ?? 0,
    failed: state?.id === readId && state.failed,
    loading: state?.id !== readId,
    moreStatus: more?.id === readId ? more.status : null,
    arrived: arrived?.id === readId ? arrived : null,
    loadMore,
    reload,
  }
}

const EMPTY: Omit<ListState, 'id' | 'failed'> = { items: null, nextBefore: null, pages: 0 }

type Restoring = { version: number; target?: LegalEntityVersion }

export default function LegalEntityHistory({
  entity,
  canChange,
  version,
  onVersionChange,
  onOpenCurrent,
  onEntityChange,
  onLost,
  onRestored,
}: LegalEntityHistoryProps) {
  const name = strings.common.entities[entity.entity]
  const list = useVersionList(entity.entity)
  const sentenceId = useId()
  const rows = list.items === null ? null : newestFirst(list.items)
  // The version in effect: the list's highest once it is read (a save elsewhere shows up here), else the page's.
  const currentVersion = (list.items !== null ? latestVersion(list.items) : undefined) ?? entity.version

  const [restoring, setRestoring] = useState<Restoring | null>(null)
  const root = useRef<HTMLDivElement>(null)

  // Back from a version returns focus to that row's Open button (its row is where the person was).
  const lastOpened = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (version !== undefined) {
      lastOpened.current = version
      return
    }
    if (rows === null || lastOpened.current === undefined) return
    const opened = lastOpened.current
    lastOpened.current = undefined
    // The row's Open; a version that is not among the pages read (a link to an old one) has no row: the table.
    const target =
      root.current?.querySelector<HTMLElement>(`[data-testid="${ROW_PREFIX}-${opened}-open"]`) ??
      root.current?.querySelector<HTMLElement>(`[data-testid="${TABLE_ID}"]`)?.closest<HTMLElement>('[role="region"]')
    target?.focus()
  }, [version, rows])

  // A page arrived: focus moves to the Open of its first row (the button that had it may be gone).
  const arrivedSeq = list.arrived?.seq
  useEffect(() => {
    if (list.arrived === null) return
    root.current?.querySelector<HTMLElement>(`[data-testid="${ROW_PREFIX}-${list.arrived.firstNew}-open"]`)?.focus()
    // Only a new page moves focus, not a re-render that still holds the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivedSeq])

  // The page failed: focus moves to Retry. A retry that starts puts focus on the loading button (Retry is gone).
  const moreButton = useRef<HTMLButtonElement>(null)
  const retrying = useRef(false)
  const moreStatus = list.moreStatus
  useEffect(() => {
    if (moreStatus === 'failed') {
      root.current?.querySelector<HTMLElement>(`[data-testid="${PAGING_ID}"] [data-testid="error-banner-retry"]`)?.focus()
    } else if (moreStatus === 'loading' && retrying.current) {
      moreButton.current?.focus()
    }
    if (moreStatus !== 'failed') retrying.current = false
  }, [moreStatus])

  const open = (n: number) => {
    if (n === currentVersion) onOpenCurrent()
    else onVersionChange(n)
  }

  // From a row the dialog reads the version itself; from the version view it is handed the one already read.
  const restore = (n: number, target?: LegalEntityVersion) => {
    setRestoring({ version: n, target })
  }

  const handleConflict = () => {
    list.reload()
    getLegalEntity(entity.entity).then(onEntityChange, () => undefined)
  }

  const tableRows: VersionTableRow[] = (rows ?? []).map((item) => ({
    version: item.version,
    current: item.version === currentVersion,
    restoredFrom: item.restoredFrom,
    savedBy: item.createdBy?.name ?? t.history.system,
    savedAt: item.createdAt,
    changed: changedCell(item),
    restoreBlockedReason: item.restorable ? undefined : t.history.restoreBlocked,
  }))

  let body
  if (version !== undefined) {
    body = (
      <LegalEntityVersionView
        key={version}
        entity={entity.entity}
        version={version}
        currentVersion={currentVersion}
        canChange={canChange}
        listedBlocked={rows?.find((item) => item.version === version)?.restorable === false}
        onBack={() => onVersionChange(undefined)}
        onRestore={(target) => restore(target.version, target)}
      />
    )
  } else if (rows === null) {
    body = list.failed ? (
      <ErrorBanner message={t.history.failed} onRetry={list.reload} />
    ) : (
      <SkeletonListRows rows={3} label={t.history.loading} />
    )
  } else if (rows.length === 0) {
    body = <StatePanel title={t.history.empty} headingLevel={4} testId="admin-legal-entity-history-empty" />
  } else {
    const shown = rows.length
    // One page (the whole history fits in it): no sentence and no button, as before paging.
    const paged = list.nextBefore !== null || list.pages > 1
    body = (
      <div className="flex flex-col gap-3">
        {list.failed && <ErrorBanner message={t.history.failed} onRetry={list.reload} />}
        <VersionTable
          caption={t.history.caption(name)}
          rows={tableRows}
          labels={tableLabels}
          canRestore={canChange}
          onOpen={open}
          onRestore={(n) => restore(n)}
          testId={TABLE_ID}
          rowTestIdPrefix={ROW_PREFIX}
        />
        <div className="flex flex-col items-start gap-2" data-testid={PAGING_ID}>
          {paged && (
            <p id={sentenceId} className="text-sm text-soft" data-testid="admin-legal-history-showing">
              {list.nextBefore !== null ? t.history.showing(shown) : t.history.showingAll(shown)}
            </p>
          )}
          {list.nextBefore !== null && moreStatus !== 'failed' && (
            <Button
              ref={moreButton}
              variant="secondary"
              busy={moreStatus === 'loading'}
              aria-disabled={moreStatus === 'loading' || undefined}
              aria-describedby={sentenceId}
              data-testid="admin-legal-history-more"
              onClick={() => {
                if (moreStatus !== 'loading') list.loadMore()
              }}
            >
              {moreStatus === 'loading' ? t.history.loadingMore : t.history.more}
            </Button>
          )}
          {list.nextBefore !== null && moreStatus === 'failed' && (
            <ErrorBanner
              message={t.history.moreFailed}
              onRetry={() => {
                retrying.current = true
                list.loadMore()
              }}
            />
          )}
          <VisuallyHidden live role="status" data-testid="admin-legal-history-status">
            {list.arrived !== null ? t.history.moreLoaded(list.arrived.count) : ''}
          </VisuallyHidden>
        </div>
      </div>
    )
  }

  return (
    <div ref={root} data-testid="admin-legal-entity-history-slot">
      {body}
      {restoring !== null && (
        <RestoreDialog
          entity={entity}
          version={restoring.version}
          target={restoring.target}
          baseVersion={currentVersion}
          onRestored={(result) => {
            setRestoring(null)
            onRestored(result, restoring.version)
          }}
          onConflict={handleConflict}
          onLost={onLost}
          onCancel={() => setRestoring(null)}
        />
      )}
    </div>
  )
}
