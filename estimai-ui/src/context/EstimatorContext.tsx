import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Activity, Parameters, Release, ReleaseSummary, Totals } from "../types";
import { deriveOP, useEstimator } from "../hooks/useEstimator";

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

const STORAGE_KEY = "estimai_v1";

const DEF_PARAMS: Parameters = {
  parallelism: 0.7,
  sprintDays: 10,
  workingDaysMonth: 20,
  qaDeployDays: 0,
  qaTestDays: 0,
  pmDays: 0,
  aiCostCoef: 10,
  aiGain: 0.30,
};

const DEF_RELEASES: Release[] = [
  { id: uid(), name: "Release 1", fte: 1 },
  { id: uid(), name: "Release 2", fte: 1 },
];

const DEF_ACTS: Activity[] = [
  { id: uid(), num: "1.1", epic: "Auth", act: "Login flow", prof: "Backend Dev", o: 3.75, ml: 5, p: 8, risk: 0, notes: "", release: "Release 1" },
  { id: uid(), num: "1.2", epic: "Auth", act: "OAuth setup", prof: "Backend Dev", o: 6, ml: 8, p: 13, risk: 2, notes: "3rd party dep", release: "Release 1" },
  { id: uid(), num: "1.3", epic: "UI Shell", act: "Navigation", prof: "Frontend Dev", o: 3, ml: 4, p: 6, risk: 0, notes: "", release: "Release 1" },
  { id: uid(), num: "2.1", epic: "Dashboard", act: "Main view", prof: "Frontend Dev", o: 7.5, ml: 10, p: 16, risk: 0, notes: "", release: "Release 2" },
  { id: uid(), num: "2.2", epic: "Dashboard", act: "API endpoints", prof: "Developer", o: 4.5, ml: 6, p: 9.6, risk: 1, notes: "Awaiting spec", release: "Release 2" },
];

interface StoredState {
  name: string;
  author: string;
  params: Parameters;
  releases: Release[];
  acts: Activity[];
}

function loadFromStorage(): StoredState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredState;
  } catch {
    return null;
  }
}

export interface EstimatorContextValue {
  name: string;
  author: string;
  params: Parameters;
  releases: Release[];
  acts: Activity[];
  summary: ReleaseSummary[];
  totals: Totals;
  byProfile: [string, number][];
  setName: (v: string) => void;
  setAuthor: (v: string) => void;
  updAct: (id: string, f: keyof Activity, v: string) => void;
  addAct: () => void;
  delAct: (id: string) => void;
  updRel: (id: string, f: keyof Release, v: string | number) => void;
  addRel: () => void;
  delRel: (id: string) => void;
  updP: (k: keyof Parameters, v: string) => void;
}

const EstimatorContext = createContext<EstimatorContextValue | null>(null);

export function EstimatorProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState(() => loadFromStorage()?.name ?? "My Software Project");
  const [author, setAuthor] = useState(() => loadFromStorage()?.author ?? "");
  const [params, setParams] = useState<Parameters>(() => loadFromStorage()?.params ?? DEF_PARAMS);
  const [releases, setRels] = useState<Release[]>(() => loadFromStorage()?.releases ?? DEF_RELEASES);
  const [acts, setActs] = useState<Activity[]>(() => loadFromStorage()?.acts ?? DEF_ACTS);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, author, params, releases, acts }));
  }, [name, author, params, releases, acts]);

  const rnames = useMemo(() => releases.map((r) => r.name), [releases]);
  const { summary, totals, byProfile } = useEstimator(acts, releases, params);

  const updAct = useCallback((id: string, f: keyof Activity, v: string) =>
    setActs((prev) => prev.map((a) => {
      if (a.id !== id) return a;
      const u = { ...a, [f]: v };
      if (f === "ml") {
        const d = deriveOP(Number(v));
        u.o = d.o;
        u.p = d.p;
      }
      return u;
    })), []);

  const addAct = useCallback(() =>
    setActs((prev) => [...prev, {
      id: uid(),
      num: "",
      epic: "",
      act: "New activity",
      prof: "Developer",
      o: 3.75,
      ml: 5,
      p: 8,
      risk: 0,
      notes: "",
      release: rnames[0] || "Release 1",
    }]), [rnames]);

  const delAct = useCallback((id: string) =>
    setActs((prev) => prev.filter((a) => a.id !== id)), []);

  const updRel = useCallback((id: string, f: keyof Release, v: string | number) =>
    setRels((prev) => prev.map((r) => r.id === id ? { ...r, [f]: v } : r)), []);

  const addRel = useCallback(() =>
    setRels((prev) => [...prev, { id: uid(), name: `Release ${prev.length + 1}`, fte: 1 }]), []);

  const delRel = useCallback((id: string) =>
    setRels((prev) => prev.filter((r) => r.id !== id)), []);

  const updP = useCallback((k: keyof Parameters, v: string) =>
    setParams((prev) => ({ ...prev, [k]: parseFloat(v) || 0 })), []);

  const value = useMemo<EstimatorContextValue>(() => ({
    name, author, params, releases, acts,
    summary, totals, byProfile,
    setName, setAuthor,
    updAct, addAct, delAct,
    updRel, addRel, delRel,
    updP,
  }), [name, author, params, releases, acts, summary, totals, byProfile, updAct, addAct, delAct, updRel, addRel, delRel, updP]);

  return <EstimatorContext.Provider value={value}>{children}</EstimatorContext.Provider>;
}

export function useEstimatorContext(): EstimatorContextValue {
  const ctx = useContext(EstimatorContext);
  if (!ctx) throw new Error("useEstimatorContext must be used within EstimatorProvider");
  return ctx;
}
