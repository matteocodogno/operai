import { useCallback, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { loadProjects, loadProject, createProject, saveProjectData, duplicateProject, deleteProject, importProjectFromJson, uid, DEF_PARAMS } from '../lib/projects'
import { TEMPLATES } from '../lib/templates'
import type { ProjectMeta } from '../types'
import { authClient } from '../lib/authClient'
import UserMenu from '../components/UserMenu'

const getAuthUrl = (): string => import.meta.env.VITE_AUTH_URL as string

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

export default function EstimatesPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [projects, setProjects] = useState<ProjectMeta[]>(() =>
    [...loadProjects()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  )
  const { data: session } = authClient.useSession()
  const sessionUser = session?.user ?? null

  const handleSignOut = useCallback(async () => {
    await authClient.signOut()
    window.location.assign(`${getAuthUrl()}/sign-in`)
  }, [])

  function refresh() {
    setProjects([...loadProjects()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()))
  }

  function handleNew() {
    const id = createProject()
    navigate({ to: '/estimates/$estimateId', params: { estimateId: id } })
  }

  function handleLoadExample() {
    const tpl = TEMPLATES[0] // REST API Backend
    const id = uid()
    saveProjectData({
      id,
      name: tpl.name,
      author: '',
      params: { ...DEF_PARAMS },
      releases: tpl.releases.map(r => ({ ...r, id: uid() })),
      acts: tpl.activities.map(a => ({ ...a, id: uid(), num: '' })),
    })
    navigate({ to: '/estimates/$estimateId', params: { estimateId: id } })
  }

  function handleOpen(id: string) {
    navigate({ to: '/estimates/$estimateId', params: { estimateId: id } })
  }

  function handleDuplicate(id: string) {
    const newId = duplicateProject(id)
    if (newId) navigate({ to: '/estimates/$estimateId', params: { estimateId: newId } })
  }

  function handleExportJson(p: ProjectMeta) {
    const data = loadProject(p.id)
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(p.name || 'estimate').replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleDelete(p: ProjectMeta) {
    if (!confirm(`Delete "${p.name || 'Untitled'}"? This cannot be undone.`)) return
    deleteProject(p.id)
    refresh()
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const id = importProjectFromJson(ev.target?.result as string)
        navigate({ to: '/estimates/$estimateId', params: { estimateId: id } })
      } catch (err) {
        alert((err as Error).message)
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const isEmpty = projects.length === 0

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
        <div className="flex items-center gap-3 h-14">
          <img src="/estimai.svg" alt="EstimAI" className="h-8 w-8 rounded-md shrink-0" />
          <div className="flex-1" />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-muted text-sm py-1 px-2.5 border border-rule hover:text-text transition-colors"
          >
            ↑ Import JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImport}
          />
          <button
            onClick={handleNew}
            className="text-sm py-1 px-3 font-medium text-white bg-acc hover:bg-acc/90 transition-colors"
          >
            + New estimate
          </button>
          {sessionUser && (
            <UserMenu user={sessionUser} onSignOut={handleSignOut} />
          )}
        </div>
      </header>

      {isEmpty ? (
        /* ── Empty state ───────────────────────────────────────────────────── */
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 gap-10">
          {/* Card */}
          <div className="flex flex-col items-center text-center gap-5 max-w-sm w-full">
            {/* Logomark */}
            <img src="/estimai.svg" alt="EstimAI" className="w-16 h-16 rounded-2xl" />

            <div className="flex flex-col gap-2">
              <h1 className="font-disp text-xl font-bold text-text">
                Ready to estimate your first project?
              </h1>
              <p className="text-sm text-muted leading-relaxed">
                EstimAI helps you size software projects using PERT, account for AI productivity gains, and produce a client-ready confidence range — in minutes.
              </p>
            </div>

            {/* CTAs */}
            <div className="flex gap-2.5 w-full">
              <button
                onClick={handleNew}
                className="flex-1 py-2 text-sm font-medium text-white bg-acc hover:bg-acc/90 transition-colors"
              >
                + New estimate
              </button>
              <button
                onClick={handleLoadExample}
                className="flex-1 py-2 text-sm font-medium border border-rule text-text hover:border-acc/50 hover:text-acc transition-colors"
              >
                Load example
              </button>
            </div>
          </div>

          {/* What you get strip */}
          <div className="flex items-center gap-8 text-center">
            {([
              ['📊', 'PERT estimation'],
              ['🤖', 'AI comparison'],
              ['📁', 'Excel & PDF export'],
            ] as const).map(([icon, label]) => (
              <div key={label} className="flex flex-col items-center gap-1.5">
                <span className="text-xl leading-none opacity-60">{icon}</span>
                <span className="text-[11px] text-muted font-mono">{label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* ── List state ────────────────────────────────────────────────────── */
        <>
          <div className="max-w-3xl mx-auto w-full px-5.5 py-8">
            <div className="flex flex-col gap-2">
              {projects.map(p => (
                <div
                  key={p.id}
                  className="flex items-center gap-4 px-4 py-3 rounded-md border border-rule bg-ink-soft hover:border-acc/40 transition-colors"
                >
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleOpen(p.id)}>
                    <div className="text-sm font-medium truncate">{p.name || 'Untitled'}</div>
                    <div className="text-[11px] text-muted font-mono mt-0.5">
                      {p.author ? `${p.author} · ` : ''}{formatDate(p.updatedAt)}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleOpen(p.id)}
                      className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-text hover:border-acc hover:text-acc transition-colors"
                    >
                      Open
                    </button>
                    <button
                      onClick={() => handleDuplicate(p.id)}
                      className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-muted hover:text-text transition-colors"
                      title="Duplicate"
                    >
                      ⧉
                    </button>
                    <button
                      onClick={() => handleExportJson(p)}
                      className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-muted hover:text-text transition-colors"
                      title="Export JSON"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-muted hover:text-red transition-colors"
                      title="Delete"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* FAB — only when list is populated */}
          <button
            onClick={handleNew}
            className="fixed bottom-6 right-6 z-20 w-14 h-14 rounded-full text-white text-2xl flex items-center justify-center bg-[linear-gradient(130deg,var(--color-acc),#3a4cd8)] shadow-[0_4px_20px_rgba(91,106,247,.5)] hover:scale-105 active:scale-95 transition-transform"
            aria-label="New Estimate"
            title="New Estimate"
          >
            +
          </button>
        </>
      )}
    </div>
  )
}
