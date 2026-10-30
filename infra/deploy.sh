#!/usr/bin/env bash
# infra/deploy.sh — automate what can be automated in an Operai deploy.
#
# WHAT THIS AUTOMATES
#   Railway (backends): link the project, ensure the shared Postgres + the
#   five logical databases (auth, estimai, notify, refund, inventory), set
#   every automatable env var for the `auth`, `estimai-api`, `notify-api`,
#   `refund-api`, and `inventory-api` services from your direnv/1Password-
#   exported secrets, and trigger their deploys. This
#   includes AUTH_AUDIENCE (ADR-0010, specs/005-notification-center) — the
#   SAME value is set on all five services, closing the cross-service JWT
#   replay gap now that notify-api/refund-api/inventory-api are additional JWKS
#   resource servers. Every notify-api caller authenticates as itself with a
#   scoped 5-minute service JWT (ADR-0044/0048/0049, specs/016): `auth` mints its
#   own in process, `refund-api`, `estimai-api` and `inventory-api` ask auth's
#   POST /system/service-token with SERVICE_CLIENT_ID / SERVICE_CLIENT_SECRET.
#   The retired shared token is neither required nor set by this script. This
#   script sets auth's and the callers' NOTIFY_INTERNAL_URL (notify-api's Railway
#   PRIVATE-networking address, not its public domain — plan.md Risk R2),
#   SERVICE_AUDIENCE (only when you export it — byte-identically on auth +
#   notify-api; it must differ from AUTH_AUDIENCE, both services refuse to start
#   otherwise), SERVICE_CLIENT_ID on the three callers, and notify-api's optional
#   EMAIL_ENABLED/RESEND_API_KEY/RESEND_FROM.
#
#   NOT automated (specs/016): the callers' SERVICE_CLIENT_SECRET and auth's
#   SERVICE_CLIENTS (JSON carrying every caller's secret). Each secret is a
#   Railway Shared Variable with no 1Password item, so it is never passed through
#   this script. Set them with `railway variables --service <svc> --set ...` (or
#   the dashboard; infra/README.md § Notify credential rollout, step 3). The callers' env.ts exits 1
#   at startup without SERVICE_CLIENT_SECRET, so this script CHECKS, by variable
#   NAME only (values are never read into the terminal), that it exists on
#   refund-api, estimai-api and inventory-api and that auth has SERVICE_CLIENTS,
#   and skips a caller's deploy trigger, with a warning, until it does.
#
#   inventory-api (specs/015-hardware-inventory, ADR-0044/0047) additionally
#   gets DATABASE_URL, ALLOWED_ORIGINS, AUTH_ISSUER/AUTH_JWKS_URL/AUTH_BASE_URL/
#   AUTH_AUDIENCE, PORT and NODE_ENV.
#   ORDER: auth and notify-api come BEFORE the callers (their SERVICE_* vars must
#   exist when a caller first asks for a token) — the blocks below run in that
#   order.
#   Migrations + the authz seed run automatically via each service's
#   railway.json preDeployCommand (`bun run db:deploy && …`).
#
#   NOT automated: `refund-api`'s REFUND_S3_* (EU object storage, ADR-0016) —
#   no bucket/1Password item exists yet (see infra/README.md § Variable
#   reference, "Object storage — provisioning"). Set those manually via
#   `railway variables --service refund-api --set "REFUND_S3_...=..."` once
#   provisioned; this script deliberately does not invent placeholder values
#   for a service still using its local-dev-only .env.example defaults.
#
#   NOT automated (inventory, same precedent): `inventory-api`'s INVENTORY_S3_*
#   (its OWN private EU invoice bucket and credentials, never refund-api's —
#   see infra/README.md § `inventory-api` service), its SERVICE_CLIENT_SECRET,
#   and auth's SERVICE_CLIENTS (JSON carrying that same secret). The secret is
#   a Railway Shared Variable (INVENTORY_SERVICE_CLIENT_SECRET) with no
#   1Password item, so it is never passed through this script. Set them with
#   `railway variables --service <svc> --set ...` (or the dashboard). UNLIKE
#   refund-api, inventory-api's env.ts exits 1 at startup without the S3 vars
#   and SERVICE_CLIENT_SECRET, so this script CHECKS that those names exist
#   (names only — values are never read into the terminal) and skips the
#   inventory-api deploy trigger, with a warning, until they do.
#
#   Vercel (frontends, optional --vercel): push the build-time env vars to the
#   six existing projects (shell, estimai-ui, refund-ui, admin-ui, notify-ui,
#   inventory-ui) and trigger a redeploy. Project + custom-domain creation is NOT
#   automatable via CLI here — do it once in the dashboard (see
#   infra/README.md § Vercel), then this keeps env vars in sync.
#
# WHAT STAYS MANUAL (see infra/README.md): creating the Railway project +
#   attaching custom domains (incl. inventory-api's, targeting port 8083);
#   creating the Railway `inventory-api` service itself; creating the 6 Vercel
#   projects + assigning the 6 domains; registering the Google/GitHub OAuth
#   redirect URIs; provisioning refund-api's and inventory-api's EU object-
#   storage buckets (+ the invoice bucket's CORS rule); DNS for the two
#   inventory hostnames.
#
# USAGE
#   direnv exec auth ./infra/deploy.sh            # backends only (recommended)
#   direnv exec auth ./infra/deploy.sh --vercel   # + sync Vercel env + redeploy
#   AUTH_PUBLIC_URL=https://auth.operai.welld.io ./infra/deploy.sh   # set the JWT issuer
#
# PREREQS: railway CLI (logged in), 1Password-unlocked direnv shell (so the
#   secrets below are exported). For --vercel: vercel CLI (logged in, linked).
#   NEVER put real secret values in this file — it is committed.
#
# DATA RESIDENCY: all backend services + Postgres are pinned to europe-west4.
#   notify-api additionally never logs request/response bodies (notification
#   title/body may name clients/estimates) and is pinned to numReplicas: 1 in
#   notify-api/railway.json — do not scale it without reading plan.md Risk R2.
#   inventory-api never logs request/response bodies either (financial figures
#   and who holds which device are personal data); no replica pin.
#   refund-api never logs request/response bodies either (financial figures +
#   receipt-attachment metadata may carry PII, ADR-0016) but has no replica
#   pin — its authz cache is a per-replica perf optimization, not a shared
#   store (see infra/README.md § refund-api deploy notes).

