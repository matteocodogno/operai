import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { activitiesApi, appAccess, call, db, estimai, estimaiNotice, makeCompany, makeDeal, resetWorld, signServiceToken, app } from "../test-support/world";
import { setDealLinkSenderForTests, type DealLinkNotice } from "../lib/estimaiNotices";
import { activities, LOCKED_CALL } from "../lib/activities";
import { addWorkingDays } from "./workingDays";

/** specs/20261101-crm-sales-flow US-3: estimate requests, the ready/reopen/override lifecycle and the gate. */
describe("technical estimates (specs/20261101-crm-sales-flow US-3)", () => {
  beforeEach(resetWorld);

  const qualifiedDeal = async () => {
    const company = await makeCompany({ name: "Acme SA" });
    return makeDeal(company.id, { stage: "qualified", title: "Grid analytics" }, "salesCh");
  };
  const request = (dealId: string, technicalUserId = "user-tech", as: "salesCh" | "admin" | "consultant" = "salesCh") =>
    call("POST", `/deals/${dealId}/estimate`, { as, body: { technicalUserId } });
  const linkOf = (dealId: string) => db.dealEstimate.findUniqueOrThrow({ where: { dealId } });
  /** The next `db.$transaction` (the link's commit) rejects; the returned function puts the real one back. (A spy does not reach a Prisma client's method.) */
  const failNextTransaction = (): (() => void) => {
    const target = db as unknown as Record<string, unknown>;
    const real = target["$transaction"] as (...args: unknown[]) => unknown;
    let armed = true;
    const put = (value: unknown) =>
      Object.defineProperty(target, "$transaction", { configurable: true, enumerable: true, writable: true, value });
    put((...args: unknown[]) => {
      if (!armed) return real.apply(target, args);
      armed = false;
      return Promise.reject(new Error("commit failed"));
    });
    return () => put(real);
  };

  it("creates the estimate in EstimAI, shares it with the technician, links it and tasks them (AC-1.2)", async () => {
    const deal = await qualifiedDeal();
    const res = await request(deal.id);
    expect(res.status).toBe(201);
    expect(res.json.estimate).toMatchObject({ name: "Acme SA — Grid analytics", state: "requested", technical: { id: "user-tech" } });
    expect(res.json.estimateState).toBe("requested");

    const [created] = [...estimai.estimates.values()];
    expect(created).toMatchObject({ owner: "user-sales-ch", editors: ["user-tech@welld.test"] });
    expect(res.json.estimate.estimateId).toBe(created!.id);

    // The task is created in activities-api, as the CRM's service, under the id the link records.
    const link = await linkOf(deal.id);
    expect(link.taskId).toBeTruthy();
    const [put, ...rest] = activitiesApi.calls;
    expect(rest).toHaveLength(0);
    expect(put).toMatchObject({ op: "put", id: link.taskId });
    expect(put!.authorization).toMatch(/^Bearer svc-token-/);
    expect(put!.body).toEqual({
      type: "task",
      subject: "Estimate: Grid analytics",
      occurredAt: link.requestedAt.toISOString(),
      companyId: deal.company.id,
      dealId: deal.id,
      authorUserId: "user-sales-ch",
      assigneeUserId: "user-tech",
      dueDate: addWorkingDays(link.requestedAt, 5).toISOString().slice(0, 10),
    });
    expect(activitiesApi.activities.has(link.taskId!)).toBe(true);
  });

  it("a failed put leaves no task and no estimate, and answers 503 (AC-1.2)", async () => {
    const deal = await qualifiedDeal();
    activitiesApi.fail = { put: 503 };
    const res = await request(deal.id);
    expect(res.json).toMatchObject({ status: 503, code: "activities_unavailable" });
    expect(estimai.estimates.size).toBe(0);
    expect(estimai.deletes).toHaveLength(1);
    expect(await db.dealEstimate.count()).toBe(0);
    expect(activitiesApi.activities.size).toBe(0);
    // The put may have landed with its answer lost, so the id is taken back as well (a no-op if absent).
    expect(activitiesApi.of("delete").map((c) => c.id)).toEqual(activitiesApi.puts().map((c) => c.id));
    // ...and a retry once it is back works from a clean slate.
    activitiesApi.fail = {};
    expect((await request(deal.id)).status).toBe(201);
  });

  it("activities-api unreachable is the same: 503, estimate deleted, nothing linked", async () => {
    const deal = await qualifiedDeal();
    activitiesApi.down = true;
    const res = await request(deal.id);
    expect(res.json).toMatchObject({ status: 503, code: "activities_unavailable" });
    expect(estimai.estimates.size).toBe(0);
    expect(await db.dealEstimate.count()).toBe(0);
  });

  it("a commit that fails after the put deletes the task again (AC-1.2)", async () => {
    const deal = await qualifiedDeal();
    // The link's transaction fails, i.e. the commit does. (A NUL in a name used to be the device; it is a 400 now, QE D2.)
    const restore = failNextTransaction();
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await request(deal.id)).status).toBe(500);
    } finally {
      restore();
      quiet.mockRestore();
    }
    const [put] = activitiesApi.puts();
    expect(put).toBeDefined();
    const deletes = activitiesApi.of("delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ id: put!.id });
    expect(activitiesApi.activities.size).toBe(0);
    expect(await db.dealEstimate.count()).toBe(0);
  });

  it("a compensation that itself fails is logged, never thrown over the real error", async () => {
    const deal = await qualifiedDeal();
    const restore = failNextTransaction();
    const log = spyOn(console, "error").mockImplementation(() => {});
    activitiesApi.fail = { delete: 503 };
    try {
      expect((await request(deal.id)).status).toBe(500);
      expect(log.mock.calls.some((args) => String(args[0]).includes("could not remove the activity"))).toBe(true);
    } finally {
      restore();
      log.mockRestore();
    }
  });

  it("refuses a technician who is not a CRM user, or cannot use EstimAI, and leaves nothing behind", async () => {
    const deal = await qualifiedDeal();
    expect((await request(deal.id, "user-outsider")).json).toMatchObject({ code: "owner_not_crm_user", field: "technicalUserId" });
    // user-colleague can open the CRM but not EstimAI.
    expect((await request(deal.id, "user-colleague")).json).toMatchObject({ code: "technician_not_estimai_user" });
    expect(estimai.estimates.size).toBe(0);

    // EstimAI refusing the grant: the half-made estimate is deleted again.
    estimai.shareStatus = 422;
    expect((await request(deal.id)).json.code).toBe("technician_not_estimai_user");
    expect(estimai.estimates.size).toBe(0);
    expect(estimai.deletes).toHaveLength(1);
    expect(await db.dealEstimate.count()).toBe(0);
    expect(activitiesApi.calls).toHaveLength(0);
  });

  it("a requester without EstimAI gets 403 estimai_access_required; EstimAI down is a 503", async () => {
    const deal = await qualifiedDeal();
    estimai.forbidden.add("user-sales-ch");
    expect((await request(deal.id)).json).toMatchObject({ status: 403, code: "estimai_access_required" });
    estimai.forbidden.clear();
    estimai.down = true;
    expect((await request(deal.id)).json).toMatchObject({ status: 503, code: "estimai_unavailable" });
    expect(activitiesApi.calls).toHaveLength(0);
  });

  it("only a lead or qualified deal without an estimate can request one; scope applies", async () => {
    const deal = await qualifiedDeal();
    await request(deal.id);
    expect((await request(deal.id)).json.code).toBe("estimate_exists");
    const itCompany = await makeCompany({ entity: "welld_it" });
    const itDeal = await makeDeal(itCompany.id);
    expect((await request(itDeal.id)).json.code).toBe("out_of_scope");
    expect((await request(deal.id, "user-tech", "consultant")).status).toBe(403);
  });

  it("gates proposal on a ready estimate; it is ready once closed in EstimAI, and the task is completed there (AC-1.3, AC-3.3)", async () => {
    const deal = await qualifiedDeal();
    const move = (stage: string, ifMatch: number) =>
      call("POST", `/deals/${deal.id}/stage`, { as: "salesCh", ifMatch, body: { stage } });

    const noEstimate = await move("proposal", 1);
    expect(noEstimate.json).toMatchObject({ status: 409, code: "estimate_not_ready", estimateState: null });

    await request(deal.id);
    const { taskId } = await linkOf(deal.id);
    expect((await move("proposal", 1)).json).toMatchObject({ code: "estimate_not_ready", estimateState: "requested" });
    // Lost is never gated, and lost → won cannot step around the gate.
    expect((await move("lost", 1)).status).toBe(200);
    expect((await move("won", 2)).json.code).toBe("estimate_not_ready");
    expect((await move("qualified", 2)).status).toBe(200);

    // The CRM no longer marks it ready itself.
    expect((await call("POST", `/deals/${deal.id}/estimate/ready`, { as: "admin" })).status).toBe(404);
    activitiesApi.calls = [];
    expect((await estimaiNotice(deal.id)).status).toBe(204);
    const ready = await call("GET", `/deals/${deal.id}`, { as: "salesCh" });
    expect(ready.json.estimate).toMatchObject({ state: "ready" });
    expect(ready.json.estimate.readyAt).not.toBeNull();

    // Inside the notice, the request task is completed with seq = the EstimAI version just recorded,
    // and the labels the "You can go ahead" notice needs.
    const readyLink = await linkOf(deal.id);
    const [completion, ...others] = activitiesApi.calls;
    expect(others).toHaveLength(0);
    expect(completion).toMatchObject({ op: "completion", id: taskId });
    expect(completion!.body).toEqual({
      completed: true,
      at: readyLink.readyAt!.toISOString(),
      byUserId: "user-tech",
      seq: readyLink.estimaiVersion,
      context: { companyName: "Acme SA", dealId: deal.id, dealTitle: "Grid analytics" },
    });
    expect(activitiesApi.activities.get(taskId!)!.completedAt).not.toBeNull();

    expect((await move("proposal", 3)).json).toMatchObject({ stage: "proposal" });
    // Past qualified, the gate no longer applies, even if the estimate is reopened.
    activitiesApi.calls = [];
    await estimaiNotice(deal.id, "reopened", { by: "user-sales-ch" });
    expect((await call("GET", `/deals/${deal.id}`, { as: "salesCh" })).json.estimate.state).toBe("requested");
    const reopened = await linkOf(deal.id);
    expect(activitiesApi.calls).toHaveLength(1);
    expect(activitiesApi.calls[0]).toMatchObject({ op: "completion", id: taskId, body: { completed: false, byUserId: "user-sales-ch", seq: reopened.estimaiVersion } });
    expect(activitiesApi.activities.get(taskId!)!.completedAt).toBeNull();
    expect((await move("negotiation", 4)).status).toBe(200);
  });

  it("the completion made under the deal_estimate row lock carries the 2 s / 4 s bound (plan § Risks)", async () => {
    const deal = await qualifiedDeal();
    await request(deal.id);
    const complete = spyOn(activities, "complete");
    try {
      expect((await estimaiNotice(deal.id)).status).toBe(204);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]![2]).toEqual(LOCKED_CALL);
    } finally {
      complete.mockRestore();
    }
  });

  it("an unreachable activities-api fails the notice with 503 and changes nothing, so it can be sent again (AC-1.3)", async () => {
    const deal = await qualifiedDeal();
    await request(deal.id);
    const before = await linkOf(deal.id);
    activitiesApi.fail = { completion: 503 };
    expect((await estimaiNotice(deal.id)).status).toBe(503);
    const after = await linkOf(deal.id);
    expect(after).toMatchObject({ state: "requested", estimaiVersion: before.estimaiVersion, readyAt: null });

    // The same notice, once activities-api is back, applies.
    activitiesApi.fail = {};
    expect((await estimaiNotice(deal.id, "closed", { version: 2 })).status).toBe(204);
    expect((await linkOf(deal.id)).state).toBe("ready");
    expect(activitiesApi.activities.get(after.taskId!)!.completedAt).not.toBeNull();
  });

  it("an answer of applied:false (a duplicate, or a task deleted by hand) does not stop the CRM state moving", async () => {
    const deal = await qualifiedDeal();
    await request(deal.id);
    const { taskId } = await linkOf(deal.id);
    activitiesApi.activities.delete(taskId!);
    expect((await estimaiNotice(deal.id)).status).toBe(204);
    expect((await linkOf(deal.id)).state).toBe("ready");
  });

  it("unlinking removes the request task while it is open, and keeps a completed one (AC-1.2)", async () => {
    const deal = await qualifiedDeal();
    await request(deal.id);
    const first = await linkOf(deal.id);
    activitiesApi.calls = [];
    expect((await call("DELETE", `/deals/${deal.id}/estimate`, { as: "salesCh" })).status).toBe(200);
    expect(activitiesApi.calls).toHaveLength(1);
    expect(activitiesApi.calls[0]).toMatchObject({ op: "delete", id: first.taskId, query: "?onlyIfOpen=true" });
    expect(activitiesApi.activities.has(first.taskId!)).toBe(false);
    expect(await db.dealEstimate.count({ where: { dealId: deal.id } })).toBe(0);

    await request(deal.id);
    const second = await linkOf(deal.id);
    await estimaiNotice(deal.id);
    expect((await call("DELETE", `/deals/${deal.id}/estimate`, { as: "salesCh" })).status).toBe(200);
    // The completed task is still there: the delete was conditional.
    expect(activitiesApi.activities.get(second.taskId!)!.completedAt).not.toBeNull();
  });

  it("an unlink with activities-api down is a 503 and nothing changes (the link, the task, the notices)", async () => {
    const sent: DealLinkNotice[] = [];
    setDealLinkSenderForTests(async (n) => (sent.push(n), true));
    try {
      const deal = await qualifiedDeal();
      await request(deal.id);
      sent.length = 0;
      activitiesApi.fail = { delete: 503 };
      const res = await call("DELETE", `/deals/${deal.id}/estimate`, { as: "salesCh" });
      expect(res.json).toMatchObject({ status: 503, code: "activities_unavailable" });
      expect(await db.dealEstimate.count({ where: { dealId: deal.id } })).toBe(1);
      expect(activitiesApi.activities.size).toBe(1);
      expect(sent).toHaveLength(0);
    } finally {
      setDealLinkSenderForTests(null);
    }
  });

  it("an unlink of an override-only row calls activities-api for nothing", async () => {
    const deal = await qualifiedDeal();
    await call("POST", `/deals/${deal.id}/estimate/override`, { as: "admin", body: { reason: "Framework contract" } });
    activitiesApi.calls = [];
    expect((await call("DELETE", `/deals/${deal.id}/estimate`, { as: "salesCh" })).status).toBe(404);
    expect(activitiesApi.calls).toHaveLength(0);
  });

  it("a late notice cannot undo a newer one, and an unknown estimate is a quiet 204 (AC-1.3)", async () => {
    const deal = await qualifiedDeal();
    await request(deal.id);
    const { taskId } = await linkOf(deal.id);
    await estimaiNotice(deal.id, "closed", { version: 4 });
    // The reopen of version 3 arrives after the close of version 4: ignored, activities-api is not even asked.
    activitiesApi.calls = [];
    await estimaiNotice(deal.id, "reopened", { version: 3 });
    expect(activitiesApi.calls).toHaveLength(0);
    expect((await call("GET", `/deals/${deal.id}`)).json.estimate.state).toBe("ready");
    expect(activitiesApi.activities.get(taskId!)!.completedAt).not.toBeNull();
    await estimaiNotice(deal.id, "reopened", { version: 5 });
    expect(activitiesApi.calls.map((c) => [c.op, c.body.seq, c.body.completed])).toEqual([["completion", 5, false]]);
    expect((await call("GET", `/deals/${deal.id}`)).json.estimate.state).toBe("requested");
    expect(activitiesApi.activities.get(taskId!)!.completedAt).toBeNull();

    activitiesApi.calls = [];
    const token = await signServiceToken({ sub: "system:estimai-api", scope: "estimate-notices.send" });
    const unknown = await app.request("/system/estimate-notices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ estimateId: "est-nobody", event: "closed", version: 2, at: new Date().toISOString(), byUserId: "user-tech" }),
    });
    expect(unknown.status).toBe(204);
    expect(activitiesApi.calls).toHaveLength(0);
  });

  it("takes only estimai-api's service credential with the notices scope", async () => {
    const deal = await qualifiedDeal();
    await request(deal.id);
    expect((await estimaiNotice(deal.id, "closed", { sub: "system:crm-api" })).status).toBe(401);
    expect((await estimaiNotice(deal.id, "closed", { scope: "notifications.push" })).status).toBe(401);
    const userToken = await call("POST", "/system/estimate-notices", { as: "tech", body: {} });
    expect(userToken.status).toBe(401);
    const otherAudience = await signServiceToken({ sub: "system:estimai-api", scope: "estimate-notices.send", audience: "operai-suite" });
    const res = await app.request("/system/estimate-notices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherAudience}` },
      body: JSON.stringify({ estimateId: "x", event: "closed", version: 2, at: new Date().toISOString(), byUserId: "user-tech" }),
    });
    expect(res.status).toBe(401);
    expect((await call("GET", `/deals/${deal.id}`)).json.estimate.state).toBe("requested");
    expect(activitiesApi.of("completion")).toHaveLength(0);
  });

  it("whoever manages the deal overrides the gate with a reason, kept on the timeline and across an unlink (AC-1.2)", async () => {
    const deal = await qualifiedDeal();
    const override = (as: "salesCh" | "admin" | "consultant") =>
      call("POST", `/deals/${deal.id}/estimate/override`, { as, body: { reason: "Framework contract" } });
    // Without deal:manage (a technician) there is no override; nothing reaches the timeline.
    expect((await override("consultant")).status).toBe(403);
    expect(activitiesApi.calls).toHaveLength(0);
    const res = await override("admin");
    expect(res.json.estimate).toBeNull();
    expect(res.json.estimateOverride).toMatchObject({ reason: "Framework contract", by: { id: "user-admin" } });
    expect(res.json.estimateOverridden).toBe(true);

    // The note goes to the timeline in activities-api, authored by the admin, on the deal.
    const [note, ...rest] = activitiesApi.calls;
    expect(rest).toHaveLength(0);
    expect(note).toMatchObject({ op: "put" });
    expect(note!.body).toMatchObject({
      type: "note",
      subject: "Estimate gate overridden",
      body: "Framework contract",
      companyId: deal.company.id,
      dealId: deal.id,
      authorUserId: "user-admin",
    });
    expect(note!.body.assigneeUserId).toBeUndefined();

    // A request still works on an overridden deal; unlinking keeps the override.
    expect((await request(deal.id)).status).toBe(201);
    const unlinked = await call("DELETE", `/deals/${deal.id}/estimate`, { as: "salesCh" });
    expect(unlinked.json.estimate).toBeNull();
    expect(unlinked.json.estimateOverridden).toBe(true);
    expect((await call("POST", `/deals/${deal.id}/stage`, { as: "salesCh", ifMatch: 1, body: { stage: "proposal" } })).status).toBe(200);
    // The note is not the request task: unlinking deleted only the task.
    expect(activitiesApi.activities.has(note!.id!)).toBe(true);
  });

  it("a salesperson overrides the gate of a deal of their own entity, never of another one (amended 2026-11-13)", async () => {
    const own = await qualifiedDeal();
    const res = await call("POST", `/deals/${own.id}/estimate/override`, { as: "salesCh", body: { reason: "Public tender" } });
    expect(res.status).toBe(200);
    expect(res.json.estimateOverride).toMatchObject({ reason: "Public tender", by: { id: "user-sales-ch" } });
    expect(activitiesApi.calls[0]!.body).toMatchObject({ authorUserId: "user-sales-ch", dealId: own.id });

    const company = await makeCompany({ name: "Rossi Srl" });
    const italian = await makeDeal(company.id, { stage: "qualified", entity: "welld_it" }, "admin");
    const refused = await call("POST", `/deals/${italian.id}/estimate/override`, { as: "salesCh", body: { reason: "x" } });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("out_of_scope");
    expect((await call("GET", `/deals/${italian.id}`, { as: "salesCh" })).json.estimateOverride).toBeNull();
  });

  it("an override whose note cannot be written records nothing (503), and one whose commit fails removes the note again", async () => {
    const deal = await qualifiedDeal();
    activitiesApi.fail = { put: 503 };
    const refused = await call("POST", `/deals/${deal.id}/estimate/override`, { as: "admin", body: { reason: "x" } });
    expect(refused.json).toMatchObject({ status: 503, code: "activities_unavailable" });
    expect(await db.dealEstimate.count()).toBe(0);
    expect(activitiesApi.of("delete").map((c) => c.id)).toEqual(activitiesApi.puts().map((c) => c.id));

    activitiesApi.fail = {};
    activitiesApi.calls = [];
    // The database fails to record the override after the note was written: a concurrent request recorded one for the
    // deal while this one was writing the note, so the insert hits the unique `dealId`. (This used to be provoked with a
    // NUL in the reason, which is now a 422 at the schema, security L-8.)
    activitiesApi.onCall = async ({ op }) => {
      if (op !== "put") return;
      const at = new Date();
      await db.dealEstimate.create({
        data: { dealId: deal.id, estimateId: "", estimateName: "", technicalUserId: "user-admin", requestedBy: "user-admin", requestedAt: at, overrideBy: "user-admin", overrideReason: "first", overrideAt: at },
      });
    };
    expect((await call("POST", `/deals/${deal.id}/estimate/override`, { as: "admin", body: { reason: "second" } })).status).toBe(500);
    activitiesApi.onCall = null;
    expect(activitiesApi.of("delete")).toHaveLength(1);
    expect(activitiesApi.activities.size).toBe(0);
  });

  it("the technician must still be a CRM user when the request is made", async () => {
    appAccess.crm.delete("user-tech");
    const deal = await qualifiedDeal();
    expect((await request(deal.id)).json.code).toBe("owner_not_crm_user");
  });

  it("counts working days for the task's due date", () => {
    // Friday 2026-11-06 + 5 working days = Friday 2026-11-13.
    expect(addWorkingDays(new Date(Date.UTC(2026, 10, 6, 15)), 5).toISOString().slice(0, 10)).toBe("2026-11-13");
    // Saturday + 1 = Monday.
    expect(addWorkingDays(new Date(Date.UTC(2026, 10, 7)), 1).toISOString().slice(0, 10)).toBe("2026-11-09");
  });
});

