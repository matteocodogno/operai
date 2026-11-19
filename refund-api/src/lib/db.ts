import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({
  connectionString: process.env["DATABASE_URL"],
});

export const db: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env["NODE_ENV"] === "development"
        ? ["info", "error", "warn"]
        : ["error"],
  });

// Reuse the same instance across hot-reloads (bun --hot)
if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = db;
}

/**
 * A client for command-line scripts that must never print a raw driver error (T57, specs/20261119-accounting; F-03, AC-6.10).
 * `db` above logs `error` (plus `info` and `warn` in development) through Prisma, and that text carries the invocation
 * arguments, the source path and, for a connection failure, the host. A script that reports failures on its own masked line
 * (`describeReleaseFailure`) uses this client instead, so Prisma prints nothing. The service keeps `db` and its logging.
 * Not shared through `globalThis`: one script run owns it, and disconnects it.
 */
export function createQuietDb(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"] }),
    log: [],
  });
}
