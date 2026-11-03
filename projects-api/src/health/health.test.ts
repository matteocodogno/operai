import { describe, expect, it } from "bun:test";
import { call } from "../test-support/world";

describe("GET /health", () => {
  it("answers 200 without a token", async () => {
    const res = await call("GET", "/health", { as: null });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "ok", service: "projects-api" });
    expect(typeof res.json.version).toBe("string");
    expect(Number.isNaN(Date.parse(res.json.timestamp))).toBe(false);
  });
});
