/**
 * What the list routes promise in the OpenAPI document (specs/029 T12; plan § Lists, AC-3.2): the
 * five routes and no `delete`, the 80-character name documented as `maxLength: 80` (code points, which
 * is what JSON Schema counts), the id's bound, and the answers a client must handle.
 */
import { describe, expect, it } from "bun:test";
import { call } from "../test-support/world";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = async (): Promise<any> => (await call("GET", "/openapi.json", { as: null })).json;

describe("the OpenAPI document of the lists", () => {
  it("lists exactly the routes of plan § Lists, and no delete", async () => {
    const { paths } = await doc();
    expect(Object.keys(paths["/time-lists"])).toEqual(["get"]);
    expect(Object.keys(paths["/time-categories"])).toEqual(["post"]);
    expect(Object.keys(paths["/time-categories/{id}"])).toEqual(["patch"]);
    expect(Object.keys(paths["/work-types"])).toEqual(["post"]);
    expect(Object.keys(paths["/work-types/{id}"])).toEqual(["patch"]);
  });

  it("documents the name as 1..80 characters on every route that takes one", async () => {
    const { paths } = await doc();
    const body = (path: string, method: string) => paths[path][method].requestBody.content["application/json"].schema;
    for (const [path, method] of [
      ["/time-categories", "post"],
      ["/time-categories/{id}", "patch"],
      ["/work-types", "post"],
      ["/work-types/{id}", "patch"],
    ] as const) {
      const name = body(path, method).properties.name;
      expect(name).toMatchObject({ type: "string", minLength: 1, maxLength: 80 });
      expect(body(path, method).additionalProperties).toBe(false);
    }
  });

  it("documents the id of a path as 1..64 characters, and includeRetired as true or false", async () => {
    const { paths } = await doc();
    for (const path of ["/time-categories/{id}", "/work-types/{id}"]) {
      const id = paths[path].patch.parameters.find((p: { name: string }) => p.name === "id");
      expect(id).toMatchObject({ in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 64 } });
    }
    const includeRetired = paths["/time-lists"].get.parameters.find((p: { name: string }) => p.name === "includeRetired");
    expect(includeRetired).toMatchObject({ in: "query", required: false, schema: { type: "string", enum: ["true", "false"] } });
  });

  it("documents the views, and the answers a client must handle on a write", async () => {
    const { paths, components } = await doc();
    expect(Object.keys(components.schemas)).toEqual(expect.arrayContaining(["CategoryView", "WorkTypeView", "TimeListsView"]));
    expect(components.schemas.CategoryView.required).toEqual(["id", "name", "requiresNote", "retired"]);
    expect(components.schemas.WorkTypeView.required).toEqual(["id", "list", "name", "retired"]);
    for (const [path, method, success] of [
      ["/time-categories", "post", "201"],
      ["/time-categories/{id}", "patch", "200"],
      ["/work-types", "post", "201"],
      ["/work-types/{id}", "patch", "200"],
    ] as const) {
      const codes = Object.keys(paths[path][method].responses);
      expect(codes).toEqual(expect.arrayContaining([success, "400", "403", "409", "503"]));
    }
    expect(Object.keys(paths["/time-lists"].get.responses)).toEqual(expect.arrayContaining(["200", "400", "401"]));
    expect(Object.keys(paths["/time-categories/{id}"].patch.responses)).toContain("404");
    expect(Object.keys(paths["/work-types/{id}"].patch.responses)).toContain("404");
  });
});
