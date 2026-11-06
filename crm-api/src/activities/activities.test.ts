import { beforeEach, describe, expect, it } from "bun:test";
import { call, db, makeCompany, makeDeal, resetWorld } from "../test-support/world";

beforeEach(resetWorld);

describe("activities and tasks (US-4)", () => {
  it("logs an activity on a company, newest first, with live author names (AC-4.1, AC-4.5)", async () => {
    const company = await makeCompany();
    await call("POST", "/activities", {
      as: "consultant",
      body: { type: "meeting", subject: "Kick-off", companyId: company.id, occurredAt: "2026-10-01T09:00:00Z" },
    });
    await call("POST", "/activities", {
      as: "colleague",
      body: { type: "note", subject: "Follow-up", body: "Sent the deck", companyId: company.id, occurredAt: "2026-10-05T09:00:00+02:00" },
    });
    const list = await call("GET", `/activities?companyId=${company.id}`);
    expect(list.json.total).toBe(2);
    expect(list.json.items.map((a: { subject: string }) => a.subject)).toEqual(["Follow-up", "Kick-off"]);
    expect(list.json.items[1]).toMatchObject({ author: { id: "user-consultant", status: "active" }, task: null });
  });

  it("needs exactly one filter", async () => {
    expect((await call("GET", "/activities")).status).toBe(422);
    expect((await call("GET", "/activities?companyId=a&dealId=b")).status).toBe(422);
  });

  it("refuses a contact or deal of another company (AC-4.1)", async () => {
    const mine = await makeCompany();
    const other = await makeCompany();
    const contact = (await call("POST", "/contacts", { body: { firstName: "A", lastName: "B", companyId: other.id } })).json;
    const deal = await makeDeal(other.id);
    const base = { type: "call", subject: "S", companyId: mine.id };
    expect((await call("POST", "/activities", { body: { ...base, contactId: contact.id } })).json.code).toBe("contact_not_in_company");
    expect((await call("POST", "/activities", { body: { ...base, dealId: deal.id } })).json.code).toBe("deal_not_in_company");
    expect((await call("POST", "/activities", { body: { ...base, dueDate: "2026-12-01" } })).json.code).toBe("task_fields_on_non_task");
  });

  it("only the author edits or deletes (AC-4.2)", async () => {
    const company = await makeCompany();
    const note = (await call("POST", "/activities", { as: "consultant", body: { type: "note", subject: "Mine", companyId: company.id } })).json;
    const notMine = await call("PATCH", `/activities/${note.id}`, { as: "colleague", body: { subject: "Theirs" } });
    expect(notMine.status).toBe(403);
    expect(notMine.json.code).toBe("author_only");
    expect((await call("DELETE", `/activities/${note.id}`, { as: "admin" })).status).toBe(403);
    expect((await call("PATCH", `/activities/${note.id}`, { as: "consultant", body: { body: "More" } })).json.body).toBe("More");
    expect((await call("DELETE", `/activities/${note.id}`, { as: "consultant" })).status).toBe(204);
  });

  it("tasks: default assignee is the author, anyone completes or reopens, my tasks by due date (AC-4.3, AC-4.4)", async () => {
    const company = await makeCompany();
    const task = (body: Record<string, unknown>) =>
      call("POST", "/activities", { as: "consultant", body: { type: "task", companyId: company.id, ...body } });
    const noDate = (await task({ subject: "Whenever" })).json;
    const later = (await task({ subject: "Later", dueDate: "2026-12-20" })).json;
    await task({ subject: "Sooner", dueDate: "2026-11-02" });
    await task({ subject: "For colleague", assigneeUserId: "user-colleague" });
    expect(noDate.task).toMatchObject({ assignee: { id: "user-consultant" }, completedAt: null });

    const mine = await call("GET", "/tasks", { as: "consultant" });
    expect(mine.json.items.map((t: { subject: string }) => t.subject)).toEqual(["Sooner", "Later", "Whenever"]);

    const done = await call("POST", `/activities/${later.id}/complete`, { as: "colleague" });
    expect(done.json.task).toMatchObject({ completedBy: { id: "user-colleague" } });
    const again = await call("POST", `/activities/${later.id}/complete`, { as: "admin" });
    expect(again.json.task.completedBy.id).toBe("user-colleague");

    expect((await call("GET", "/tasks?status=done", { as: "consultant" })).json.items.map((t: { subject: string }) => t.subject)).toEqual(["Later"]);
    expect((await call("GET", "/tasks?assignee=any")).json.total).toBe(3);
    // One colleague's tasks, and the people the filter can offer (any crm:access holder).
    const colleagues = await call("GET", "/tasks?assignee=user-colleague", { as: "consultant" });
    expect(colleagues.json.items.map((t: { subject: string }) => t.subject)).toEqual(["For colleague"]);
    const assignees = await call("GET", "/tasks/assignees", { as: "consultant" });
    expect(assignees.status).toBe(200);
    expect(assignees.json.items.map((p: { id: string }) => p.id).sort()).toEqual(["user-colleague", "user-consultant"]);
    expect((await call("POST", `/activities/${later.id}/reopen`)).json.task.completedAt).toBeNull();

    const note = (await call("POST", "/activities", { body: { type: "note", subject: "N", companyId: company.id } })).json;
    expect((await call("POST", `/activities/${note.id}/complete`)).json.code).toBe("not_a_task");
  });

  it("an assignee must be a CRM user (specs/018 AC-2.2)", async () => {
    const company = await makeCompany();
    const task = (assigneeUserId: string) =>
      call("POST", "/activities", { body: { type: "task", subject: "T", companyId: company.id, assigneeUserId } });
    // Deleted, or active but without crm:access: both refused, the same way.
    expect((await task("user-gone")).json).toMatchObject({ code: "owner_not_crm_user", field: "assigneeUserId" });
    expect((await task("user-outsider")).json).toMatchObject({ code: "owner_not_crm_user", field: "assigneeUserId" });
    expect((await task("user-tech")).status).toBe(201);
  });
});

