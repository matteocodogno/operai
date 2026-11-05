# 0064 — meetings-api reads audio bytes to normalise them: the bounded-read rule, third caller (ADR-0057's escalation trigger)

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04, D-7)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0057](0057-crm-api-reads-attachment-bytes-for-offer-annexes.md), [ADR-0043](0043-request-archive-export-refund-api-reads-attachment-bytes.md), [ADR-0016](0016-eu-object-storage-refund-attachments.md), [ADR-0019](0019-refund-batch-pdf-generation-pdf-lib.md), [ADR-0062](0062-durable-job-runner-work-queued-state-derived.md), [ADR-0061](0061-meetings-ai-providers-eu-zero-retention.md)

---

## Context

ADR-0016 says no service proxies file bytes. ADR-0043 allowed refund-api to read attachment
bytes to compose a derived document it authors itself, and asked for a revisit at a second
reader. ADR-0057 was that revisit (crm-api) and named its own trigger: **a THIRD service
reading object bytes**, a file the user did not choose, more than 25 MiB in one request, or an
object that is not a PDF. meetings-api trips it on all counts except "a file the user did not
choose".

To transcribe, meetings-api must turn what the browser produced (WebM/Opus or MP4 chunks, or an
uploaded audio *or video* file of up to 500 MiB) into one mono 16 kHz Opus file (AC-3.1:
video never leaves this step). That needs the bytes in our process and a media parser, ffmpeg,
on user-supplied files.

## Decision

1. **meetings-api may read object bytes in exactly one place: the `prepare_audio` job and the
   upload `confirm` probe**, both while it authors a derived document (`audio.ogg`) from a
   recording the creator made or uploaded. Proxying a file a client asked for stays forbidden;
   playback is a presigned GET (15 min, minted only after the visibility check).
2. **Bounds, enforced before and during the read:**
   - an uploaded original is at most 500 MiB (presigned POST policy, re-checked from a HEAD at
     confirm), and is streamed **to disk in a per-job temp dir, never into memory**;
   - chunks are at most 8 MiB each and at most 3 h at 32 kbit/s in total; `audio.ogg` is at
     most ≈ 45 MB;
   - the temp dir is removed in `finally`.
3. **`ffprobe` runs synchronously at upload confirm** (≤ 30 s, over a 60 s presigned GET with
   `-protocol_whitelist https,tls,tcp`), and must show: a demuxer on the allowlist
   (mov/mp4/m4a, matroska/webm, ogg, wav, mp3, aac, flac), an audio stream, and a duration
   ≤ 3 h. A failure deletes the object and leaves the meeting `draft` with 422 `upload_rejected
   { reason }`.
4. **`ffmpeg` hardening:** `ffmpeg -protocol_whitelist file,pipe -i in -vn -sn -dn -ac 1 -ar
   16000 -c:a libopus -b:a 32k audio.ogg`; the process runs non-root with a 20-minute timeout;
   the Debian package is pinned in the Dockerfile and patched on a stated cadence; one ffmpeg
   job at a time per process (ADR-0062). After success the chunks or the original are
   deleted.
5. **Only validated objects are read:** keys are fixed server-side under `meetings/<id>/`
   (`chunks/<seq>`, `upload/<uuid>`), never client-supplied.
6. **Nothing is stored beyond the audio and its derived text.** Video bytes are never retained.
7. **Escalation trigger:** a FOURTH service reading object bytes, a read of a file the user did
   not choose, a read into memory of more than a bounded amount, or a new media type beyond the
   allowlist. Revisit this ADR rather than extending it quietly.

## Failure shape

**A service pulling user-supplied bytes through its own process for a narrow reason and the
reason quietly widening, so that the process inherits unbounded memory or disk use and the
attack surface of whatever parses the bytes.** The mistake is not "reading a file"; it is
reading a *hostile, user-chosen* file with a rich parser (a media demuxer that can follow
playlists and URLs is also a network client) with no ceiling on size, no allowlist on type and
no isolation of the work.

Mirror positions. **Read vs write:** a service that composes a document may also *write*
user-supplied bytes into one; the same ceiling, allowlist and fail-the-whole-operation rule
apply. **Server-side fetch vs client-supplied reference:** a parser given a URL or a playlist
(SSRF) is the same hazard as one given a path; hence the protocol whitelist and demuxer
allowlist. **Trusted vs derived input:** chunks the browser recorded are as untrusted as an
upload. **Success vs partial:** an unreadable file fails the whole step; no placeholder.
Recognise it whenever a service starts to open files users sent it: ask who chose the bytes,
how big they can be, what parses them, what that parser can reach, and what happens to the
temp copy on failure.

