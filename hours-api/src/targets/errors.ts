/**
 * The answers of a bookability check (specs/029 T15; plan § Errors; AC-2.2, AC-2.5, AC-2.10, AC-2.11).
 *
 * The three that matter to a person are the same whatever the target is, so they are made here once:
 *
 * - 404 `not_found` — the target does not exist, or the caller may not read it, or (a meeting) the caller is
 *   not one of its people. ONE body for all of them, naming no kind of target and no id, so the id space is no
 *   oracle for what other people may read (AC-2.10, ADR-0089 "existence and access").
 * - 403 `not_on_project` — the target is readable and the caller is not on it. The only answer that says more
 *   than "no", and only because the caller can read the project anyway (ADR-0052 posture).
 * - 503 `host_unavailable` — the owner could not say, or said something that is not an answer (AC-2.11): the
 *   write fails CLOSED, nothing is recorded, and the person can try again.
 */

import { ProblemError } from "../lib/problem";

/** 404 `not_found`: one body for "missing", "not readable" and "not yours" (AC-2.10). */
export const targetNotFound = (): ProblemError =>
  new ProblemError({ status: 404, code: "not_found", detail: "There is nothing of yours with this id to record hours on" });

/** 403 `not_on_project`: the project is readable, the caller is neither its project manager nor on its team (AC-2.2). */
export const notOnProject = (): ProblemError =>
  new ProblemError({ status: 403, code: "not_on_project", detail: "Hours can only be recorded on a project you are the project manager or a team member of" });

/** 503 `host_unavailable`: the tool that owns the target did not answer the check, so nothing was recorded (AC-2.11). */
export const hostUnavailable = (): ProblemError =>
  new ProblemError({ status: 503, code: "host_unavailable", detail: "The tool that owns this could not be asked whether you may record hours on it, so nothing was saved" });
