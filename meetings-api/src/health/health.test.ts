import { afterAll, describe, expect, it } from "bun:test";

// Environment: src/test-support/testEnv.ts (bunfig preload).
const { app } = await import("../index");
const { db } = await import("../lib/db");

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /health", () => {
  it("reports ok with the database reachable", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; db: { status: string } };
    expect(body.service).toBe("meetings-api");
    expect(body.status).toBe("ok");
    expect(body.db.status).toBe("ok");
  });

  it("answers 503 degraded when the database cannot be reached", async () => {
    // The client is a proxy: spyOn does not take, a plain assignment does.
    const original = db.$queryRaw;
    (db as unknown as { $queryRaw: unknown }).$queryRaw = () => Promise.reject(new Error("down"));
    try {
      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(((await res.json()) as { status: string }).status).toBe("degraded");
    } finally {
      (db as unknown as { $queryRaw: unknown }).$queryRaw = original;
    }
  });
});

describe("assembled app", () => {
  it("answers an unknown path with Problem JSON 404", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: number; instance: string };
    expect(body.status).toBe(404);
    expect(body.instance).toBe("/nope");
  });

  it("serves the OpenAPI document", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { info: { title: string } }).info.title).toBe("Operai Meetings API");
  });
});
