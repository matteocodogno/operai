/**
 * The answers of the oversight path (specs/029 T19; plan § Errors; AC-1.6, AC-4.2, AC-5.4).
 *
 * - 403 `read_all_required` — `whose=all` or a `userId` without `time-entry:read-all`.
 * - 503 `authz_unavailable` — `auth` could not say whether the caller holds it: the read fails CLOSED (ADR-0014 posture),
 *   never open, and nothing of anyone else's is returned.
 * - 403 `owner_only` — a holder of the permission writing someone else's entry. Reading everyone's hours never becomes
 *   a way to change them (AC-1.6): the privilege is for looking (ADR-0075).
 */

import { ProblemError } from "../lib/problem";

/** 403 `read_all_required`: `whose=all` or a `userId` without the permission (AC-4.2). */
export const readAllRequired = (): ProblemError =>
  new ProblemError({ status: 403, code: "read_all_required", detail: "Reading everyone's hours needs the time-entry:read-all permission" });

/** 503 `authz_unavailable`: `auth` did not answer an oversight read (AC-5.4). */
export const authzUnavailable = (): ProblemError =>
  new ProblemError({ status: 503, code: "authz_unavailable", detail: "The authorization service is unavailable, so everyone's hours are not shown" });

/** 403 `owner_only`: a holder of `time-entry:read-all` writing someone else's entry (AC-1.6). */
export const ownerOnly = (): ProblemError =>
  new ProblemError({ status: 403, code: "owner_only", detail: "An entry can only be changed or deleted by the person who recorded it, even by those who may read everyone's hours" });
