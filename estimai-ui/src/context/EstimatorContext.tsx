import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Activity, Parameters, ProjectMeta, Release, ReleaseSummary, Totals } from "../types";
import { deriveOP, useEstimator } from "../hooks/useEstimator";

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

const PROJECTS_KEY = "estimai_projects";
const CURRENT_ID_KEY = "estimai_current_id";
const projectKey = (id: string) => `estimai_project_${id}`;

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

interface ProjectData {
  id: string;
  name: string;
  author: string;
  params: Parameters;
  releases: Release[];
  acts: Activity[];
}

function blankProject(): ProjectData {
  return {
    id: uid(),
    name: "",
    author: "",
    params: { ...DEF_PARAMS },
    releases: [],
    acts: [],
  };
}

function loadProjects(): ProjectMeta[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    return raw ? (JSON.parse(raw) as ProjectMeta[]) : [];
  } catch {
    return [];
  }
}

function loadProject(id: string): ProjectData | null {
  try {
    const raw = localStorage.getItem(projectKey(id));
    return raw ? (JSON.parse(raw) as ProjectData) : null;
  } catch {
    return null;
  }
}

function initState(): { project: ProjectData; projects: ProjectMeta[] } {
  const currentId = localStorage.getItem(CURRENT_ID_KEY);
  const projects = loadProjects();

  if (currentId) {
    const data = loadProject(currentId);
    if (data) return { project: data, projects };
  }

  return { project: blankProject(), projects };
}

export interface EstimatorContextValue {
  projectId: string;
  projects: ProjectMeta[];
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
  addRel: () => string;
  delRel: (id: string) => void;
  updP: (k: keyof Parameters, v: string) => void;
  switchProject: (id: string) => void;
  newProject: () => void;
}

const EstimatorContext = createContext<EstimatorContextValue | null>(null);

export function EstimatorProvider({ children }: { children: React.ReactNode }) {
  const [initialData] = useState(initState);

  const [projects, setProjects] = useState<ProjectMeta[]>(initialData.projects);
  const [projectId, setProjectId] = useState<string>(initialData.project.id);
  const [name, setName] = useState<string>(initialData.project.name);
  const [author, setAuthor] = useState<string>(initialData.project.author);
  const [params, setParams] = useState<Parameters>(initialData.project.params);
  const [releases, setRels] = useState<Release[]>(initialData.project.releases);
  const [acts, setActs] = useState<Activity[]>(initialData.project.acts);

  // Persist current project data and update the projects index on every change
  useEffect(() => {
    const data: ProjectData = { id: projectId, name, author, params, releases, acts };
    localStorage.setItem(projectKey(projectId), JSON.stringify(data));
    localStorage.setItem(CURRENT_ID_KEY, projectId);

    const meta: ProjectMeta = { id: projectId, name, author, updatedAt: new Date().toISOString() };
    setProjects((prev) => {
      const exists = prev.some((p) => p.id === projectId);
      return exists ? prev.map((p) => (p.id === projectId ? meta : p)) : [...prev, meta];
    });
  }, [projectId, name, author, params, releases, acts]);

  // Write the projects index to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  }, [projects]);

  const rnames = useMemo(() => releases.map((r) => r.name), [releases]);
  const { summary, totals, byProfile } = useEstimator(acts, releases, params);

  const loadProjectIntoState = useCallback((data: ProjectData) => {
    setProjectId(data.id);
    setName(data.name);
    setAuthor(data.author);
    setParams(data.params);
    setRels(data.releases);
    setActs(data.acts);
  }, []);

  const switchProject = useCallback((id: string) => {
    const data = loadProject(id);
    if (data) loadProjectIntoState(data);
  }, [loadProjectIntoState]);

  const newProject = useCallback(() => {
    loadProjectIntoState(blankProject());
  }, [loadProjectIntoState]);

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

  const addRel = useCallback((): string => {
    const newName = `Release ${releases.length + 1}`;
    setRels((prev) => [...prev, { id: uid(), name: newName, fte: 1 }]);
    return newName;
  }, [releases]);

  const delRel = useCallback((id: string) =>
    setRels((prev) => prev.filter((r) => r.id !== id)), []);

  const updP = useCallback((k: keyof Parameters, v: string) =>
    setParams((prev) => ({ ...prev, [k]: parseFloat(v) || 0 })), []);

  const value = useMemo<EstimatorContextValue>(() => ({
    projectId, projects,
    name, author, params, releases, acts,
    summary, totals, byProfile,
    setName, setAuthor,
    updAct, addAct, delAct,
    updRel, addRel, delRel,
    updP,
    switchProject, newProject,
  }), [projectId, projects, name, author, params, releases, acts, summary, totals, byProfile, updAct, addAct, delAct, updRel, addRel, delRel, updP, switchProject, newProject]);

  return <EstimatorContext.Provider value={value}>{children}</EstimatorContext.Provider>;
}

export function useEstimatorContext(): EstimatorContextValue {
  const ctx = useContext(EstimatorContext);
  if (!ctx) throw new Error("useEstimatorContext must be used within EstimatorProvider");
  return ctx;
}
