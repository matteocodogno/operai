---
"@operai/meetings-api": minor
"@operai/meetings-ui": minor
"@operai/auth": minor
"@operai/shell": minor
---

Add Meetings (specs/021-meetings, ADR-0058 to ADR-0068): record, transcribe, summarise and question meetings from anywhere in Operai. New services `meetings-api` and `meetings-ui`.
- **Capture:** record in the browser (microphone, plus the audio of a shared tab where the browser allows it), upload a recording, or paste text. The person who records attests consent, and that attestation is stored on the meeting.
- **Transcripts and summaries:** meetings are transcribed in Italian or English, summarised from shared or personal templates, and can be questioned one at a time, with answers citing transcript passages. Questions and answers are private to the asker. Audio is kept for 30 days; transcripts and summaries live until the meeting is deleted. AI providers run in the EU with zero retention.
- **Visibility:** a meeting is visible to its creator and its Operai participants. The creator can optionally open it to everyone who can open the host record. A meeting whose creator is deactivated is frozen, not orphaned.
- **auth:** new `meetings` catalog (`meetings:access`, `template:manage`, `meeting:erase`). `employee` now holds `meetings:access` by default, the first default grant on that role, and `admin` holds the other two. `meetings:access` also opens the user directory for the participant picker (ADR-0066). New service client `meetings-api` and scope `host-notices.send`.
- **shell:** the gated tool at `/meetings` and the ungated "My meetings" page at `/my-meetings`, so a participant without tool access can still read what was captured about them. Adds the host-extension seam that lets another remote embed a Meetings panel, and the meetings-api origin for the session.
- **Operators:** `meetings-api` needs its own database, an EU bucket for audio and the env contract in `tools/env-doctor`.
