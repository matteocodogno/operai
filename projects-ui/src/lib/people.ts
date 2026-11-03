import { strings } from '../strings'
import type { Person } from './types'

/** How a person reads: the live name, the account state, and "(You)" for the signed-in user. */
export function personName(person: Person | null, currentUserId: string | null = null): string {
  if (person === null) return strings.common.none
  if (person.deleted) return strings.people.deleted
  const name = person.name ?? strings.people.picker.noName
  return person.id === currentUserId ? `${name} (${strings.people.you})` : name
}
