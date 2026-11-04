/**
 * Pure mapping tests for the Italian variant (T5, specs/021-meetings, ADR-0065):
 * row <-> DTO. No database: the round trip through Postgres is covered in
 * system/notifications.routes.test.ts and list.routes.test.ts.
 */

import { describe, it, expect } from "bun:test";

// The repo imports the Prisma client module; give it a URL so the import is
// inert (the client connects lazily and these tests never query).
process.env["DATABASE_URL"] ??= "postgresql://unused:unused@localhost:1/unused";

const { toDto, toCreateData } = await import("./notifications.repo");

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "n1",
  title: "Transcript ready",
  body: "Your meeting was transcribed with AI.",
  titleIt: null as string | null,
  bodyIt: null as string | null,
  severity: "success",
  originApp: "meetings",
  linkHref: "/my-meetings/m/abc",
  linkLabel: null as string | null,
  toastWorthy: false,
  readAt: null as Date | null,
  createdAt: new Date("2026-11-05T10:00:00.000Z"),
  ...overrides,
});

describe("toDto — Italian variant", () => {
  it("returns it: { title, body } when both columns are set", () => {
    const dto = toDto(row({ titleIt: "Trascrizione pronta", bodyIt: "La riunione e stata trascritta con l'IA." }));
    expect(dto.it).toEqual({ title: "Trascrizione pronta", body: "La riunione e stata trascritta con l'IA." });
    // The English text is untouched: it is the fallback the reader uses.
    expect(dto.title).toBe("Transcript ready");
    expect(dto.body).toBe("Your meeting was transcribed with AI.");
  });

  it("returns it: null (never undefined, never blank strings) when there is no variant", () => {
    const dto = toDto(row());
    expect(dto.it).toBeNull();
    expect("it" in dto).toBe(true);
  });

  it("returns it: null when only half of the pair is stored (degrade to English, never blank)", () => {
    expect(toDto(row({ titleIt: "Solo titolo" })).it).toBeNull();
    expect(toDto(row({ bodyIt: "Solo corpo" })).it).toBeNull();
  });
});

describe("toCreateData — Italian variant", () => {
  const input = {
    recipientId: "u1",
    title: "Transcript ready",
    body: "Body",
    severity: "info",
    originApp: "meetings",
    toastWorthy: false,
  };

  it("stores the variant as titleIt / bodyIt", () => {
    const data = toCreateData({ ...input, it: { title: "Titolo", body: "Corpo" } });
    expect(data.titleIt).toBe("Titolo");
    expect(data.bodyIt).toBe("Corpo");
  });

  it("stores nulls when the caller sent no variant (existing callers are unchanged)", () => {
    const data = toCreateData(input);
    expect(data.titleIt).toBeNull();
    expect(data.bodyIt).toBeNull();
    expect(data.title).toBe("Transcript ready");
  });
});
