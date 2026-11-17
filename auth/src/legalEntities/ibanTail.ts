/**
 * The one rule for how much of an IBAN may leave the registry (specs/20261117-legal-entities, T54; security review
 * F5 item 3; AC-9.11, AC-9.12). A person who must recognise an IBAN (a notice of a change, the report of the copy) is
 * shown its last four characters and nothing else, and only when that reveals little:
 *
 *   - empty                              -> `none`
 *   - 8 characters or fewer              -> `set` (a value that short would be mostly shown by its tail)
 *   - more than 8 characters             -> `tail`, the last 4 characters
 *
 * One more refusal, on top of the spec's: a tail that is not four of `A-Z` / `0-9` (an imported value can hold any
 * character, AC-7.3, D3) is `set`, never printed. That keeps the output inside `^[A-Z0-9]{4}$`, the shape the
 * notices' typed data accepts (plan G5), so a control or bidi character, half a surrogate pair or a non-ASCII letter
 * can neither reach a terminal nor an email through this function.
 *
 * Pure and total: it takes the stored value (or one typed by a person; the same normalisation as the registry's is
 * applied first, so spaces and case do not matter) and returns data, never text for a reader. Wording and language
 * belong to the caller.
 */

import { normaliseIban } from "./rules";

export type IbanTail = { state: "none" } | { state: "set" } | { state: "tail"; last4: string };

/** Longest value that shows no character at all (AC-9.11: "a value of 8 characters or fewer"). */
export const IBAN_SET_ONLY_MAX = 8;
/** What a shown tail looks like; the notice's typed data validates the same pattern. */
export const IBAN_TAIL_PATTERN = /^[A-Z0-9]{4}$/;

export function ibanTail(iban: string): IbanTail {
  const chars = Array.from(normaliseIban(iban));
  if (chars.length === 0) return { state: "none" };
  if (chars.length <= IBAN_SET_ONLY_MAX) return { state: "set" };
  const last4 = chars.slice(-4).join("");
  return IBAN_TAIL_PATTERN.test(last4) ? { state: "tail", last4 } : { state: "set" };
}
