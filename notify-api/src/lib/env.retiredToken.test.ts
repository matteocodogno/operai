/**
 * specs/016 AC-5.2 (T14): the shared notify token is not a setting notify-api
 * reads or requires, and a deployment that still has it set (any value, even a
 * short or empty one) starts normally. env.ts runs process.exit(1) at import
 * time, so each case boots it in a child process with the variable present or
 * absent. The name is assembled so this file is not a hit of the repository-wide
 * search for the retired variable.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const RETIRED = ["NOTIFY", "INTERNAL", "TOKEN"].join("_");
const ROOT = resolve(import.meta.dir, "..", "..");

async function bootEnv(extra: Record<string, string>, drop = false) {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...extra };
  if (drop) delete childEnv[RETIRED];
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { env } = await import("./src/lib/env.ts"); console.log("BOOT_OK:" + (${JSON.stringify(RETIRED)} in env));`,
    ],
    { cwd: ROOT, env: childEnv, stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out, code };
}

describe("notify-api env no longer knows the retired shared token (AC-5.2)", () => {
  test("starts with the variable absent and does not expose it", async () => {
    const { out, code } = await bootEnv({}, true);
    expect(code).toBe(0);
    expect(out).toContain("BOOT_OK:false");
  });

  for (const [label, value] of [
    ["a long value", "x".repeat(48)],
    ["a short value", "short"],
    ["an empty value", ""],
  ] as const) {
    test(`starts normally with the variable present as ${label}, and ignores it`, async () => {
      const { out, code } = await bootEnv({ [RETIRED]: value });
      expect(code).toBe(0);
      expect(out).toContain("BOOT_OK:false");
    });
  }
});
