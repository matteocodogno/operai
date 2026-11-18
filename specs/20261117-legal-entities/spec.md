---
id: 20261117
slug: legal-entities
status: in-progress
approved: 2026-11-17
rigor: production
created: 2026-11-17
---

# Legal entities — one registry of the group's companies, for every tool

> **Origin.** Found while trying the letterhead service (specs/20261116-letterhead-service): the placeholders
> `{legal_name}`, `{address}`, `{vat}`, `{iban}` and `{contacts}` are filled from the CRM's entity profile, so a
> tool that wants the letterhead has to go through the CRM, and `{contacts}` is never filled because no such value
> exists anywhere. The owner (wellD) decided on 2026-11-17 that these values belong to a registry of the whole
> group, not to the CRM. Their answers are marked *(owner)*. Choices made while writing, which the owner has not
> given, are marked *(owner, as proposed)* and each has an entry under Open questions.
>
> **Amendment of 2026-11-17 (US-9).** After the security review (security-review.md, finding F1) the owner decided
> to mitigate the risk of an unnoticed change of the details that identify the issuer and receive payments with a
> confirmation in admin-ui and a notification to the other people responsible. Those decisions, and the owner's
> answers of the same day to the questions that followed, are marked *(owner, 2026-11-17)* or *(owner, 2026-11-17,
> security review F1)*. Nothing in US-9 is left unconfirmed.
>
> **Amendment of 2026-11-18 (D9).** After the security re-review (security-review-2.md, finding N1; qe-report.md,
> O-1) the owner decided that a notice identifies the person who made the change by the email address of their
> account, not by their display name, which any signed-in person can edit. It is marked *(amendment D9, owner
> 2026-11-18, security re-review N1)*.

## Problem

The legal details of the two wellD companies (welld_it and welld_ch) — legal name, address, VAT number, IBAN — are
kept in the CRM's entity profile, the only place they exist. Every document that names its issuer needs them: today
the CRM's offers, tomorrow refunds, inventory or any tool that prints on the letterhead. Such a tool would have to
depend on the CRM, or keep its own copy that drifts from it. The letterhead also has a contacts line that nothing
can fill, so it prints nothing on real documents, and the details cannot differ between an Italian and an English
document (an address that reads "Svizzera" in one and "Switzerland" in the other). Changes to these values leave no
trace of who made them or what they were before.

## Vocabulary

- **Legal entity** *(owner)*: one of the group's companies, as a tool sees it: welld_it or welld_ch. The word is
  chosen so it is never confused with the CRM's **companies**, which are customers. In Italian: "Società del gruppo".
- **Registry**: the one place where the legal entities' details are kept and changed.
- **Details**: the values of one legal entity listed in AC-1.1.
- **Version**: the details of one legal entity as one save left them, numbered from 1 per entity.
- **Consumer**: a tool that reads the details to put them on a document (the letterhead service, the CRM).
- **Protected details** *(US-9, owner 2026-11-17)*: the legal name, the VAT number and the IBAN. The address and the
  contacts line are not protected.
- **Protected change** *(US-9)*: a save or a restore after which at least one protected detail, as it would be
  stored (for the IBAN as AC-1.4 stores it: upper case, no spaces), differs from the same detail in the version
  before it. Filling an empty value and emptying a filled one count; a different spacing or case of the same IBAN
  does not. Version 1 made by the move of US-7 is not a protected change.
- **Notice** *(US-9)*: the message that tells a person a protected change has been stored (AC-9.7 to AC-9.13).
- **Author of a version** *(amendment D9, owner 2026-11-18, security re-review N1)*: the person who made the save or
  the restore that stored it. In a notice the author is identified by the email address of their account as it was
  when the version was stored (AC-9.11), and by nothing else: never by their display name, which the person can
  change themselves.

## User stories

### US-1: The details of each legal entity, in one place

As a person who manages a legal entity's administration, I want to keep its legal details in one place, in both
languages, so that every document of every tool names the company the same way.

**Acceptance criteria:**