set -euo pipefail

# ─── Config (override via env) ────────────────────────────────────────────────
RAILWAY_ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
RAILWAY_REGION="europe-west4"
UI_ORIGIN="${UI_ORIGIN:-https://operai.welld.io}"              # the shell's origin (no trailing slash)
DO_VERCEL=false; [[ "${1:-}" == "--vercel" ]] && DO_VERCEL=true

# Frontend build-time URLs (used by --vercel). Override to match real domains.
AUTH_URL="${AUTH_URL:-https://auth.operai.welld.io}"
API_URL="${API_URL:-https://estimai-api.operai.welld.io}"
NOTIFY_API_URL="${NOTIFY_API_URL:-https://notify-api.operai.welld.io}"
REFUND_API_URL="${REFUND_API_URL:-https://refund-api.operai.welld.io}"
# ASSUMED hostnames (the ones shell/vercel.json's CSP already names) — they do
# not resolve until DNS + the custom domains exist (infra/README.md rollout).
INVENTORY_API_URL="${INVENTORY_API_URL:-https://inventory-api.operai.welld.io}"
ESTIMAI_REMOTE_URL="${ESTIMAI_REMOTE_URL:-https://estimai.operai.welld.io/remoteEntry.js}"
REFUND_REMOTE_URL="${REFUND_REMOTE_URL:-https://refund.operai.welld.io/remoteEntry.js}"
ADMIN_REMOTE_URL="${ADMIN_REMOTE_URL:-https://admin.operai.welld.io/remoteEntry.js}"
INVENTORY_REMOTE_URL="${INVENTORY_REMOTE_URL:-https://inventory.operai.welld.io/remoteEntry.js}"
SHELL_REMOTE_URL="${SHELL_REMOTE_URL:-https://operai.welld.io/remoteEntry.js}"

