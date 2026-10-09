/**
 * RFC 7807 Problem JSON for inventory-api (specs/015-hardware-inventory,
 * plan.md § API contracts: "Errors are RFC 7807 Problem JSON with a `code`
 * where listed").
 *
 * The extra members a problem carries (`code`, `serialNumber`, `assetId`,
 * `year`, `from`, `field`, …) are TOP-LEVEL members of the problem object —
 * never nested under an `extras`/`detail` object. inventory-ui's `ApiError`
 * reads them straight off the body (`inventory-ui/src/lib/types.ts`
 * `toInventoryError`), so a nested shape would silently turn every typed error
 * into an untyped one.
 *
 * Three ways in, all producing the same body:
 *   - `problem(...)`        a ready `Response`, for middleware that returns;
 *   - `ProblemError`        thrown from a service or a transaction callback;
 *                           index.ts's `app.onError` renders it via
 *                           `handleProblemError` (a throw inside
 *                           `db.$transaction` is also what rolls it back);
 *   - `validationHook`      the zod-openapi `defaultHook`, so a body that fails
 *                           its schema is a 422 naming the field, not the
 *                           library's default 400.
 */

import type { Context } from "hono";

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  428: "Precondition Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** Members the standard shape owns; an `extras` key can never overwrite them. */
const RESERVED = ["type", "title", "status", "detail", "instance", "code"];

export type ProblemExtras = Readonly<Record<string, unknown>>;

export interface ProblemInit {
  readonly status: number;
  readonly detail: string;
  /** Machine-readable discriminator the UI switches on (`fiscal_year_closed`, …). */
  readonly code?: string;
  /** Top-level extension members, e.g. `{ year: 2025 }`. */
  readonly extras?: ProblemExtras;
}

export function problemBody(
  init: ProblemInit,
  instance: string,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(init.extras ?? {})) {
    if (!RESERVED.includes(key)) extras[key] = value;
  }
  return {
    // Extension members first so the standard ones always win.
    ...extras,
    type: `https://httpstatuses.com/${init.status}`,
    title: TITLES[init.status] ?? "Error",
    status: init.status,
    detail: init.detail,
    instance,
    ...(init.code !== undefined ? { code: init.code } : {}),
  };
}

/** A Problem JSON `Response`. */
export function problem(init: ProblemInit, instance: string): Response {
  return Response.json(problemBody(init, instance), { status: init.status });
}

/**
 * Thrown to end a request with a Problem JSON answer. Carries `status` so
 * anything that only looks at `err.status` still behaves.
 */
export class ProblemError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly extras: ProblemExtras;

  constructor(init: ProblemInit) {
    super(init.detail);
    this.name = "ProblemError";
    this.status = init.status;
    this.code = init.code;
    this.extras = init.extras ?? {};
  }

  toResponse(instance: string): Response {
    return problem(
      {
        status: this.status,
        detail: this.message,
        ...(this.code !== undefined ? { code: this.code } : {}),
        extras: this.extras,
      },
      instance,
    );
  }
}

/**
 * The `ProblemError` branch of the global `app.onError`: a `Response` when
 * `err` is one, `null` otherwise (the caller falls through to its 500 path).
 */
export function handleProblemError(
  err: unknown,
  instance: string,
): Response | null {
  return err instanceof ProblemError ? err.toResponse(instance) : null;
}

// ─── Convenience constructors for the denials every route shares ─────────────

export const forbidden = (detail: string, code?: string): ProblemError =>
  new ProblemError({ status: 403, detail, ...(code ? { code } : {}) });

export const notFound = (detail = "Not found"): ProblemError =>
  new ProblemError({ status: 404, detail });

export const conflict = (
  code: string,
  detail: string,
  extras?: ProblemExtras,
): ProblemError =>
  new ProblemError({
    status: 409,
    code,
    detail,
    ...(extras ? { extras } : {}),
  });

export const unprocessable = (
  detail: string,
  extras?: ProblemExtras & { field?: string },
  code?: string,
): ProblemError =>
  new ProblemError({
    status: 422,
    detail,
    ...(code ? { code } : {}),
    ...(extras ? { extras } : {}),
  });

// ─── zod-openapi validation hook ─────────────────────────────────────────────

interface ZodIssueLike {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * `new OpenAPIHono({ defaultHook: validationHook })`. A failed schema parse is
 * a 422 whose top-level `field` names the first offending member (dotted path
 * for nested ones, e.g. `serialNumbers.2`) and whose `errors` lists them all.
 * Without it the library answers 400 in its own shape, which no AC allows.
 */
export const validationHook = (
  result:
    | { success: true }
    | { success: false; error: { issues: readonly ZodIssueLike[] } },
  c: Context,
): Response | undefined => {
  if (result.success) return undefined;
  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
  return problem(
    {
      status: 422,
      detail: errors[0]
        ? `${errors[0].field || "body"}: ${errors[0].message}`
        : "Invalid request",
      extras: { field: errors[0]?.field ?? "", errors },
    },
    c.req.path,
  );
};