## Alternatives considered

- **Client-side `ffmpeg.wasm`.** Rejected: about 500 MiB in tab memory, slow, no help for
  recordings, and the server could no longer stand behind what it stores.
- **A third-party media service.** Rejected: one more processor of personal data (residency
  and retention review, ADR-0061) for a few minutes of CPU.
- **Send raw uploads to the transcriber.** Rejected: video bytes would leave our boundary, and
  the transcriber's size limits would apply to video.
- **Do not revisit; treat as ADR-0057's case.** Rejected: ADR-0057 asked for exactly this
  revisit at the third reader.

## Consequences

**Positive:**
- One bounded-read rule, now stated for three services; video never leaves the normalisation
  step.
- Memory is bounded by streaming to disk; disk by the 500 MiB policy and per-job cleanup.

**Negative / trade-offs:**
- meetings-api carries ffmpeg/ffprobe in its image and takes on their patch cadence.
- Hostile media is parsed on our infrastructure (R15, a security review item): mitigated, not
  eliminated, by allowlist, protocol whitelist, non-root, timeouts and temp dirs.
- Concurrent uploads fill the temp disk; ffmpeg jobs are limited to one per process.

**Risks:**
- A CVE in ffmpeg. Mitigation: pinned package, patch cadence, non-root, no network protocols
  beyond the whitelist.
- Browser chunk streams vary (Safari fMP4, MediaRecorder timestamps after pause, R4):
  fixtures from Chrome, Firefox and Safari are part of the test suite.

## Amended 2026-11-05 (security review)

The OWASP review found point 3 wrong, and the fix (commits 5578708 and 4d94790 on
`feat/021-meetings`) changed the design. Status stays Accepted.

- **Wrong:** point 3 said the confirm-time probe ran with `-protocol_whitelist https,tls,tcp`
  and implied that a playlist could not send ffprobe elsewhere. A protocol (scheme) list does
  not bound hosts or ports, so an `https` playlist could still make ffprobe fetch from any
  host.
- **Now:** the demuxer allowlist, audio-stream and duration checks are authoritative **only on
  the local file inside `prepare_audio`**, run with `-protocol_whitelist file`, and the decode
  pins `-f` to the demuxer that probe found. The confirm-time probe over the presigned URL is
  an **early reject only**: its input format is pinned from the declared content type, so
  hls, concat and dash can never be selected over the network, and nothing it concludes is
  trusted by the decode.
- **Point 4 additionally:** the child process runs with a minimal environment (`PATH`,
  `TMPDIR` only), and the byte ceilings are enforced on **bytes actually written**, summed
  across the run, not on DB-recorded sizes.
- **Point 5, keys:** the upload key is no longer a fixed `meetings/<id>/original`. Each mint
  gets a unique `meetings/<id>/upload/<uuid>`, stored in `meeting_upload.object_key`, because
  S3 POST policies are not single-use; other objects under the upload prefix are deleted. Keys
  remain server-side, never client-supplied.

**Round 2 (same review, later commits: cap decoded output, media inputs restricted to
allowlisted demuxers, confirm only the upload key it probed).**

- **Point 4, the documented command becomes:** `ffmpeg -protocol_whitelist file,pipe
  -format_whitelist mov,mp4,m4a,matroska,webm,ogg,wav,mp3,aac,flac [-f <demuxer>] -i in -vn
  -sn -dn -ac 1 -ar 16000 -c:a libopus -b:a 32k -t 10861 -fs 104857600 audio.ogg`. The output
  caps are `too_long` triggers: `-t 10861` s is the 3 h + 60 s bound plus 1 s, so an honest
  maximum-length file is distinguishable from a truncated one; `-fs` 100 MiB is about 2.3x the
  3 h Opus budget.
- **Point 3, the probe:** `-format_whitelist <allowlist>` applies to every input, local and
  URL. An UPLOADED file must state its duration: missing means `unsupported_type` at confirm
  and `audio_unreadable` in `prepare_audio`. Recording runs are exempt (MediaRecorder WebM has
  no header duration) and are bounded by the output caps and the 128 MiB input cap instead.
- **Confirm acts only on the key it probed:** it flips the meeting with a compare-and-set on
  `objectKey`; a mismatch (a newer mint superseded it) is 409 `upload_superseded`.

Failure-shape note: the lesson is that a parser given a URL must be bounded by what it can
*reach* (host and port), not by the scheme it speaks; the authoritative check belongs on the
local copy, where no network is reachable.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
