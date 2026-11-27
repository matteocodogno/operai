/**
 * What hours-api waits for an owner that itself asks a host before it answers sits strictly outside what that owner spends
 * (specs/20261126-teams R13 b; ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-
 * the-deadline-of-the-consumer-..., rule 7: a chain through a middle counts its sequential rounds).
 *
 * Two kinds of owner. A HOST (projects-api, crm-api, meetings-api's system route) answers from its own data: `OWNER_TIMEOUT_MS`, 2 s.
 * A RELAYED owner asks a host first: activities-api (`GET /activities?ids=` and `?dealId=`) and the meetings list
 * (`GET /meetings?ids=`). hours-api waits `RELAYED_OWNER_TIMEOUT_MS` (6 s) for those, and each middle bounds its own inner waits:
 *
 *   activities-api  LIST_HOST_ROUNDS × RESOLVE_TIMEOUT_MS + NAMES_WAIT_MS + RELAY_MARGIN_MS < RELAYED_OWNER_TIMEOUT_MS   (2 × 2 000 + 800 + 1 000 = 5 800)
 *   meetings-api    max(rounds × RESOLVE_TIMEOUT_MS, LIST_NAMES_WAIT_MS) + RELAY_MARGIN_MS < RELAYED_OWNER_TIMEOUT_MS      (2 000 + 1 000 = 3 000)
 *
 * where `rounds` is what the batch size needs of the host's own batch size (`ceil(50 / 25) = 2`, `ceil(25 / 25) = 1`), and the
 * name lookups outlive their wait (`NAMES_WAIT_MS`, `LIST_NAMES_WAIT_MS` < `REQUEST_TIMEOUT_MS`) so a late answer still fills the cache.
 * `LIST_HOST_ROUNDS` is descriptive: `activities-api/src/activities/hostRounds.test.ts` ties it to the code.
 *
 * HOW THE CONSTANTS ARE READ. The other packages' files cannot be IMPORTED from here (each evaluates its own `env` and resolves its own
 * `node_modules`), so each is read as text and the one `export const <NAME> = …;` declaration is evaluated (a number, or a product of
 * numbers). A file that is missing, a declaration that is absent, repeated, not exported or not a plain number is a FAILURE, never a
 * skip: the inequalities are the whole point of this file.
 *
 * THE STATIC CHECKS. The relayed default is applied by the clients that call a relayed owner and by no other: a client moved back
 * to `OWNER_TIMEOUT_MS` is silently 2 s again, and one that borrows the 6 s is silently slower to fail. Planted sources prove each can fail.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { OWNER_TIMEOUT_MS, RELAYED_OWNER_TIMEOUT_MS } from "./owner";
import { ACTIVITIES_IDS_BATCH_SIZE } from "./activities";
import { MEETINGS_IDS_BATCH_SIZE } from "./meetings";

// shared-copy:begin deadlineReader
/** The value of the one `export const <name> = <n | n * n>;` of `source`; throws when it is not exactly that. */
function deadlineOf(source: string, name: string): number {
  const declaration = new RegExp(`^export const ${name}\\s*(?::\\s*number\\s*)?=\\s*([^;\\n]*);`, "gm");
  const found = [...source.matchAll(declaration)];
  if (found.length !== 1) throw new Error(`expected exactly one \`export const ${name} = …;\`, found ${found.length}`);
  const expression = found[0]![1]!.trim();
  if (!/^\d[\d_]*(\s*\*\s*\d[\d_]*)*$/.test(expression)) throw new Error(`${name} is not a plain number or product of numbers: ${expression}`);
  return expression.split("*").reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
}
// shared-copy:end deadlineReader

/** Repo-relative: this file is `hours-api/src/clients/…`. */
const fileUrl = (path: string): URL => new URL(`../../../${path}`, import.meta.url);

function readSource(path: string): string {
  const url = fileUrl(path);
  if (!existsSync(url)) throw new Error(`${path} is not at ${url.pathname}: this test does not skip, the inequalities it checks have to be checkable`);
  return readFileSync(url, "utf8");
}

const read = (path: string, name: string): number => deadlineOf(readSource(path), name);

/** One margin for what a middle spends outside its own waits: JWT, the DB, building the answer, two hops (the accounting precedent: 1 000 ms). */
const RELAY_MARGIN_MS = 1_000;

