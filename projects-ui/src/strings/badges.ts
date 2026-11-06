/** Labels of the project vocabularies: type, state, entity. Shared by the list, the page and the forms. */
import type { Entity, ProjectState, ProjectType } from '../lib/types'

const en = {
  projectType: {
    t_and_m: 'Time & material',
    fixed_price: 'Fixed price',
    maintenance: 'Maintenance',
    saas: 'SaaS',
    internal: 'Internal',
  } as Record<ProjectType, string>,
  projectState: {
    planned: 'Planned',
    active: 'Active',
    on_hold: 'On hold',
    closed: 'Closed',
    cancelled: 'Cancelled',
  } as Record<ProjectState, string>,
  entity: { welld_ch: 'wellD CH', welld_it: 'wellD IT' } as Record<Entity, string>,
}

const it: typeof en = {
  projectType: {
    t_and_m: 'Tempo e materiali',
    fixed_price: 'Prezzo fisso',
    maintenance: 'Manutenzione',
    saas: 'SaaS',
    internal: 'Interno',
  },
  projectState: {
    planned: 'Pianificato',
    active: 'Attivo',
    on_hold: 'In pausa',
    closed: 'Chiuso',
    cancelled: 'Annullato',
  },
  entity: { welld_ch: 'wellD CH', welld_it: 'wellD IT' },
}

export const badges = { en, it }
