/**
 * May this person record hours on this? Asked of the tool that owns it, AS THE CALLER, at the moment of the
 * write (specs/029 T15; plan § Sequences; ADR-0089; AC-2.2, AC-2.5, AC-2.10, AC-2.11).
 *
 * hours-api holds no list of who is on a project or a meeting and never decides it: a person who left a team,
 * a project made unreadable to them, a meeting relinked — each applies on the next write, because the owner is
 * asked every time and nothing is remembered (no cache, no copy). The caller's own `Authorization` is forwarded
 * unchanged (src/clients/owner.ts), so the answer is the PERSON's, not the service's.
 *
 * What is checked, and when, is the route's decision (src/entries/entries.routes.ts): a new entry, and an entry
 * MOVED to another target; never a change that keeps the target and never a delete (AC-2.4, AC-2.12, D46).
 * This module only answers the question it is asked, and fails closed:
 *
 *   owner did not answer (down, slow, 5xx, an undeployed route, an answer that is not one) → 503 host_unavailable
 *   target missing, or the caller may not read it, or is not one of a meeting's people → 404 not_found (one body)
 *   project readable, caller not its project manager or team → 403 not_on_project
 *
 * Every id reaching here has passed the id rule (src/lists/idRule.ts): the clients rely on it, so an owner's
 * 4xx is always a version gap and never the caller's malformed input (plan R7).
 */

import { listMeetingsByIds } from "../clients/meetings";
import { resolveProjects } from "../clients/projects";
import { ProblemError } from "../lib/problem";
import { hostUnavailable, notOnProject, targetNotFound } from "./errors";

/** What an entry is booked on, as an owner knows it. */
export interface BookableTarget {
  readonly type: "project" | "deal" | "meeting";
  readonly id: string;
}

/** The caller, and the credential an owner is asked with: their own, unchanged. */
export interface Caller {
  readonly userId: string;
  readonly authorization: string;
}

/**
 * Resolves unless the caller may not book on `target`; then throws the `ProblemError` that says why (above).
 * Throws on EVERY outcome but "yes": there is no value to forget to check.
 */
export async function assertBookable(caller: Caller, target: BookableTarget): Promise<void> {
  switch (target.type) {
    case "project":
      return assertOnProject(caller, target.id);
    case "meeting":
      return assertOnMeeting(caller, target.id);
    case "deal":
      // TODO(T16): until deals are checked a write on one is refused, never accepted unchecked.
      throw new ProblemError({
        status: 501,
        code: "not_implemented",
        detail: "Hours on a deal cannot be recorded yet: whether you may book on it is not checked here yet",
      });
  }
}

/**
 * A project: the caller must be its project manager or on its team — `assignees` of projects-api's host
 * resolve (src/clients/projects.ts). `writable` (false for a closed or cancelled project) is NOT read:
 * entries are accepted in any project state (A12).
 */
async function assertOnProject({ userId, authorization }: Caller, projectId: string): Promise<void> {
  const outcome = await resolveProjects(authorization, [projectId]);
  if (outcome.state === "unavailable") throw hostUnavailable();
  // No `projects:access` reads nothing at all: as good as missing, and the same 404 (AC-2.10).
  if (outcome.state === "not_reader") throw targetNotFound();

  // The client answers every asked id or is `unavailable`; an id it did not answer is not an answer either.
  const project = outcome.items.get(projectId);
  if (project === undefined) throw hostUnavailable();
  if (project.state === "missing") throw targetNotFound();
  if (!project.assignees.includes(userId)) throw notOnProject();
}

/**
 * A meeting: the caller must be its creator or one of its Operai participants. meetings-api's own list
 * answers exactly that — it lists the caller's OWN meetings only, `ids` narrowing them — so a meeting that
 * is absent is one the caller took part in no way: unknown, someone else's, or readable only through its
 * host (a CRM deal's page), which is never a way to book (ADR-0058: visibility by relationship, never by
 * role). All three are the one 404; none is told apart. A list that ignored `ids` is the client's
 * `unavailable` (a meetings-api older than T8 answers the caller's latest page: that page's silence about
 * the asked meeting is no "no", plan R7).
 */
async function assertOnMeeting({ authorization }: Caller, meetingId: string): Promise<void> {
  const outcome = await listMeetingsByIds(authorization, [meetingId]);
  if (outcome.state === "unavailable") throw hostUnavailable();
  // The client keeps only a creator's or a participant's row.
  if (!outcome.items.has(meetingId)) throw targetNotFound();
}
