# accounting-ui

The Accounting module's screens (specs/20261119-accounting): a Module Federation **remote** that the shell
mounts at `/accounting`. It shows and keeps, for each legal entity, the **ledger accounts**, the **VAT codes**
and the **monthly average exchange rates** held by `accounting-api`. Port **5183** (pinned in `vite.config.ts`).

Exposes `./App` (gated) and `./version`. It has no authenticated bootstrap of its own: it calls
accounting-api through `shell/session`, so run it through the shell. The shell is told the API's origin by
`VITE_ACCOUNTING_API_URL` (`http://localhost:8089` by default in `mise run dev`) and the remote's address by
`ACCOUNTING_REMOTE_URL`.

## Routes

`/accounting` redirects to `/accounting/ledger-accounts`; the others are `/accounting/vat-codes` and
`/accounting/exchange-rates` (with `?month=YYYY-MM` to scroll to a month). Each takes `?entity=welld_ch|welld_it`.

- A person sees only the entities their grant covers; with two or more there is an **Entity** switcher.
- Write controls (add, deactivate, reactivate, fetch now, correct a rate) appear from `GET /v1/me` `canManage`
  for the displayed entity, never from the shell's permissions. A reader sees the same lists without them.
- There is no edit or delete of an entry: it is deactivated and reactivated.
- WellD Italia has no official rate source yet: its rates view says so, which is not an error.

## Commands

```bash
pnpm install
pnpm dev        # standalone dev server on :5183 — a remote still needs the shell for an authed session
pnpm lint       # ESLint
pnpm build      # tsc -b + vite build (typecheck happens here)
pnpm test       # vitest (includes axe checks on every state of every card and dialog)
```

Run the whole stack with `mise run dev` (opens the shell at http://localhost:5173). The e2e serves this remote
on `:5185` (`E2E_ACCOUNTING_REMOTE_PORT`); the journeys are `shell/e2e/accounting.spec.ts` and
`accounting-access.spec.ts`. Copy lives in `src/strings.ts` (`en` and `it`, with a parity test).
