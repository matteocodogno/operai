/**
 * The global error handler answers a NUL that reached Postgres with a 400 `validation_failed`, never a 500 (specs/20261126-teams QE D2
 * follow-up). Postgres text, and the text inside jsonb, cannot hold U+0000; the request was wrong, not the server. The REAL app runs
 * in a child process (`nul.probe.ts`), whose probe route throws the error the driver stack gives for a NUL, the first of them a real
 * one from the real database.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { isNulDatabaseError } from "./nul";

const CHILD_ENV = {
  NODE_ENV: "test",
  ALLOWED_ORIGINS: "http://localhost:5173",
  AUTH_JWKS_URL: "http://localhost:3001/.well-known/jwks.json",
  AUTH_ISSUER: "http://localhost:3001",
  AUTH_AUDIENCE: "operai-suite-test",
  SERVICE_AUDIENCE: "operai-services-test",
};

type Answer = { status: number; body: string; warned: unknown[][] };
let answers: Record<string, Answer> = {};

beforeAll(async () => {
  const child = Bun.spawn(["bun", "src/lib/nul.probe.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, ...CHILD_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  await child.exited;
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`the probe printed no result: ${err.slice(0, 500)}`);
  answers = JSON.parse(line.slice("RESULT ".length)) as Record<string, Answer>;
}, 30_000);

describe("a NUL the database refused is a 400, never a 500", () => {
  it("the real error of a real query", () => {
    const res = answers["real"]!;
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ status: 400, code: "validation_failed", instance: "/__nul-probe" });
    expect(res.body).not.toMatch(/22021|invalid byte|prisma|UTF8|select/i);
  });

  for (const [key, label] of [
    ["wrapped", "Prisma-wrapped, model query (P2039, 22021)"],
    ["raw-jsonb", "Prisma-wrapped, raw query on jsonb (P2010, 22P05)"],
    ["adapter", "the driver adapter's own error"],
    ["pg", "unwrapped from pg"],
  ] as const) {
    it(`${label}: 400 \`validation_failed\`, nothing of the request or the database in the answer`, () => {
      const res = answers[key]!;
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ status: 400, title: "Bad Request", code: "validation_failed" });
      expect(res.body).not.toMatch(/secret-note|22021|22P05|invalid byte|prisma|UTF8/i);
    });
  }

  // Security review A09: the safety net answers 400 and leaves ONE line, the code(s) only, so a server-built bad value is not blamed on
  // the client with no trace. No message, no value, no arguments, no person.
  it("logs one line per refusal: the code(s), no message, no value", () => {
    for (const [key, codes] of [
      ["wrapped", "P2039/22021"],
      ["raw-jsonb", "P2010/22P05"],
      ["adapter", "22021"],
      ["pg", "22P05"],
    ] as const) {
      expect(answers[key]!.warned).toEqual([["[nul] database refused U+0000 or invalid text", codes]]);
    }
    const real = answers["real"]!.warned;
    expect(real).toHaveLength(1);
    expect(real[0]![0]).toBe("[nul] database refused U+0000 or invalid text");
    expect(real[0]![1]).toMatch(/^(P2039\/|P2010\/)?(22021|22P05)$/);
    expect(JSON.stringify(Object.values(answers).map((a) => a.warned))).not.toMatch(/secret|invocation|Invalid|invalid byte|Unicode|Raw query/);
  });

  it("logs nothing as a NUL refusal when the failure is not about a NUL", () => {
    expect(answers["other-sqlstate"]!.warned).toEqual([]);
    expect(answers["other"]!.warned).toEqual([]);
  });

  it("a database failure that is not about a NUL stays a 500", () => {
    expect(answers["other-sqlstate"]!.status).toBe(500);
    expect(answers["other"]!.status).toBe(500);
  });

  // QE F1: the routes do not throw the driver's error, they throw an `Error` made from the repository's tagged `DatabaseError` that
  // carries it. The net must find the NUL down that chain, and a failure that is not about a NUL must stay a 500.
  it("a DatabaseError the route wrapped keeps its cause: the real error of a real query is a 400 and logs one coded line", () => {
    const res = answers["tagged-real"]!;
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ status: 400, code: "validation_failed" });
    expect(res.body).not.toMatch(/Failed to list|Unexpected database|22021|invalid byte|prisma|select/i);
    expect(res.warned).toHaveLength(1);
    expect(res.warned[0]![0]).toBe("[nul] database refused U+0000 or invalid text");
    expect(res.warned[0]![1]).toMatch(/^(P2039\/|P2010\/)?(22021|22P05)$/);
  });

  it("a wrapped Prisma P2039 inside the DatabaseError is a 400 with the codes and nothing else in the log", () => {
    const res = answers["tagged-wrapped"]!;
    expect(res.status).toBe(400);
    expect(res.warned).toEqual([["[nul] database refused U+0000 or invalid text", "P2039/22021"]]);
    expect(res.body + JSON.stringify(res.warned)).not.toMatch(/secret-note/);
  });

  it("a wrapped database failure that is not about a NUL stays a 500, and logs no refusal", () => {
    expect(answers["tagged-other"]!.status).toBe(500);
    expect(answers["tagged-other"]!.warned).toEqual([]);
  });

  it("does not take a message for a code", () => {
    expect(isNulDatabaseError(new Error("invalid byte sequence for encoding UTF8: 0x00 (22021)"))).toBe(false);
    expect(isNulDatabaseError(null)).toBe(false);
    expect(isNulDatabaseError("22021")).toBe(false);
  });
});
