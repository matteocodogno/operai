/**
 * `timeEntryRecordedEvent` — the browser event a save made with Record hours broadcasts, and the guard every listener asks
 * (specs/20261112-project-hours T10; plan § "Browser event" and § "Refreshing after Record hours"; D84, D-P6; AC-2.8; ADR
 * 20261116-record-hours-widget-through-the-host-extension-seam, amended 2026-11-26).
 *
 * hours-ui's `./RecordHours` dispatches ONE `CustomEvent` on `window` after a `POST /time-entries` that succeeded, naming only
 * the target it wrote to: a project, a deal, or other work (`targetId` is `''` then). No minutes, no day, no person, no entry id,
 * no note: it is a fact that something changed there, never what. A panel that shows that target's figures (hours-ui's
 * `HostHours`, projects-ui's `ConsumptionBlock`) listens while it is mounted and, when the detail names its own target, reads its
 * figures again from their owner; it never takes a figure from the event. Nothing comes back to the dispatcher.
 *
 * Any script of the page can dispatch an event with this name, so a listener runs `isTimeEntryRecordedDetail` first and ignores
 * what fails it. The guard is strict on purpose: exactly the two members, nothing else (a different message is not this one).
 *
 * This file is a byte-identical copy in `hours-ui/src/lib/timeEntryRecordedEvent.ts` and
 * `projects-ui/src/lib/timeEntryRecordedEvent.ts` (the two apps are installed and deployed on their own, with no shared package);
 * `scripts/check-shared-copies.ts` (`mise run shared:check`, in CI) fails when they differ by a byte. A change is a change to both
 * files in one commit.
 */

/** The event's name, on `window`. */
export const TIME_ENTRY_RECORDED = 'operai:time-entry-recorded'

/** What the event names: the project or deal the hours were recorded on, or `none` (other work), with `targetId` `''`. */
export type TimeEntryRecordedDetail = { on: 'project' | 'deal' | 'none'; targetId: string }

const KINDS: readonly string[] = ['project', 'deal', 'none']

/**
 * Whether `value` is exactly a `TimeEntryRecordedDetail`: an object whose own members are `on` (project, deal or none) and
 * `targetId` (text) and no others; a project or a deal names its target (not blank), and `none` names none (`''`).
 */
export function isTimeEntryRecordedDetail(value: unknown): value is TimeEntryRecordedDetail {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'on' || keys[1] !== 'targetId') return false
  const { on, targetId } = value as Record<string, unknown>
  if (typeof on !== 'string' || !KINDS.includes(on) || typeof targetId !== 'string') return false
  return on === 'none' ? targetId === '' : targetId.trim() !== ''
}
