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
