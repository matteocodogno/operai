import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Activity, Parameters, Release, ReleaseSummary, Totals } from '../types'
import { deriveOP, useEstimator } from '../hooks/useEstimator'
import { DEF_PARAMS, loadProject, saveProjectData, uid } from '../lib/projects'
import type { Template } from '../lib/templates'

export interface EstimatorContextValue {
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
  addAct: () => void
  delAct: (id: string) => void
  reorderActs: (fromIndex: number, toIndex: number) => void
  updRel: (id: string, f: keyof Release, v: string | number) => void
  addRel: () => string
  delRel: (id: string) => void
  updP: (k: keyof Parameters, v: string) => void
  loadTemplate: (t: Template) => void
  saveStatus: 'idle' | 'saved'
}

const EstimatorContext = createContext<EstimatorContextValue | null>(null)

interface Props {
  estimateId: string
  children: React.ReactNode
}

export function EstimatorProvider({ estimateId, children }: Props) {
  const stored = loadProject(estimateId)

  const [name, setName] = useState(stored?.name ?? '')
  const [author, setAuthor] = useState(stored?.author ?? '')
  const [params, setParams] = useState<Parameters>(stored?.params ?? { ...DEF_PARAMS })
  const [releases, setRels] = useState<Release[]>(stored?.releases ?? [])
  const [acts, setActs] = useState<Activity[]>(stored?.acts ?? [])
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')
  const isFirstSave = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Auto-save on every change
  useEffect(() => {
    saveProjectData({ id: estimateId, name, author, params, releases, acts })
    if (isFirstSave.current) { isFirstSave.current = false; return }
    setSaveStatus('saved')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => setSaveStatus('idle'), 2000)
  }, [estimateId, name, author, params, releases, acts])

  const rnames = useMemo(() => releases.map(r => r.name), [releases])
  const { summary, totals, byProfile } = useEstimator(acts, releases, params)

  const updAct = useCallback((id: string, f: keyof Activity, v: string) =>
    setActs(prev => prev.map(a => {
      if (a.id !== id) return a
      const u = { ...a, [f]: v }
      if (f === 'ml') {
        const d = deriveOP(Number(v))
        u.o = d.o
        u.p = d.p
      }
      return u
    })), [])

  const addAct = useCallback(() =>
    setActs(prev => {
      const last = prev[prev.length - 1]
      return [...prev, {
        id: uid(),
        num: '',
        epic: last?.epic ?? '',
        act: 'New activity',
        prof: last?.prof ?? 'Developer',
        o: 3.75,
        ml: 5,
        p: 8,
        risk: 0,
        notes: '',
        release: last?.release ?? rnames[0] ?? 'Release 1',
      }]
    }), [rnames])

  const delAct = useCallback((id: string) =>
    setActs(prev => prev.filter(a => a.id !== id)), [])

  const reorderActs = useCallback((fromIndex: number, toIndex: number) =>
    setActs(prev => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    }), [])

  const updRel = useCallback((id: string, f: keyof Release, v: string | number) =>
    setRels(prev => prev.map(r => r.id === id ? { ...r, [f]: v } : r)), [])

  const addRel = useCallback((): string => {
    const newName = `Release ${releases.length + 1}`
    setRels(prev => [...prev, { id: uid(), name: newName, fte: 1 }])
    return newName
  }, [releases])

  const delRel = useCallback((id: string) =>
    setRels(prev => prev.filter(r => r.id !== id)), [])

  const updP = useCallback((k: keyof Parameters, v: string) =>
    setParams(prev => ({ ...prev, [k]: parseFloat(v) || 0 })), [])

  const loadTemplate = useCallback((t: Template) => {
    const newReleases: Release[] = t.releases.map(r => ({ ...r, id: uid() }))
    const newActs: Activity[] = t.activities.map(a => ({ ...a, id: uid(), num: '' }))
    setRels(newReleases)
    setActs(newActs)
  }, [])

  const value = useMemo<EstimatorContextValue>(() => ({
    projectId: estimateId,
    name, author, params, releases, acts,
    summary, totals, byProfile,
    setName, setAuthor,
    updAct, addAct, delAct, reorderActs,
    updRel, addRel, delRel,
    updP, loadTemplate,
    saveStatus,
  }), [estimateId, name, author, params, releases, acts, summary, totals, byProfile,
    updAct, addAct, delAct, reorderActs, updRel, addRel, delRel, updP, loadTemplate, saveStatus])

  return <EstimatorContext.Provider value={value}>{children}</EstimatorContext.Provider>
}

export function useEstimatorContext(): EstimatorContextValue {
  const ctx = useContext(EstimatorContext)
  if (!ctx) throw new Error('useEstimatorContext must be used within EstimatorProvider')
  return ctx
}
