/**
 * The scope table of an offer: an EstimAI estimate's effort per release and
 * epic (specs/018 AC-4.1, O1). Pure and DB-free.
 *
 * It mirrors the part of estimai-ui's `useEstimator.ts` an offer prints, never
 * the elapsed/FTE chain (an offer quotes effort, not a schedule):
 *
 *   PERT      = (O + 4 × ML + P) / 6
 *   Expected  = PERT + risk buffer                    (AGENTS.md: summaries use Expected, never PERT)
 *   AI        = Expected × (1 − gain), gain per activity, falling back to the global one
 *   only ML   → O = ML × 0.75, P = ML × 1.60
 *
 * Inputs may be strings (EstimAI stores what the grid typed). Figures are kept
 * as man-days in tenths (integers), summed unrounded and rounded once per line,
 * like the money rule of ADR-0025. `scope.test.ts` pins shared vectors against
 * estimai-ui's `pertCalc`.
 *
 * The block between the `shared-copy:begin manDays` markers (the Expected-effort arithmetic
 * and `totalManDays`) is copied byte for byte into estimai-api's `src/system/manDays.ts`,
 * which serves a contract's man-days figure (specs/022, ADR-0061); `scripts/check-shared-
 * copies.ts` fails when the two drift. Change both in the same commit.
 */

import type { EstimateDocument } from "../lib/estimai";

// shared-copy:begin manDays
export const DEFAULT_AI_GAIN = 0.3;

const num = (value: number | string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function pert(o: number, ml: number, p: number): number {
  return (o + 4 * ml + p) / 6;
}

/** Expected effort of one activity, in man-days (unrounded). */
export function expectedOf(
  act: EstimateDocument["content"]["acts"][number],
  options: { aiAssisted: boolean; globalAiGain: number },
): number {
  const ml = num(act.ml);
  let o = num(act.o);
  let p = num(act.p);
  if (o === 0 && p === 0 && ml > 0) {
    o = ml * 0.75;
    p = ml * 1.6;
  }
  const expected = pert(o, ml, p) + num(act.risk);
  if (!options.aiAssisted) return expected;
  const gain = act.aiGain !== undefined && act.aiGain !== "" ? num(act.aiGain) : options.globalAiGain;
  return expected * (1 - gain);
}

export const globalAiGainOf = (estimate: EstimateDocument): number => {
  const { aiGain } = estimate.content.params;
  return aiGain !== undefined && aiGain !== "" ? num(aiGain) : DEFAULT_AI_GAIN;
};

const sum = (values: Iterable<number>): number => [...values].reduce((total, value) => total + value, 0);

/** The estimate's total expected man-days, unrounded: round it once, where it is printed. */
export function totalManDays(estimate: EstimateDocument, aiAssisted: boolean): number {
  const globalAiGain = globalAiGainOf(estimate);
  return sum(estimate.content.acts.map((act) => expectedOf(act, { aiAssisted, globalAiGain })));
}
// shared-copy:end manDays

export interface ScopeEpic {
  readonly epic: string;
  /** Man-days × 10, rounded half up once. */
  readonly manDaysTenths: number;
}

export interface ScopeRelease {
  readonly name: string;
  readonly epics: readonly ScopeEpic[];
  readonly manDaysTenths: number;
}

export interface Scope {
  readonly aiAssisted: boolean;
  readonly releases: readonly ScopeRelease[];
  readonly manDaysTenths: number;
}

const tenths = (manDays: number): number => Math.round(manDays * 10 + Number.EPSILON);

export type EstimateActivity = EstimateDocument["content"]["acts"][number];

/**
 * The release key of an activity: estimai-ui stores the release NAME on an
 * activity (`a.release === rel.name`), older fixtures its id. Either matches;
 * anything else is "" (unassigned).
 */
export function releaseKeyOf(estimate: EstimateDocument, act: EstimateActivity): string {
  const { releases } = estimate.content;
  if (!act.release) return "";
  return (
    releases.find((release) => release.id === act.release)?.id ??
    releases.find((release) => release.name === act.release)?.id ??
    ""
  );
}

interface ReleaseGroup {
  readonly name: string;
  /** Epic → expected man-days, unrounded, first-seen order. */
  readonly epics: Map<string, number>;
}

/**
 * Groups the activities by release (estimate order, unassigned last) and epic
 * (first seen). Man-days are NOT rounded here: callers round once.
 */
function groupByRelease(
  estimate: EstimateDocument,
  options: { aiAssisted: boolean; unassignedLabel: string; noEpicLabel: string },
): ReleaseGroup[] {
  const content = estimate.content;
  const globalAiGain = globalAiGainOf(estimate);
  const releaseName = new Map(content.releases.map((release) => [release.id, release.name || release.id]));
  const order = [...content.releases.map((release) => release.id)];

  const groups = new Map<string, Map<string, number>>();
  for (const act of content.acts) {
    const key = releaseKeyOf(estimate, act);
    if (!groups.has(key)) {
      groups.set(key, new Map());
      if (key === "") order.push("");
    }
    const epics = groups.get(key)!;
    const epic = act.epic?.trim() || options.noEpicLabel;
    epics.set(epic, (epics.get(epic) ?? 0) + expectedOf(act, { aiAssisted: options.aiAssisted, globalAiGain }));
  }
  const result: ReleaseGroup[] = [];
  for (const key of order) {
    const epics = groups.get(key);
    if (epics) result.push({ name: key === "" ? options.unassignedLabel : releaseName.get(key)!, epics });
  }
  return result;
}

/**
 * Groups the estimate's activities by release (in the estimate's release
 * order) and epic (first-seen order). Activities of an unknown release are
 * grouped under `unassignedLabel`; an empty epic under `noEpicLabel`.
 */
export function buildScope(
  estimate: EstimateDocument,
  options: { aiAssisted: boolean; unassignedLabel: string; noEpicLabel: string },
): Scope {
  const groups = groupByRelease(estimate, options);
  const releases: ScopeRelease[] = groups.map((group) => ({
    name: group.name,
    epics: [...group.epics.entries()].map(([epic, manDays]) => ({ epic, manDaysTenths: tenths(manDays) })),
    manDaysTenths: tenths(sum(group.epics.values())),
  }));
  const total = sum(groups.map((group) => sum(group.epics.values())));
  return { aiAssisted: options.aiAssisted, releases, manDaysTenths: tenths(total) };
}

/** Expected man-days per release, unrounded (specs/020 D-13: the weights of a per-phase split). */
export function releaseManDays(
  estimate: EstimateDocument,
  options: { aiAssisted: boolean; unassignedLabel: string; noEpicLabel: string },
): { name: string; manDays: number }[] {
  return groupByRelease(estimate, options).map((group) => ({ name: group.name, manDays: sum(group.epics.values()) }));
}

/** Round half up to a whole number, once (ADR-0025 posture). */
export const roundHalfUp = (value: number): number => Math.round(value + Number.EPSILON);
