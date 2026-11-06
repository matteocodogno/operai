import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { requestLogger } from "./logger";

// AC-4.10: the log line is method, path, status and duration; a search term
// (query string) or a body is content and must never reach it.
describe("requestLogger", () => {
  let lines: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    lines = [];
    spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  });
  afterEach(() => spy.mockRestore());

  const app = new Hono();
  app.use("*", requestLogger());
  app.get("/meetings", (c) => c.json({ ok: true }));
  app.post("/meetings", (c) => c.json({ ok: true }, 201));

  it("logs method, path, status and duration", async () => {
    await app.request("/meetings");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/meetings 200 \d+ms$/);
  });

  it("drops the query string", async () => {
    await app.request("/meetings?q=Acme%20renewal&role=creator");
    expect(lines[0]).toMatch(/^GET \/meetings 200 /);
    expect(lines.join("\n")).not.toContain("Acme");
    expect(lines.join("\n")).not.toContain("?");
  });

  it("never logs a request body", async () => {
    await app.request("/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Confidential budget talk" }),
    });
    expect(lines[0]).toMatch(/^POST \/meetings 201 /);
    expect(lines.join("\n")).not.toContain("Confidential");
  });
});
