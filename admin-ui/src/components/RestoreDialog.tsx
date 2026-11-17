/**
 * RestoreDialog — "Restore version n?" (T39, specs/20261117-legal-entities, design S7, flow F10; AC-2.4, AC-2.5).
 *
 * A `ConfirmDialog tone="primary"` that owns the restore call and its four refusals. It says what will happen (a
 * NEW version is made with the details of version n; nothing is rewritten) and which values change compared with
 * the version in effect, so a change to the IBAN is visible before it is made. Both versions' details are read
 * here: the entity the page holds is the current one when it is, otherwise it is fetched; the version to restore is
 * given by the version view, or fetched when the dialog is opened from a row.
 *
 * The person never confirms a restore whose changes they have not been shown. While the two versions are not both in
 * hand the dialog is a READING dialog (the library `Dialog`, no Confirm at all): a skeleton and the hidden live
 * "Loading the details of version n…" while it reads, or the warning `restore.detailsFailed` with Retry when it cannot
 * (fail closed: without both versions it cannot tell whether a protected detail changes, AC-9.4, plan G7). Cancel works
 * in both. A restore from the version view hands the version it already read and the entity is the current one, so
 * the confirmation opens at once, with nothing to wait for. When both are read the dialog is the confirmation below,
 * and focus lands on Cancel as in every confirmation. After a 409 the version in effect has changed, so the details
 * are read again behind the open dialog: Confirm is busy ("Loading…") meanwhile, and a read that fails turns it back
 * into the reading dialog with Retry.
 *
 * Protected details (AC-9.4, 9.6): below the change line, only when a protected detail (legal name, VAT number, IBAN)
 * differs between the current version (Old) and version n (New), the dialog says what that is, who is told, and lists
 * them with `ProtectedChangeList` (the IBAN as `ibanPrint`). Nothing differs: the dialog is as it was, with no list.
 * It sits in the dialog's described content, so it is announced when the dialog opens.
 *
 * Refusals, inline in the dialog (it stays open; Cancel is the way out):
 *   422 invalid_legal_entity  assertive "Version n cannot be restored: {values}. Nothing changed." (only a race now: the
 *                             history already disables a non-restorable row)
 *   409 version_conflict      "A newer version was saved meanwhile…": the base moves to the answer's `currentVersion`,
 *                             the page reloads the history (`onConflict`) and the next Confirm uses the new base
 *   403                       "You can no longer change {entity}" and `onLost()`: the page turns read-only
 *   429                       warning "Too many changes in a short time. Nothing was restored. Wait about m minutes…"
 *                             (from `Retry-After`, rounded up; no readable header: "a few minutes"); Confirm stays available
 *   404 / 5xx / network       "Version n was not restored. Nothing changed. Try again."
 *
 * On success the dialog calls `onRestored(result)`; the caller closes it (it is unmounted, focus goes where the caller
 * decides: the entity heading).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Banner, Button, ConfirmDialog, Dialog } from '@operai/ui'
import { refusedFields, restoreChanges } from './LegalEntityHistoryModel'
import ProtectedChangeList from './ProtectedChangeList'
import { protectedChangesBetween, waitText } from './ProtectedChangeModel'
import type { ComparedVersion } from './ProtectedChangeModel'
import SkeletonListRows from './SkeletonListRows'
import { LegalEntityApiError, getVersion, restoreVersion } from '../lib/legalEntitiesApi'
import type { SaveResult } from '../lib/legalEntitiesApi'
import { valueNameList } from '../lib/legalEntityMappings'
import type { LegalEntity, LegalEntityVersion } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

export type RestoreDialogProps = {
  /** The entity as the page last read it (the current version, unless the page is stale). */
  entity: LegalEntity
  /** The version to restore. */
  version: number
  /** Its details when the caller has them (the version view); otherwise they are read here. */
  target?: LegalEntityVersion
  /** The version in effect as the history shows it: what the restore is based on (a stale base is a 409). */
  baseVersion: number
  /** The restore was done (or was already the current details: `created` is false). */
  onRestored: (result: SaveResult) => void
  /** A 409: reload the history and the entity; the dialog already uses the answer's `currentVersion`. */
  onConflict: () => void
  /** A 403: the person can no longer change this entity. */
  onLost: () => void
  /**
   * No longer called (T60): a read that fails is shown inside the dialog, with Retry, instead of closing it and saying so
   * elsewhere. Kept optional so the history, which still passes it, compiles until it drops it.
   */
  onLoadFailed?: () => void
  onCancel: () => void
}

