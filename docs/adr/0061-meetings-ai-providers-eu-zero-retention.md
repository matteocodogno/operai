# 0061 — Meetings AI processing: Azure AI Speech fast transcription (EU) and Claude on Amazon Bedrock (EU) with zero retention, enforced at startup

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04, D-5). Provider contract sign-off remains open (spec O3, accepted as a tracked risk).
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0016](0016-eu-object-storage-refund-attachments.md), [ADR-0032](0032-google-places-browser-direct-referrer-restricted-key.md), [ADR-0067](0067-ai-output-structured-validated-plain-text.md), [ADR-0063](0063-audio-retention-bucket-lifecycle-verified-at-startup.md)

---

## Context

Meetings sends people's voices and the text of their conversations to third-party processors.
The spec makes processing in the EU or Switzerland, contractual no-retention and no-training a
hard constraint (US-4, AC-4.9), with diarization and Italian and English support (US-13).
wellD's clients are in regulated sectors. Residency can change without a change in our
repository: a provider moves a feature, a model starts requiring retention, an inference
profile routes to another region. Vendor facts below were read from the vendors' own
documentation on 2026-11-04 (plan.md § AI providers carries the sources).

## Decision

1. **Transcription:** Azure AI Speech **fast transcription**, region `westeurope` (nearest to
   Railway Amsterdam). One locale per meeting (`it-IT` or `en-US`, never auto-detect, AC-13.2),
   diarization on with `maxSpeakers = clamp(participants + 1, 2, 35)`. Microsoft documents
   that fast transcription does not retain or store the data. Switzerland North is not
   available for fast transcription (batch only).
2. **Language model:** **Claude on Amazon Bedrock, EU**, with the account/region
   `data_retention_mode: none` and a **model id pinned in env** (`BEDROCK_MODEL_ID`). Region is
   `eu-central-2` (Zurich) in-region when the pinned model is on-demand there, otherwise the EU
   geographic inference profile. A model that requires retention (for example Claude Fable
   5/5.1 need `aws_review`, up to 30 days) is excluded.
3. **Residency is enforced at startup, not trusted from config** (`src/lib/residency.ts`;
   exit 1 on any failure): `MEETINGS_S3_*` EU residency (the existing `checkEuResidency`);
   `AZURE_SPEECH_REGION` in the EU/CH allowlist and matching the endpoint host; `BEDROCK_REGION`
   in `{eu-central-1, eu-central-2, eu-west-1, eu-west-3, eu-north-1, eu-south-1, eu-south-2}`
   (London is not EU); when `BEDROCK_MODEL_ID` is an inference profile, `GetInferenceProfile`
   is called and **every destination Region must be in that allowlist**; Bedrock's retention
   configuration (a per-Region setting that does not propagate) must read `none` in `BEDROCK_REGION`
   and in **every** destination Region of the profile, and **if it cannot be read in any of them,
   start is refused**; a
   fake provider is accepted only when `NODE_ENV !== "production"`.
4. **Two interfaces, one real implementation each plus a fake:**
   `Transcriber.transcribe(audio, locale, maxSpeakers)` and `LanguageModel.complete(request,
   outputSchema)`. Fallbacks live behind the same interfaces: Mistral Voxtral for transcription
   (only once ZDR is on and the subprocessor list is checked) and Azure OpenAI with modified
   abuse monitoring for the model (only after approval).
5. **Changing `BEDROCK_MODEL_ID` requires a green eval run** recorded in the PR (ADR-0067).
6. **Open for the data-protection lead (O3), before production data:** the controller entity,
   the Microsoft and AWS DPAs and whether the product-terms statements count as the
   *contractual* no-retention the spec requires, a transfer-impact note for US-parented
   processors operating in EU regions, and the Mistral subprocessor list if that fallback is
   ever used.

## Failure shape

**Personal data leaving the permitted jurisdiction or being retained by a processor, through a
change nobody made in our code.** Residency and retention are properties of the vendor's
configuration, region routing and model terms, so a deploy, a model swap or an upstream policy
change can silently move or keep data while every test stays green. The mistake is treating
"we set the region" as a fact about where the bytes go.

Mirror positions. **Every hop, not only the AI ones:** object storage, transcription, the
language model, and any future embeddings, OCR or translation step are separate residency
decisions; the object bucket (ADR-0016) and the lifecycle (ADR-0063) are the same class.
**Input and output:** a processor that only returns data can still retain what it was sent.
**Primary and fallback:** a fallback provider is a new residency and retention decision, not a
config switch. **Production and non-production:** a fake or test provider reachable in
production is the same hazard reversed (no processing at all, silently). Recognise it whenever
a feature adds a third-party call carrying user content: check where the vendor documents it
processes and what it keeps, verify rather than assume, and make the process refuse to start
when the live configuration disagrees.

## Alternatives considered

- **Anthropic first-party API.** Rejected, verified rather than assumed: `inference_geo` is
  only `"global"` or `"us"` and workspace geo only `"us"`; no EU geography.
- **Azure OpenAI (DataZone EU or regional Standard)** as primary. Rejected as primary: abuse
  monitoring may store flagged prompts for human review unless the customer is approved for
  modified abuse monitoring. Kept as the model fallback after approval; it would keep a
  single vendor if the AWS DPA is refused.
- **Mistral Voxtral Mini Transcribe V2 as primary.** Rejected as primary: data is "temporarily
  transferred outside the EU" to listed subprocessors depending on the feature; ZDR is
  available only with pay-as-you-go and stateless calls and needs a training opt-out.
  Fallback once ZDR is on.
- **AWS Transcribe (eu-central-1/2).** Rejected: more moving parts, and AI-services content may
  be used to improve the service unless an Organizations opt-out policy is set; input is staged
  in S3.
- **Self-hosted Whisper + pyannote on Railway.** Rejected: needs GPUs our Railway setup does
  not have; CPU is far slower than real time for 3 h.
- **Trust configuration without startup verification.** Rejected: see Failure shape.

## Consequences

**Positive:**
- A misrouted or retention-requiring configuration cannot serve traffic: the process exits.
- The pinned model plus the eval gate make a model change a deliberate, tested event.
- Provider swaps do not touch route code.

**Negative / trade-offs:**
- Startup depends on AWS control-plane reads (`GetInferenceProfile`, retention config) with
  least-privilege IAM; an AWS control-plane outage can block a deploy or restart.
- Two cloud vendors (Microsoft, AWS) for one feature, with two DPAs.
- The zero-retention guarantee is only as strong as AWS's documented behaviour for the retention flag; the startup check verifies the setting, not the behaviour.

**Risks:**
- R1: a provider changes terms or the model starts requiring retention. Mitigation: startup
  refusal, pinned id, evals, fallbacks, DPA review before go-live.
- R2: fast transcription of a 3 h file may exceed the target or time out. Week-1 spike;
  fallback Azure batch transcription in the same region.
- R13: the EU inference profile routing outside the allowlist; mitigated by the destination
  check and a preference for in-region `eu-central-2`.

## Compliance notes

- GDPR / nFADP: voice and conversation data processed by Microsoft and AWS as processors; the
  DPAs, controller entity and transfer assessment are open (O3) and gate production data.
- Data residency: compliant by construction at startup; unverified by a human until O3.
- Audit trail: logs hold identifiers and sizes only (AC-4.10).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
