/**
 * What the global error handler writes for a failure it has no answer for (security review A09). Since specs/20261126-teams QE F1 a
 * route keeps the database's error as the `cause` of the `Error` it throws, and a Prisma or driver error's message can embed the
 * query's arguments (an id, an email, the text of a record). Logging the whole error, as `console.error("[uncaught]", err)` did, writes
 * that chain. So: the error's own message and call frames (the code's, not the driver's), and every error down the `cause` chain
 * reduced to its name and code. An error that is itself a Prisma or driver error has no message here either, for the same reason.
 */

/** How far down a `cause` chain the log reads: route error -> tagged repository error -> Prisma error -> driver error. */
const MAX_DEPTH = 6;

export interface UncaughtDescription {
  readonly name: string;
  readonly code?: string | number;
  /** Absent when the error is a Prisma or driver error: its message can hold the query's arguments. */
  readonly message?: string;
  /** The call frames only (`    at …`), never the first line, which repeats the message. */
  readonly frames?: string;
  readonly causes: readonly { readonly name: string; readonly code?: string | number }[];
}

const codeOf = (error: unknown): string | number | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
};

const nameOf = (error: unknown): string => {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : "UnknownError";
};

/** A Prisma client error or a driver error: what carries a query's arguments in its message. */
const isDatabaseShaped = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (nameOf(error).startsWith("Prisma") || "clientVersion" in error || "meta" in error || nameOf(error) === "DriverAdapterError");

export function describeUncaught(error: unknown): UncaughtDescription {
  const code = codeOf(error);
  const causes: { name: string; code?: string | number }[] = [];
  let current: unknown = typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined && current !== null; depth++) {
    const causeCode = codeOf(current);
    causes.push({ name: nameOf(current), ...(causeCode !== undefined ? { code: causeCode } : {}) });
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  const message = error instanceof Error && !isDatabaseShaped(error) ? error.message : undefined;
  const stack = error instanceof Error && !isDatabaseShaped(error) ? error.stack : undefined;
  const at = stack === undefined ? -1 : stack.indexOf("\n    at ");
  return {
    name: nameOf(error),
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(stack !== undefined && at >= 0 ? { frames: stack.slice(at + 1) } : {}),
    causes,
  };
}
