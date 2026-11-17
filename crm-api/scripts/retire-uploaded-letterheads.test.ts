import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { bucket, db, memoryStorage, resetWorld } from "../src/test-support/world";
import { ProblemError } from "../src/lib/problem";
import { createLetterheadClient } from "../src/lib/letterheadClient";
import { runRetire, sampleContent, sampleRenderer } from "./retire-uploaded-letterheads";

/**
 * specs/20261116-letterhead-service T30 (AC-10.11, AC-10.12, O5): the retirement of the uploaded letterheads at the switch.
 * Real Postgres; the bucket is the in-memory one of the test world; the check is a stub (its own tests are apart).
 */
const PROFILE = { legalName: "wellD", addressLines: ["Via Example 1"] };
const PDF = new TextEncoder().encode("%PDF-1.4 letterhead");

async function profile(entity: "welld_ch" | "welld_it", withLetterhead: boolean, key = `letterheads/${entity}/${crypto.randomUUID()}.pdf`): Promise<string | null> {
  if (withLetterhead) bucket.objects.set(key, { bytes: PDF, contentType: "application/pdf", sizeBytes: PDF.byteLength });
  await db.entityProfile.create({
    data: { entity, ...PROFILE, updatedBy: "user-admin", ...(withLetterhead ? { letterheadKey: key, letterheadBy: "user-admin", letterheadAt: new Date() } : {}) },
  });
  return withLetterhead ? key : null;
}

type Entity = "welld_ch" | "welld_it";

function run(
  over: { check?: number; switchOn?: boolean; apply?: boolean; storage?: Parameters<typeof runRetire>[0]["storage"]; render?: (entity: Entity) => Promise<void> } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { log: (l: string) => void out.push(l), error: (l: string) => void err.push(l) };
  let checks = 0;
  const rendered: Entity[] = [];
  return {
    out,
    err,
    rendered,
    checks: () => checks,
    go: () =>
      runRetire({
        storage: over.storage ?? memoryStorage,
        check: async () => {
          checks += 1;
          return over.check ?? 0;
        },
        renderSample: async (entity) => {
          rendered.push(entity);
          await over.render?.(entity);
        },
        switchOn: over.switchOn ?? true,
        apply: over.apply ?? false,
        io,
      }),
  };
}

const rows = () => db.entityProfile.findMany({ orderBy: { entity: "asc" } });

beforeEach(resetWorld);

