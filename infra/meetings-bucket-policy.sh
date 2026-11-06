#!/usr/bin/env bash
# infra/meetings-bucket-policy.sh - apply or verify the retention policy of the meetings AUDIO
# bucket on any S3-compatible endpoint (specs/021-meetings, ADR-0063, AC-4.4).
#
# WHY THIS EXISTS. Recorded audio is deleted by the bucket, not by our code: one bucket-wide
# lifecycle rule expires every object after 29 days, with versioning off (a versioned delete is
# recoverable). meetings-api reads the same facts at startup and REFUSES TO START when they are
# wrong; this script is the operator's way to set them and to prove them BEFORE a deploy, without
# starting the service. It also manages the bucket's CORS rule (the browser uploads audio chunks
# straight to the bucket from the shell origin with a presigned POST, and plays it back with a
# presigned GET).
#
# USAGE
#   infra/meetings-bucket-policy.sh --check --endpoint <url> --bucket <name> [options]
#   infra/meetings-bucket-policy.sh --apply --endpoint <url> --bucket <name> [options]
#
#   --check             read-only: verify the policy, change nothing. Exit 0 only when all of it holds.
#   --apply             set the policy (REPLACES the bucket's lifecycle configuration and CORS rules),
#                       then run --check. Never creates the bucket and never touches objects.
#   --endpoint <url>    the S3 endpoint (env: MEETINGS_S3_ENDPOINT). http:// only for localhost.
#   --bucket <name>     the audio bucket (env: MEETINGS_S3_BUCKET).
#   --region <r>        signing region (env: MEETINGS_S3_REGION, default us-east-1; MinIO ignores it).
#   --shell-origin <o>  the origin allowed by CORS (default https://operai.welld.io).
#   --require-cors      CORS is required on every endpoint except loopback (localhost, 127.0.0.1): a
#                       missing rule, or an endpoint that cannot do bucket CORS, FAILS. MinIO has no
#                       per-bucket CORS, so on loopback that step is SKIPped; this flag requires it there too.
#   --no-noncurrent     do not add a noncurrent-version expiration to the rule (for a provider that
#                       rejects it). The bucket is unversioned, so it is only a safety net.
#   --path-style        force path-style addressing (MinIO and most self-hosted endpoints).
#   --force             --apply onto a bucket that already holds objects outside meetings/.
#
# CREDENTIALS come from the environment only, never from a flag or a file: MEETINGS_S3_ACCESS_KEY_ID /
# MEETINGS_S3_SECRET_ACCESS_KEY, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. The script ignores
# ~/.aws and any AWS profile, so an unrelated AWS login can never be sent to a third-party endpoint.
# Nothing secret is ever printed.
#
# EXIT CODES  0 policy holds (or was applied and now holds) - 1 policy does not hold / refused
#             2 usage error - 3 cannot tell (tooling missing, no credentials, unreachable, access denied).
#             A check that cannot reach the bucket is NEVER a pass.
#
# REQUIRES    the AWS CLI (v1 or v2) and jq. Used here only as a generic S3 client against --endpoint.
#
# WHY THESE RULES. See specs/021-meetings/plan.md section "Retention and deletion of bytes" and
# infra/README.md section "Meetings". The rule has NO prefix filter on purpose: it also caps the
# chunks of a meeting that was never processed and abandoned presigned uploads.

set -uo pipefail

RETENTION_DAYS=29
RULE_ID="meetings-audio-expire-${RETENTION_DAYS}d"
KEY_PREFIX="meetings"   # every object meetings-api writes lives under meetings/<meeting id>/

MODE=""; ENDPOINT="${MEETINGS_S3_ENDPOINT:-}"; BUCKET="${MEETINGS_S3_BUCKET:-}"
REGION="${MEETINGS_S3_REGION:-us-east-1}"; SHELL_ORIGIN="https://operai.welld.io"
REQUIRE_CORS=false; LOOPBACK=false; NONCURRENT=true; PATH_STYLE=false; FORCE=false

usage() { sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "error: $1" >&2; exit "${2:-2}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --endpoint) ENDPOINT="${2:-}"; shift ;;
    --bucket) BUCKET="${2:-}"; shift ;;
    --region) REGION="${2:-}"; shift ;;
    --shell-origin) SHELL_ORIGIN="${2:-}"; shift ;;
    --require-cors) REQUIRE_CORS=true ;;
    --no-noncurrent) NONCURRENT=false ;;
    --path-style) PATH_STYLE=true ;;
    --force) FORCE=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[[ -n "$MODE" ]] || die "pass --check or --apply (see --help)"
