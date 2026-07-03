/**
 * useImportOffer — encapsulates the logic for the one-time legacy localStorage
 * import offer (US-5, AC-5.1, AC-5.2, AC-5.3, AC-5.4).
 *
 * Responsibilities:
 *   • Detect legacy `estimai_project_*` keys via projects.ts `loadProjects()`.
 *   • Check (and set) the session-scoped dismissal flag in sessionStorage.
 *   • Drive the 3-phase modal (offer → importing → results) through local state.
 *   • Call `estimatesApi.importEstimates` with the fully-assembled payloads.
 *   • Trigger a list refresh (`onListRefresh`) after the import resolves.
 *   • NEVER delete any localStorage key (AC-5.3, AC-5.4).
 *
 * The hook exposes a minimal surface area; the modal component receives only
 * what it needs to render.
 *
 * Note: initial state is derived eagerly (lazy useState initializers) to avoid
 * calling setState synchronously inside a useEffect, which triggers cascading
 * renders and violates the react-hooks/set-state-in-effect lint rule.
 */

import { useCallback, useState } from 'react'
import { loadProject, loadProjects } from '../lib/projects'
import * as estimatesApi from '../lib/estimatesApi'
import type { EstimateImportResult } from '../lib/estimatesApi'
import type { ProjectMeta } from '../types'
import type { ImportPhase } from '../components/ImportOfferModal'

/** sessionStorage key used to remember "offer dismissed this session" (AC-5.3). */
export const OFFER_DISMISSED_KEY = 'import_offer_dismissed'

/**
 * Determine the initial offer state synchronously on first render.
 * Called once via lazy useState initializer — safe to read sessionStorage and
 * localStorage here because this executes before the first paint, not inside
 * an effect.
 */
const computeInitialOffer = (): { show: boolean; projects: ProjectMeta[] } => {
  // If the user already dismissed the offer this session, skip (AC-5.3).
  if (sessionStorage.getItem(OFFER_DISMISSED_KEY)) {
    return { show: false, projects: [] }
  }
  const projects = loadProjects()
  return { show: projects.length > 0, projects }
}

export type UseImportOfferReturn = {
  /** Whether the ImportOfferModal should be rendered. */
  showOffer: boolean
  /** Local ProjectMeta list (populated when showOffer is true). */
  localEstimates: ProjectMeta[]
  /** Current phase of the import flow. */
  phase: ImportPhase
  /** Per-estimate results (non-null only after the API call returns). */
  results: EstimateImportResult[] | null
  /** Accept handler — assembles payload, calls the API, shows results. */
  handleAccept: () => Promise<void>
  /** Decline handler — sets the session flag, hides the modal. */
  handleDecline: () => void
  /** Close handler (results phase) — hides the modal. */
  handleClose: () => void
}

/**
 * @param onListRefresh — callback the hook calls after a successful (or
 *   partial) import to trigger a re-fetch of the estimates list (AC-5.2).
 */
export const useImportOffer = (onListRefresh: () => void): UseImportOfferReturn => {
  // Lazy initializer: reads localStorage and sessionStorage once on mount,
  // no effect needed, no cascading render.
  const [{ show: showOffer, projects: localEstimates }, setOfferState] = useState(
    computeInitialOffer,
  )
  const [phase, setPhase] = useState<ImportPhase>('offer')
  const [results, setResults] = useState<EstimateImportResult[] | null>(null)

  const handleDecline = useCallback(() => {
    // Remember the dismissal for the rest of the session (AC-5.3).
    sessionStorage.setItem(OFFER_DISMISSED_KEY, '1')
    setOfferState({ show: false, projects: [] })
  }, [])

  const handleAccept = useCallback(async () => {
    setPhase('importing')

    // Build the import payload: for each local project, load its full data.
    const items = localEstimates.flatMap((meta) => {
      const data = loadProject(meta.id)
      if (!data) return []
      return [
        {
          localId: meta.id,
          name: data.name || 'Untitled',
          author: data.author || '',
          content: {
            params: data.params,
            releases: data.releases,
            acts: data.acts,
          },
        },
      ]
    })

    try {
      const { results: importResults } = await estimatesApi.importEstimates(items)
      setResults(importResults)
      setPhase('results')
      // Refresh the list so imported estimates appear (AC-5.2).
      onListRefresh()
    } catch {
      // If the whole request fails (network / 400 / 401), show an empty results
      // set so the user sees the modal close path rather than a frozen spinner.
      // Individual per-element failures are returned as status:"failed" inside
      // the 200 response body (handled by the results table), not as throws.
      setResults([])
      setPhase('results')
    }
  }, [localEstimates, onListRefresh])

  const handleClose = useCallback(() => {
    setOfferState({ show: false, projects: [] })
  }, [])

  return {
    showOffer,
    localEstimates,
    phase,
    results,
    handleAccept,
    handleDecline,
    handleClose,
  }
}
