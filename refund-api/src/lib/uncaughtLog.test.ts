/**
 * The fallback of the global error handler logs a failure without the database's message (security review A09): the route keeps the
 * driver's error as the `cause`, and a Prisma message can embed the query's arguments. The real handler runs on a probe route.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { describeUncaught } from "./uncaughtLog";
import { problemErrorHandler } from "./errorHandler";

const prismaLike = (message: string) =>
  Object.assign(new Error(message), { name: "PrismaClientKnownRequestError", code: "P2024", clientVersion: "7.0.0", meta: { args: { where: { email: "sentinel@example.test" } } } });

describe("describeUncaught", () => {
  it("keeps the route's message and frames, and reduces every cause to its name and code", () => {
    const tagged = Object.assign(new Error("Failed to load request"), { name: "DatabaseError", cause: prismaLike("Invalid `db.refundRequest.findUnique()` invocation: where: { email: 'sentinel@example.test' }") });
    const wrapper = new Error("Unexpected database failure loading request", { cause: tagged });
    const described = describeUncaught(wrapper);
    expect(described.message).toBe("Unexpected database failure loading request");
    expect(described.frames).toContain("at ");
    expect(described.causes).toEqual([{ name: "DatabaseError" }, { name: "PrismaClientKnownRequestError", code: "P2024" }]);
    expect(JSON.stringify(described)).not.toMatch(/sentinel|invocation/i);
  });

  it("gives a Prisma error no message at all, and survives a non-Error and a cyclic cause", () => {
    expect(describeUncaught(prismaLike("sentinel")).message).toBeUndefined();
    expect(describeUncaught("sentinel string")).toEqual({ name: "UnknownError", causes: [] });
    const loop: { name: string; cause?: unknown } = { name: "Loop" };
    loop.cause = loop;
    expect(describeUncaught(Object.assign(new Error("x"), { cause: loop })).causes.length).toBeLessThanOrEqual(6);
  });
});

describe("the real handler's [uncaught] line", () => {
  const original = console.error;
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    console.error = (...args: unknown[]) => {
      if (args[0] === "[uncaught]") lines.push(Bun.inspect(args.slice(1), { depth: 8 }));
    };
  });
  afterEach(() => {
    console.error = original;
  });

  it("a sentinel in a Prisma-shaped cause message never reaches the log, the answer is a 500 Problem", async () => {
    const app = new Hono();
    app.get("/boom", () => {
      throw new Error("Unexpected database failure loading request", { cause: prismaLike("Invalid invocation: email 'sentinel@example.test'") });
    });
    app.onError(problemErrorHandler);
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Unexpected database failure loading request");
    expect(lines[0]).toContain("P2024");
    expect(lines[0]).not.toMatch(/sentinel|example\.test|invocation/i);
    expect(await res.text()).not.toMatch(/sentinel/i);
  });
});
