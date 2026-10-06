import { getJson } from './api'
import type { Scope } from './types'

/** `GET /scope` — the entities each capability covers for the caller (through `authzMiddleware`, no capability required). */
export const getScope = (init?: RequestInit): Promise<Scope> => getJson<Scope>('/scope', init)
