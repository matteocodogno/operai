/**
 * RestoreDialog — "Restore version n?" (T39, specs/20261117-legal-entities, design S7, flow F10; AC-2.4, AC-2.5).
 *
 * A `ConfirmDialog tone="primary"` that owns the restore call and its four refusals. It says what will happen (a
 * NEW version is made with the details of version n; nothing is rewritten) and which values change compared with
 * the version in effect, so a change to the IBAN is visible before it is made. Both versions' details are read
 * here: the entity the page holds is the current one when it is, otherwise it is fetched; the version to restore is
 * given by the version view, or fetched when the dialog is opened from a row.
 *
 * The dialog does not open until both are read (it renders nothing, and calls `onLoadFailed` if they cannot be read):
 * the person never confirms a restore whose changes they have not been shown, and focus lands on Cancel as in every
 * confirmation. After a 409 the version in effect has changed, so the details are read again behind the open
 * dialog: Confirm is busy ("Loading…") meanwhile, and a read that fails says so and Confirm tries it again.
 *
 * Refusals, inline in the dialog (it stays open; Cancel is the way out):
 *   422 invalid_legal_entity  assertive "Version n cannot be restored: {values}. Nothing changed." (only a race now: the
 *                             history already disables a non-restorable row)
 *   409 version_conflict      "A newer version was saved meanwhile…": the base moves to the answer's `currentVersion`,
 *                             the page reloads the history (`onConflict`) and the next Confirm uses the new base
 *   403                       "You can no longer change {entity}" and `onLost()`: the page turns read-only
 *   404 / 5xx / network       "Version n was not restored. Nothing changed. Try again."
 *
 * On success the dialog calls `onRestored(result)`; the caller closes it (it is unmounted, focus goes where the caller
 * decides: the entity heading).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '@operai/ui'
import { refusedFields, restoreChanges } from './LegalEntityHistoryModel'
import { LegalEntityApiError, getVersion, restoreVersion } from '../lib/legalEntitiesApi'
import type { SaveResult } from '../lib/legalEntitiesApi'
import { valueNameList } from '../lib/legalEntityMappings'
import type { LegalEntity, LegalEntityDetails, LegalEntityVersion } from '../lib/legalEntityModel'
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
  /** The details to compare could not be read, so the dialog never opened. */
  onLoadFailed: () => void
  onCancel: () => void
}

/** What the confirmation shows: the version to restore and the version in effect. */
type Compared = { target: LegalEntityDetails; current: LegalEntityDetails }

type Failure = 'refused' | 'conflict' | 'lost' | 'failed'

export default function RestoreDialog({
  entity,
  version,
  target,
  baseVersion,
  onRestored,
  onConflict,
  onLost,
  onLoadFailed,
  onCancel,
}: RestoreDialogProps) {
  const name = strings.common.entities[entity.entity]
  // A 409 names the version now in effect; the history's own answer may arrive later, and the higher one wins.
  const [conflictBase, setConflictBase] = useState(0)
  const base = Math.max(baseVersion, conflictBase)

  const [attempt, setAttempt] = useState(0)
  const readId = `${entity.entity}:${version}:${base}:${attempt}`
  // `compared` is the last pair read; `read` says whether the read of THIS pair of versions is over, and how.
  const [compared, setCompared] = useState<Compared | null>(null)
  const [read, setRead] = useState<{ id: string; failed: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ kind: Failure; list?: string } | null>(null)

  // The effect reads the latest props without re-running when they are replaced by an equal read.
  const latest = useRef({ entity, target, compared, onRestored, onConflict, onLost, onLoadFailed })
  useEffect(() => {
    latest.current = { entity, target, compared, onRestored, onConflict, onLost, onLoadFailed }
  })

  useEffect(() => {
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
        if (latest.current.compared === null) latest.current.onLoadFailed()
      },
    )
    return () => {
      current = false
    }
  }, [readId, version, base])

  const loading = read?.id !== readId
  const loadFailed = read?.id === readId && read.failed
  const changes = compared === null ? [] : restoreChanges(compared.target, compared.current)

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
    if (loading || busy) return
    // The read of what changes failed: Confirm reads it again, it never restores unseen.
    if (loadFailed) {
      setAttempt((n) => n + 1)
      return
    }
    restore()
  }

  // Nothing is shown until the first read is over (a failed one never opens the dialog: `onLoadFailed`).
  if (compared === null) return null

  const error =
    failure !== null
      ? failure.kind === 'refused'
        ? t.restore.refused(version, failure.list ?? '')
        : failure.kind === 'conflict'
          ? t.restore.conflict
          : failure.kind === 'lost'
            ? t.lost.title(name)
            : t.restore.failed(version)
      : loadFailed
        ? t.restore.failed(version)
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
    </ConfirmDialog>
  )
}
