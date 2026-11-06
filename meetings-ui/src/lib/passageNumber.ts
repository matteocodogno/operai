/**
 * The number a person reads for a passage. The API's `ordinal` is 0-based (meetings-api, unchanged);
 * every label, aria-label and citation shows it counted from 1. Never put a raw `ordinal` in copy.
 */
export const passageNumber = (ordinal: number): number => ordinal + 1
