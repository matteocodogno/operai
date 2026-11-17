/**
 * ConflictBanner — "a newer version was saved" above the entity form's save bar (T38, specs/20261117-legal-entities,
 * design S2 "Conflict behaviour", owner decision Q3=B; AC-2.6, 8.1).
 *
 * An assertive warning (the library `Banner`, `role="alert"`): who saved which version and when, which values they
 * changed since the version the person loaded, and the two ways forward — **Reapply my changes to version n**
 * (primary) and **Discard my changes and load version n**. The typed values are still in the form; Save waits.
 *
 * While the newer version is being read the banner says so and offers nothing; if it cannot be read it says that
 * and offers Retry (the person's values and Save's wait are unchanged). The wording is all in `strings`.
 */
import type { Ref } from 'react'
import { Banner, Button, formatDateTime } from '@operai/ui'
import { valueNameList } from '../lib/legalEntityMappings'
import type { LegalEntityField, LegalEntityVersion } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

/** What the form knows about the newer version. */
export type ConflictRead =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; version: LegalEntityVersion; changed: LegalEntityField[] }

export type ConflictBannerProps = {
  read: ConflictRead
  onReapply: () => void
  onDiscard: () => void
  onRetry: () => void
  /** The primary action, for a focus the form moves there. */
  reapplyRef?: Ref<HTMLButtonElement>
}

export default function ConflictBanner({ read, onReapply, onDiscard, onRetry, reapplyRef }: ConflictBannerProps) {
  if (read.kind !== 'ready') {
    return (
      <Banner
        tone="warning"
        title={t.conflict.title}
        onRetry={read.kind === 'failed' ? onRetry : undefined}
        retryLabel={strings.common.actions.retry}
        data-testid="admin-legal-conflict"
      >
        {read.kind === 'failed' ? t.load.failed : t.sections.loading}
      </Banner>
    )
  }

  const { version, changed } = read
  return (
    <Banner
      tone="warning"
      title={t.conflict.title}
      actions={
        <>
          <Button
            type="button"
            variant="primary"
            size="sm"
            ref={reapplyRef}
            onClick={onReapply}
            data-testid="admin-legal-reapply"
          >
            {t.conflict.reapply(version.version)}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onDiscard} data-testid="admin-legal-discard">
            {t.conflict.discard(version.version)}
          </Button>
        </>
      }
      data-testid="admin-legal-conflict"
    >
      {t.conflict.body(
        version.createdBy?.name ?? t.history.system,
        version.version,
        formatDateTime(version.createdAt),
        valueNameList(changed),
      )}
    </Banner>
  )
}
