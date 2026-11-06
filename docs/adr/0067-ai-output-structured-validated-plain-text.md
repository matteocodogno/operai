# 0067 — AI output is structured, validated and rendered as plain text; the whole record goes in context and there is no embeddings store

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04, D-8). Amended 2026-11-05 (point 3: one offered tool, not forced; plan amendment #2, decision D4). The suite's first LLM-facing feature; ReviewAI and ProposAI inherit it.
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0061](0061-meetings-ai-providers-eu-zero-retention.md), [ADR-0013](0013-invitation-lifecycle-derived-expiry-state.md), [ADR-0038](0038-optimistic-concurrency-version-if-match-cas-amends-0004.md)

---

## Context

Meetings summarises a transcript from a template and answers questions about it (US-7, US-9).
The transcript is **text spoken or pasted by anyone present or by whoever supplied the file**,
so it is untrusted input to a language model. Anything a speaker says can be an instruction
("ignore your instructions and …", "ignora le istruzioni …", a forged `</transcript><system>`
block). The output is shown to people who may act on it and may be copied into other systems.
No existing feature in the suite calls a model; the pattern set here will be reused.

A 3 h meeting is about 27 k words, about 50 k tokens; a 200,000-character text meeting about
60 k tokens.

## Decision

1. **The whole transcript goes in context; no retrieval, no embeddings.** Follow-ups send the
   last 10 turns (AC-9.4). Prompt caching is used only if the provider confirms compatibility
   with `none` retention (ADR-0061).
2. **Prompt layout.** A fixed English system prompt sets the task, the output language and the
   rule that everything inside the transcript block is quoted data, never instructions. The
   template's section instructions come next, length-bounded (≤ 500 per section, ≤ 2,000
   general). Then `<transcript>` with one line per segment, `[S<ordinal> hh:mm:ss <speaker
   label>] text` (a text meeting: one line per passage, ~1,000 characters, no time or speaker).
   **Angle brackets and the `[S` marker are escaped inside segment text**, so a speaker cannot
   close the block or forge a segment header.
3. **Structured output through a single offered tool, and the "tool" is only the output schema.**
   No function reaches anything, so there is no capability to act (AC-7.10). *(Amended
   2026-11-05; originally "forced tool use".)* The request offers exactly one tool and does not
   force it (no `tool_choice`, no `thinking`). The reply is accepted only as **exactly one call of
   that tool, `stop_reason` `tool_use`, whose input passes the schema validator**. `text`,
   `thinking` and `redacted_thinking` blocks are discarded unread (never validated, stored or
   logged, since they can echo the transcript); any other block type is invalid. Text-only
   replies, no call, two calls, another tool, any other stop reason or a schema rejection are
   `invalid_output`. Forcing the call is used only where the pinned model supports it and is never
   relied on: **the guarantee is the validation, not the provider mechanism.**
   - Summary `{ sections: [{ index, body ≤ 8,000, notDiscussed }] }`: the server checks every
     index 0..n−1 appears exactly once, **renders the headings itself** from the template
     snapshot (built-in headings in the output language), and writes the localised "Not
     discussed". Injected text can change a section's prose, never the template's shape
     (AC-7.12).
   - Answer `{ answer ≤ 4,000, citations: string[] ≤ 10, notInMeeting }`: the server keeps only
     citations that exist in this meeting; an answer with no valid citation becomes the "the
     meeting does not contain this" answer, so **no answer goes uncited** (AC-9.3, AC-9.6).
   - Invalid output: one automatic resample (the same request again, no corrective message,
     counted as the same single AI request under AC-13.4), then `failed`. **Partial text is never
     stored as `ready`** (AC-7.9).
4. **Rendering is plain text with line breaks**: no Markdown links or images, so injected text
   cannot exfiltrate through an image URL or a link; React escapes the rest. Every AI output
   is labelled "AI-generated" with template, language, author and time.
