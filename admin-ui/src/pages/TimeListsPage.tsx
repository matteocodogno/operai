import { useCallback, useEffect, useRef, useState } from 'react'
import { usePermissions } from 'shell/session'
import { Banner, Card, PageHeader } from '@operai/ui'
import * as timeListsApi from '../lib/timeListsApi'
import { ApiError } from '../lib/timeListsApi'
import type { TimeCategory, TimeLists, WorkType } from '../lib/timeListsApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import SuccessBanner from '../components/SuccessBanner'
import TimeListCard from '../components/TimeListCard'
import TimeListItemDialog from '../components/TimeListItemDialog'
import type { TimeListItemFailure, TimeListItemValues } from '../components/TimeListItemDialog'
import type { TimeListRow, TimeListScope } from '../components/TimeListCard'
import { strings } from '../strings'

const t = strings.timeLists

/**
 * TimeListsPage — the admin screen for the categories and the two work-type lists people pick from
 * when they record hours (specs/029-time-tracking/tasks.md: T31 the frame and its states, refs
 * AC-3.3, AC-5.5; T32 the cards and what they do, refs AC-3.1, AC-3.2, AC-3.4, AC-3.7, AC-3.8;
 * design.md S5). The shape is the one of MileageRatesPage (ADR-0023): hours-api is called directly
 * through `shell/session`, and the page is a state union.
 *
 * States, exactly one at a time:
 *   denied     — the caller does not hold `time-list:manage`, or hours-api answered 403: `PermissionDenied`
 *                in place of the cards, focused. Nothing is fetched without the permission.
 *   loading    — three skeleton cards and one polite announcement.
 *   error      — `503 authz_unavailable`: the "Authorization service unavailable" banner; any other
 *                failure: the warning banner. Both with Retry, which asks again.
 *   loaded     — three `TimeListCard`s, with what the last change said above them.
 *
 * What a change does (T32). Retire and Restore are one idempotent `PATCH { retired }` with no
 * dialog, busy on that row only; Add and Rename are `TimeListItemDialog`. A success is shown from
 * the server's own answer (the row takes it and moves; an added item joins its list), never by
 * asking for the lists again, and is said in a polite banner. A failure leaves everything as it
 * was: 403 is the permission-denied state (in a dialog, an inline line), 503 `authz_unavailable`
 * and any other failure are a banner whose Retry re-sends the same PATCH, 404 means the item is
 * gone so the lists reload with an info banner, and 409 `name_taken` is the Name field's error.
 * Names are data: shown exactly as typed, whatever the language around them (AC-3.8).
 *
 * Why the permission is read here and not only from the API: hours-api serves `GET /time-lists` to
 * any JWT (the entry dialog reads the same lists), so the read never answers 403 for a missing
 * `time-list:manage`; only the writes are gated. The page decides from `usePermissions()` (the same
 * seam `SectionNav` uses, INC-32). The shell resolves the permissions before it mounts a gated
 * remote, so they are already there when this renders; an empty result (a failed `/authz/me`) holds
 * no grant and fails CLOSED, as the nav link does. UX only: hours-api enforces the permission live on
 * every list write (plan.md § Lists), and a 403 from it lands in the same state.
 *
 * Fetch pattern: an explicit Promise chain rather than an async helper called from the effect, for
 * `react-hooks/set-state-in-effect`, as in MileageRatesPage and RolesPage.
 */

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; lists: TimeLists }
  | { status: 'error'; cause: 'authz' | 'load' }
  | { status: 'forbidden' }

/** Whether `permissions` contains the given (resource, action) pair. */
const hasCapability = (
  permissions: { resource: string; action: string }[],
  resource: string,
  action: string,
): boolean => permissions.some((p) => p.resource === resource && p.action === action)

/** What a failed load becomes. Only a 503 that says it was the authorization check is that banner. */
const failureState = (error: unknown): ListState => {
  if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' }
  if (error instanceof ApiError && error.status === 503 && error.code === 'authz_unavailable') {
    return { status: 'error', cause: 'authz' }
  }
  return { status: 'error', cause: 'load' }
}

/** What a failed change (retire, restore, add or rename) means to the screen. A 409 is the dialog's own. */
type ChangeFailure = 'forbidden' | 'authz' | 'gone' | 'other'

const classifyFailure = (error: unknown): ChangeFailure => {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden'
    if (error.status === 503 && error.code === 'authz_unavailable') return 'authz'
    if (error.status === 404) return 'gone'
  }
  return 'other'
}

/** A retire or restore that did not happen, kept so Retry can send the very same PATCH. */
type RowFailure = { scope: TimeListScope; id: string; retired: boolean; cause: 'authz' | 'other' }

type Notice = { seq: number; tone: 'success' | 'info'; message: string }

/** One item of one list, as a key for "this row is busy". The scope is in it: the lists are separate tables, so an id is only unique inside its own. */
const rowKey = (scope: TimeListScope, id: string): string => `${scope}:${id}`

const withKey = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => new Set(set).add(key)

const withoutKey = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(set)
  next.delete(key)
  return next
}

