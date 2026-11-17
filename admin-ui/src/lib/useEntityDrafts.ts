/**
 * useEntityDrafts — one unsaved draft per legal entity, held by the page host in memory (T36,
 * specs/20261117-legal-entities, design S1 "Drafts" and flow F3b).
 *
 * The Legal entities page shows one entity at a time behind tabs, and the form of the selected entity unmounts when
 * the person switches entity, switches Details | History or opens a version. What they typed must survive that, so
 * it lives here, above the panel, and the form is a controlled view of it. Nothing is stored: a reload loses it
 * (the leave guard asks first), and a draft is never written to storage because it holds company data.
 *
 * "Unsaved" is a judgement against the entity as last read: a draft that differs from it only by blanks, case in an
 * IBAN or empty address lines is the same as the saved details once normalised (AC-2.1), so it is not an unsaved
 * change and neither marks the tab nor asks anything on leaving.
 *
 * A draft is dropped (`discard`) on a successful save, on "Discard changes", and when its entity turns read-only
 * (403); the page and the form call it, this hook has no opinion about why.
 */
import { useCallback, useMemo, useState } from 'react'
import { LEGAL_ENTITY_IDS, changedFieldsBetween, detailsOf } from './legalEntityModel'
import type { LegalEntityDetails, LegalEntityId } from './legalEntityModel'

export type EntityDrafts = Partial<Record<LegalEntityId, LegalEntityDetails>>

/** The entities whose draft holds a change against `bases`, in the page's fixed order. Pure. */
export const unsavedEntities = (drafts: EntityDrafts, bases: EntityDrafts): LegalEntityId[] =>
  LEGAL_ENTITY_IDS.filter((entity) => {
    const draft = drafts[entity]
    const base = bases[entity]
    return draft !== undefined && base !== undefined && changedFieldsBetween(draft, base).length > 0
  })

export type UseEntityDrafts = {
  /** The draft of an entity exactly as typed, or `undefined` when there is none. */
  draftOf: (entity: LegalEntityId) => LegalEntityDetails | undefined
  /** Replaces the draft of one entity (copied: the caller's object is never shared). */
  setDraft: (entity: LegalEntityId, details: LegalEntityDetails) => void
  /** Drops the draft of one entity. Nothing to drop is not an error. */
  discard: (entity: LegalEntityId) => void
  discardAll: () => void
  /** The entities with an unsaved change, in the fixed page order. */
  unsaved: readonly LegalEntityId[]
  isUnsaved: (entity: LegalEntityId) => boolean
}

/** @param bases the details of each entity as last read from the registry (what "unsaved" is measured against). */
export function useEntityDrafts(bases: EntityDrafts): UseEntityDrafts {
  const [drafts, setDrafts] = useState<EntityDrafts>({})

  const setDraft = useCallback((entity: LegalEntityId, details: LegalEntityDetails) => {
    setDrafts((previous) => ({ ...previous, [entity]: detailsOf(details) }))
  }, [])

  const discard = useCallback((entity: LegalEntityId) => {
    setDrafts((previous) => {
      if (!(entity in previous)) return previous
      const next = { ...previous }
      delete next[entity]
      return next
    })
  }, [])

  const discardAll = useCallback(() => {
    setDrafts((previous) => (Object.keys(previous).length === 0 ? previous : {}))
  }, [])

  const draftOf = useCallback((entity: LegalEntityId) => drafts[entity], [drafts])

  const unsaved = useMemo(() => unsavedEntities(drafts, bases), [drafts, bases])
  const isUnsaved = useCallback((entity: LegalEntityId) => unsaved.includes(entity), [unsaved])

  return { draftOf, setDraft, discard, discardAll, unsaved, isUnsaved }
}
