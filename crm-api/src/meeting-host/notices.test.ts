/**
 * `POST /system/meeting-host/v1/notices` (specs/021 T8; AC-14.1 .. AC-14.9, AC-11.8;
 * ADR-0059): the reconciler that mirrors a meeting as ONE `meeting` activity.
 * Needs Postgres (migration `20261105090000_meeting_host` applied).
 *
 * The service JWT is verified for real (RS256, issuer, audience, scope, sub
 * allowlist); only the key set is local.
 */
import { TEST_ISSUER } from "../test-support/testAuth"; // sets the environment before ../lib/env is read
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { __setDefaultJwksForTests } from "../auth/systemAuth.middleware";
import { env } from "../lib/env";
import { PERSONAS, app, call, db, makeCompany, makeDeal, resetWorld } from "../test-support/world";

const PATH = "/system/meeting-host/v1/notices";
// `bun test` shares one process, so `../lib/env` may have been evaluated by an earlier file before
// testAuth set SERVICE_AUDIENCE; the route reads the audience from that same object, so use it.
env.SERVICE_AUDIENCE ??= "operai-system";
const SERVICE_AUDIENCE = env.SERVICE_AUDIENCE;
const KID = "svc-notices-test";

let key: CryptoKey;
let previousJwks: ReturnType<typeof __setDefaultJwksForTests>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  // The route verifies against a process-wide key set that an earlier file may already have filled from
  // the network (the matrix posts user tokens here), so swap it for ours instead of stubbing fetch.
  previousJwks = __setDefaultJwksForTests(createLocalJWKSet({ keys: [jwk] }));
});
afterAll(() => {
  __setDefaultJwksForTests(previousJwks);
});
beforeEach(resetWorld);

