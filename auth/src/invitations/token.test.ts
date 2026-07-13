/**
 * Unit tests for the invite-link token helper (T5, specs/006-user-
 * invitations — AC-3.3, R3). Pure crypto — no DB, no mocks.
 */

import { describe, expect, test } from "bun:test";
import {
  generateInvitationToken,
  hashInvitationToken,
  timingSafeEqualHex,
} from "./token";

describe("generateInvitationToken (R3)", () => {
  test("produces a raw token with at least 32 bytes of entropy (base64url, no padding)", async () => {
    // 32 raw bytes → base64url without padding is ceil(32*4/3) = 43 chars.
    // Assert on the encoded length rather than trying to decode it back, so
    // the test doesn't silently drift if the encoding helper changes.
    for (let i = 0; i < 5; i++) {
      const { raw } = await generateInvitationToken();
      expect(raw.length).toBeGreaterThanOrEqual(43);
      expect(raw).toMatch(/^[A-Za-z0-9\-_]+$/); // URL-safe alphabet only
    }
  });

  test("hash is the SHA-256 hex digest of the raw token", async () => {
    const { raw, hash } = await generateInvitationToken();
    const recomputed = await hashInvitationToken(raw);
    expect(hash).toBe(recomputed);
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 → 64 hex chars
  });

  test("two calls produce different raw tokens and different hashes (CSPRNG, never reused)", async () => {
    const first = await generateInvitationToken();
    const second = await generateInvitationToken();
    expect(first.raw).not.toBe(second.raw);
    expect(first.hash).not.toBe(second.hash);
  });

  test("rotate on resend: a fresh token's hash never matches the old token's hash (AC-3.3)", async () => {
    const original = await generateInvitationToken();
    const rotated = await generateInvitationToken();

    // The old raw token, hashed, must NOT equal the rotated (new) stored hash —
    // this is exactly what makes an old, pre-resend link invalid at the
    // landing page (T9): it hashes the OLD raw token and compares against
    // whatever `tokenHash` is CURRENTLY stored (the rotated one).
    const oldRawHashedAgain = await hashInvitationToken(original.raw);
    expect(oldRawHashedAgain).not.toBe(rotated.hash);
  });
});

describe("hashInvitationToken", () => {
  test("is deterministic for the same input", async () => {
    const a = await hashInvitationToken("some-raw-token-value");
    const b = await hashInvitationToken("some-raw-token-value");
    expect(a).toBe(b);
  });

  test("different inputs hash differently", async () => {
    const a = await hashInvitationToken("token-a");
    const b = await hashInvitationToken("token-b");
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqualHex", () => {
  test("returns true for identical strings", () => {
    expect(timingSafeEqualHex("abc123", "abc123")).toBe(true);
  });

  test("returns false for different strings of the same length", () => {
    expect(timingSafeEqualHex("abc123", "abc124")).toBe(false);
  });

  test("returns false for different-length strings (no throw)", () => {
    expect(timingSafeEqualHex("abc", "abcd")).toBe(false);
  });
});
