/**
 * estimai-api client for an estimate's man-days (specs/022 T5, AC-3.1, ADR-0061).
 *
 * projects-api reads `GET /system/estimates/{id}/summary` as ITSELF: the 5-minute service JWT
 * (`serviceTokens`, scope `estimai.estimates.read`), never the caller's token — the person taking a
 * deal is often not a collaborator on its estimate, and estimai-api accepts no user JWT here. The
 * route answers `{ id, name, manDays }` and nothing of the estimate's content.
 *
 * `estimateManDays(id)`:
 *   a number        the estimate's Expected man-days (one decimal, >= 0);
 *   `null`          EstimAI answers 404: the purchase order keeps its estimate id and no man-days;
 *   ProblemError    503 `estimai_unconfigured` (ESTIMAI_INTERNAL_URL unset, or no service credential)
 *                   or 503 `estimai_unavailable` (down, refused, or an unreadable answer).
 *
 * The caller copies the number onto the terms once (A6); nothing here caches it.
 * Nothing here logs a token or a response body.
 */

import { env } from "./env";
import { ProblemError } from "./problem";
import { serviceTokens } from "./serviceToken";

const REQUEST_TIMEOUT_MS = 5_000;

const unconfigured = (): ProblemError =>
  new ProblemError({
    status: 503,
    code: "estimai_unconfigured",
    detail: "EstimAI is not configured for this service; the estimate's man-days cannot be read",
  });

const unavailable = (reason: string): ProblemError => {
  console.error("[estimai] man-days lookup failed:", reason);
  return new ProblemError({
    status: 503,
    code: "estimai_unavailable",
    detail: "EstimAI is unavailable; the estimate's man-days could not be read",
  });
};

/** The estimate's man-days, or `null` when EstimAI does not know the estimate. */
export async function estimateManDays(estimateId: string): Promise<number | null> {
  if (!env.ESTIMAI_INTERNAL_URL || !serviceTokens) throw unconfigured();

  let token: string;
  try {
    token = await serviceTokens.getToken();
  } catch (error) {
    throw unavailable(error instanceof Error ? error.message : "no service token");
  }

  let res: Response;
  try {
    res = await fetch(`${env.ESTIMAI_INTERNAL_URL}/system/estimates/${encodeURIComponent(estimateId)}/summary`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw unavailable(`request failed (${error instanceof Error ? error.name : "unknown error"})`);
  }

  if (res.status === 404) return null;
  // estimai-api answers every credential failure with one 401: drop the token so the next call mints a fresh one.
  if (res.status === 401) serviceTokens.invalidate(token);
  if (!res.ok) throw unavailable(`estimai-api responded with HTTP ${res.status}`);

  const body = (await res.json().catch(() => null)) as { manDays?: unknown } | null;
  const manDays = body?.manDays;
  if (typeof manDays !== "number" || !Number.isFinite(manDays) || manDays < 0) {
    throw unavailable("estimai-api returned an unreadable body");
  }
  return manDays;
}