const serviceToken = (o: { sub?: string; aud?: string; scope?: string } = {}) =>
  new SignJWT({ scope: o.scope ?? "host-notices.send" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(TEST_ISSUER)
    .setSubject(o.sub ?? "system:meetings-api")
    .setAudience(o.aud ?? SERVICE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);

interface Notice {
  noticeId: string;
  seq: number;
  event: "linked" | "changed" | "unlinked" | "deleted";
  meeting: { id: string; title: string | null; startsAt: string | null; creatorId: string };
  entity: { type: string; id: string };
}

const CREATOR = PERSONAS.consultant.sub;
const STARTS = "2026-11-10T09:30:00.000Z";

function notice(meetingId: string, dealId: string, seq: number, event: Notice["event"], extra: { title?: string; startsAt?: string } = {}): Notice {
  const carries = event === "linked" || event === "changed";
  return {
    noticeId: crypto.randomUUID(),
    seq,
    event,
    meeting: {
      id: meetingId,
      title: carries ? (extra.title ?? "Discovery call") : null,
      startsAt: carries ? (extra.startsAt ?? STARTS) : null,
      creatorId: CREATOR,
    },
    entity: { type: "deal", id: dealId },
  };
}

async function send(body: unknown, token?: string) {
  const res = await app.request(PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}
const post = async (body: unknown) => send(body, await serviceToken());

const rows = (meetingId: string) => db.activity.findMany({ where: { meetingId } });

async function seed() {
  const company = await makeCompany();
  const deal = await makeDeal(company.id, { title: "Platform rebuild" });
  return { company, deal, meetingId: crypto.randomUUID() };
}

describe("who may post a notice (AC-11.8)", () => {
  it("401 without a token, with a user JWT, with another service, with the wrong scope or audience", async () => {
    const { deal, meetingId } = await seed();
    const body = notice(meetingId, deal.id, 1, "linked");
    expect((await send(body)).status).toBe(401);
    for (const token of [
      await serviceToken({ sub: "system:refund-api" }),
      await serviceToken({ scope: "notifications.push" }),
      await serviceToken({ aud: "operai-suite" }),
    ]) {
      expect((await send(body, token)).status).toBe(401);
    }
    const asUser = await call("POST", PATH, { as: "admin", body });
    expect(asUser.status).toBe(401);
    expect(await rows(meetingId)).toHaveLength(0);
  });
});

describe("linked (AC-14.1, AC-14.2, AC-14.3)", () => {
  it("creates one meeting activity on the deal's company, authored by the meeting's creator", async () => {
    const { company, deal, meetingId } = await seed();
    const res = await post(notice(meetingId, deal.id, 1, "linked", { title: "Kick-off" }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ applied: true });
    const [activity, ...rest] = await rows(meetingId);
    expect(rest).toHaveLength(0);
    expect(activity).toMatchObject({
      type: "meeting",
      subject: "Kick-off",
      body: null,
      companyId: company.id,
      dealId: deal.id,
      contactId: null,
      authorUserId: CREATOR,
      meetingId,
    });
    expect(activity!.occurredAt.toISOString()).toBe(STARTS);
  });

  it("the author-only edit rule still applies to it: the creator edits, anyone else gets 403 author_only (AC-14.3)", async () => {
    const { deal, meetingId } = await seed();
    await post(notice(meetingId, deal.id, 1, "linked"));
    const [activity] = await rows(meetingId);
    const other = await call("PATCH", `/activities/${activity!.id}`, { as: "colleague", body: { subject: "Mine now" } });
    expect(other.status).toBe(403);
    expect(other.json.code).toBe("author_only");
    const own = await call("PATCH", `/activities/${activity!.id}`, { as: "consultant", body: { body: "My notes" } });
    expect(own.status).toBe(200);
  });

  it("one activity per meeting across duplicates, retries and concurrent deliveries (AC-14.9)", async () => {
    const { deal, meetingId } = await seed();
    const first = notice(meetingId, deal.id, 1, "linked");
    expect((await post(first)).json).toEqual({ applied: true });
    expect((await post(first)).json).toEqual({ applied: false }); // exact duplicate
    expect((await post(notice(meetingId, deal.id, 2, "linked"))).json).toEqual({ applied: true }); // retry, newer seq
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => post(notice(meetingId, deal.id, 10 + i, "linked"))));
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(await rows(meetingId)).toHaveLength(1);
  });

  it("concurrent FIRST deliveries (no state row yet) still make one activity", async () => {
    const { deal, meetingId } = await seed();
    const results = await Promise.all(Array.from({ length: 6 }, () => post(notice(meetingId, deal.id, 1, "linked"))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.json.applied).length).toBe(1);
    expect(await rows(meetingId)).toHaveLength(1);
  });

  it("relinking moves the activity to the new deal's company and drops a contact of the old one (AC-14.7)", async () => {
    const { deal, meetingId } = await seed();
    const otherCompany = await makeCompany();
    const otherDeal = await makeDeal(otherCompany.id, { title: "Other" });
    await post(notice(meetingId, deal.id, 1, "linked"));
    const [activity] = await rows(meetingId);
    const contact = (await call("POST", "/contacts", { body: { firstName: "A", lastName: "B", companyId: activity!.companyId } })).json;
    expect((await call("PATCH", `/activities/${activity!.id}`, { as: "consultant", body: { contactId: contact.id } })).status).toBe(200);

    expect((await post(notice(meetingId, otherDeal.id, 2, "linked", { title: "Renamed" }))).json).toEqual({ applied: true });
    const moved = await rows(meetingId);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ id: activity!.id, companyId: otherCompany.id, dealId: otherDeal.id, contactId: null, subject: "Renamed" });
  });

  it("a deal that does not exist is 422 entity_not_found, creates nothing and leaves the seq free for a retry", async () => {
    const { deal, meetingId } = await seed();
    const missing = await post(notice(meetingId, "no-such-deal", 5, "linked"));
    expect(missing.status).toBe(422);
    expect(missing.json.code).toBe("entity_not_found");
    expect(await rows(meetingId)).toHaveLength(0);
    expect(await db.meetingHostState.findUnique({ where: { meetingId } })).toBeNull();
    expect((await post(notice(meetingId, deal.id, 5, "linked"))).json).toEqual({ applied: true });
  });
});

describe("changed (AC-14.5)", () => {
  it("updates the subject and the occurred-at moment", async () => {
    const { deal, meetingId } = await seed();
    await post(notice(meetingId, deal.id, 1, "linked"));
    await post(notice(meetingId, deal.id, 2, "changed", { title: "Renamed", startsAt: "2026-11-12T14:00:00.000Z" }));
    const [activity] = await rows(meetingId);
    expect(activity!.subject).toBe("Renamed");
    expect(activity!.occurredAt.toISOString()).toBe("2026-11-12T14:00:00.000Z");
  });

  it("never recreates an activity its author deleted by hand", async () => {
    const { deal, meetingId } = await seed();
    await post(notice(meetingId, deal.id, 1, "linked"));
    const [activity] = await rows(meetingId);
    expect((await call("DELETE", `/activities/${activity!.id}`, { as: "consultant" })).status).toBe(204);
    const res = await post(notice(meetingId, deal.id, 2, "changed", { title: "Renamed" }));
    expect(res.status).toBe(200);
    expect(await rows(meetingId)).toHaveLength(0);
  });

  it("an out-of-order seq is ignored: the older notice cannot overwrite the newer", async () => {
    const { deal, meetingId } = await seed();
    await post(notice(meetingId, deal.id, 1, "linked", { title: "First" }));
    expect((await post(notice(meetingId, deal.id, 3, "changed", { title: "Third" }))).json).toEqual({ applied: true });
    expect((await post(notice(meetingId, deal.id, 2, "changed", { title: "Second" }))).json).toEqual({ applied: false });
    expect((await rows(meetingId))[0]!.subject).toBe("Third");
  });
});

