/**
 * Trip-signature fold-merge, ranking and capping (T4, specs/014-motivo-autocomplete).
 *
 * PURE — no Prisma, no Hono, no clock of its own (the window cutoff takes
 * `now` as an argument). Everything here is directly unit-testable, which is
 * the point: this is where AC-2.1/2.2/2.3/2.5 actually live, and none of them
 * should need a database to verify.
 *
 * The two-stage grouping, and why it is two stages
 * ───────────────────────────────────────────────
 * `suggestions.repo.ts` collapses EXACT `(motivo, km, entity)` triples in SQL
 * — Postgres groups on the raw bytes, so `"Milano → Lugano"` and
 * `"milano → LUGANO"` come back as two separate triples. This module then
 * merges triples whose motivo FOLDS equal (`normaliseMotivo`, plan D3) onto
 * one trip signature (AC-2.1), summing their counts and taking the latest
 * date. Doing the fold in SQL instead would require a Postgres `unaccent`
 * extension + an expression index + an immutability wrapper — explicitly
 * rejected in plan D3, and unnecessary at this corpus size.
 *
 * `km` and `entity` are part of the signature and are NEVER folded together:
 * same words, different distance or different legal entity, means a different
 * trip and stays a separate suggestion (AC-2.2).
 */

import { normaliseMotivo } from "./normaliseMotivo";
import type { EntityValue } from "./requests.schemas";
import type { TripSuggestionResponse } from "./suggestions.schemas";

// ─── Bounds and window ──────────────────────────────────────────────────────

/** The suggestion window (spec Domain language, AC-2.4). */
export const SUGGESTION_WINDOW_MONTHS = 24;

/**
 * plan D5's cap on the ranked result. 25x the 8 the UI can display
 * (AC-1.5), so what is dropped is by definition the least-used, least-recent
 * trips of an employee who has more than 200 DISTINCT trips in 24 months —
 * i.e. someone who does not have the repetition problem this feature exists
 * to solve. Recorded as a bounded, documented deviation from AC-1.4's "any
 * matching trip" for pathological corpora (plan Risk R1).
 */
export const MAX_TRIP_SUGGESTIONS = 200;

/**
 * The inclusive lower bound of the suggestion window, computed from the
 * server clock per request (plan § Data model) — never a stored or scheduled
 * value (ADR-0013 posture).
 *
 * UTC throughout: the column is `@db.Date` (stored at UTC midnight) and the
 * <=2h offset between UTC and Europe/Rome is immaterial at a 24-month
 * boundary. `Date.UTC`'s month-overflow normalisation (e.g. a 31st rolling
 * into the following month for a 30-day target month) is accepted and
 * deliberate — it is applied identically to every caller, so the window is
 * always a single well-defined instant.
 *
 * INCLUSIVE by design: AC-2.4 excludes a line dated "more than 24 months
 * before today", so a line dated exactly 24 months ago is still eligible.
 */
export function suggestionWindowCutoff(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - SUGGESTION_WINDOW_MONTHS,
      now.getUTCDate(),
    ),
  );
}

// ─── Input shape ────────────────────────────────────────────────────────────

/**
 * One EXACT `(motivo, km, entity)` triple as SQL grouped it — the repo's
 * output, this module's input. `count` is that triple's line count and
 * `lastUsedOn` its most recent expense date, both already restricted to the
 * caller's own lines inside the 24-month window by the repo.
 */
export interface TripTriple {
  readonly motivo: string;
  readonly km: number;
  readonly entity: EntityValue;
  readonly count: number;
  /** ISO date-only, `YYYY-MM-DD` — lexicographic order IS chronological order. */
  readonly lastUsedOn: string;
}

// ─── Comparators ────────────────────────────────────────────────────────────

/**
 * Plain code-unit comparison, deliberately NOT `localeCompare`: the latter is
 * locale- and ICU-version-sensitive, so two deployments (or a developer's
 * machine and CI) could rank identically-scored trips differently and the
 * response would stop being reproducible. Nothing here is displayed to a
 * human in sorted order, so collation correctness is not a requirement —
 * determinism is.
 */
const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ─── Fold-merge ─────────────────────────────────────────────────────────────