[[ -n "$ENDPOINT" ]] || die "--endpoint is required (or MEETINGS_S3_ENDPOINT)"
[[ -n "$BUCKET" ]] || die "--bucket is required (or MEETINGS_S3_BUCKET)"
[[ "$BUCKET" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$ ]] || die "--bucket is not a valid bucket name"
[[ "$REGION" =~ ^[a-zA-Z0-9-]{1,32}$ ]] || die "--region is not a valid region name"
[[ "$SHELL_ORIGIN" =~ ^https?://[^/[:space:]]+$ ]] || die "--shell-origin must be an origin: scheme://host[:port], no path or trailing slash"
case "$ENDPOINT" in
  https://*) ;;
  http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://\[::1\]|http://\[::1\]:*) LOOPBACK=true ;;
  http://*) die "refusing a plain-http endpoint that is not localhost: credentials would cross the network in clear" ;;
  *) die "--endpoint must be an http(s) URL" ;;
esac

command -v aws >/dev/null 2>&1 || die "the AWS CLI is required (any S3 client works against --endpoint; this script uses 'aws s3api')" 3
command -v jq >/dev/null 2>&1 || die "jq is required" 3

# Credentials: MEETINGS_S3_* win over AWS_*, so a developer's real AWS keys are not used by accident.
KEY_ID="${MEETINGS_S3_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}"
SECRET="${MEETINGS_S3_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}"
[[ -n "$KEY_ID" && -n "$SECRET" ]] || die "no credentials: set MEETINGS_S3_ACCESS_KEY_ID and MEETINGS_S3_SECRET_ACCESS_KEY (or the AWS_* pair) in the environment" 3

WORK="$(mktemp -d)" || die "cannot create a temporary directory" 3
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/out.json"; ERR="$WORK/err.txt"

# An isolated AWS CLI environment: no profile, no shared config, no session token, no endpoint override.
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_ENDPOINT_URL AWS_ENDPOINT_URL_S3 AWS_CA_BUNDLE
export AWS_ACCESS_KEY_ID="$KEY_ID" AWS_SECRET_ACCESS_KEY="$SECRET" AWS_DEFAULT_REGION="$REGION"
export AWS_SHARED_CREDENTIALS_FILE="$WORK/credentials" AWS_CONFIG_FILE="$WORK/config"
export AWS_PAGER="" AWS_EC2_METADATA_DISABLED=true AWS_RETRY_MODE=standard AWS_MAX_ATTEMPTS=2
# S3-compatible stores reject the extra CRC32 checksums newer CLIs add by default.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
if $PATH_STYLE; then printf '[default]\ns3 =\n    addressing_style = path\n' > "$AWS_CONFIG_FILE"; fi

# Bucket CORS is mandatory except against a loopback dev store (MinIO), unless --require-cors says otherwise.
cors_required() { $REQUIRE_CORS || ! $LOOPBACK; }

FAILS=0
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }
warn() { echo "  WARN  $*"; }
skip() { echo "  SKIP  $*"; }

# s3api <args...>: stdout -> $OUT, stderr -> $ERR, returns the CLI's exit code.
s3api() {
  aws --endpoint-url "$ENDPOINT" --output json --cli-connect-timeout 10 --cli-read-timeout 30 s3api "$@" >"$OUT" 2>"$ERR" || return $?
  [[ -s "$OUT" ]] || echo '{}' >"$OUT"   # the CLI prints nothing for an empty answer (e.g. never-versioned bucket)
}
err_has() { grep -Eq "$1" "$ERR"; }
err_line() { head -n 1 "$ERR" | tr -d '\r' | cut -c1-300; }

# An error that means "I could not find out", as opposed to "the answer is no". Exits 3.
cannot_tell() {
  local what="$1"
  if err_has 'InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|\(403\)|Forbidden'; then
    echo "  ??    $what: access denied or credentials rejected" >&2
  elif err_has 'Could not connect|Connect timeout|EndpointConnectionError|Read timeout|Name or service not known|nodename nor servname'; then
    echo "  ??    $what: endpoint unreachable ($ENDPOINT)" >&2
  else
    echo "  ??    $what: $(err_line)" >&2
  fi
  echo "cannot verify the policy; this is not a pass (exit 3)" >&2
  exit 3
}

# ---------------------------------------------------------------------------------------------
check_bucket() {
  if s3api head-bucket --bucket "$BUCKET"; then pass "bucket '$BUCKET' exists"; return 0; fi
  if err_has '404|NoSuchBucket|Not Found'; then
    fail "bucket '$BUCKET' does not exist (create it first: infra/provision-tool.sh meetings --bucket, or docker compose up -d minio minio-createbucket)"
    return 1
  fi
  cannot_tell "HeadBucket"
}

