import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { importProjectFromJson, uid, DEF_PARAMS } from '../lib/projects'
import { TEMPLATES } from '../lib/templates'
import type { EstimateIdentity, EstimateListItem } from '../lib/estimatesApi'
import * as estimatesApi from '../lib/estimatesApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ImportOfferModal from '../components/ImportOfferModal'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import AccessLevelBadge from '../components/AccessLevelBadge'
import { formatIdentity } from '../lib/identity'
import { useImportOffer } from '../hooks/useImportOffer'

/**
 * Defensive fallback for a shared row whose `owner` came back `null` despite
 * `access !== 'owner'` — `EstimateListItem`'s contract (estimatesApi.ts) says
 * `owner` is populated whenever the row isn't the caller's own, but
 * `formatIdentity` must never be handed `null`; routing a contract-violating
 * response through the same "unknown" placeholder keeps AC-10.5's "never
 * blank, never a raw id, never an error" bar even then (T14's `formatIdentity`
 * is the one place that owns this decision — this fallback stays a plain
 * data object, not a second rendering rule).
 */
const UNKNOWN_OWNER: EstimateIdentity = { status: 'unknown', name: null }

/**
 * `formatIdentity` (T14, ../lib/identity.ts) is typed to take a full
 * `Identity` (id + status + name) — its own doc comment claims it "accepts
 * this shape too despite the missing id" for the id-less `EstimateIdentity`
 * embedded on `EstimateListItem.owner`, but the actual TS signature still
 * requires `id`, so a bare `EstimateIdentity` doesn't type-check at this call
 * site. `formatIdentity`'s implementation only ever reads `.status`/`.name`
 * (verified by reading it), so padding in the row's own id as a throwaway,
 * unused `id` is behaviorally inert — a narrow workaround kept local to this
 * file rather than widening `identity.ts`'s exported type, which is outside
 * this task's touch list (T23, specs/013-estimate-sharing/tasks.md). Flagged
 * back to the caller as a real (if small) T14/T23 contract gap.
 */
const ownerIdentityFor = (item: EstimateListItem) => ({
  id: item.id,
  ...(item.owner ?? UNKNOWN_OWNER),
})

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

// ---------------------------------------------------------------------------
// Delete modal state
// ---------------------------------------------------------------------------

type DeleteModalState =
  | { open: false }
  | { open: true; item: EstimateListItem; isDeleting: boolean; error: string | null }

export default function EstimatesPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const [deleteModal, setDeleteModal] = useState<DeleteModalState>({ open: false })

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
  // Import offer (one-time per session when legacy localStorage estimates exist)
  // AC-5.1 / AC-5.2 / AC-5.3 / AC-5.4
  // ---------------------------------------------------------------------------

  const {
    showOffer,
    localEstimates,
    phase: importPhase,
    results: importResults,
    handleAccept: handleImportAccept,
    handleDecline: handleImportDecline,
    handleClose: handleImportClose,
  } = useImportOffer(fetchList)

  // ---------------------------------------------------------------------------
  // Create / open
  // ---------------------------------------------------------------------------

  const handleNew = useCallback(async () => {
    try {
      const estimate = await estimatesApi.create({
        name: 'Untitled',
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
  // Delete — accessible ConfirmDeleteModal (T10, AC-3.1 / AC-3.2)
  // ---------------------------------------------------------------------------

  /** Opens the confirm modal for a row's delete "×" button. */
  const handleDeleteRequest = useCallback((item: EstimateListItem) => {
    setDeleteModal({ open: true, item, isDeleting: false, error: null })
  }, [])

  /** Cancel / Escape: close the modal without any API call (AC-3.2). */
  const handleDeleteCancel = useCallback(() => {
    setDeleteModal({ open: false })
  }, [])

  /** Confirm: call the API, refresh list on success, show inline error on failure. */
  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteModal.open) return
    const { item } = deleteModal
    setDeleteModal({ open: true, item, isDeleting: true, error: null })
    try {
      await estimatesApi.remove(item.id)
      setDeleteModal({ open: false })
      void fetchList()
    } catch {
      setDeleteModal({ open: true, item, isDeleting: false, error: 'Delete failed. Try again.' })
    }
  }, [deleteModal, fetchList])

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
      // Existing empty state — reused as-is, but the condition is now the
      // COMBINED owned+shared list length (AC-2.3): `estimatesApi.list()`
      // already returns both in one array (access-scoped by estimai-api,
      // T6), so a user with only shared estimates never falls through to
      // this branch.
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
                data-testid={p.access === 'owner' ? 'estimate-row-owned' : 'estimate-row-shared'}
                className="flex items-center gap-4 px-4 py-3 rounded-md border border-rule bg-ink-soft hover:border-acc/40 transition-colors"
              >
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleOpen(p.id)}>
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium truncate">{p.name || 'Untitled'}</div>
                    {p.access !== 'owner' && <AccessLevelBadge level={p.access} />}
                  </div>
                  <div className="text-[11px] text-muted font-mono mt-0.5">
                    {p.access === 'owner'
                      ? <>{p.author ? `${p.author} · ` : ''}{formatDate(p.updatedAt)}</>
                      : <><span>{formatIdentity(ownerIdentityFor(p))}</span>{' · '}{formatDate(p.updatedAt)}</>}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleOpen(p.id)}
                    className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-text hover:border-acc hover:text-acc transition-colors"
                  >
                    Open
                  </button>
                  {/* Owner-only action — absent on shared rows, including the orphaned-owner
                      case (AC-10.4/AC-3.3): never rendered-then-disabled. */}
                  {p.access === 'owner' && (
                    <button
                      onClick={() => handleDeleteRequest(p)}
                      className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-muted hover:text-red transition-colors"
                      title="Delete"
                      aria-label={`Delete "${p.name || 'Untitled'}"`}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* No FAB — the header "+ New estimate" is the single, consistent CTA (matches the other screens). */}
      </>
    )
  }

  const isEmptyOrList =
    listState.status === 'loaded' && listState.items.length === 0

  return (
    <div className="min-h-screen flex flex-col">
      {/* Import offer modal (one-time per session, AC-5.1) */}
      {showOffer && (
        <ImportOfferModal
          localEstimates={localEstimates}
          phase={importPhase}
          results={importResults}
          onAccept={() => void handleImportAccept()}
          onDecline={handleImportDecline}
          onClose={handleImportClose}
        />
      )}

      {/* Delete confirm modal (AC-3.1 / AC-3.2) */}
      {deleteModal.open && (
        <ConfirmDeleteModal
          estimateName={deleteModal.item.name}
          isDeleting={deleteModal.isDeleting}
          errorMessage={deleteModal.error}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={handleDeleteCancel}
        />
      )}

      {/* Header */}
      <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
        <div className="flex items-center gap-3 h-14">
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
        </div>
      </header>

      {renderListBody()}
    </div>
  )
}
