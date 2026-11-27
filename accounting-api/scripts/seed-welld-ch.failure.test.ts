/**
 * `seed:welld-ch` failure messages: a database without the schema must be named as such (not "run it again", which cannot
 * help), and no message ever carries a driver error's text (it can hold a connection string). Pure: no database.
 */

import { describe, expect, it } from "bun:test";

const { describeSeedFailure, SeedFileError } = await import("./seed-welld-ch");

describe("describeSeedFailure", () => {
  it("names a missing table (Prisma P2021) as an unmigrated database and says which command applies the migrations", () => {
    const error = Object.assign(new Error("The table `public.ledger_account` does not exist in the current database. postgres://u:secret@host/db"), { code: "P2021" });
    const text = describeSeedFailure(error);
    expect(text).toContain("migrations");
    expect(text).toContain("bun run db:deploy");
    expect(text).toContain("nothing was added");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("run it again");
  });

  it("names a missing column (P2022) the same way", () => {
    expect(describeSeedFailure(Object.assign(new Error("x"), { code: "P2022" }))).toContain("bun run db:deploy");
  });

  it("keeps the generic message for any other failure, without its text", () => {
    const text = describeSeedFailure(new Error("connect ECONNREFUSED postgres://u:secret@host/db"));
    expect(text).toBe("seed:welld-ch failed: nothing was added; run it again");
  });

  it("keeps a seed file refusal as it is", () => {
    expect(describeSeedFailure(new SeedFileError("vatCodes[0]: code is refused"))).toBe("seed:welld-ch refused: vatCodes[0]: code is refused");
  });
});
