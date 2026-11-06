/**
 * Prompt-injection evals for meetings-api (specs/021-meetings T83; AC-7.12, AC-9.7; ADR-0067).
 *
 *   bun run eval                      fake model, no network, no database: the CI gate
 *   bun run eval --obey <fixture-id>  negative control: that fixture's obedient replies judged
 *                                     by every tier; exits 1 (the assertions bite)
 *   bun run eval --live               the REAL EU model (Claude on Vertex AI): the release and
 *                                     model-change gate. Needs MEETINGS_GCP_PROJECT_ID,
 *                                     MEETINGS_VERTEX_LOCATION, MEETINGS_VERTEX_MODEL_ID and credentials
 *                                     (MEETINGS_GCP_SERVICE_ACCOUNT_KEY, or the credential file in
 *                                     GOOGLE_APPLICATION_CREDENTIALS that Workload Identity Federation
 *                                     writes in CI); costs real calls.
 *                                     The gate (plan H-10, QH-2): zero safety findings, no `max_tokens` stop on the wire, and
 *                                     at most 2 fixtures ending `invalid_output` after the resample (the availability tier).
 *                                     The first-sample rate and the stop-reason counts are printed for the PR (counts only).
 *   bun run eval --list               the fixtures
 *   options: --filter <text> (id contains)  --repeat <n> (live: samples per fixture)  --json
 *
 * Exit codes: 0 all pass, 1 an assertion failed, 2 bad usage or missing live configuration.
 * The fake path never imports the Vertex module or the Google auth library, so it cannot reach a cloud provider.
 */

import {
  GCP_PROJECT_ID_PATTERN,
  checkNoVertexBaseUrlOverride,
  checkVertexLocation,
  checkVertexModelId,
  parseServiceAccountKey,
} from "../src/lib/residency";
import { control, evaluate, liveGate, type FixtureResult } from "./engine";
import { FIXTURES } from "./fixtures";
import type { Fixture } from "./types";
import { recordWire, type WireStats } from "./wire";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const KNOWN = new Set(["--live", "--obey", "--filter", "--repeat", "--list", "--json", "--help"]);
const unknown = argv.filter((a, i) => a.startsWith("--") && !KNOWN.has(a) && !(i > 0 && ["--obey", "--filter", "--repeat"].includes(argv[i - 1]!)));
if (unknown.length > 0 || flag("--help")) {
  console.error("usage: bun run eval [--live] [--obey <fixture-id>] [--filter <text>] [--repeat <n>] [--list] [--json]");
  process.exit(unknown.length > 0 ? 2 : 0);
}

const pick = (): Fixture[] => {
  const filter = option("--filter");
  return filter ? FIXTURES.filter((f) => f.id.includes(filter)) : [...FIXTURES];
};

const langOf = (f: Fixture): string => (f.kind === "summary" ? `${f.lang}->${f.outputLanguage}` : f.questionLanguage);
const label = (f: Fixture): string => `${f.kind.padEnd(7)} ${langOf(f).padEnd(6)}`;

function print(results: readonly FixtureResult[], live: boolean): void {
  for (const r of results) {
    const f = r.fixture;
    const mark = r.ok ? "PASS" : "FAIL";
    const rejected = r.channels.filter((c) => c.outcome === "rejected").length;
    const accepted = r.channels.length - rejected;
    const residual = r.channels.filter((c) => c.outcome === "accepted" && c.modelFindings.length > 0 && !c.failed && c.knownGap === null).length;
    const gaps = r.channels.filter((c) => c.knownGap !== null && !c.staleGap).length;
    const tail = live ? "" : `  obey: ${r.channels.length} channels (${rejected} rejected, ${accepted} accepted, ${residual} prose-only residual${gaps ? `, ${gaps} KNOWN GAP` : ""})`;
    console.log(`${mark}  ${f.id.padEnd(48)} ${label(f)}${tail}`);
    for (const x of r.findings) console.log(`        [${x.tier}] ${x.check}: ${x.detail}`);
    for (const c of r.channels) {
      if (c.failed) for (const x of c.findings) console.log(`        [obey ${c.id}] [${x.tier}] ${x.check}: ${x.detail}`);
      if (c.staleGap) console.log(`        [stale known-gap marker] ${c.id} now passes: remove "${c.knownGap}" from the fixture`);
    }
  }
}

