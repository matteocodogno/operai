/**
 * useCatalogToggle — what the ledger-account and VAT-code cards share about deactivating and reactivating a row
 * (moved from refund-ui, specs/20261118-refund-accounting-export design F2, UX-3; adapted by specs/20261119-accounting,
 * design FA5, UX-5, UX-7, UX-15): a confirm for Deactivate, an immediate Reactivate, the 409 of a stale list, and where
 * focus goes afterwards.
 *
 *   - Rows are keyed by their NATURAL key (`keyOf`: the account number or the VAT code), never an id (UX-5). The same key
 *     is the label the messages name.
 *   - Deactivate asks first (a `ConfirmDialog`, owned by the card from `confirming`). Reactivate only restores a state, so
 *     it acts at once.
 *   - A success swaps the row for the server's (`onChanged`), confirms in a banner, and moves focus to the row's header:
 *     the button that was pressed no longer exists (`focusRowKey`; it is reset to `null` at the start of each action so the
 *     same row can be focused twice).
 *   - A 409 (`already_active` / `already_inactive`: the list was stale, AC-1.11) says so in a danger banner and reloads the
 *     list (`onStale`); nothing else changes. A 404 (the number or code is no longer there) says the generic failure and
 *     reloads the same way.
 *   - A 403 reads as a permission problem, never as "try again", and tells the frame (`onForbidden`) so it re-reads
 *     `/v1/me` and the controls that should not be there disappear (UX-15, AC-3.4). Any other failure keeps the confirm
 *     open with its message (deactivate), or shows in the same banner (reactivate).
 *
 * One action at a time: while one is in flight every row action is disabled (`pendingKey`).
 */

import { useState } from 'react'
import { ApiError } from '../lib/api'

export type CatalogToggleMessages = {
  deactivated: (key: string) => string
  reactivated: (key: string) => string
  alreadyActive: (key: string) => string
  alreadyInactive: (key: string) => string
  forbidden: string
  genericError: string
}

export type CatalogToggleOptions<T> = {
  /** The natural key of a row: the account number or the VAT code. */
  keyOf: (item: T) => string
  deactivate: (key: string) => Promise<T>
  reactivate: (key: string) => Promise<T>
  /** The server's version of the row, to put in the list. */
  onChanged: (item: T) => void
  /** The list is stale: load it again. */
  onStale: () => void
  /** A write answered 403: the frame re-reads `/v1/me` (UX-15). */
  onForbidden: () => void
  messages: CatalogToggleMessages
}

export function useCatalogToggle<T>({
  keyOf,
  deactivate,
  reactivate,
  onChanged,
  onStale,
  onForbidden,
  messages,
}: CatalogToggleOptions<T>) {
  const [confirming, setConfirming] = useState<T | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [focusRowKey, setFocusRowKey] = useState<string | null>(null)

  const begin = (key: string) => {
    setPendingKey(key)
    setActionError(null)
    setSuccess(null)
    setFocusRowKey(null)
  }

  const finish = (updated: T, message: string) => {
    onChanged(updated)
    setSuccess(message)
    setFocusRowKey(keyOf(updated))
    setPendingKey(null)
  }

  /** The text for a failure that is not a stale-list 409: permission or generic. */
  const failureText = (error: unknown): string => {
    if (error instanceof ApiError && error.status === 403) {
      onForbidden()
      return messages.forbidden
    }
    return messages.genericError
  }

  const stale = (error: unknown): 'active' | 'inactive' | null =>
    error instanceof ApiError && error.status === 409
      ? error.code === 'already_active'
        ? 'active'
        : error.code === 'already_inactive'
          ? 'inactive'
          : null
      : null

  const gone = (error: unknown): boolean => error instanceof ApiError && error.status === 404

  const confirmDeactivate = async () => {
    if (confirming === null || pendingKey !== null) return
    const item = confirming
    const key = keyOf(item)
    begin(key)
    setConfirmError(null)
    try {
      finish(await deactivate(key), messages.deactivated(key))
      setConfirming(null)
    } catch (error) {
      setPendingKey(null)
      if (stale(error) !== null) {
        setConfirming(null)
        setActionError(messages.alreadyInactive(key))
        onStale()
      } else if (gone(error)) {
        setConfirming(null)
        setActionError(messages.genericError)
        onStale()
      } else {
        setConfirmError(failureText(error))
      }
    }
  }

  const reactivateItem = async (item: T) => {
    if (pendingKey !== null) return
    const key = keyOf(item)
    begin(key)
    try {
      finish(await reactivate(key), messages.reactivated(key))
    } catch (error) {
      setPendingKey(null)
      if (stale(error) !== null) {
        setActionError(messages.alreadyActive(key))
        onStale()
      } else if (gone(error)) {
        setActionError(messages.genericError)
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
    confirmBusy: confirming !== null && pendingKey === keyOf(confirming),
    openConfirm: (item: T) => {
      setConfirmError(null)
      setConfirming(item)
    },
    cancelConfirm: () => {
      if (pendingKey === null) setConfirming(null)
    },
    confirmDeactivate,
    reactivate: reactivateItem,
    pendingKey,
    actionError,
    clearActionError: () => setActionError(null),
    success,
    clearSuccess: () => setSuccess(null),
    focusRowKey,
    /** Show a confirmation from outside the hook (an item was added). */
    announce: (message: string) => setSuccess(message),
  }
}
