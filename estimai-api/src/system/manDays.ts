/**
 * The man-days figure of an estimate (specs/022 T2, AC-3.1, ADR-0061): the **Expected**
 * effort WITHOUT AI gain — the sum over activities of PERT + risk buffer, unrounded, rounded
 * half up once to one decimal. It is the figure an offer prints when "AI-assisted" is off.
 *
 * The arithmetic between the `shared-copy` markers is a byte-identical copy of the same
 * region of crm-api's `src/offers/scope.ts` (itself pinned to estimai-ui's `pertCalc`),
 * enforced by `scripts/check-shared-copies.ts` (group `manDays`). Edit both in one commit.
 * Everything outside the markers is estimai-api's own.
 */

/** The slice of a stored estimate the arithmetic reads (crm-api's `EstimateDocument`, narrowed). */
export interface EstimateDocument {
  id: string;
  name: string;
  content: {
    params: { aiGain?: number | string };
    acts: {
      id: string;
      epic?: string;
      act?: string;
      o?: number | string;
      ml?: number | string;
      p?: number | string;
      risk?: number | string;
      aiGain?: number | string;
      release?: string;
    }[];
  };
}

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The figure a contract copies (AC-3.1): the estimate's Expected man-days, no AI gain,
 * rounded half up once to one decimal, never negative. `content` is the stored JSON
 * document: anything that is not an estimate with an `acts` array has no effort (0), and a
 * malformed activity counts for nothing instead of failing the read.
 */
export function manDaysOf(content: unknown): number {
  if (!isRecord(content) || !Array.isArray(content["acts"])) return 0;
  const acts = content["acts"].filter(isRecord) as unknown as EstimateDocument["content"]["acts"];
  const params = isRecord(content["params"]) ? (content["params"] as EstimateDocument["content"]["params"]) : {};
  const total = totalManDays({ id: "", name: "", content: { params, acts } }, false);
  return Math.max(0, Math.round(total * 10 + Number.EPSILON) / 10);
}
