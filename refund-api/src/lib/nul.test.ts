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
  AUTH_BASE_URL: "http://localhost:3001",
  REFUND_S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com",
  REFUND_S3_REGION: "eu-central-1",
  REFUND_S3_BUCKET: "refund",
  REFUND_S3_ACCESS_KEY_ID: "test",
  REFUND_S3_SECRET_ACCESS_KEY: "test",
  NOTIFY_INTERNAL_URL: "http://localhost:8081",
  SERVICE_CLIENT_ID: "refund-api",
  SERVICE_CLIENT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
  ACCOUNTING_INTERNAL_URL: "http://localhost:8089",
  REFUND_APP_BASE_URL: "http://localhost:5175",
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

  it("does not take a message for a code", () => {
    expect(isNulDatabaseError(new Error("invalid byte sequence for encoding UTF8: 0x00 (22021)"))).toBe(false);
    expect(isNulDatabaseError(null)).toBe(false);
    expect(isNulDatabaseError("22021")).toBe(false);
  });
});
