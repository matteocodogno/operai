/**
 * The outcome of validating untrusted model output (ADR-0067).
 *
 * A failure carries a CLOSED reason code and nothing the model wrote: reasons are logged and
 * stored as a failure code, and model output is the one thing that must never travel there
 * (it can contain meeting content, or a planted string).
 */
export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export const valid = <T>(value: T): Validation<T> => ({ ok: true, value });
export const invalid = (reason: string): Validation<never> => ({ ok: false, reason });

/** A plain JSON object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` has exactly the members in `required`: all present, no others. */
export function hasOnly(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}
