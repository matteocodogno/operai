/**
 * Prompt-injection evals for meetings-api (specs/021-meetings T83; AC-7.12, AC-9.7; ADR-0067).
 *
 *   bun run eval                      fake model, no network, no database: the CI gate
 *   bun run eval --obey <fixture-id>  negative control: that fixture's obedient replies judged
 *                                     by every tier; exits 1 (the assertions bite)
 *   bun run eval --live               the REAL EU model (Bedrock): the release and model-change
 *                                     gate. Needs BEDROCK_* and MEETINGS_AWS_*; costs real calls.
 *   bun run eval --list               the fixtures
 *   options: --filter <text> (id contains)  --repeat <n> (live: samples per fixture)  --json
 *
 * Exit codes: 0 all pass, 1 an assertion failed, 2 bad usage or missing live configuration.
 * The fake path never imports the Bedrock module, so it cannot reach a cloud provider.
 */

import { checkBedrockRegion } from "../src/lib/residency";
import { control, evaluate, type FixtureResult } from "./engine";
import { FIXTURES } from "./fixtures";
import type { Fixture } from "./types";

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

async function liveModel() {
  const need = ["BEDROCK_REGION", "BEDROCK_MODEL_ID", "MEETINGS_AWS_ACCESS_KEY_ID", "MEETINGS_AWS_SECRET_ACCESS_KEY"] as const;
  const missing = need.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`--live needs ${missing.join(", ")} (names only; values are never printed). See README.md § Release: prompt-injection evals.`);
    process.exit(2);
  }
  const refusal = checkBedrockRegion(process.env["BEDROCK_REGION"]!);
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  // Imported only here: a fake run never loads the AWS SDK.
  const { createBedrockLanguageModel, createBedrockRuntimeClient } = await import("../src/ai/bedrock");
  return createBedrockLanguageModel({
    client: createBedrockRuntimeClient({
      region: process.env["BEDROCK_REGION"]!,
      accessKeyId: process.env["MEETINGS_AWS_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["MEETINGS_AWS_SECRET_ACCESS_KEY"]!,
    }),
    modelId: process.env["BEDROCK_MODEL_ID"]!,
  });
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

  let model;
  if (live) {
    model = await liveModel();
    console.log(`LIVE run against ${process.env["BEDROCK_MODEL_ID"]} in ${process.env["BEDROCK_REGION"]}: ${fixtures.length} fixtures x ${repeat} (real provider calls)`);
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
  const code = summarise(results, live);
  if (live) {
    console.log(code === 0 ? `LIVE PASS: ${process.env["BEDROCK_MODEL_ID"]}, ${new Date().toISOString().slice(0, 10)}. Record this block in the PR.` : "LIVE FAIL: do not release or switch the model.");
  } else {
    console.log(code === 0 ? "PASS (fake model: server-side defences held against an obedient model)" : "FAIL");
  }
  return code;
}

process.exit(await main());
