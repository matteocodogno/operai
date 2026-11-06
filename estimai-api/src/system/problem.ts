/**
 * RFC 7807 Problem JSON for the `/system/*` routes (specs/022 T2). Same body shape as
 * the rest of estimai-api (`type`, `title`, `status`, `detail`, `instance`) plus the
 * machine-readable `code` crm-api's and projects-api's problems carry.
 */

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
};

export interface ProblemInit {
  readonly status: number;
  readonly detail: string;
  readonly code?: string;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code?: string;
}

export function problemBody(init: ProblemInit, instance: string): ProblemBody {
  return {
    type: `https://httpstatuses.com/${init.status}`,
    title: TITLES[init.status] ?? "Error",
    status: init.status,
    detail: init.detail,
    instance,
    ...(init.code !== undefined ? { code: init.code } : {}),
  };
}

/** A Problem JSON `Response`, for middleware that returns. */
export function problem(init: ProblemInit, instance: string): Response {
  return Response.json(problemBody(init, instance), { status: init.status });
}
