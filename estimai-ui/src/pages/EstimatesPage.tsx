import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { loadProjects, createProject, duplicateProject, deleteProject } from '../lib/projects'
import type { ProjectMeta } from '../types'

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

export default function EstimatesPage() {
  const navigate = useNavigate()
  // Local state so deletions/duplications re-render the list without a full navigation
  const [projects, setProjects] = useState<ProjectMeta[]>(() =>
    [...loadProjects()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  )

  function refresh() {
    setProjects([...loadProjects()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()))
  }

  function handleNew() {
    const id = createProject()
    navigate({ to: '/estimates/$estimateId', params: { estimateId: id } })
  }

  function handleOpen(id: string) {
    navigate({ to: '/estimates/$estimateId', params: { estimateId: id } })
  }

  function handleDuplicate(id: string) {
    const newId = duplicateProject(id)
    if (newId) navigate({ to: '/estimates/$estimateId', params: { estimateId: newId } })
  }

  function handleDelete(p: ProjectMeta) {
    if (!confirm(`Delete "${p.name || 'Untitled'}"? This cannot be undone.`)) return
    deleteProject(p.id)
    refresh()
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
        <div className="flex items-center gap-4 h-14">
          <span className="font-disp text-xl font-extrabold shrink-0 bg-[linear-gradient(130deg,#8b96ff,#2ec27e)] bg-clip-text text-transparent">
            EstimAI
          </span>
          <div className="flex-1" />
        </div>
      </header>

      {/* List */}
      <div className="max-w-3xl px-5.5 py-8">
        {projects.length === 0 ? (
          <div className="text-center py-16 text-muted text-sm">
            <div className="text-3xl mb-3 opacity-30">📋</div>
            <p>No estimates yet.</p>
            <button onClick={handleNew} className="mt-4 text-acc underline text-sm">
              Create your first estimate
            </button>
          </div>
        ) : (
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
        )}
      </div>
      {/* FAB */}
      <button
        onClick={handleNew}
        className="fixed bottom-6 right-6 z-20 w-14 h-14 rounded-full text-white text-2xl flex items-center justify-center bg-[linear-gradient(130deg,var(--color-acc),#3a4cd8)] shadow-[0_4px_20px_rgba(91,106,247,.5)] hover:scale-105 active:scale-95 transition-transform"
        aria-label="New Estimate"
        title="New Estimate"
      >
        +
      </button>
    </div>
  )
}
