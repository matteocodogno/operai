/**
 * `createQuietDb` (T57, specs/20261119-accounting; F-03, AC-6.10): the client of command-line scripts, which has Prisma's own
 * log off while the service's `db` keeps its own. That nothing is printed is proved where it is observable, on the child's real
 * stdout and stderr: `scripts/accounting-release.cli.test.ts` ("T57"). This is the factory alone: it is a working client.
 */

import { describe, expect, it } from "bun:test";
import { createQuietDb } from "./db";

describe("createQuietDb", () => {
  it("talks to the configured database and is disconnected by its owner", async () => {
    const client = createQuietDb();
    try {
      const rows = await client.$queryRaw<{ one: number }[]>`select 1 as one`;
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await client.$disconnect();
    }
  });
});
