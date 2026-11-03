/**
 * A root layout for page tests: hands `value` down through `ScopeContext` the way
 * `ProjectsShell` does once `GET /scope` answered, without the request. Use with
 * `createAppRouter(undefined, scopeRoot(scope({ manage: ['welld_ch'] })))`.
 */
import { Outlet } from '@tanstack/react-router'
import { ScopeContext } from '../hooks/useScope'
import type { Scope } from '../lib/types'

export const scopeRoot = (value: Scope) =>
  function ScopeRoot() {
    return (
      <ScopeContext.Provider value={value}>
        <Outlet />
      </ScopeContext.Provider>
    )
  }
