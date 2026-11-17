import { useEffect, useState } from 'react'
import { useSession } from 'shell/session'
import { listManageableLegalEntities } from '../lib/crmApi'
import type { Entity } from '../lib/types'

/**
 * The entities the signed-in person may manage, asked of `auth` once per session (specs/20261117-legal-entities plan E2).
 * One module-level promise, keyed by the person: a sign-out ends the session (the id goes null) and another person
 * signing in has another id, so neither can read the previous answer. A failed ask is not kept, so the next mount tries
 * again; every reader of the failed ask meanwhile gets "none" (fail closed).
 */
let asked: { userId: string; answer: Promise<ReadonlySet<string>> } | null = null

function manageableFor(userId: string): Promise<ReadonlySet<string>> {
  if (asked?.userId === userId) return asked.answer
  const answer = listManageableLegalEntities().then(
    (body) => new Set(Array.isArray(body?.entities) ? body.entities.filter((name) => typeof name === 'string') : []),
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
 * Whether the person may manage `entity`'s legal details: UX only (the link to the Legal entities page), the registry's
 * own 403 is the gate. Fails closed: while the answer is pending, on any error, and for a non-answer, it is `false`, so
 * the Settings note shows the sentence and never the link. The browser never evaluates the grant's `entity` condition.
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
