/** Live names (AC-1.6) and the write-time module-access check (ADR-0055), against the auth fakes. */
import { beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, appAccess, identities, resetWorld } from "../test-support/world";
import { ProblemError } from "./problem";

const { loadPeople } = await import("./people");
const { requireProjectUsers } = await import("./identities");

beforeEach(resetWorld);

const caller = (id: string) => ({ req: { header: () => "Bearer caller-token" }, get: () => id });

const refusalOf = async (promise: Promise<void>): Promise<ProblemError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error("expected a ProblemError");
};

describe("loadPeople", () => {
  it("maps an active user to a name, a deleted one and an unknown one to a null name", async () => {
    const { person, maybe } = await loadPeople({ req: { header: () => "Bearer t" } }, ["user-pm-ch", "user-gone", "stranger"]);
    expect(person("user-pm-ch")).toEqual({ id: "user-pm-ch", name: "Name of user-pm-ch", deleted: false });
    expect(person("user-gone")).toEqual({ id: "user-gone", name: null, deleted: true });
    expect(person("stranger")).toEqual({ id: "stranger", name: null, deleted: false });
    expect(maybe(null)).toBeNull();
  });

  it("fails soft: an auth outage degrades every name to null", async () => {
    identities.down = true;
    const { person } = await loadPeople({ req: { header: () => "Bearer t" } }, ["user-pm-ch"]);
    expect(person("user-pm-ch")).toEqual({ id: "user-pm-ch", name: null, deleted: false });
  });
});

describe("requireProjectUsers", () => {
  it("accepts users who hold projects:access", async () => {
    await requireProjectUsers(caller(PERSONAS.admin.sub), [PERSONAS.pmCh.sub, PERSONAS.accounting.sub]);
  });

  it("refuses with 422 `not_project_user`, naming every refused id", async () => {
    const error = await refusalOf(
      requireProjectUsers(caller(PERSONAS.admin.sub), [PERSONAS.pmCh.sub, PERSONAS.outsider.sub, "system:crm-api"]),
    );
    expect(error).toMatchObject({ status: 422, code: "not_project_user" });
    expect(error.extras).toEqual({ userIds: [PERSONAS.outsider.sub, "system:crm-api"] });
  });

  it("does not check the caller: they are using the module right now", async () => {
    appAccess.projects.clear();
    await requireProjectUsers(caller(PERSONAS.admin.sub), [PERSONAS.admin.sub]);
  });

  it("fails closed with 503 `identity_unavailable` when auth cannot answer", async () => {
    identities.down = true;
    const error = await refusalOf(requireProjectUsers(caller(PERSONAS.admin.sub), [PERSONAS.pmCh.sub]));
    expect(error).toMatchObject({ status: 503, code: "identity_unavailable" });
  });
});
