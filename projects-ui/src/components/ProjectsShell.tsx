import { Outlet } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ToolLayout } from '@operai/ui'
import { ScopeContext } from '../hooks/useScope'
import { useResource } from '../hooks/useResource'
import { getScope } from '../lib/projectsApi'
import { strings } from '../strings'
import { LoadFailure, Loading } from './LoadState'

/**
 * ProjectsShell — projects-ui's root layout: the tool title (h1) and the routed
 * page (ToolLayout `default` width). No suite chrome and no auth guard: the
 * shell owns both and mounts this remote only for `projects:access` holders
 * (ADR-0006, ADR-0007). There are no tabs — the list and the project page are
 * the whole tool.
 *
 * What varies per person is `GET /scope` — the entities they manage and whether
 * they may write a Bexio order id — loaded once here and handed to the pages
 * through `ScopeContext`. Until it answers the page area shows the loading
 * state; a failure shows the retry banner (the 503 "authorization service
 * unavailable" variant for a fail-closed `auth`, ADR-0014) or PermissionDenied
 * on a 403. The title stays on screen in every state.
 */
const loadScope = (signal: AbortSignal) => getScope({ signal })

export default function ProjectsShell() {
  const scope = useResource(loadScope)

  let content: ReactNode
  if (scope.status === 'loading') content = <Loading label={strings.nav.loading} />
  else if (scope.status === 'error') content = <LoadFailure error={scope.error} onRetry={scope.retry} />
  else
    content = (
      <ScopeContext.Provider value={scope.data!}>
        <Outlet />
      </ScopeContext.Provider>
    )

  return (
    <ToolLayout title={strings.nav.heading} testId="projects-shell">
      {content}
    </ToolLayout>
  )
}
