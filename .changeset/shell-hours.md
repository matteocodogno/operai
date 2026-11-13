---
"@operai/shell": minor
---

Mount the new Hours remote (specs/029-time-tracking, ADR-0090) at `/hours` and `/hours/all`, and add a "My hours" / "Le mie ore" row to the user menu after "My meetings". The route is open to every signed-in user, including one with no tool grants: it has no app-access guard and is not a sidebar tool, so recording and reading your own hours never depends on a grant; with no session it still goes to sign-in, and a remote that fails to load shows the usual in-place error with Retry. The About dialog lists the Hours version, the Vercel CSP allows the remote and hours-api, `hours` joins the runtime remote overrides, and the shell's stylesheet scans the remote's source. The shell also reads the hours-api origin from `VITE_HOURS_API_URL` and trusts it for the Bearer token (T21). Copy is English and Italian.
