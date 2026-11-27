/** specs/20261111-push-notifications (T2, AC-6.4): the web-push private key is a secret and never printed. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SECRET_VARS, isSecretVar } from "./manifest";
import { showValue } from "./check";

describe("notify-api web push env", () => {
  test("VAPID_PRIVATE_KEY is a secret, redacted when shown", () => {
    expect(isSecretVar("VAPID_PRIVATE_KEY")).toBe(true);
    expect(SECRET_VARS.has("VAPID_PRIVATE_KEY")).toBe(true);
    const key = "kQ3xYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
    expect(showValue("VAPID_PRIVATE_KEY", key)).not.toContain(key);
  });

  test("the public key and subject stay readable so drift is diagnosable", () => {
    expect(isSecretVar("VAPID_PUBLIC_KEY")).toBe(false);
    expect(isSecretVar("VAPID_SUBJECT")).toBe(false);
  });

  // Push went live in production on 2026-11-13 (ADR 20261111-web-push-encrypted-payloads-not-fcm go-live
  // sign-off; commit 4238bb7f flipped this template): the template is the production contract, so it ships
  // push ON with the full VAPID group, and the private key is only ever a 1Password reference.
  test("the production template ships push on (live since 2026-11-13) and holds the private key only as a 1Password reference", () => {
    const t = readFileSync(resolve(import.meta.dir, "templates/production/notify-api.env"), "utf8");
    expect(t).toMatch(/^PUSH_ENABLED=true$/m);
    expect(t).toMatch(/^VAPID_PUBLIC_KEY=\S+$/m);
    expect(t).toMatch(/^VAPID_SUBJECT=(mailto|https):\S+$/m);
    const priv = t.split("\n").filter((l) => l.includes("VAPID_PRIVATE_KEY="));
    expect(priv.length).toBeGreaterThan(0);
    for (const l of priv) expect(l).toMatch(/\$\{OP:/);
  });
});