describe("retire-uploaded-letterheads", () => {
  it("is a dry run by default: it lists what it would do and changes nothing", async () => {
    const ch = (await profile("welld_ch", true))!;
    const it = (await profile("welld_it", true))!;
    const before = await rows();
    const r = run();
    expect(await r.go()).toBe(0);
    expect(r.out).toContain(`welld_ch  would delete ${ch} and clear the letterhead reference`);
    expect(r.out).toContain(`welld_it  would delete ${it} and clear the letterhead reference`);
    expect(r.out.at(-1)).toContain("Dry run");
    expect(await rows()).toEqual(before);
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.has(ch) && bucket.objects.has(it)).toBe(true);
  });

  it("with --apply deletes the objects and nulls letterheadKey, letterheadBy and letterheadAt, and touches nothing else", async () => {
    const ch = (await profile("welld_ch", true))!;
    const it = (await profile("welld_it", true))!;
    // an offer's PDF, an attachment and another entity's key in the same bucket
    const offerKey = "offers/deal-1/offer-1.pdf";
    const attachmentKey = "attachments/deal-1/a.pdf";
    for (const key of [offerKey, attachmentKey]) bucket.objects.set(key, { bytes: PDF, contentType: "application/pdf", sizeBytes: PDF.byteLength });
    const before = await rows();

    const r = run({ apply: true });
    expect(await r.go()).toBe(0);
    expect(r.err).toEqual([]);
    expect(bucket.deleted.sort()).toEqual([ch, it].sort());
    expect([...bucket.objects.keys()].sort()).toEqual([attachmentKey, offerKey]);
    const after = await rows();
    for (const [row, was] of after.map((row, i) => [row, before[i]!] as const)) {
      expect(row).toMatchObject({ letterheadKey: null, letterheadBy: null, letterheadAt: null });
      // the offer details are as they were
      expect(row).toMatchObject({ entity: was.entity, legalName: was.legalName, addressLines: was.addressLines });
    }
    // it logs what it deleted, and no link, credential or bytes
    expect(r.out.join("\n")).toContain(`deleted ${ch}`);
    expect(r.out.join("\n")).not.toContain("signed");
    expect(r.out.at(-1)).toContain("Offer PDFs were not touched");
  });

  it("is idempotent: a second run has nothing to do, calls neither the bucket nor the profile, and exits 0", async () => {
    await profile("welld_ch", true);
    await profile("welld_it", false);
    expect(await run({ apply: true }).go()).toBe(0);
    const settled = await rows();
    bucket.deleted.length = 0;
    const del = spyOn(memoryStorage, "deleteObject");
    try {
      const again = run({ apply: true });
      expect(await again.go()).toBe(0);
      expect(again.out).toEqual(["Nothing to retire: no entity profile holds an uploaded letterhead."]);
      expect(del).not.toHaveBeenCalled();
    } finally {
      del.mockRestore();
    }
    expect(await rows()).toEqual(settled);
    expect(bucket.deleted).toEqual([]);
  });

  it("finishes what a failed run left: a failed delete keeps the reference, and the re-run completes it", async () => {
    const ch = (await profile("welld_ch", true))!;
    const it = (await profile("welld_it", true))!;
    const flaky = {
      async deleteObject(key: string) {
        if (key === ch) throw Object.assign(new Error(`SECRET-STORAGE-DETAIL ${key}`), { name: "ServiceUnavailable" });
        await memoryStorage.deleteObject(key);
      },
    };
    const first = run({ apply: true, storage: flaky });
    expect(await first.go()).toBe(1);
    // the class only: a storage error's message may carry the key or the endpoint
    expect([...first.out, ...first.err].join("\n")).not.toContain("SECRET");
    expect([...first.out, ...first.err].join("\n")).toContain("ServiceUnavailable");
    const [chRow, itRow] = await rows();
    expect(chRow!.letterheadKey).toBe(ch);
    expect(itRow!.letterheadKey).toBeNull();
    expect(bucket.objects.has(ch)).toBe(true);

    expect(await run({ apply: true }).go()).toBe(0);
    expect((await rows()).map((row) => row.letterheadKey)).toEqual([null, null]);
    expect(bucket.objects.has(ch)).toBe(false);
  });

  it("finishes when the object is already gone but the reference is still there (a run that stopped between the two)", async () => {
    const ch = (await profile("welld_ch", true))!;
    bucket.objects.delete(ch);
    expect(await run({ apply: true }).go()).toBe(0);
    expect((await rows())[0]!.letterheadKey).toBeNull();
  });

  it("clears a partial reference (by or at without a key) too, without deleting any object", async () => {
    await db.entityProfile.create({ data: { entity: "welld_ch", ...PROFILE, updatedBy: "user-admin", letterheadBy: "user-admin", letterheadAt: new Date() } });
    const r = run({ apply: true });
    expect(await r.go()).toBe(0);
    expect(bucket.deleted).toEqual([]);
    expect((await rows())[0]).toMatchObject({ letterheadKey: null, letterheadBy: null, letterheadAt: null });
  });

  it("refuses unless the check passes, in a dry run too, and changes nothing", async () => {
    const ch = (await profile("welld_ch", true))!;
    const before = await rows();
    for (const apply of [false, true]) {
      const r = run({ check: 1, apply });
      expect(await r.go()).toBe(1);
      expect(r.err.join("\n")).toContain("Refused");
      expect(r.checks()).toBe(1);
    }
    expect(await run({ check: 2, apply: true }).go()).toBe(2);
    expect(await rows()).toEqual(before);
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.has(ch)).toBe(true);
  });

  it("refuses --apply while the switch is off here: the CRM would still draw its own pages from the upload", async () => {
    const ch = (await profile("welld_ch", true))!;
    const before = await rows();
    const r = run({ apply: true, switchOn: false });
    expect(await r.go()).toBe(1);
    expect(r.err.join("\n")).toContain("LETTERHEAD_SERVICE_ENABLED");
    expect(await rows()).toEqual(before);
    expect(bucket.objects.has(ch)).toBe(true);
    // a dry run says so but still lists
    const dry = run({ switchOn: false });
    expect(await dry.go()).toBe(0);
    expect(dry.out[0]).toContain("switch is off");
    expect(dry.out.some((line) => line.includes("would delete"))).toBe(true);
  });

  it("never deletes anything that is not the entity's own letterhead object: an offer PDF, another entity's file, a path trick", async () => {
    const offerKey = "offers/deal-1/offer-1.pdf";
    bucket.objects.set(offerKey, { bytes: PDF, contentType: "application/pdf", sizeBytes: PDF.byteLength });
    const otherEntity = (await profile("welld_it", true, `letterheads/welld_ch/${crypto.randomUUID()}.pdf`))!;
    await profile("welld_ch", true, offerKey);
    const before = await rows();
    for (const apply of [false, true]) {
      const r = run({ apply });
      expect(await r.go()).toBe(1);
      expect(r.err.join("\n")).toContain("SKIPPED");
      expect(r.err.join("\n")).not.toContain(offerKey);
    }
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.has(offerKey)).toBe(true);
    expect(bucket.objects.has(otherEntity)).toBe(true);
    // the references stay for a person to look at
    expect(await rows()).toEqual(before);

    for (const key of ["letterheads/welld_ch/../offers/x.pdf", "letterheads/welld_ch/not-a-uuid.pdf", "x/letterheads/welld_ch/11111111-1111-1111-1111-111111111111.pdf"]) {
      await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { letterheadKey: key } });
      expect(await run({ apply: true }).go()).toBe(1);
    }
    expect(bucket.deleted).toEqual([]);
  });

  it("leaves a letterhead that was replaced while it ran, instead of clearing the new reference", async () => {
    const ch = (await profile("welld_ch", true))!;
    const replacement = `letterheads/welld_ch/${crypto.randomUUID()}.pdf`;
    const racing = {
      async deleteObject(key: string) {
        await memoryStorage.deleteObject(key);
        await db.entityProfile.update({ where: { entity: "welld_ch" }, data: { letterheadKey: replacement } });
      },
    };
    const r = run({ apply: true, storage: racing });
    expect(await r.go()).toBe(1);
    expect(r.err.join("\n")).toContain("CHANGED");
    expect((await rows())[0]!.letterheadKey).toBe(replacement);
    expect(bucket.objects.has(ch)).toBe(false);
  });
});

