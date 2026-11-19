import { useState } from 'react'
import { Field, VisuallyHidden } from '@operai/ui'
import { useEntity } from '../hooks/useEntity'
import { isEntityId } from '../lib/meApi'
import { strings } from '../strings'

/**
 * EntitySwitch — the one labelled native `<select>` "Entity", in each page header's `actions` slot (design UX-2, AS2,
 * AC-8.2). Shown only when `/v1/me` lists two or more entities; with one there is nothing to switch.
 *
 * The choice is written to `?entity=` with `replace` (the frame does it, `selectEntity`). A native select keeps the platform's
 * keyboard contract; focus stays on it, and one polite status says "Showing WellD Italia". The cards below are keyed by entity, so
 * a screen reader that was reading rows of one entity is not left in a list that changed under it. On Windows and Firefox each
 * arrow key on a closed select fires `change` at once; each is a cheap replace, and a late answer of an earlier entity is dropped
 * because the cards are keyed (AS2), so there is no extra guard.
 */
export default function EntitySwitch() {
  const { entities, entity, selectEntity } = useEntity()
  // Nothing is announced until the person changes it: the status is for the change, not for arriving on the page.
  const [announced, setAnnounced] = useState<string | null>(null)

  if (entities.length < 2) return null

  return (
    <div data-testid="accounting-entity-switch">
      <Field label={strings.entity.label}>
        {(control) => (
          <select
            {...control}
            value={entity.entity}
            onChange={(event) => {
              const next = event.target.value
              if (!isEntityId(next)) return
              setAnnounced(strings.entity.showing(strings.entity[next]))
              selectEntity(next)
            }}
            data-testid="accounting-entity-select"
          >
            {entities.map((option) => (
              <option key={option.entity} value={option.entity}>
                {strings.entity[option.entity]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <VisuallyHidden live role="status">
        {announced}
      </VisuallyHidden>
    </div>
  )
}