describe("the reader of another package's constant", () => {
  it("evaluates a number, a number with separators and a product, and refuses anything else", () => {
    expect(deadlineOf("export const X_MS = 2_000;", "X_MS")).toBe(2_000);
    expect(deadlineOf("export const X_MS: number = 2 * 1_000;", "X_MS")).toBe(2_000);
    expect(deadlineOf("// export const X_MS = 1;\nexport const X_MS = 3_000;", "X_MS")).toBe(3_000);
    for (const bad of [
      "",
      "const X_MS = 2_000;", // not exported
      "export const X_MS = env.DEADLINE;", // not a literal
      "export const X_MS = 2_000 + 1;",
      "export const X_MS = 2_000;\nexport const X_MS = 5_000;", // repeated
      "export const OTHER_MS = 2_000;", // absent
    ]) {
      expect(() => deadlineOf(bad, "X_MS")).toThrow();
    }
  });

  it("a missing file fails, it never skips", () => {
    expect(() => readSource("no-such-package/src/nothing.ts")).toThrow(/does not skip/);
  });
});

describe("hours-api's own figures", () => {
  it("pins them: a host 2 000 ms, a relayed owner 6 000 ms, the batches 50 and 25", () => {
    expect(OWNER_TIMEOUT_MS).toBe(2_000);
    expect(RELAYED_OWNER_TIMEOUT_MS).toBe(6_000);
    expect(ACTIVITIES_IDS_BATCH_SIZE).toBe(50);
    expect(MEETINGS_IDS_BATCH_SIZE).toBe(25);
    expect(RELAYED_OWNER_TIMEOUT_MS).toBeGreaterThan(OWNER_TIMEOUT_MS);
  });
});

describe("activities-api's list routes fit inside the relayed owner's wait (R13 b)", () => {
  const hostsClient = "activities-api/src/hosts/client.ts";
  const rounds = () => read(hostsClient, "LIST_HOST_ROUNDS");
  const resolveTimeout = () => read(hostsClient, "RESOLVE_TIMEOUT_MS");
  const namesWait = () => read("activities-api/src/lib/people.ts", "NAMES_WAIT_MS");
  const requestTimeout = () => read("activities-api/src/lib/identities.ts", "REQUEST_TIMEOUT_MS");

  it("pins the figures: a host call 2 000 ms and a batch of 25 ids, 2 rounds, names 800 ms of the lookup's own 5 000 ms", () => {
    expect(resolveTimeout()).toBe(2_000);
    expect(read(hostsClient, "RESOLVE_BATCH_SIZE")).toBe(25);
    expect(rounds()).toBe(2);
    expect(namesWait()).toBe(800);
    expect(requestTimeout()).toBe(5_000);
  });

  it("the rounds cover hours-api's batch of ids: ceil(ACTIVITIES_IDS_BATCH_SIZE / RESOLVE_BATCH_SIZE) <= LIST_HOST_ROUNDS", () => {
    expect(Math.ceil(ACTIVITIES_IDS_BATCH_SIZE / read(hostsClient, "RESOLVE_BATCH_SIZE"))).toBeLessThanOrEqual(rounds());
  });

  it("rounds × host deadline + names wait + margin is under hours-api's wait: 2 × 2 000 + 800 + 1 000 = 5 800 < 6 000", () => {
    expect(rounds() * resolveTimeout() + namesWait() + RELAY_MARGIN_MS).toBeLessThan(RELAYED_OWNER_TIMEOUT_MS);
  });

  it("the names wait is shorter than the lookup it does not abort, so a late answer still fills the cache", () => {
    expect(namesWait()).toBeLessThan(requestTimeout());
  });
});

