/**
 * Unit tests for the evaluator behind GET /authz/users/holders (T20,
 * specs/022-projects-handoff - refs AC-4.1, AC-4.2; security-review.md L4):
 * `entityGrantFor` / `grantKind` of `resolver.ts`, pure and DB-free.
 *
 * The HTTP tests of the route itself (listing, query, gate, limiter) live in
 * `src/auth/holders.routes.test.ts`: they need the real Bearer-token mint, which
 * collides with the `mock.module("../auth/auth.config")` of sibling files in this
 * directory in a full `bun test` (see that file's header). This one touches
 * neither `auth.config` nor the database, so it is safe in any position.
 */

import { describe, expect, test } from "bun:test";
import {
  entityGrantFor,
  grantKind,
  type EffectivePermission,
  type GrantKind,
  type RuleConditions,
} from "./resolver";

const ENTITY: RuleConditions = { attributes: [{ key: "entity", match: "user" }] };

const receive = (conditions: RuleConditions | null): EffectivePermission => ({
  resource: "purchase-order",
  action: "receive",
  conditions,
});

const ask = (permissions: EffectivePermission[], userEntity: string | null, entity = "welld_ch") =>
  entityGrantFor(permissions, "purchase-order", "receive", { entity: userEntity }, entity);

describe("grantKind - how a grant's conditions read", () => {
  test.each<[string, RuleConditions | null, GrantKind]>([
    ["no conditions", null, "unrestricted"],
    ["an empty conditions object", {}, "unrestricted"],
    ["an empty attribute list", { attributes: [] }, "unrestricted"],
    ["the entity condition", ENTITY, "entity"],
    ["the entity condition twice", { attributes: [...ENTITY.attributes!, ...ENTITY.attributes!] }, "entity"],
    ["an ownership of own", { ownership: "own" }, "unrecognised"],
    ["an ownership of any", { ownership: "any" }, "unrecognised"],
    ["the entity condition next to an ownership", { ...ENTITY, ownership: "own" }, "unrecognised"],
    ["another attribute", { attributes: [{ key: "department", match: "user" }] }, "unrecognised"],
    ["another match", { attributes: [{ key: "entity", match: "welld_ch" }] }, "unrecognised"],
    [
      "the entity condition next to another attribute",
      { attributes: [...ENTITY.attributes!, { key: "department", match: "user" }] },
      "unrecognised",
    ],
  ])("%s reads as its kind", (_label, conditions, expected) => {
    expect(grantKind(conditions)).toBe(expected);
  });
});

describe("entityGrantFor - fails closed, like scopeFor in the resource servers", () => {
  test("no grant of the pair, or a grant of another pair: nobody", () => {
    expect(ask([], "welld_ch")).toBeNull();
    expect(
      ask([{ resource: "purchase-order", action: "bexio", conditions: null }], "welld_ch"),
    ).toBeNull();
    expect(
      ask([{ resource: "project", action: "receive", conditions: null }], "welld_ch"),
    ).toBeNull();
  });

  test("an unrestricted grant covers every entity, whatever the user's own (an admin has none)", () => {
    expect(ask([receive(null)], null)).toEqual({ unconditioned: true });
    expect(ask([receive(null)], "welld_it", "welld_ch")).toEqual({ unconditioned: true });
    expect(ask([receive(null)], "welld_ch", "welld_it")).toEqual({ unconditioned: true });
  });

  test("an entity grant covers the asked entity only when the user's entity equals it", () => {
    expect(ask([receive(ENTITY)], "welld_ch", "welld_ch")).toEqual({ unconditioned: false });
    expect(ask([receive(ENTITY)], "welld_it", "welld_it")).toEqual({ unconditioned: false });
    expect(ask([receive(ENTITY)], "welld_it", "welld_ch")).toBeNull();
    expect(ask([receive(ENTITY)], "welld_ch", "welld_it")).toBeNull();
  });

  test("an entity grant of a user with no entity (or an unknown one) qualifies nobody", () => {
    expect(ask([receive(ENTITY)], null, "welld_ch")).toBeNull();
    expect(ask([receive(ENTITY)], null, "welld_it")).toBeNull();
    expect(ask([receive(ENTITY)], "welld_xx", "welld_ch")).toBeNull();
  });

  test.each<[string, RuleConditions]>([
    ["an ownership", { ownership: "own" }],
    ["another attribute", { attributes: [{ key: "department", match: "user" }] }],
    ["another match", { attributes: [{ key: "entity", match: "welld_ch" }] }],
    ["the entity condition plus another", { attributes: [...ENTITY.attributes!, { key: "x", match: "user" }] }],
  ])("a condition it does not recognise (%s) grants nothing, even to the matching entity", (_label, conditions) => {
    expect(ask([receive(conditions)], "welld_ch", "welld_ch")).toBeNull();
  });

  test("an unrecognised grant next to an entity grant contributes nothing, the entity one still counts", () => {
    const unrecognised = receive({ ownership: "own" });
    expect(ask([unrecognised, receive(ENTITY)], "welld_ch")).toEqual({ unconditioned: false });
    expect(ask([unrecognised, receive(ENTITY)], "welld_it", "welld_ch")).toBeNull();
  });

  test("an unrestricted grant wins over any other grant of the pair", () => {
    expect(ask([receive(ENTITY), receive(null)], "welld_it", "welld_ch")).toEqual({ unconditioned: true });
    expect(ask([receive({ ownership: "own" }), receive(null)], null)).toEqual({ unconditioned: true });
  });
});
