import { useRef, useState } from 'react'
import AssignDialog from './AssignDialog'
import ConfirmDialog from './ConfirmDialog'
import GuardrailDialog from './GuardrailDialog'
import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { ApiError } from '../lib/api'
import { finishRepair, markFound, markLost, receiveAsset, returnAsset, startRepair } from '../lib/assetsApi'
import { cancelAssignment } from '../lib/assignmentsApi'
import { formatDate } from '../lib/dates'
import { toInventoryError } from '../lib/types'
import type { AssetView, Identity } from '../lib/types'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'

/**
 * AssetActions — the action region of the asset detail page (T33, specs/015-
 * hardware-inventory; design.md F3, F5, § Dialogs, § Error and conflict
 * catalogue, § Accessibility "T2 detail"; AC-1.8, AC-2.1, AC-2.2, AC-2.5,
 * AC-2.10, AC-3.1 to AC-3.5). Its props are fixed by T32; the page owns the
 * "Edit details" entry and never renders this region for a disposed asset.
 *
 * Only the actions valid for the asset's status are rendered (F5), and none at
 * all while an assignment is pending — the callout, with its "Cancel
 * assignment", is the only way forward (AC-2.2, AC-2.10). The action group, the
 * Assign dialog and every confirm are `asset:manage` only and ABSENT from the
 * DOM otherwise; the two callouts (pending assignment, holder's account deleted)
 * are read-only for an accountant. Return and Lost ask for confirmation first
 * (Q4); receive, repair, repair finished and found act on one click.
 *
 * After a successful action the trigger no longer exists, so focus moves to the
 * page heading and the page's status line announces the result. A stale asset
 * (`invalid_transition`, `assignment_pending`, `asset_disposed`) is explained in
 * a guardrail and the page reloads the asset once it is acknowledged; a 404
 * reloads at once; 503 and network failures stay inline and keep the controls.
 */

export type AssetActionsProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  /** A fresh `AssetView` replaces the page's asset; `null` reloads it in place. */
  onChanged: (updated: AssetView | null) => void
  /** Fills the page's polite status line. */
  announce: (message: string) => void
  focusHeading: () => void
}

type ActionKey = 'receive' | 'assign' | 'repair' | 'repairDone' | 'return' | 'lost' | 'found' | 'cancel'
type ConfirmKind = 'return' | 'lost' | 'cancel'

/** Actions that need no confirmation: the request, and the line announced on success. */
const ONE_CLICK = {
  receive: { call: receiveAsset, done: strings.actions.done.received },
  repair: { call: startRepair, done: strings.actions.done.repair },
  repairDone: { call: finishRepair, done: strings.actions.done.repairDone },
  found: { call: markFound, done: strings.actions.done.found },
} as const

const CONFIRMED = {
  return: { call: returnAsset, done: strings.actions.done.returned },
  lost: { call: markLost, done: strings.actions.done.lost },
} as const

/** The buttons of the action group per status (F5); none while an assignment is pending. */
const ACTIONS_FOR_STATUS: Record<string, readonly ActionKey[]> = {
  ordered: ['receive'],
  in_stock: ['assign', 'repair', 'lost'],
  assigned: ['return', 'repair', 'lost'],
  in_repair: ['repairDone', 'lost'],
  lost: ['found'],
}

const LABELS: Record<ActionKey, string> = {
  receive: strings.actions.receive,
  assign: strings.actions.assign,
  repair: strings.actions.repair,
  repairDone: strings.actions.repairDone,
  return: strings.actions.return,
  lost: strings.actions.lost,
  found: strings.actions.found,
  cancel: strings.actions.pending.cancel,
}

const identityLabel = (identity: Identity): string => {
  if (identity.status === 'system') return strings.assets.holderSystem
  if (identity.status === 'deleted') return strings.assets.holderDeleted
  return identity.name ?? strings.assets.holderUnknown
}

