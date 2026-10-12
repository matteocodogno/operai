#!/usr/bin/env bash
# infra/provision-tool.sh — create (or audit) the production infrastructure of
# ONE Operai tool: its Railway backend, its Vercel remote, and their DNS.
#
# It covers what infra/deploy.sh deliberately leaves manual: creating the
# Railway service, its logical database on the shared Postgres, its bucket, the
# custom domains, the Vercel project, the Cloudflare DNS records and the shell
# wiring. It never sets a secret and never reads one.
#
# USAGE
#   ./infra/provision-tool.sh <tool> [options]            # PLAN: read-only audit
#   ./infra/provision-tool.sh <tool> [options] --apply    # create what is missing
#
#   <tool>            e.g. `inventory` → service `inventory-api`, remote
#                     `inventory-ui`, Vercel project `inventory`, database
#                     `inventory`, hosts inventory[-api].operai.welld.io
#   --port <n>        the backend's port (default: PORT in its env-doctor template)
#   --bucket          the backend owns a private EU bucket named <tool>
#   --no-api          frontend only          --no-ui   backend only
#   --connect         connect the GitHub repo to the Railway service. This starts
#                     the FIRST BUILD — pass it only once the service's secrets
#                     are set (the plan lists the variables still missing).
#   --redeploy-shell  redeploy the shell after its two variables were added
#                     (they are read at build time)
#   --apply           without it nothing is created, changed or deployed
#
# Safe to re-run: every step first checks what exists and only fills gaps. It
# never overwrites a variable, never deletes, never moves a domain.
#
# ORDER MATTERS, and the script enforces it:
#   - DNS records are created right after the domain is attached and BEFORE
#     anything resolves the hostname. A resolver that looks a name up too early
#     caches "no such host" for 30 minutes (the zone's negative TTL). For the
#     same reason this script only ever resolves through 1.1.1.1, never through
#     the system resolver. Do not `curl` a new hostname before it reports the
#     record as live.
#   - A Vercel project created after the push never builds on its own, so the
#     first production deployment is triggered here.
#
# Runbook, human decisions and the lessons behind these rules:
# .claude/skills/provision-tool/SKILL.md and infra/README.md § Provisioning a new tool.

set -uo pipefail

# ─── Config (override via env) ────────────────────────────────────────────────
RAILWAY_PROJECT_ID="${RAILWAY_PROJECT_ID:-3bafd4c0-226f-4621-821b-a063976498a2}"   # project `operai`
RAILWAY_ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
RAILWAY_REGION="${RAILWAY_REGION:-europe-west4-drams3a}"   # EU — data residency (CLAUDE.md)
BUCKET_REGION="${BUCKET_REGION:-ams}"                      # EU — ADR-0016
VERCEL_SCOPE="${VERCEL_SCOPE:-aiscream}"
VERCEL_SHELL_PROJECT="${VERCEL_SHELL_PROJECT:-operai}"
GITHUB_REPO="${GITHUB_REPO:-matteocodogno/operai}"
DNS_ZONE="${DNS_ZONE:-welld.io}"
BASE_DOMAIN="${BASE_DOMAIN:-operai.welld.io}"
SHELL_ORIGIN="${SHELL_ORIGIN:-https://${BASE_DOMAIN}}"
PUBLIC_RESOLVER="${PUBLIC_RESOLVER:-1.1.1.1}"

# ─── Arguments ────────────────────────────────────────────────────────────────
TOOL=""; PORT=""; APPLY=false; WITH_BUCKET=false; DO_API=true; DO_UI=true
CONNECT=false; REDEPLOY_SHELL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --bucket) WITH_BUCKET=true ;;
    --no-api) DO_API=false ;;
    --no-ui) DO_UI=false ;;
    --connect) CONNECT=true ;;
    --redeploy-shell) REDEPLOY_SHELL=true ;;
    --port) PORT="${2:-}"; shift ;;
    -h|--help) sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [[ -z "$TOOL" ]] && TOOL="$1" || { echo "unexpected argument: $1" >&2; exit 2; } ;;
  esac
  shift