check_versioning() {
  if ! s3api get-bucket-versioning --bucket "$BUCKET"; then cannot_tell "GetBucketVersioning"; fi
  VERSIONING="$(jq -r '.Status // "Off"' "$OUT")"
  case "$VERSIONING" in
    Off) pass "versioning is off (never enabled)" ;;
    Suspended) pass "versioning is suspended (not Enabled; noncurrent versions, if any, are covered by the rule below)" ;;
    Enabled) fail "versioning is ENABLED: a delete would stay recoverable, which breaks the 29-day promise. It cannot be switched off, only suspended: recreate the bucket or suspend versioning, then re-run" ;;
    *) fail "unexpected versioning status '$VERSIONING'" ;;
  esac
}

check_lifecycle() {
  if ! s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"; then
    if err_has 'NoSuchLifecycleConfiguration'; then
      fail "no lifecycle configuration: audio would be kept forever"
      return
    fi
    cannot_tell "GetBucketLifecycleConfiguration"
  fi
  local total good
  total="$(jq '[.Rules[]?] | length' "$OUT")"
  # A qualifying rule: Enabled, expires CURRENT objects after 1..29 days, and applies to the WHOLE bucket
  # (no prefix, tag, size or And filter, whether spelled in Filter or in the legacy top-level Prefix).
  good="$(jq --argjson max "$RETENTION_DAYS" '
    [ .Rules[]?
      | select(.Status == "Enabled")
      | select((.Expiration.Days // 0) >= 1 and (.Expiration.Days // 0) <= $max)
      | select((.Prefix // "") == "")
      | select((.Filter // {}) as $f
               | ($f.Prefix // "") == "" and $f.Tag == null and $f.And == null
                 and $f.ObjectSizeGreaterThan == null and $f.ObjectSizeLessThan == null)
    ] | length' "$OUT")"
  if [[ "$good" -ge 1 ]]; then
    pass "lifecycle: an enabled rule expires every object after at most ${RETENTION_DAYS} days, with no prefix filter"
  else
    fail "lifecycle: no enabled rule expires the WHOLE bucket after at most ${RETENTION_DAYS} days (rules: $total; a prefix/tag/size filter, Days > ${RETENTION_DAYS}, a date-based or disabled rule does not count)"
  fi
  if [[ "$total" -gt 1 ]]; then warn "lifecycle: $total rules present; only the whole-bucket rule is required, check the others are intended"; fi
  if [[ "${VERSIONING:-Off}" == "Suspended" ]]; then
    if [[ "$(jq '[.Rules[]? | select(.Status == "Enabled" and .NoncurrentVersionExpiration != null)] | length' "$OUT")" -lt 1 ]]; then
      warn "versioning is suspended and no rule expires noncurrent versions: older versions would stay"
    fi
  fi
}

check_cors() {
  if ! s3api get-bucket-cors --bucket "$BUCKET"; then
    if err_has 'NoSuchCORSConfiguration'; then
      if cors_required; then fail "no CORS configuration: the browser cannot upload to or play from the bucket (add a rule for $SHELL_ORIGIN)"
      else skip "CORS: none configured on a loopback dev store (MinIO has no per-bucket CORS; pass --require-cors to demand it)"; fi
      return
    fi
    if err_has 'NotImplemented|not implemented|MethodNotAllowed'; then
      if cors_required; then fail "this endpoint does not support bucket CORS, which the browser upload needs"
      else skip "CORS: this loopback dev store does not support bucket CORS (normal for MinIO; pass --require-cors to demand it)"; fi
      return
    fi
    cannot_tell "GetBucketCors"
  fi
  if [[ "$(jq '[.CORSRules[]?] | length' "$OUT")" -eq 0 ]] && ! cors_required; then
    skip "CORS: none configured on a loopback dev store (pass --require-cors to demand it)"
    return
  fi
  if [[ "$(jq '[.CORSRules[]? | select(.AllowedOrigins | index("*"))] | length' "$OUT")" -gt 0 ]]; then
    fail "CORS: a rule allows origin '*'; the audio bucket may only allow $SHELL_ORIGIN"
    return
  fi
  if [[ "$(jq --arg o "$SHELL_ORIGIN" '[.CORSRules[]? | select((.AllowedOrigins | index($o)) and (.AllowedMethods | index("POST")) and (.AllowedMethods | index("GET")))] | length' "$OUT")" -ge 1 ]]; then
    pass "CORS: $SHELL_ORIGIN may POST (presigned upload) and GET (playback)"
  else
    fail "CORS: no rule allows $SHELL_ORIGIN with both POST and GET"
  fi
}

run_check() {
  echo "meetings bucket policy check: bucket '$BUCKET' on $ENDPOINT"
  check_bucket || { echo "NOT OK: $FAILS check(s) failed"; return 1; }
  VERSIONING="Off"
  check_versioning
  check_lifecycle
  check_cors
  if [[ "$FAILS" -eq 0 ]]; then echo "OK: the policy holds"; return 0; fi
  echo "NOT OK: $FAILS check(s) failed"
  return 1
}

# ---------------------------------------------------------------------------------------------
apply_policy() {
  echo "meetings bucket policy apply: bucket '$BUCKET' on $ENDPOINT"
  if ! s3api head-bucket --bucket "$BUCKET"; then
    if err_has '404|NoSuchBucket|Not Found'; then
      echo "error: bucket '$BUCKET' does not exist; this script never creates it" >&2; exit 1
    fi
    cannot_tell "HeadBucket"
  fi

  # Guard against the wrong bucket (a typo that names the CRM or refund bucket would put a 29-day
  # expiry on offers or receipts). meetings-api writes only under meetings/, so anything else at the
  # top level means this is not the audio bucket. Only the top level is listed (cheap, one page).
  if ! s3api list-objects-v2 --bucket "$BUCKET" --delimiter "/" --max-keys 1000 --no-paginate; then cannot_tell "ListObjectsV2"; fi
  local foreign truncated
  foreign="$(jq --arg p "${KEY_PREFIX}/" '[ (.Contents[]?.Key), (.CommonPrefixes[]?.Prefix) ] | map(select(. != $p)) | length' "$OUT")"
  truncated="$(jq -r '.IsTruncated // false' "$OUT")"
  if [[ "$foreign" -gt 0 || "$truncated" == "true" ]] && ! $FORCE; then
    echo "error: bucket '$BUCKET' holds objects outside '${KEY_PREFIX}/' - it does not look like the meetings audio bucket." >&2
    echo "       Applying would put a ${RETENTION_DAYS}-day expiry on them. Check --bucket; use --force only if you are sure." >&2
    exit 1
  fi

  if ! s3api get-bucket-versioning --bucket "$BUCKET"; then cannot_tell "GetBucketVersioning"; fi
  if [[ "$(jq -r '.Status // "Off"' "$OUT")" == "Enabled" ]]; then
    echo "error: versioning is ENABLED on '$BUCKET'. It cannot be switched off, only suspended; a versioned delete stays recoverable." >&2
    echo "       Recreate the bucket (preferred) or suspend versioning, then re-run." >&2
    exit 1
  fi

  local before="0"
  if s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"; then before="$(jq '[.Rules[]?] | length' "$OUT")"
  elif ! err_has 'NoSuchLifecycleConfiguration'; then cannot_tell "GetBucketLifecycleConfiguration"; fi

  local rule
  rule="$(jq -n --arg id "$RULE_ID" --argjson days "$RETENTION_DAYS" --argjson nc "$NONCURRENT" '
    { Rules: [ { ID: $id, Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: $days } }
               + (if $nc then { NoncurrentVersionExpiration: { NoncurrentDays: 1 } } else {} end) ] }')"
  if ! s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration "$rule"; then
    echo "error: PutBucketLifecycleConfiguration failed: $(err_line)" >&2
    echo "       (a provider that rejects the noncurrent-version part: retry with --no-noncurrent)" >&2
    exit 3
  fi
  echo "  DONE  lifecycle: ${before} previous rule(s) replaced by '$RULE_ID' (expire after ${RETENTION_DAYS} days)"

  local cors
  cors="$(jq -n --arg o "$SHELL_ORIGIN" '
    { CORSRules: [ { AllowedOrigins: [$o], AllowedMethods: ["POST", "GET"], AllowedHeaders: ["*"],
                     ExposeHeaders: ["ETag", "Location"], MaxAgeSeconds: 3000 } ] }')"
  if s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "$cors"; then
    echo "  DONE  CORS: $SHELL_ORIGIN may POST and GET"
  elif err_has 'NotImplemented|not implemented|MethodNotAllowed'; then
    if cors_required; then echo "error: this endpoint does not support bucket CORS, which the browser upload needs" >&2; exit 1; fi
    echo "  SKIP  CORS: this loopback dev store does not support bucket CORS"
  else
    echo "error: PutBucketCors failed: $(err_line)" >&2; exit 3
  fi
  echo
}

if [[ "$MODE" == "apply" ]]; then apply_policy; fi
run_check
exit $?
