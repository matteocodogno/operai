/**
 * The state machine of a project (specs/021 AC-1.2, AC-1.3, A10). Pure: no database, no request.
 * Its type never changes (specs/022 A30, D40), so there is no type change here.
 */

import type { ProjectState } from "./projects.schemas";

/** The two columns a transition reads and writes. `stateBeforeHold` is set iff `state` is `on_hold` (a CHECK). */
export interface StateSnapshot {
  readonly state: ProjectState;
  readonly stateBeforeHold: ProjectState | null;
}

/** Where each state may go. `on_hold` is handled apart: it returns only to the state it left. */
const MOVES: Readonly<Record<Exclude<ProjectState, "on_hold">, readonly ProjectState[]>> = {
  planned: ["active", "on_hold", "cancelled"],
  active: ["on_hold", "closed", "cancelled"],
  closed: ["active"],
  cancelled: [], // final
};

/**
 * The snapshot after moving to `to`, or `null` when AC-1.3 does not allow that move.
 * Putting a project on hold remembers the state it left; every other move forgets it.
 */
export function applyTransition(current: StateSnapshot, to: ProjectState): StateSnapshot | null {
  if (current.state === "on_hold") {
    const back = current.stateBeforeHold;
    if (back !== null && to === back) return { state: back, stateBeforeHold: null };
    return to === "cancelled" ? { state: "cancelled", stateBeforeHold: null } : null;
  }
  if (!MOVES[current.state].includes(to)) return null;
  return { state: to, stateBeforeHold: to === "on_hold" ? current.state : null };
}
