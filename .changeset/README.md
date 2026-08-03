# Changesets — Operai release workflow

Operai versions each app **independently** (SemVer) and derives an **umbrella
`operai` version** (aggregate SemVer) from each release. Everything is local +
`mise`-driven; nothing is published to npm (all apps are `private`).

## When you finish a feature

Record a changeset describing which apps changed and how:

```bash
mise run changeset        # → pnpm exec changeset (interactive)
```

Pick the affected package(s) (`@operai/refund-ui`, `@operai/auth`, …), choose
`patch`/`minor`/`major` for each, and write a one-line summary. This creates a
markdown file under `.changeset/` — **commit it with your feature**. A
cross-app change (e.g. a refund-api contract + its refund-ui consumer) selects
BOTH packages in the same changeset — the apps aren't npm-linked, so Changesets
can't infer the coupling for you.

CI (`.github/workflows/changeset-check.yml`) requires a changeset alongside
any app-code change. For a deliberate no-release change (docs-only inside an
app dir, CI/tooling-only, etc.), run `pnpm exec changeset add --empty` instead
of the interactive flow above — Changesets' own escape hatch for an
intentional no-op release note — and commit the resulting file.

> Pre-1.0 note: while an app is `0.x`, a `minor` is the "breaking allowed"
> lane and `patch` is everything else — SemVer treats `0.y.z` specially.

## When you're ready to release

```bash
mise run release:version  # apply pending changesets: bump each app's version +
                          # its CHANGELOG.md, then bump the umbrella `operai`
                          # version by the LARGEST bump in this release and
                          # stamp the root CHANGELOG.md
# review + commit the version bumps, then:
mise run release:tag      # create git tags (per-app `@operai/x@a.b.c` +
                          # `operai@a.b.c`) and push them
```

The umbrella aggregation lives in `scripts/version.mjs`.
