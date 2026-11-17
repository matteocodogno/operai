/**
 * LegalEntityPanel — one entity's panel inside its tab (T36, specs/20261117-legal-entities, design S1–S4; the
 * `LegalEntityPanel` of the component inventory: "one host for the four states of one record").
 *
 * From the top: the entity header (h3 = the entity's name, the status badge, the Read-only mark, and the version
 * line "Version n · saved by X · date"), the view tabs (Details | History, tablist "Views of {entity}"), then the
 * banner slot and the body of the selected view.
 *
 *   - Details of an entity the person may change: the FORM (T37 mounts `LegalEntityForm` at `DetailsBody`). Until it
 *     does the values are shown as facts. The form is a controlled view of the page's per-entity draft
 *     (`draft` / `onDraftChange`), so what is typed survives a switch of entity, of view or of version.
 *   - Details of an entity the person may NOT change (S4), and of one not moved yet: values as facts, no input, no
 *     disabled control; a persistent info Banner says why (live="off": read in place, not announced on arrival).
 *   - Incomplete / Needs correction (S3): a persistent warning Banner listing what is missing and what is out of
 *     rule, in words, above the values.
 *   - History: T39 mounts `LegalEntityHistory` and `LegalEntityVersionView` at `HistoryBody`; `version` is the open
 *     version of the URL (`&version=n`) and `onVersionChange` pushes/clears it. A not-moved entity has nothing to list.
 *
 * What the host (LegalEntitiesPage) owns and this panel only calls: the URL (`onViewChange`, `onVersionChange`), the
 * drafts (`onDraftChange`), the entity as last read (`onEntityChange`, after a save or a restore) and the loss of the
 * grant (`onLost`, a 403: the page turns the entity read-only and drops its draft).
 *
 * Heading outline: the page's h2, this panel's h3, the cards' h4.
 */
import { useEffect, useRef, useState } from 'react'
import { Banner, StatePanel, Tabs, formatDateTime, tabPanelProps } from '@operai/ui'
import { EntityReadOnlyBadge, EntityStatusBadge } from './LegalEntityPanelBadges'
import LegalEntityFacts from './LegalEntityFacts'
import { getVersion } from '../lib/legalEntitiesApi'
import { valueNameList } from '../lib/legalEntityMappings'
import type { LegalEntity, LegalEntityDetails, LegalEntityField } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

export type LegalEntityView = 'details' | 'history'

export type LegalEntityPanelProps = {
  entity: LegalEntity
  /** May this person change the entity (and has the grant not been lost since)? False: read-only. */
  canChange: boolean
  view: LegalEntityView
  /** The open version of the History view (`&version=n`), when there is one. */
  version: number | undefined
  /** The page's unsaved draft of this entity, when there is one. */
  draft: LegalEntityDetails | undefined
  /** Selecting a view replaces the history entry. */
  onViewChange: (view: LegalEntityView) => void
  /** Opening or closing a version pushes an entry (Back returns from the version to the list). */
  onVersionChange: (version: number | undefined) => void
  /** `undefined` drops the draft. */
  onDraftChange: (draft: LegalEntityDetails | undefined) => void
  /** The entity was read again (a save, a restore, a conflict reload). */
  onEntityChange: (entity: LegalEntity) => void
  /** A 403 on a write: the person can no longer change this entity. */
  onLost: () => void
}

const VIEW_PREFIX = 'admin-legal-entity-view'