# ADR-0010 (specs/005-notification-center, extended by specs/007-refund-
# service): ONE audience value, verified by auth (stamps it) and every
# resource server (estimai-api, notify-api, refund-api, inventory-api). Not a
# secret, but must be byte-for-byte identical across all five services — a drift fails
# every request closed (401), not open. Defaults to the same local-dev value
# baked into each service's .env.example; override for a real deploy if you
# want a non-default suite-wide audience string.
AUTH_AUDIENCE="${AUTH_AUDIENCE:-operai-suite}"

# ADR-0044 (specs/015-hardware-inventory): the `aud` auth stamps on scoped
# service JWTs and notify-api verifies. Byte-identical on auth + notify-api and
# DIFFERENT from AUTH_AUDIENCE (both refuse to start otherwise). Deliberately
# NO default: guessing a value could overwrite one already set in production
# (the manual rollout may have done so); unset = left untouched on both
# services, and the inventory-api block then requires it to be present already.
SERVICE_AUDIENCE="${SERVICE_AUDIENCE:-}"

# Names (never values) of the variables currently set on a Railway service.
# Used for the inventory-api prerequisite checks; the values pass through
# `cut` and are discarded, so no secret reaches the terminal or a variable.
railway_var_names() { # railway_var_names <service>
  railway variables --service "$1" --kv 2>/dev/null | cut -d= -f1 || true
}

