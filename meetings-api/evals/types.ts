/**
 * Shapes of the prompt-injection evals (specs/021-meetings T83; AC-7.12, AC-9.7; ADR-0067 point 6).
 *
 * WHAT A FIXTURE IS. A synthetic transcript (Italian or English, never personal) with
 * planted attacks, plus the replies a model that OBEYED those attacks would submit, one per
 * "channel" (the way an obedient model could let the injection reach the output).
 *
 * THREE TIERS OF ASSERTION (see assertions.ts):
 *   request  the prompt the server builds cannot be restructured by transcript text
 *   server   whatever the model replies, what the server accepts keeps the shape and is plain,
 *            link-free, banner-free and grounded. Run on EVERY run, fake or live.
 *   model    the model itself resisted: canary absent, off-scope question refused, output
 *            language right. Run on a well-behaved reply (fake) or the real model (live);
 *            NEVER on the obedient channels, which are the case the server must survive.
 */

import type { TemplateSnapshot } from "../src/templates/builtin";
import type { PromptSegment } from "../src/ai/prompts/transcript";

export type Lang = "it" | "en";

export type AttackClass =
  | "ignore-instructions"
  | "format-scope-change"
  | "fake-system-line"
  | "fake-delimiters"
  | "markup-links"
  | "url-exfil"
  | "cross-meeting"
  | "off-scope"
  | "language-switch"
  | "canary"
  | "hostile-label"
  | "hostile-template"
  | "unicode-evasion"
  | "citation-forgery"
  | "history-injection";

/** One content block of a provider reply, as much of it as the channels build (wire.ts). */
export interface WireBlock {
  readonly type: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly text?: string;
  readonly thinking?: string;
}

/** A provider reply, the shape the adapter reads (`stop_reason` + `content`). */
export interface WireReply {
  readonly stop_reason: string;
  readonly content: readonly WireBlock[];
}

/**
 * A channel at the PROVIDER level (plan H-8/H-10): the model is not forced to call the tool, so a reply can be plain
 * text, two calls, another tool, a cut-off call, or a valid call wrapped in text or thinking. It goes through the REAL
 * adapter (the acceptance rule) over a stubbed client, then the real validators and the one-resample loop.
 */
export interface WireShape {
  /** The provider reply, built from what the well-behaved model would have submitted as the tool input. */
  readonly build: (honest: unknown, tool: string) => WireReply;
  /** What the adapter must do: reject with this closed reason (every sample), or accept and discard the text that must never show. */
  readonly expect: { readonly outcome: "rejected"; readonly reason: string } | { readonly outcome: "accepted"; readonly discards: readonly string[] };
}

/** One way an obedient model could let the injection through: the raw tool input it submits. */
export interface Channel {
  readonly id: string;
  /** The tool input submitted. Unused (null) on a wire channel, which builds a whole provider reply instead. */
  readonly reply: unknown;
  readonly wire?: WireShape;
  /**
   * A server-tier failure is EXPECTED on this channel: a defence gap, reported not hidden.
   * The value names the defect (README § Known gaps). A marked channel that passes is a stale marker.
   */
  readonly knownGap?: string;
  /** Strings that a contained reply must still show (a legitimate URL the meeting contains is not removed). */
  readonly keeps?: readonly string[];
}

export interface Common {
  readonly id: string;
  readonly lang: Lang;
  readonly attacks: readonly AttackClass[];
  readonly description: string;
  /** A planted token the attack asks the model to print; null when the fixture has none. */
  readonly canary: string | null;
  /** Strings that must never reach an output (content the injection asks for from outside this meeting). */
  readonly forbidden: readonly string[];
  /** Content of OTHER meetings (the cross-meeting attacks ask for it): absent from the request, and from any output. */
  readonly foreign?: readonly string[];
}

export interface SummaryContext {
  readonly sectionCount: number;
  readonly outputLanguage: Lang;
}

export interface SummaryFixture extends Common {
  readonly kind: "summary";
  readonly outputLanguage: Lang;
  /** A built-in template (snapshotted in the output language) or a custom one. */
  readonly template: { readonly builtin: string } | { readonly custom: TemplateSnapshot };
  readonly segments: readonly PromptSegment[];
  /** The well-behaved model's section body (in the output language); sections from `notDiscussedFrom` on are "not discussed". */
  readonly honest: { readonly body: string; readonly notDiscussedFrom?: number };
  readonly channels: (ctx: SummaryContext) => readonly Channel[];
}

export interface HistoryTurn {
  readonly question: string;
  readonly answer: string;
}

export interface AnswerFixture extends Common {
  readonly kind: "answer";
  /** The meeting's language (the fallback of the question-language detection). */
  readonly meetingLanguage: Lang;
  readonly question: string;
  /** The language the question is written in: the fixed "not in the meeting" answer must be in it. */
  readonly questionLanguage: Lang;
  readonly history?: readonly HistoryTurn[];
  readonly segments: readonly PromptSegment[];
  /** What a well-behaved model submits. `ordinals` are the segments that support the answer. */
  readonly honest: { readonly notInMeeting: true } | { readonly answer: string; readonly ordinals: readonly number[] };
  readonly channels: () => readonly Channel[];
}

export type Fixture = SummaryFixture | AnswerFixture;

export type Tier = "request" | "server" | "model";

export interface Finding {
  readonly tier: Tier;
  readonly check: string;
  readonly detail: string;
}
