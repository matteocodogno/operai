import { useEffect, useState } from 'react'
import * as shell from 'shell/session'
import { useSession } from 'shell/session'
import { requestJson } from '../lib/api'
import type { Entity } from '../lib/types'

/**
 * The shell's auth base URL (`getAuthBaseUrl`, exposed by `shell/session` for federated remotes). Read through the
 * namespace, so a shell or test double that lacks it throws inside the ask below and the answer fails closed, instead of
 * breaking the page. The ambient declaration of `shell/session` (federation/remotes.d.ts) does not list it yet.
 */
const authBaseUrl = (): string => (shell as unknown as { getAuthBaseUrl: () => string }).getAuthBaseUrl()

/**
 * The entities the signed-in person may manage, asked of `auth` once per session (specs/20261117-legal-entities plan E2;
 * own copy of crm-ui's hook, apps cannot share a hook through `shell/session`). One module-level promise, keyed by the
 * person: a sign-out ends the session (the id goes null) and another person signing in has another id, so neither can
 * read the previous answer. A failed ask is not kept, so the next mount tries again; every reader of the failed ask
 * meanwhile gets "none" (fail closed).
 */
let asked: { userId: string; answer: Promise<ReadonlySet<string>> } | null = null

function manageableFor(userId: string): Promise<ReadonlySet<string>> {
  if (asked?.userId === userId) return asked.answer
  const answer = (async () => requestJson<{ entities?: unknown }>(authBaseUrl(), '/legal-entities/manageable'))().then(
    (body) =>
      new Set<string>(
        Array.isArray(body?.entities) ? body.entities.filter((name): name is string => typeof name === 'string') : [],
      ),
    () => {
      if (asked?.answer === answer) asked = null
      return new Set<string>()
    },
  )
  asked = { userId, answer }
  return answer
}

/** Test seam: forgets the session's answer. */
export function resetManageableLegalEntities(): void {
  asked = null
}

/**
 * Whether the person may manage `entity`'s legal details: UX only (the link to the Legal entities page in the preview's
 * source line), the registry's own 403 is the gate. Fails closed: while the answer is pending, on any error, and for a
 * non-answer, it is `false`, so the preview shows the sentence and never the link. The browser never evaluates the
 * grant's `entity` condition.
 */
export function useCanManageLegalEntity(entity: Entity): boolean {
  const userId = useSession().data?.user?.id ?? null
  const [answer, setAnswer] = useState<{ userId: string; entities: ReadonlySet<string> } | null>(null)
  useEffect(() => {
    if (userId === null) return
    let live = true
    void manageableFor(userId).then((entities) => {
      if (live) setAnswer({ userId, entities })
    })
    return () => {
      live = false
    }
  }, [userId])
  return userId !== null && answer?.userId === userId && answer.entities.has(entity)
}