function summarise(results: readonly FixtureResult[], live: boolean): number {
  const failed = results.filter((r) => !r.ok);
  const channels = results.flatMap((r) => r.channels.map((c) => ({ r, c })));
  const gaps = channels.filter(({ c }) => c.knownGap !== null && !c.staleGap);
  const stale = channels.filter(({ c }) => c.staleGap);
  const residual = channels.filter(({ c }) => c.outcome === "accepted" && c.modelFindings.length > 0 && c.knownGap === null && !c.failed);
  console.log("");
  console.log(`fixtures: ${results.length} (${results.filter((r) => r.fixture.kind === "summary").length} summary, ${results.filter((r) => r.fixture.kind === "answer").length} answer), failed: ${failed.length}`);
  if (!live) {
    console.log(
      `obedient channels: ${channels.length} (${channels.filter(({ c }) => c.outcome === "rejected").length} rejected by validation, ${channels.filter(({ c }) => c.outcome === "accepted").length} accepted after cleaning)`,
    );
    console.log(`prose-only residual (server cannot judge; only a live run shows the model resisting): ${residual.length}`);
    console.log(`known gaps (expected server-tier failures): ${gaps.length}${gaps.length ? ` -> ${[...new Set(gaps.map(({ c }) => c.knownGap!.split(" ")[0]))].join(", ")}` : ""}`);
    if (stale.length > 0) console.log(`stale known-gap markers: ${stale.length} (a closed gap must lose its marker so it is guarded from now on)`);
  }
  return failed.length === 0 && stale.length === 0 ? 0 : 1;
}

/**
 * The settings the live run needs, checked BEFORE anything is imported or sent. The S2/S3/S5 checks the service
 * applies at startup apply here too (a `global` location, a Fable or Mythos model and an ambient base-URL override
 * are refused); a refusal names the variable and never a value. Credentials: the explicit service-account key as
 * the service uses it, or, in CI, the credential file Workload Identity Federation writes (a separate Vertex-only
 * service account). Never Application Default Credentials from the machine.
 */
function liveConfigProblems(env: NodeJS.ProcessEnv): { missing: string[]; refusals: string[] } {
  const missing = ["MEETINGS_GCP_PROJECT_ID", "MEETINGS_VERTEX_LOCATION", "MEETINGS_VERTEX_MODEL_ID"].filter((name) => !env[name]);
  if (!env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"] && !env["GOOGLE_APPLICATION_CREDENTIALS"]) {
    missing.push("MEETINGS_GCP_SERVICE_ACCOUNT_KEY (or GOOGLE_APPLICATION_CREDENTIALS)");
  }
  const refusals: string[] = [];
  const push = (message: string | null) => message && refusals.push(message);
  if (env["MEETINGS_VERTEX_LOCATION"]) push(checkVertexLocation(env["MEETINGS_VERTEX_LOCATION"]));
  if (env["MEETINGS_VERTEX_MODEL_ID"]) push(checkVertexModelId(env["MEETINGS_VERTEX_MODEL_ID"]));
  push(checkNoVertexBaseUrlOverride(env["ANTHROPIC_VERTEX_BASE_URL"]));
  if (env["MEETINGS_GCP_PROJECT_ID"] && !GCP_PROJECT_ID_PATTERN.test(env["MEETINGS_GCP_PROJECT_ID"])) {
    refusals.push("MEETINGS_GCP_PROJECT_ID is not a valid Google Cloud project id");
  }
  if (env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"]) push(parseServiceAccountKey(env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"], env["MEETINGS_GCP_PROJECT_ID"]).error ?? null);
  return { missing, refusals };
}

