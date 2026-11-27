/**
 * The database's refusal of a U+0000 (specs/20261126-teams QE D2 follow-up). Postgres text, and the text inside a jsonb value, cannot
 * hold one. A NUL that gets past validation reaches the driver and comes back as Postgres 22021 (`invalid byte sequence`, in text)
 * or 22P05 (`unsupported Unicode escape sequence`, in jsonb), which Prisma 7 wraps as P2039 (a model query) or P2010 (a raw one) with
 * the SQLSTATE on `meta.driverAdapterError.cause`. The global error handler of every service asks this one question and answers a
 * 400 instead of a 500: the request was wrong, not the server.
 *
 * The check reads codes only, never a message, so it cannot be fooled by (or repeat) text the caller wrote.
 */
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
