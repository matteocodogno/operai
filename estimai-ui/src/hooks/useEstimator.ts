import { useMemo } from "react";
import type { Activity, Release, Parameters, ReleaseResult, ReleaseSummary, Totals } from "../types";

/**
 * PERT calculation: (O + 4*ML + P) / 6
 */
export function pertCalc(o: number, ml: number, p: number): number {
  return ((Number(o) || 0) + 4 * (Number(ml) || 0) + (Number(p) || 0)) / 6;
}

/**
 * Derive optimistic and pessimistic from most likely
 */
export function deriveOP(ml: number): { o: number; p: number } {
  const v = Number(ml) || 0;
  return { o: +(v * 0.75).toFixed(1), p: +(v * 1.6).toFixed(1) };
}

/**
 * Compute release metrics given activities, release config, and parameters
 */
export function computeRelease(acts: Activity[], rel: Release, p: Parameters): ReleaseResult | null {
  if (!acts.length) return null;

  const par = Number(p.parallelism) || 0.7;
  const sprint = Number(p.sprintDays) || 10;
  const wdm = Number(p.workingDaysMonth) || 20;
  const fte = Number(rel.fte) || 1;
  const oh = (Number(p.qaDeployDays) || 0) + (Number(p.qaTestDays) || 0) + (Number(p.pmDays) || 0);

  function crunch(sum: number) {
    const ind = sum + oh;
    const plan = sprint > 0 ? fte * (ind / sprint) / 8 : 0;
    const base = ind + plan;
    const el = Math.round(base * (1 - par * ((fte - 1) / fte)));
    return {
      ind: +ind.toFixed(1),
      plan: +plan.toFixed(1),
      base: +base.toFixed(1),
      el,
      tm: el * fte,
      mo: +(el / wdm).toFixed(2),
    };
  }

  const sumExp = acts.reduce((s, a) => s + pertCalc(a.o, a.ml, a.p) + (Number(a.risk) || 0), 0);
  const sumBest = acts.reduce((s, a) => s + (Number(a.o) || 0) + (Number(a.risk) || 0), 0);
  const sumWst = acts.reduce((s, a) => s + (Number(a.p) || 0) + (Number(a.risk) || 0), 0);
  const gain = Number(p.aiGain) || 0;
  const sumAI = acts.reduce((s, a) => {
    const actGain = (a.aiGain !== undefined && a.aiGain !== null && (a.aiGain as unknown as string) !== "")
      ? Number(a.aiGain)
      : gain;
    return s + (pertCalc(a.o, a.ml, a.p) + (Number(a.risk) || 0)) * (1 - actGain);
  }, 0);

  const main = crunch(sumExp);
  const aiElapsed = crunch(sumAI).el;
  const aiTotalMD = aiElapsed * fte;
  const aiCost = Math.round((Number(p.aiCostCoef) || 0) * fte * main.el);

  return {
    ...main,
    best: crunch(sumBest).el,
    worst: crunch(sumWst).el,
    aiCost,
    aiElapsed,
    aiTotalMD,
    sumExp: +sumExp.toFixed(2),
    sumAiExp: +sumAI.toFixed(2),
  };
}

/**
 * Custom hook: computes summary per release, totals, and by-profile breakdown
 */
export function useEstimator(acts: Activity[], releases: Release[], params: Parameters) {
  const summary = useMemo<ReleaseSummary[]>(
    () =>
      releases.map((rel) => ({
        ...rel,
        res: computeRelease(
          acts.filter((a) => a.release === rel.name),
          rel,
          params
        ),
      })),
    [acts, releases, params]
  );

  const totals = useMemo<Totals>(() => {
    const f = summary.filter((s) => s.res);
    return {
      ind: f.reduce((s, r) => s + (r.res?.ind ?? 0), 0),
      base: f.reduce((s, r) => s + (r.res?.base ?? 0), 0),
      el: f.reduce((s, r) => s + (r.res?.el ?? 0), 0),
      tm: f.reduce((s, r) => s + (r.res?.tm ?? 0), 0),
      mo: +f.reduce((s, r) => s + (r.res?.mo ?? 0), 0).toFixed(2),
      best: f.reduce((s, r) => s + (r.res?.best ?? 0), 0),
      worst: f.reduce((s, r) => s + (r.res?.worst ?? 0), 0),
      aiCost: f.reduce((s, r) => s + (r.res?.aiCost ?? 0), 0),
      aiElapsed: f.reduce((s, r) => s + (r.res?.aiElapsed ?? 0), 0),
      aiTotalMD: f.reduce((s, r) => s + (r.res?.aiTotalMD ?? 0), 0),
    };
  }, [summary]);

  const byProfile = useMemo(() => {
    const m: Record<string, number> = {};
    acts.forEach((a) => {
      const k = a.prof || "Developer";
      m[k] = (m[k] || 0) + pertCalc(a.o, a.ml, a.p) + (Number(a.risk) || 0);
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [acts]);

  return { summary, totals, byProfile };
}