describe("unlinked and deleted (AC-14.6, AC-14.7)", () => {
  it("unlinked removes the activity when it is on that deal", async () => {
    const { deal, meetingId } = await seed();
    await post(notice(meetingId, deal.id, 1, "linked"));
    expect((await post(notice(meetingId, deal.id, 2, "unlinked"))).json).toEqual({ applied: true });
    expect(await rows(meetingId)).toHaveLength(0);
  });

  it("unlinked from a deal the activity is no longer on leaves it alone (a late unlink after a relink)", async () => {
    const { deal, meetingId } = await seed();
    const otherDeal = await makeDeal((await makeCompany()).id);
    await post(notice(meetingId, deal.id, 1, "linked"));
    await post(notice(meetingId, otherDeal.id, 3, "linked"));
    expect((await post(notice(meetingId, deal.id, 4, "unlinked"))).json).toEqual({ applied: true });
    const [activity] = await rows(meetingId);
    expect(activity!.dealId).toBe(otherDeal.id);
  });

  it("deleted removes it wherever it is, and a late lower-seq linked cannot bring it back", async () => {
    const { deal, meetingId } = await seed();
    await post(notice(meetingId, deal.id, 1, "linked"));
    expect((await post(notice(meetingId, deal.id, 5, "deleted"))).json).toEqual({ applied: true });
    expect(await rows(meetingId)).toHaveLength(0);
    expect((await post(notice(meetingId, deal.id, 3, "linked"))).json).toEqual({ applied: false });
    expect(await rows(meetingId)).toHaveLength(0);
  });

  it("deleted for a meeting the CRM never saw is accepted and recorded, so an early linked cannot follow it", async () => {
    const { deal, meetingId } = await seed();
    expect((await post(notice(meetingId, deal.id, 4, "deleted"))).json).toEqual({ applied: true });
    expect((await post(notice(meetingId, deal.id, 2, "linked"))).json).toEqual({ applied: false });
    expect(await rows(meetingId)).toHaveLength(0);
  });

  it("the guard row keeps only the meeting id and the seq: nothing with a title survives a deletion (AC-4.6)", async () => {
    const { deal, meetingId } = await seed();
    await post(notice(meetingId, deal.id, 1, "linked", { title: "Confidential topic" }));
    await post(notice(meetingId, deal.id, 2, "deleted"));
    const state = await db.meetingHostState.findUnique({ where: { meetingId } });
    expect(Object.keys(state!).sort()).toEqual(["lastSeq", "meetingId", "updatedAt"]);
    expect(state!.lastSeq).toBe(2);
  });
});

describe("a strict body (AC-14.9)", () => {
  it("rejects an extra key at any level with 422", async () => {
    const { deal, meetingId } = await seed();
    const ok = notice(meetingId, deal.id, 1, "linked");
    for (const body of [
      { ...ok, extra: 1 },
      { ...ok, meeting: { ...ok.meeting, agenda: "x" } },
      { ...ok, entity: { ...ok.entity, name: "x" } },
    ]) {
      expect((await post(body)).status).toBe(422);
    }
    expect(await rows(meetingId)).toHaveLength(0);
  });

  it("rejects a malformed notice with 422", async () => {
    const { deal, meetingId } = await seed();
    const ok = notice(meetingId, deal.id, 1, "linked");
    const bad: unknown[] = [
      { ...ok, noticeId: "not-a-uuid" },
      { ...ok, seq: -1 },
      { ...ok, seq: 1.5 },
      { ...ok, event: "renamed" },
      { ...ok, entity: { type: "company", id: deal.id } },
      { ...ok, meeting: { ...ok.meeting, title: null } }, // linked needs a title
      { ...ok, meeting: { ...ok.meeting, startsAt: null } }, // and a start
      { ...ok, meeting: { ...ok.meeting, title: "x".repeat(201) } },
      { ...ok, meeting: { ...ok.meeting, startsAt: "tomorrow" } },
      { ...notice(meetingId, deal.id, 1, "unlinked"), meeting: { id: meetingId, title: "Still here", startsAt: null, creatorId: CREATOR } },
      { ...notice(meetingId, deal.id, 1, "deleted"), meeting: { id: meetingId, title: null, startsAt: STARTS, creatorId: CREATOR } },
      { seq: 1 },
    ];
    for (const body of bad) expect((await post(body)).status).toBe(422);
    expect(await rows(meetingId)).toHaveLength(0);
  });
});
