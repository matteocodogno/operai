/**
 * Problem JSON helpers (specs/015-hardware-inventory, plan.md § API contracts).
 * The contract the built UI depends on: extension members are TOP-LEVEL.
 */

import { describe, it, expect } from "bun:test";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ProblemError,
  conflict,
  forbidden,
  handleProblemError,
  notFound,
  problem,
  problemBody,
  unprocessable,
  validationHook,
} from "./problem";

describe("problemBody", () => {
  it("has the RFC 7807 members plus a top-level code", () => {
    expect(
      problemBody({ status: 409, code: "fiscal_year_closed", detail: "Year 2025 is closed" }, "/assets"),
    ).toEqual({
      type: "https://httpstatuses.com/409",
      title: "Conflict",
      status: 409,
      detail: "Year 2025 is closed",
      instance: "/assets",
      code: "fiscal_year_closed",
    });
  });

  it("puts extension members at the top level, never under extras/detail", () => {
    const body = problemBody(
      {
        status: 409,
        code: "serial_conflict",
        detail: "Serial already registered",
        extras: { serialNumber: "SN-1", assetId: "a1" },
      },
      "/assets",
    );
    expect(body["serialNumber"]).toBe("SN-1");
    expect(body["assetId"]).toBe("a1");
    expect(body).not.toHaveProperty("extras");
    expect(typeof body["detail"]).toBe("string");
  });

  it("an extension can never overwrite a standard member", () => {
    const body = problemBody(
      {
        status: 409,
        code: "x",
        detail: "real detail",
        extras: { status: 200, code: "forged", detail: "forged", instance: "/forged", type: "forged", title: "forged", year: 2025 },
      },
      "/real",
    );
    expect(body["status"]).toBe(409);
    expect(body["code"]).toBe("x");
    expect(body["detail"]).toBe("real detail");
    expect(body["instance"]).toBe("/real");
    expect(body["type"]).toBe("https://httpstatuses.com/409");
    expect(body["title"]).toBe("Conflict");
    expect(body["year"]).toBe(2025);
  });

  it("omits code when there is none, and falls back on a generic title", () => {
    const body = problemBody({ status: 418, detail: "teapot" }, "/t");
    expect(body).not.toHaveProperty("code");
    expect(body["title"]).toBe("Error");
  });
});

describe("problem / ProblemError", () => {
  it("problem() is a JSON Response with the status", async () => {
    const res = problem({ status: 403, detail: "no" }, "/x");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { title: string }).title).toBe("Forbidden");
  });

  it("a ProblemError keeps status, code and extras and renders them", async () => {
    const err = conflict("invalid_transition", "Cannot receive", { from: "assigned" });
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
    expect(err.message).toBe("Cannot receive");
    const body = (await err.toResponse("/assets/1/receive").json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "invalid_transition", from: "assigned", status: 409 });
  });

  it("handleProblemError renders a ProblemError and ignores anything else", () => {
    expect(handleProblemError(notFound(), "/a")?.status).toBe(404);
    expect(handleProblemError(forbidden("no"), "/a")?.status).toBe(403);
    expect(handleProblemError(new Error("boom"), "/a")).toBeNull();
    expect(handleProblemError("string", "/a")).toBeNull();
    expect(handleProblemError({ status: 409 }, "/a")).toBeNull();
  });

  it("unprocessable() carries the offending field at the top level", async () => {
    const body = (await unprocessable("bad", { field: "usefulLifeYears" })
      .toResponse("/rules")
      .json()) as Record<string, unknown>;
    expect(body["status"]).toBe(422);
    expect(body["field"]).toBe("usefulLifeYears");
  });
});

describe("validationHook", () => {
  const route = createRoute({
    method: "post",
    path: "/things",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              serialNumbers: z.array(z.string().min(1)).optional(),
              totalPriceCents: z.number().int().positive(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "ok" } },
  });
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.openapi(route, (c) => c.json({ ok: true }, 200));

  const post = (body: unknown) =>
    app.request("/things", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("a body that fails its schema is a 422 naming the field", async () => {
    const res = await post({ name: "x", totalPriceCents: 0 });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      status: number;
      field: string;
      detail: string;
      errors: { field: string; message: string }[];
    };
    expect(body.status).toBe(422);
    expect(body.field).toBe("totalPriceCents");
    expect(body.errors.map((e) => e.field)).toEqual(["totalPriceCents"]);
    expect(body.detail).toContain("totalPriceCents");
  });

  it("names a nested field with a dotted path and lists every error", async () => {
    const res = await post({ name: "", serialNumbers: ["a", ""], totalPriceCents: 5 });
    const body = (await res.json()) as { field: string; errors: { field: string }[] };
    expect(res.status).toBe(422);
    expect(body.errors.map((e) => e.field).sort()).toEqual(["name", "serialNumbers.1"]);
    expect(["name", "serialNumbers.1"]).toContain(body.field);
  });

  it("a valid body is untouched", async () => {
    expect((await post({ name: "x", totalPriceCents: 5 })).status).toBe(200);
  });
});