/** specs/20261108-estimate-list-oversight US-3: the deal-link notices (AC-3.4, AC-3.5, AC-3.8). */
describe("deal-link notices to EstimAI (specs/20261108-estimate-list-oversight US-3)", () => {
  const sent: DealLinkNotice[] = [];
  beforeEach(async () => {
    await resetWorld();
    sent.length = 0;
    setDealLinkSenderForTests(async (notice) => {
      sent.push(notice);
      return true;
    });
  });
  afterEach(() => setDealLinkSenderForTests(null));

  const linkedDeal = async () => {
    const company = await makeCompany({ name: "Acme SA" });
    const deal = await makeDeal(company.id, { stage: "qualified", title: "Grid analytics" }, "salesCh");
    const res = await call("POST", `/deals/${deal.id}/estimate`, { as: "salesCh", body: { technicalUserId: "user-tech" } });
    return { deal, res };
  };

  it("sends exactly one linked notice after a request, at the link's requestedAt", async () => {
    const { deal, res } = await linkedDeal();
    expect(res.status).toBe(201);
    const row = await db.dealEstimate.findUniqueOrThrow({ where: { dealId: deal.id } });
    expect(sent).toEqual([
      { estimateId: res.json.estimate.estimateId, dealId: deal.id, event: "linked", at: row.requestedAt.toISOString() },
    ]);
  });

  it("sends one unlinked notice with the PREVIOUS estimate id after an unlink", async () => {
    const { deal, res } = await linkedDeal();
    sent.length = 0;
    const before = Date.now();
    expect((await call("DELETE", `/deals/${deal.id}/estimate`, { as: "salesCh" })).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ estimateId: res.json.estimate.estimateId, dealId: deal.id, event: "unlinked" });
    expect(Date.parse(sent[0]!.at)).toBeGreaterThanOrEqual(before);
  });

  it("sends nothing for a refused request, an override, or a ready/reopened notice", async () => {
    const company = await makeCompany();
    const deal = await makeDeal(company.id, { stage: "qualified" }, "salesCh");
    expect((await call("POST", `/deals/${deal.id}/estimate`, { as: "salesCh", body: { technicalUserId: "user-outsider" } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("POST", `/deals/${deal.id}/estimate/override`, { as: "admin", body: { reason: "urgent" } })).status).toBe(200);
    expect(sent).toHaveLength(0);
    await call("POST", `/deals/${deal.id}/estimate`, { as: "salesCh", body: { technicalUserId: "user-tech" } });
    sent.length = 0;
    await estimaiNotice(deal.id, "closed", { version: 2 });
    await estimaiNotice(deal.id, "reopened", { version: 3 });
    expect(sent).toHaveLength(0);
  });

  it("a failing sender never fails or undoes the CRM action", async () => {
    setDealLinkSenderForTests(async () => {
      throw new Error("boom");
    });
    const { deal, res } = await linkedDeal();
    expect(res.status).toBe(201);
    expect(await db.dealEstimate.count({ where: { dealId: deal.id } })).toBe(1);
    expect((await call("DELETE", `/deals/${deal.id}/estimate`, { as: "salesCh" })).status).toBe(200);
    expect(await db.dealEstimate.count({ where: { dealId: deal.id } })).toBe(0);
  });
});
