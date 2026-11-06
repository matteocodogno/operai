import { describe, expect, it } from "bun:test";
import { ProblemError, problemBody, validationHook } from "./problem";

describe("validationHook", () => {
  it("answers 400 `validation_failed`, naming the first field and listing them all", async () => {
    const response = validationHook(
      {
        success: false,
        error: {
          issues: [
            { path: ["terms", "sla", "highDays"], message: "Number must be less than or equal to 60" },
            { path: ["startDate"], message: "Required" },
          ],
        },
      },
      { req: { path: "/projects/p1/terms" } } as never,
    )!;
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: unknown[] };
    expect(body).toMatchObject({
      status: 400,
      code: "validation_failed",
      field: "terms.sla.highDays",
      detail: "terms.sla.highDays: Number must be less than or equal to 60",
      instance: "/projects/p1/terms",
    });
    expect(body.errors).toHaveLength(2);
  });

  it("lets a valid parse through", () => {
    expect(validationHook({ success: true }, {} as never)).toBeUndefined();
  });
});

describe("ProblemError", () => {
  it("renders top-level extension members and never lets them overwrite the standard ones", () => {
    const body = problemBody(
      { status: 409, code: "version_conflict", detail: "stale", extras: { currentVersion: 3, status: 200, code: "x" } },
      "/projects/p1",
    );
    expect(body).toMatchObject({ status: 409, code: "version_conflict", currentVersion: 3 });
    expect(new ProblemError({ status: 404, detail: "no" }).toResponse("/x").status).toBe(404);
  });
});
