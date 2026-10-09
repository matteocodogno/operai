import { useId, useRef, useState } from 'react'
import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { ApiError } from '../lib/api'
import { listAssets } from '../lib/assetsApi'
import {
  INVOICE_CONTENT_TYPES,
  StorageUploadError,
  getInvoiceFileUrl,
  linkInvoiceFile,
  uploadInvoiceFile,
  validateInvoiceFile,
} from '../lib/invoiceFilesApi'
import { toInventoryError } from '../lib/types'
import type { AssetListItem, AssetView } from '../lib/types'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'

/**
 * InvoiceFilePanel — the invoice region of the asset detail page (T35, specs/015-
 * hardware-inventory; design.md § T2 invoice region, F8, § Accessibility "Invoice
 * panel", Resolutions G6/Q2; AC-10.4, AC-10.5, AC-10.6). Its props are fixed by T32.
 *
 * Both capabilities may upload and link; a disposed asset shows the panel
 * read-only (the file still opens). The flow, per file: a client-side type and
 * size check (a rejected file is shown with its reason, nothing is requested),
 * then mint -> bucket POST -> confirm, then the file is linked to THIS asset
 * (without that link it could not be opened from the asset, AC-10.4) and the page
 * reloads the asset in place (`onChanged(null)`). Right after, the other open
 * assets of the entity sharing the invoice reference are offered in a checklist
 * (Q2) and linked with one call (AC-10.5). There is no remove control: a new file
 * replaces the link, and changing the reference unlinks it (the edit dialog says
 * so). "Open invoice" asks for a fresh 60 s URL on every click, never caching one.
 *
 * A failure after the upload (the link to this asset) keeps the stored file id so
 * "Try linking again" does not upload twice.
 */

export type InvoiceFilePanelProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  onChanged: (updated: AssetView | null) => void
  announce: (message: string) => void
  focusHeading: () => void
}

type Notice = { message: string; retryLink?: { fileId: string; fileName: string } }

type Offer = {
  fileId: string
  reference: string
  status: 'loading' | 'ready' | 'error'
  items: AssetListItem[]
  selected: string[]
  linking: boolean
  error: string | null
}

/** Everything transient, owned by one asset: a flow of another asset is ignored, never shown. */
type Flow = {
  ownerId: string
  uploading: string | null
  notice: Notice | null
  offer: Offer | null
  opening: boolean
  openFailed: boolean
}

const emptyFlow = (ownerId: string): Flow => ({
  ownerId,
  uploading: null,
  notice: null,
  offer: null,
  opening: false,
  openFailed: false,
})

const unavailable = `${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`

/** The user-facing reason for a failed mint / bucket POST / confirm. */
const uploadFailure = (error: unknown): string => {
  if (error instanceof StorageUploadError) {
    return error.status === 413 ? strings.errors.tooLarge : strings.errors.upload_not_found
  }
  const known = toInventoryError(error)
  if (known?.code === 'upload_not_found') return strings.errors.upload_not_found
  if (known?.code === 'too_many_pending_uploads') return strings.errors.too_many_pending_uploads
  if (error instanceof ApiError) {
    if (error.status === 413) return strings.errors.tooLarge
    if (error.status === 415) return strings.errors.unsupportedType
    if (error.status === 503) return unavailable
    return error.detail ?? strings.errors.unknown
  }
  return strings.errors.network
}

const rejectionMessage = (reason: 'tooLarge' | 'unsupportedType'): string =>
  reason === 'tooLarge' ? strings.errors.tooLarge : strings.errors.unsupportedType

/** Every open sibling that does not carry this file yet, across all result pages. */
const findSiblings = async (entity: AssetView['entity'], reference: string, ownerId: string, fileId: string) => {
  const found: AssetListItem[] = []
  let cursor: string | null = null
  do {
    const page: { items: AssetListItem[]; nextCursor: string | null } = await listAssets(
      cursor === null ? { entity, invoiceRef: reference } : { entity, invoiceRef: reference, cursor },
    )
    found.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== null)
  return found.filter((item) => item.id !== ownerId && item.status !== 'disposed' && item.invoiceFile?.id !== fileId)
}

