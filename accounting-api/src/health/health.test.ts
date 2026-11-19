/**
 * GET /health (T4, specs/20261119-accounting): public, no token, no data. The database probe is
 * replaced (`probes.db`), so this file needs no database; the real probe is a one-line `SELECT 1`.
 */

import { describe, expect, it, spyOn } from "bun:test";
import "../test-support/testAuth"; // sets the environment as an import side effect

const { app } = await import("../index");
const { probes } = await import("./health.routes");

describe("GET /health", () => {
  it("answers 200 without a token when the database answers", async () => {
    const probe = spyOn(probes, "db").mockResolvedValue(undefined);
    try {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: "ok", service: "accounting-api", db: { status: "ok" } });
      expect(typeof body["version"]).toBe("string");
      expect(Number.isNaN(Date.parse(String(body["timestamp"])))).toBe(false);
    } finally {
      probe.mockRestore();
    }
  });

  it("answers 503 `degraded` when the database cannot be reached", async () => {
    const probe = spyOn(probes, "db").mockRejectedValue(new Error("connection refused"));
    try {
      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "degraded", service: "accounting-api", db: { status: "error" } });
    } finally {
      probe.mockRestore();
    }
  });

  it("does not leak the failure of the probe", async () => {
    const probe = spyOn(probes, "db").mockRejectedValue(new Error("password authentication failed for user postgres"));
    try {
      const res = await app.request("/health");
      expect(await res.text()).not.toContain("password");
    } finally {
      probe.mockRestore();
    }
  });
});

describe("the assembled app (scaffold)", () => {
  it("answers an unknown path with a 404 Problem document that names the path only", async () => {
    const res = await app.request("/nope?secret=1");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 404, title: "Not Found", instance: "/nope" });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("refuses a body over 4 KiB with a 413 Problem document, before anything is parsed", async () => {
    const res = await app.request("/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(5 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ status: 413, title: "Payload Too Large", instance: "/health" });
  });

  it("serves CORS to the shell origin only: another origin gets no allow-origin header", async () => {
    const shell = await app.request("/health", { headers: { Origin: "http://localhost:5173" } });
    expect(shell.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await app.request("/health", { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not offer PATCH or DELETE in the CORS preflight (AC-1.12: nothing is edited or deleted)", async () => {
    const res = await app.request("/health", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "DELETE" },
    });
    const allowed = res.headers.get("access-control-allow-methods") ?? "";
    expect(allowed).not.toMatch(/DELETE|PATCH/);
  });
});
