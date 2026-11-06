---
"@operai/meetings-api": minor
"@operai/meetings-ui": patch
---

Meetings moves its AI providers to Google Cloud, EU only (specs/021 amendment 2026-11-05, ADR-0069). Transcription is Cloud Speech-to-Text v2 Chirp 3 batch through a transient EU bucket, and summaries and Q&A are Claude on Vertex AI in the EU, replacing Azure Speech and Bedrock. Transcripts now keep their parts (with per-part speakers) and the transcript endpoint returns them. The consent notice moves to version 2026-11-05 and discloses transcript retention. Deleting a meeting or its recording also empties the transient transcription prefix first.
- **Operators:** meetings-api needs the Google project, location and a Workload Identity Federation credential file, plus the transient bucket (`infra/meetings-gcs-transient-policy.sh --check`). It refuses to start when a startup check fails (wrong region, bucket lifecycle, soft delete, retention or caching settings). The Azure and Bedrock variables are gone; `tools/env-doctor` (not a versioned package) carries the new contract.
- **meetings-ui:** shows transcript parts and the updated consent text.
