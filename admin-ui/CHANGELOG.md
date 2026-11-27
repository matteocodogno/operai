# @operai/admin-ui

## 0.4.0

### Minor Changes

- 3e5d1b5: Teams, admin side (step 1): a **Teams** section between Departments and Users, for administrators only (a legal-entity manager who is not an administrator is redirected to Legal entities). The list at `/admin/teams` shows every team's name, active members and state, opens on Active teams, switches to Archived or All, searches by part of the name ignoring case, and creates a team through a dialog that names the clashing team when the name is taken, in English and Italian. There is no delete control. The team's own page follows in the next change.

### Patch Changes

- 3e5d1b5: The Teams screens in Italian use the informal "tu", as the other admin screens that were written last.

## 0.3.1

### Patch Changes

- 531247d: A mileage expense states where the trip starts and ends: two required fields, From and To, with Google address suggestions (the library's `AddressAutocomplete`, which also suggests companies and towns; when suggestions are unavailable the fields stay plain text). The line shows its route, the request PDF prints it and the register extract fills From and To. refund-api requires both for a mileage line on create and edit, and a draft mileage line written before must get them before it is submitted. admin-ui's employee address uses the same shared field. Needs `VITE_GOOGLE_MAPS_API_KEY` on the refund-ui Vercel project (infra/README.md).

## 0.3.0

### Minor Changes

- 8048f95: New Legal entities page, shown to anyone who can manage at least one entity, with one tab per entity (status, read-only and unsaved-changes marks), Details and History under each, and a draft kept per entity so switching never loses typing; leaving the page asks first. Details: a form with four address lines per language, the IBAN grouped as it is read, a summary of refused values that moves focus to the first one, and clear outcomes for saved, unchanged, refused and failed. When two people edit the same entity a banner offers Reapply, which keeps the values only one of them changed and flags the rest with "Use theirs", or Discard. Changing the legal name, VAT number or IBAN, and restoring an earlier version that does, now asks for confirmation first: the dialog shows the old and new values (IBAN in groups of four), says who will be told, defaults to Cancel and sends nothing until confirmed; a check that is refused or fails says so and saves nothing, and the save and restore limit shows its wait in minutes. History lists the newest 50 versions and Show older versions adds more, with loading and failure states and focus kept; a version opens read-only and can be restored. The Audit page now shows Before and After for legal entity changes. Section label, audit description and strings in English and Italian.

## 0.2.2

### Patch Changes

- bc1bf94: Patch the `zod` and `undici` advisories in the frontends' lockfiles: `zod` (reached through better-auth and eslint-plugin-react-hooks) moves to 4.6.7 and `undici` (reached through jsdom, tests only) to 7.30.1. Lockfile-only, both within the parents' existing ranges; no package.json change.

## 0.2.1

### Patch Changes

- 0d8b9df: The browser's back and forward buttons show the page of the address in every module,
  within a module and between modules. Each module now builds its router when it mounts,
  so coming back from another module no longer shows a page matched from that module's
  address (a project named "admin", "This page does not exist"). The router also follows
  the address while the shell hides the module behind its pending fallback, so back from
  "To start" or from a company shows the list it was opened from, not the page it left.
- 66ef8fa: The design system `@operai/ui` is compiled once, by the shell, and shared with every remote as a Module Federation singleton: remotes declare it with `import: false` and no longer bundle it (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell). The rich-text entry is still compiled by crm-ui, meetings-ui and projects-ui.

## 0.2.0

### Minor Changes

- 28872b4: Every tool now shares one look for actions, text and page layout: buttons and
  dialogs come from the shared library with the same meaning-based styles
  (primary actions meet contrast everywhere, cancel is quiet, destructive is
  red), text uses one type scale with an 11px minimum, labels drop their "+"
  and arrow prefixes, each tool has the same title bar, tabs and page header on
  a common width scale, and every detail page has a "Back to …" link. EstimAI's
  shortcuts, health and About dialogs are now real modal dialogs.
- 28872b4: Tables, paging, forms and feedback now work the same in every tool: record
  lists are accessible data tables, long lists page the same way, every form
  marks required fields with an asterisk and explains errors next to the field
  (moving focus to the first one), amounts accept a comma or a dot, dates use
  the date picker, every save, invite and delete confirms where you acted,
  errors you can retry are orange and errors you must fix are red, EstimAI no
  longer uses browser alert boxes, and the page no longer scrolls behind an open
  dialog.
- 28872b4: The whole suite now speaks Italian as well as English: every tool has a
  complete Italian translation and follows the browser's language, chosen once
  for all tools. Dates read the same everywhere (31.10.2026), amounts show their
  currency code with the language's separators, statuses use one shared set of
  icons and colours so the same symbol always means the same thing, emoji and
  text symbols are replaced by real icons that render on every system, headings
  are in sentence case, loading and empty screens look the same in every tool,
  detail pages are organised in cards, and EstimAI's views are proper tabs.
- 800aec6: Operai is now invitation-only. Signing in creates a user only for an email in an allowed domain (`ALLOWED_SIGNUP_DOMAINS`) that holds a valid invitation; an allowed-domain email without one sees a page explaining this and joins a waiting list, and an outside-domain email is refused with nothing recorded. Admins review these requests in a new waiting list in the Admin tool and approve one into an invitation or dismiss it, and are notified of new requests.
- 9adfd4a: The refund tool's settings (mileage rates per entity and the accounting distribution email) move from Admin to a new Settings tab in Refund (`/refund/settings`), shown to whoever holds `rate:read` or `settings:read`. Admin no longer has a Refund section.

### Patch Changes

- 9d0fbb9: The Admin user list shows each user's roles and departments by name instead of "NaN". The screen expected two counts the API never sent, while the API sends the names.
- 28872b4: The design system gains `Combobox` (suggestions while typing) and `Drawer` (a
  side panel for reference content). Admin's address and country fields and
  Inventory's holder and supplier pickers now share the one `Combobox`, which
  also keeps the highlighted suggestion in view in a long list. EstimAI's model
  reference opens in the library `Drawer`. Admin's user detail and mileage-rate
  pages read permissions from the shell instead of fetching them again. The
  suite's end-to-end tests look for the current Refund label instead of the old
  "Refund (Rimborsi)".
- 59e9b48: Dependency security update. better-auth moves to 1.7.18 everywhere, closing the advisory that let an OAuth state be used as a magic link to sign in as another user. The frontends move to vitest 4 and refreshed lockfiles, which clears the critical seroval and tinypool advisories. auth gains a migration adding three optional key columns that better-auth 1.7 expects on its signing-key table.
- 28872b4: One styling dialect across the suite (ADR 20261031-one-styling-dialect-token-utilities): colours and fonts are Tailwind
  utilities generated from the shared design tokens, never inline styles, and a
  lint rule keeps it that way. Hover and focus colours now apply where inline
  colours used to override them, date pickers follow the light theme, EstimAI's
  AI purple and tinted highlights follow the theme too, and each tool's
  standalone build uses the suite's real tokens instead of a stale copy.
- 28872b4: The design system gains `Menu` (the header's logo and account menus, now with
  full keyboard support) and `CheckboxGroupField` (pick several options from a
  list), and `ConfirmDialog` can ask for an acknowledgement and hold fields.
  Refund's "Mark as paid" and Inventory's dispose, close-year and new-rule
  dialogs now share that confirmation; Admin's role and department checklists
  and Inventory's invoice linking share the checkbox group. Success messages
  dismiss themselves after the same time in every tool.
- 94f89d9: Access requests follow-ups: an invitation conflict (409) now names its cause in a `code` field (`active_user_exists` / `pending_invitation_exists`); in the Admin tool, deciding the last request on a page returns to the previous page instead of an empty list, and the list shows a focus ring when it takes keyboard focus after a decision.
- c4ba4c3: Pages use more of a wide screen: the default tool column grows from 64rem to 80rem and the wide one (the CRM pipeline) fills the width beside the sidebar; single forms stay at 40rem.

## 0.1.0

### Minor Changes

- 621604b: Admins can now record and update an employee's home address from the Admin
  tool's Users section — with live, suggestion-assisted entry (Google Places,
  biased toward Switzerland and Italy) or fully manual typing, either way. Every
  change is captured in the existing audit trail. Employees gain a new "My
  profile" page (reachable from the account menu) where they can see their own
  address, read-only.

### Patch Changes

- 44c557e: The Admin tool's Audit tab now names the person behind each change: the Actor
  column shows the actor's full name, with their user id still shown underneath
  for correlation. A hard-deleted actor keeps its existing "Deleted user"
  fallback, so the cell is never blank.
- 2b11a53: Status, entity and currency badges keep their label on one line instead of wrapping inside a
  narrow table column.

## 0.0.1

### Patch Changes

- 6a13795: The shell footer/About dialog was showing `@operai/shell`'s own package
  version (`0.0.0`) instead of the Operai suite's umbrella version — the two
  are different numbers, and only the umbrella one is meaningful to a user.
  The footer now reads the umbrella version from a committed, generated file
  (`shell/src/lib/suiteVersion.generated.json`, kept in sync by
  `scripts/version.mjs` at release time) instead of `shell`'s own
  `package.json`.

  The About dialog additionally gains a "Components" section listing each
  mounted remote's own version (EstimAI, Refund, Admin, Notify), each exposed
  via a small new federated `./version` module. A remote whose version can't be
  resolved — unreachable, cold-starting, or (going forward, since every app
  deploys independently) simply predating this change — degrades to a muted
  "—" rather than blocking the dialog or throwing.
