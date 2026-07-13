/**
 * Invite-link token helper (T5, specs/006-user-invitations — refs R3, AC-3.3).
 *
 * The raw token is the ONLY thing embedded in the invite link
 * (`<BETTER_AUTH_URL>/invite?id=<invId>&token=<raw>`, plan.md "Invite link &
 * landing"). It is never persisted — only its SHA-256 hash (`tokenHash`) is
 * stored on the `Invitation` row, so a database leak alone never discloses a
 * usable token (mirrors the general "never store the secret, store its
 * hash" posture, the same reason session tokens/passwords are never stored
 * in plaintext elsewhere in this codebase).
 *
 * Security properties (R3):
 *   - ≥32 bytes (256 bits) of CSPRNG entropy — `crypto.getRandomValues` (Web
 *     Crypto, available globally in Bun) is used for the SAME reason
 *     `signin.routes.ts`'s CSP nonce uses it: it is a cryptographically
 *     secure RNG, unlike `Math.random()`.
 *   - Rotated on resend (a NEW raw token + NEW hash replace the old ones) —
 *     the old link's token no longer matches `tokenHash` and is rejected by
 *     the landing page (AC-3.3), even though the `Invitation.id` in the old
 *     URL is unchanged.
 *   - The token itself grants NO access — activation is strictly the
 *     verified-OAuth-email match at the `user.create.after`/
 *     `session.create.before` hooks (T8, ADR-0012). A leaked link at worst
 *     reveals invite state + one email address (`GET /invite/state`, T9).
 */

const TOKEN_BYTES = 32; // ≥32-byte CSPRNG raw token (R3)

/** A freshly generated token: `raw` goes in the link (never persisted), `hash` is what gets stored as `tokenHash`. */
export interface InvitationToken {
  readonly raw: string;
  readonly hash: string;
}

/** Base64url-encodes raw bytes (RFC 4648 §5) — URL-safe, no padding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex digest of `value`, via Web Crypto's `subtle.digest` (async — no native sync hash needed). */
export async function hashInvitationToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generates a brand-new invite-link token: a ≥32-byte CSPRNG raw value (for
 * the link) and its SHA-256 hash (for `Invitation.tokenHash`). Used both at
 * invite-create and — with a FRESH call, never reusing the old raw value —
 * at resend (AC-3.1/3.3: "rotate the token").
 */
export async function generateInvitationToken(): Promise<InvitationToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const raw = toBase64Url(bytes);
  const hash = await hashInvitationToken(raw);
  return { raw, hash };
}

/**
 * Constant-time comparison of two same-alphabet strings (here, two SHA-256
 * hex digests). Guards the landing-page token check (T9) against a timing
 * side-channel on hash comparison — belt-and-suspenders given the compared
 * hashes are fixed-length hex, but cheap and matches the "never compare a
 * secret-derived value with `===`" discipline.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
