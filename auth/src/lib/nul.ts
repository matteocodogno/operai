/**
 * U+0000 in a request (specs/20261126-teams QE D2 follow-up). Postgres text, and the text inside a jsonb value, cannot hold one.
 * Two choke points, both answering a 400 `validation_failed` that names no value:
 *
 *   - `rejectNul`, a middleware in front of the whole app: a NUL in the path, the query or a JSON body is refused before any route,
 *     schema or database call, however many string inputs a route has and whichever route someone adds next;
 *   - `isNulDatabaseError`, asked by the global error handler: a NUL that still reached Postgres (a header, a value built from
 *     other values) comes back as 22021 or 22P05, which Prisma 7 wraps as P2039 or P2010, and is answered the same 400, not a 500.
 */
import type { MiddlewareHandler } from "hono";

// shared-copy:begin nulDatabaseError
const NUL_SQLSTATES: ReadonlySet<string> = new Set(["22021", "22P05"]);
const PRISMA_DRIVER_CODES: ReadonlySet<string> = new Set(["P2039", "P2010"]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/** A driver error's SQLSTATE: `code` as `pg` throws it, `originalCode` as Prisma's driver adapter keeps it. */
const isNulSqlState = (value: unknown): boolean => {
  const err = asRecord(value);
  return err !== null && [err["code"], err["originalCode"]].some((c) => typeof c === "string" && NUL_SQLSTATES.has(c));
};

/**
 * True for the error Postgres raises when a text or jsonb value holds a NUL, in each form it reaches us in: unwrapped from `pg`
 * (SQLSTATE in `code`), as Prisma's `DriverAdapterError` (SQLSTATE in `cause`), or wrapped as P2039 (a model query) or P2010 (a raw
 * one) with the adapter error in `meta`. It reads codes only, never a message, so text the caller wrote cannot fool it.
 */
export function isNulDatabaseError(error: unknown): boolean {
  const err = asRecord(error);
  if (!err) return false;
  if (isNulSqlState(err) || isNulSqlState(err["cause"])) return true;
  if (typeof err["code"] !== "string" || !PRISMA_DRIVER_CODES.has(err["code"])) return false;
  const adapter = asRecord(asRecord(err["meta"])?.["driverAdapterError"]);
  return isNulSqlState(adapter) || isNulSqlState(adapter?.["cause"]);
}

/** The one sentence a refused request gets: it names the character, never the value or the database's own text. */
export const NUL_DATABASE_DETAIL = "The request contains a NUL character (U+0000), which cannot be stored.";

/**
 * The one line the safety net leaves (security review A09): without it a server-built value with bad bytes would be answered as the
 * client's mistake with no trace. It holds the Prisma and SQLSTATE codes and nothing else: each code is taken from the two closed
 * sets above, never from a message, a value, an argument or the request, so no text anyone wrote can reach the log through it.
 */
export const NUL_REFUSAL_LOG_LINE = "[nul] database refused U+0000 or invalid text";

/** `P2039/22021`, `22P05`, ...: the recognised codes of a refusal, in the order Prisma and then Postgres give them. */
export function nulRefusalCodes(error: unknown): string {
  const err = asRecord(error);
  if (!err) return "unknown";
  const adapter = asRecord(asRecord(err["meta"])?.["driverAdapterError"]);
  const found: string[] = [];
  const take = (value: unknown, allowed: ReadonlySet<string>): void => {
    if (typeof value === "string" && allowed.has(value) && !found.includes(value)) found.push(value);
  };
  take(err["code"], PRISMA_DRIVER_CODES);
  for (const source of [err, asRecord(err["cause"]), adapter, asRecord(adapter?.["cause"])]) {
    take(source?.["code"], NUL_SQLSTATES);
    take(source?.["originalCode"], NUL_SQLSTATES);
  }
  return found.length > 0 ? found.join("/") : "unknown";
}

/** Logs the refusal: one `console.warn`, the line and the codes. Called by the global error handler right before it answers 400. */
export function logNulRefusal(error: unknown): void {
  console.warn(NUL_REFUSAL_LOG_LINE, nulRefusalCodes(error));
}
// shared-copy:end nulDatabaseError

/** `%00` in the raw target: the only way a URL carries a NUL (a literal one is percent-encoded by the URL parser). */
const ENCODED_NUL = /%00/i;
/**
 * A JSON string escape `\u0000` that is a real escape: preceded by an even number of backslashes (the pairs are escaped backslashes,
 * so `\\u0000` is a backslash and the text "u0000", which is fine). A raw NUL character is not valid JSON, and is refused too.
 */
const JSON_NUL_ESCAPE = /(?<!\\)(?:\\\\)*\\u0000|\u0000/;

/** The 400 a NUL gets, from the guard and from the error handler alike. Nothing of the request but its path (`instance`). */
export const nulProblem = (path: string): Response =>
  Response.json(
    {
      type: "https://httpstatuses.com/400",
      title: "Bad Request",
      status: 400,
      detail: NUL_DATABASE_DETAIL,
      instance: path,
      code: "validation_failed",
    },
    { status: 400, headers: { "Content-Type": "application/problem+json" } },
  );

/**
 * Refuses a NUL in the path, the query or a JSON body. The body is read from a clone, so the route (and anything that wraps the
 * request, a body limit or the sign-in library) still reads the original untouched. Not JSON, no body, or a body that cannot be
 * read: let the request through, the route refuses or fails on its own terms.
 */
export const rejectNul: MiddlewareHandler = async (c, next) => {
  if (ENCODED_NUL.test(c.req.url)) return nulProblem(c.req.path);

  const type = c.req.header("content-type") ?? "";
  if (c.req.raw.body && /\bjson\b/i.test(type)) {
    let text: string | null = null;
    try {
      text = await c.req.raw.clone().text();
    } catch {
      text = null;
    }
    if (text !== null && JSON_NUL_ESCAPE.test(text)) return nulProblem(c.req.path);
  }
  await next();
  return undefined;
};