describe("meetings-api's list route fits inside the relayed owner's wait (R13 b)", () => {
  const hostsClient = "meetings-api/src/hosts/client.ts";
  const identities = "meetings-api/src/lib/identities.ts";
  const resolveTimeout = () => read(hostsClient, "RESOLVE_TIMEOUT_MS");
  const batch = () => read(hostsClient, "RESOLVE_BATCH");
  const namesWait = () => read(identities, "LIST_NAMES_WAIT_MS");
  const requestTimeout = () => read(identities, "REQUEST_TIMEOUT_MS");

  it("pins the figures: a host call 2 000 ms, a batch of 25 ids, names 800 ms of the lookup's own 5 000 ms", () => {
    expect(resolveTimeout()).toBe(2_000);
    expect(batch()).toBe(25);
    expect(namesWait()).toBe(800);
    expect(requestTimeout()).toBe(5_000);
  });

  it("one host round covers hours-api's batch of ids, and the longer of host round and names, plus the margin, is under hours-api's wait: 2 000 + 1 000 = 3 000 < 6 000", () => {
    const rounds = Math.ceil(MEETINGS_IDS_BATCH_SIZE / batch());
    expect(rounds).toBe(1);
    // the names and the host labels run in parallel (meetings/rows.ts)
    expect(Math.max(rounds * resolveTimeout(), namesWait()) + RELAY_MARGIN_MS).toBeLessThan(RELAYED_OWNER_TIMEOUT_MS);
  });

  it("the names wait is shorter than the lookup it does not abort, so a late answer still fills the cache", () => {
    expect(namesWait()).toBeLessThan(requestTimeout());
  });
});

/** The text of `source` from the `export async function <name>` to the next `export ` (or the end). */
function functionText(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`no export async function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

const DEFAULT = "?? RELAYED_OWNER_TIMEOUT_MS";
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** What is wrong with where the clients apply the relayed default, as a list of problems (empty = fine). */
function relayedProblems(files: { activities: string; meetings: string; projects: string; crm: string }): string[] {
  const problems: string[] = [];
  if (count(files.activities, DEFAULT) !== 2) problems.push(`activities.ts: expected 2 \`${DEFAULT}\`, found ${count(files.activities, DEFAULT)}`);
  const list = functionText(files.meetings, "listMeetingsByIds");
  if (count(list, DEFAULT) !== 1) problems.push(`meetings.ts listMeetingsByIds: expected 1 \`${DEFAULT}\`, found ${count(list, DEFAULT)}`);
  if (count(files.meetings, DEFAULT) !== 1) problems.push("meetings.ts: the relayed default is used outside listMeetingsByIds (the system route is a host: 2 s)");
  for (const [name, text] of [["projects.ts", files.projects], ["crm.ts", files.crm]] as const) {
    if (text.includes("RELAYED_OWNER_TIMEOUT_MS")) problems.push(`${name}: a host is asked with OWNER_TIMEOUT_MS, never the relayed wait`);
  }
  return problems;
}

const sources = () => ({
  activities: readSource("hours-api/src/clients/activities.ts"),
  meetings: readSource("hours-api/src/clients/meetings.ts"),
  projects: readSource("hours-api/src/clients/projects.ts"),
  crm: readSource("hours-api/src/clients/crm.ts"),
});

describe("the clients apply the relayed default exactly where an owner relays (R13 b)", () => {
  it("activities.ts twice, meetings.ts once in listMeetingsByIds and nowhere else, the host clients never", () => {
    expect(relayedProblems(sources())).toEqual([]);
  });

  it("the check can fail: a missing default, an extra one, a borrowed one are each found", () => {
    const good = {
      activities: `a ${DEFAULT} b\nc ${DEFAULT}`,
      meetings: `export async function listMeetingsByIds() { x ${DEFAULT} }\nexport async function readMeetingHosts() { y }`,
      projects: "",
      crm: "",
    };
    expect(relayedProblems(good)).toEqual([]);
    expect(relayedProblems({ ...good, activities: `a ${DEFAULT}` })).toEqual(["activities.ts: expected 2 `?? RELAYED_OWNER_TIMEOUT_MS`, found 1"]);
    expect(relayedProblems({ ...good, meetings: "export async function listMeetingsByIds() { x }\nexport async function readMeetingHosts() { y }" })).toEqual([
      "meetings.ts listMeetingsByIds: expected 1 `?? RELAYED_OWNER_TIMEOUT_MS`, found 0",
      "meetings.ts: the relayed default is used outside listMeetingsByIds (the system route is a host: 2 s)",
    ]);
    expect(
      relayedProblems({
        ...good,
        meetings: `export async function listMeetingsByIds() { x ${DEFAULT} }\nexport async function readMeetingHosts() { y ${DEFAULT} }`,
      }),
    ).toEqual(["meetings.ts: the relayed default is used outside listMeetingsByIds (the system route is a host: 2 s)"]);
    expect(relayedProblems({ ...good, crm: "timeoutMs: RELAYED_OWNER_TIMEOUT_MS" })).toEqual(["crm.ts: a host is asked with OWNER_TIMEOUT_MS, never the relayed wait"]);
  });
});
