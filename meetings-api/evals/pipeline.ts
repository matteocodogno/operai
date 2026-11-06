/**
 * The production path, minus the database (ADR-0067).
 *
 * Every step that touches model input or output is the REAL one: the prompt builders
 * (`buildSummaryRequest`, `buildAnswerRequest`: escaping and the fixed system prompt), the
 * validators (`validateSummaryOutput`, `validateAnswerOutput`: shape, server-rendered headings,
 * prose cleaning, citation filtering, the fixed "not in the meeting" answer) and the one-retry
 * loop of the summarize job and the ask route. Only persistence is left out, which is why an
 * eval needs neither a database nor a network in CI. The loop is mirrored, not imported (it is
 * inline in a job handler and a route); `eval.test.ts` pins both to `OUTPUT_TRIES = 2`.
 */

import { LanguageModelError, type LanguageModel, type LlmRequest, type OutputSchema } from "../src/ai/languageModel";
import { buildAnswerRequest, questionLanguage, validateAnswerOutput, type AnswerContext } from "../src/ai/prompts/answer";
import { buildSummaryRequest, validateSummaryOutput, type SummaryInput } from "../src/ai/prompts/summary";
import { builtinSnapshot, type TemplateSnapshot } from "../src/templates/builtin";
import type { AnswerOutcome, SummaryOutcome } from "./assertions";
import type { AnswerFixture, SummaryFixture } from "./types";

/** Invalid output gets this many samples in one run (the original and one retry): summarize.ts and conversation.routes.ts. */
export const OUTPUT_TRIES = 2;

export function templateOf(fixture: SummaryFixture): TemplateSnapshot {
  if ("custom" in fixture.template) return fixture.template.custom;
  const snapshot = builtinSnapshot(fixture.template.builtin, fixture.outputLanguage);
  if (!snapshot) throw new Error(`fixture ${fixture.id}: unknown built-in template ${fixture.template.builtin}`);
  return snapshot;
}

export interface SummaryRun {
  readonly request: LlmRequest;
  readonly schema: OutputSchema;
  readonly template: TemplateSnapshot;
  readonly outcome: SummaryOutcome;
  readonly samples: number;
}

export async function runSummary(model: LanguageModel, fixture: SummaryFixture): Promise<SummaryRun> {
  const template = templateOf(fixture);
  const input: SummaryInput = { template, language: fixture.outputLanguage, segments: fixture.segments };
  const { request, schema } = buildSummaryRequest(input);
  let samples = 0;
  for (let sample = 1; sample <= OUTPUT_TRIES; sample++) {
    samples = sample;
    try {
      const checked = validateSummaryOutput(await model.complete(request, schema), input);
      if (checked.ok) return { request, schema, template, outcome: { status: "ready", sections: checked.value }, samples };
    } catch (error) {
      if (error instanceof LanguageModelError && error.code === "invalid_output") continue;
      if (error instanceof LanguageModelError) return { request, schema, template, outcome: { status: "failed", code: error.code }, samples };
      throw error;
    }
  }
  return { request, schema, template, outcome: { status: "failed", code: "invalid_output" }, samples };
}

export interface AnswerRun {
  readonly request: LlmRequest;
  readonly schema: OutputSchema;
  readonly outcome: AnswerOutcome;
  readonly samples: number;
}

export async function runAnswer(model: LanguageModel, fixture: AnswerFixture): Promise<AnswerRun> {
  // the route detects the language from the question's words; the fixed answer is written in it
  const language = questionLanguage(fixture.question, fixture.meetingLanguage);
  const { request, schema } = buildAnswerRequest({ question: fixture.question, history: fixture.history ?? [], segments: fixture.segments });
  const context: AnswerContext = { segments: fixture.segments, language };
  let samples = 0;
  for (let sample = 1; sample <= OUTPUT_TRIES; sample++) {
    samples = sample;
    try {
      const checked = validateAnswerOutput(await model.complete(request, schema), context);
      if (checked.ok) return { request, schema, outcome: { status: "answered", answer: checked.value }, samples };
    } catch (error) {
      if (error instanceof LanguageModelError && error.code === "invalid_output") continue;
      if (error instanceof LanguageModelError) return { request, schema, outcome: { status: "failed", code: error.code }, samples };
      throw error;
    }
  }
  return { request, schema, outcome: { status: "failed", code: "invalid_output" }, samples };
}

// ─── The fake models ─────────────────────────────────────────────────────────

/** A model that submits `reply` every time it is asked (the obedient model of one channel). */
export const scripted = (reply: unknown): LanguageModel => ({ complete: async () => reply });

/** The well-behaved model: summarises the transcript and refuses what is out of scope. */
export function honestSummaryModel(fixture: SummaryFixture): LanguageModel {
  return {
    complete: async (_request, schema) => {
      const sections = (schema.jsonSchema["properties"] as { sections: { minItems: number } }).sections.minItems;
      const from = fixture.honest.notDiscussedFrom ?? sections;
      return {
        sections: Array.from({ length: sections }, (_, index) =>
          index >= from ? { index, body: "", notDiscussed: true } : { index, body: fixture.honest.body, notDiscussed: false },
        ),
      };
    },
  };
}

export function honestAnswerModel(fixture: AnswerFixture): LanguageModel {
  return {
    complete: async () =>
      "notInMeeting" in fixture.honest
        ? { answer: "", citations: [], notInMeeting: true }
        : { answer: fixture.honest.answer, citations: fixture.honest.ordinals.map((o) => `S${o}`), notInMeeting: false },
  };
}
