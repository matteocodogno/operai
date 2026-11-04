import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import type { RouteComponent, RouterHistory } from '@tanstack/react-router'
import ErasePage from './pages/ErasePage'
import MeetingPage from './pages/MeetingPage'
import MeetingsListPage from './pages/MeetingsListPage'
import NewMeetingPage from './pages/NewMeetingPage'
import NotFoundPage from './pages/NotFoundPage'
import TemplateEditorPage from './pages/TemplateEditorPage'
import TemplatesPage from './pages/TemplatesPage'
import TemplateViewPage from './pages/TemplateViewPage'

/**
 * meetings-ui's two inner routers (specs/021-meetings design.md § Conventions › Routes). No auth
 * guard and no chrome (ADR-0006): `Root` is the layout seam, `MeetingsShell` for `./App` and
 * `MyMeetingsShell` for `./MyMeetings`; tests may render a page under a bare `<Outlet/>`.
 *
 * `./App`, basepath `/meetings` (gated by `meetings:access` in the shell):
 *
 *   /                          Meetings list            /templates            Templates list
 *   /new                       New meeting              /templates/new        New template
 *   /m/$id                     Meeting page             /templates/$id        Template view
 *                                                       /templates/$id/edit   Template editor
 *                                                       /erase                Erase (meeting:erase)
 *
 * `./MyMeetings`, basepath `/my-meetings` (UNGATED, ADR-0045; every signed-in user): `/` and `/m/$id`.
 *
 * Both lists are the router's `/`, so a page links to its list with `to="/"` and the basepath does
 * the rest. There is deliberately no `declare module … Register`: two routers with different trees
 * cannot both be the registered one, and the pages use string paths and `useParams({ strict: false })`.
 */

/** The optional `history` is for tests (a memory history); production uses the browser's. */
export function createAppRouter(basepath?: string, Root: RouteComponent = Outlet, history?: RouterHistory) {
  const rootRoute = createRootRoute({ component: Root })

  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <MeetingsListPage mine={false} />,
  })
  // Sibling of `/m/$id`, not a child: the static `new` segment outranks any param (`/new` is never read as an id).
  const newRoute = createRoute({ getParentRoute: () => rootRoute, path: '/new', component: NewMeetingPage })
  const meetingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/m/$id',
    component: () => <MeetingPage listPath="/meetings" />,
  })
  const templatesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/templates', component: TemplatesPage })
  const templateNewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/templates/new',
    component: TemplateEditorPage,
  })
  const templateRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/templates/$id',
    component: TemplateViewPage,
  })
  const templateEditRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/templates/$id/edit',
    component: TemplateEditorPage,
  })
  const eraseRoute = createRoute({ getParentRoute: () => rootRoute, path: '/erase', component: ErasePage })

  const routeTree = rootRoute.addChildren([
    listRoute,
    newRoute,
    meetingRoute,
    templatesRoute,
    templateNewRoute,
    templateRoute,
    templateEditRoute,
    eraseRoute,
  ])

  return createRouter({
    routeTree,
    basepath,
    history,
    defaultNotFoundComponent: () => <NotFoundPage mine={false} />,
  })
}

/** `./MyMeetings`: the identity-scoped list and detail only; no templates, no erase, no new-meeting page. */
export function createMyMeetingsRouter(basepath?: string, Root: RouteComponent = Outlet, history?: RouterHistory) {
  const rootRoute = createRootRoute({ component: Root })

  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <MeetingsListPage mine />,
  })
  const meetingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/m/$id',
    component: () => <MeetingPage listPath="/my-meetings" />,
  })

  return createRouter({
    routeTree: rootRoute.addChildren([listRoute, meetingRoute]),
    basepath,
    history,
    defaultNotFoundComponent: () => <NotFoundPage mine />,
  })
}
