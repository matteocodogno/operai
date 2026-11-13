/**
 * The error answers every hours-api route shares (specs/029 T10; plan § Errors). Next to the
 * `problem` copy, not in it: `problem.ts` is a byte-identical copy of crm-api's (the suite's error
 * shape) and its own `validationHook` answers 422, while this API's contract is 400
 * `invalid_request` for any schema violation (a body with an unknown key, a bad query, a bad
 * path parameter, malformed JSON); its 422s are the named rules (`invalid_minutes`,
 * `future_day`, …) that a route raises itself.
 */
import type { Context } from "hono";
import { env } from "./env";
import { handleProblemError, problem } from "./problem";

interface ZodIssueLike {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * `new OpenAPIHono({ defaultHook: invalidRequestHook })`. A failed schema parse is a 400
 * `invalid_request` whose top-level `field` names the first offending member (a dotted path for
 * nested ones; empty for a whole-object problem such as an unknown key, which the message names)
 * and whose `errors` lists them all. Messages are zod's own and name keys and types, never a stored
 * value.
 */
export const invalidRequestHook = (
  result: { success: true } | { success: false; error: { issues: readonly ZodIssueLike[] } },
  c: Context,
): Response | undefined => {
  if (result.success) return undefined;
  const errors = result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
  return problem(
    {
      status: 400,
      code: "invalid_request",
      detail: errors[0] ? `${errors[0].field || "body"}: ${errors[0].message}` : "Invalid request",
      extras: { field: errors[0]?.field ?? "", errors },
    },
    c.req.path,
  );
};

/**
 * `app.onError`. A `ProblemError` is a deliberate, typed answer (403 `owner_only`, 503
 * `host_unavailable`, …), not a fault. Anything else that carries a 4xx `status` is Hono's own
 * refusal of a request (malformed JSON): a Problem with its message, and `invalid_request` for a
 * 400. Everything else is a fault: a generic 500, and the log line carries the error's NAME and
 * CODE only. A database or driver error's message and stack can carry the statement and its
 * parameters, which here are what each person worked on and the notes they wrote.
 */
export const handleError = (err: Error, c: Context): Response => {
  const typed = handleProblemError(err, c.req.path);
  if (typed) return typed;

  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
    return problem(
      { status, detail: err.message, ...(status === 400 ? { code: "invalid_request" } : {}) },
      c.req.path,
    );
  }

  const code = (err as { code?: unknown }).code;
  console.error("[uncaught]", { name: err.name, ...(typeof code === "string" ? { code } : {}) });

  return problem(
    {
      status: 500,
      detail: env.NODE_ENV === "development" ? err.message : "An unexpected error occurred",
    },
    c.req.path,
  );
};

/** `app.notFound`: Problem JSON; names the method and the path, never a query or a body. */
export const handleNotFound = (c: Context): Response =>
  problem({ status: 404, detail: `${c.req.method} ${c.req.path} does not exist` }, c.req.path);
