import { strings } from '../strings'

/**
 * Client-side checks mirroring projects-api's limits (tasks.md § API contracts).
 * The server stays the authority: its 400/422 names the field and is shown the
 * same way.
 */
const v = () => strings.common.validation

export const required = (value: string): string | null => (value.trim() === '' ? v().required : null)

export const maxLength = (value: string, max: number): string | null =>
  value.trim().length > max ? v().tooLong(max) : null

/** The first message of a list of checks, or null when all pass. */
export const first = (...checks: (string | null)[]): string | null => checks.find((check) => check !== null) ?? null

/** An optional text field on the wire: trimmed, `null` when empty (PATCH clears with null). */
export const optional = (value: string): string | null => (value.trim() === '' ? null : value.trim())

export type Errors<K extends string> = Partial<Record<K, string>>

export const hasErrors = (errors: Errors<string>): boolean => Object.values(errors).some(Boolean)
