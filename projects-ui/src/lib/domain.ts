import type { Entity, ProjectType } from './types'

export const ENTITIES: readonly Entity[] = ['welld_ch', 'welld_it']
export const PROJECT_TYPES: readonly ProjectType[] = ['t_and_m', 'fixed_price', 'maintenance', 'saas', 'internal']
export const PROJECT_STATES = ['planned', 'active', 'on_hold', 'closed', 'cancelled'] as const

/** Client projects have exactly one company of their own; `saas` and `internal` have none (AC-1.1). */
export const CLIENT_TYPES: readonly ProjectType[] = ['t_and_m', 'fixed_price', 'maintenance']

export const isClientType = (type: ProjectType): boolean => CLIENT_TYPES.includes(type)
