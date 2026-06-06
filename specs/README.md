# Specs — spec-driven workflow

This project uses the welld spec-driven development workflow: one standardized path
from idea to reviewed task list, with three artifacts per feature and two human
approval gates.

```
idea ──/welld-dev:spec──► spec.md ──[user approves]──/welld-dev:plan──► plan.md ──[user approves]──/welld-dev:tasks──► tasks.md ──► implementation
```

## Directory layout

```
specs/
├── 001-user-auth/
│   ├── spec.md      # WHAT & WHY — problem, user stories, acceptance criteria
│   ├── plan.md      # HOW — architecture, data model, API contracts, test strategy
│   ├── design.md    # optional, UI features only — flows, screens, component reuse, a11y
│   └── tasks.md     # ordered, dependency-aware task list
└── 002-csv-export/
    └── spec.md
```

- `NNN` is zero-padded and sequential across the project; `slug` is short kebab-case.
- Never rename a spec directory after creation — it is referenced from commits.

## Status lifecycle

```
draft ──► approved ──► in-progress ──► done
                                └────► superseded (link the successor)
```

Only the **user** moves a spec from `draft` to `approved`. `/welld-dev:plan` refuses
to run on an unapproved spec; `/welld-dev:tasks` refuses to run on an unapproved plan.

## Drift rule

The spec is the source of truth. If implementation reveals the spec or plan is wrong:
stop, update `spec.md`/`plan.md` first, re-run `/welld-dev:tasks` to re-sync, then
continue coding. Reference task IDs in commit messages:
`feat(report): add CSV serializer (T1, specs/002)`.