describe("the render pre-check (security review F10)", () => {
  it("renders a sample PDF of each entity before it deletes anything, and deletes only after both succeeded", async () => {
    const ch = (await profile("welld_ch", true))!;
    const it = (await profile("welld_it", true))!;
    const seenAtRender: string[][] = [];
    const r = run({
      apply: true,
      render: async () => void seenAtRender.push([...bucket.deleted]),
    });
    expect(await r.go()).toBe(0);
    expect(r.rendered).toEqual(["welld_ch", "welld_it"]);
    // nothing was deleted when either render ran
    expect(seenAtRender).toEqual([[], []]);
    expect(bucket.deleted.sort()).toEqual([ch, it].sort());
  });

  it("refuses, in the dry run too, and changes nothing, when either entity's sample does not render", async () => {
    const ch = (await profile("welld_ch", true))!;
    const it = (await profile("welld_it", true))!;
    const before = await rows();
    for (const failing of ["welld_ch", "welld_it"] as const) {
      for (const apply of [false, true]) {
        const r = run({
          apply,
          render: async (entity) => {
            if (entity === failing)
              throw new ProblemError({ status: 503, code: "layout_service_unavailable", detail: "SECRET-SERVICE-DETAIL https://secret.example/x", extras: { reason: "SECRET-REASON" } });
          },
        });
        expect(await r.go()).toBe(1);
        const said = r.err.join("\n");
        expect(said).toContain("Refused");
        expect(said).toContain(`${failing.padEnd(9)} sample PDF did NOT render (layout_service_unavailable)`);
        // the entity that rendered is not blamed, and nothing of the service's words or a link is printed
        expect(said).not.toContain(failing === "welld_ch" ? "welld_it  sample" : "welld_ch  sample");
        expect(said + r.out.join("\n")).not.toMatch(/SECRET|secret\.example/);
        expect(r.out.some((line) => line.includes("would delete") || line.includes("deleted"))).toBe(false);
      }
    }
    expect(await rows()).toEqual(before);
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.has(ch) && bucket.objects.has(it)).toBe(true);
  });

  it("names a failure that is not a problem by its class only, never its text", async () => {
    await profile("welld_ch", true);
    const r = run({
      apply: true,
      render: async () => {
        throw Object.assign(new Error("SECRET-TEXT with a link https://x.example"), { name: "TimeoutError" });
      },
    });
    expect(await r.go()).toBe(1);
    expect(r.err.join("\n")).toContain("(TimeoutError)");
    expect(r.err.join("\n")).not.toContain("SECRET");
    expect(bucket.deleted).toEqual([]);
  });

  it("does not render when the check or the switch has already refused, nor when there is nothing to retire", async () => {
    await profile("welld_ch", true);
    const checkRefused = run({ check: 1, apply: true });
    expect(await checkRefused.go()).toBe(1);
    const switchOff = run({ apply: true, switchOn: false });
    expect(await switchOff.go()).toBe(1);
    expect(checkRefused.rendered).toEqual([]);
    expect(switchOff.rendered).toEqual([]);
    await resetWorld();
    const none = run({ apply: true });
    expect(await none.go()).toBe(0);
    expect(none.rendered).toEqual([]);
  });

  it("asks the real client for a small PDF of each entity (the offers' own call), and refuses when the service answers anything else", async () => {
    const sent: { path: string; body: any; authorization: string | null }[] = [];
    const pdf = (status = 200, headers: Record<string, string> = {}) =>
      new Response("%PDF-1.7 sample", {
        status,
        headers: { "Content-Type": "application/pdf", "Letterhead-Version": "3", "Legal-Entity-Version": "5", "Page-Count": "1", "Unprintable-Characters": "0", ...headers },
      });
    const clientAnswering = (answer: () => Response) =>
      createLetterheadClient({
        baseUrl: "http://letterhead.test",
        tokens: { getToken: async () => "svc-token", invalidate() {} },
        sleep: async () => {},
        fetchImpl: (async (url: unknown, init?: RequestInit) => {
          sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("Authorization") });
          return answer();
        }) as typeof fetch,
      });

    await profile("welld_ch", true);
    const good = run({ apply: true, render: sampleRenderer(clientAnswering(() => pdf())) });
    expect(await good.go()).toBe(0);
    expect(sent.map((call) => [call.path, call.body.entity, call.authorization])).toEqual([
      ["/v1/render/pdf", "welld_ch", "Bearer svc-token"],
      ["/v1/render/pdf", "welld_it", "Bearer svc-token"],
    ]);
    // small: one heading and one line, no issuer text, no letterhead version pinned, and no issuer version either (it prints nothing of it)
    expect(sent[0]!.body).toEqual(sampleContent("welld_ch"));
    expect(sent[0]!.body.blocks).toHaveLength(2);
    expect(sent[0]!.body.letterheadVersion).toBeUndefined();
    expect(sent[0]!.body.contentVersion).toBe(2);
    expect(sent[0]!.body).not.toHaveProperty("entityData");
    expect(sent[0]!.body).not.toHaveProperty("legalEntityVersion");

    // the second entity keeps its letterhead while every bad answer is tried
    const it = (await profile("welld_it", true))!;
    sent.length = 0;
    bucket.deleted.length = 0;
    const before = await rows();
    for (const answer of [() => pdf(500), () => new Response(null, { status: 409, headers: { "Content-Type": "application/problem+json" } }), () => pdf(200, { "Content-Type": "text/html" }), () => new Response("not a pdf", { headers: { "Content-Type": "application/pdf", "Letterhead-Version": "1", "Legal-Entity-Version": "5", "Page-Count": "1", "Unprintable-Characters": "0" } })]) {
      const bad = run({ apply: true, render: sampleRenderer(clientAnswering(answer)) });
      expect(await bad.go()).toBe(1);
      expect(bad.err.join("\n")).toContain("did NOT render");
    }
    expect(await rows()).toEqual(before);
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.has(it)).toBe(true);
  });
});