const DAY_MS = 24 * 60 * 60 * 1000

const pendingText = (name: string, createdAt: string): string => {
  const offered = formatDate(createdAt)
  const days = Math.floor((Date.now() - Date.parse(createdAt)) / DAY_MS)
  const t = strings.actions.pending
  if (!Number.isFinite(days)) return t.textNoAge(name, offered)
  return t.text(name, offered, days <= 0 ? t.ageToday : t.ageDays(days))
}

const unavailableMessage = `${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`

const failureMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.status === 503 ? unavailableMessage : (error.detail ?? strings.errors.unknown)
  }
  return strings.errors.network
}

const buttonStyle = (destructive: boolean) => ({
  borderColor: destructive ? 'var(--red)' : 'var(--acc)',
  color: destructive ? 'var(--red)' : 'var(--acc)',
})

export default function AssetActions({ asset, capabilities, onChanged, announce, focusHeading }: AssetActionsProps) {
  const t = strings.actions
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; error: string | null } | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [guardrail, setGuardrail] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Synchronous guard: two clicks in one tick must not send two requests. */
  const inFlight = useRef(false)

  if (asset.status === 'disposed') return null

  const canManage = capabilities.canManageAssets
  const pending = asset.pendingAssignment
  const holderDeleted = asset.status === 'assigned' && asset.holder?.status === 'deleted'
  const actions = pending === null ? (ACTIONS_FOR_STATUS[asset.status] ?? []) : []

  const showGuardrail = (message: string) => {
    setConfirm(null)
    setAssigning(false)
    setGuardrail(message)
  }

  /** Maps a failed write onto the catalogue: a guardrail, a reload, or an inline message. */
  const fail = (error: unknown) => {
    const known = toInventoryError(error)
    if (known?.code === 'invalid_transition') {
      const from = known.extras.from
      const label =
        from === undefined
          ? undefined
          : (strings.badges.assetStatus[from as keyof typeof strings.badges.assetStatus] ?? from)
      return showGuardrail(
        label === undefined
          ? t.changedGeneric
          : fillTemplate(strings.errors.invalid_transition, { from: label.toLowerCase() }),
      )
    }
    if (known?.code === 'assignment_pending') {
      return showGuardrail(fillTemplate(strings.errors.assignment_pending, { name: t.someone }))
    }
    if (known?.code === 'asset_disposed') return showGuardrail(strings.errors.asset_disposed)
    if (known?.code === 'assignment_not_pending') {
      setConfirm(null)
      setActionError(strings.errors.assignment_not_pending)
      return onChanged(null)
    }
    if (error instanceof ApiError && error.status === 404) {
      setConfirm(null)
      return onChanged(null)
    }
    const message = failureMessage(error)
    if (confirm !== null) setConfirm({ kind: confirm.kind, error: message })
    else setActionError(message)
  }

  const perform = async (key: ActionKey, call: () => Promise<AssetView>, done: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(key)
    setActionError(null)
    try {
      const updated = await call()
      setConfirm(null)
      onChanged(updated)
      announce(done)
      // The trigger is gone with the status change: the heading is the focus anchor.
      focusHeading()
    } catch (error) {
      fail(error)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const click = (key: ActionKey) => {
    if (inFlight.current) return
    setActionError(null)
    if (key === 'assign') return setAssigning(true)
    if (key === 'return' || key === 'lost' || key === 'cancel') return setConfirm({ kind: key, error: null })
    const { call, done } = ONE_CLICK[key]
    void perform(key, () => call(asset.id), done)
  }

  const confirmed = () => {
    if (confirm === null) return
    if (confirm.kind === 'cancel') {
      if (pending === null) return
      void perform('cancel', () => cancelAssignment(pending.id), t.done.cancelled)
      return
    }
    const { call, done } = CONFIRMED[confirm.kind]
    void perform(confirm.kind, () => call(asset.id), done)
  }

  const assigneeName = pending === null ? '' : identityLabel(pending.assignee)
  const holderName = asset.holder === null || asset.holder.name === null ? null : asset.holder.name

  const actionButton = (key: ActionKey, destructive = false) => (
    <button
      key={key}
      type="button"
      onClick={() => click(key)}
      aria-disabled={busy !== null || undefined}
      aria-busy={busy === key || undefined}
      className="border px-3 py-2 text-sm font-medium aria-disabled:opacity-60"
      style={buttonStyle(destructive)}
    >
      {LABELS[key]}
    </button>
  )

  const confirmCopy = (kind: ConfirmKind) => {
    if (kind === 'return') {
      const d = t.returnDialog
      return {
        entityLabel: d.entityLabel,
        title: d.title(asset.description),
        body: d.body(holderName ?? d.holderFallback),
        confirm: d.confirm,
        confirming: d.confirming,
        tone: 'positive' as const,
      }
    }
    if (kind === 'lost') {
      const d = t.lostDialog
      return {
        entityLabel: d.entityLabel,
        title: d.title(asset.description),
        body: d.body,
        confirm: d.confirm,
        confirming: d.confirming,
        tone: 'destructive' as const,
      }
    }
    const d = t.cancelDialog
    return {
      entityLabel: d.entityLabel,
      title: d.title(asset.description),
      body: d.body(assigneeName),
      confirm: d.confirm,
      confirming: d.confirming,
      tone: 'destructive' as const,
    }
  }

  const copy = confirm === null ? null : confirmCopy(confirm.kind)

  return (
    <div data-testid="asset-actions" className="flex flex-col gap-3">
      {pending !== null && (
        <div
          role="status"
          data-testid="pending-callout"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--acc)', color: 'var(--text)' }}
        >
          <p>{pendingText(assigneeName, pending.createdAt)}</p>
          {canManage && actionButton('cancel')}
        </div>
      )}

      {holderDeleted && (
        <div
          role="status"
          data-testid="holder-deleted-callout"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--org)', color: 'var(--text)' }}
        >
          <p>{holderName === null ? t.holderDeleted.unnamed : t.holderDeleted.named(holderName)}</p>
          {canManage && actionButton('return')}
        </div>
      )}

      {actionError !== null && (
        <p
          role="alert"
          data-testid="asset-actions-error"
          className="rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--org)', color: 'var(--org)' }}
        >
          {actionError}
        </p>
      )}

      {canManage && actions.length > 0 && (
        <div role="group" aria-label={t.groupLabel} className="flex flex-wrap gap-2">
          {actions.map((key) => actionButton(key, key === 'lost'))}
        </div>
      )}

      {canManage && assigning && (
        <AssignDialog
          asset={asset}
          onAssigned={(updated) => {
            setAssigning(false)
            onChanged(updated)
            announce(
              t.done.assigned(
                updated.pendingAssignment == null ? assigneeName : identityLabel(updated.pendingAssignment.assignee),
              ),
            )
            focusHeading()
          }}
          onCancel={() => setAssigning(false)}
          onConflict={fail}
        />
      )}

      {canManage && confirm !== null && copy !== null && (
        <ConfirmDialog
          entityLabel={copy.entityLabel}
          itemName={asset.description}
          isDeleting={busy === confirm.kind}
          errorMessage={confirm.error}
          title={copy.title}
          body={<p>{copy.body}</p>}
          tone={copy.tone}
          confirmLabel={copy.confirm}
          confirmingLabel={copy.confirming}
          onConfirm={confirmed}
          onCancel={() => setConfirm(null)}
          testIdPrefix={`confirm-${confirm.kind}`}
        />
      )}

      {guardrail !== null && (
        <GuardrailDialog
          title={t.conflictTitle}
          message={guardrail}
          onAcknowledge={() => {
            setGuardrail(null)
            onChanged(null)
          }}
        />
      )}
    </div>
  )
}
