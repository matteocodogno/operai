/**
 * CollaboratorsDialog — add/list/change-level/remove collaborators on an
 * estimate (T20, specs/013-estimate-sharing/tasks.md; design.md "## Screens &
 * states → S2 — CollaboratorsDialog, owner mode").
 *
 * Scope (T20, owner mode only — see tasks.md "Scope boundary"): this file
 * implements the OWNER branch in full. Member mode (S3 — "Shared with you by
 * {owner}" + Leave) is T21's second render branch on this same component;
 * until then, a non-owner `access` renders nothing (see the guard at the top
 * of the default export). The toolbar entry that opens this dialog (the
 * "Collaborators (n)" button / "Shared by X" chip) is T22 — out of scope here.
 * This component is self-sufficient: it owns its own collaborator-list fetch,
 * its own add/remove/level-change mutations, and reads the signed-in user's
 * own email via `authClient.useSession()` (the same pattern EstimatorApp.tsx
 * already uses for author backfill) for the client-side self-add short-circuit
 * — there is no parent page wiring it any of that yet.
 *
 * Presentational data source aside, this follows ConfirmDeleteModal.tsx's
 * dialog shell (backdrop, header/body/footer, role="dialog") and
 * admin-ui/InviteUserModal.tsx's a11y pattern (reimplemented locally per
 * ADR-0006's federation boundary — see design.md's "Federation note").
 *
 * Every failure state named by design.md S2 is a distinct, reachable render:
 *   - generic 422 (`CollaboratorNotEligibleError`) — copy is the fixed server
 *     detail via strings.ts, verbatim, never paraphrased (AC-1.2: must not
 *     hint at which of the two collapsed causes applied).
 *   - 409 already-a-collaborator (`AlreadyCollaboratorError`) — names the
 *     EXISTING level, looked up from the already-fetched collaborator list
 *     (falling back to one re-fetch if the target row isn't loaded yet, e.g.
 *     a fast double-submit before the initial GET resolves) and focuses that
 *     row's level <select> (AC-1.3).
 *   - self-add (`CannotShareWithSelfError`) — both the client-side short-
 *     circuit (own email, no request fired) and the server's alias-address
 *     round trip render the same copy (AC-1.4).
 *   - 429 rate-limited (`RateLimitedError`) — the Add button gets a short
 *     client-side cooldown (no live countdown, per design.md).
 *   - 503 auth-unavailable (`AuthorizationServiceUnavailableError`) — a
 *     visibly different message from the generic 422, on purpose.
 *
 * A11y (design.md "## Accessibility → CollaboratorsDialog (S2/S3)"):
 *   - role="dialog" aria-modal="true" aria-labelledby.
 *   - Focus trap: queried LIVE over every currently-enabled focusable element
 *     inside the dialog (`input, button, select`) — the set changes as rows
 *     are added/removed, so a fixed two-button trap (ConfirmDeleteModal's)
 *     would break here; this reuses InviteUserModal's live-query technique.
 *   - Default focus: the email input (owner mode's natural first action).
 *   - Escape closes the dialog UNLESS the nested Remove-confirm layer is
 *     open, in which case Escape (and Tab) are left entirely to that layer —
 *     both this dialog's Escape and Tab handlers short-circuit while
 *     `removeTarget` is set, matching ConfirmDeleteModal's own semantics
 *     rather than fighting its independent trap/Escape listener.
 *   - Every Remove button carries `aria-label="Remove {email}"` (never a bare
 *     "×") — the visible glyph stays "×", the accessible name does not.
 *   - A visually-hidden `aria-live="polite"` region (always mounted, a
 *     sibling of the interactive elements it describes — Bell.tsx's pattern)
 *     announces add/remove/level-change outcomes.
 *   - Inline field errors (generic 422, 409, self, rate-limit, 503) are
 *     `role="alert"` — assertive, matching ToastBanner's error convention.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { authClient } from '../lib/authClient'
import * as collaboratorsApi from '../lib/collaboratorsApi'
import {
  AlreadyCollaboratorError,
  AuthorizationServiceUnavailableError,
  CannotShareWithSelfError,
  CollaboratorNotEligibleError,
  InvalidInputError,
  RateLimitedError,
} from '../lib/collaboratorsApi'
import type { CollaboratorGrant } from '../lib/collaboratorsApi'
import type { EstimateAccess } from '../lib/estimatesApi'
import AccessLevelBadge from './AccessLevelBadge'
import type { AccessLevel } from './AccessLevelBadge'
import ConfirmDeleteModal from './ConfirmDeleteModal'
import SkeletonListRows from './SkeletonListRows'
import { strings } from '../strings'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * No `Retry-After` header, or a non-numeric one, is the common case at this
 * ceiling (20/10min — nobody hits it by accident). Design.md: "Add button
 * stays disabled for a short client-side cool-down (no live countdown)" —
 * this is that cooldown's fallback length when the server doesn't give one.
 * A pragmatic constant, not an AC-specified value; flagged in the T20 report.
 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000

const DIALOG_TITLE_ID = 'collaborators-dialog-title'
const EMAIL_INPUT_ID = 'collaborators-dialog-email'

const levelLabel = (level: AccessLevel): string =>
  level === 'editor' ? strings.sharing.dialog.levelEditor : strings.sharing.dialog.levelViewer

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const findByEmail = (
  email: string,
  collaborators: CollaboratorGrant[],
): CollaboratorGrant | undefined => {
  const target = normalizeEmail(email)
  return collaborators.find((c) => normalizeEmail(c.email) === target)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollaboratorsDialogProps = {
  estimateId: string
  /** The caller's relationship to this estimate — determines dialog mode. */
  access: EstimateAccess
  onClose: () => void
}

