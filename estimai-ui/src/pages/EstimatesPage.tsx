import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { importProjectFromJson, uid, DEF_PARAMS } from '../lib/projects'
import { TEMPLATES } from '../lib/templates'
import type { EstimateListItem } from '../lib/estimatesApi'
import * as estimatesApi from '../lib/estimatesApi'
import { authClient } from '../lib/authClient'
import { clearJwtCache } from '../lib/api'
import UserMenu from '../components/UserMenu'
import SkeletonListRows from '../components/SkeletonListRows'

const getAuthUrl = (): string => import.meta.env.VITE_AUTH_URL as string

const formatDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; items: EstimateListItem[] }
  | { status: 'error'; message: string }

export default function EstimatesPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const { data: session } = authClient.useSession()
  const sessionUser = session?.user ?? null

  // ---------------------------------------------------------------------------
  // Load list from API on mount
  // ---------------------------------------------------------------------------

  const fetchList = useCallback(async () => {
    setListState({ status: 'loading' })
    try {
      const items = await estimatesApi.list()
      // Sort by updatedAt descending (server may already sort; defensive sort here)
      const sorted = [...items].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      setListState({ status: 'loaded', items: sorted })
    } catch {
      setListState({ status: 'error', message: 'Could not load your estimates.' })
    }
  }, [])

  useEffect(() => {
    void fetchList()
  }, [fetchList])

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  const handleSignOut = useCallback(async () => {
    await authClient.signOut()
    clearJwtCache()
    window.location.assign(`${getAuthUrl()}/sign-in`)
  }, [])

  // ---------------------------------------------------------------------------
  // Create / open
  // ---------------------------------------------------------------------------

  const handleNew = useCallback(async () => {
    try {
      const estimate = await estimatesApi.create({
        name: '',
        author: '',
        content: {
          params: { ...DEF_PARAMS },
          releases: [],
          acts: [],
        },
      })
      navigate({ to: '/estimates/$estimateId', params: { estimateId: estimate.id } })
    } catch {
      // Surface a simple alert — create failures are not a primary flow
      alert('Could not create a new estimate. Check your connection and try again.')
    }
  }, [navigate])

  const handleLoadExample = useCallback(async () => {
    const tpl = TEMPLATES[0] // REST API Backend
    try {
      const estimate = await estimatesApi.create({
        name: tpl.name,
        author: '',
        content: {
          params: { ...DEF_PARAMS },
          releases: tpl.releases.map((r) => ({ ...r, id: uid() })),
          acts: tpl.activities.map((a) => ({ ...a, id: uid(), num: '' })),
        },
      })
      navigate({ to: '/estimates/$estimateId', params: { estimateId: estimate.id } })
    } catch {
      alert('Could not load the example estimate. Check your connection and try again.')
    }
  }, [navigate])

  const handleOpen = useCallback(
    (id: string) => {
      navigate({ to: '/estimates/$estimateId', params: { estimateId: id } })
    },
    [navigate],
  )

  // ---------------------------------------------------------------------------
  // Delete (confirm dialog; T10 will replace with ConfirmDeleteModal)
  // ---------------------------------------------------------------------------

  const handleDelete = useCallback(
    async (item: EstimateListItem) => {
      if (!confirm(`Delete "${item.name || 'Untitled'}"? This cannot be undone.`)) return
      try {
        await estimatesApi.remove(item.id)
        void fetchList()
      } catch {
        alert('Delete failed. Try again.')
      }
    },
    [fetchList],
  )

  // ---------------------------------------------------------------------------
  // Import JSON (legacy file-based import; T12 handles the localStorage offer)
  // ---------------------------------------------------------------------------

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = async (ev) => {
        try {
          // Parse locally to validate shape, then POST to the API
          const raw = ev.target?.result as string
          // Validate shape using importProjectFromJson's parsing logic; we don't
          // want to save to localStorage — just extract the parsed data
          const tempId = importProjectFromJson(raw)
          // importProjectFromJson saves to localStorage as a side effect;
          // read that data back so we can POST it to the API
          const stored = localStorage.getItem(`estimai_project_${tempId}`)
          if (!stored) throw new Error('Failed to read imported data.')
          const data = JSON.parse(stored) as {
            name: string
            author: string
            params: import('../types').Parameters
            releases: import('../types').Release[]
            acts: import('../types').Activity[]
          }
          const estimate = await estimatesApi.create({
            name: data.name || 'Imported estimate',
            author: data.author || '',
            content: { params: data.params, releases: data.releases, acts: data.acts },
          })
          navigate({ to: '/estimates/$estimateId', params: { estimateId: estimate.id } })
        } catch (err) {
          alert((err as Error).message)
        }
      }
      reader.readAsText(file)
      e.target.value = ''
    },
    [navigate],
  )

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderListBody = () => {
    if (listState.status === 'loading') {
      return (
        <div className="max-w-3xl mx-auto w-full px-5.5 py-8">
          <p className="sr-only" aria-live="polite">Loading your estimates</p>
          <SkeletonListRows />
        </div>
      )
    }

    if (listState.status === 'error') {
      return (
        <div className="max-w-3xl mx-auto w-full px-5.5 py-8">
          <div
            role="alert"
            className="px-4 py-3 rounded-md border border-org/40 bg-org/10 text-sm text-org flex items-center justify-between gap-4"
          >
            <span>{listState.message} Check your connection and refresh.</span>
            <button
              onClick={() => void fetchList()}
              className="shrink-0 text-xs font-medium border border-org/60 text-org px-2.5 py-1 hover:bg-org/20 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )
    }

    const { items } = listState

    if (items.length === 0) {
      // Existing empty state — reused as-is (AC-2.3)
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 gap-10">
          <div className="flex flex-col items-center text-center gap-5 max-w-sm w-full">
            <img src="/estimai.svg" alt="EstimAI" className="w-16 h-16 rounded-2xl" />

            <div className="flex flex-col gap-2">
              <h1 className="font-disp text-xl font-bold text-text">
                Ready to estimate your first project?
              </h1>
              <p className="text-sm text-muted leading-relaxed">
                EstimAI helps you size software projects using PERT, account for AI productivity gains,
                and produce a client-ready confidence range — in minutes.
              </p>
            </div>

            <div className="flex gap-2.5 w-full">
              <button
                onClick={() => void handleNew()}
                className="flex-1 py-2 text-sm font-medium text-white bg-acc hover:bg-acc/90 transition-colors"
              >
                + New estimate
              </button>
              <button
                onClick={() => void handleLoadExample()}
                className="flex-1 py-2 text-sm font-medium border border-rule text-text hover:border-acc/50 hover:text-acc transition-colors"
              >
                Load example
              </button>
            </div>
          </div>

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
      )
    }

    // Populated list (AC-2.1)
    return (
      <>
        <div className="max-w-3xl mx-auto w-full px-5.5 py-8">
          <p className="sr-only" aria-live="polite">{items.length} estimates loaded</p>
          <div className="flex flex-col gap-2">
            {items.map((p) => (
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
                    onClick={() => void handleDelete(p)}
                    className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-muted hover:text-red transition-colors"
                    title="Delete"
                    aria-label={`Delete "${p.name || 'Untitled'}"`}
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
          onClick={() => void handleNew()}
          className="fixed bottom-6 right-6 z-20 w-14 h-14 rounded-full text-white text-2xl flex items-center justify-center bg-[linear-gradient(130deg,var(--color-acc),#3a4cd8)] shadow-[0_4px_20px_rgba(91,106,247,.5)] hover:scale-105 active:scale-95 transition-transform"
          aria-label="New Estimate"
          title="New Estimate"
        >
          +
        </button>
      </>
    )
  }

  const isEmptyOrList =
    listState.status === 'loaded' && listState.items.length === 0

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
          {!isEmptyOrList && (
            <button
              onClick={() => void handleNew()}
              className="text-sm py-1 px-3 font-medium text-white bg-acc hover:bg-acc/90 transition-colors"
            >
              + New estimate
            </button>
          )}
          {sessionUser && (
            <UserMenu user={sessionUser} onSignOut={handleSignOut} />
          )}
        </div>
      </header>

      {renderListBody()}
    </div>
  )
}