export default function InvoiceFilePanel({
  asset,
  capabilities,
  onChanged,
  announce,
  focusHeading,
}: InvoiceFilePanelProps) {
  void focusHeading
  const t = strings.invoice
  const baseId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<Flow>(() => emptyFlow(asset.id))
  const flow = state.ownerId === asset.id ? state : emptyFlow(asset.id)
  const ownerId = asset.id

  const patch = (changes: Partial<Flow>) =>
    setState((previous) => ({ ...(previous.ownerId === ownerId ? previous : emptyFlow(ownerId)), ...changes }))
  const patchOffer = (changes: Partial<Offer>) =>
    setState((previous) =>
      previous.ownerId === ownerId && previous.offer !== null
        ? { ...previous, offer: { ...previous.offer, ...changes } }
        : previous,
    )

  const readOnly = asset.status === 'disposed'
  const canWrite = !readOnly && (capabilities.canManageAssets || capabilities.canManageLedger)
  const reference = asset.invoiceRef
  const hasReference = reference !== null && reference !== ''
  const busy = flow.uploading !== null

  const loadSiblings = async (fileId: string, ref: string, quiet: boolean) => {
    if (!quiet) {
      patch({
        offer: { fileId, reference: ref, status: 'loading', items: [], selected: [], linking: false, error: null },
      })
    }
    try {
      const items = await findSiblings(asset.entity, ref, ownerId, fileId)
      if (items.length === 0) return patch({ offer: null })
      setState((previous) => {
        if (previous.ownerId !== ownerId) return previous
        const kept = previous.offer?.selected.filter((id) => items.some((item) => item.id === id)) ?? []
        const offer: Offer = {
          fileId,
          reference: ref,
          status: 'ready',
          items,
          selected: kept,
          linking: false,
          error: quiet ? (previous.offer?.error ?? null) : null,
        }
        return { ...previous, offer }
      })
    } catch {
      if (!quiet) patchOffer({ status: 'error' })
    }
  }

  /** Links the stored file to this asset, reloads the page, and offers the siblings. */
  const linkOwn = async (fileId: string, fileName: string) => {
    try {
      await linkInvoiceFile(fileId, [asset.id])
    } catch (error) {
      const known = toInventoryError(error)
      if (known?.code === 'asset_disposed') {
        patch({ uploading: null, notice: { message: strings.errors.asset_disposed } })
        return onChanged(null)
      }
      if (known?.code === 'invoice_ref_mismatch') {
        patch({
          uploading: null,
          notice: { message: fillTemplate(strings.errors.invoice_ref_mismatch, { asset: asset.description }) },
        })
        return onChanged(null)
      }
      return patch({ uploading: null, notice: { message: t.linkOwnFailed, retryLink: { fileId, fileName } } })
    }
    patch({ uploading: null, notice: null })
    announce(t.saved(fileName))
    onChanged(null)
    if (hasReference) void loadSiblings(fileId, reference, false)
  }

  const startUpload = async (file: File) => {
    if (reference === null || reference === '') return
    const rejected = validateInvoiceFile(file)
    if (rejected !== null) {
      return patch({ notice: { message: t.rejected(file.name, rejectionMessage(rejected)) }, offer: null })
    }
    patch({ uploading: file.name, notice: null, offer: null })
    let stored: { id: string; fileName: string }
    try {
      stored = await uploadInvoiceFile(asset.entity, reference, file)
    } catch (error) {
      return patch({ uploading: null, notice: { message: t.rejected(file.name, uploadFailure(error)) } })
    }
    await linkOwn(stored.id, stored.fileName)
  }

  const retryLink = async (retry: { fileId: string; fileName: string }) => {
    patch({ uploading: retry.fileName, notice: null })
    await linkOwn(retry.fileId, retry.fileName)
  }

  const open = async () => {
    const file = asset.invoiceFile
    if (file === null || flow.opening) return
    patch({ opening: true, openFailed: false })
    // Open the tab inside the click, before the await, so a popup blocker lets it through.
    const tab = window.open('', '_blank')
    try {
      const { url } = await getInvoiceFileUrl(file.id)
      if (tab) {
        tab.opener = null
        tab.location.href = url
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      patch({ opening: false })
    } catch {
      tab?.close()
      patch({ opening: false, openFailed: true })
    }
  }

  const linkSelected = async () => {
    const offer = flow.offer
    if (offer === null || offer.linking || offer.selected.length === 0) return
    patchOffer({ linking: true, error: null })
    try {
      const { linked } = await linkInvoiceFile(offer.fileId, offer.selected)
      announce(t.siblings.done(linked.length))
      patch({ offer: null })
    } catch (error) {
      const known = toInventoryError(error)
      const nameOf = (id: string | undefined) =>
        offer.items.find((item) => item.id === id)?.description ?? t.siblings.unnamedAsset
      let message: string
      let refresh = false
      if (known?.code === 'invoice_ref_mismatch') {
        message = fillTemplate(strings.errors.invoice_ref_mismatch, { asset: nameOf(known.extras.assetId) })
        refresh = true
      } else if (known?.code === 'asset_disposed') {
        message = t.siblings.disposed(nameOf(known.extras.assetId), strings.errors.asset_disposed)
        refresh = true
      } else if (error instanceof ApiError && error.status === 404) {
        message = t.siblings.notFound
        refresh = true
      } else if (error instanceof ApiError) {
        message = error.status === 503 ? unavailable : (error.detail ?? strings.errors.unknown)
      } else {
        message = strings.errors.network
      }
      patchOffer({ linking: false, error: message })
      if (refresh) void loadSiblings(offer.fileId, offer.reference, true)
    }
  }

  const onPick = (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ''
    if (file !== undefined && canWrite && hasReference && !busy) void startUpload(file)
  }

  const headingId = `${baseId}-heading`
  const reasonId = `${baseId}-reason`
  const hintId = `${baseId}-hint`
  const labelStyle = { color: 'var(--soft)' }
  const alertStyle = {
    borderColor: 'var(--org)',
    backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)',
    color: 'var(--org)',
  }
  const offer = flow.offer

  return (
    <section aria-labelledby={headingId} data-testid="invoice-panel" className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 id={headingId} className="card-title">
          {t.heading}
        </h3>
        {canWrite && (
          <div className="flex flex-col items-end gap-1 text-right">
            <input
              ref={inputRef}
              type="file"
              data-testid="invoice-file-input"
              accept={INVOICE_CONTENT_TYPES.join(',')}
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => onPick(event.currentTarget)}
            />
            <button
              type="button"
              onClick={() => {
                if (hasReference && !busy) inputRef.current?.click()
              }}
              aria-disabled={!hasReference || busy || undefined}
              aria-busy={busy || undefined}
              aria-describedby={!hasReference ? reasonId : asset.invoiceFile !== null ? hintId : undefined}
              className="btn btn-secondary btn-sm"
            >
              {asset.invoiceFile === null ? t.upload : t.uploadAnother}
            </button>
            {!hasReference && (
              <p id={reasonId} className="text-xs" style={labelStyle}>
                {t.needsReference}
              </p>
            )}
            {hasReference && asset.invoiceFile !== null && (
              <p id={hintId} className="text-xs" style={labelStyle}>
                {t.uploadAnotherHint}
              </p>
            )}
          </div>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs" style={labelStyle}>
            {t.reference}
          </dt>
          <dd className="text-sm" style={{ color: 'var(--text)' }}>
            {hasReference ? reference : t.referenceNone}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs" style={labelStyle}>
            {t.file}
          </dt>
          <dd className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>
            {asset.invoiceFile === null ? (
              <span>{t.fileNone}</span>
            ) : (
              <>
                <span>{asset.invoiceFile.fileName}</span>
                <button
                  type="button"
                  onClick={() => void open()}
                  aria-label={t.openNamed(asset.invoiceFile.fileName)}
                  aria-busy={flow.opening || undefined}
                  className="btn btn-secondary btn-sm"
                >
                  {flow.opening ? t.opening : t.open}
                </button>
              </>
            )}
          </dd>
        </div>
      </dl>

      {flow.openFailed && (
        <p role="alert" className="border px-3 py-2 text-sm" style={alertStyle}>
          {t.openFailed}
        </p>
      )}

      {readOnly && (
        <p className="text-sm" style={labelStyle}>
          {t.readOnly}
        </p>
      )}

      {flow.uploading !== null && (
        <p role="status" className="text-sm" style={labelStyle}>
          {t.uploading(flow.uploading)}
        </p>
      )}

      {flow.notice !== null && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border px-3 py-2 text-sm"
          style={alertStyle}
        >
          <span>{flow.notice.message}</span>
          <span className="flex shrink-0 items-center gap-2">
            {flow.notice.retryLink !== undefined && (
              <button
                type="button"
                onClick={() => void retryLink(flow.notice?.retryLink as { fileId: string; fileName: string })}
                className="btn btn-secondary btn-sm"
              >
                {t.retryLink}
              </button>
            )}
            <button
              type="button"
              onClick={() => patch({ notice: null })}
              className="btn btn-ghost btn-sm"
            >
              {t.dismiss}
            </button>
          </span>
        </div>
      )}

      {canWrite && offer !== null && offer.status === 'loading' && (
        <p role="status" className="text-sm" style={labelStyle}>
          {t.siblings.loading}
        </p>
      )}

      {canWrite && offer !== null && offer.status === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border px-3 py-2 text-sm"
          style={alertStyle}
        >
          <span>{t.siblings.failed}</span>
          <button
            type="button"
            onClick={() => void loadSiblings(offer.fileId, offer.reference, false)}
            className="btn btn-secondary btn-sm"
          >
            {t.retry}
          </button>
        </div>
      )}

      {canWrite && offer !== null && offer.status === 'ready' && (
        <div className="flex flex-col gap-2">
          <fieldset className="flex flex-col gap-1.5" disabled={offer.linking}>
            <legend className="text-sm font-medium" style={{ color: 'var(--text)' }}>
              {t.siblings.legend(offer.reference)}
            </legend>
            {offer.items.map((item) => (
              <label key={item.id} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={offer.selected.includes(item.id)}
                  onChange={(event) =>
                    patchOffer({
                      selected: event.target.checked
                        ? [...offer.selected, item.id]
                        : offer.selected.filter((id) => id !== item.id),
                    })
                  }
                />
                {t.siblings.option(item.description, item.serialNumber)}
              </label>
            ))}
          </fieldset>
          <p aria-live="polite" className="text-xs" style={labelStyle}>
            {t.siblings.selected(offer.selected.length)}
          </p>
          {offer.error !== null && (
            <p role="alert" className="border px-3 py-2 text-sm" style={alertStyle}>
              {offer.error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void linkSelected()}
              aria-disabled={offer.selected.length === 0 || offer.linking || undefined}
              aria-busy={offer.linking || undefined}
              className="btn btn-secondary"
            >
              {offer.linking ? t.siblings.linking : t.siblings.link}
            </button>
            <button
              type="button"
              onClick={() => patch({ offer: null })}
              disabled={offer.linking}
              className="btn btn-ghost"
            >
              {t.siblings.notNow}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
