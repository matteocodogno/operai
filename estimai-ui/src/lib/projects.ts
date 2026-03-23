import type { Activity, Parameters, ProjectMeta, Release } from '../types'

export const PROJECTS_KEY = 'estimai_projects'
export const CURRENT_ID_KEY = 'estimai_current_id'
export const projectKey = (id: string) => `estimai_project_${id}`

export interface ProjectData {
  id: string
  name: string
  author: string
  params: Parameters
  releases: Release[]
  acts: Activity[]
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 9)
}

export const DEF_PARAMS: Parameters = {
  parallelism: 0.7,
  sprintDays: 10,
  workingDaysMonth: 20,
  qaDeployDays: 0,
  qaTestDays: 0,
  pmDays: 0,
  aiCostCoef: 10,
  aiGain: 0.30,
}

export function loadProjects(): ProjectMeta[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY)
    return raw ? (JSON.parse(raw) as ProjectMeta[]) : []
  } catch {
    return []
  }
}

export function saveProjects(projects: ProjectMeta[]): void {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
}

export function loadProject(id: string): ProjectData | null {
  try {
    const raw = localStorage.getItem(projectKey(id))
    return raw ? (JSON.parse(raw) as ProjectData) : null
  } catch {
    return null
  }
}

export function saveProjectData(data: ProjectData): void {
  localStorage.setItem(projectKey(data.id), JSON.stringify(data))
  const meta: ProjectMeta = { id: data.id, name: data.name, author: data.author, updatedAt: new Date().toISOString() }
  const existing = loadProjects()
  const idx = existing.findIndex(p => p.id === data.id)
  const next = idx >= 0 ? existing.map(p => p.id === data.id ? meta : p) : [...existing, meta]
  saveProjects(next)
}

export function createProject(): string {
  const id = uid()
  saveProjectData({ id, name: '', author: '', params: { ...DEF_PARAMS }, releases: [], acts: [] })
  localStorage.setItem(CURRENT_ID_KEY, id)
  return id
}

export function duplicateProject(id: string): string | null {
  const data = loadProject(id)
  if (!data) return null
  const newId = uid()
  saveProjectData({ ...data, id: newId, name: data.name ? `${data.name} (copy)` : 'Untitled (copy)' })
  return newId
}

export function deleteProject(id: string): void {
  localStorage.removeItem(projectKey(id))
  saveProjects(loadProjects().filter(p => p.id !== id))
}

export function getLastProjectId(): string | null {
  return localStorage.getItem(CURRENT_ID_KEY)
}