interface TripGroup {
  /** The elected display text — a real motivo, verbatim as typed (AC-2.5). */
  motivo: string;
  readonly normalisedMotivo: string;
  readonly km: number;
  readonly entity: EntityValue;
  /** Sum over every constituent triple (AC-2.1). */
  count: number;
  /** Max over every constituent triple. */
  lastUsedOn: string;
  /** The elected constituent's OWN count — election tiebreak only, never surfaced. */
  electedCount: number;
  /** The elected constituent's OWN date — election tiebreak only, never surfaced. */
  electedOn: string;
}

/**
 * Which of two constituent triples supplies the group's display text.
 *
 * AC-2.5 fixes the first key only ("the motivo of the group's MOST RECENT
 * line, exactly as originally typed"). The remaining two keys exist because
 * a group can hold several variants sharing that most-recent date — with no
 * tiebreak the winner would depend on SQL row order, and the same corpus
 * could show `"Milano → Lugano"` on one request and `"milano → LUGANO"` on
 * the next. Additive to AC-2.5, never contradicting it: every candidate here
 * is a real, verbatim past motivo.
 */
function winsDisplay(candidate: TripTriple, group: TripGroup): boolean {
  if (candidate.lastUsedOn !== group.electedOn) {
    return candidate.lastUsedOn > group.electedOn;
  }
  if (candidate.count !== group.electedCount) {
    return candidate.count > group.electedCount;
  }
  return compareStrings(candidate.motivo, group.motivo) < 0;
}

/**
 * Merge key. NUL is used as the separator because Postgres `text` cannot
 * contain a NUL byte at all, so it can never appear inside `normalisedMotivo`
 * — unlike `:` or `|`, which a motivo very plausibly does contain and which
 * would let `("a|b", 1)` collide with `("a", "b|1")`.
 */
function signatureKey(normalisedMotivo: string, km: number, entity: EntityValue): string {
  return `${normalisedMotivo}\u0000${km}\u0000${entity}`;
}

/**
 * Fold-merge → rank → cap. The whole of `GET /line-suggestions`'s domain
 * logic.
 *
 * Ranking is the deterministic TOTAL order of plan D8:
 *   `count` desc → `lastUsedOn` desc → `normalisedMotivo` asc → `km` asc →
 *   `entity` asc.
 * AC-2.3 fixes only the first two; the last three are added so that
 * identical-count/identical-date trips cannot flap between two responses over
 * the same data. Because the client filters order-preservingly, this ordering
 * is also what makes AC-1.7's "never shows a lower count than a suggestion
 * listed below it" true by construction rather than by a client-side re-sort.
 */
export function buildTripSuggestions(
  triples: readonly TripTriple[],
  limit: number = MAX_TRIP_SUGGESTIONS,
): TripSuggestionResponse[] {
  const groups = new Map<string, TripGroup>();

  for (const triple of triples) {
    const normalisedMotivo = normaliseMotivo(triple.motivo);
    const key = signatureKey(normalisedMotivo, triple.km, triple.entity);
    const group = groups.get(key);

    if (group === undefined) {
      groups.set(key, {
        motivo: triple.motivo,
        normalisedMotivo,
        km: triple.km,
        entity: triple.entity,
        count: triple.count,
        lastUsedOn: triple.lastUsedOn,
        electedCount: triple.count,
        electedOn: triple.lastUsedOn,
      });
      continue;
    }

    // Election runs BEFORE the running maximum is widened — it compares the
    // incoming triple against the CURRENT representative's own date/count,
    // never against the group's already-widened aggregate (which would make
    // every later triple lose against a date it had itself contributed).
    if (winsDisplay(triple, group)) {
      group.motivo = triple.motivo;
      group.electedCount = triple.count;
      group.electedOn = triple.lastUsedOn;
    }

    group.count += triple.count;
    if (triple.lastUsedOn > group.lastUsedOn) {
      group.lastUsedOn = triple.lastUsedOn;
    }
  }

  return Array.from(groups.values())
    .sort(
      (a, b) =>
        b.count - a.count ||
        compareStrings(b.lastUsedOn, a.lastUsedOn) ||
        compareStrings(a.normalisedMotivo, b.normalisedMotivo) ||
        a.km - b.km ||
        compareStrings(a.entity, b.entity),
    )
    .slice(0, limit)
    .map((group) => ({
      motivo: group.motivo,
      normalisedMotivo: group.normalisedMotivo,
      km: group.km,
      entity: group.entity,
      count: group.count,
      lastUsedOn: group.lastUsedOn,
    }));
}
