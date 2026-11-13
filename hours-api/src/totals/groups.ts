/**
 * What a totals answer is made of (specs/029 T18; plan § Totals): the groups, how minutes are collected into them,
 * and the order they are listed in. Pure: no database, no other service.
 *
 * Every matching entry is counted in exactly ONE group, so `Σ groups[].minutes === totalMinutes` holds by
 * construction: the total is the sum of what was tallied, never a second query that could see another moment.
 */

import type { PersonStatus, UnavailableSources } from "../labels/types";

export const GROUPINGS = ["person", "project", "deal", "category", "month", "day"] as const;
export type Grouping = (typeof GROUPINGS)[number];

/**
 * What a group that names nothing stands for. Each is ONE group however many entities it merges, because the
 * viewer could not tell them apart and the export has no id to write for them (plan § Totals, "What the viewer
 * cannot name", AC-4.10):
 * - `none`: entries outside the grouping (a project entry under `groupBy=deal`, …);
 * - `hidden`: the viewer may not read the project or deal;
 * - `unavailable`: the owner did not answer the viewer's read;
 * - `deal-unknown`: a meeting's current deal could not be read (`meeting-deals` did not answer).
 */
export type BucketKind = "none" | "hidden" | "unavailable" | "deal-unknown";

export interface KeyedGroup {
  readonly kind: "keyed";
  readonly key: string;
  readonly label: string | null;
  readonly minutes: number;
  /** `groupBy=person` only. */
  readonly status?: PersonStatus;
  /** `groupBy=category` only. */
  readonly retired?: boolean;
}

export type TotalsGroup = KeyedGroup | { readonly kind: BucketKind; readonly minutes: number };

export interface TotalsAnswer {
  readonly totalMinutes: number;
  readonly groups: TotalsGroup[];
  readonly unavailable: UnavailableSources;
}

// ─── Collecting ──────────────────────────────────────────────────────────────

/** What a keyed group is, before it has minutes. */
export type KeyedIdentity = Omit<KeyedGroup, "kind" | "minutes">;

/** Minutes collected into keyed groups (merged by `key`) and into the groups that name nothing. */
export class Tally {
  private readonly keyed = new Map<string, { identity: KeyedIdentity; minutes: number }>();
  private readonly buckets = new Map<BucketKind, number>();
  private sum = 0;

  /** Everything tallied so far: the answer's `totalMinutes`. */
  get totalMinutes(): number {
    return this.sum;
  }

  /** Adds to the keyed group `identity.key`, creating it. A second add with the same key keeps the first identity. */
  addKeyed(identity: KeyedIdentity, minutes: number): void {
    this.sum += minutes;
    const existing = this.keyed.get(identity.key);
    if (existing === undefined) this.keyed.set(identity.key, { identity, minutes });
    else existing.minutes += minutes;
  }

  addBucket(kind: BucketKind, minutes: number): void {
    this.sum += minutes;
    this.buckets.set(kind, (this.buckets.get(kind) ?? 0) + minutes);
  }

  /** The groups: the keyed ones in `order`, then the buckets that hold minutes in the order of `tail`. */
  groups(order: (a: KeyedGroup, b: KeyedGroup) => number, tail: readonly BucketKind[]): TotalsGroup[] {
    const keyed = [...this.keyed.values()].map(({ identity, minutes }): KeyedGroup => ({ kind: "keyed", ...identity, minutes })).sort(order);
    const buckets = tail.flatMap((kind): TotalsGroup[] => {
      const minutes = this.buckets.get(kind);
      return minutes === undefined ? [] : [{ kind, minutes }];
    });
    return [...keyed, ...buckets];
  }
}

// ─── Order (plan § Totals, the table) ────────────────────────────────────────

const collator = new Intl.Collator("en", { sensitivity: "base" });

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** By label as the English collator reads it (case and accents set aside), a `null` label last, then by key. */
export function byLabel(a: KeyedGroup, b: KeyedGroup): number {
  if (a.label === null && b.label !== null) return 1;
  if (a.label !== null && b.label === null) return -1;
  if (a.label !== null && b.label !== null) {
    const byText = collator.compare(a.label, b.label);
    if (byText !== 0) return byText;
  }
  return compareKeys(a.key, b.key);
}

/** The most hours first; equal hours by `byLabel`. */
export const byMinutesThenLabel = (a: KeyedGroup, b: KeyedGroup): number => b.minutes - a.minutes || byLabel(a, b);

/** The newest first: a month or a day key sorts as text. */
export const byKeyDesc = (a: KeyedGroup, b: KeyedGroup): number => compareKeys(b.key, a.key);
