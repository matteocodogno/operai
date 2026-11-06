/**
 * estimai-api client (specs/022 T5; AC-3.1, ADR-0061): `estimateManDays(id)` reads the figure a
 * fixed-price terms of a project made from a deal copy, as the service principal (the person taking the
 * deal is often no collaborator on the estimate). EstimAI is the fake of test-support/world.ts.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { env } from "./env";
import { ProblemError } from "./problem";
import { authSystem, estimai, resetWorld, SERVICE_JWT } from "../test-support/world";
import { estimateManDays } from "./estimai";
import { serviceTokens } from "./serviceToken";

beforeEach(resetWorld);

/** The ProblemError an `estimateManDays` call rejects with. */
const failure = async (id: string): Promise<ProblemError> => {
  try {
    await estimateManDays(id);
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error("expected estimateManDays to reject");
};

describe("estimateManDays(id)", () => {
  it("returns the estimate's man-days, read as the service principal", async () => {
    estimai.estimates.set("est-1", { name: "Koordy", manDays: 41.5 });
    expect(await estimateManDays("est-1")).toBe(41.5);
    expect(estimai.lastAuthorization).toBe(`Bearer ${SERVICE_JWT}`);
  });

  it("returns 0 for an estimate of no effort, not null", async () => {
    estimai.estimates.set("est-0", { name: "Empty", manDays: 0 });
    expect(await estimateManDays("est-0")).toBe(0);
  });

  it("returns null when EstimAI does not know the estimate (404): the purchase order keeps its estimate id, no man-days", async () => {
    expect(await estimateManDays("est-gone")).toBeNull();
  });

  it("is live: a changed estimate gives the new figure on the next read, so only the caller's copy snapshots it (A6)", async () => {
    estimai.estimates.set("est-1", { name: "Koordy", manDays: 10 });
    expect(await estimateManDays("est-1")).toBe(10);
    estimai.estimates.set("est-1", { name: "Koordy", manDays: 12 });
    expect(await estimateManDays("est-1")).toBe(12);
  });

  it("answers 503 `estimai_unavailable` when estimai-api is down, or auth cannot mint the credential", async () => {
    estimai.down = true;
    const down = await failure("est-1");
    expect(down).toMatchObject({ status: 503, code: "estimai_unavailable" });
    estimai.down = false;
    serviceTokens!.invalidate(SERVICE_JWT); // the provider caches a token for minutes; start without one
    authSystem.down = true;
    expect(await failure("est-1")).toMatchObject({ status: 503, code: "estimai_unavailable" });
  });

  it("answers 503 `estimai_unconfigured`, and calls nothing, when ESTIMAI_INTERNAL_URL is unset", async () => {
    const configured = env.ESTIMAI_INTERNAL_URL;
    env.ESTIMAI_INTERNAL_URL = undefined;
    try {
      expect(await failure("est-1")).toMatchObject({ status: 503, code: "estimai_unconfigured" });
      expect(estimai.calls).toBe(0);
    } finally {
      env.ESTIMAI_INTERNAL_URL = configured;
    }
  });

  it("answers 503 `estimai_unavailable` for a body that is not a man-days figure", async () => {
    estimai.estimates.set("est-bad", { name: "Bad", manDays: -3 });
    expect(await failure("est-bad")).toMatchObject({ status: 503, code: "estimai_unavailable" });
  });
});