type ListStatus = 'loading' | 'error' | 'ready'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CollaboratorsDialog({ estimateId, access, onClose }: CollaboratorsDialogProps) {
  // Member mode (S3) + Leave are T21's second render branch on this same
  // component (specs/013-estimate-sharing/tasks.md T21, deps: T20) — out of
  // this task's scope. Nothing currently renders this dialog for a
  // non-owner (T22, the toolbar wiring, is also not yet built), so this is
  // an inert guard, not a reachable dead-end in the shipped product. Kept as
  // a thin wrapper (rather than an early `return null` inside the owner
  // implementation itself) so every hook below always runs in the same
  // order on every render — an early return before hooks would violate the
  // Rules of Hooks the moment `access` ever changed across a re-render.
  if (access !== 'owner') {
    return null
  }
  return <OwnerCollaboratorsDialog estimateId={estimateId} onClose={onClose} />
}

type OwnerCollaboratorsDialogProps = {
  estimateId: string
  onClose: () => void
}

function OwnerCollaboratorsDialog({ estimateId, onClose }: OwnerCollaboratorsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const rowSelectRefs = useRef(new Map<string, HTMLSelectElement>())
  const isMountedRef = useRef(true)
  useEffect(
    () => () => {
      isMountedRef.current = false
    },
    [],
  )

  const { data: session } = authClient.useSession()
  const sessionEmail = session?.user?.email ?? null

  // ---- collaborator list -----------------------------------------------
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [collaborators, setCollaborators] = useState<CollaboratorGrant[]>([])

  const loadList = useCallback(async () => {
    setListStatus('loading')
    try {
      const data = await collaboratorsApi.list(estimateId)
      if (!isMountedRef.current) return
      setCollaborators(data)
      setListStatus('ready')
    } catch {
      if (!isMountedRef.current) return
      setListStatus('error')
    }
  }, [estimateId])

  useEffect(() => {
    void loadList()
  }, [loadList])

  // ---- add form -----------------------------------------------------------
  const [email, setEmail] = useState('')
  const [addLevel, setAddLevel] = useState<AccessLevel>('viewer')
  const [submitting, setSubmitting] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null)

  useEffect(() => {
    if (rateLimitedUntil === null) return
    const remaining = rateLimitedUntil - Date.now()
    if (remaining <= 0) {
      setRateLimitedUntil(null)
      return
    }
    const timer = setTimeout(() => setRateLimitedUntil(null), remaining)
    return () => clearTimeout(timer)
  }, [rateLimitedUntil])

  const isRateLimited = rateLimitedUntil !== null

  // ---- live-region announcement -------------------------------------------
  const [announcement, setAnnouncement] = useState('')

  // ---- remove flow ----------------------------------------------------------
  const [removeTarget, setRemoveTarget] = useState<CollaboratorGrant | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  // ---- level-change flow ---------------------------------------------------
  const [levelChangingIds, setLevelChangingIds] = useState<ReadonlySet<string>>(new Set())
  const [levelChangeErrors, setLevelChangeErrors] = useState<Record<string, string>>({})

  const focusRow = useCallback((collaboratorId: string) => {
    const el = rowSelectRefs.current.get(collaboratorId)
    if (!el) return
    // jsdom (the test environment) doesn't implement scrollIntoView — guard
    // rather than assume a real browser's full Element API.
    el.scrollIntoView?.({ block: 'center' })
    el.focus()
  }, [])

  const handleAddError = useCallback(
    async (err: unknown, attemptedEmail: string) => {
      if (err instanceof AlreadyCollaboratorError) {
        let existing = findByEmail(attemptedEmail, collaborators)
        if (!existing) {
          // Rare race (double-submit before the initial GET resolved) —
          // one best-effort re-fetch so the message can still name a level.
          try {
            const fresh = await collaboratorsApi.list(estimateId)
            if (isMountedRef.current) setCollaborators(fresh)
            existing = findByEmail(attemptedEmail, fresh)
          } catch {
            // Fall through with existing === undefined — see fallback below.
          }
        }
        setAddError(strings.sharing.errors.alreadyCollaborator(levelLabel(existing?.accessLevel ?? addLevel)))
        if (existing) focusRow(existing.id)
        return
      }
      if (err instanceof CannotShareWithSelfError) {
        setAddError(strings.sharing.errors.cannotShareWithSelf)
        return
      }
      if (err instanceof CollaboratorNotEligibleError) {
        // Verbatim server detail (design.md: "not paraphrased" — AC-1.2's
        // anti-enumeration property). strings.ts already carries this exact
        // sentence, so reading it here IS reading it verbatim.
        setAddError(strings.sharing.errors.notEligible)
        return
      }
      if (err instanceof RateLimitedError) {
        setAddError(strings.sharing.errors.rateLimited)
        const cooldownMs = (err.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS / 1000) * 1000
        setRateLimitedUntil(Date.now() + cooldownMs)
        return
      }
      if (err instanceof AuthorizationServiceUnavailableError) {
        setAddError(strings.sharing.errors.authUnavailable)
        return
      }
      if (err instanceof InvalidInputError) {
        setAddError(strings.sharing.errors.invalidEmail)
        return
      }
      setAddError(strings.sharing.errors.genericAddFailed)
    },
    [collaborators, estimateId, addLevel, focusRow],
  )

  const handleAddSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      const trimmed = email.trim()

      if (!EMAIL_PATTERN.test(trimmed)) {
        setAddError(strings.sharing.errors.invalidEmail)
        return
      }
      // Client-side self-check (design.md: "short-circuits the common case
      // before any request fires") — the server's post-lookup check on the
      // resolved userId still catches an alias address on the round trip.
      if (sessionEmail && normalizeEmail(trimmed) === normalizeEmail(sessionEmail)) {
        setAddError(strings.sharing.errors.cannotShareWithSelf)
        return
      }

      setSubmitting(true)
      setAddError(null)
      try {
        const grant = await collaboratorsApi.add(estimateId, { email: trimmed, accessLevel: addLevel })
        if (!isMountedRef.current) return
        setCollaborators((prev) => [...prev, grant])
        setEmail('')
        setAnnouncement(strings.sharing.dialog.addedAnnouncement(grant.email, levelLabel(grant.accessLevel)))
        emailInputRef.current?.focus()
      } catch (err) {
        if (!isMountedRef.current) return
        await handleAddError(err, trimmed)
      } finally {
        if (isMountedRef.current) setSubmitting(false)
      }
    },
    [email, sessionEmail, estimateId, addLevel, handleAddError],
  )

  const handleConfirmRemove = useCallback(async () => {
    if (!removeTarget) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await collaboratorsApi.remove(estimateId, removeTarget.id)
      if (!isMountedRef.current) return
      setCollaborators((prev) => prev.filter((c) => c.id !== removeTarget.id))
      setAnnouncement(strings.sharing.dialog.removedAnnouncement(removeTarget.email))
      setRemoveTarget(null)
    } catch {
      if (!isMountedRef.current) return
      setRemoveError(strings.sharing.errors.genericRemoveFailed)
    } finally {
      if (isMountedRef.current) setRemoving(false)
    }
  }, [estimateId, removeTarget])

  const handleLevelChange = useCallback(
    async (row: CollaboratorGrant, nextLevel: AccessLevel) => {
      setLevelChangingIds((prev) => new Set(prev).add(row.id))
      setLevelChangeErrors((prev) => {
        if (!(row.id in prev)) return prev
        const next = { ...prev }
        delete next[row.id]
        return next
      })
      try {
        const updated = await collaboratorsApi.updateLevel(estimateId, row.id, { accessLevel: nextLevel })
        if (!isMountedRef.current) return
        setCollaborators((prev) => prev.map((c) => (c.id === row.id ? updated : c)))
        setAnnouncement(
          strings.sharing.dialog.levelChangedAnnouncement(updated.email, levelLabel(updated.accessLevel)),
        )
      } catch {
        if (!isMountedRef.current) return
        setLevelChangeErrors((prev) => ({ ...prev, [row.id]: strings.sharing.errors.genericLevelChangeFailed }))
      } finally {
        if (isMountedRef.current) {
          setLevelChangingIds((prev) => {
            const next = new Set(prev)
            next.delete(row.id)
            return next
          })
        }
      }
    },
    [estimateId],
  )

  // ---- a11y: default focus + Tab trap + Escape ----------------------------

  useEffect(() => {
    emailInputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The nested Remove-confirm layer owns Escape/Tab entirely while open
      // (design.md: "matches ConfirmDeleteModal's existing Escape
      // semantics") — it renders its own independent trap/Escape listener,
      // and this dialog's trap must not fight it for focus.
      if (removeTarget) return

      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      if (e.key !== 'Tab' || !dialogRef.current) return

      // Live-queried (InviteUserModal's technique) — the focusable set
      // changes as rows are added/removed, so a fixed list would go stale.
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('input, button, select'),
      ).filter((el) => !(el as HTMLInputElement | HTMLButtonElement | HTMLSelectElement).disabled)
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, removeTarget])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canSubmitAdd = EMAIL_PATTERN.test(email.trim()) && !submitting && !isRateLimited

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        data-testid="collaborators-dialog-backdrop"
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={DIALOG_TITLE_ID}
          className="bg-ink-soft border border-rule rounded-lg shadow-2xl w-full max-w-md mx-4 p-5 max-h-[85vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
          data-testid="collaborators-dialog"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3 shrink-0">
            <h2 id={DIALOG_TITLE_ID} className="font-disp text-sm font-bold text-text">
              {strings.sharing.dialog.title}
            </h2>
            <button
              onClick={onClose}
              className="text-muted hover:text-text text-lg leading-none transition-colors"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <p className="text-xs text-soft mb-3 shrink-0">{strings.sharing.dialog.ownerRowLabel}</p>

          {/* Add form — always visible for the owner (design.md S2) */}
          <form onSubmit={(e) => void handleAddSubmit(e)} className="flex flex-col gap-2 mb-4 shrink-0">
            <div className="flex flex-col gap-1">
              <label htmlFor={EMAIL_INPUT_ID} className="text-xs font-medium text-soft">
                {strings.sharing.dialog.emailLabel}
              </label>
              <input
                ref={emailInputRef}
                id={EMAIL_INPUT_ID}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={strings.sharing.dialog.emailPlaceholder}
                disabled={submitting}
                aria-invalid={addError !== null}
                aria-describedby={addError ? 'collaborators-dialog-add-error' : undefined}
                data-testid="collaborators-dialog-email-input"
                className="text-sm px-2.5 py-1.5 border border-rule rounded bg-ink text-text"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="collaborators-dialog-level" className="text-xs font-medium text-soft">
                {strings.sharing.dialog.levelLabel}
              </label>
              <select
                id="collaborators-dialog-level"
                value={addLevel}
                onChange={(e) => setAddLevel(e.target.value as AccessLevel)}
                disabled={submitting}
                data-testid="collaborators-dialog-level-select"
                className="text-sm px-2.5 py-1.5 border border-rule rounded bg-ink text-text"
              >
                <option value="viewer">{strings.sharing.dialog.levelViewer}</option>
                <option value="editor">{strings.sharing.dialog.levelEditor}</option>
              </select>
              <p className="text-[11px] text-muted">
                {addLevel === 'editor'
                  ? strings.sharing.dialog.levelEditorHint
                  : strings.sharing.dialog.levelViewerHint}
              </p>
            </div>

            {addError && (
              <p
                id="collaborators-dialog-add-error"
                role="alert"
                data-testid="collaborators-dialog-add-error"
                className="text-xs text-org"
              >
                {addError}
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmitAdd}
              data-testid="collaborators-dialog-add-button"
              className="self-start py-1.5 px-3 text-sm font-medium text-acc border border-acc/50 hover:bg-acc/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block w-3 h-3 border-2 border-acc border-t-transparent rounded-full animate-spin"
                    aria-hidden="true"
                  />
                  {strings.sharing.dialog.addingButton}
                </span>
              ) : (
                strings.sharing.dialog.addButton
              )}
            </button>
          </form>

          {/* Collaborator list */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {listStatus === 'loading' && <SkeletonListRows />}

            {listStatus === 'error' && (
              <div
                role="alert"
                className="px-4 py-3 rounded-md border border-org/40 bg-org/10 text-sm text-org flex items-center justify-between gap-4"
                data-testid="collaborators-dialog-load-error"
              >
                <span>{strings.sharing.errors.loadFailed}</span>
                <button
                  onClick={() => void loadList()}
                  className="shrink-0 text-xs font-medium border border-org/60 text-org px-2.5 py-1 hover:bg-org/20 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {listStatus === 'ready' && collaborators.length === 0 && (
              <p className="text-muted text-[11px] italic" data-testid="collaborators-dialog-empty">
                {strings.sharing.dialog.emptyState}
              </p>
            )}

            {listStatus === 'ready' && collaborators.length > 0 && (
              <ul className="flex flex-col gap-2" data-testid="collaborators-dialog-list">
                {collaborators.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-md border border-rule"
                    data-testid={`collaborators-dialog-row-${row.id}`}
                  >
                    <span className="flex-1 text-sm text-text truncate">{row.email}</span>
                    <AccessLevelBadge level={row.accessLevel} />
                    <select
                      ref={(el) => {
                        if (el) rowSelectRefs.current.set(row.id, el)
                        else rowSelectRefs.current.delete(row.id)
                      }}
                      value={row.accessLevel}
                      onChange={(e) => void handleLevelChange(row, e.target.value as AccessLevel)}
                      disabled={levelChangingIds.has(row.id)}
                      aria-label={`${strings.sharing.dialog.levelLabel} (${row.email})`}
                      data-testid={`collaborators-dialog-row-level-${row.id}`}
                      className="text-xs px-1.5 py-1 border border-rule rounded bg-ink text-text"
                    >
                      <option value="viewer">{strings.sharing.dialog.levelViewer}</option>
                      <option value="editor">{strings.sharing.dialog.levelEditor}</option>
                    </select>
                    <button
                      onClick={() => {
                        setRemoveTarget(row)
                        setRemoveError(null)
                      }}
                      aria-label={strings.sharing.dialog.removeAction(row.email)}
                      data-testid={`collaborators-dialog-row-remove-${row.id}`}
                      className="text-muted hover:text-red text-base leading-none transition-colors"
                    >
                      ×
                    </button>
                    {levelChangeErrors[row.id] && (
                      <p role="alert" className="text-[11px] text-org w-full basis-full">
                        {levelChangeErrors[row.id]}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Live region — always mounted (Bell.tsx's pattern), separate from inline alerts */}
          <span className="sr-only" aria-live="polite" data-testid="collaborators-dialog-live-region">
            {announcement}
          </span>
        </div>
      </div>

      {removeTarget && (
        <ConfirmDeleteModal
          estimateName={removeTarget.email}
          isDeleting={removing}
          errorMessage={removeError}
          onConfirm={() => void handleConfirmRemove()}
          onCancel={() => {
            setRemoveTarget(null)
            setRemoveError(null)
          }}
          title={strings.sharing.dialog.removeConfirmTitle}
          bodyText={strings.sharing.dialog.removeConfirmBody(removeTarget.email)}
          confirmLabel={strings.sharing.dialog.removeConfirmButton}
        />
      )}
    </>
  )
}
