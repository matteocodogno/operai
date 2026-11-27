---
"@operai/auth": minor
---

Teams, service read (step 2): `GET /system/teams?ids=…` answers up to 50 teams with their members (name order, deactivated ones last with no name) and whether each holds the bound app's access, and `GET /system/teams?state=active[&q=…]` lists the active teams' names for the attach picker (name search, exact match first, 50 at most). It takes a service JWT with the new scope `teams:read` from a service bound in code (`TEAM_READERS`, projects-api only); the app is derived from the verified caller, never asked for; every credential failure is the same 401. Two allowances per service per 10 minutes, chosen by whether `ids` is present: 3 000 for ids and 1 500 for options. Grant `teams:read` to projects-api in `SERVICE_CLIENTS` only after this version is live (an unknown scope stops auth at startup).
