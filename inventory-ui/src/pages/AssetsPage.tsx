import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import AssetFilterBar from '../components/AssetFilterBar'
import type { AssetFilterPatch, AssetFilterValues } from '../components/AssetFilterBar'
import AssetStatusBadge from '../components/AssetStatusBadge'
import DataTable from '../components/DataTable'
import type { DataTableColumn } from '../components/DataTable'
import EntityBadge from '../components/EntityBadge'
import ErrorBanner from '../components/ErrorBanner'
import LoadMore from '../components/LoadMore'
import PermissionDenied from '../components/PermissionDenied'
import SkeletonListRows from '../components/SkeletonListRows'
import { useInventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { useScope } from '../hooks/useScope'
import { ApiError } from '../lib/api'
import { listAssets } from '../lib/assetsApi'
import { listDirectory } from '../lib/directoryApi'
import { formatDate } from '../lib/dates'
import { formatMoney } from '../lib/money'
import type {
  AssetCategory,
  AssetListFilters,
  AssetListItem,
  AssetStatus,
  DirectoryUser,
  Entity,
  Identity,
} from '../lib/types'
import { fillTemplate } from '../strings/errors'
import { strings } from '../strings'

/**
 * AssetsPage — T1, the Assets list at `/assets` (T29, specs/015-hardware-
 * inventory; design.md § T1, F7; AC-3.7, AC-3.8, AC-10.3, AC-12.10).
 *
 * Reads its filters from the URL search params (shareable, survives back) and
 * writes them back with `replace`, so typing in the search box does not fill
 * the history. Cursor-paged: the first page replaces the list, "Load more"
 * appends. Both capabilities read the list (the shell has already gated the
 * route); `asset:manage` adds the Register button and the holder filter,
 * `ledger:manage` adds the book value column. Read-only: every action lives on
 * the detail screen, so a row has no controls but its link.
 *
 * The request key — the filters plus a retry counter — decides which answer is
 * current: an answer for a superseded key is dropped, so a slow earlier request
 * can never overwrite a newer one.
 */

const PAGE_SIZE = 50

const STATUSES = Object.keys(strings.badges.assetStatus) as AssetStatus[]
const CATEGORIES = Object.keys(strings.categories) as AssetCategory[]
const ENTITIES: Entity[] = ['welld_ch', 'welld_it']

/** A URL search value as text. The router's default parser turns `2026` into a number; this undoes it. */
const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

const asTrimmed = (value: unknown): string => asText(value)?.trim() ?? ''

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => {
  const text = asText(value)
  return allowed.find((candidate) => candidate === text)
}

/** Reads the URL filters, dropping anything that is not a known value so garbage never reaches the API. */
const parseFilters = (search: Record<string, unknown>, canFilterByHolder: boolean): AssetListFilters => {
  const filters: AssetListFilters = {}
  const status = oneOf(search.status, STATUSES)
  const category = oneOf(search.category, CATEGORIES)
  const entity = oneOf(search.entity, ENTITIES)
  const holderUserId = asTrimmed(search.holderUserId)
  const invoiceRef = asTrimmed(search.invoiceRef)
  const q = asTrimmed(search.q)
  if (status) filters.status = status
  if (category) filters.category = category
  if (entity) filters.entity = entity
  if (canFilterByHolder && holderUserId) filters.holderUserId = holderUserId
  if (search.toVerify === true || search.toVerify === 'true') filters.toVerify = true
  if (invoiceRef) filters.invoiceRef = invoiceRef
  if (q) filters.q = q
  return filters
}

const messageForError = (error: unknown): string =>
  error instanceof ApiError ? (error.detail ?? strings.errors.unknown) : strings.errors.network

const holderLabel = (holder: Identity | null): string => {
  if (holder === null) return strings.assets.noHolder
  if (holder.status === 'system') return strings.assets.holderSystem
  if (holder.status === 'deleted') return strings.assets.holderDeleted
  return holder.name ?? strings.assets.holderUnknown
}

type ListOutcome =
  | { key: string; ok: true; items: AssetListItem[]; nextCursor: string | null }
  | { key: string; ok: false; error: unknown }

type MoreState = { key: string; status: 'loading' } | { key: string; status: 'error'; message: string }

type DirectoryOutcome =
  { attempt: number; ok: true; users: DirectoryUser[] } | { attempt: number; ok: false; error: unknown }

type LocationState = { registeredCount?: unknown; focusRegister?: unknown }

export default function AssetsPage() {
  const { canManageAssets, canManageLedger } = useInventoryCapabilities()
  const scope = useScope()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const locationState = useRouterState({ select: (state) => state.location.state }) as LocationState

  const filtersKey = JSON.stringify(parseFilters(search, canManageAssets))
  const filters = useMemo(() => JSON.parse(filtersKey) as AssetListFilters, [filtersKey])

  // --- the list ---------------------------------------------------------
  const [attempt, setAttempt] = useState(0)
  const requestKey = `${attempt}:${filtersKey}`
  const [outcome, setOutcome] = useState<ListOutcome | null>(null)
  const [moreState, setMoreState] = useState<MoreState | null>(null)
  const [moreAnnouncement, setMoreAnnouncement] = useState<{ key: string; text: string } | null>(null)
  const moreController = useRef<AbortController | null>(null)
  const pendingFocusId = useRef<string | null>(null)
  const registerRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    listAssets({ ...filters, limit: PAGE_SIZE }, { signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) {
          setOutcome({ key: requestKey, ok: true, items: result.items, nextCursor: result.nextCursor })
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ key: requestKey, ok: false, error })
      },
    )
    return () => {
      controller.abort()
      moreController.current?.abort()
    }
  }, [filters, requestKey])

  const current = outcome?.key === requestKey ? outcome : null
  const items = current?.ok ? current.items : null
  const nextCursor = current?.ok ? current.nextCursor : null
  const listError = current !== null && !current.ok ? current.error : null
  const more = moreState?.key === requestKey ? moreState : null
  const announcement = moreAnnouncement?.key === requestKey ? moreAnnouncement.text : ''

  const loadMore = () => {
    if (items === null || nextCursor === null || more?.status === 'loading') return
    const controller = new AbortController()
    moreController.current = controller
    setMoreState({ key: requestKey, status: 'loading' })
    listAssets({ ...filters, limit: PAGE_SIZE, cursor: nextCursor }, { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return
        const known = new Set(items.map((item) => item.id))
        const added = result.items.filter((item) => !known.has(item.id))
        if (result.nextCursor === null) {
          pendingFocusId.current = (added.at(-1) ?? items.at(-1))?.id ?? null
        }
        setOutcome((previous) =>
          previous?.ok && previous.key === requestKey
            ? { ...previous, items: [...previous.items, ...added], nextCursor: result.nextCursor }
            : previous,
        )
        setMoreAnnouncement({ key: requestKey, text: strings.assets.moreLoaded(added.length) })
        setMoreState(null)
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setMoreState({ key: requestKey, status: 'error', message: messageForError(error) })
        }
      },
    )
  }

  // After the last page loads the button is gone: focus the last loaded row's link.
  useEffect(() => {
    const id = pendingFocusId.current
    if (id === null) return
    pendingFocusId.current = null
    Array.from(document.querySelectorAll<HTMLElement>('[data-asset-link]'))
      .find((link) => link.dataset.assetLink === id)
      ?.focus()
  })

  // Back from a cancelled register form: land on the button that opened it.
  const returnedFromRegister = locationState.focusRegister === true
  useEffect(() => {
    if (returnedFromRegister && canManageAssets) registerRef.current?.focus()
  }, [returnedFromRegister, canManageAssets])

  // --- the holder directory (asset:manage only) -------------------------
  const [directoryAttempt, setDirectoryAttempt] = useState(0)
  const [directory, setDirectory] = useState<DirectoryOutcome | null>(null)

  useEffect(() => {
    if (!canManageAssets) return
    const controller = new AbortController()
    listDirectory({ signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) setDirectory({ attempt: directoryAttempt, ok: true, users: result.users })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setDirectory({ attempt: directoryAttempt, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [canManageAssets, directoryAttempt])

  const directoryCurrent = canManageAssets && directory?.attempt === directoryAttempt ? directory : null
  const holderLoading = canManageAssets && directoryCurrent === null
  const holderOptions = useMemo(
    () =>
      directoryCurrent?.ok
        ? directoryCurrent.users.map((user) => ({
            id: user.id,
            label: user.name ? `${user.name} (${user.email})` : user.email,
          }))
        : [],
    [directoryCurrent],
  )
  const directoryError =
    directoryCurrent !== null && !directoryCurrent.ok ? directoryCurrent.error : null

  // --- filters <-> URL --------------------------------------------------
  const entitiesInScope = useMemo<Entity[]>(
    () =>
      scope.scope === null
        ? []
        : ENTITIES.filter((e) => scope.scope!.asset.includes(e) || scope.scope!.ledger.includes(e)),
    [scope.scope],
  )

  const values: AssetFilterValues = {
    status: filters.status,
    category: filters.category,
    entity: filters.entity,
    holderUserId: filters.holderUserId,
    toVerify: filters.toVerify === true,
    invoiceRef: filters.invoiceRef ?? '',
    q: filters.q ?? '',
  }

  const writeSearch = (apply: (next: Record<string, unknown>) => void) => {
    void navigate({
      search: ((previous: Record<string, unknown>) => {
        const next = { ...previous }
        apply(next)
        return next
      }) as never,
      replace: true,
    })
  }

  const setFilters = (patch: AssetFilterPatch) =>
    writeSearch((next) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '' || value === false) delete next[key]
        else next[key] = value
      }
    })

  const clearFilters = () => {
    writeSearch((next) => {
      for (const key of ['status', 'category', 'entity', 'holderUserId', 'toVerify', 'invoiceRef', 'q'])
        delete next[key]
    })
    document.getElementById('asset-filter-q')?.focus()
  }

  const activeFilters = Object.keys(filters)
  const onlyToVerify = activeFilters.length === 1 && filters.toVerify === true

  const captionFor = (): string => {
    const t = strings.assets
    const parts: string[] = []
    if (filters.status) parts.push(t.captionFilterItem(t.filters.status, strings.badges.assetStatus[filters.status]))
    if (filters.category) parts.push(t.captionFilterItem(t.filters.category, strings.categories[filters.category]))
    if (filters.entity) parts.push(t.captionFilterItem(t.filters.entity, strings.common.entity[filters.entity]))
    if (filters.holderUserId) parts.push(t.filters.holder)
    if (filters.toVerify) parts.push(t.captionToVerify)
    if (filters.invoiceRef) parts.push(t.captionFilterItem(t.filters.invoiceRef, filters.invoiceRef))
    if (filters.q) parts.push(t.captionFilterItem(t.filters.search, filters.q))
    return parts.length === 0 ? t.caption : t.captionFilters(parts.join(', '))
  }

  // --- the table --------------------------------------------------------
  const showEntity = scope.status === 'ready' && entitiesInScope.length > 1

  const columns: DataTableColumn<AssetListItem>[] = [
    {
      id: 'description',
      header: strings.assets.columns.description,
      rowHeader: true,
      render: (asset) => (
        <div className="flex flex-col gap-0.5">
          <Link
            to="/assets/$id"
            params={{ id: asset.id }}
            data-asset-link={asset.id}
            className="underline underline-offset-2"
          >
            {asset.description}
          </Link>
          <span className="text-xs font-normal" style={{ color: 'var(--soft)' }}>
            {[
              strings.categories[asset.category] ?? asset.category,
              asset.serialNumber,
              asset.invoiceRef ? `${strings.assets.invoiceRefPrefix} ${asset.invoiceRef}` : null,
            ]
              .filter((part): part is string => part !== null && part !== '')
              .join(' · ')}
          </span>
          {asset.toVerify && (
            <span
              className="w-fit rounded px-1.5 py-0.5 text-[11px] font-medium"
              style={{ color: 'var(--org)', backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)' }}
            >
              <span aria-hidden="true">⚑ </span>
              {strings.assets.toVerifyChip}
            </span>
          )}
        </div>
      ),
    },
    ...(showEntity
      ? [
          {
            id: 'entity',
            header: strings.assets.columns.entity,
            render: (asset: AssetListItem) => <EntityBadge entity={asset.entity} />,
          },
        ]
      : []),
    {
      id: 'status',
      header: strings.assets.columns.status,
      render: (asset) => (
        <div className="flex flex-col items-start gap-1">
          <AssetStatusBadge status={asset.status} />
          {asset.pendingAssignment !== null && (
            <span className="text-[11px]" style={{ color: 'var(--soft)' }}>
              {strings.assets.awaitingConfirmation}
            </span>
          )}
        </div>
      ),
    },
    { id: 'holder', header: strings.assets.columns.holder, render: (asset) => holderLabel(asset.holder) },
    { id: 'purchased', header: strings.assets.columns.purchased, render: (asset) => formatDate(asset.purchaseDate) },
    {
      id: 'price',
      header: strings.assets.columns.price,
      numeric: true,
      render: (asset) => formatMoney(asset.purchasePriceCents, asset.currency),
    },
    ...(canManageLedger
      ? [
          {
            id: 'bookValue',
            header: strings.assets.columns.bookValue,
            numeric: true,
            render: (asset: AssetListItem) =>
              asset.ledger ? formatMoney(asset.ledger.bookValueCents, asset.currency) : strings.assets.noBookValue,
          },
        ]
      : []),
  ]

  // --- content ----------------------------------------------------------
  const listStatus = listError instanceof ApiError ? listError.status : null

  let content: ReactNode
  if (listError !== null) {
    if (listStatus === 403) content = <PermissionDenied />
    else if (listStatus === 503) {
      content = <ErrorBanner variant="authUnavailable" onRetry={() => setAttempt((n) => n + 1)} />
    } else {
      content = <ErrorBanner message={messageForError(listError)} onRetry={() => setAttempt((n) => n + 1)} />
    }
  } else if (items === null) {
    content = (
      <div>
        <p role="status" aria-live="polite" className="sr-only" data-testid="assets-loading">
          {strings.assets.loading}
        </p>
        <SkeletonListRows />
      </div>
    )
  } else if (items.length === 0) {
    content =
      activeFilters.length > 0 ? (
        <div data-testid="assets-empty-filtered" className="py-8 text-center text-sm">
          <p style={{ color: 'var(--text)' }}>
            {onlyToVerify ? strings.assets.empty.nothingToVerify : strings.assets.empty.filtered}
          </p>
          {!onlyToVerify && (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-3 border px-3 py-1.5 text-sm font-medium"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              {strings.assets.filters.clear}
            </button>
          )}
        </div>
      ) : (
        <div data-testid="assets-empty" className="py-8 text-center text-sm">
          <p style={{ color: 'var(--text)' }}>
            {canManageAssets ? strings.assets.empty.manager : strings.assets.empty.accountant}
          </p>
          {canManageAssets && (
            <Link
              to="/assets/new"
              className="mt-3 inline-block border px-3 py-1.5 text-sm font-medium"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              {strings.assets.registerAction}
            </Link>
          )}
          <p className="mt-3 text-xs" style={{ color: 'var(--soft)' }}>
            {strings.assets.empty.scopeNote}
          </p>
        </div>
      )
  } else {
    content = (
      <>
        <DataTable
          caption={captionFor()}
          regionLabel={strings.assets.regionLabel}
          columns={columns}
          rows={items}
          getRowKey={(asset) => asset.id}
          testId="assets-table"
        />
        <LoadMore
          hasMore={nextCursor !== null}
          isLoading={more?.status === 'loading'}
          onLoadMore={loadMore}
          label={strings.assets.loadMore}
          loadingLabel={strings.assets.loadingMore}
          announcement={announcement}
          errorMessage={more?.status === 'error' ? more.message : null}
        />
      </>
    )
  }

  const directoryMessage =
    directoryError instanceof ApiError && directoryError.status === 429
      ? directoryError.retryAfterSeconds !== null
        ? fillTemplate(strings.errors.tooManyLookups, { n: directoryError.retryAfterSeconds })
        : strings.errors.tooManyLookupsNoDelay
      : directoryError !== null
        ? messageForError(directoryError)
        : null

  const registeredCount = typeof locationState.registeredCount === 'number' ? locationState.registeredCount : null

  return (
    <section aria-labelledby="assets-heading" data-testid="inventory-assets-page" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 id="assets-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          {strings.assets.heading}
        </h2>
        {canManageAssets && (
          <Link
            ref={registerRef}
            to="/assets/new"
            className="border px-3 py-2 text-sm font-medium"
            style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
          >
            {strings.assets.registerAction}
          </Link>
        )}
      </div>

      {registeredCount !== null && (
        <p role="status" data-testid="assets-flash" className="text-sm" style={{ color: 'var(--grn)' }}>
          {strings.assets.registered(registeredCount)}
        </p>
      )}

      <AssetFilterBar
        values={values}
        entities={entitiesInScope}
        canFilterByHolder={canManageAssets}
        holderOptions={holderOptions}
        holderLoading={holderLoading}
        onChange={setFilters}
      />

      {directoryMessage !== null && (
        <div data-testid="directory-error">
          <ErrorBanner message={directoryMessage} onRetry={() => setDirectoryAttempt((n) => n + 1)} />
        </div>
      )}

      <p
        role="status"
        aria-live="polite"
        data-testid="assets-count"
        className="text-sm"
        style={{ color: 'var(--soft)' }}
      >
        {items !== null && items.length > 0 ? strings.assets.shown(items.length, nextCursor !== null) : ''}
      </p>

      {content}
    </section>
  )
}