/**
 * The lists with one item replaced by the server's answer (in the server's order) or appended to its
 * list — never a refetch. The one place that knows a category and a work type live in different
 * arrays.
 */
const withItem = (
  lists: TimeLists,
  scope: TimeListScope,
  item: TimeCategory | WorkType,
  how: 'replace' | 'append',
): TimeLists => {
  const change = <T extends { id: string }>(items: T[], next: T): T[] =>
    how === 'append' ? [...items, next] : items.map((existing) => (existing.id === next.id ? next : existing))
  if (scope === 'categories') return { ...lists, categories: change(lists.categories, item as TimeCategory) }
  return { ...lists, workTypes: { ...lists.workTypes, [scope]: change(lists.workTypes[scope], item as WorkType) } }
}

const CARD_TITLES = [t.cards.categories, t.cards.projectWorkTypes, t.cards.dealWorkTypes]

export default function TimeListsPage() {
  // Derived at render; empty until the permissions resolve and on any failure (no grants).
  const { permissions } = usePermissions()
  const canManage = hasCapability(permissions, 'time-list', 'manage')

  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  // The retire / restore requests in flight, by `rowKey`: busy on that row only (design.md S5).
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  // What the last action says, above the cards: a success, or the info that an item is gone. `seq`
  // gives each its own banner (its own 3 s timer) even when two messages are alike.
  const [notice, setNotice] = useState<Notice | null>(null)
  const noticeSeq = useRef(0)
  const announce = useCallback((tone: Notice['tone'], message: string) => {
    noticeSeq.current += 1
    setNotice({ seq: noticeSeq.current, tone, message })
  }, [])
  // The last retire or restore that failed, with Retry.
  const [failure, setFailure] = useState<RowFailure | null>(null)
  // The Add / Rename dialog: for a new item of `scope`, or for renaming `item`.
  const [dialog, setDialog] = useState<{ scope: TimeListScope; item?: TimeListRow } | null>(null)
  // The item whose new toggle button should take focus once the row has moved: one shot.
  const [focusToggle, setFocusToggle] = useState<{ scope: TimeListScope; id: string } | null>(null)
  const handleToggleFocused = useCallback(() => setFocusToggle(null), [])

  useEffect(() => {
    if (!canManage) return
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => timeListsApi.listTimeLists())
      .then((lists) => {
        if (!cancelled) setState({ status: 'loaded', lists })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState(failureState(error))
      })

    return () => {
      cancelled = true
    }
  }, [canManage, reloadToken])

  // Retry replaces its own banner with the loading state; without a deliberate move, focus would fall
  // to <body> and the next Tab would start from the top of the document (design-system.md § a11y).
  const headingRef = useRef<HTMLHeadingElement>(null)
  const handleRetry = useCallback(() => {
    headingRef.current?.focus()
    setReloadToken((token) => token + 1)
  }, [])

  const denied = !canManage || state.status === 'forbidden'

  /** Shows an item the server answered with, when the lists are showing. */
  const showItem = useCallback((scope: TimeListScope, item: TimeCategory | WorkType, how: 'replace' | 'append') => {
    setState((current) =>
      current.status === 'loaded' ? { status: 'loaded', lists: withItem(current.lists, scope, item, how) } : current,
    )
  }, [])

  /**
   * Retire (`retired: true`) or restore (`false`) one item: one idempotent PATCH, which is also what a
   * Retry of a failed one sends. Busy on that row only; the row takes the server's answer.
   */
  const sendRetired = (scope: TimeListScope, id: string, retired: boolean) => {
    const key = rowKey(scope, id)
    if (busy.has(key)) return
    setBusy((current) => withKey(current, key))
    // This item's own earlier failure is over once it is asked again.
    setFailure((current) => (current?.scope === scope && current.id === id ? null : current))
    const request =
      scope === 'categories'
        ? timeListsApi.updateCategory(id, { retired })
        : timeListsApi.updateWorkType(id, { retired })
    request.then(
      (updated) => {
        setBusy((current) => withoutKey(current, key))
        showItem(scope, updated, 'replace')
        const done = t.done[retired ? 'retired' : 'restored']
        announce('success', scope === 'categories' ? done.category(updated.name) : done.workType(updated.name))
        setFocusToggle({ scope, id })
      },
      (error: unknown) => {
        setBusy((current) => withoutKey(current, key))
        const kind = classifyFailure(error)
        if (kind === 'forbidden') {
          setState({ status: 'forbidden' })
        } else if (kind === 'gone') {
          announce('info', t.gone)
          handleRetry()
        } else {
          // An error is never shown beside the "retired" of an earlier action.
          setNotice(null)
          setFailure({ scope, id, retired, cause: kind })
        }
      },
    )
  }

  /** What the Add / Rename dialog sends. `null` is success (the dialog is closed here); else why not. */
  const submitItem = async (
    scope: TimeListScope,
    item: TimeListRow | undefined,
    values: TimeListItemValues,
  ): Promise<TimeListItemFailure | null> => {
    try {
      if (item === undefined) {
        const created =
          scope === 'categories'
            ? await timeListsApi.createCategory({ name: values.name, requiresNote: values.requiresNote })
            : await timeListsApi.createWorkType({ list: scope, name: values.name })
        showItem(scope, created, 'append')
        announce('success', t.done.added[scope](created.name))
      } else {
        // Only what changed: a stale "needs a note" must not overwrite another admin's change.
        const renamed = values.name !== item.name
        const noteChanged = values.requiresNote !== undefined && values.requiresNote !== item.requiresNote
        if (!renamed && !noteChanged) {
          setDialog(null)
          return null
        }
        const updated =
          scope === 'categories'
            ? await timeListsApi.updateCategory(item.id, {
                ...(renamed ? { name: values.name } : {}),
                ...(noteChanged ? { requiresNote: values.requiresNote } : {}),
              })
            : await timeListsApi.updateWorkType(item.id, { name: values.name })
        showItem(scope, updated, 'replace')
        announce(
          'success',
          renamed
            ? t.done.renamed(updated.name)
            : values.requiresNote
              ? t.done.noteRequired(updated.name)
              : t.done.noteOptional(updated.name),
        )
      }
      setDialog(null)
      return null
    } catch (error) {
      const kind = classifyFailure(error)
      if (kind === 'gone' && item !== undefined) {
        setDialog(null)
        announce('info', t.gone)
        handleRetry()
        return null
      }
      if (error instanceof ApiError && error.status === 409 && error.code === 'name_taken') return 'name_taken'
      if (kind === 'forbidden' || kind === 'authz') return kind
      return 'other'
    }
  }

  const renderCard = (scope: TimeListScope, title: string, rows: readonly TimeListRow[]) => (
    <TimeListCard
      scope={scope}
      title={title}
      rows={rows}
      isBusy={(id) => busy.has(rowKey(scope, id))}
      focusToggleId={focusToggle?.scope === scope ? focusToggle.id : null}
      onToggleFocused={handleToggleFocused}
      onAdd={() => setDialog({ scope })}
      onRename={(row) => setDialog({ scope, item: row })}
      onToggleRetired={(row) => sendRetired(scope, row.id, !row.retired)}
    />
  )

  return (
    <section aria-labelledby="time-lists-heading" data-testid="time-lists-page">
      <PageHeader
        title={t.heading}
        titleId="time-lists-heading"
        description={t.description}
        headingRef={headingRef}
        focusableHeading
      />

      <div className="flex flex-col gap-4">
        {denied && <PermissionDenied headingLevel={3} title={t.forbidden.title} message={t.forbidden.body} />}

        {!denied &&
          state.status === 'loading' &&
          CARD_TITLES.map((title, index) => (
            <Card key={title} title={title}>
              {/* One announcement for the whole screen, on the first card. */}
              <SkeletonListRows rows={3} label={index === 0 ? t.loading : null} />
            </Card>
          ))}

        {!denied && state.status === 'error' && state.cause === 'authz' && (
          <ErrorBanner title={t.authzUnavailable.title} message={t.authzUnavailable.body} onRetry={handleRetry} />
        )}

        {!denied && state.status === 'error' && state.cause === 'load' && (
          <ErrorBanner message={t.loadError} onRetry={handleRetry} />
        )}

        {!denied && state.status === 'loaded' && (
          <div data-testid="time-lists-loaded" className="flex flex-col gap-4">
            {failure && (
              <ErrorBanner
                tone={failure.cause === 'authz' ? 'warning' : 'danger'}
                title={failure.cause === 'authz' ? t.authzUnavailable.title : undefined}
                message={failure.cause === 'authz' ? t.authzUnavailable.actionBody : t.failed}
                onRetry={() => sendRetired(failure.scope, failure.id, failure.retired)}
                onDismiss={() => setFailure(null)}
              />
            )}
            {notice?.tone === 'success' && (
              <SuccessBanner
                key={notice.seq}
                message={notice.message}
                onDismiss={() => setNotice(null)}
                testId="time-lists-notice"
                // The message holds a name, which may be 80 characters with no space in it.
                className="wrap-anywhere"
              />
            )}
            {notice?.tone === 'info' && (
              <Banner
                key={notice.seq}
                tone="info"
                compact
                onDismiss={() => setNotice(null)}
                dismissLabel={strings.common.actions.dismiss}
                dismissTestId="time-lists-notice-dismiss"
                data-testid="time-lists-notice-banner"
              >
                <span data-testid="time-lists-notice">{notice.message}</span>
              </Banner>
            )}
            {renderCard('categories', t.cards.categories, state.lists.categories)}
            {/* Side by side only where each table fits its card (about 450px): from 1024px up. */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {renderCard('project', t.cards.projectWorkTypes, state.lists.workTypes.project)}
              {renderCard('deal', t.cards.dealWorkTypes, state.lists.workTypes.deal)}
            </div>
          </div>
        )}

        {!denied && state.status === 'loaded' && dialog && (
          <TimeListItemDialog
            key={`${dialog.scope}:${dialog.item?.id ?? 'new'}`}
            scope={dialog.scope}
            item={dialog.item}
            onSubmit={(values) => submitItem(dialog.scope, dialog.item, values)}
            onCancel={() => setDialog(null)}
          />
        )}
      </div>
    </section>
  )
}
