# 0069 — Meetings AI processing on Google Cloud: Chirp 3 batch through a transient EU bucket and Claude on Vertex AI (EU); verify at startup what Google exposes, sign off what it does not

**Date:** 2026-11-05
**Status:** Accepted (specs/021-meetings; plan amendment "provider change: Google Cloud" approved by the user on 2026-11-05). **Supersedes the provider choice of [ADR-0061](0061-meetings-ai-providers-eu-zero-retention.md)** (its decision points 1, 2, 4 and 5 and the provider-specific parts of 3 and 6); ADR-0061's principle and failure shape stay in force. Go-live is gated on the sign-offs H1-H6 below and on spike T107.
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0061](0061-meetings-ai-providers-eu-zero-retention.md), [ADR-0063](0063-audio-retention-bucket-lifecycle-verified-at-startup.md), [ADR-0064](0064-meetings-api-reads-audio-bytes-third-reader.md), [ADR-0062](0062-durable-job-runner-work-queued-state-derived.md), [ADR-0067](0067-ai-output-structured-validated-plain-text.md), [ADR-0070](0070-meetings-transcript-parts-speaker-labels-per-part.md), [ADR-0016](0016-eu-object-storage-refund-attachments.md)

---

## Context

On 2026-11-05 the user decided to run both AI steps of Meetings under one Google Cloud contract
instead of Azure AI Speech plus Amazon Bedrock (two vendors, two DPAs; no contract had been signed
and nothing was provisioned). The spec is provider-neutral (EU or Switzerland, no retention, no
training, AC-4.9 startup refusal, diarization, Italian and English), so no AC changes. Three facts
read from Google's documentation on 2026-11-05 shape the design. Chirp 3 does diarization only in
`Recognize` (at most 1 minute or 10 MB per request) and `BatchRecognize`, and `BatchRecognize` takes
audio only as a `gs://` URI, so a 3 h meeting needs its audio in a Cloud Storage bucket while it is
transcribed. Google's async endpoint stores "the resulting transcript ... for approximately 5 days"
and does not document whether that applies when output goes to our own bucket. Several data-handling
settings (Speech data logging, the contract type, Advanced AI consent) cannot be read through any API.

## Decision

We will transcribe with **Cloud Speech-to-Text v2, model Chirp 3, `BatchRecognize` in location `eu`**
(one file per request, one locale, diarization on, output written to our own bucket, never inline) and
generate summaries and Q&A with **Claude on Vertex AI through the `eu` multi-region endpoint** (never
`global`), forced single tool use, no prompt caching, no server tools, model pinned in
`MEETINGS_VERTEX_MODEL_ID` and Claude Fable/Mythos excluded. Audio reaches Google only through a
**transient EU Cloud Storage bucket** (per-attempt prefix `transcribe/<meetingId>/<attempt>/`, deleted at attempt
start and in `finally`, and before any database change on "Delete recording"/"Delete meeting", with a
503 and nothing changed on failure), reached only through its regional endpoint
`storage.<location>.rep.googleapis.com`; the Railway bucket stays the only place audio is *kept*
(ADR-0063). Every setting Google exposes through an API is **read at startup, and unreadable, absent
or wrong means exit 1**; every setting it does not expose is a **recorded go-live sign-off** with an
owner and a date, re-attested quarterly and on any change to the project.

**Accepted exception, decided by the user on 2026-11-05:** Google may keep the async transcript
result for about 5 days. The spec Constraint "must contractually not retain submitted content beyond
the request" is amended accordingly: Google keeps no input audio, and keeps a transcript copy for a
bounded period that is documented and signed off. Mitigations kept in code: output goes to our bucket
instead of inline, `operations.delete` is called after reading, and sign-off H4 asks Google for
written confirmation of the actual behaviour with Cloud Storage output (it may be shorter or none).
This is a bounded, recorded exception, not a change of principle: a retention that is documented,
bounded and accepted by a named decision is different from one nobody noticed.

### What is verified at startup (exit 1; messages name the check, never a value)

| # | Check |
|---|---|
| S1 | Speech location is `eu` (Chirp 3 is GA in `eu` and `us` only) |
| S2 | Vertex location in `{eu, europe-west1, europe-west4}`; `global`, `us` and anything else refused |
| S3 | `MEETINGS_VERTEX_MODEL_ID` matches `^claude-[a-z0-9.@-]+$` and contains neither `fable` nor `mythos` |
| S4 | The service-account key decodes, is a `service_account` and its `project_id` equals `MEETINGS_GCP_PROJECT_ID` |
| S5 | `ANTHROPIC_VERTEX_BASE_URL` is not set (an ambient override is refused) |
| S6 | `MEETINGS_AI_PROVIDER=fake` refused in production |
| N1 | Railway audio bucket: 29-day rule, versioning (unchanged, ADR-0063) |
| N2 | Transient bucket: EU/CH location allowlist (London excluded), lifecycle `Delete` rule with `age <= 1` and no narrowing condition, versioning off, **soft delete retention 0** (GCS enables 7 days by default), no retention policy, no default event hold, uniform access, public access prevention enforced |
| N3 | Vertex data caching disabled for the project (`cacheConfig.disableCache: true`) |
| N4 | Vertex request-response logging not enabled for the exact location and model (404 = no config = passes; `enabled` or `enableOtelLogging` true, or any other error, refuses) |