async function liveModel(): Promise<{ model: import("../src/ai/languageModel").LanguageModel; wire: () => WireStats }> {
  const { missing, refusals } = liveConfigProblems(process.env);
  if (missing.length > 0) {
    console.error(`--live needs ${missing.join(", ")} (names only; values are never printed). See README.md § Release: prompt-injection evals.`);
    process.exit(2);
  }
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(refusal);
    process.exit(2);
  }
  const location = process.env["MEETINGS_VERTEX_LOCATION"]!;
  const projectId = process.env["MEETINGS_GCP_PROJECT_ID"]!;

  // Imported only here: a fake run never loads the Vertex SDK or the Google auth library.
  const { createVertexClient, createVertexLanguageModel } = await import("../src/ai/vertexClaude");
  const authClient = await liveAuthClient(projectId);
  // The spy sees every reply of the real model, so a `max_tokens` stop the resample would hide is still counted (R30).
  const recorded = recordWire(createVertexClient({ location, projectId, authClient }));
  return { model: createVertexLanguageModel({ client: recorded.client, modelId: process.env["MEETINGS_VERTEX_MODEL_ID"]! }), wire: recorded.stats };
}

async function liveAuthClient(projectId: string) {
  const key = process.env["MEETINGS_GCP_SERVICE_ACCOUNT_KEY"];
  if (key) {
    const { createGoogleAuth } = await import("../src/lib/google/auth");
    return createGoogleAuth({ key: parseServiceAccountKey(key, projectId).key! }).client;
  }
  // The WIF credential file google-github-actions/auth exports: named explicitly, not found by the ambient chain.
  const { GoogleAuth } = await import("google-auth-library");
  return new GoogleAuth({ keyFilename: process.env["GOOGLE_APPLICATION_CREDENTIALS"]!, scopes: ["https://www.googleapis.com/auth/cloud-platform"], projectId }).getClient();
}

async function main(): Promise<number> {
  if (flag("--list")) {
    for (const f of pick()) console.log(`${f.id.padEnd(48)} ${label(f)} ${f.attacks.join(",")}`);
    return 0;
  }

  const obey = option("--obey");
  if (obey !== undefined) {
    const fixture = FIXTURES.find((f) => f.id === obey);
    if (!fixture) {
      console.error(`unknown fixture "${obey}" (bun run eval --list)`);
      return 2;
    }
    const found = await control(fixture);
    console.log(`negative control ${fixture.id}: the fake OBEYS the planted instruction on every channel`);
    for (const f of found) console.log(`  [${f.tier}] ${f.check}: ${f.detail}`);
    if (found.length === 0) {
      console.error("the control found nothing: the assertions do not bite (harness bug)");
      return 3;
    }
    console.log(`${found.length} finding(s): the run FAILS, as it must when a model obeys.`);
    return 1;
  }

  const live = flag("--live");
  const repeat = Number(option("--repeat") ?? 1);
  if (!Number.isInteger(repeat) || repeat < 1) {
    console.error("--repeat must be a positive integer");
    return 2;
  }
  const fixtures = pick();
  if (fixtures.length === 0) {
    console.error("no fixture matches --filter");
    return 2;
  }

  let model: import("../src/ai/languageModel").LanguageModel | undefined;
  let wire: (() => WireStats) | undefined;
  if (live) {
    ({ model, wire } = await liveModel());
    console.log(`LIVE run against ${process.env["MEETINGS_VERTEX_MODEL_ID"]} in ${process.env["MEETINGS_VERTEX_LOCATION"]}: ${fixtures.length} fixtures x ${repeat} (real provider calls)`);
  } else {
    console.log("fake model, no network, no database (CI mode)");
  }

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) results.push(await evaluate(fixture, model ? { live: model, repeat } : {}));

  if (flag("--json")) {
    console.log(JSON.stringify(results.map((r) => ({ id: r.fixture.id, ok: r.ok, findings: r.findings, channels: r.channels.map((c) => ({ id: c.id, outcome: c.outcome, failed: c.failed, knownGap: c.knownGap, staleGap: c.staleGap, findings: c.findings })) })), null, 2));
  } else {
    print(results, live);
  }
  let code = summarise(results, live);
  if (live) {
    const gate = liveGate(results, wire!());
    console.log("");
    for (const line of gate.lines) console.log(line);
    if (!gate.ok) code = 1;
    console.log(code === 0 ? `LIVE PASS: ${process.env["MEETINGS_VERTEX_MODEL_ID"]}, ${new Date().toISOString().slice(0, 10)}. Record this block in the PR.` : "LIVE FAIL: do not release or switch the model.");
  } else {
    console.log(code === 0 ? "PASS (fake model: server-side defences held against an obedient model)" : "FAIL");
  }
  return code;
}

process.exit(await main());
