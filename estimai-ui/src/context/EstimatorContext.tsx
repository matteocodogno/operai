import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Activity, Parameters, Release, ReleaseSummary, Totals } from '../types'
import { deriveOP, useEstimator } from '../hooks/useEstimator'
import { DEF_PARAMS, uid } from '../lib/projects'
import * as estimatesApi from '../lib/estimatesApi'
import type { EstimateAccess, EstimateContent, EstimateIdentity } from '../lib/estimatesApi'
import type { Template } from '../lib/templates'

/** Debounce delay for auto-save (ms) */
const AUTOSAVE_DEBOUNCE_MS = 1500

/** Copy for the success toast shown on a completed auto-save. */
export const SAVED_TOAST_MESSAGE = 'Changes stored'

/**
 * `'conflict'` (T16, specs/013-estimate-sharing/tasks.md; plan.md "###
 * Frontend": "on 409/428 enters a conflict state and suspends further
 * autosaves") is the 4th state design.md S4 names for `Header`'s
 * save-status span ("Not saving — reload to continue") — a distinct state
 * from `'error'` because, per design.md, entering conflict deliberately
 * clears any prior `saveError`/`showSavedToast` so the (T18) `ConflictBanner`
 * owns the save-status zone exclusively, never stacking with the ordinary
 * error/success toast.
 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

/**
 * Snapshot of a 409/428 rejection surfaced by `estimatesApi.update` (T15's
 * `ConflictError`), carried in context for T18's `ConflictBanner` to render
 * design.md S4's three copy variants — `status: 409` with a resolved
 * `lastModifiedBy` ("{Name} saved changes…"), `status: 409` with an
 * unresolved one ("Someone else saved changes…"), and `status: 428` (a
 * pre-rollout tab with no prior version to compare against, framed as "This
 * tab needs to reload…"). `currentVersion`/`updatedAt`/`lastModifiedBy` are
 * only ever populated on a real 409 — always `undefined` on 428, mirroring
 * `ConflictError`'s own contract.
 */
export type ConflictInfo = {
  status: 409 | 428
  currentVersion: number | undefined
  updatedAt: string | undefined
  lastModifiedBy: EstimateIdentity | undefined
}

export type EstimatorContextValue = {
  projectId: string
  name: string
  author: string
  params: Parameters
  releases: Release[]
  acts: Activity[]
  summary: ReleaseSummary[]
  totals: Totals
  byProfile: [string, number][]
  setName: (v: string) => void
  setAuthor: (v: string) => void
  updAct: (id: string, f: keyof Activity, v: string) => void
  addAct: (epic?: string) => void
  delAct: (id: string) => void
  reorderActs: (fromIndex: number, toIndex: number) => void
  updRel: (id: string, f: keyof Release, v: string | number) => void
  addRel: () => string
  delRel: (id: string) => void
  updP: (k: keyof Parameters, v: string) => void
  loadTemplate: (t: Template) => void
  saveStatus: SaveStatus
  saveError: string | null
  clearSaveError: () => void
  /** True right after a successful auto-save — drives the "Changes stored" success toast. */
  showSavedToast: boolean
  dismissSavedToast: () => void
  /**
   * The caller's relationship to this estimate (T16, specs/013-estimate-
   * sharing/tasks.md; plan.md "### Frontend"). Fixed for the lifetime of the
   * provider — a change in access level only ever takes effect on the next
   * load (AC-5.1), i.e. a fresh `EstimatorProvider` mount, never a live
   * update mid-session.
   */
  access: EstimateAccess
  /**
   * The single derived "am I allowed to mutate" gate — `access !== 'viewer'`
   * — computed exactly once here (plan risk R5: "one rule, not twelve").
   * Every mutating control downstream (T17) reads *this*, never re-derives
   * its own notion of "am I allowed."
   */
  canEdit: boolean
  /**
   * The last version this session knows to be current — the `If-Match`
   * value the next autosave will send, and the value `estimatesApi.update`
   * adopted from its most recent 2xx response.
   */
  version: number
  /**
   * Non-null while autosave is suspended after a 409/428 (AC-4.1/AC-4.2).
   * `null` in every other state. T18's `ConflictBanner` is the sole
   * consumer; resolving the conflict is always a navigation (route
   * invalidate on "Reload latest", or a new estimate id on "Save as a
   * copy") that remounts `EstimatorProvider` on a fresh key — there is
   * deliberately no in-place "clear conflict" setter here.
   */
  conflict: ConflictInfo | null
  /**
   * The estimate's owner identity (T22, specs/013-estimate-sharing/
   * tasks.md; `EstimateFull.owner`) — `null` when `access === 'owner'`
   * (there is no "owner of your own estimate" to resolve), populated for a
   * collaborator so the toolbar's "Shared by {owner} · {level}" chip (and
   * `CollaboratorsDialog`'s member mode) has a name to render without a
   * fetch of its own. Fixed for the provider's lifetime, same as `access`.
   */
  owner: EstimateIdentity | null
  /**
   * `EstimateFull.collaboratorCount` — present only when `access ===
   * 'owner'` (plan.md), `undefined` otherwise. Drives the toolbar
   * Collaborators button's count badge (T22).
   */
  collaboratorCount: number | undefined
}

