#!/usr/bin/env bash
# infra/meetings-gcs-transient-policy.sh - apply or verify the rules of the meetings TRANSIENT
# Google Cloud Storage bucket (specs/021-meetings, plan "Amendment 2026-11-05" G-2 and check N2,
# ADR-0069, AC-4.4, AC-4.9).
#
# WHY THIS EXISTS. Cloud Speech-to-Text v2 batch recognition (Chirp 3) accepts audio ONLY as a
# gs:// object, so every transcription attempt copies its audio parts into this bucket and Google
# writes the result back to it. The bucket is a transient processing hop, never a place audio is
# kept (the audio of record is the Railway bucket, ADR-0063). meetings-api reads the same facts at
# startup (check N2) and REFUSES TO START when one is wrong; this script is the operator's way to
# set them and to prove them BEFORE a deploy, without starting the service.
#
# THE RULES (N2). All of them must hold; anything unreadable is a refusal, never a pass:
#   - location: the EU multi-region, or ONE EU/CH single region from the allowlist below
#               (London, EUROPE-WEST2, and every non-EU location are refused; so are dual-regions)
#   - lifecycle: an enabled Delete rule whose ONLY condition is age <= 1 day (no matchesPrefix,
#               matchesSuffix, storage class, createdBefore or other narrowing). A backstop only:
#               lifecycle runs asynchronously, deletion is the service's job
#   - soft delete OFF: retention duration 0 (Cloud Storage enables 7 days on every new bucket, which
#               would leave a deleted object recoverable for a week)
#   - versioning off; no retention policy; no default event-based hold (a hold or a lock blocks deletion)
#   - uniform bucket-level access on; public access prevention enforced
#
# USAGE
#   infra/meetings-gcs-transient-policy.sh --check --bucket <name> [--project <id>]
#   infra/meetings-gcs-transient-policy.sh --apply --bucket <name> [--project <id>] [--force]
#
#   --check          read-only: verify the rules, change nothing. Exit 0 only when all of them hold.
#   --apply          set the rules (REPLACES the bucket's lifecycle configuration), then run --check.
#                    Never creates the bucket (the README has the one-time create command), never
#                    changes IAM, never touches objects. It refuses a bucket that holds anything outside
#                    transcribe/ unless --force, so a mistyped name cannot put a 1-day expiry on another
#                    bucket's data.
#   --bucket <name>  the transient bucket (env: MEETINGS_GCS_TRANSIENT_BUCKET). A bare name, not gs://...
#   --project <id>   the Google Cloud project (env: MEETINGS_GCP_PROJECT_ID); optional, passed to gcloud.
#   --force          --apply onto a bucket that already holds objects outside transcribe/.
#
# CREDENTIALS. gcloud uses the OPERATOR's own login (gcloud auth login); this script never reads or
# prints a key and never takes one as an argument. It needs storage.buckets.get (check) and
# storage.buckets.update (apply) on the bucket: the runtime service account has neither beyond get,
# so run this as a person. Nothing secret is ever printed.
#
# EXIT CODES  0 the rules hold (or were applied and now hold) - 1 they do not hold / refused
#             2 usage error - 3 cannot tell (gcloud or jq missing, not logged in, access denied,
#             unreachable). A check that cannot read the bucket is NEVER a pass.
#
# REQUIRES    the gcloud CLI (Google Cloud SDK) and jq. Uses 'gcloud storage', not gsutil.
#
# NOT CHECKED HERE (go-live sign-offs H1-H6 and bucket IAM bindings): see infra/README.md, section
# "meetings-api service" -> "Google Cloud sign-offs". Test harness: infra/meetings-gcs-transient-policy.test.sh.

set -uo pipefail

KEY_PREFIX="transcribe"   # every object meetings-api writes here lives under transcribe/<meetingId>/
MAX_AGE_DAYS=1

# Allowed bucket locations (uppercase, as the API reports them). KEEP EQUAL to the allowlist in
# meetings-api's startup check N2 (meetings-api/src/lib/google/transientStorage.ts, plan G-2): a
# wider list here would let this script pass a bucket the service then refuses. EUROPE-WEST2
# (London) is deliberately absent. Dual-regions (EUR4, ...) are refused: plan G-2 allows only the EU
# multi-region or one EU/CH single region.
ALLOWED_LOCATIONS="EU EUROPE-CENTRAL2 EUROPE-NORTH1 EUROPE-NORTH2 EUROPE-SOUTHWEST1 EUROPE-WEST1 EUROPE-WEST3 EUROPE-WEST4 EUROPE-WEST6 EUROPE-WEST8 EUROPE-WEST9 EUROPE-WEST12"

MODE=""; BUCKET="${MEETINGS_GCS_TRANSIENT_BUCKET:-}"; PROJECT="${MEETINGS_GCP_PROJECT_ID:-}"; FORCE=false

