import { defineConfig } from "prisma/config";
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

export default defineConfig({
  earlyAccess: true,
  // Used by the migration engine (prisma migrate dev/deploy)
  datasource: {
    url: process.env["DATABASE_URL"]!,
  },
  // Used by PrismaClient at runtime
  adapter: () =>
    new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }),
});