const EstimatorContext = createContext<EstimatorContextValue | null>(null)

type Props = {
  estimateId: string
  initialName?: string
  initialAuthor?: string
  initialParams?: Parameters
  initialReleases?: Release[]
  initialActs?: Activity[]
  /**
   * The caller's relationship to this estimate (plan.md "### Frontend").
   * Defaults to `'owner'` — every pre-existing call site (this feature's own
   * `EstimatePage`, and every render in this test file predating T16) never
   * dealt with a non-owner estimate, so an owner default preserves their
   * exact prior full-edit behaviour without every call site having to pass
   * it explicitly.
   */
  initialAccess?: EstimateAccess
  /**
   * The optimistic-concurrency version this session starts from (ADR-0038)
   * — the `If-Match` value the first autosave will send. Defaults to `1`
   * for the same back-compat reason as `initialAccess`: a real load always
   * supplies `EstimateFull.version`.
   */
  initialVersion?: number
  /**
   * `EstimateFull.owner` (T22, specs/013-estimate-sharing/tasks.md).
   * Defaults to `null` — the same back-compat reason as `initialAccess`:
   * every pre-existing call site predating T22 never had an owner identity
   * to pass, and `null` is also the API's own value for an owned estimate.
   */
  initialOwner?: EstimateIdentity | null
  /**
   * `EstimateFull.collaboratorCount` (T22). Defaults to `undefined`, same
   * back-compat reasoning.
   */
  initialCollaboratorCount?: number
  children: React.ReactNode
}

