# 0065 — System notifications carry an optional Italian variant, chosen by the reader's interface language

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0017](0017-system-notifications-cross-user-trigger.md), [ADR-0049](0049-all-notify-callers-scoped-credentials-shared-token-retired.md), [ADR-0056](0056-notify-api-resolves-email-notice-address-from-auth.md), [ADR-0009](0009-notification-center-standalone-service-shell-seam.md), [ADR-0008](0008-sse-stream-auth-short-lived-ticket.md)

---

## Context

Meetings notifies in-app (AC-12.1/12.2/7.6): an Operai participant added by someone else, a
finished or failed transcription, a finished or failed summary. The spec requires the text in
the reader's language, English or Italian (AC-12.5). Every existing notification is
English-only. The suite has **no per-user language on the server**: the shell takes the
language from the browser and sets `<html lang>` once at startup. A system caller that pushes
to a recipient (ADR-0017) cannot know which language that recipient reads.

## Decision

1. **`POST /system/notifications` gains an optional `it: { title ≤ 200, body ≤ 2000 }`**
   (same limits as the English fields, plain text, no HTML). notify-api stores it as nullable
   `titleIt`/`bodyIt` (additive migration) and **returns it from the list endpoint and in the
   SSE payload** as `it: { title, body } | null` in `NotificationSchema`.
2. **The reader picks the variant, not the sender.** notify-ui and the shell's `ToastHost`
   choose `it` when `<html lang>` is `it` and `it` is present, and fall back to `title`/`body`
   otherwise. A notification without `it` renders exactly as today.
3. **notify-api's `ORIGIN_APPS` gains `meetings`**, binding `system:meetings-api → ["meetings"]`
   (ADR-0049's per-client origin binding). meetings-api's service client holds
   `notifications.push` and `host-notices.send` only, never `emails.send`; the client never
   sets `email: true` (AC-12.4).
4. **Content is built from a catalog and the meeting title only** (en + it parity tested). A
   notification carries the title, the outcome and a fixed sentence that the meeting was
   recorded or transcribed with AI; never transcript, summary or answer text. Link
   `/my-meetings/m/<id>`.
5. Existing callers keep sending English only; adding `it` is opt-in per caller.

## Failure shape

**Text composed for a reader by a layer that does not know the reader's language, and a new
field added on the write path that some read path then drops.** The first: a sender guesses a
language (usually its own), so a recipient gets a message they cannot act on, and a compliance
sentence ("recorded with AI") may be exactly the one they miss. The second: a field stored but
not returned by one of the several surfaces that render the same entity.

Mirror positions. **Write vs read:** the field must be accepted (`/system/notifications`),
stored, returned by the list **and** carried by the live SSE payload, and used by every
renderer (list item, toast, any future badge or email). **Sender vs recipient:** the rule is
that the choice happens where the reader's language is known. **In-app vs email:** ADR-0056's
notice is a generic English template, so an `email: true` path would reintroduce the same
language mismatch; meetings does not use it. **Optional vs required:** a missing variant must
degrade to the default, not to blank. Recognise it in any future message that crosses a
service boundary before reaching a person: where is the reader's language known, and does
every surface that shows the message read it from there?

## Alternatives considered

- **English-only.** Rejected: fails AC-12.5.
- **A per-user language stored in `auth`.** Rejected: a new profile attribute and a migration
  for every user, for one feature; the browser-derived language is already the suite's source.
- **Message keys rendered by notify-ui.** Rejected: it couples notify-ui to every tool's copy
  and releases (a tool's wording would change on notify-ui's deploy).

## Consequences

**Positive:**
- A participant sees the AI-recording sentence in their own language, in the list and the
  toast.
- Other tools can add Italian copy later by sending `it`, with no further contract change.

**Negative / trade-offs:**
- notify-api, notify-ui and the shell (`ToastHost`) change for a Meetings need.
- Senders must produce both texts; a language the suite adds later needs another variant (this
  design is bilingual by field, not general). A third language would need a new ADR.
- The language choice at read time is the current `<html lang>`, so a notification can render
  differently after the reader switches language, by design.

**Risks:**
- Stored `it` text with a stale or missing translation falls back to English silently;
  parity is tested in the sender's catalog (AC-12.5).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