# Prerequisite check by variable NAME only (specs/016). A caller whose env.ts
# exits 1 without its service-client credential, or whose pushes would be
# silently 401, is not worth triggering a deploy for; the variables the script
# sets are harmless to have set, so only the deploy trigger is skipped.
# need <label> <names-of-service-vars> <VAR>…  → appends to BLOCKERS
BLOCKERS=()
need() {
  local label="$1" names="$2"; shift 2
  local v
  for v in "$@"; do
    printf '%s\n' "$names" | grep -qxF "$v" || BLOCKERS+=("${label}: ${v}")
  done
}
# deploy_or_skip <service> — triggers the deploy iff BLOCKERS is empty, then resets it.
deploy_or_skip() {
  local svc="$1"
  if [[ ${#BLOCKERS[@]} -eq 0 ]]; then
    railway up --service "$svc" --detach && ok "${svc} deploy triggered."
  else
    warn "${svc} deploy NOT triggered — these variables are not set yet (names only):"
    local b
    for b in "${BLOCKERS[@]}"; do warn "    $b"; done
    warn "Set them manually (infra/README.md § Notify credential rollout, step 3), then re-run this script or: railway up --service ${svc} --detach"
  fi
  BLOCKERS=()
}

# ADR-0011 (specs/006-user-invitations, extended by ADR-0017/specs/007-refund-
# service): notify-api's Railway PRIVATE-networking address — auth's
# server-to-server POST /system/emails call AND refund-api's POST
# /system/notifications call must both stay off the public internet (plan.md
# Risk R2). This is DIFFERENT from $NOTIFY_API_URL above (that one is public,
# for the browser/SSE only). The exact private hostname is visible in the
# Railway dashboard (notify-api service → Settings → Networking → Private
# Networking) after notify-api's first deploy — override this default if
# yours differs.
NOTIFY_INTERNAL_URL="${NOTIFY_INTERNAL_URL:-http://notify-api.railway.internal:8081}"

# notify-api email channel (specs/006-user-invitations, ADR-0011). EMAIL_ENABLED
# defaults false (invite emails are stubbed — recorded, not actually sent via
# Resend) so a first deploy doesn't require a verified Resend domain up front.
# Flip to true (and provide RESEND_API_KEY/RESEND_FROM) once the domain is
# verified — see infra/README.md § Resend domain setup.
EMAIL_ENABLED="${EMAIL_ENABLED:-false}"
RESEND_FROM="${RESEND_FROM:-no-reply@operai.welld.io}"

# ─── Output helpers ───────────────────────────────────────────────────────────
c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info() { echo "$(c '0;34' '[deploy]') $*"; }
ok()   { echo "$(c '0;32' '[deploy]') $*"; }
warn() { echo "$(c '1;33' '[deploy]') $*"; }
die()  { echo "$(c '0;31' '[deploy] ERROR:') $*" >&2; exit 1; }

# ─── Preconditions ────────────────────────────────────────────────────────────
command -v railway >/dev/null 2>&1 || die "railway CLI not found — https://docs.railway.app/develop/cli"
railway whoami >/dev/null 2>&1    || die "not logged in to Railway — run: railway login"

REQUIRED_SECRETS=(BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
                  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET JWT_PRIVATE_KEY JWT_PUBLIC_KEY)
info "Checking direnv/1Password-exported secrets…"
for v in "${REQUIRED_SECRETS[@]}"; do
  [[ -n "${!v:-}" ]] || die "\$$v is not set. Run inside the direnv/1Password shell (e.g. \`direnv exec auth ./infra/deploy.sh\`); see infra/README.md."
done
[[ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ]] || warn "BOOTSTRAP_ADMIN_EMAIL not set — the seed will create no bootstrap admin (set it on the auth service to grant the first admin; specs/004 AC-6.1)."
# Case-insensitive match on the literal "true" (mirrors notify-api's own
# EMAIL_ENABLED parsing, src/lib/env.ts). Avoids bash 4+ `${VAR,,}` — macOS
# ships bash 3.2 by default, which doesn't support it.
case "${EMAIL_ENABLED}" in
  [Tt][Rr][Uu][Ee])
    [[ -n "${RESEND_API_KEY:-}" ]] || die "EMAIL_ENABLED=true but \$RESEND_API_KEY is not set — notify-api will refuse to start. Export it, or leave EMAIL_ENABLED unset/false until the Resend domain is verified (infra/README.md § Resend domain setup)."
    ;;
  *)
    warn "EMAIL_ENABLED is not 'true' — invitation emails will be stubbed (recorded, not actually sent via Resend). Fine for a first deploy; see infra/README.md § Resend domain setup before enabling in production."
    ;;
esac
# ADR-0044: a service token must be useless on every user route and a user JWT
# useless on every system route — only true while the two audiences differ.
if [[ -n "${SERVICE_AUDIENCE}" && "${SERVICE_AUDIENCE}" == "${AUTH_AUDIENCE}" ]]; then
  die "\$SERVICE_AUDIENCE must differ from \$AUTH_AUDIENCE (ADR-0044) — auth and notify-api exit at startup when they are equal."
fi
[[ -n "${SERVICE_AUDIENCE}" ]] || warn "SERVICE_AUDIENCE not exported — auth's and notify-api's value is left untouched; the inventory-api block will require it to be set already (ADR-0044)."
ok "All required secrets present."

# ─── Link the Railway project ─────────────────────────────────────────────────
if [[ -n "${RAILWAY_PROJECT_ID:-}" ]]; then
  info "Linking Railway project ${RAILWAY_PROJECT_ID} (env ${RAILWAY_ENVIRONMENT})…"
  railway link "${RAILWAY_PROJECT_ID}" >/dev/null 2>&1 || true
  railway environment "${RAILWAY_ENVIRONMENT}" >/dev/null 2>&1 || true
else
  die "RAILWAY_PROJECT_ID is not set. Create the project in the Railway dashboard (region ${RAILWAY_REGION}), then export RAILWAY_PROJECT_ID and re-run."
fi

# ─── Ensure shared Postgres + logical databases ───────────────────────────────
if ! railway service list 2>/dev/null | grep -qi postgres; then
  info "Provisioning Postgres (${RAILWAY_REGION})…"; railway add --database postgres || railway add --plugin postgresql
  ok "Postgres provisioned — confirm its region is ${RAILWAY_REGION} in the dashboard before adding data."
else
  ok "Postgres already present."
fi
info "Ensuring logical databases 'auth', 'estimai', 'notify', 'refund', and 'inventory' exist…"
for DB in auth estimai notify refund inventory; do
  railway run --service Postgres -- psql "\$DATABASE_URL" -v ON_ERROR_STOP=0 -tc \
    "SELECT 'CREATE DATABASE ${DB}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${DB}')\gexec" \
    >/dev/null 2>&1 || warn "Could not auto-create '${DB}' — create it manually: railway connect Postgres → CREATE DATABASE ${DB};"
done
ok "Logical databases ready."

# ─── auth service vars + deploy ───────────────────────────────────────────────
# ${{Postgres.*}} is Railway reference syntax — single-quote so the shell keeps it literal.
info "Setting auth service variables…"
railway variables --service auth \
  --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/auth' \
  --set "BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}" \
  --set "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}" --set "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}" \
  --set "GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}" --set "GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}" \
  --set "JWT_PRIVATE_KEY=${JWT_PRIVATE_KEY}" --set "JWT_PUBLIC_KEY=${JWT_PUBLIC_KEY}" \
  --set "ALLOWED_ORIGINS=${UI_ORIGIN}" --set "UI_HOME_URL=${UI_ORIGIN}/" \
  --set "AUTH_AUDIENCE=${AUTH_AUDIENCE}" \
  --set "NOTIFY_INTERNAL_URL=${NOTIFY_INTERNAL_URL}" \
  ${SERVICE_AUDIENCE:+--set "SERVICE_AUDIENCE=${SERVICE_AUDIENCE}"} \
  ${BOOTSTRAP_ADMIN_EMAIL:+--set "BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_ADMIN_EMAIL}"} \
  --set "NODE_ENV=production" >/dev/null
# BETTER_AUTH_URL is set after the domain exists (below). PORT / ENABLE_TEST_AUTH /
# BETTER_AUTH_TRUSTED_ORIGINS are intentionally NOT set (see infra/README.md).
# SERVICE_AUDIENCE (ADR-0044) is set only when exported (above). SERVICE_CLIENTS
# (JSON incl. every caller's client secret) is NOT set here — manual, see the
# header comment; `--set` is additive, so an existing SERVICE_CLIENTS survives.
# Not a deploy gate for auth (it starts without it), but without it no caller can
# obtain a credential, so say so by name.
AUTH_NAMES="$(railway_var_names auth)"
printf '%s\n' "$AUTH_NAMES" | grep -qxF SERVICE_CLIENTS \
  || warn "auth has no SERVICE_CLIENTS — no caller can obtain a notify credential (infra/README.md § Notify credential rollout, step 3)."
railway up --service auth --detach && ok "auth deploy triggered."

# ─── estimai-api service vars + deploy ────────────────────────────────────────
info "Setting estimai-api service variables…"
railway variables --service estimai-api \
  --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/estimai' \
  --set "ALLOWED_ORIGINS=${UI_ORIGIN}" \
  --set "AUTH_ISSUER=${AUTH_PUBLIC_URL:-$AUTH_URL}" \
  --set "AUTH_JWKS_URL=${AUTH_PUBLIC_URL:-$AUTH_URL}/auth/jwks" \
  --set "AUTH_AUDIENCE=${AUTH_AUDIENCE}" \
  --set "SERVICE_CLIENT_ID=estimai-api" \
  --set "NODE_ENV=production" >/dev/null
# specs/016: estimai-api pushes to notify-api with its own scoped service JWT and
# exits at startup without these (names only; SERVICE_CLIENT_SECRET is manual).
need estimai-api "$(railway_var_names estimai-api)" SERVICE_CLIENT_SECRET AUTH_BASE_URL NOTIFY_INTERNAL_URL
deploy_or_skip estimai-api

# ─── notify-api service vars + deploy (specs/005-notification-center) ─────────
# Own logical DB ('notify', NOT 'estimai'); same AUTH_ISSUER/AUTH_JWKS_URL as
# estimai-api (same issuer, same JWKS endpoint) but its OWN AUTH_AUDIENCE value
# (must match auth's and estimai-api's — ADR-0010). railway.json (committed)
# pins numReplicas: 1 — this script does not and must not override that.
# SERVICE_AUDIENCE (ADR-0044) is the audience of the callers' service JWTs; it is
# set only when exported and must equal auth's. RESEND_API_KEY is only set
# when provided (leaving it unset keeps EMAIL_ENABLED=false safe — notify-api's
# env schema only requires it when EMAIL_ENABLED=true).
info "Setting notify-api service variables…"
railway variables --service notify-api \
  --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/notify' \
  --set "ALLOWED_ORIGINS=${UI_ORIGIN}" \
  --set "AUTH_ISSUER=${AUTH_PUBLIC_URL:-$AUTH_URL}" \
  --set "AUTH_JWKS_URL=${AUTH_PUBLIC_URL:-$AUTH_URL}/auth/jwks" \
  --set "AUTH_AUDIENCE=${AUTH_AUDIENCE}" \
  --set "MAX_STREAM_DURATION=${MAX_STREAM_DURATION:-1800}" \
  --set "EMAIL_ENABLED=${EMAIL_ENABLED}" \
  --set "RESEND_FROM=${RESEND_FROM}" \
  ${RESEND_API_KEY:+--set "RESEND_API_KEY=${RESEND_API_KEY}"} \
  ${SERVICE_AUDIENCE:+--set "SERVICE_AUDIENCE=${SERVICE_AUDIENCE}"} \
  --set "NODE_ENV=production" >/dev/null
railway up --service notify-api --detach && ok "notify-api deploy triggered."

# ─── refund-api service vars + deploy (specs/007-refund-service, T19) ─────────
# Own logical DB ('refund', NOT 'estimai'/'notify'); same AUTH_ISSUER/
# AUTH_JWKS_URL/AUTH_AUDIENCE pattern as estimai-api/notify-api above — a
# THIRD JWKS resource server on the same shared AUTH_AUDIENCE (ADR-0010).
# refund-api also gets NOTIFY_INTERNAL_URL and SERVICE_CLIENT_ID (ADR-0017/0049)
# for its decision→notification push (POST /system/notifications) and its
# batch email (POST /system/emails), authenticated by a scoped service JWT
# (scopes notifications.push + emails.send) from its own SERVICE_CLIENTS entry.
#
# NOT SET HERE: REFUND_S3_* (EU object storage, ADR-0016) — no bucket/
# 1Password item exists yet (see infra/README.md § Variable reference,
# "Object storage — provisioning"). refund-api's env.ts does not enforce
# these until T9 lands, so omitting them here does not break this deploy;
# set them manually via `railway variables --service refund-api --set
# "REFUND_S3_...=..."` once a real bucket exists, before T9 ships.
info "Setting refund-api service variables…"
railway variables --service refund-api \
  --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/refund' \
  --set "ALLOWED_ORIGINS=${UI_ORIGIN}" \
  --set "AUTH_ISSUER=${AUTH_PUBLIC_URL:-$AUTH_URL}" \
  --set "AUTH_JWKS_URL=${AUTH_PUBLIC_URL:-$AUTH_URL}/auth/jwks" \
  --set "AUTH_AUDIENCE=${AUTH_AUDIENCE}" \
  --set "NOTIFY_INTERNAL_URL=${NOTIFY_INTERNAL_URL}" \
  --set "SERVICE_CLIENT_ID=refund-api" \
  --set "NODE_ENV=production" >/dev/null
# specs/016: exits at startup without SERVICE_CLIENT_SECRET (manual; names only).
need refund-api "$(railway_var_names refund-api)" SERVICE_CLIENT_SECRET AUTH_BASE_URL
deploy_or_skip refund-api
warn "refund-api's REFUND_S3_* vars were NOT set (no bucket provisioned yet) — the service will start (env.ts does not enforce them until T9), but attachment upload/download will fail until they're set manually. See infra/README.md."

# ─── inventory-api service vars + deploy (specs/015-hardware-inventory) ───────
# MUST stay AFTER the auth and notify-api blocks above (ordering constraint:
# auth needs SERVICE_AUDIENCE + SERVICE_CLIENTS and notify-api needs
# SERVICE_AUDIENCE before inventory-api first asks for a scoped token; a push
# attempted earlier is a silent 401 — it is best-effort and never rolls back a
# mutation). The deploys above are triggered with --detach and NOT awaited:
# confirm auth and notify-api booted (`railway status`) — auth's
# preDeployCommand seeds the `inventory` catalog inventory-api authorizes against.
#
# Own logical DB ('inventory'); the FOURTH JWKS resource server on the shared
# AUTH_AUDIENCE (ADR-0010). Per infra/README.md § Private networking, a CALL to
# another backend (AUTH_JWKS_URL, AUTH_BASE_URL) uses Railway private networking
# and a CLAIM (AUTH_ISSUER) stays the public URL. NOTIFY_INTERNAL_URL is the
# project Shared Variable (notify-api's `${{notify-api.…}}` reference does not
# resolve — never hand-type its private domain). Single-quoted so the shell
# keeps the `${{…}}` references literal.
#
# MANUAL (see header): INVENTORY_S3_*, SERVICE_CLIENT_SECRET, auth SERVICE_CLIENTS.
info "Setting inventory-api service variables…"
railway variables --service inventory-api \
  --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/inventory' \
  --set "ALLOWED_ORIGINS=${UI_ORIGIN}" \
  --set "AUTH_ISSUER=${AUTH_PUBLIC_URL:-$AUTH_URL}" \
  --set 'AUTH_JWKS_URL=http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks' \
  --set 'AUTH_BASE_URL=http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}' \
  --set "AUTH_AUDIENCE=${AUTH_AUDIENCE}" \
  --set 'NOTIFY_INTERNAL_URL=${{shared.NOTIFY_INTERNAL_URL}}' \
  --set "SERVICE_CLIENT_ID=inventory-api" \
  --set "PORT=8083" \
  --set "NODE_ENV=production" >/dev/null