usage() { sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "error: $1" >&2; exit "${2:-2}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --bucket) BUCKET="${2:-}"; shift ;;
    --project) PROJECT="${2:-}"; shift ;;
    --force) FORCE=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[[ -n "$MODE" ]] || die "pass --check or --apply (see --help)"
[[ -n "$BUCKET" ]] || die "--bucket is required (or MEETINGS_GCS_TRANSIENT_BUCKET)"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || die "--bucket must be a bare bucket name (3-63 chars: lowercase letters, digits, - _ .), not a gs:// URL"
if [[ -n "$PROJECT" ]]; then
  [[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "--project is not a valid project id"
fi

command -v gcloud >/dev/null 2>&1 || die "the gcloud CLI is required (https://cloud.google.com/sdk/docs/install)" 3
command -v jq >/dev/null 2>&1 || die "jq is required" 3

WORK="$(mktemp -d)" || die "cannot create a temporary directory" 3
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/out.json"; ERR="$WORK/err.txt"

# A non-interactive, quiet gcloud that never opens a prompt or a browser, and is pinned to the project
# when one is given (--project goes on every call so an ambient default project is never used by accident).
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=1
PROJECT_ARGS=(); [[ -n "$PROJECT" ]] && PROJECT_ARGS=(--project "$PROJECT")

FAILS=0
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }
warn() { echo "  WARN  $*"; }

# gc <args...>: stdout -> $OUT, stderr -> $ERR, returns gcloud's exit code.
# (${arr[@]+...} keeps an empty array legal under set -u on bash 3.2, the macOS default)
gc() { gcloud --quiet "$@" ${PROJECT_ARGS[@]+"${PROJECT_ARGS[@]}"} >"$OUT" 2>"$ERR"; }
err_has() { grep -Eqi "$1" "$ERR"; }
err_line() { head -n 1 "$ERR" | tr -d '\r' | cut -c1-300; }

# An error that means "I could not find out", as opposed to "the answer is no". Exits 3.
cannot_tell() {
  local what="$1"
  if err_has 'does not have|permission|PERMISSION_DENIED|403|forbidden|access denied'; then
    echo "  ??    $what: access denied (the caller needs storage.buckets.get/update on the bucket)" >&2
  elif err_has 'not.*(logged|authenticated)|gcloud auth login|credentials|reauthentication'; then
    echo "  ??    $what: gcloud is not logged in (gcloud auth login)" >&2
  elif err_has 'unreachable|network|timed out|Could not resolve|connection'; then
    echo "  ??    $what: Google Cloud Storage is unreachable" >&2
  else
    echo "  ??    $what: $(err_line)" >&2
  fi
  echo "cannot verify the rules; this is not a pass (exit 3)" >&2
  exit 3
}

# ---------------------------------------------------------------------------------------------
# describe: fetch the bucket's metadata in the JSON API's own field names (--raw), which is also what
# meetings-api reads at startup, so the two cannot disagree about a property's spelling.
describe() {
  if gc storage buckets describe "gs://$BUCKET" --raw --format=json; then
    if ! jq -e 'type == "object" and (.location != null)' "$OUT" >/dev/null 2>&1; then
      echo "  ??    bucket metadata is not the expected JSON; this is not a pass (exit 3)" >&2
      exit 3
    fi
    return 0
  fi
  if err_has '404|not found|does not exist|NotFound'; then
    fail "bucket '$BUCKET' does not exist (create it first, see infra/README.md; this script never creates it)"
    return 1
  fi
  cannot_tell "buckets describe"
}

check_all() {
  describe || return 1
  local loc
  loc="$(jq -r '.location // "" | ascii_upcase' "$OUT")"
  if [[ " $ALLOWED_LOCATIONS " == *" $loc "* ]]; then
    pass "location is $loc (EU multi-region or an EU/CH single region)"
  else
    fail "location '$loc' is not allowed: only the EU multi-region or one EU/CH single region from the allowlist (London, dual-regions and non-EU are refused)"
  fi

  # Lifecycle: an enabled Delete rule, ONLY condition age <= 1. A rule with any other condition key
  # (matchesPrefix, matchesSuffix, matchesStorageClass, createdBefore, isLive, numNewerVersions, ...)
  # is narrower than the whole bucket and does not count.
  local good total
  total="$(jq '[.lifecycle.rule[]?] | length' "$OUT")"
  good="$(jq --argjson max "$MAX_AGE_DAYS" '
    [ .lifecycle.rule[]?
      | select(.action.type == "Delete")
      | select((.condition // {}) | keys == ["age"])
      | select(.condition.age != null and (.condition.age | type) == "number" and .condition.age <= $max)
    ] | length' "$OUT")"
  if [[ "$good" -ge 1 ]]; then
    pass "lifecycle: a Delete rule on age <= ${MAX_AGE_DAYS} day with no other condition (no prefix, suffix, class or date filter)"
    if [[ "$(jq '[.lifecycle.rule[]? | select(.action.type == "Delete" and .condition.age == 0)] | length' "$OUT")" -ge 1 ]]; then
      warn "lifecycle: a rule with age 0 deletes objects as soon as the next lifecycle run sees them, possibly mid-attempt; age 1 is the intended value"
    fi
  else
    fail "lifecycle: no Delete rule with age <= ${MAX_AGE_DAYS} and no other condition (rules: $total; a matchesPrefix/matchesSuffix/storage-class/createdBefore condition, age > ${MAX_AGE_DAYS} or a non-Delete action does not count)"
  fi
  if [[ "$total" -gt 1 ]]; then warn "lifecycle: $total rules present; only the whole-bucket age rule is required, check the others are intended"; fi

  # Soft delete: must be present AND 0. Absent is unreadable, which is a refusal (the service does the same).
  local sd
  sd="$(jq -r '.softDeletePolicy.retentionDurationSeconds // "absent"' "$OUT")"
  if [[ "$sd" == "0" ]]; then
    pass "soft delete is off (retention 0)"
  elif [[ "$sd" == "absent" ]]; then
    fail "soft delete policy could not be read: treated as on (a deleted object may stay recoverable)"
  else
    fail "soft delete retains deleted objects for ${sd} s: a deleted object stays recoverable, which breaks the deletion promise (apply sets it to 0)"
  fi

  if [[ "$(jq -r '.versioning.enabled // false' "$OUT")" == "false" ]]; then
    pass "versioning is off"
  else
    fail "versioning is ENABLED: a delete would stay recoverable (apply switches it off)"
  fi

  if [[ "$(jq -r '.retentionPolicy // null | type' "$OUT")" == "null" ]]; then
    pass "no retention policy"
  else
    fail "a retention policy is set: objects cannot be deleted before it elapses (apply clears it unless it is locked; a LOCKED policy means recreating the bucket)"
  fi

  if [[ "$(jq -r '.defaultEventBasedHold // false' "$OUT")" == "false" ]]; then
    pass "no default event-based hold"
  else
    fail "default event-based hold is on: new objects cannot be deleted until released (apply switches it off)"
  fi

  if [[ "$(jq -r '.iamConfiguration.uniformBucketLevelAccess.enabled // false' "$OUT")" == "true" ]]; then
    pass "uniform bucket-level access is on"
  else
    fail "uniform bucket-level access is off (apply switches it on)"
  fi

  if [[ "$(jq -r '.iamConfiguration.publicAccessPrevention // "absent"' "$OUT")" == "enforced" ]]; then
    pass "public access prevention is enforced"
  else
    fail "public access prevention is not 'enforced' (apply enforces it)"
  fi
  [[ "$FAILS" -eq 0 ]]
}

# ---------------------------------------------------------------------------------------------
apply_all() {
  describe || exit 1
  # Refuse a bucket that holds anything outside transcribe/: --apply replaces the lifecycle
  # configuration, and a 1-day Delete rule on the wrong bucket would destroy its data.
  if ! gc storage ls "gs://$BUCKET/"; then cannot_tell "listing the bucket"; fi
  local stray
  stray="$(grep -v -x -e "gs://${BUCKET}/${KEY_PREFIX}/" -e '' "$OUT" | head -n 3 | tr '\n' ' ')"
  if [[ -n "$stray" ]] && ! $FORCE; then
    echo "  FAIL  the bucket holds objects outside ${KEY_PREFIX}/ (e.g. ${stray}): refusing to put a ${MAX_AGE_DAYS}-day delete rule on it; use the right bucket, or --force if you are sure" >&2
    exit 1
  fi

  local lc="$WORK/lifecycle.json"
  printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":%d}}]}\n' "$MAX_AGE_DAYS" >"$lc"

  # One update. Soft delete 0 disables it; --clear-retention-period fails on a LOCKED policy (by design:
  # that bucket must be recreated), which surfaces below as a failed apply, never a silent pass.
  if ! gc storage buckets update "gs://$BUCKET" \
        --lifecycle-file="$lc" \
        --soft-delete-duration=0 \
        --no-versioning \
        --clear-retention-period \
        --no-default-event-based-hold \
        --uniform-bucket-level-access \
        --public-access-prevention; then
    echo "  FAIL  buckets update was refused: $(err_line)" >&2
    exit 1
  fi
  echo "  applied: lifecycle (Delete, age ${MAX_AGE_DAYS}), soft delete 0, versioning off, no retention, no default hold, uniform access, public access prevention"
  echo "verifying what was applied:"
}

if [[ "$MODE" == "apply" ]]; then apply_all; fi
if check_all; then
  echo "OK: the transient bucket rules hold"
  exit 0
fi
echo "the transient bucket rules do NOT hold ($FAILS failing)" >&2
exit 1
