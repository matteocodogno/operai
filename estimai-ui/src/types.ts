export const PROFILES = ["Developer","Backend Dev","Frontend Dev","Designer","DevOps","QA Engineer","PM","Full-stack"] as const;

export interface ProjectMeta {
  id: string;
  name: string;
  author: string;
  updatedAt: string;
}

export type Profile = typeof PROFILES[number];

export interface Activity {
  id: string;
  num: string;
  epic: string;
  act: string;
  prof: Profile;
  o: number;
  ml: number;
  p: number;
  risk: number;
  aiGain?: number;
  notes: string;
  release: string;
}

export interface Release {
  id: string;
  name: string;
  fte: number;
}

export interface Parameters {
  parallelism: number;
  sprintDays: number;
  workingDaysMonth: number;
  qaDeployDays: number;
  qaTestDays: number;
  pmDays: number;
  aiCostCoef: number;
  aiGain: number;
}

export interface ReleaseResult {
  ind: number;
  plan: number;
  base: number;
  el: number;
  tm: number;
  mo: number;
  best: number;
  worst: number;
  aiCost: number;
  aiElapsed: number;
  aiTotalMD: number;
}

export interface ReleaseSummary extends Release {
  res: ReleaseResult | null;
}

export interface Totals {
  ind: number;
  base: number;
  el: number;
  tm: number;
  mo: number;
  best: number;
  worst: number;
  aiCost: number;
  aiElapsed: number;
  aiTotalMD: number;
}