# Prerequisites, by name only (see need/deploy_or_skip above): auth must hold the
# service-token endpoint's configuration and notify-api must know the audience.
need auth          "$AUTH_NAMES"                           SERVICE_AUDIENCE SERVICE_CLIENTS PORT
need notify-api    "$(railway_var_names notify-api)"       SERVICE_AUDIENCE
need inventory-api "$(railway_var_names inventory-api)"    SERVICE_CLIENT_SECRET INVENTORY_S3_ENDPOINT INVENTORY_S3_REGION INVENTORY_S3_BUCKET INVENTORY_S3_ACCESS_KEY_ID INVENTORY_S3_SECRET_ACCESS_KEY
deploy_or_skip inventory-api

# ─── Cross-wire: auth must know its own public URL (JWT issuer) ────────────────
if [[ -n "${AUTH_PUBLIC_URL:-}" ]]; then
  info "Setting auth BETTER_AUTH_URL=${AUTH_PUBLIC_URL} (JWT issuer)…"
  railway variables --service auth --set "BETTER_AUTH_URL=${AUTH_PUBLIC_URL}" >/dev/null
  railway redeploy --service auth --yes >/dev/null 2>&1 || railway up --service auth --detach
  ok "auth redeployed with issuer."
else
  warn "AUTH_PUBLIC_URL not set → BETTER_AUTH_URL not applied. Generate the auth domain, then re-run with AUTH_PUBLIC_URL=https://<auth-domain> (must equal estimai-api's, notify-api's, refund-api's, and inventory-api's AUTH_ISSUER)."