- AC-1.1: Given the registry, then it holds exactly the two legal entities welld_it and welld_ch *(owner)*, each
  with these details:
  - legal name (one value);
  - address, in Italian and in English, each as one or more lines *(owner)*;
  - VAT number (one value);
  - IBAN (one value);
  - contacts line, in Italian and in English *(owner)* (for example "Tel. +41 91 … · info@welld.ch").
- AC-1.2: Given a save, when the legal name, the address in either language, or the VAT number is empty (or only
  blanks), then nothing is saved and the person is told which value is missing, next to it *(owner)*. The IBAN and
  the contacts line may be empty.
- AC-1.3: Given a save, when a value is longer than its limit, or holds a line break where one line is expected, or
  holds a control character, then nothing is saved and the person is told which value and why. Limits *(owner, as
  proposed)*: legal name 200 characters; address up to 4 lines of 120 characters per language; VAT number 40;
  IBAN 34 after removing spaces; contacts line 200 per language.
- AC-1.4: Given an IBAN typed with spaces or in lower case, when it is saved, then it is stored in upper case
  without spaces; given an IBAN whose check digits are wrong, then it is refused *(owner, as proposed)*.
- AC-1.5: Given a person who may manage a legal entity (US-4), when they save its details, then the new details
  are what every consumer reads from then on (US-3), within the freshness of AC-3.3.

### US-2: What changed, and going back

As a person who manages a legal entity, I want to see every earlier version of its details, who saved each and
when, and to bring an earlier one back, so that a mistake is found and undone without retyping.

**Acceptance criteria:**

- AC-2.1: Given a save that changes at least one value, then it creates a new version of that entity with the
  next number, the person who saved it and the time *(owner)*. A save that changes nothing creates no version.
- AC-2.2: Given the history of an entity, then it lists every version, newest first, each with its number, who
  saved it, when, and which values it changed compared with the version before it.
- AC-2.3: Given a version in the history, when the person opens it, then they see all its details, read-only.
- AC-2.4: Given an older version, when a person who may manage the entity restores it, then a new version is
  created whose details equal that version's (the versions in between stay in the history); restoring the current
  version is not offered. A restore is refused, as a save would be (AC-1.2–1.4), when that version's details are
  not complete or valid *(amendment D4, owner 2026-11-17)*.
- AC-2.5: Given any save or restore, then an entry is written to the administration audit log with who, when,
  which entity, and each changed value before and after *(owner)*.
- AC-2.6: Given two people editing the same entity, when the second saves on a version that is no longer the
  current one, then nothing is saved and they are told a newer version exists, keeping what they typed.
- AC-2.7: Versions are never deleted or changed.

### US-3: Every tool reads the same details

As a tool of the suite, I want to read the details of a legal entity without going through another tool, so that
any document I make names its issuer correctly.

**Acceptance criteria:**

- AC-3.1: Given any signed-in person, when they ask for the list of legal entities or for one of them, then they
  get the current details of each (or of that one), whatever their role *(owner)*. A request that is not signed in
  is refused.
- AC-3.2: Given a tool of the suite authenticated as a service with the right to read legal entities, when it asks
  for them, then it gets the same answer as AC-3.1. A service without that right is refused.
- AC-3.3: Given a change saved at time T, then every consumer uses the new details for any document it starts
  making later than T + 60 seconds *(owner, as proposed)*.
- AC-3.4: Given an unknown entity name, then the answer says it is unknown, and nothing else.

### US-4: Who may change what

As an administrator, I want to grant the right to manage a legal entity's details per entity, so that the Swiss
administration changes welld_ch and not welld_it.

**Acceptance criteria:**

- AC-4.1: Given the permission catalog, then it has a permission to manage legal entities that can be limited to
  one or both entities, granted through roles like every other permission *(owner)*. Limited means the entity the
  person belongs to; a grant cannot name another entity than theirs *(amendment D6, owner 2026-11-17)*.
- AC-4.2: Given a person without that permission for an entity, when they try to save or restore its details,
  then they are refused and nothing changes; they can still read it (AC-3.1).
