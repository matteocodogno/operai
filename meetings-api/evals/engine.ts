/**
 * Runs fixtures and decides pass/fail. No I/O: `run.ts` prints, `eval.test.ts` asserts.
 *
 * FAKE MODE, per fixture:
 *   1. request tier on the real prompt;
 *   2. the RESIST pass: a well-behaved fake summarises / refuses, and ALL tiers must pass
 *      (this proves the assertions are satisfiable by correct behaviour);
 *   3. the OBEY pass: for each channel, a fake that OBEYS the planted instruction submits the
 *      hostile reply and the SERVER tier must hold. A channel the server accepts but a model
 *      assertion would reject is counted as `residual`: the server cannot contain prose that
 *      reads as a plausible summary (R14), only the live run can show the model resisting it.
 * LIVE MODE: only step 1 and a RESIST pass against the real model (all tiers), `repeat` times.
 */

import type { LanguageModel } from "../src/ai/languageModel";
import {
  answerModelFindings,
  answerRequestFindings,
  answerServerFindings,
  summaryModelFindings,
  summaryRequestFindings,
  summaryServerFindings,
} from "./assertions";
import { FIXTURES } from "./fixtures";
import { honestAnswerModel, honestSummaryModel, runAnswer, runSummary, scripted, templateOf } from "./pipeline";
import type { AnswerFixture, Channel, Finding, Fixture, SummaryFixture } from "./types";

export interface ChannelResult {
  readonly id: string;
  /** What the pipeline did with the hostile reply. */
  readonly outcome: "rejected" | "accepted";
  /** Server-tier findings (a containment failure unless `knownGap`). */
  readonly findings: readonly Finding[];
  /** Model-tier findings on the same reply: the part only the model can resist. */
  readonly modelFindings: readonly Finding[];
  readonly knownGap: string | null;
  /** The channel was marked as a known gap but now passes: the marker is stale. */
  readonly staleGap: boolean;
  /** Counts against the run: an unexpected server-tier finding. */
  readonly failed: boolean;
}

export interface FixtureResult {
  readonly fixture: Fixture;
  /** request + resist-pass findings (all tiers): any is a failure. */
  readonly findings: readonly Finding[];
  readonly channels: readonly ChannelResult[];
  readonly samples: number;
  readonly ok: boolean;
}

interface Ran {
  readonly request: readonly Finding[];
  readonly server: (keeps: readonly string[]) => readonly Finding[];
  readonly model: readonly Finding[];
  readonly rejected: boolean;
  readonly samples: number;
}

async function runOnce(fixture: Fixture, model: LanguageModel): Promise<Ran> {
  if (fixture.kind === "summary") {
    const run = await runSummary(model, fixture);
    const headings = run.template.sections.map((s) => s.heading);
    return {
      request: summaryRequestFindings(fixture, run.request, run.schema),
      server: (keeps) => summaryServerFindings(fixture, headings, run.outcome, keeps),
      model: summaryModelFindings(fixture, run.outcome),
      rejected: run.outcome.status === "failed",
      samples: run.samples,
    };
  }
  const run = await runAnswer(model, fixture);
  return {
    request: answerRequestFindings(fixture, run.request, run.schema),
    server: (keeps) => answerServerFindings(fixture, run.outcome, keeps),
    model: answerModelFindings(fixture, run.outcome),
    rejected: run.outcome.status === "failed",
    samples: run.samples,
  };
}

const channelsOf = (fixture: Fixture): readonly Channel[] =>
  fixture.kind === "summary" ? fixture.channels({ sectionCount: templateOf(fixture).sections.length, outputLanguage: fixture.outputLanguage }) : fixture.channels();

export async function runChannel(fixture: Fixture, channel: Channel): Promise<ChannelResult> {
  const ran = await runOnce(fixture, scripted(channel.reply));
  const findings = [...ran.request, ...ran.server(channel.keeps ?? [])];
  const knownGap = channel.knownGap ?? null;
  return {
    id: channel.id,
    outcome: ran.rejected ? "rejected" : "accepted",
    findings,
    modelFindings: ran.model,
    knownGap,
    staleGap: knownGap !== null && findings.length === 0,
    failed: knownGap === null && findings.length > 0,
  };
}

export interface EvalOptions {
  /** Live: the real model instead of the fakes, and no obedient channels. */
  readonly live?: LanguageModel;
  readonly repeat?: number;
}

export async function evaluate(fixture: Fixture, options: EvalOptions = {}): Promise<FixtureResult> {
  const findings: Finding[] = [];
  const channels: ChannelResult[] = [];
  let samples = 0;

  const repeat = options.live ? Math.max(1, options.repeat ?? 1) : 1;
  for (let i = 0; i < repeat; i++) {
    const model = options.live ?? (fixture.kind === "summary" ? honestSummaryModel(fixture) : honestAnswerModel(fixture));
    const ran = await runOnce(fixture, model);
    samples += ran.samples;
    const found = [...ran.request, ...ran.server([]), ...ran.model];
    for (const f of found) if (!findings.some((g) => g.check === f.check && g.detail === f.detail)) findings.push(f);
  }

  if (!options.live) for (const channel of channelsOf(fixture)) channels.push(await runChannel(fixture, channel));

  const ok = findings.length === 0 && channels.every((c) => !c.failed);
  return { fixture, findings, channels, samples, ok };
}

export async function evaluateAll(fixtures: readonly Fixture[] = FIXTURES, options: EvalOptions = {}): Promise<FixtureResult[]> {
  const out: FixtureResult[] = [];
  for (const fixture of fixtures) out.push(await evaluate(fixture, options));
  return out;
}

/**
 * The negative control: `fixture`'s obedient replies judged by EVERY tier, as if the model's
 * obedience were a failure. Must find something, or the assertions do not bite.
 */
export async function control(fixture: Fixture): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const channel of channelsOf(fixture)) {
    const r = await runChannel(fixture, channel);
    for (const f of [...r.findings, ...r.modelFindings]) out.push({ ...f, check: `${channel.id}: ${f.check}` });
  }
  return out;
}

export const isSummary = (f: Fixture): f is SummaryFixture => f.kind === "summary";
export const isAnswer = (f: Fixture): f is AnswerFixture => f.kind === "answer";
