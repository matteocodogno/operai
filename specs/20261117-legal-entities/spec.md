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

## Constraints

- *(owner)* The registry lives in the auth service and is administered from admin-ui; services read it with a
  service-token scope of its own (the request named it `companies:read`; its final name is the plan's).
- *(owner)* The letterhead service reads the details itself, with a short cache; callers stop sending them.
- *(amendment D1, owner 2026-11-17)* This spec supersedes specs/20261116-letterhead-service AC-6.3, AC-8.5 and
  AC-10.10, replaced by AC-5.1, AC-5.2 and AC-5.4 here.
- *(amendment D7, owner 2026-11-17)* It also supersedes specs/20261116-letterhead-service AC-1.8 for the issuer's
  details only: a request of an earlier content version renders after the upgrade with the registry's current
  details, not those it sent; everything else on its pages is unchanged.

## Open questions

- [x] OQ-1 *Resolved 2026-11-17 (owner): accepted as proposed.* — Limits of AC-1.3 (lengths, 4 address lines). — owner: wellD
- [x] OQ-2 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-1.4: refuse an IBAN whose check digits are wrong (rather than only normalising it). — owner: wellD
- [x] OQ-3 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-3.3: 60 seconds as the longest time before every tool uses a change. — owner: wellD
- [x] OQ-4 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-4.3: the page is hidden from people who may manage no entity, though anyone signed in may read the
  details through the suite's tools. — owner: wellD
- [x] OQ-5 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-5.2: details still sent by a tool are ignored, rather than refused. — owner: wellD
- [x] OQ-6 *Resolved 2026-11-17 (owner): accepted as proposed.* — AC-5.5: a document is not made when the registry cannot be read, rather than printed with the last
  details known however old. — owner: wellD