done
[[ "$TOOL" =~ ^[a-z][a-z0-9]{1,30}$ ]] || { echo "usage: $0 <tool> [--port n] [--bucket] [--no-api|--no-ui] [--connect] [--redeploy-shell] [--apply]" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT" || exit 1
API_SVC="${TOOL}-api"; UI_DIR="${TOOL}-ui"; DB_NAME="$TOOL"; BUCKET_NAME="$TOOL"; VERCEL_PROJECT="$TOOL"
API_HOST="${TOOL}-api.${BASE_DOMAIN}"; UI_HOST="${TOOL}.${BASE_DOMAIN}"
UPPER="$(printf '%s' "$TOOL" | tr '[:lower:]' '[:upper:]')"
TEMPLATE="tools/env-doctor/templates/production/${API_SVC}.env"

# ─── Output helpers ───────────────────────────────────────────────────────────
c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
MISSING=0; DONE=0; FAILED=0; TODO=()
section() { echo; echo "$(c '1;37' "== $* ==")"; }
have()    { echo "  $(c '0;32' '✓') $*"; }
need()    { MISSING=$((MISSING+1)); echo "  $(c '1;33' '+') $*"; }          # missing, would be created
did()     { DONE=$((DONE+1)); echo "  $(c '0;32' '✓') created: $*"; }
bad()     { FAILED=$((FAILED+1)); echo "  $(c '0;31' '✗') $*"; }
note()    { echo "  $(c '0;34' '•') $*"; }
todo()    { TODO+=("$*"); }
die()     { echo "$(c '0;31' 'ERROR:') $*" >&2; exit 1; }

# vapi <METHOD> <path> [json-body] — the Vercel REST API through the logged-in CLI.
vapi() {
  local method="$1" path="$2" body="${3:-}" sep='?'
  [[ "$path" == *\?* ]] && sep='&'
  if [[ -n "$body" ]]; then
    printf '%s' "$body" | vercel api "${path}${sep}teamId=${VERCEL_SCOPE}" -X "$method" --input - --scope "$VERCEL_SCOPE" --raw 2>/dev/null
  else
    vercel api "${path}${sep}teamId=${VERCEL_SCOPE}" -X "$method" --scope "$VERCEL_SCOPE" --raw 2>/dev/null
  fi
}

# dns_ensure <TYPE> <fqdn> <content> — DNS-only record (never proxied: Railway
# and Vercel terminate TLS themselves), automatic TTL, like every operai record.
DNS_CACHE=""
dns_ensure() {
  local type="$1" name="$2" content="$3" current
  [[ -n "$DNS_CACHE" ]] || DNS_CACHE="$(cf dns records list -z "$DNS_ZONE" 2>/dev/null)"
  current="$(printf '%s' "$DNS_CACHE" | jq -r --arg t "$type" --arg n "$name" '(if type=="array" then . else (.result // []) end)[] | select(.type==$t and .name==$n) | .content' 2>/dev/null | head -1)"
  current="${current%\"}"; current="${current#\"}"; current="${current%.}"
  if [[ -n "$current" ]]; then
    if [[ "$current" == "${content%.}" ]]; then have "DNS $type $name"
    else bad "DNS $type $name exists with a DIFFERENT value — not touched; fix it by hand"; fi
    return
  fi
  if ! $APPLY; then need "DNS $type $name → ${content%.}"; return; fi
  local value="${content%.}"; [[ "$type" == "TXT" ]] && value="\"${value}\""
  local body; body="$(jq -nc --arg t "$type" --arg n "$name" --arg v "$value" '{type:$t,name:$n,content:$v,ttl:1} + (if $t=="CNAME" then {proxied:false} else {} end)')"
  if cf dns records create -z "$DNS_ZONE" --body "$body" >/dev/null 2>&1; then did "DNS $type $name"; DNS_CACHE=""
  else bad "could not create DNS $type $name"; fi
}

# resolves <fqdn> — through a PUBLIC resolver only (see ORDER MATTERS above).
resolves() { [[ -n "$(dig +short "$1" "@${PUBLIC_RESOLVER}" 2>/dev/null | head -1)" ]]; }

# ─── Preflight ────────────────────────────────────────────────────────────────
section "Preflight ($($APPLY && echo APPLY || echo 'plan — nothing will be changed'))"
for t in jq dig git; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done
if $DO_API; then
  command -v railway >/dev/null 2>&1 || die "railway CLI not found"
  railway whoami >/dev/null 2>&1 || die "not logged in to Railway — run: railway login"
  [[ -f "${API_SVC}/Dockerfile" ]] || die "${API_SVC}/Dockerfile not found — is <tool> right?"
  [[ -f "${API_SVC}/railway.json" ]] || die "${API_SVC}/railway.json not found (the build/deploy settings are read from it)"
  [[ -f "$TEMPLATE" ]] || die "$TEMPLATE not found — add the service to tools/env-doctor first (it is the committed variable contract)"
  [[ -n "$PORT" ]] || PORT="$(grep -E '^PORT=' "$TEMPLATE" | head -1 | cut -d= -f2)"
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "no port: pass --port <n> or add PORT= to $TEMPLATE"
  have "backend ${API_SVC} (port ${PORT})"
fi
if $DO_UI; then
  command -v vercel >/dev/null 2>&1 || die "vercel CLI not found"
  vercel whoami >/dev/null 2>&1 || die "not logged in to Vercel — run: vercel login"
  [[ -f "${UI_DIR}/vercel.json" ]] || die "${UI_DIR}/vercel.json not found — is <tool> right?"
  have "frontend ${UI_DIR}"
fi
command -v cf >/dev/null 2>&1 || die "cf (Cloudflare CLI) not found"
cf dns records list -z "$DNS_ZONE" >/dev/null 2>&1 || die "cf cannot read zone ${DNS_ZONE} — log in to Cloudflare first"
have "Cloudflare zone ${DNS_ZONE}"

git fetch -q origin main 2>/dev/null || note "could not fetch origin/main — using the local copy of it"
ON_MAIN=true
for d in $($DO_API && echo "$API_SVC") $($DO_UI && echo "$UI_DIR"); do
  if git cat-file -e "origin/main:${d}/package.json" 2>/dev/null; then have "${d} is on origin/main"
  else ON_MAIN=false; bad "${d} is NOT on origin/main — push first: Railway and Vercel build from GitHub"; fi
done

# ─── Railway backend ──────────────────────────────────────────────────────────
if $DO_API; then
  section "Railway — ${API_SVC}"
  railway link -p "$RAILWAY_PROJECT_ID" -e "$RAILWAY_ENVIRONMENT" >/dev/null 2>&1 || die "could not link Railway project ${RAILWAY_PROJECT_ID}"

  # 1. Logical database on the shared Postgres. The service's preDeployCommand
  #    runs its migrations, so the database must exist before the first deploy.
  #    The URL stays inside the child process; nothing is printed but the answer.
  pg() { # pg <sql> — prints the result, or returns 9 when no psql client is available
    local runner pgc
    if command -v psql >/dev/null 2>&1; then runner='psql "$DATABASE_PUBLIC_URL" -At -v ON_ERROR_STOP=1'
    else
      # No local client: borrow psql from any running Postgres container (e.g. the
      # repo's compose one). `docker exec`, not `docker compose exec` — compose
      # re-reads every service's env file and fails if one of them is malformed.
      pgc="$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '$2 ~ /postgres/ {print $1; exit}')"
      [[ -n "$pgc" ]] || return 9
      runner="docker exec -i -e DATABASE_PUBLIC_URL ${pgc} sh -c 'psql \"\$DATABASE_PUBLIC_URL\" -At -v ON_ERROR_STOP=1'"
    fi
    printf '%s\n' "$1" | railway run -s Postgres -- sh -c 'test -n "$DATABASE_PUBLIC_URL" || exit 8; '"$runner" 2>/dev/null
  }
  db_exists="$(pg "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}';")"; pg_rc=$?
  if [[ $pg_rc -eq 9 ]]; then
    bad "cannot check database '${DB_NAME}': no psql on PATH and no running Postgres container to borrow one from (docker compose up -d postgres)"
  elif [[ "$db_exists" == "1" ]]; then have "database '${DB_NAME}' on the shared Postgres"
  elif ! $APPLY; then need "database '${DB_NAME}' on the shared Postgres"
  elif pg "CREATE DATABASE ${DB_NAME};" >/dev/null && [[ "$(pg "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}';")" == "1" ]]; then did "database '${DB_NAME}'"
  else bad "could not create database '${DB_NAME}' (railway connect Postgres → CREATE DATABASE ${DB_NAME};)"; fi

  # 2. Bucket — the tool's OWN, never another tool's (CLAUDE.md § Data residency).
  if $WITH_BUCKET; then
    if railway bucket list --json 2>/dev/null | jq -e --arg n "$BUCKET_NAME" 'any(.[]; .name==$n)' >/dev/null; then have "bucket '${BUCKET_NAME}'"
    elif ! $APPLY; then need "bucket '${BUCKET_NAME}' (region ${BUCKET_REGION})"
    elif railway bucket create "$BUCKET_NAME" --region "$BUCKET_REGION" --json >/dev/null 2>&1; then did "bucket '${BUCKET_NAME}' (${BUCKET_REGION})"
    else bad "could not create bucket '${BUCKET_NAME}'"; fi
    todo "Bucket '${BUCKET_NAME}': set a CORS rule for ${SHELL_ORIGIN} (POST, GET; expose ETag, Location) and test one browser upload — this script cannot set or read bucket CORS."
  fi

  # 3. The service itself, created empty: no source, so nothing builds yet.
  svc_json="$(railway service list --json 2>/dev/null | jq -c --arg n "$API_SVC" '.[] | select(.name==$n)' 2>/dev/null)"
  if [[ -n "$svc_json" ]]; then have "service ${API_SVC}"; SVC_EXISTS=true
  elif ! $APPLY; then need "service ${API_SVC} (empty, no source yet)"; SVC_EXISTS=false
  elif railway add --service "$API_SVC" --json >/dev/null 2>&1; then did "service ${API_SVC}"; SVC_EXISTS=true
  else bad "could not create service ${API_SVC}"; SVC_EXISTS=false; fi

  if $SVC_EXISTS; then
    # 4. Build/deploy settings, copied from the service's own railway.json.
    #    Railway no longer lets a new service register a config-file path, so the
    #    file's values are set on the service directly; the file stays the source.
    cfg() { railway environment config --json 2>/dev/null | jq -c --arg id "$(railway service list --json 2>/dev/null | jq -r --arg n "$API_SVC" '.[] | select(.name==$n) | .id')" '.services[$id] | del(.variables)'; }
    live="$(cfg)"
    want_pairs="$(jq -r --arg root "/${API_SVC}" --arg region "$RAILWAY_REGION" '
      [ ["source.rootDirectory", $root],
        ["build.builder", (.build.builder // empty)],
        ["build.dockerfilePath", (.build.dockerfilePath // empty)],
        ["deploy.startCommand", (.deploy.startCommand // empty)],
        ["deploy.healthcheckPath", (.deploy.healthcheckPath // empty)],
        ["deploy.healthcheckTimeout", (.deploy.healthcheckTimeout // empty)],
        ["deploy.restartPolicyMaxRetries", (.deploy.restartPolicyMaxRetries // empty)],
        ["deploy.preDeployCommand", (.deploy.preDeployCommand // empty)],
        ["deploy.multiRegionConfig.\($region).numReplicas", 1]
      ] | .[] | select(.[1] != null) | "\(.[0])\t\(.[1])"' "${API_SVC}/railway.json")"
    cfgfile="$(printf '%s' "$live" | jq -r '.configFile // empty')"
    if [[ -n "$cfgfile" ]]; then
      # Older services registered their railway.json before Railway stopped
      # accepting that; the file drives them, so there is nothing to copy.
      have "build and deploy settings come from the registered config file ${cfgfile}"
    else
      drift=0
      while IFS=$'\t' read -r path want; do
        [[ -n "$path" ]] || continue
        got="$(printf '%s' "$live" | jq -r --arg p "$path" 'getpath($p | split(".")) | if type=="array" then join(" && ") else (. // "") end | tostring' 2>/dev/null)"
        if [[ "$got" == "$want" ]]; then continue; fi
        drift=$((drift+1))
        if ! $APPLY; then need "setting ${path} = ${want}"; continue; fi
        if railway environment edit -e "$RAILWAY_ENVIRONMENT" --service-config "$API_SVC" "$path" "$want" -m "provision ${API_SVC}: ${path}" --json >/dev/null 2>&1; then did "setting ${path}"
        else bad "could not set ${path} = ${want} — set it in the dashboard"; fi
      done <<< "$want_pairs"
      [[ $drift -eq 0 ]] && have "build and deploy settings match ${API_SVC}/railway.json (root /${API_SVC}, region ${RAILWAY_REGION})"
      if $APPLY && [[ $drift -gt 0 ]]; then
        # Re-read: the CLI's handling of numbers and lists is not documented, so trust only what the service now reports.
        live="$(cfg)"
        while IFS=$'\t' read -r path want; do
          [[ -n "$path" ]] || continue
          got="$(printf '%s' "$live" | jq -r --arg p "$path" 'getpath($p | split(".")) | if type=="array" then join(" && ") else (. // "") end | tostring' 2>/dev/null)"
          [[ "$got" == "$want" ]] || bad "after apply, ${path} is '${got}', expected '${want}' — fix it in the dashboard"
        done <<< "$want_pairs"
      fi
    fi

    # 5. Variables: every KEY=VALUE of the committed env-doctor template (Railway
    #    reference syntax, no secret values) plus the bucket's credentials BY
    #    REFERENCE. A name that already exists is never overwritten.
    names="$(railway variables --service "$API_SVC" --kv 2>/dev/null | cut -d= -f1)"
    set_var() { # set_var <NAME> <value>
      if printf '%s\n' "$names" | grep -qx "$1"; then return 0; fi
      if ! $APPLY; then need "variable $1"; return 0; fi
      if railway variable set "$1=$2" --service "$API_SVC" --skip-deploys --json >/dev/null 2>&1; then did "variable $1"
      else bad "could not set variable $1"; fi
    }
    before=$MISSING
    while IFS= read -r line; do
      case "$line" in ''|\#*) continue ;; esac
      set_var "${line%%=*}" "${line#*=}"
    done < "$TEMPLATE"
    if $WITH_BUCKET; then
      set_var "${UPPER}_S3_BUCKET" "\${{${BUCKET_NAME}.BUCKET}}"
      set_var "${UPPER}_S3_ENDPOINT" "\${{${BUCKET_NAME}.ENDPOINT}}"
      set_var "${UPPER}_S3_ACCESS_KEY_ID" "\${{${BUCKET_NAME}.ACCESS_KEY_ID}}"
      set_var "${UPPER}_S3_SECRET_ACCESS_KEY" "\${{${BUCKET_NAME}.SECRET_ACCESS_KEY}}"
    fi
    [[ $MISSING -eq $before ]] && ! $APPLY && have "every template variable is present"
    # What the service's own env.ts requires but nobody has set: the secrets.
    names="$(railway variables --service "$API_SVC" --kv 2>/dev/null | cut -d= -f1)"
    unset_required=""
    if [[ -f "${API_SVC}/.env.example" ]] || [[ -f "${API_SVC}/src/lib/env.ts" ]]; then
      for v in $(grep -oE '^[[:space:]]+[A-Z][A-Z0-9_]{2,}:' "${API_SVC}/src/lib/env.ts" 2>/dev/null | tr -d ' :' | sort -u); do
        printf '%s\n' "$names" | grep -qx "$v" || unset_required="${unset_required} ${v}"
      done
    fi
    if [[ -n "$unset_required" ]]; then
      note "declared in ${API_SVC}/src/lib/env.ts but not set on the service:${unset_required}"
      note "  (some may be optional — check env.ts; the required ones make the service exit at startup)"
      todo "Set the remaining variables on ${API_SVC} in Railway (secrets by hand or by reference, never through this script):${unset_required}"
    fi

    # 6. Custom domain, then 7. its DNS records IMMEDIATELY.
    if railway domain list --service "$API_SVC" --json 2>/dev/null | jq -e --arg d "$API_HOST" 'any(.domains[]?; .domain==$d)' >/dev/null; then have "custom domain ${API_HOST}"; DOMAIN_OK=true
    elif ! $APPLY; then need "custom domain ${API_HOST} → port ${PORT}"; DOMAIN_OK=false
    elif railway domain "$API_HOST" --service "$API_SVC" --port "$PORT" --json >/dev/null 2>&1; then did "custom domain ${API_HOST} → port ${PORT}"; DOMAIN_OK=true
    else bad "could not attach ${API_HOST}"; DOMAIN_OK=false; fi
    if $DOMAIN_OK; then
      st="$(railway domain status "$API_HOST" --service "$API_SVC" --json 2>/dev/null)"
      cname="$(printf '%s' "$st" | jq -r '.domain.dnsRecords[]? | select(.recordType|test("CNAME")) | .requiredValue' | head -1)"
      vhost="$(printf '%s' "$st" | jq -r '.domain.verification.dnsHost // empty')"
      vtoken="$(printf '%s' "$st" | jq -r '.domain.verification.token // empty')"
      [[ -n "$cname" ]] && dns_ensure CNAME "$API_HOST" "$cname" || bad "Railway did not report the CNAME target for ${API_HOST}"
      [[ -n "$vhost" && -n "$vtoken" ]] && dns_ensure TXT "${vhost}.${DNS_ZONE}" "$vtoken"
      cert="$(printf '%s' "$st" | jq -r '.domain.certificate.status // "unknown"')"
      [[ "$cert" == *VALID* && "$cert" != *VALIDATING* ]] && have "certificate issued for ${API_HOST}" || note "certificate for ${API_HOST}: ${cert} (Railway issues it a few minutes after the DNS records exist and the service has deployed)"
    else
      $APPLY || need "DNS CNAME + TXT for ${API_HOST} (values come from Railway once the domain is attached)"
    fi

    # 8. Source. Connecting the repo starts the first build, so it is opt-in.
    src="$(printf '%s' "$live" | jq -r '.source.repo // empty')"
    if [[ -n "$src" ]]; then have "source ${src}"
    elif ! $CONNECT; then
      note "source not connected — re-run with --connect once the variables above are set (it starts the first build)"
      todo "Connect ${API_SVC} to ${GITHUB_REPO}: re-run this script with --connect --apply."
    elif ! $ON_MAIN; then bad "not connecting the source: ${API_SVC} is not on origin/main"
    elif ! $APPLY; then need "source ${GITHUB_REPO}@main (starts the first build)"
    elif railway service source connect --repo "$GITHUB_REPO" --branch main --service "$API_SVC" --json >/dev/null 2>&1; then did "source ${GITHUB_REPO}@main — first build started"
    else bad "could not connect ${GITHUB_REPO} to ${API_SVC}"; fi
  fi
fi

# ─── Vercel frontend ──────────────────────────────────────────────────────────
if $DO_UI; then
  section "Vercel — ${VERCEL_PROJECT} (${UI_DIR})"
  proj="$(vapi GET "/v9/projects/${VERCEL_PROJECT}")"
  if printf '%s' "$proj" | jq -e '.id' >/dev/null 2>&1; then
    root="$(printf '%s' "$proj" | jq -r '.rootDirectory // ""')"
    [[ "$root" == "$UI_DIR" ]] && have "project ${VERCEL_PROJECT} (root ${UI_DIR})" || bad "project ${VERCEL_PROJECT} exists with root '${root}', expected '${UI_DIR}' — not touched"
    PROJ_OK=true
  elif ! $APPLY; then need "project ${VERCEL_PROJECT} (root ${UI_DIR}, Vite, git ${GITHUB_REPO})"; PROJ_OK=false
  else
    body="$(jq -nc --arg n "$VERCEL_PROJECT" --arg r "$UI_DIR" --arg g "$GITHUB_REPO" '{name:$n,framework:"vite",rootDirectory:$r,gitRepository:{type:"github",repo:$g}}')"
    proj="$(vapi POST "/v11/projects" "$body")"
    if printf '%s' "$proj" | jq -e '.id' >/dev/null 2>&1; then did "project ${VERCEL_PROJECT}"; PROJ_OK=true
    else bad "could not create project ${VERCEL_PROJECT}: $(printf '%s' "$proj" | jq -r '.error.message // "unknown error"' 2>/dev/null)"; PROJ_OK=false; fi
  fi

  # vercel_env <project> <NAME> <value> — production + preview, like the other projects.
  # One variable per request: the API's array form is not accepted through the CLI.
  vercel_env() {
    local project="$1" name="$2" value="$3" envs="$4"
    if printf '%s' "$envs" | jq -e --arg k "$name" 'any(.env[]?; .key==$k)' >/dev/null 2>&1; then have "${project}: ${name}"; return 0; fi
    if ! $APPLY; then need "${project}: ${name}=${value}"; return 1; fi
    local out; out="$(vapi POST "/v10/projects/${project}/env" "$(jq -nc --arg k "$name" --arg v "$value" '{key:$k,value:$v,type:"encrypted",target:["production","preview"]}')")"
    if printf '%s' "$out" | jq -e '(.created.key // .key)' >/dev/null 2>&1; then did "${project}: ${name}"; return 1
    else bad "could not set ${name} on ${project}"; return 0; fi
  }

  if $PROJ_OK; then
    vercel_env "$VERCEL_PROJECT" SHELL_REMOTE_URL "${SHELL_ORIGIN}/remoteEntry.js" "$proj" || true

    # Domain, then its DNS record IMMEDIATELY.
    if vapi GET "/v9/projects/${VERCEL_PROJECT}/domains" | jq -e --arg d "$UI_HOST" 'any(.domains[]?; .name==$d)' >/dev/null 2>&1; then have "domain ${UI_HOST}"; UI_DOMAIN_OK=true
    elif ! $APPLY; then need "domain ${UI_HOST}"; UI_DOMAIN_OK=false
    elif vapi POST "/v10/projects/${VERCEL_PROJECT}/domains" "$(jq -nc --arg d "$UI_HOST" '{name:$d}')" | jq -e '.name' >/dev/null 2>&1; then did "domain ${UI_HOST}"; UI_DOMAIN_OK=true
    else bad "could not attach ${UI_HOST}"; UI_DOMAIN_OK=false; fi
    if $UI_DOMAIN_OK; then
      target="$(vapi GET "/v6/domains/${UI_HOST}/config" | jq -r '(.cnames[0] // (.recommendedCNAME | sort_by(.rank) | .[0].value)) // empty' 2>/dev/null)"
      [[ -n "$target" ]] && dns_ensure CNAME "$UI_HOST" "$target" || bad "Vercel did not report a CNAME target for ${UI_HOST}"
    else
      $APPLY || need "DNS CNAME for ${UI_HOST} (value comes from Vercel once the domain is attached)"
    fi

    # First production deployment: a project created after the push never builds by itself.
    if vapi GET "/v6/deployments?projectId=${VERCEL_PROJECT}&target=production&limit=1" | jq -e '.deployments | length > 0' >/dev/null 2>&1; then have "a production deployment exists"
    elif ! $ON_MAIN; then bad "no deployment yet, and ${UI_DIR} is not on origin/main"
    elif ! $APPLY; then need "first production deployment of ${VERCEL_PROJECT} from main"
    else
      repo_id="$(printf '%s' "$proj" | jq -r '.link.repoId // empty')"
      [[ -n "$repo_id" ]] || repo_id="$(vapi GET "/v9/projects/${VERCEL_PROJECT}" | jq -r '.link.repoId // empty')"
      out="$(vapi POST "/v13/deployments" "$(jq -nc --arg n "$VERCEL_PROJECT" --argjson id "${repo_id:-0}" '{name:$n,project:$n,target:"production",gitSource:{type:"github",repoId:$id,ref:"main"}}')")"
      if printf '%s' "$out" | jq -e '.id' >/dev/null 2>&1; then did "first production deployment started ($(printf '%s' "$out" | jq -r '.url'))"
      else bad "could not start the first deployment: $(printf '%s' "$out" | jq -r '.error.message // "unknown error"' 2>/dev/null)"; fi
    fi
  fi

  # The shell reads both at BUILD time: without them the tool does not load and
  # apiFetch sends no token to the tool's API (every call 401s, silently).
  section "Shell wiring (Vercel project ${VERCEL_SHELL_PROJECT})"
  grep -q "${UPPER}_REMOTE_URL" shell/vite.config.ts 2>/dev/null && have "shell/vite.config.ts reads ${UPPER}_REMOTE_URL" || bad "shell/vite.config.ts does not read ${UPPER}_REMOTE_URL — the remote is not wired into the shell's code"
  csp="$(jq -r '[.headers[]?.headers[]? | select(.key=="Content-Security-Policy") | .value] | join(" ")' shell/vercel.json 2>/dev/null)"
  for h in "https://${UI_HOST}" $($DO_API && echo "https://${API_HOST}"); do
    [[ "$csp" == *"$h"* ]] && have "shell CSP names ${h}" || bad "shell/vercel.json CSP does not name ${h} — add it (script-src and connect-src for the remote, connect-src for the API), commit and push"
  done
  shell_proj="$(vapi GET "/v9/projects/${VERCEL_SHELL_PROJECT}")"
  changed=false
  vercel_env "$VERCEL_SHELL_PROJECT" "${UPPER}_REMOTE_URL" "https://${UI_HOST}/remoteEntry.js" "$shell_proj" || changed=true
  if $DO_API; then vercel_env "$VERCEL_SHELL_PROJECT" "VITE_${UPPER}_API_URL" "https://${API_HOST}" "$shell_proj" || changed=true; fi
  if $REDEPLOY_SHELL && $APPLY; then
    last="$(vapi GET "/v6/deployments?projectId=${VERCEL_SHELL_PROJECT}&target=production&limit=1" | jq -r '.deployments[0].url // empty')"
    if [[ -n "$last" ]] && vercel redeploy "$last" --scope "$VERCEL_SCOPE" --target production >/dev/null 2>&1; then did "shell redeployed"
    else bad "could not redeploy the shell"; fi
  elif $changed; then
    todo "Redeploy the shell so it picks up its new variables: re-run with --redeploy-shell --apply (or push to main)."
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
section "Summary"
if $APPLY; then echo "  ${DONE} created, ${FAILED} problem(s)."
else echo "  ${MISSING} thing(s) missing, ${FAILED} problem(s). Nothing was changed; re-run with --apply to create what is missing."; fi
if [[ ${#TODO[@]} -gt 0 ]]; then
  echo; echo "  Left for a person:"
  for t in "${TODO[@]}"; do echo "   - $t"; done
fi
echo
for h in $($DO_API && echo "$API_HOST") $($DO_UI && echo "$UI_HOST"); do
  resolves "$h" && echo "  ${h} resolves publicly." || echo "  ${h} does not resolve yet — do NOT open or curl it until it does (a too-early lookup is cached for 30 minutes)."
done
echo "  When everything above is green: ./infra/check.sh"
[[ $FAILED -eq 0 ]]
