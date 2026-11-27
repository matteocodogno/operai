/**
 * The global error handler (RFC 7807 Problem JSON), `app.onError(...)` of `src/index.ts`. Its own module so a route-level test can
 * put the same handler on the routers it mounts, instead of proving the handler on a probe route that no request ever reaches.
 */
import type { Context } from "hono";
import { env } from "./env";
import { NUL_DATABASE_DETAIL, isNulDatabaseError, logNulRefusal } from "./nul";
import { describeUncaught } from "./uncaughtLog";

export function problemErrorHandler(err: Error, c: Context): Response {
  // Safety net for a NUL that no schema refused: the request was wrong, not the server (QE D2). Names no value.
  if (isNulDatabaseError(err)) {
    logNulRefusal(err); // the code only (A09): a server-built bad value must not be blamed on the client with no trace
    return c.json(
      {
        type: "https://httpstatuses.com/400",
        title: "Bad Request",
        status: 400,
        detail: NUL_DATABASE_DETAIL,
        code: "validation_failed",
        instance: c.req.path,
      },
      400,
    );
  }

  console.error("[uncaught]", describeUncaught(err)); // name, code and the code's frames; a database cause by name and code only (A09)

  const status =
    "status" in err && typeof (err as { status: number }).status === "number"
      ? (err as { status: number }).status
      : 500;

  return c.json(
    {
      type: `https://httpstatuses.com/${status}`,
      title: status === 500 ? "Internal Server Error" : err.message,
      status,
      detail: env.NODE_ENV === "development" ? err.message : "An unexpected error occurred",
      instance: c.req.path,
    },
    status as 500,
  );
}