export function EstimatorProvider({
  estimateId,
  initialName,
  initialAuthor,
  initialParams,
  initialReleases,
  initialActs,
  initialAccess,
  initialVersion,
  initialOwner,
  initialCollaboratorCount,
  children,
}: Props) {
  const [name, setName] = useState(initialName ?? '')
  const [author, setAuthor] = useState(initialAuthor ?? '')
  const [params, setParams] = useState<Parameters>(initialParams ?? { ...DEF_PARAMS })
  const [releases, setRels] = useState<Release[]>(initialReleases ?? [])
  const [acts, setActs] = useState<Activity[]>(initialActs ?? [])
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showSavedToast, setShowSavedToast] = useState(false)

  // access is fixed for the provider's lifetime (see the Props doc comment
  // above) — a plain const, not state; nothing in this feature ever changes
  // a session's own access level mid-mount (AC-5.1 is next-load only).
  const access: EstimateAccess = initialAccess ?? 'owner'
  const canEdit = access !== 'viewer'

  // owner/collaboratorCount are likewise fixed for the provider's lifetime
  // (T22, specs/013-estimate-sharing/tasks.md) — plain consts, not state;
  // nothing in this feature changes them mid-mount.
  const owner: EstimateIdentity | null = initialOwner ?? null
  const collaboratorCount: number | undefined = initialCollaboratorCount

  // version is real state (not just a ref) so consumers (T18's badge/banner
  // copy) can react to it; the value the *next* autosave actually sends as
  // If-Match lives in versionRef below, read inside the debounced closure —
  // see that effect's comment for why the ref, not this state, drives the
  // request (putting `version` itself in the effect's dependency array would
  // re-trigger the debounce on every successful save, an autosave-loops-
  // forever bug).
  const [version, setVersion] = useState<number>(initialVersion ?? 1)
  const versionRef = useRef(initialVersion ?? 1)

  // Non-null while autosave is suspended after a 409/428 (AC-4.1/AC-4.2).
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)

  /**
   * Track whether this is the initial mount (skip auto-save on first render)
   * and the debounce timer handle.
   */
  const isFirstRender = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** Cleared-status timer: hides "Saved" indicator after 2 s */
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const clearSaveError = useCallback(() => setSaveError(null), [])
  const dismissSavedToast = useCallback(() => setShowSavedToast(false), [])

  // Auto-save: debounced PUT to the API whenever state changes.
  //
  // T16 (specs/013-estimate-sharing/tasks.md; plan.md "### Frontend";
  // design.md S4/R5) adds two gates on top of T9/T11's original behaviour:
  //
  //   (a) AC-3.1/AC-3.3 — a viewer never autosaves at all. Checked first,
  //       before anything else, so a viewer fires literally zero PUTs even
  //       if some future bug lets state change under them.
  //   (c) AC-4.1/AC-4.2 — once a conflict is detected, autosave is
  //       suspended entirely until the user reloads or saves a copy (T18).
  //       Without this, the very next 1.5 s tick would resubmit the same
  //       stale `If-Match` and 409 again — a retry storm against a server
  //       that will keep refusing it.
  //
  // Both gates are re-checked on every dependency change (not just once),
  // because a viewer/conflict state must block *every* future scheduling
  // attempt, not just the one active when it was entered.
  useEffect(() => {
    // Skip the very first render — we don't want to PUT immediately on mount
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    if (!canEdit || conflict) {
      return
    }

    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const content: EstimateContent = { params, releases, acts }
      setSaveStatus('saving')

      estimatesApi
        .update(estimateId, { name, author, content }, versionRef.current)
        .then(updated => {
          // (b) AC-3.2/ADR-0038: adopt the server's new version so the
          // *next* autosave's If-Match is correct.
          versionRef.current = updated.version
          setVersion(updated.version)
          setSaveStatus('saved')
          setSaveError(null)
          setShowSavedToast(true)
          clearTimeout(savedTimer.current)
          savedTimer.current = setTimeout(() => setSaveStatus('idle'), 2000)
        })
        .catch((err: unknown) => {
          // ConflictError extends ApiError, so it must be distinguished
          // FIRST — otherwise it would silently fall into the generic
          // ApiError branch below and never suspend autosave.
          if (err instanceof estimatesApi.ConflictError) {
            // (c) AC-4.1/AC-4.2: refused, nothing overwritten. name/author/
            // params/releases/acts are deliberately left untouched here —
            // only save-status/conflict bookkeeping changes, so the user's
            // in-progress edits stay visible until they choose to reload.
            // Entering conflict clears any prior saveError/showSavedToast
            // (design.md S4) — the (T18) ConflictBanner owns this zone
            // exclusively from here, it never stacks with the ordinary
            // save toast.
            setSaveStatus('conflict')
            setSaveError(null)
            setShowSavedToast(false)
            setConflict({
              status: err.status === 428 ? 428 : 409,
              currentVersion: err.currentVersion,
              updatedAt: err.updatedAt,
              lastModifiedBy: err.lastModifiedBy,
            })
            return
          }

          // AC-1.3 / AC-1.4: on failure, keep in-memory state untouched and
          // surface an error. The catch here never mutates name/author/params/
          // releases/acts — only the save indicator and error message change.
          setSaveStatus('error')
          if (err instanceof estimatesApi.ApiError) {
            if (err.status === 413) {
              // AC-1.4: size-limit rejection — surface a clear, specific message
              // distinct from generic network/save failures. Prefer the server's
              // Problem detail (e.g. "Estimate content is 2.3 MB; the maximum is
              // 1.0 MB. Nothing was saved.") when available; it already names the
              // sizes. Fall back to a fixed message if the detail is absent.
              setSaveError(
                err.detail ??
                  'This estimate is too large to save. Remove some activities to reduce its size.',
              )
            } else {
              // Non-413: generic save failure — show the server detail if present
              // (e.g. a 500 with an operator-facing message), otherwise fall back
              // to a status-code message. Either way, no size-limit phrasing.
              setSaveError(
                err.detail ??
                  `Save failed (${String(err.status)}). Your work is safe in this tab.`,
              )
            }
          } else {
            setSaveError('Save failed. Check your connection. Your work is safe in this tab.')
          }
        })
    }, AUTOSAVE_DEBOUNCE_MS)

    return () => clearTimeout(saveTimer.current)
  }, [estimateId, name, author, params, releases, acts, canEdit, conflict])

  const rnames = useMemo(() => releases.map(r => r.name), [releases])
  const { summary, totals, byProfile } = useEstimator(acts, releases, params)

  const updAct = useCallback(
    (id: string, f: keyof Activity, v: string) =>
      setActs(prev =>
        prev.map(a => {
          if (a.id !== id) return a
          const u = { ...a, [f]: v }
          if (f === 'ml') {
            const d = deriveOP(Number(v))
            u.o = d.o
            u.p = d.p
          }
          return u
        }),
      ),
    [],
  )

  const addAct = useCallback(
    (epic?: string) =>
      setActs(prev => {
        const last = prev[prev.length - 1]
        return [
          ...prev,
          {
            id: uid(),
            num: '',
            epic: epic ?? last?.epic ?? '',
            act: 'New activity',
            prof: last?.prof ?? 'Developer',
            o: 3.75,
            ml: 5,
            p: 8,
            risk: 0,
            notes: '',
            release: last?.release ?? rnames[0] ?? 'Release 1',
          },
        ]
      }),
    [rnames],
  )

  const delAct = useCallback((id: string) => setActs(prev => prev.filter(a => a.id !== id)), [])

  const reorderActs = useCallback(
    (fromIndex: number, toIndex: number) =>
      setActs(prev => {
        const next = [...prev]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return next
      }),
    [],
  )

  const updRel = useCallback(
    (id: string, f: keyof Release, v: string | number) => {
      // Activities link to a release by name, so a rename must cascade to
      // every activity pointing at the old name or they become orphaned.
      if (f === 'name') {
        const oldName = releases.find(r => r.id === id)?.name
        const newName = String(v)
        if (oldName !== undefined && oldName !== newName) {
          setActs(prev =>
            prev.map(a => (a.release === oldName ? { ...a, release: newName } : a)),
          )
        }
      }
      setRels(prev => prev.map(r => (r.id === id ? { ...r, [f]: v } : r)))
    },
    [releases],
  )

  const addRel = useCallback((): string => {
    const newName = `Release ${releases.length + 1}`
    setRels(prev => [...prev, { id: uid(), name: newName, fte: 1 }])
    return newName
  }, [releases])

  const delRel = useCallback(
    (id: string) => setRels(prev => prev.filter(r => r.id !== id)),
    [],
  )

  const updP = useCallback(
    (k: keyof Parameters, v: string) =>
      setParams(prev => ({ ...prev, [k]: parseFloat(v) || 0 })),
    [],
  )

  const loadTemplate = useCallback((t: Template) => {
    const newReleases: Release[] = t.releases.map(r => ({ ...r, id: uid() }))
    const newActs: Activity[] = t.activities.map(a => ({ ...a, id: uid(), num: '' }))
    setRels(newReleases)
    setActs(newActs)
  }, [])

  const value = useMemo<EstimatorContextValue>(
    () => ({
      projectId: estimateId,
      name,
      author,
      params,
      releases,
      acts,
      summary,
      totals,
      byProfile,
      setName,
      setAuthor,
      updAct,
      addAct,
      delAct,
      reorderActs,
      updRel,
      addRel,
      delRel,
      updP,
      loadTemplate,
      saveStatus,
      saveError,
      clearSaveError,
      showSavedToast,
      dismissSavedToast,
      access,
      canEdit,
      version,
      conflict,
      owner,
      collaboratorCount,
    }),
    [
      estimateId,
      name,
      author,
      params,
      releases,
      acts,
      summary,
      totals,
      byProfile,
      updAct,
      addAct,
      delAct,
      reorderActs,
      updRel,
      addRel,
      delRel,
      updP,
      loadTemplate,
      saveStatus,
      saveError,
      clearSaveError,
      showSavedToast,
      dismissSavedToast,
      access,
      canEdit,
      version,
      conflict,
      owner,
      collaboratorCount,
    ],
  )

  return <EstimatorContext.Provider value={value}>{children}</EstimatorContext.Provider>
}

export function useEstimatorContext(): EstimatorContextValue {
  const ctx = useContext(EstimatorContext)
  if (!ctx) throw new Error('useEstimatorContext must be used within EstimatorProvider')
  return ctx
}
