/**
 * LegalEntityVersionView — one old version of an entity, read-only, inside the History panel (T39,
 * specs/20261117-legal-entities, design S6, flow F9; AC-2.3).
 *
 * `VersionBanner` (info, not announced; its heading, level 4 under the panel's h3, takes focus on arrival: the
 * caller keys this view per version so every opened version refocuses) with the sentence "Saved by {who} on {when}.
 * The current version is {m}.", a "Not current" badge, **Back to history** and, for a person who may change the
 * entity, **Restore this version**; under it the same three cards as the read-only Details (`LegalEntityFacts`).
 *
 * Restore is `aria-disabled`, focusable and described by its reason when the version cannot be restored: the
 * version's own answer says so (`complete: false` or `invalid`: "…{missing and invalid values}…"), or the history's
 * row did (`restorable: false`, E1), whichever comes first; both are the registry's word, none is decided here.
 *
 * States: loading (hidden live "Loading…" + skeleton), the version does not exist (404 `version_not_found`: a panel
 * with Back), failed (Banner + Retry, and Back). This component only reads: the restore flow is the caller's
 * (`onRestore`, which opens `RestoreDialog` with the version it was handed).
 */
import { useEffect, useState } from 'react'
import { Badge, Button, StatePanel, VersionBanner, formatDateTime } from '@operai/ui'
import ErrorBanner from './ErrorBanner'
import LegalEntityFacts from './LegalEntityFacts'
import { blockingFields } from './LegalEntityHistoryModel'
import SkeletonListRows from './SkeletonListRows'
import { LegalEntityApiError, getVersion } from '../lib/legalEntitiesApi'
import { valueNameList } from '../lib/legalEntityMappings'
import type { LegalEntityId, LegalEntityVersion } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

export type LegalEntityVersionViewProps = {
  entity: LegalEntityId
  /** The version to show (`&version=n`). */
  version: number
  /** The version in effect, for the sentence and for "Not current". */
  currentVersion: number
  /** May this person change the entity: Restore is offered only then. */
  canChange: boolean
  /** The history's list item said `restorable: false` for this version (E1). */
  listedBlocked: boolean
  onBack: () => void
  /** Restore this version: the caller opens the dialog (with what was read here). */
  onRestore: (version: LegalEntityVersion) => void
}

type Read =
  | { id: string; status: 'ready'; version: LegalEntityVersion }
  | { id: string; status: 'notFound' }
  | { id: string; status: 'failed' }

export default function LegalEntityVersionView({
  entity,
  version,
  currentVersion,
  canChange,
  listedBlocked,
  onBack,
  onRestore,
}: LegalEntityVersionViewProps) {
  const name = strings.common.entities[entity]
  const [attempt, setAttempt] = useState(0)
  const readId = `${entity}:${version}:${attempt}`
  const [read, setRead] = useState<Read | null>(null)

  useEffect(() => {
    let current = true
    getVersion(entity, version).then(
      (answer) => {
        if (current) setRead({ id: readId, status: 'ready', version: answer })
      },
      (error: unknown) => {
        if (!current) return
        const notFound = error instanceof LegalEntityApiError && error.status === 404
        setRead({ id: readId, status: notFound ? 'notFound' : 'failed' })
      },
    )
    return () => {
      current = false
    }
  }, [entity, version, readId])

  const answer = read?.id === readId ? read : null
  const back = (
    <Button variant="secondary" size="sm" onClick={onBack} data-testid="admin-legal-version-back">
      {t.version.back}
    </Button>
  )

  if (answer === null) return <SkeletonListRows rows={3} />

  if (answer.status === 'notFound') {
    return (
      <StatePanel title={t.version.notFound} headingLevel={4} action={back} testId="admin-legal-version-not-found" />
    )
  }

  if (answer.status === 'failed') {
    return (
      <div className="flex flex-col items-start gap-3">
        <ErrorBanner message={t.version.failed} onRetry={() => setAttempt((n) => n + 1)} />
        {back}
      </div>
    )
  }

  const shown = answer.version
  const isCurrent = shown.version === currentVersion
  const blocking = blockingFields(shown)
  const blocked = blocking.length > 0 || listedBlocked
  const reason = blocking.length > 0 ? t.version.blocked(valueNameList(blocking), name) : t.history.restoreBlocked

  return (
    <div className="flex flex-col gap-4" data-testid="admin-legal-version-view">
      <VersionBanner
        title={t.version.title(shown.version)}
        headingLevel={4}
        badge={isCurrent ? undefined : <Badge tone="muted">{t.version.notCurrent}</Badge>}
        backLabel={t.version.back}
        onBack={onBack}
        restoreLabel={canChange && !isCurrent ? t.version.restore : undefined}
        onRestore={canChange && !isCurrent ? () => onRestore(shown) : undefined}
        restoreBlockedReason={blocked ? reason : undefined}
        testId="admin-legal-version-banner"
      >
        {t.version.body(shown.createdBy?.name ?? t.history.system, formatDateTime(shown.createdAt), currentVersion)}
      </VersionBanner>
      <LegalEntityFacts
        details={shown}
        ibanPrint={shown.ibanPrint}
        missing={shown.missing}
        testId="admin-legal-version-facts"
      />
    </div>
  )
}
