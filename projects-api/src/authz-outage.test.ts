/**
 * AC-4.2 / ADR-0014: an `auth` outage on /authz/resolve is a 503, never an allow. The
 * resolve fixture is restored in `finally` because the test harness is shared by every
 * file in the process.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { setupTestAuth } from "./test-support/testAuth";
import { PERSONAS, call, resetWorld } from "./test-support/world";

beforeEach(resetWorld);

const subOf = (header: string): string =>
  (JSON.parse(Buffer.from(header.split(".")[1] ?? "", "base64url").toString("utf-8")) as { sub: string }).sub;

describe("auth outage (AC-4.2)", () => {
  it("fails closed with 503 `authz_unavailable` on a gated route when /authz/resolve is down", async () => {
    const harness = setupTestAuth();
    try {
      harness.setResolve(async () => {
        throw new Error("auth down");
      });
      const res = await call("GET", "/scope", { as: "admin" });
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ status: 503, code: "authz_unavailable" });
    } finally {
      harness.setResolve(async (header) => {
        const sub = subOf(header);
        const persona = Object.values(PERSONAS).find((p) => p.sub === sub)!;
        return { sub, epoch: 0, permissions: persona.permissions, entity: persona.entity, jobTitle: null };
      });
    }
    expect((await call("GET", "/scope", { as: "admin" })).status).toBe(200);
  });
});
