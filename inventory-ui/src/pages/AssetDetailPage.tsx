import { Link, useParams, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import AssetActions from '../components/AssetActions'
import AssetStatusBadge from '../components/AssetStatusBadge'
import CurrencyBadge from '../components/CurrencyBadge'
import EditAssetDialog from '../components/EditAssetDialog'
import EntityBadge from '../components/EntityBadge'
import ErrorBanner from '../components/ErrorBanner'
import GuardrailDialog from '../components/GuardrailDialog'
import HistoryTimeline from '../components/HistoryTimeline'
import InvoiceFilePanel from '../components/InvoiceFilePanel'
import LedgerBlock from '../components/LedgerBlock'
import PermissionDenied from '../components/PermissionDenied'
import SkeletonListRows from '../components/SkeletonListRows'
import { useInventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { ApiError } from '../lib/api'
import { getAsset, updateAsset } from '../lib/assetsApi'
import { formatDate } from '../lib/dates'
import { formatMoney } from '../lib/money'
import { toInventoryError } from '../lib/types'
import type { AssetView, Identity } from '../lib/types'
import { strings } from '../strings'

/**
 * AssetDetailPage — T2, one asset (T32, specs/015-hardware-inventory; design.md
 * § T2, F6, § Accessibility "T2 detail"; AC-1.9, AC-3.6, AC-10.1).
 *
 * The page is a FRAME: it owns the load (and every load failure state), the
 * summary (header, facts, disposal banner), the one polite status line, heading
 * focus, the edit entry ("Edit details" / "Edit invoice details" and "Mark as
 * verified") and four region components — `AssetActions` (T33), `LedgerBlock`
 * (T34), `InvoiceFilePanel` (T35), `HistoryTimeline` (T36) — each in its own file
 * with its final props, so no later task edits this file. A region whose
 * capability is not held is not rendered: the ledger block needs
 * `ledger:manage`; the actions region is rendered for either capability (its
 * callouts are read-only for an accountant) and gates its controls itself.
 * A disposed asset is read-only: no edit entry, no actions region.
 *
 * Regions talk back through three seams: `onChanged(updated | null)` — a fresh
 * `AssetView` replaces the page's asset, `null` reloads it in place without a
 * skeleton; `announce(message)` — the status line; `focusHeading()`. Every
 * change also bumps `revision`, which the history timeline reloads on.
 */

type Outcome = { requestKey: string; ok: true; asset: AssetView } | { requestKey: string; ok: false; error: unknown }

const holderLabel = (holder: Identity | null): string => {
  if (holder === null) return strings.assetDetail.none
  if (holder.status === 'system') return strings.assets.holderSystem
  if (holder.status === 'deleted') return strings.assets.holderDeleted
  return holder.name ?? strings.assets.holderUnknown
}

const orDash = (value: string | null): string => (value === null || value === '' ? strings.assetDetail.none : value)

/** The guardrail copy for a conflict that came from a write. */
const conflictMessage = (kind: 'asset_disposed' | 'not_found'): string =>
  kind === 'asset_disposed' ? strings.errors.asset_disposed : strings.assetDetail.notFound.body

function NotFound() {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  const t = strings.assetDetail.notFound
  return (
    <section aria-labelledby="asset-not-found-heading" data-testid="asset-not-found" className="flex flex-col gap-3">
      <h2
        id="asset-not-found-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold focus:outline-none"
        style={{ fontFamily: 'var(--disp)' }}
      >
        {t.heading}
      </h2>
      <p className="text-sm" style={{ color: 'var(--soft)' }}>
        {t.body}
      </p>
      <Link to="/assets" className="text-sm underline" style={{ color: 'var(--acc)' }}>
        {t.back}
      </Link>
    </section>
  )
}

export default function AssetDetailPage() {
  const { id = '' } = useParams({ strict: false }) as { id?: string }
  const locationState = useRouterState({ select: (state) => state.location.state }) as { registeredCount?: unknown }
  const capabilities = useInventoryCapabilities()

  const [attempt, setAttempt] = useState(0)
  const requestKey = `${id}:${attempt}`
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [revision, setRevision] = useState(0)
  const [statusLine, setStatusLine] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [guardrail, setGuardrail] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState(false)

  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocus = useRef(false)
  /** Arrived from the register page: announce and focus once, after the first load. */
  const announceRegistered = useRef(typeof locationState.registeredCount === 'number')
  /** Orders loads and writes: only the latest outcome is applied. */
  const sequence = useRef(0)
  const alive = useRef(new AbortController())

  useEffect(() => {
    const controller = new AbortController()
    alive.current = controller
    const mine = ++sequence.current
    getAsset(id, { signal: controller.signal }).then(
      (asset) => {
        if (controller.signal.aborted || mine !== sequence.current) return
        setOutcome({ requestKey, ok: true, asset })
        if (announceRegistered.current) {
          announceRegistered.current = false
          pendingFocus.current = true
          setStatusLine(strings.assetDetail.registered)
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted && mine === sequence.current) setOutcome({ requestKey, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [id, requestKey])

  // Move focus once the heading exists.
  useEffect(() => {
    if (pendingFocus.current && headingRef.current) {
      pendingFocus.current = false
      headingRef.current.focus()
    }
  })

  const current = outcome?.requestKey === requestKey ? outcome : null
  const asset = current?.ok ? current.asset : null
  const loadError = current !== null && !current.ok ? current.error : null

  /** Applies a fresh asset from a write, discarding any older load still in flight. */
  const apply = (fresh: AssetView) => {
    sequence.current += 1
    setNotice(null)
    setRevision((n) => n + 1)
    setOutcome({ requestKey, ok: true, asset: fresh })
  }

  /** Reloads in place, without a skeleton. A 403/404 replaces the page; any other failure keeps the asset and says so. */
  const reload = () => {
    const mine = ++sequence.current
    setRevision((n) => n + 1)
    getAsset(id, { signal: alive.current.signal }).then(
      (fresh) => {
        if (alive.current.signal.aborted || mine !== sequence.current) return
        setNotice(null)
        setOutcome({ requestKey, ok: true, asset: fresh })
      },
      (error: unknown) => {
        if (alive.current.signal.aborted || mine !== sequence.current) return
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
          setOutcome({ requestKey, ok: false, error })
        } else {
          setNotice(strings.assetDetail.refreshFailed)
        }
      },
    )
  }

  const onChanged = (updated: AssetView | null) => (updated === null ? reload() : apply(updated))
  const announce = (message: string) => setStatusLine(message)
  const focusHeading = () => headingRef.current?.focus()

  const conflict = (kind: 'asset_disposed' | 'not_found') => {
    setEditing(false)
    setGuardrail(conflictMessage(kind))
  }

  const markVerified = async () => {
    if (asset === null || verifying) return
    setVerifying(true)
    setVerifyError(false)
    try {
      apply(await updateAsset(asset.id, { toVerify: false }))
      setStatusLine(strings.assetDetail.verified)
    } catch (error) {
      const known = toInventoryError(error)
      if (known?.code === 'asset_disposed') conflict('asset_disposed')
      else if (error instanceof ApiError && error.status === 404) conflict('not_found')
      else setVerifyError(true)
    } finally {
      setVerifying(false)
    }
  }

  const t = strings.assetDetail

  if (loadError instanceof ApiError && loadError.status === 404) return <NotFound />
  if (loadError instanceof ApiError && loadError.status === 403) return <PermissionDenied />
  if (loadError !== null) {
    const retry = () => setAttempt((n) => n + 1)
    return loadError instanceof ApiError && loadError.status === 503 ? (
      <ErrorBanner variant="authUnavailable" onRetry={retry} />
    ) : (
      <ErrorBanner
        message={loadError instanceof ApiError ? (loadError.detail ?? strings.errors.unknown) : strings.errors.network}
        onRetry={retry}
      />
    )
  }
  if (asset === null) {
    return (
      <div data-testid="inventory-asset-detail-page">
        <p role="status" aria-live="polite" className="sr-only" data-testid="asset-loading">
          {t.loading}
        </p>
        <SkeletonListRows />
      </div>
    )
  }

  const disposed = asset.status === 'disposed'
  const canEdit = !disposed && (capabilities.canManageAssets || capabilities.canManageLedger)
  const sectionStyle = { fontFamily: 'var(--disp)', color: 'var(--text)' }

  const fact = (label: string, value: string) => (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs" style={{ color: 'var(--soft)' }}>
        {label}
      </dt>
      <dd className="text-sm" style={{ color: 'var(--text)' }}>
        {value}
      </dd>
    </div>
  )

  return (
    <section aria-labelledby="asset-heading" data-testid="inventory-asset-detail-page" className="flex flex-col gap-6">
      <header data-testid="asset-header" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="asset-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold focus:outline-none focus-visible:ring-2"
            style={sectionStyle}
          >
            {asset.description}
          </h2>
          {canEdit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="border px-3 py-2 text-sm font-medium"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              {capabilities.canManageAssets ? t.editAction : t.editInvoiceAction}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AssetStatusBadge status={asset.status} />
          <EntityBadge entity={asset.entity} />
          <CurrencyBadge currency={asset.currency} />
          {asset.toVerify && (
            <span
              data-testid="to-verify-chip"
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium"
              style={{
                color: 'var(--text)',
                borderColor: 'var(--org)',
                backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)',
              }}
            >
              <span aria-hidden="true" style={{ color: 'var(--org)' }}>
                ⚑
              </span>
              <span>{t.toVerify.chip}</span>
            </span>
          )}
        </div>
        {asset.toVerify && (
          <div className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--soft)' }}>
            <span>{t.toVerify.hint}</span>
            {capabilities.canManageAssets && !disposed && (
              <button
                type="button"
                onClick={() => void markVerified()}
                disabled={verifying}
                aria-busy={verifying || undefined}
                className="border px-2.5 py-1 text-xs font-medium disabled:opacity-40"
                style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
              >
                {verifying ? t.toVerify.acting : t.toVerify.action}
              </button>
            )}
            {verifyError && (
              <span role="alert" data-testid="to-verify-error" style={{ color: 'var(--red)' }}>
                {t.toVerify.failed}
              </span>
            )}
          </div>
        )}
      </header>

      <p role="status" aria-live="polite" data-testid="asset-status" className="sr-only">
        {statusLine}
      </p>

      {notice !== null && (
        <p
          role="alert"
          data-testid="asset-notice"
          className="rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--org)', color: 'var(--org)' }}
        >
          {notice}
        </p>
      )}

      {disposed && asset.disposal !== null && (
        <div
          data-testid="asset-disposed-banner"
          className="flex flex-col gap-1 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--rule)', color: 'var(--text)' }}
        >
          <p>{t.disposed.banner(formatDate(asset.disposal.disposedOn))}</p>
          <p style={{ color: 'var(--soft)' }}>{t.disposed.reason(strings.disposalReasons[asset.disposal.reason])}</p>
        </div>
      )}

      {!disposed && (
        <AssetActions
          asset={asset}
          capabilities={capabilities}
          onChanged={onChanged}
          announce={announce}
          focusHeading={focusHeading}
        />
      )}

      <section aria-labelledby="asset-facts-heading" data-testid="asset-facts" className="flex flex-col gap-3">
        <h3 id="asset-facts-heading" className="text-base font-semibold" style={sectionStyle}>
          {t.facts.heading}
        </h3>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {fact(t.facts.category, strings.categories[asset.category])}
          {fact(t.facts.serial, orDash(asset.serialNumber))}
          {fact(t.facts.purchaseDate, formatDate(asset.purchaseDate))}
          {fact(t.facts.purchasePrice, formatMoney(asset.purchasePriceCents, asset.currency))}
          {fact(t.facts.holder, holderLabel(asset.holder))}
          {fact(t.facts.location, orDash(asset.locationNote))}
          {fact(t.facts.supplier, orDash(asset.supplier))}
        </dl>
      </section>

      <InvoiceFilePanel
        asset={asset}
        capabilities={capabilities}
        onChanged={onChanged}
        announce={announce}
        focusHeading={focusHeading}
      />

      {capabilities.canManageLedger && (
        <LedgerBlock
          asset={asset}
          capabilities={capabilities}
          onChanged={onChanged}
          announce={announce}
          focusHeading={focusHeading}
        />
      )}

      <HistoryTimeline asset={asset} capabilities={capabilities} revision={revision} />

      {editing && (
        <EditAssetDialog
          asset={asset}
          capabilities={capabilities}
          onSaved={(saved) => {
            setEditing(false)
            apply(saved)
            setStatusLine(t.saved)
          }}
          onCancel={() => setEditing(false)}
          onConflict={conflict}
        />
      )}

      {guardrail !== null && (
        <GuardrailDialog
          title={t.conflictTitle}
          message={guardrail}
          onAcknowledge={() => {
            setGuardrail(null)
            reload()
          }}
        />
      )}
    </section>
  )
}
