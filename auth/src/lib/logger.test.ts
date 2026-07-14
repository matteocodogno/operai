/**
 * Regression test for security-review fix #1 (specs/006-user-invitations
 * bounded fix round): the request logger must never write a query string —
 * only method + path + status + duration — so a live invite token in
 * `GET /invite?id=<invId>&token=<raw>` is never persisted to application logs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requestLogger } from "./logger";

describe("requestLogger (auth) — no query string in logs", () => {
  let logs: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("a request to /invite?token=SECRET logs the path WITHOUT the query string", async () => {
    const app = new Hono();
    app.use("*", requestLogger());
    app.get("/invite", (c) => c.text("ok"));

    const res = await app.request("/invite?id=inv_1&token=SUPER_SECRET_TOKEN");
    expect(res.status).toBe(200);

    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("GET /invite ");
    expect(logs[0]).not.toContain("SUPER_SECRET_TOKEN");
    expect(logs[0]).not.toContain("?");
    expect(logs[0]).not.toContain("token=");
  });

  test("a plain request with no query string still logs method + path + status", async () => {
    const app = new Hono();
    app.use("*", requestLogger());
    app.get("/health", (c) => c.text("ok"));

    await app.request("/health");

    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("GET /health 200");
  });
});