### What is signed off, because no API exposes it (go-live; owner and date recorded in the infra README)

- **H1** Speech-to-Text data logging not enrolled (a console toggle the v2 API does not expose).
- **H2** Use is under the Google Cloud Master Agreement + CDPA, not the online Terms of Service (only then is abuse-monitoring prompt logging exempt), with written confirmation that it does not apply to Claude on Vertex.
- **H3** No consent to the Advanced AI Safety Addendum and no Advanced AI model enabled (per project; the runtime service account lacks the permission to give it).
- **H4** Google's written statement on the ~5-day transcript copy with Cloud Storage output (the accepted exception above); blocks go-live.
- **H5** Anthropic's Commercial Terms, accepted by enabling Claude in Model Garden, reviewed by the data-protection lead; Google states partner models do not receive prompts or responses.
- **H6** Cloud Audit Logs Data Access for `speech`, `aiplatform` and `storage` record no request payloads.

### Implementation constraints

REST through `fetch` for Speech and Cloud Storage (no gRPC client on Bun, no `@google-cloud/*`
packages: they hide the URL the residency check pins). `@anthropic-ai/vertex-sdk` for Vertex with
`baseURL` derived, `authClient` explicit and `maxRetries: 0`, so none of its environment defaults
apply. Runtime credentials: one least-privilege service account whose key is in
`MEETINGS_GCP_SERVICE_ACCOUNT_KEY` (Railway has no workload OIDC; escalation trigger: when it does,
move to Workload Identity Federation and delete the key); the live eval uses WIF with a separate
Vertex-only service account. Never Application Default Credentials.

## Failure shape

**Personal data leaving the permitted jurisdiction or being kept by a processor, through a change
nobody made in our code, where the only evidence is a setting we cannot read.** ADR-0061 named the
shape; this decision adds two refinements. First, a processor's *intermediate* storage (a staging
bucket, an operation store, a soft-delete window, a logging toggle) is a retention decision of its
own, and its default is often the long one: a bucket created with defaults keeps "deleted" audio for
a week. Second, some guarantees cannot be read at runtime at all; pretending a startup check covers
them is the same mistake as trusting configuration, so they must be named as sign-offs with an owner
rather than left implicit.

Mirror positions. **Input and output:** a hop that is emptied on the way in is not necessarily empty
on the way out (the transcript written back is content too). **Success and failure paths:** cleanup
that runs only on success leaves the crashed attempt's copy behind, so deletion happens at attempt
start, in `finally`, and on explicit user deletion. **Readable and unreadable controls:** each new
vendor setting is either verified at startup or listed as a sign-off, never neither. **Accepted and
unnoticed retention:** an exception is legitimate only when it is bounded, recorded and decided by a
named person; recognise the unrecorded kind wherever a processor documents "stored for N days".
Applies to any future hop that stages user content (OCR, translation, embeddings).

## Options considered

### Option A (chosen) - Chirp 3 BatchRecognize via a transient EU bucket + Claude on Vertex EU
One Google contract, diarization per file, everything Google exposes verified at startup.

**Pros:** one vendor and one DPA; usable diarization on long audio; resource-level residency checks possible; transcript output lands in a bucket we control.
**Cons:** a new storage hop with its own rules; Google keeps the async transcript about 5 days (accepted exception); some controls are sign-offs only; long audio is split into parts (ADR-0070); a service-account key on Railway.

### Option B - Keep Azure AI Speech + Amazon Bedrock (ADR-0061 as written)
**Pros:** already designed, with startup verification. **Cons:** two vendors and two DPAs; no contract would be signed. Rejected.

### Option C - Sync `Recognize` without a bucket
Inline audio in pieces of at most 60 s, processed in memory with nothing stored.

**Pros:** the cleanest retention story. **Cons:** no usable diarization (labels per minute, no continuity across about 180 pieces). **Named fallback**, a visible AC-6.2 regression needing a PO decision, if Google's answer to H4 proves unacceptable to the data-protection lead.

### Option D - `StreamingRecognize`
Rejected: diarization is not supported for Chirp 3, and audio must be sent at about real time (3 h takes 3 h).

### Option E - BatchRecognize with inline output
Rejected: moves the transcript copy from a bucket we control into Google's operation store, which is exactly the ~5-day storage.

### Option F - Dynamic batching
Rejected: up to 24 h latency, which breaks the processing-time target.

