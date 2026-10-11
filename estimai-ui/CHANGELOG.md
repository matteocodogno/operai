# @operai/estimai-ui

## 0.0.2

### Patch Changes

- 2b11a53: Status, entity and currency badges keep their label on one line instead of wrapping inside a
  narrow table column.
- 2b11a53: React and React DOM now resolve to 19.2.7, the version every other frontend in the suite
  uses. Module Federation shares React as a singleton, so a different version in one remote can
  break the others when they load together.

  Dropdowns now draw the suite's own chevron with space reserved for it, instead of the browser's
  arrow sitting against the right border.

  Checkboxes and radio buttons use the suite's own style instead of the browser's.

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