5. **Request content is fixed.** The request holds only system prompt + template + transcript
   (+ the asker's own previous turns); no summaries of other meetings, no host data, no
   other users' conversations (AC-9.2).
6. **Evidence of the defence.** Unit tests feed hostile fake-LLM outputs (extra sections,
   renamed headings, prose claiming to be the system, citations that do not exist, a URL) and
   require rejection or neutralisation. Evals (`meetings-api/evals/`, `bun run eval`, against
   the real EU provider) use synthetic Italian and English transcripts with planted
   instructions and assert deterministically: schema-valid, every section present, the canary
   absent from a section body or the answer, an off-scope injected question returns
   `notInMeeting`, no URL not in the transcript, the output in the requested language. They
   are a **release gate and a model-change gate** (a `BEDROCK_MODEL_ID` change needs a green
   run recorded in the PR) and run nightly with a dedicated key on synthetic content only.

## Failure shape

**Untrusted text being treated as instructions by a model, and model output being treated as
trusted structure.** The first: content that a third party controls (a speaker, a code diff, a
client brief) is placed where the model reads it as a command, changing what is produced. The
second: the model's reply is rendered or acted on with the authority of the application, so
invented headings, links, citations or claimed facts reach a reader looking like the app's own.
Both are the old "data crosses into code" mistake, once going in and once coming out.

Mirror positions. **Input vs output:** escape and delimit what goes in (point 2), constrain
and re-derive what comes out (point 3); defending only one side leaves the other open. **Shape
vs prose:** the application, not the model, owns structure (headings, order, count, citations),
and only prose is the model's. **Claim vs grounding:** an answer that cites nothing that
exists must degrade to "not in the meeting", never to a confident sentence. **Capability:** a
model with a tool list that reaches anything turns an injection into an action; here the only
tool is the schema. **Residual risk is real** (R14, a misleading summary paragraph): the
transcript stays one click away and the output is labelled. Recognise it in any future feature
that feeds user-controlled text (a PR, a brief, a retrospective) to a model.

## Alternatives considered

- **Keeping a forced `tool_choice` by pinning an older model that supports it** (added 2026-11-05).
  Rejected: it ties model choice to a mechanism; the pinned Claude Sonnet 5.5 on Vertex rejects a
  forced `tool_choice` and `thinking: disabled`, and the eval, not the mechanism, is the gate.
- **Free-text JSON parsed from a text reply.** Rejected: loses the schema channel, and a text
  answer then looks valid.
- **Feature-detecting forcing at runtime.** Rejected: two untested paths.
- **A corrective second turn quoting the invalid reply.** Rejected: feeds untrusted model output
  back into the request.
- **Counting the resample as a second AI request.** Rejected: it charges the user for the
  model's failure; the 30/h limit already bounds it at x2.
- **Free-form Markdown output.** Rejected: links and images are an exfiltration and phishing
  surface from injected text, and headings the model invents break the template's shape.
- **Retrieval over a vector store (embeddings).** Rejected on three grounds: it adds a
  processor and a second copy of the content (residency and deletion get harder, against
  ADR-0061 and AC-4.6); it answers "what were the action items" worse than reading the whole
  meeting; and it buys nothing at this size.

## Consequences

**Positive:**
- A hostile transcript can change prose but not shape, add a link, cite what is not there, or
  trigger an action.
- No second store of meeting content; deletion stays one transactional cascade plus a bucket
  prefix.
- A reusable pattern for ReviewAI and ProposAI.

**Negative / trade-offs:**
- Whole-record context costs tokens on every request (about 50 k for 3 h); the 30/h rate limit
  and the content-free `ai_request` rows bound and measure it (R8).
- Plain text only: no rich formatting in summaries.
- The context window caps the supported record size (3 h of speech, 200,000 characters of
  text); a larger input would need chunking and a new ADR.
- Evals need a dedicated key and a nightly CI job.

**Risks:**
- A model change shifts behaviour: gated by the eval run.
- Prompt-injection evals are finite; residual injection remains possible (R14).

## Follow-up notes

- **2026-11-05 (amendment, plan #2 H-8, D4):** point 3 now reads as above. Why forcing was dropped: the real-provider spike showed Claude Sonnet 5.5 on Vertex refuses a forced `tool_choice` and `thinking: disabled`, so a design that relied on forcing could not run. Failure shape unchanged and sharpened: *model output is never trusted structure* now holds with no provider help, because the application checks the shape itself; the same posture applies to every future model or provider. An explicit `auto` + `disable_parallel_tool_use` may be adopted only after the pinned model is recorded accepting it. The evals gain the unforced reply channels (plain-text reply, double call, other tool) and an availability tier: up to 2 of ~55 fixtures may end `invalid_output` after the resample, zero tolerance on safety findings, and no `max_tokens` stop. The adapter logs a closed reason for each rejected reply (`no_call`, `multiple_calls`, `wrong_tool`, `stop_reason`, `block_type`), never content.
- **2026-11-05 (ADR-0069):** the model runs on Vertex AI, so the model-change gate's variable is `MEETINGS_VERTEX_MODEL_ID` (was `BEDROCK_MODEL_ID`) and the live eval runs on Vertex, authenticated through Workload Identity Federation with a separate Vertex-only service account. The request carries exactly one tool (offered, since the 2026-11-05 amendment, not forced) and no server tools, `cache_control` or betas, asserted by a unit test. Prompts, validators and the eval fixtures are unchanged.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