### Option G - A presigned URL to the Railway bucket
Impossible: `BatchRecognize` accepts only `gs://` URIs.

### Option H - Vertex `global` endpoint, or `europe-west1` as default
Rejected: `global` gives no residency guarantee; current 4.7+ Claude models are not served in `europe-west1`.

### Option I - Claude Fable / Mythos
Rejected: designated "Advanced AI" with prompt and response logging for up to 30 days (the same exclusion ADR-0061 made for Bedrock `aws_review`).

### Option J - Gemini on Vertex for summaries; Vertex prompt caching
Rejected: not the user's decision, needs a new eval baseline, implicit caching is on by default; caching stores data and nothing at this size needs it.

### Option K - Workload Identity Federation for the runtime, Application Default Credentials, one key for runtime and CI, a Google API key
Rejected for the runtime: Railway publishes no workload OIDC (WIF is used for CI); ADC is ambient (ADR-0061's failure shape); one shared key widens a leak; an API key cannot call Vertex partner models or Speech batch.

### Option L - gRPC client libraries (`@google-cloud/speech`, `@google-cloud/storage`) on Bun
Rejected: unproven on Bun, large, and they hide the request URL that residency checks pin.

## Consequences

**Positive:**
- One contract and one DPA instead of two; Azure and Bedrock code, env and checks are removed.
- A misconfigured bucket (soft delete, versioning, wrong location) or a logging-enabled Vertex project cannot serve traffic.
- The transient hop is empty outside a running attempt: deleted at start, in `finally` and on user deletion.

**Negative / trade-offs:**
- Google holds a transcript copy for about 5 days (accepted); the spec Constraint is amended.
- Startup depends on Google control-plane reads (bucket metadata, `cacheConfig`, `fetchPublisherModelConfig`); an outage can block a deploy or restart (fail closed by design, `maxAttempts` 2 per read).
- H1-H6 are human attestations, only as strong as the quarterly re-attestation.
- Chirp 3 batch is guided to about 1 h per file, so recordings are split into parts (ADR-0070).
- A long-lived service-account key sits on Railway (least-privilege custom role, 90-day expiry, never logged, env-doctor secret).

**Risks:**
- R1: Google changes residency or retention terms, or redesignates a pinned model "Advanced AI". Mitigation: N2-N4, pinned and denylisted model id, per-project consent the runtime cannot give, quarterly re-attestation, green eval for any model change.
- R2: Chirp 3 batch slower than the target or diarizing differently from the docs. Mitigation: spike T107 before go-live (1 h and 3 h it/en, whole file vs parts, latency from Railway Amsterdam, `gcsOutputConfig` in `eu`).
- R17: the ~5-day transcript copy. Mitigation: output to our bucket, `operations.delete`, H4; fallback Option C.
- R18: a transient copy outliving a deletion (crashed attempt, late output write). Accepted residual: a running operation can write its output after a delete; it is removed by the attempt's `finally`, the next attempt's start, or the 1-day rule. The bound is the part's remaining time plus one day plus lifecycle lag, with identifier-only names.
- R13: traffic reaching a non-EU endpoint through SDK defaults or ADC. Mitigation: derived, test-asserted base URL, explicit credentials, S5, no `global`.
- R22: Anthropic's terms add a second contract relationship. Mitigation: DPL review (O3).

## Compliance notes

- GDPR / nFADP: voice and conversation data processed by Google Cloud (Speech-to-Text, Vertex AI, Cloud Storage) as processor under one contract (H2), plus Anthropic's terms for model use (H5); DPA/O3 sign-off before production data. Impact: high. Google may keep the async transcript about 5 days; accepted by the user on 2026-11-05 and recorded here and in the spec Constraint.
- Data residency: Speech `eu`, Vertex `eu` multi-region (EU member states; Switzerland and the UK excluded, within the spec), transient bucket in an EU/CH location reached through its regional endpoint. Compliant at startup, unverified by a human until H1-H6 are signed.
- Audit trail: logs hold identifiers and sizes only (AC-4.10); transient object names carry ids only.
- **2026-11-05 (ADR-0073, plan amendment #2):** each transcription try writes to its own output prefix (`transcribe/<id>/<attempt>/out/<k>-<t>/`) that is read and deleted at once, and a part's input copy is deleted when the part settles rather than at the end; the key and prefix patterns gain `out/<k>-<t>/`. Every retry leaves Google one more transcription result (retries are suspended by spec A8, tries = 1, ADR-0073) under the ~5-day bound; this is covered by the existing disclosure (no consent version bump) and added to sign-off H4's question. A process-wide `SPEECH_MAX_INFLIGHT` = 24 operations semaphore and polling at 30 s then every 15 s keep operation GETs and submits under quota. Residency, startup checks and the recorded exceptions are unchanged. Separately (ADR-0067 amendment): the model is offered one tool unforced, because the pinned model rejects a forced `tool_choice`.


---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
