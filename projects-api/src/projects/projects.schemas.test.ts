/** The project view's team fields (specs/20261126-teams T12; plan § "The project view's team read": the four invariants). */
import { describe, expect, it } from "bun:test";
import { ProjectSchema, ProjectTeamsInvariants, PutTeamsSchema } from "./projects.schemas";
import { app } from "../test-support/world";

const person = { id: "u", name: "U", deleted: false };
const base = {
  id: "p",
  name: "P",
  type: "internal",
  state: "planned",
  stateBeforeHold: null,
  entity: "welld_ch",
  company: null,
  projectManager: person,
  awaitingProjectManager: false,
  team: [],
  purchaseOrder: null,
  tenderDealId: null,
  terms: null,
  startDate: null,
  endDate: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  teams: [],
  onProject: [person],
  onProjectComplete: true,
  teamsStatus: "complete",
  teamsRetryAfterSeconds: null,
};
const team = { id: "t", name: null, archived: null, members: null };
const ok = (over: Record<string, unknown>) => ProjectTeamsInvariants.safeParse({ ...base, ...over }).success;

describe("Project teams fields", () => {
  it("accept the cases of the table", () => {
    expect(ok({})).toBe(true);
    expect(ok({ teams: [team], onProjectComplete: false, teamsStatus: "unavailable" })).toBe(true);
    expect(ok({ teams: [team], onProjectComplete: false, teamsStatus: "rate_limited", teamsRetryAfterSeconds: 431 })).toBe(true);
  });

  it("the status is `complete` exactly when the project is complete", () => {
    expect(ok({ teamsStatus: "unavailable" })).toBe(false);
    expect(ok({ teams: [team], onProjectComplete: false, teamsStatus: "complete" })).toBe(false);
  });

  it("the wait is set exactly with `rate_limited`, an integer 1..600", () => {
    const limited = { teams: [team], onProjectComplete: false, teamsStatus: "rate_limited" };
    expect(ok({ ...limited, teamsRetryAfterSeconds: null })).toBe(false);
    expect(ok({ ...limited, teamsRetryAfterSeconds: 0 })).toBe(false);
    expect(ok({ ...limited, teamsRetryAfterSeconds: 601 })).toBe(false);
    expect(ok({ ...limited, teamsRetryAfterSeconds: 1.5 })).toBe(false);
    expect(ok({ teams: [team], onProjectComplete: false, teamsStatus: "unavailable", teamsRetryAfterSeconds: 5 })).toBe(false);
  });

  it("`rate_limited` only when there are teams; the enum is closed", () => {
    expect(ok({ onProjectComplete: false, teamsStatus: "rate_limited", teamsRetryAfterSeconds: 5 })).toBe(false);
    expect(ok({ teams: [team], onProjectComplete: false, teamsStatus: "soon" })).toBe(false);
  });

  it("are required members of the OpenAPI ProjectSchema, and the PUT 429 requires retryAfterSeconds", async () => {
    const { teamsStatus, teamsRetryAfterSeconds, ...without } = base;
    void teamsStatus;
    void teamsRetryAfterSeconds;
    expect(ProjectSchema.safeParse(without).success).toBe(false);
    expect(ProjectSchema.safeParse(base).success).toBe(true);
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: { required?: string[] } }> }> }>>;
    };
    const put = doc.paths["/projects/{id}/teams"]?.["put"];
    const project = put?.responses["200"]?.content?.["application/json"]?.schema;
    expect(project?.required).toEqual(expect.arrayContaining(["teams", "onProject", "onProjectComplete", "teamsStatus", "teamsRetryAfterSeconds"]));
    expect(Object.keys(put?.responses ?? {})).toEqual(expect.arrayContaining(["200", "422", "429", "503"]));
    expect(JSON.stringify(put?.responses["429"])).toContain("retryAfterSeconds");
  });

  it("PUT body is strict, at most 10 ids", () => {
    expect(PutTeamsSchema.safeParse({ teamIds: [] }).success).toBe(true);
    expect(PutTeamsSchema.safeParse({ teamIds: Array(11).fill("a") }).success).toBe(false);
    expect(PutTeamsSchema.safeParse({ teamIds: [], x: 1 }).success).toBe(false);
  });
});
