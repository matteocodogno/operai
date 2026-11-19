/**
 * The legal entities Accounting keeps reference data for, and what differs between them (T6,
 * specs/20261119-accounting, plan D19). A new entity (or Italy's own source) is a change HERE plus a source
 * module, with no schema migration: every other file reads these tables, none re-types a literal.
 *
 * `ENTITIES` is the display order of every list (`welld_ch` first) and the only set `coverage.ts` ever
 * answers for: an entity id that is not in it is refused as an entity that does not exist.
 */

export const ENTITIES = ["welld_ch", "welld_it"] as const;

export type Entity = (typeof ENTITIES)[number];

/** Whether `value` names a legal entity (an array lookup, so `"__proto__"` and the like are no entity). */
export function isEntity(value: string): value is Entity {
  return (ENTITIES as readonly string[]).includes(value);
}

/** The currency each entity's books are kept in; foreign rates are expressed against it. */
export const OWN_CURRENCY = {
  welld_ch: "CHF",
  welld_it: "EUR",
} as const satisfies Record<Entity, string>;

export type RateSourceName = "bazg";

/** Where an entity's monthly average rates come from and which foreign currencies it converts. */
export interface RateSourceConfig {
  readonly name: RateSourceName;
  readonly currencies: readonly string[];
}

/**
 * The official rate source per entity. `null` = no source and no currencies in v1 (WellD Italia, D19): its
 * rates screen says so and a fetch is a 422 `no_rate_source`.
 */
export const RATE_SOURCE = {
  welld_ch: { name: "bazg", currencies: ["EUR", "USD", "GBP"] },
  welld_it: null,
} as const satisfies Record<Entity, RateSourceConfig | null>;
