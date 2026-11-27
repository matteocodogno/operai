import { useCallback, useEffect, useState } from 'react'
import { Navigate, Outlet, useRouterState } from '@tanstack/react-router'
import { ToolLayout } from '@operai/ui'
import { usePermissions } from 'shell/session'
import SectionNav from './SectionNav'
import ErrorBanner from './ErrorBanner'
import PermissionDenied from './PermissionDenied'
import SkeletonListRows from './SkeletonListRows'
import { getManageable } from '../lib/legalEntitiesApi'
import type { LegalEntityId } from '../lib/legalEntityModel'
import { strings } from '../strings'

/**
 * AdminShell — admin-ui's own root layout, wired as the inner router's root
 * route component (see ../router.tsx's `createRootRoute({ component:
 * AdminShell })`). This is "the App root that renders the nav + an
 * `<Outlet/>`" this task's description asks for: a heading identifying the
 * tool, the section nav (./SectionNav.tsx), and the `<Outlet/>` the section
 * routes (../pages/*Page.tsx) and the not-found fallback
 * (../pages/NotFoundPage.tsx) render into.
 *
 * No suite chrome duplicated here (Header/Footer/UserMenu/ThemeToggle,
 * sign-out, …) — per the plan's federation contract (ADR 20260709-suite-frontend-module-federation) and
 * design.md's component inventory ("Shell chrome … Reuse (shared),
 * unchanged … none of this feature's flows touch chrome"), that chrome
 * already exists once in the shell and wraps admin-ui when it's mounted
 * there; duplicating any of it here (including an identity/sign-out
 * affordance) would be a second, redundant copy of chrome the shell already
 * owns. No auth guard either, same rationale as estimai-ui's router
 * (specs/20260709-suite-shell, AC-2.3): the shell's own `_authed` guard and its per-tool `access` guard
 * already run before admin-ui is ever mounted.
 *
 * Sections by capability (T35, specs/20261117-legal-entities, AC-4.3, plan decision 5 and E7, design S8).
 * The shell lets a person in with `apps ∋ "admin"`, which `/authz/me` also derives for a manager of a legal
 * entity who holds no `admin:access`. So here, and only here, the sections are told apart:
 *   - Roles, Departments, Users, Audit: `admin:access` in `usePermissions().permissions` (today's meaning).
 *   - Legal entities: `GET /legal-entities/manageable` is not empty. Any failure of that call means "may
 *     not" (fails closed) and is shown, with a Retry, where the answer is needed; it never opens a page.
 * The index, and the URL of a section the person may not use, redirect (replace, no announcement: DR-7) to the
 * first section they may use. A person without `admin:access` waits for `manageable` before anything is
 * decided (skeleton tab, hidden live "Loading…"), because nothing else tells a manager-only person where to
 * land; a failed answer keeps them in place with the Banner, never redirects them to a page that would 403.
 *
 * "Permissions not resolved yet" is `apps` without `"admin"`: every person who can mount this module holds it
 * (the shell's guard), while the hook's empty first value (a cold standalone start) has none; deciding on that
 * empty value would send an administrator away from their own section.
 *
 * Frame from @operai/ui (ADR 20261031-shared-ui-library-consumed-as-source, INC-12): `ToolLayout` renders the tool
 * title (h1), the tabs and the page column — a <div>, never a <main>: the
 * shell's layout owns the page's one main landmark.
 */

type ManageableState = { status: 'pending' } | { status: 'failed' } | { status: 'ready'; entities: LegalEntityId[] }

/** `GET /legal-entities/manageable` for this mount, with a Retry. Read at most once per attempt. */
function useManageable() {
  const [state, setState] = useState<ManageableState>({ status: 'pending' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    getManageable().then(
      (entities) => {
        if (current) setState({ status: 'ready', entities })
      },
      () => {
        if (current) setState({ status: 'failed' })
      },
    )
    return () => {
      current = false
    }
  }, [attempt])

  const retry = useCallback(() => {
    setState({ status: 'pending' })
    setAttempt((n) => n + 1)
  }, [])

  return { state, retry }
}

type Area = 'index' | 'admin' | 'legal-entities' | 'other'

const ADMIN_SEGMENTS: ReadonlySet<string> = new Set(['roles', 'departments', 'teams', 'users', 'audit'])

/** Which section the current match belongs to, by route id (independent of the router's basepath). */
const areaOf = (routeId: string): Area => {
  if (routeId === '/') return 'index'
  const first = routeId.split('/')[1] ?? ''
  if (first === 'legal-entities') return 'legal-entities'
  return ADMIN_SEGMENTS.has(first) ? 'admin' : 'other'
}

type Gate =
  | { kind: 'render' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'denied' }
  | { kind: 'redirect'; to: '/roles' | '/legal-entities' }

const gateFor = (area: Area, isAdmin: boolean, manageable: ManageableState): Gate => {
  // An administrator needs nothing from `manageable` to see or leave any section but Legal entities.
  if (isAdmin && area === 'index') return { kind: 'redirect', to: '/roles' }
  if (isAdmin && area !== 'legal-entities') return { kind: 'render' }

  if (manageable.status === 'pending') return { kind: 'loading' }
  if (manageable.status === 'failed') return { kind: 'failed' }

  const canManage = manageable.entities.length > 0
  if (area === 'legal-entities') {
    if (canManage) return { kind: 'render' }
    return isAdmin ? { kind: 'redirect', to: '/roles' } : { kind: 'denied' }
  }
  // Not an administrator, on the index, an admin section or a path nothing matches.
  if (!canManage) return { kind: 'denied' }
  return area === 'other' ? { kind: 'render' } : { kind: 'redirect', to: '/legal-entities' }
}

export default function AdminShell() {
  const { apps, permissions } = usePermissions()
  const { state: manageable, retry } = useManageable()
  const routeId = useRouterState({ select: (s) => s.matches[s.matches.length - 1]?.routeId ?? '__root__' })

  const resolved = apps.includes('admin')
  const isAdmin = resolved && permissions.some((p) => p.resource === 'admin' && p.action === 'access')
  const gate: Gate = resolved ? gateFor(areaOf(routeId), isAdmin, manageable) : { kind: 'loading' }

  const legalEntities =
    manageable.status === 'pending' || !resolved
      ? 'resolving'
      : manageable.status === 'ready' && manageable.entities.length > 0
        ? 'shown'
        : 'hidden'

  return (
    <ToolLayout title={strings.nav.toolTitle} nav={<SectionNav showAdmin={isAdmin} legalEntities={legalEntities} />}>
      {gate.kind === 'render' && <Outlet />}
      {gate.kind === 'loading' && <SkeletonListRows rows={3} label={strings.legalEntities.sections.loading} />}
      {gate.kind === 'failed' && <ErrorBanner message={strings.legalEntities.sections.failed} onRetry={retry} />}
      {gate.kind === 'denied' && <PermissionDenied />}
      {gate.kind === 'redirect' && <Navigate to={gate.to} replace />}
    </ToolLayout>
  )
}