/** What the confirmation shows: the version to restore and the version in effect (with the IBAN as printed). */
type Compared = { target: ComparedVersion; current: ComparedVersion }

type Failure = 'refused' | 'conflict' | 'lost' | 'failed' | 'tooMany'

export default function RestoreDialog({
  entity,
  version,
  target,
  baseVersion,
  onRestored,
  onConflict,
  onLost,
  onCancel,
}: RestoreDialogProps) {
  const name = strings.common.entities[entity.entity]
  // A 409 names the version now in effect; the history's own answer may arrive later, and the higher one wins.
  const [conflictBase, setConflictBase] = useState(0)
  const base = Math.max(baseVersion, conflictBase)

  const [attempt, setAttempt] = useState(0)
  const readId = `${entity.entity}:${version}:${base}:${attempt}`
  // `compared` is the last pair read; `read` says whether the read of THIS pair of versions is over, and how.
  // Both in hand already (the version view's restore, on the current entity): nothing to read, nothing to wait for.
  const inHand = target !== undefined && target.version === version && entity.version === base
  const [compared, setCompared] = useState<Compared | null>(() => (inHand ? { target, current: entity } : null))
  const [read, setRead] = useState<{ id: string; failed: boolean } | null>(() =>
    inHand ? { id: readId, failed: false } : null,
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ kind: Failure; list?: string; wait?: string } | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const readingId = useId()

  // The effect reads the latest props without re-running when they are replaced by an equal read.
  const latest = useRef({ entity, target, read, onRestored, onConflict, onLost })
  useEffect(() => {
    latest.current = { entity, target, read, onRestored, onConflict, onLost }
  })

  useEffect(() => {
    // The pair of this very id was handed over at mount: nothing to read.
    if (latest.current.read?.id === readId) return
    let current = true
    const { entity: known, target: given } = latest.current
    const targetRead =
      given !== undefined && given.version === version ? Promise.resolve(given) : getVersion(known.entity, version)
    const currentRead = known.version === base ? Promise.resolve(known) : getVersion(known.entity, base)
    Promise.all([targetRead, currentRead]).then(
      ([targetDetails, currentDetails]) => {
        if (!current) return
        setCompared({ target: targetDetails, current: currentDetails })
        setRead({ id: readId, failed: false })
      },
      () => {
        if (!current) return
        setRead({ id: readId, failed: true })
      },
    )
    return () => {
      current = false
    }
  }, [readId, version, base])

  const loading = read?.id !== readId
  const loadFailed = read?.id === readId && read.failed
  // What is shown is only ever about THIS pair of versions: while it is read again (after a 409) nothing stale is listed.
  const shown = compared !== null && !loading && !loadFailed ? compared : null
  const changes = shown === null ? [] : restoreChanges(shown.target, shown.current)
  const protectedChanges = shown === null ? [] : protectedChangesBetween(shown.current, shown.target)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const restore = useCallback(() => {
    setBusy(true)
    setFailure(null)
    restoreVersion(latest.current.entity.entity, version, base).then(
      (result) => latest.current.onRestored(result),
      (error: unknown) => {
        if (!alive.current) return
        setBusy(false)
        if (error instanceof LegalEntityApiError) {
          if (error.status === 403) {
            setFailure({ kind: 'lost' })
            latest.current.onLost()
            return
          }
          if (error.status === 429) {
            setFailure({ kind: 'tooMany', wait: waitText(error.retryAfterSeconds) })
            return
          }
          if (error.status === 409 && error.code === 'version_conflict') {
            if (error.currentVersion !== undefined) setConflictBase(error.currentVersion)
            setFailure({ kind: 'conflict' })
            latest.current.onConflict()
            return
          }
          if (
            error.status === 422 &&
            error.code === 'invalid_legal_entity' &&
            error.problems !== undefined &&
            error.problems.length > 0
          ) {
            setFailure({ kind: 'refused', list: valueNameList(refusedFields(error.problems)) })
            return
          }
        }
        setFailure({ kind: 'failed' })
      },
    )
  }, [version, base])

  const confirm = () => {
    if (loading || busy || loadFailed) return
    restore()
  }

  // Reading: the two versions are not both in hand (first read, or after a 409 whose re-read failed). No Confirm.
  if (compared === null || loadFailed) {
    return (
      <Dialog
        title={t.restore.title(version)}
        size="sm"
        onClose={onCancel}
        closeLabel={strings.common.actions.cancel}
        describedBy={readingId}
        initialFocusRef={cancelRef}
        fallbackFocusRef={cancelRef}
        testIdPrefix="admin-legal-restore"
      >
        <div id={readingId} className="dialog-body" data-testid="admin-legal-restore-reading">
          <p className="m-0">{t.restore.body(version, base + 1, base)}</p>
          {loadFailed ? (
            <Banner
              tone="warning"
              className="mt-3"
              onRetry={() => {
                setAttempt((n) => n + 1)
                // The button that had focus goes with the warning: Cancel is where the person lands.
                cancelRef.current?.focus()
              }}
              retryLabel={strings.common.actions.retry}
              retryTestId="admin-legal-restore-retry"
              data-testid="admin-legal-restore-details-failed"
            >
              {t.restore.detailsFailed(version)}
            </Banner>
          ) : (
            <div className="mt-3">
              <SkeletonListRows rows={2} label={t.restore.loadingDetails(version)} />
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} data-testid="admin-legal-restore-cancel">
            {strings.common.actions.cancel}
          </Button>
        </div>
      </Dialog>
    )
  }

  const error =
    failure !== null && failure.kind !== 'tooMany'
      ? failure.kind === 'refused'
        ? t.restore.refused(version, failure.list ?? '')
        : failure.kind === 'conflict'
          ? t.restore.conflict
          : failure.kind === 'lost'
            ? t.lost.title(name)
            : t.restore.failed(version)
      : null

  return (
    <ConfirmDialog
      tone="primary"
      title={t.restore.title(version)}
      confirmLabel={t.restore.confirm(version)}
      busyLabel={loading ? strings.common.loading : t.restore.busy}
      cancelLabel={strings.common.actions.cancel}
      closeLabel={strings.common.actions.cancel}
      busy={busy || loading}
      error={error}
      onConfirm={confirm}
      onCancel={onCancel}
      testIdPrefix="admin-legal-restore"
    >
      <p className="m-0">{t.restore.body(version, base + 1, base)}</p>
      {changes.length > 0 && (
        <p className="m-0 mt-2" data-testid="admin-legal-restore-changes">
          {t.restore.changes(valueNameList(changes))}
        </p>
      )}
      {protectedChanges.length > 0 && (
        <div className="mt-3" data-testid="admin-legal-restore-protected">
          <p className="m-0">{t.restore.protectedIntro(name)}</p>
          <p className="m-0 mt-2 text-sm text-soft">{t.restore.protectedLegend(base, version)}</p>
          <ProtectedChangeList changes={protectedChanges} testId="admin-legal-restore-protected-list" />
        </div>
      )}
      {failure?.kind === 'tooMany' && (
        <Banner tone="warning" className="mt-3" data-testid="admin-legal-restore-too-many">
          {failure.wait === undefined ? t.restore.tooManyNoWait : t.restore.tooMany(failure.wait)}
        </Banner>
      )}
    </ConfirmDialog>
  )
}