- AC-4.3: Given a person who holds the permission for at least one entity, then the administration area shows
  them the Legal entities page, with the entities they may change editable and the others read-only. A person who
  holds it for none does not see the page *(owner, as proposed)*.

### US-5: The letterhead prints the registry's details

As a person who designs a letterhead, I want its placeholders filled from the registry, in the document's language,
and to see the real details in the preview, so that what I see is what every tool will print.

**Acceptance criteria:**

- AC-5.1: Given a document rendered by the letterhead service for an entity, in a language, then `{legal_name}`,
  `{address}`, `{vat}`, `{iban}` and `{contacts}` print that entity's current details from the registry, the
  address and the contacts line in the document's language. `{address}` keeps today's form (the lines joined by a
  comma). The IBAN prints in groups of four characters (for example CH93 0076 2011 6238 5295 7) *(amendment D2,
  owner 2026-11-17)*.
- AC-5.2: Given a tool that asks for a document, then it no longer sends the issuer's details; any such details a
  tool still sends have no effect on what is printed *(owner, as proposed)*.
- AC-5.3: Given an empty IBAN or contacts line, then the placeholder prints nothing, and a conditional segment
  around it is dropped, as today (specs/20261116-letterhead-service AC-6.6).
- AC-5.4: Given the configurator's preview, then the placeholders show the entity's real details from the
  registry, in the preview language *(owner)*; a value that is empty is shown in the "missing" style, so the
  person sees what is not filled in. The body of the sample document stays sample text.
- AC-5.5: Given the registry cannot be read and the service holds no details read within the freshness of AC-3.3,
  then the document is not made and the caller is told to try again later; a document is never printed with
  details missing because the registry could not be read *(owner, as proposed)*.

### US-6: The CRM uses the registry

As a salesperson, I want offers and contracts to name the issuer from the registry, so that the CRM never disagrees
with the other tools.

**Acceptance criteria:**

- AC-6.1: Given the CRM's entity settings, then they no longer hold the legal name, the address, the VAT number or
  the IBAN; they keep what is the CRM's own (the standard offer terms, the place of issue), and point to the Legal
  entities page for the rest: a link for those who may manage an entity; for the others, the name of the page and
  that an administrator keeps it *(amendment D5, owner 2026-11-17)*.
- AC-6.2: Given an offer or a contract made by the CRM, whether through the letterhead service or the classic
  path, then every place it printed the issuer's legal name, address, VAT number or IBAN prints the registry's
  current values, in the document's language where the registry has two; the IBAN prints as in AC-5.1 *(D2)*.
