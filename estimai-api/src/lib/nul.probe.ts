/**
 * Child-process script of `nul.test.ts`; not part of the service. It loads the REAL app (`src/index.ts`), puts the app's own error
 * handler (the one `app.onError` installed) on a probe route that throws the errors a NUL gives, and prints each answer as one JSON
 * line. A child, because importing the whole app in the test process would load every router into the shared module registry of the run.
 */
import { Hono, type ErrorHandler } from "hono";

const { app } = await import(process.cwd() + "/src/index.ts");
const { db } = await import(process.cwd() + "/src/lib/db.ts");

let thrown: unknown;
const probe = new Hono();
probe.get("/__nul-probe", () => {
  throw thrown;
});
probe.onError((app as unknown as { errorHandler: ErrorHandler }).errorHandler);

// What the safety net writes to console.warn (security review A09): kept per answer, so the test can read the line and prove it holds no value.
const warned: unknown[][] = [];
// Only the `[nul]` lines count: another warning (a token check, a log of the request) is not the safety net's and must not be mistaken for it.
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[nul]")) warned.push(args);
};

// What the fallback writes to console.error (security review A09, the cause chain): kept per answer as the text a log shipper would receive.
const errored: string[] = [];
console.error = (...args: unknown[]) => {
  if (args[0] === "[uncaught]") errored.push(Bun.inspect(args.slice(1), { depth: 8 }));
};

const out: Record<string, { status: number; body: string; warned: unknown[][]; errored: string[] }> = {};
const hit = async (label: string) => {
  warned.length = 0;
  errored.length = 0;
  const res = await probe.request("/__nul-probe?q=secret-query");
  out[label] = { status: res.status, body: await res.text(), warned: warned.map((line) => [...line]), errored: [...errored] };
};

try {
  await db.$queryRaw`select ${"a\u0000b"}::text`;
} catch (error) {
  thrown = error;
}
await hit("real");

const adapter = (sqlstate: string) => ({ name: "DriverAdapterError", cause: { kind: "postgres", code: sqlstate, originalCode: sqlstate } });
thrown = Object.assign(new Error("Invalid `db.thing.create()` invocation: secret-note"), { code: "P2039", meta: { target: ["secret-value"], args: { data: "secret-value" }, driverAdapterError: { ...adapter("22021"), message: "secret-note" } } });
await hit("wrapped");
thrown = Object.assign(new Error("Raw query failed secret-note"), { code: "P2010", meta: { driverAdapterError: adapter("22P05") } });
await hit("raw-jsonb");
thrown = Object.assign(new Error("invalid byte sequence secret-note"), adapter("22021"));
await hit("adapter");
thrown = Object.assign(new Error("unsupported Unicode escape sequence secret-note"), { code: "22P05" });
await hit("pg");
thrown = Object.assign(new Error("dup"), { code: "P2039", meta: { driverAdapterError: adapter("23505") } });
await hit("other-sqlstate");
thrown = Object.assign(new Error("down"), { code: "P1001" });
await hit("other");

// What the routes throw (QE F1): the repository's tagged `DatabaseError` carrying the driver's error, wrapped by `unexpectedDbFailure`.
// Before the fix the wrapper dropped the cause, so the safety net above could never see the NUL.
const { Cause } = await import("effect");
const { DatabaseError } = await import(process.cwd() + "/src/lib/errors.ts");
const { unexpectedDbFailure } = await import(process.cwd() + "/src/lib/dbFailure.ts");
const tagged = (cause: unknown) => unexpectedDbFailure("Unexpected database failure fetching estimate", Cause.fail(new DatabaseError({ message: "Failed to fetch estimate", cause })));
thrown = tagged(
  await db.$queryRaw`select ${"a\u0000b"}::text`.then(
    () => undefined,
    (error: unknown) => error,
  ),
);
await hit("tagged-real");
thrown = tagged(Object.assign(new Error("Invalid `db.thing.create()` invocation: secret-note"), { code: "P2039", meta: { driverAdapterError: { ...adapter("22021"), message: "secret-note" } } }));
await hit("tagged-wrapped");
thrown = tagged(Object.assign(new Error("down"), { code: "P1001" }));
await hit("tagged-other");

// A wrapped failure that is not about a NUL ends in the fallback's log: the route's own message and the cause by name and code, and nothing of
// the Prisma message, whose text carries the query's arguments (security review A09).
thrown = tagged(
  Object.assign(new Error("Invalid `db.estimate.findUnique()` invocation: where: { ownerId: 'sentinel-owner@example.test' }"), {
    name: "PrismaClientKnownRequestError",
    code: "P2024",
    clientVersion: "7.0.0",
    meta: { args: { where: { ownerId: "sentinel-owner@example.test" } } },
  }),
);
await hit("tagged-sentinel");
thrown = Object.assign(new Error("Invalid `db.estimate.create()` invocation: data: { name: 'sentinel-top-name' }"), {
  name: "PrismaClientKnownRequestError",
  code: "P2024",
  clientVersion: "7.0.0",
  meta: { args: { data: { name: "sentinel-top-name" } } },
});
await hit("top-sentinel");

console.log("RESULT " + JSON.stringify(out));
process.exit(0);