fi

# ─── Optional: sync Vercel env + redeploy (projects must already exist) ────────
if $DO_VERCEL; then
  command -v vercel >/dev/null 2>&1 || die "--vercel given but vercel CLI not found — https://vercel.com/docs/cli"
  vset() { # vset <project> <VAR> <value>
    printf '%s' "$3" | vercel env add "$2" production --scope "${VERCEL_SCOPE:-}" --yes "$1" >/dev/null 2>&1 \
      || warn "  could not set $2 on $1 (may already exist — remove+re-add or set in dashboard)"
  }
  info "Syncing Vercel env vars (production)…"
  vset shell VITE_AUTH_URL "$AUTH_URL"; vset shell VITE_API_URL "$API_URL"; vset shell VITE_NOTIFY_API_URL "$NOTIFY_API_URL"
  vset shell VITE_REFUND_API_URL "$REFUND_API_URL"
  # specs/015: both are BUILD-time on the shell. VITE_INVENTORY_API_URL is optional by design
  # and unset = the inventory origin is not trusted, so apiFetch sends no Bearer there and
  # every inventory call silently 401s (infra/README.md § Frontend build-time vars).
  vset shell VITE_INVENTORY_API_URL "$INVENTORY_API_URL"; vset shell INVENTORY_REMOTE_URL "$INVENTORY_REMOTE_URL"
  vset shell ESTIMAI_REMOTE_URL "$ESTIMAI_REMOTE_URL"; vset shell REFUND_REMOTE_URL "$REFUND_REMOTE_URL"; vset shell ADMIN_REMOTE_URL "$ADMIN_REMOTE_URL"
  vset estimai-ui VITE_API_URL "$API_URL"; vset estimai-ui VITE_AUTH_URL "$AUTH_URL"; vset estimai-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  # refund-ui (T20, specs/007-refund-service): VITE_REFUND_API_URL is REQUIRED
  # here too — refund-ui builds its own refund-api URLs from this project's
  # OWN copy (refund-ui/src/lib/refundApi.ts), independent of the shell's
  # copy above. Both MUST carry the identical $REFUND_API_URL value (see
  # infra/README.md § Variable reference's cross-service-wiring note) or the
  # shell's trusted-origins check and refund-ui's own request URLs silently
  # disagree.
  vset refund-ui VITE_REFUND_API_URL "$REFUND_API_URL"; vset refund-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  vset admin-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  # notify-ui (specs/005): no backend var of its own — it goes through shell/session's
  # VITE_NOTIFY_API_URL (set on the shell project above), same pattern as admin-ui.
  vset notify-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  # inventory-ui (specs/015): no backend var of its own — it asks the shell for
  # getInventoryApiBaseUrl()/getAuthBaseUrl() (set on the shell project above).
  vset inventory-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  for p in shell estimai-ui refund-ui admin-ui notify-ui inventory-ui; do vercel deploy --prod --cwd "$p" >/dev/null 2>&1 && ok "  redeployed $p" || warn "  redeploy $p failed — trigger from dashboard"; done
fi

echo ""
ok "Done. Verify with:  ./infra/check.sh"
echo "   Health:  railway status --service auth ; railway status --service estimai-api ; railway status --service notify-api ; railway status --service refund-api ; railway status --service inventory-api"
echo "   Migrations + authz seed run automatically via each railway.json preDeployCommand."
echo "   Reminder: refund-api's REFUND_S3_* vars still need to be set manually once its EU bucket is provisioned (infra/README.md § Variable reference)."
echo "   Reminder: every caller's SERVICE_CLIENT_SECRET (refund-api, estimai-api, inventory-api), auth's SERVICE_CLIENTS and inventory-api's INVENTORY_S3_* are manual (infra/README.md § Notify credential rollout, step 3, § inventory-api service)."