describe("a meeting activity (specs/021 US-14, AC-14.2, AC-14.4)", () => {
  // What the notices reconciler writes, inserted directly: this file is about how it READS.
  async function meetingActivity(companyId: string, dealId: string, extra: { body?: string } = {}) {
    const meetingId = crypto.randomUUID();
    const row = await db.activity.create({
      data: {
        type: "meeting",
        subject: "Discovery call",
        body: extra.body ?? null,
        occurredAt: new Date("2026-11-10T09:30:00Z"),
        companyId,
        dealId,
        authorUserId: "user-consultant",
        meetingId,
      },
    });
    return { row, meetingId };
  }

  it("shows subject, occurredAt, no body and the meeting link on the deal's and the company's timeline", async () => {
    const company = await makeCompany();
    const deal = await makeDeal(company.id);
    const { row, meetingId } = await meetingActivity(company.id, deal.id);
    const expected = {
      id: row.id,
      type: "meeting",
      subject: "Discovery call",
      occurredAt: "2026-11-10T09:30:00.000Z",
      body: null,
      meeting: { id: meetingId, href: `/my-meetings/m/${meetingId}` },
      deal: { id: deal.id },
      author: { id: "user-consultant", status: "active" },
    };
    for (const url of [`/activities?dealId=${deal.id}`, `/activities?companyId=${company.id}`]) {
      const res = await call("GET", url, { as: "colleague" });
      expect(res.status).toBe(200);
      expect(res.json.items).toHaveLength(1);
      expect(res.json.items[0]).toMatchObject(expected);
    }
  });

  it("never exposes a body on it, even one the row holds", async () => {
    const company = await makeCompany();
    const deal = await makeDeal(company.id);
    await meetingActivity(company.id, deal.id, { body: "Transcript excerpt that must not leak" });
    const res = await call("GET", `/activities?dealId=${deal.id}`, { as: "consultant" });
    expect(res.json.items[0].body).toBeNull();
    expect(JSON.stringify(res.json)).not.toContain("must not leak");
  });

  it("an ordinary activity has meeting: null and keeps its body; a client cannot set a meeting id", async () => {
    const company = await makeCompany();
    const created = await call("POST", "/activities", { as: "consultant", body: { type: "note", subject: "N", body: "Kept", companyId: company.id } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ body: "Kept", meeting: null });
    const forged = await call("POST", "/activities", {
      as: "consultant",
      body: { type: "meeting", subject: "M", companyId: company.id, meetingId: "forged" },
    });
    expect(forged.status).toBe(422);
    expect((await call("PATCH", `/activities/${created.json.id}`, { as: "consultant", body: { meetingId: "forged" } })).status).toBe(422);
  });

  it("a PATCH response shows it the same way", async () => {
    const company = await makeCompany();
    const deal = await makeDeal(company.id);
    const { row, meetingId } = await meetingActivity(company.id, deal.id);
    const res = await call("PATCH", `/activities/${row.id}`, { as: "consultant", body: { body: "mine" } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ body: null, meeting: { id: meetingId } });
  });
});
