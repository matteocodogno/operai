/**
 * useCatalogToggle — what the ledger-account and VAT-code cards share about deactivating and reactivating a row
 * (specs/20261118-refund-accounting-export, design F2, UX-3): a confirm for Deactivate, an immediate Reactivate, the
 * 409 of a stale list, and where focus goes afterwards.
 *
 *   - Deactivate asks first (a `ConfirmDialog`, owned by the card from `confirming`): it changes what
 *     approval needs. Reactivate only restores a state, so it acts at once.
 *   - A success swaps the row for the server's (`onChanged`), confirms in a banner, and moves focus to the row's
 *     header: the button that was pressed no longer exists (`focusRowKey`; it is reset to `null` at the start of each
 *     action so the same row can be focused twice).
 *   - A 409 (`already_active` / `already_inactive`: the list was stale, AC-1.11) says so in a danger banner and
 *     reloads the list (`onStale`); nothing else changes and nothing was audited.
 *   - Any other failure keeps the confirm open with its message (deactivate), or shows in the same banner
 *     (reactivate). A 403 reads as a permission problem, never as "try again".
 *
 * One action at a time: while one is in flight every row action is disabled (`pendingId`).
 */

import { useState } from 'react'
import { ApiError } from '../../lib/refundApi'

export type CatalogToggleMessages = {
  deactivated: (label: string) => string
  reactivated: (label: string) => string
  alreadyActive: (label: string) => string
  alreadyInactive: (label: string) => string
  forbidden: string
  genericError: string
}

export type CatalogToggleOptions<T extends { id: string }> = {
  deactivate: (id: string) => Promise<T>
  reactivate: (id: string) => Promise<T>
  /** The number or code the messages name. */
  labelOf: (item: T) => string
  /** The server's version of the row, to put in the list. */
  onChanged: (item: T) => void
  /** The list is stale: load it again. */
  onStale: () => void
  messages: CatalogToggleMessages
}

export function useCatalogToggle<T extends { id: string }>({
  deactivate,
  reactivate,
  labelOf,
  onChanged,
  onStale,
  messages,
}: CatalogToggleOptions<T>) {
  const [confirming, setConfirming] = useState<T | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [focusRowKey, setFocusRowKey] = useState<string | null>(null)

  const begin = (id: string) => {
    setPendingId(id)
    setActionError(null)
    setSuccess(null)
    setFocusRowKey(null)
  }

  const finish = (updated: T, message: string) => {
    onChanged(updated)
    setSuccess(message)
    setFocusRowKey(updated.id)
    setPendingId(null)
  }

  /** The text for a failure that is not a stale-list 409: permission or generic. */
  const failureText = (error: unknown): string =>
    error instanceof ApiError && error.status === 403 ? messages.forbidden : messages.genericError

  const stale = (error: unknown): 'active' | 'inactive' | null =>
    error instanceof ApiError && error.status === 409
      ? error.code === 'already_active'
        ? 'active'
        : error.code === 'already_inactive'
          ? 'inactive'
          : null
      : null

  const confirmDeactivate = async () => {
    if (confirming === null || pendingId !== null) return
    const item = confirming
    begin(item.id)
    setConfirmError(null)
    try {
      finish(await deactivate(item.id), messages.deactivated(labelOf(item)))
      setConfirming(null)
    } catch (error) {
      setPendingId(null)
      if (stale(error) !== null) {
        setConfirming(null)
        setActionError(messages.alreadyInactive(labelOf(item)))
        onStale()
      } else {
        setConfirmError(failureText(error))
      }
    }
  }

  const reactivateItem = async (item: T) => {
    if (pendingId !== null) return
    begin(item.id)
    try {
      finish(await reactivate(item.id), messages.reactivated(labelOf(item)))
    } catch (error) {
      setPendingId(null)
      if (stale(error) !== null) {
        setActionError(messages.alreadyActive(labelOf(item)))
        onStale()
      } else {
        setActionError(failureText(error))
      }
    }
  }

  return {
    confirming,
    confirmError,
    /** True while the deactivate being confirmed is in flight (the dialog is busy and cannot be dismissed). */
    confirmBusy: confirming !== null && pendingId === confirming.id,
    openConfirm: (item: T) => {
      setConfirmError(null)
      setConfirming(item)
    },
    cancelConfirm: () => {
      if (pendingId === null) setConfirming(null)
    },
    confirmDeactivate,
    reactivate: reactivateItem,
    pendingId,
    actionError,
    clearActionError: () => setActionError(null),
    success,
    clearSuccess: () => setSuccess(null),
    focusRowKey,
    /** Show a confirmation from outside the hook (an item was added). */
    announce: (message: string) => setSuccess(message),
  }
}
