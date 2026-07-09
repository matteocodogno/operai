import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Activity, Parameters, Release, ReleaseSummary, Totals } from '../types'
import { deriveOP, useEstimator } from '../hooks/useEstimator'
import { DEF_PARAMS, uid } from '../lib/projects'
import * as estimatesApi from '../lib/estimatesApi'
import type { EstimateContent } from '../lib/estimatesApi'
import type { Template } from '../lib/templates'

/** Debounce delay for auto-save (ms) */
const AUTOSAVE_DEBOUNCE_MS = 1500

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

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
}

const EstimatorContext = createContext<EstimatorContextValue | null>(null)

type Props = {
  estimateId: string
  initialName?: string
  initialAuthor?: string
  initialParams?: Parameters
  initialReleases?: Release[]
  initialActs?: Activity[]
  children: React.ReactNode
}

export function EstimatorProvider({
  estimateId,
  initialName,
  initialAuthor,
  initialParams,
  initialReleases,
  initialActs,
  children,
}: Props) {
  const [name, setName] = useState(initialName ?? '')
  const [author, setAuthor] = useState(initialAuthor ?? '')
  const [params, setParams] = useState<Parameters>(initialParams ?? { ...DEF_PARAMS })
  const [releases, setRels] = useState<Release[]>(initialReleases ?? [])
  const [acts, setActs] = useState<Activity[]>(initialActs ?? [])
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * Track whether this is the initial mount (skip auto-save on first render)
   * and the debounce timer handle.
   */
  const isFirstRender = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** Cleared-status timer: hides "Saved" indicator after 2 s */
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const clearSaveError = useCallback(() => setSaveError(null), [])

  // Auto-save: debounced PUT to the API whenever state changes
  useEffect(() => {
    // Skip the very first render — we don't want to PUT immediately on mount
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const content: EstimateContent = { params, releases, acts }
      setSaveStatus('saving')

      estimatesApi
        .update(estimateId, { name, author, content })
        .then(() => {
          setSaveStatus('saved')
          setSaveError(null)
          clearTimeout(savedTimer.current)
          savedTimer.current = setTimeout(() => setSaveStatus('idle'), 2000)
        })
        .catch((err: unknown) => {
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
  }, [estimateId, name, author, params, releases, acts])

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
    ],
  )

  return <EstimatorContext.Provider value={value}>{children}</EstimatorContext.Provider>
}

export function useEstimatorContext(): EstimatorContextValue {
  const ctx = useContext(EstimatorContext)
  if (!ctx) throw new Error('useEstimatorContext must be used within EstimatorProvider')
  return ctx
}
