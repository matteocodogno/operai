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
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { StatePanel, VersionTable } from '@operai/ui'
import type { VersionTableLabels, VersionTableRow } from '@operai/ui'
import ErrorBanner from './ErrorBanner'
import { latestVersion, newestFirst, sharedWords } from './LegalEntityHistoryModel'
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

const tableLabels: VersionTableLabels = {
  version: t.history.version,
  savedBy: t.history.savedBy,
  savedAt: t.history.savedAt,
  changed: t.history.changed,
  actions: t.history.actions,
  current: t.history.current,
  restoredFrom: t.history.restoredFrom,
  open: sharedWords(t.history.open),
  restore: sharedWords(t.history.restore),
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
        {values !== null && <span className="block text-xs text-soft">{values}</span>}
      </>
    )
  }
  return values ?? strings.common.emptyValue
}

type ListState = { id: string; items: VersionListItem[] | null; failed: boolean }

/** The versions of an entity. A reload that fails keeps the rows read before (`items`, with `failed`). */
function useVersionList(entity: LegalEntity['entity']) {
  const [attempt, setAttempt] = useState(0)
  const readId = `${entity}:${attempt}`
  const [state, setState] = useState<ListState | null>(null)

  useEffect(() => {
    let current = true
    listVersions(entity).then(
      (items) => {
        if (current) setState({ id: readId, items, failed: false })
      },
      () => {
        if (current) setState((previous) => ({ id: readId, items: previous?.items ?? null, failed: true }))
      },
    )
    return () => {
      current = false
    }
  }, [entity, readId])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return {
    items: state?.items ?? null,
    failed: state?.id === readId && state.failed,
    loading: state?.id !== readId,
    reload,
  }
}

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
  const rows = list.items === null ? null : newestFirst(list.items)
  // The version in effect: the list's highest once it is read (a save elsewhere shows up here), else the page's.
  const currentVersion = (list.items !== null ? latestVersion(list.items) : undefined) ?? entity.version

  const [restoring, setRestoring] = useState<Restoring | null>(null)
  const [restoreFailed, setRestoreFailed] = useState<number | null>(null)
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
    root.current?.querySelector<HTMLElement>(`[data-testid="${ROW_PREFIX}-${opened}-open"]`)?.focus()
  }, [version, rows])

  const open = (n: number) => {
    if (n === currentVersion) onOpenCurrent()
    else onVersionChange(n)
  }

  // From a row the dialog reads the version itself; from the version view it is handed the one already read.
  const restore = (n: number, target?: LegalEntityVersion) => {
    setRestoreFailed(null)
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
    body = list.failed ? <ErrorBanner message={t.load.failed} onRetry={list.reload} /> : <SkeletonListRows rows={3} />
  } else if (rows.length === 0) {
    body = <StatePanel title={t.history.empty} headingLevel={4} testId="admin-legal-entity-history-empty" />
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {list.failed && <ErrorBanner message={t.load.failed} onRetry={list.reload} />}
        <VersionTable
          caption={t.history.caption(name)}
          rows={tableRows}
          labels={tableLabels}
          canRestore={canChange}
          onOpen={open}
          onRestore={(n) => restore(n)}
          testId="admin-legal-history-table"
          rowTestIdPrefix={ROW_PREFIX}
        />
      </div>
    )
  }

  return (
    <div ref={root} data-testid="admin-legal-entity-history-slot">
      {restoreFailed !== null && (
        <div className="mb-3">
          <ErrorBanner message={t.restore.failed(restoreFailed)} tone="danger" onDismiss={() => setRestoreFailed(null)} />
        </div>
      )}
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
          onLoadFailed={() => {
            setRestoring(null)
            setRestoreFailed(restoring.version)
          }}
          onCancel={() => setRestoring(null)}
        />
      )}
    </div>
  )
}