/** "Version n · saved by X · date", from the current version's own record (the entity answer carries no author). */
function useVersionLine(entity: LegalEntity): string | null {
  const key = `${entity.entity}:${entity.version}`
  const [loaded, setLoaded] = useState<{ key: string; line: string } | null>(null)

  useEffect(() => {
    if (entity.version < 1) return
    let current = true
    getVersion(entity.entity, entity.version).then(
      (v) => {
        if (!current) return
        const when = formatDateTime(v.createdAt)
        const line =
          v.action === 'import'
            ? t.entity.moved(when)
            : t.entity.version(entity.version, v.createdBy?.name ?? t.history.system, when)
        setLoaded({ key, line })
      },
      // The line is a convenience: the panel works without it, and the history says the same.
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [entity.entity, entity.version, key])

  return loaded?.key === key ? loaded.line : null
}

/** The values the registry holds out of rule (E6 `invalid[]`), once each, in the API's order. */
const invalidFields = (entity: LegalEntity): LegalEntityField[] => [...new Set(entity.invalid.map((p) => p.field))]

/** S3: what is missing and what needs correcting, in words. `null` when the entity needs neither. */
function StatusBanner({ entity, name }: { entity: LegalEntity; name: string }) {
  if (entity.version === 0) return null
  const toCorrect = entity.invalid.length > 0 ? t.entity.toCorrect(valueNameList(invalidFields(entity))) : null
  if (!entity.complete) {
    return (
      <Banner tone="warning" live="off" title={t.incomplete.title} data-testid="admin-legal-entity-incomplete">
        {t.incomplete.body(valueNameList(entity.missing), name)}
        {toCorrect !== null && <> {toCorrect}</>}
      </Banner>
    )
  }
  if (toCorrect !== null) {
    return (
      <Banner tone="warning" live="off" title={t.toCorrect.title} data-testid="admin-legal-entity-to-correct">
        {toCorrect}
      </Banner>
    )
  }
  return null
}

type DetailsBodyProps = Pick<LegalEntityPanelProps, 'entity' | 'canChange'>

/**
 * The Details view's body. T37 replaces the `canChange` branch with `LegalEntityForm` (props: the entity, `draft`,
 * `onDraftChange`, `onEntityChange`, `onLost`); the facts stay for everything that is not a form (S4).
 */
function DetailsBody({ entity }: DetailsBodyProps) {
  return (
    <LegalEntityFacts
      details={entity}
      ibanPrint={entity.ibanPrint}
      missing={entity.missing}
      testId="admin-legal-entity-facts"
    />
  )
}

/** T39 replaces this with `LegalEntityHistory` / `LegalEntityVersionView` (`version` and `onVersionChange`). */
function HistoryBody({ entity }: Pick<LegalEntityPanelProps, 'entity' | 'version' | 'onVersionChange'>) {
  if (entity.version === 0) {
    return <StatePanel title={t.history.empty} headingLevel={4} testId="admin-legal-entity-history-empty" />
  }
  return <div data-testid="admin-legal-entity-history-slot" />
}

export default function LegalEntityPanel(props: LegalEntityPanelProps) {
  const { entity, canChange, view, version, onViewChange, onVersionChange } = props
  const name = strings.common.entities[entity.entity]
  const versionLine = useVersionLine(entity)
  const headingRef = useRef<HTMLHeadingElement>(null)

  return (
    <div data-testid={`admin-legal-entity-panel-${entity.entity}`}>
      <div className="mb-3">
        <div className="page-title-row">
          <h3 ref={headingRef} tabIndex={-1} className="page-title" data-testid="admin-legal-entity-heading">
            {name}
          </h3>
          <EntityStatusBadge entity={entity} />
          {!canChange && <EntityReadOnlyBadge />}
        </div>
        {versionLine !== null && (
          <p className="page-description" data-testid="admin-legal-entity-version-line">
            {versionLine}
          </p>
        )}
      </div>

      <Tabs
        label={t.tabs.views(name)}
        tabs={[
          { id: 'details', label: t.views.details },
          { id: 'history', label: t.views.history },
        ]}
        value={view}
        onChange={onViewChange}
        idPrefix={`${VIEW_PREFIX}-${entity.entity}`}
        testId="admin-legal-entity-view-tabs"
      />

      <div {...tabPanelProps(`${VIEW_PREFIX}-${entity.entity}`, view)} className="pt-4">
        {view === 'details' ? (
          <div className="flex flex-col gap-4">
            {!canChange && entity.version > 0 && (
              <Banner tone="info" live="off" data-testid="admin-legal-entity-readonly-note">
                {t.readOnly.note(name)}
              </Banner>
            )}
            {entity.version === 0 && (
              <Banner tone="info" live="off" data-testid="admin-legal-entity-not-moved">
                {t.entity.notMoved}
              </Banner>
            )}
            <StatusBanner entity={entity} name={name} />
            {entity.version > 0 && <DetailsBody entity={entity} canChange={canChange} />}
          </div>
        ) : (
          <HistoryBody entity={entity} version={version} onVersionChange={onVersionChange} />
        )}
      </div>
    </div>
  )
}
