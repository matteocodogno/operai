import { getJson, sendJson } from './api'
import type { Entity, Rule, RuleInput, RulesList } from './types'

/** Depreciation rules (`ledger:manage`). There is no update or delete route (AC-6.5): a rule is only ever appended. */

export const listRules = (entity: Entity, init?: RequestInit): Promise<RulesList> =>
  getJson<RulesList>(`/rules?entity=${encodeURIComponent(entity)}`, init)

export const createRule = (input: RuleInput): Promise<Rule> => sendJson<Rule>('/rules', 'POST', input)
