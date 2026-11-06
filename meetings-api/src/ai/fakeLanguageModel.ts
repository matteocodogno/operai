/**
 * A scriptable `LanguageModel` for tests and for `MEETINGS_AI_PROVIDER=fake` (dev,
 * test and e2e only; env.ts refuses it in production). Never touches the network.
 *
 * Without a script it behaves like a well-behaved model, so an end-to-end run
 * produces a real-looking summary and a cited answer:
 *   - summary: one short body per section, read off the schema's item count;
 *   - answer: cites the first transcript segment header (`[S<n> ...]`) it finds in
 *     the request, or reports `notInMeeting` when the request holds none.
 *
 * Tests script the opposite, a HOSTILE model, to prove the validators (ADR-0067):
 *
 *   fake.respondWith({ sections: [...extra, renamed, forged...] })
 *   fake.failWith(new LanguageModelError("provider_unavailable", true, 503))
 *   fake.respondWith((request, schema) => ...)
 *
 * Every request it receives is kept in `requests`, which is what a prompt snapshot
 * test reads.
 */

import { ANSWER_TOOL, SUMMARY_TOOL, type LanguageModel, type LlmRequest, type OutputSchema } from "./languageModel";

type Script = unknown | Error | ((request: LlmRequest, schema: OutputSchema) => unknown | Promise<unknown>);

interface Scripted {
  readonly script: Script;
}

export interface RecordedRequest {
  readonly request: LlmRequest;
  readonly schema: OutputSchema;
}

const HEADER = /\[S(\d+)[\s\]]/;

function sectionCount(schema: OutputSchema): number {
  const sections = (schema.jsonSchema["properties"] as { sections?: { minItems?: unknown } } | undefined)?.sections;
  return typeof sections?.minItems === "number" ? sections.minItems : 1;
}

/** What a cooperative model submits for `schema`. */
export function defaultOutput(request: LlmRequest, schema: OutputSchema): unknown {
  if (schema.name === SUMMARY_TOOL) {
    return {
      sections: Array.from({ length: sectionCount(schema) }, (_, index) => ({
        index,
        body: `Fake summary of section ${index + 1}.`,
        notDiscussed: false,
      })),
    };
  }
  if (schema.name === ANSWER_TOOL) {
    const first = request.messages.map((m) => HEADER.exec(m.text)).find((m) => m !== null);
    return first
      ? { answer: "Fake answer, based on the cited passage.", citations: [`S${first[1]}`], notInMeeting: false }
      : { answer: "", citations: [], notInMeeting: true };
  }
  return {};
}

export class FakeLanguageModel implements LanguageModel {
  /** Every request, in order. */
  readonly requests: RecordedRequest[] = [];
  private readonly queue: Scripted[] = [];

  /**
   * One entry per upcoming call (a value, a function of the request, or an Error to
   * throw); once the queue is empty the cooperative default answers.
   */
  respondWith(...scripts: Script[]): this {
    this.queue.push(...scripts.map((script) => ({ script })));
    return this;
  }

  failWith(error: Error): this {
    return this.respondWith(error);
  }

  async complete(request: LlmRequest, schema: OutputSchema, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    this.requests.push({ request, schema });
    const next = this.queue.shift();
    if (!next) return defaultOutput(request, schema);
    if (next.script instanceof Error) throw next.script;
    if (typeof next.script === "function") return (next.script as (r: LlmRequest, s: OutputSchema) => unknown)(request, schema);
    return next.script;
  }
}
