/**
 * The marks of a legal entity (T36, design S1): the status badge, the Read-only mark and the Unsaved mark. Each is
 * a glyph plus words (never colour or a glyph alone), and each is rendered both on the entity's tab and in its panel
 * header, so the two never say different things. The status itself comes from `legalEntityStatus()`, the one
 * mapping (it is rendered with `Badge` + `Icon`, not the library's `StatusBadge`: the four statuses are this
 * feature's own words, not the suite's status vocabulary).
 */
import { Badge, Icon } from '@operai/ui'
import { legalEntityStatus } from '../lib/legalEntityMappings'
import type { LegalEntity } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

export function EntityStatusBadge({ entity }: { entity: Pick<LegalEntity, 'version' | 'complete' | 'invalid'> }) {
  const status = legalEntityStatus(entity)
  return (
    <Badge tone={status.tone} glyph={<Icon name={status.icon} size={12} />} data-status={status.kind}>
      {status.label}
    </Badge>
  )
}

export function EntityReadOnlyBadge() {
  return (
    <Badge tone="muted" glyph={<Icon name="lock" size={12} />}>
      {t.status.readOnly}
    </Badge>
  )
}

export function EntityUnsavedBadge() {
  return (
    <Badge tone="accent" glyph={<Icon name="pencil" size={12} />}>
      {t.tab.unsaved}
    </Badge>
  )
}
