/**
 * Integration tests for the hosted invite-landing page (T9, specs/006-user-
 * invitations — refs US-2 AC-2.2/AC-2.5, AC-1.9 state, AC-3.3 old-link
 * invalidation).
 *
 * No auth mocking needed — `GET /invite`/`GET /invite/state` are public,
 * unauthenticated routes. Every fixture row runs against the real local
 * Postgres (shared dev DB on localhost:5435) and is cleaned up in
 * `afterAll` (DB-ISOLATION convention, per-run RUN_ID suffix).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db";
import { generateInvitationToken } from "../invitations/token";
import { inviteRouter, resolveInviteState } from "./invite.routes";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;

const createdInvitationIds = new Set<string>();
const createdUserIds = new Set<string>();

async function makeInviter() {
  const user = await db.user.create({
    data: {
      name: "T9 Fixture Inviter",
      email: `t9-inviter-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@operai.test`,
      emailVerified: true,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeInvitation(
  emailSuffix: string,
  overrides: Partial<{ status: string; expiresAt: Date }> = {},
) {
  const inviter = await makeInviter();
  const token = await generateInvitationToken();
  const row = await db.invitation.create({
    data: {
      email: `t9-invitee-${emailSuffix}-${RUN_ID}@operai.test`,
      status: overrides.status ?? "pending",
      roleIds: [],
      departmentIds: [],
      tokenHash: token.hash,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 72 * HOUR),
      invitedByUserId: inviter.id,
    },
  });
  createdInvitationIds.add(row.id);
  return { row, rawToken: token.raw };
}

afterAll(async () => {
  await db.invitation.deleteMany({ where: { id: { in: Array.from(createdInvitationIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

describe("resolveInviteState (shared by HTML + JSON, T9)", () => {
  test("pending + matching token → pending, discloses email", async () => {
    const { row, rawToken } = await makeInvitation("pending");
    const resolved = await resolveInviteState(row.id, rawToken);
    expect(resolved).toEqual({ state: "pending", email: row.email });
  });

  test("expired (past window) + matching token → expired, no email disclosed (AC-4.3)", async () => {
    const { row, rawToken } = await makeInvitation("expired", {
      expiresAt: new Date(Date.now() - HOUR),
    });
    const resolved = await resolveInviteState(row.id, rawToken);
    expect(resolved).toEqual({ state: "expired", email: null });
  });

  test("revoked + matching token → revoked, no email disclosed (AC-1.9 state)", async () => {
    const { row, rawToken } = await makeInvitation("revoked", { status: "revoked" });
    const resolved = await resolveInviteState(row.id, rawToken);
    expect(resolved).toEqual({ state: "revoked", email: null });
  });

  test("accepted + matching token → accepted, no email disclosed", async () => {
    const { row, rawToken } = await makeInvitation("accepted", { status: "accepted" });
    const resolved = await resolveInviteState(row.id, rawToken);
    expect(resolved).toEqual({ state: "accepted", email: null });
  });

  test("unknown id → invalid, no email disclosed (no enumeration)", async () => {
    const resolved = await resolveInviteState("does-not-exist", "any-token");
    expect(resolved).toEqual({ state: "invalid", email: null });
  });

  test("wrong token for a real, still-pending id → invalid — never discloses the real (pending) status", async () => {
    const { row } = await makeInvitation("mismatch");
    const resolved = await resolveInviteState(row.id, "totally-wrong-token");
    expect(resolved).toEqual({ state: "invalid", email: null });
  });

  test("wrong token for a real EXPIRED id → still invalid, not 'expired' — no oracle for status via a bad token", async () => {
    const { row } = await makeInvitation("mismatch-expired", {
      expiresAt: new Date(Date.now() - HOUR),
    });
    const resolved = await resolveInviteState(row.id, "totally-wrong-token");
    expect(resolved).toEqual({ state: "invalid", email: null });
  });

  test("old token, post-resend (token rotated) → invalid (AC-3.3)", async () => {
    const { row, rawToken: oldRawToken } = await makeInvitation("resent");

    // Simulate a resend: rotate the token exactly like T6's resend handler does.
    const rotated = await generateInvitationToken();
    await db.invitation.update({ where: { id: row.id }, data: { tokenHash: rotated.hash } });

    const oldResolved = await resolveInviteState(row.id, oldRawToken);
    expect(oldResolved).toEqual({ state: "invalid", email: null });

    const newResolved = await resolveInviteState(row.id, rotated.raw);
    expect(newResolved.state).toBe("pending");
  });

  test("missing id or token → invalid", async () => {
    expect(await resolveInviteState(undefined, "some-token")).toEqual({
      state: "invalid",
      email: null,
    });
    const { row } = await makeInvitation("missing-token");
    expect(await resolveInviteState(row.id, undefined)).toEqual({
      state: "invalid",
      email: null,
    });
  });
});

describe("GET /invite/state (JSON seam)", () => {
  test("returns {state, email} for a valid pending link", async () => {
    const { row, rawToken } = await makeInvitation("state-json-pending");
    const res = await inviteRouter.request(
      `/invite/state?id=${encodeURIComponent(row.id)}&token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; email: string | null };
    expect(body.state).toBe("pending");
    expect(body.email).toBe(row.email);
  });

  test("returns invalid + null email for an unknown id", async () => {
    const res = await inviteRouter.request("/invite/state?id=nope&token=nope");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; email: string | null };
    expect(body.state).toBe("invalid");
    expect(body.email).toBeNull();
  });
});

describe("GET /invite (HTML landing page)", () => {
  test("pending + matching token renders the accept action and the invitee's email — no leak of anything else", async () => {
    const { row, rawToken } = await makeInvitation("html-pending");
    const res = await inviteRouter.request(
      `/invite?id=${encodeURIComponent(row.id)}&token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    const bodyText = await res.text();
    expect(bodyText).toContain(row.email);
    expect(bodyText).toContain("data-provider=\"google\"");
    expect(bodyText).toContain("data-provider=\"github\"");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'nonce-");
  });

  test("expired/revoked/accepted/invalid all render a 'no longer valid' message and NEVER the invitation's email (AC-2.5, no leak)", async () => {
    const cases: Array<{ label: string; make: () => Promise<{ row: { id: string; email: string }; rawToken: string }> }> = [
      { label: "expired", make: () => makeInvitation("html-expired", { expiresAt: new Date(Date.now() - HOUR) }) },
      { label: "revoked", make: () => makeInvitation("html-revoked", { status: "revoked" }) },
      { label: "accepted", make: () => makeInvitation("html-accepted", { status: "accepted" }) },
    ];

    for (const { make } of cases) {
      const { row, rawToken } = await make();
      const res = await inviteRouter.request(
        `/invite?id=${encodeURIComponent(row.id)}&token=${encodeURIComponent(rawToken)}`,
      );
      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(row.email);
      expect(bodyText).not.toContain("data-provider");
      expect(bodyText.toLowerCase()).toMatch(/no longer valid|expired|revoked|already been used|not valid/);
    }
  });

  test("unknown id renders the generic invalid message, no email, no OAuth buttons", async () => {
    const res = await inviteRouter.request("/invite?id=nope&token=nope");
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("data-provider");
    expect(bodyText).toContain("Invitation");
  });
});