- AC-6.3: Given a legal entity whose required details (AC-1.2) are not all filled in, when an offer or a contract
  is generated for it, then it is refused with a message that names the missing details and where to fill them in
  (this replaces today's refusal for a missing legal name).
- AC-6.4: Given an offer generated before the change, then its stored document and its snapshot are unchanged.

### US-7: Nothing is lost when the details move

As the owner, I want the details already kept in the CRM to move into the registry, so that no one retypes them and
no document changes on the day of the release.

**Acceptance criteria:**

- AC-7.1: Given the CRM's entity profiles in an environment, when the release is applied there, then each legal
  entity's version 1 in the registry holds the profile's legal name, VAT number and IBAN, and its address lines in
  both languages; the contacts lines are empty.
- AC-7.2: Given the move, then version 1 is attributed to the system, and the audit log records it.
- AC-7.3: Given an entity whose CRM profile lacks a required detail (AC-1.2), or holds a value AC-1.3 or AC-1.4
  refuse *(amendment D3, owner 2026-11-17)*, then it is still moved as it is (the IBAN only loses its spaces and is
  upper-cased), and the Legal entities page marks it incomplete (a required detail is missing; AC-6.3 applies to it meanwhile)
  or in need of correction (only values AC-1.3 or AC-1.4 refuse; documents are not refused for them) until someone
  saves it correct *(amendment D8, owner 2026-11-17)*.
- AC-7.4: Given the move has run once, when it runs again, then it changes nothing.
- AC-7.5: Given the day of the release, then a document generated for an entity with complete details prints the
  same issuer details as the day before (apart from the contacts line, which is new); the IBAN prints as in AC-5.1,
  and the move reports any entity whose printed IBAN would differ, which the owner accepts before the release
  *(amendment D2, owner 2026-11-17)*.

### US-8: Accessible administration

- AC-8.1: Given the Legal entities page, its history and its forms, then they have no WCAG 2.1 AA violations found
  by the suite's automated check, every control has a visible label, refused values are announced and focus moves
  to the first one, and everything is usable with the keyboard alone.
- AC-8.2: Given the page, then all its words exist in Italian and English, following the person's language.

### US-9: A change of the legal name, VAT number or IBAN is confirmed first and told to the others *(owner, 2026-11-17, security review F1)*

As the owner, I want a change of a legal entity's legal name, VAT number or IBAN to be confirmed by the person
making it and to be told to the other people responsible for that entity, so that a wrong or unauthorised change is
stopped before it is stored, or noticed within minutes, and not after offers and contracts carrying it have been
issued (AC-3.3: within 60 seconds every consumer prints it, and what a document printed is never rewritten,
AC-6.4).

**Acceptance criteria:**

*The person confirms (admin-ui).*

- AC-9.1: Given the form of a legal entity and a person who may manage it, when they save and the save is a
  protected change compared with the version they are editing from, then before anything is stored the page shows
  one confirmation that *(owner, 2026-11-17)*:
  - names the legal entity;
  - lists each protected detail that changes (and only those), each with its old value (that of the version they are
    editing from) and its new value under separate visible labels ("Old", "New" in the person's language), so the
    two cannot be mixed up;
  - shows the legal name and the VAT number in full as they would be stored, and the IBAN in full in groups of four
    characters as in AC-5.1 (for example CH93 0076 2011 6238 5295 7);
  - shows an empty old or new value as the word for "none" in the person's language, not as a blank;
  - offers two actions, confirm and cancel, and when it opens the keyboard focus is on cancel.
- AC-9.2: Given the confirmation, when the person cancels it (the cancel action, or closing it with the Escape key
  or its close control), then nothing is saved: no version, no audit log entry (AC-2.5), no notice; and the form
  stays open with everything the person typed.
- AC-9.3: Given the confirmation, when the person confirms, then the save proceeds as in US-1 and US-2 with the
  values shown. If it is then refused (AC-1.2–1.4, AC-2.6), nothing is stored, no notice is sent, and the person is
  told as those criteria say; saving again asks for the confirmation again.
- AC-9.4: Given an older version, when a person who may manage the entity restores it (AC-2.4) and the restore is a
  protected change, then the confirmation of the restore also lists each changing protected detail with its old
  value (the current version's) and its new value (the restored version's) as in AC-9.1, and cancelling it restores
  nothing as in AC-9.2; when no protected detail differs, the restore confirmation is as before and lists none.
- AC-9.5: Given a save that is not a protected change (only the address or the contacts line changed, or the IBAN
  typed with other spacing or case only), then the person is not asked for this confirmation, and the save is as in
  US-1 and US-2.
- AC-9.6: Given the confirmation, then it meets AC-8.1 (focus moves into it when it opens and returns to the
  control that opened it when it closes, its content is announced, and it is usable with the keyboard alone) and
  all its words exist in Italian and English (AC-8.2).

*The others are told.*

- AC-9.7: Given a protected change, when its version has been stored, then a notice is sent for that version,
  handed over for sending within 60 seconds of the save when the suite's notification services are available
  *(owner, 2026-11-17)*. The notice is sent whichever way the save was made, so also when it did not come through
  the admin-ui confirmation (for example a direct call to the registry).
- AC-9.8: Given a protected change on a legal entity, then the notice goes to *(owner, 2026-11-17, security review
  F1)*:
  - every other person who may manage that entity (who holds the permission of AC-4.1 covering it, whether limited
    to that entity or not);
  - every administrator, whether or not they also hold that permission.
  The recipients are those who qualify at the moment the version is stored. A person who holds the permission only
  for the other entity, and a person who has been deleted from the suite, get none. A person who qualifies in
  several ways gets one notice per channel (AC-9.13).
- AC-9.9: Given a protected change, then the person who made it also gets the notice, as a receipt
  *(owner, 2026-11-17)*.
- AC-9.10: Given a protected change, then one address outside the suite also gets the notice, by email only, so
  that removing people from roles in the suite cannot silence it *(owner, 2026-11-17)*. It is a single mailbox for
  both entities, set by configuration; when none is set, the notice goes to the others only and nothing else
  changes.
- AC-9.11: Given a notice, then it states *(owner, 2026-11-17)*:
  - the legal entity;
  - who made the change, and whether it was a save or a restore (and of which version, for a restore). The author
    is identified by the email address of their account and by nothing else: neither their display name nor any
    other value the person can edit appears in the notice, next to the email or elsewhere. The email address is the
    one the account had at the moment the version was stored and is fixed with the version, like the recipients
    (AC-9.8): a later change of the account's email address or display name, or the deletion of the account, before
    the notice is sent or retried (AC-9.14) changes nothing of what the notice says. When the account had no email
    address at that moment, the notice states, in the language of the notice, that the author has no email address
    on record, and still states everything else of this list; it never falls back to the display name
    *(amendment D9, owner 2026-11-18, security re-review N1)*. An email address that is not a valid email address
    counts as no email address on record *(R-D9a, orchestrator 2026-11-18, confirmed by the owner 2026-11-18)*;
  - when, as date, time and time zone;
  - the version number it created;
  - which protected details changed, by name only;
  - if the IBAN changed, the last 4 characters of the old IBAN and the last 4 characters of the new IBAN, each under
    its own label; an empty one is stated as "none"; a value of 8 characters or fewer shows no character, only that
    it is set;
  - the names (not the values) of the other details changed in the same version;
  - a link that opens the history of that entity on the Legal entities page, where the version can be restored
    (AC-2.4). The link needs a sign-in like every other link of the suite; a person who may not see the history is
    refused as usual (AC-4.2, AC-4.3).
- AC-9.12: Given a notice, then no part of it (subject, title, text, link, preview line, push text) contains the
  full IBAN, old or new, nor the old or new legal name or VAT number, nor any other detail's value; and no record
  of a notice (AC-9.15) contains them either *(owner, 2026-11-17)*. The author's email address required by AC-9.11
  is not a detail (AC-1.1) and is the one personal value a notice may carry; it appears in every notice, including
  the email to the address outside the suite (AC-9.10), which the owner accepts; no part of a notice contains the
  author's display name *(amendment D9, owner 2026-11-18, security re-review N1)*.
- AC-9.13: Given a notice, then it is delivered on two channels *(owner, 2026-11-17)*: by email, in English for
  every recipient including the address outside the suite; and in the suite's notification centre, in the language
  of the person (AC-8.2), with a push notification for a person who has enabled push notifications. The address
  outside the suite gets the email only.

*A failure of the notice never touches the save.*

- AC-9.14: Given a protected change whose version is stored, when a notice cannot be delivered on a channel (the
  notification service is down or refuses, or a recipient has no usable email address), then *(owner, 2026-11-17)*:
  - the save stays stored, is shown to the person as saved exactly as if all had gone well, and no error about the
    notice is shown to them; the new details are used by consumers as AC-3.3 says, whether or not any notice has
    been sent;
  - a failure for one recipient or one channel does not stop or delay the others;
  - the delivery is retried, first within 5 minutes and then repeatedly, until it succeeds or 24 hours have passed
    since the version was stored, and is then given up;
  - the duty to send is kept together with the version: if the suite stops or restarts right after the version is
    stored, every notice not yet delivered is still sent and retried;
  - no recipient gets two notices on the same channel for the same version, retries included ("delivered" meaning
    accepted by the notification service, not read).
- AC-9.15: Given a notice that fails on a channel, then it is visible to administrators in the administration audit
  log, as an entry for the first failure of each recipient and channel (entity, version, whether the recipient is a
  person or the outside address, the channel, the reason in a few words, when), another when that delivery later
  succeeds, and another when it is given up *(owner, 2026-11-17)*. Given a protected change with no recipient at
  all, then an entry says so.
- AC-9.16: Given the move of AC-7.1 (version 1, attributed to the system), whether the first run or a repeated one
  (AC-7.4), then no notice is sent and no confirmation is involved; so no author is ever stated for the system, and
  the system needs no email address *(amendment D9, owner 2026-11-18)*.
- AC-9.17: Given a save or restore that is not a protected change (only the address or the contacts line changed,
  the IBAN with other spacing or case only, a restore of a version whose protected details are the same), or that
  changes nothing (AC-2.1), or that is refused, conflicting (AC-2.6) or cancelled, then no notice is sent.

## Non-goals

- **Adding, renaming or removing a legal entity.** The registry holds the two entities that exist *(owner)*; every
  tool keeps its own list of entity names for now.
- **Other tools adopting the registry** (refunds, inventory, projects…). They can later; this spec moves only the
  CRM and the letterhead service.
- **More details** (bank accounts beyond one IBAN, branches, share capital, registry numbers, logos). The registry
  is made so they can be added later; none is added now.
- **Changing documents already made.** Stored offers and their snapshots keep what they printed.
- **The CRM's customer companies.** They are a different thing and are untouched.
- **Translating the legal name, the VAT number or the IBAN.** They are one value each *(owner)*.
- **A recent sign-in for changing a protected detail, a second person's approval (dual control) or a delay before
  a change takes effect, and a shorter session for people who manage a legal entity.** Deliberately not done: owner
  decision 2026-11-17. A change by one signed-in person still takes effect as AC-3.3 says, and the session length
  is unchanged; the confirmation and the notice (US-9) are the chosen answer to security review F1.
- **A confirmation enforced by the registry itself.** The confirmation of US-9 is a step of the admin-ui page
  (owner decision 2026-11-17); a caller that goes to the registry directly is not asked, and only the notice
  (AC-9.7) covers that case.
- **A confirmation or a notice for the address or the contacts line.** Only the protected details trigger them
  (owner decision 2026-11-17), so that the signal stays rare. The names of those details do appear in a notice
  triggered by something else (AC-9.11).
- **Values in a notice.** A notice says which protected details changed, never their values, except the last 4
  characters of the IBAN (owner decision 2026-11-17); the values are in the confirmation, the history and the
  audit log. The author's email address (AC-9.11) is not a value of the details and is stated *(amendment D9)*.
- **Showing the display name next to the email in a notice, or proving by the notice who the author really is.**
  The notice states the account's email as recorded; it does not vouch for who was behind the account
  *(amendment D9, owner 2026-11-18)*.
- **Changing how the history (AC-2.2) and the audit log (AC-2.5) show the author.** Amendment D9 concerns the
  notice only; those two are read after sign-in by people entitled to see them (see OQ-16).
- **Proof that a notice was read, or a way to block a change from the notice.** A notice is handed over for
  sending; undoing a change is the restore of US-2, reached from the notice's link.

## Constraints

- *(owner)* The registry lives in the auth service and is administered from admin-ui; services read it with a
  service-token scope of its own (the request named it `companies:read`; its final name is the plan's).
- *(owner)* The letterhead service reads the details itself, with a short cache; callers stop sending them.
- *(amendment D1, owner 2026-11-17)* This spec supersedes specs/20261116-letterhead-service AC-6.3, AC-8.5 and
  AC-10.10, replaced by AC-5.1, AC-5.2 and AC-5.4 here.
- *(amendment D7, owner 2026-11-17)* It also supersedes specs/20261116-letterhead-service AC-1.8 for the issuer's
  details only: a request of an earlier content version renders after the upgrade with the registry's current
  details, not those it sent; everything else on its pages is unchanged.
- *(owner, 2026-11-17, security review F1)* The confirmation of US-9 is in admin-ui.
- *(owner, 2026-11-17)* The permission to manage legal entities is granted to anyone other than administrators only
  after the notice of US-9 is in production (the release where it ships, the second push); until then only
  administrators hold it, as the release runbook already says.

## Open questions

- [x] OQ-1 *Resolved 2026-11-17 (owner): accepted as proposed.* — Limits of AC-1.3 (lengths, 4 address lines). — owner: wellD
- [x] OQ-2 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-1.4: refuse an IBAN whose check digits are wrong (rather than only normalising it). — owner: wellD
- [x] OQ-3 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-3.3: 60 seconds as the longest time before every tool uses a change. — owner: wellD
- [x] OQ-4 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-4.3: the page is hidden from people who may manage no entity, though anyone signed in may read the
  details through the suite's tools. — owner: wellD
- [x] OQ-5 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-5.2: details still sent by a tool are ignored, rather than refused. — owner: wellD
- [x] OQ-6 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-5.5: a document is not made when the registry cannot be read, rather than printed with the last
  details known however old. — owner: wellD
- [x] OQ-7 *Resolved 2026-11-17 (owner): yes, one outside address.* — AC-9.10: a notice to one address outside the suite: a single mailbox for both
  entities, configurable; with none configured nothing else changes. The owner gives the address later; it is not
  part of this spec. — owner: wellD
- [x] OQ-8 *Resolved 2026-11-17 (owner): yes.* — AC-9.9: the person who made the change also gets the notice, as a receipt. — owner: wellD
- [x] OQ-9 *Resolved 2026-11-17 (owner): yes, legal name and VAT number too.* — Scope of the notice: a change of the legal name or the VAT number triggers it
  as well as the IBAN, with the same recipients and rules; the confirmation applies to the three protected details;
  a notice names which changed, never their values (IBAN: last 4 characters only). Address and contacts line stay
  out. — owner: wellD
- [x] OQ-10 *Resolved 2026-11-17 (owner).* — AC-9.13, AC-9.11: channels are email (in English for everyone, the outside
  address included; no default to Italian) and the suite's notification centre (in the person's language, with
  push for those who enabled it); a value of 8 characters or fewer shows no character; the names of the other
  changed details are listed. — owner: wellD
- [x] OQ-11 *Resolved 2026-11-17 (owner): yes.* — AC-9.7, AC-9.14: handed over within 60 seconds, first retry within 5
  minutes, given up after 24 hours, and the give-up is logged in the audit log (AC-9.15). — owner: wellD
- [x] OQ-12 *Resolved 2026-11-17 (owner).* — Release order: the permission to manage legal entities is granted to anyone
  other than administrators only after the notice is in production; recorded under Constraints. — owner: wellD
- [x] OQ-13 *Resolved 2026-11-17 (owner): accepted.* — The confirmation is a control of the admin-ui page; a direct call to
  the registry is covered by the notice only (Non-goals). — owner: wellD
- [x] OQ-14 *Decided 2026-11-18 (owner), security re-review N1 / QE O-1 (amendment D9).* — The notice identifies the
  author by the account's email address, not the editable display name; email only, no display name beside it; the
  email is fixed when the version is stored; the outside mailbox also receives it (owner-accepted). — owner: wellD
- [x] OQ-15 *Resolved 2026-11-18 (orchestrator, from the code): auth's `User.email` is required and unique, so every account has one; the "no email address on record" wording is a safeguard only.* — Can an account have no email address at all? If every account always has one, the "no email address on
  record" wording of AC-9.11 is a safeguard that never shows. — owner: wellD
- [x] OQ-16 *Resolved 2026-11-18 (orchestrator, within the owner's decision that named only the notice): history and audit log unchanged.* — Should the history (AC-2.2) and the audit log (AC-2.5), which still name the author as today, also show
  the email address so that a renamed person cannot be mistaken for someone else there? Left unchanged by D9
  (Non-goals). — owner: wellD
