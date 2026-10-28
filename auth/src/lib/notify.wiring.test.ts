/**
 * QE wiring test (specs/016 T7, AC-1.4): the REAL entry point (`src/index.ts`)
 * must inject `auth`'s own credential into `lib/notify`. Unit tests replace the
 * provider, so only this proves the production wiring: without it every
 * invitation email would be reported `failed` ("not configured").
 *
 * Runs in a fresh `bun` subprocess (index.ts has import-time side effects and
 * the test files mock `auth.config`). Nothing is sent over the network: fetch is
 * stubbed in the child; the token is signed by better-auth's real key (DB).
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const AUTH_DIR = resolve(import.meta.dir, "../..");

const CHILD = `
await import("./src/index");
const { sendInvitationEmail } = await import("./src/lib/notify");
const { env } = await import("./src/lib/env");
let seen: { url: string; headers: Headers } | undefined;
globalThis.fetch = (async (url: any, init: any) => {
  seen = { url: String(url), headers: new Headers(init.headers) };
  return Response.json({ deliveryId: "d1", status: "sent" });
}) as any;
const result = await sendInvitationEmail({ to: "a@b.ch", template: "invitation", inviteUrl: "https://x/y", inviterName: "A", expiresAt: "2026-11-01T00:00:00.000Z" });
const auth = seen?.headers.get("authorization") ?? "";
const jwt = auth.replace(/^Bearer /, "");
const payload = jwt.split(".").length === 3 ? JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) : null;
console.log("RESULT:" + JSON.stringify({ result, hasLegacy: seen?.headers.has("x-internal-token"), sub: payload?.sub, scope: payload?.scope, aud: payload?.aud, audOk: payload?.aud === env.SERVICE_AUDIENCE, ttl: payload ? payload.exp - payload.iat : null }));
process.exit(0);
`;

describe("production wiring of auth's notify credential", () => {
  test("importing src/index wires a system:auth / emails.send credential into sendInvitationEmail", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", CHILD], {
      cwd: AUTH_DIR,
      env: { ...process.env } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
    expect(line, stderr.slice(-800)).toBeDefined();
    const out = JSON.parse(line!.slice("RESULT:".length));
    expect(out.result).toEqual({ status: "sent", deliveryId: "d1" });
    expect(out.hasLegacy).toBe(false);
    expect(out.sub).toBe("system:auth");
    expect(out.scope).toBe("emails.send");
    expect(out.audOk).toBe(true);
    expect(out.ttl).toBe(300);
  });
});
