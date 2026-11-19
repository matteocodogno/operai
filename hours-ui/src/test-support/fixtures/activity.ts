/**
 * Fixtures of the activity field (T26): what activities-api answers for `GET /activities?projectId=` and
 * `?dealId=`, built on `fakeApi`'s `activityItem`/`page`. The newest first order is activities-api's own
 * (`occurredAt` desc), which the field must keep.
 */
import { activityItem, page } from '../fakeApi'

/** A project's activities are tasks (operational). */
export const projectTasks = [
  activityItem({ id: 'a-offer', subject: 'Write the offer', occurredAt: '2026-11-05T09:00:00.000Z' }),
  activityItem({ id: 'a-review', subject: 'Review the design', occurredAt: '2026-11-04T09:00:00.000Z' }),
]

/** A deal's activities are pre-sales ones about its company: any type, with a deal. */
export const dealActivities = [
  activityItem({
    id: 'a-call',
    kind: 'pre_sales',
    type: 'call',
    subject: 'Call Acme about the renewal',
    project: null,
    company: { id: 'c1', name: 'Acme' },
    deal: { id: 'd1', title: 'Acme renewal' },
  }),
  activityItem({
    id: 'a-note',
    kind: 'pre_sales',
    type: 'note',
    subject: 'Budget is fixed',
    project: null,
    company: { id: 'c1', name: 'Acme' },
    deal: { id: 'd1', title: 'Acme renewal' },
  }),
  activityItem({
    id: 'a-task',
    kind: 'pre_sales',
    type: 'task',
    subject: 'Send the offer',
    project: null,
    company: { id: 'c1', name: 'Acme' },
    deal: { id: 'd1', title: 'Acme renewal' },
  }),
]

/** `n` tasks, newest first: `Task 1` is the newest. */
export const manyTasks = (n: number) =>
  Array.from({ length: n }, (_, index) => activityItem({ id: `a-${index + 1}`, subject: `Task ${index + 1}` }))

/** The current activity of an edited entry, as the entry's view carries it (no type). */
export const currentActivity = { id: 'a-offer', subject: 'Write the offer', visibility: 'visible' as const }

/** The answer of `GET /activities` for `items`; `total` is the whole count when the page holds fewer. */
export const activitiesAnswer = (items: unknown[], total = items.length) => ({ status: 200, body: page(items, total) })
