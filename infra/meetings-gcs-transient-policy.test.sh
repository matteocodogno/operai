#!/usr/bin/env bash
# Test harness for infra/meetings-gcs-transient-policy.sh (specs/021 T106). NO real cloud calls: a fake
# `gcloud` is put first on PATH and answers from fixture files in a temp directory. It records every
# invocation so the --apply cases can assert exactly what would have been changed.
#
#   bash infra/meetings-gcs-transient-policy.test.sh        # exit 0 = every case passed
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/meetings-gcs-transient-policy.sh"
command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 3; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/gcloud" <<'FAKE'
#!/usr/bin/env bash
# fake gcloud: state lives in $FAKE_DIR; every call is appended to $FAKE_DIR/calls.log
echo "$*" >> "$FAKE_DIR/calls.log"
case "$*" in
  *"storage buckets describe"*)
    case "$(cat "$FAKE_DIR/fail" 2>/dev/null)" in
      denied) echo "ERROR: (gcloud.storage.buckets.describe) HTTPError 403: caller does not have storage.buckets.get access" >&2; exit 1 ;;
      notfound) echo "ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket does not exist." >&2; exit 1 ;;
      notjson) echo "not json at all"; exit 0 ;;
    esac
    cat "$FAKE_DIR/bucket.json" ;;
  *"storage ls"*) cat "$FAKE_DIR/ls.txt" 2>/dev/null; exit 0 ;;
  *"storage buckets update"*)
    if [[ -f "$FAKE_DIR/update_fails" ]]; then echo "ERROR: update refused: bucket retention policy is locked" >&2; exit 1; fi
    # a successful update makes the bucket compliant, so the follow-up check passes
    if [[ -f "$FAKE_DIR/after_apply.json" ]]; then cp "$FAKE_DIR/after_apply.json" "$FAKE_DIR/bucket.json"; fi
    exit 0 ;;
  *) echo "fake gcloud: unexpected call: $*" >&2; exit 64 ;;
esac
FAKE
chmod +x "$T/bin/gcloud"

GOOD='{
  "name": "synthetic-transient", "location": "EUROPE-WEST4", "locationType": "region",
  "lifecycle": {"rule": [{"action": {"type": "Delete"}, "condition": {"age": 1}}]},
  "versioning": {"enabled": false},
  "softDeletePolicy": {"retentionDurationSeconds": "0"},
  "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": true}, "publicAccessPrevention": "enforced"}
}'

PASSED=0; FAILED=0; LAST_OUT=""
export FAKE_DIR="$T/state"

# fresh_state <jq filter applied to GOOD | "-" for untouched>
fresh_state() {
  rm -rf "$FAKE_DIR"; mkdir -p "$FAKE_DIR"
  if [[ "$1" == "-" ]]; then printf '%s' "$GOOD" > "$FAKE_DIR/bucket.json"
  else printf '%s' "$GOOD" | jq "$1" > "$FAKE_DIR/bucket.json"; fi
}
# run_script <expected exit> <name> [script args...]: runs the script under test with the fake gcloud first on PATH
run_script() {
  local want="$1" name="$2" rc; shift 2
  LAST_OUT="$(PATH="$T/bin:$PATH" bash "$SCRIPT" "$@" 2>&1)"; rc=$?
  if [[ "$rc" == "$want" ]]; then PASSED=$((PASSED + 1)); echo "ok   $name (exit $rc)"
  else FAILED=$((FAILED + 1)); echo "FAIL $name: wanted exit $want, got $rc"; echo "$LAST_OUT" | sed 's/^/       /'; fi
}
# case <expected exit> <name> <jq filter | -> [script args...]
run_case() { local want="$1" name="$2" filter="$3"; shift 3; fresh_state "$filter"; run_script "$want" "$name" "$@"; }
expect_out() {
  if grep -qF -- "$1" <<<"$LAST_OUT"; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); echo "FAIL output lacks: $1"; echo "$LAST_OUT" | sed 's/^/       /'; fi
}
expect_called() {
  if grep -qF -- "$1" "$FAKE_DIR/calls.log"; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); echo "FAIL gcloud was not called with: $1"; fi
}
expect_not_called() {
  if grep -qE -- "$1" "$FAKE_DIR/calls.log"; then FAILED=$((FAILED + 1)); echo "FAIL gcloud was called with: $1"; else PASSED=$((PASSED + 1)); fi
}
B=(--check --bucket synthetic-transient)

# --- the check passes on a compliant bucket ----------------------------------------------------
run_case 0 "compliant bucket passes" "-" "${B[@]}"
expect_out "OK: the transient bucket rules hold"
run_case 0 "EU multi-region passes" '.location = "EU"' "${B[@]}"
run_case 0 "--project is accepted and passed to gcloud" "-" "${B[@]}" --project synthetic-proj-123
expect_called "--project synthetic-proj-123"
run_case 0 "lowercase location is normalised" '.location = "europe-west4"' "${B[@]}"

# --- each N2 property failing in turn (soft delete 7 d is the headline case) -------------------------
run_case 1 "soft delete 7 days -> refused" '.softDeletePolicy.retentionDurationSeconds = "604800"' "${B[@]}"
expect_out "604800"
run_case 1 "soft delete policy absent -> refused (unreadable)" 'del(.softDeletePolicy)' "${B[@]}"
run_case 1 "versioning on -> refused" '.versioning.enabled = true' "${B[@]}"
run_case 1 "lifecycle rule with matchesPrefix -> refused" '.lifecycle.rule[0].condition.matchesPrefix = ["transcribe/"]' "${B[@]}"
run_case 1 "lifecycle rule with matchesSuffix -> refused" '.lifecycle.rule[0].condition.matchesSuffix = [".ogg"]' "${B[@]}"
run_case 1 "lifecycle age 2 -> refused" '.lifecycle.rule[0].condition.age = 2' "${B[@]}"
run_case 1 "lifecycle without any age -> refused" '.lifecycle.rule[0].condition = {"createdBefore": "2026-01-01"}' "${B[@]}"
run_case 1 "lifecycle action SetStorageClass -> refused" '.lifecycle.rule[0].action = {"type": "SetStorageClass", "storageClass": "NEARLINE"}' "${B[@]}"
run_case 1 "no lifecycle at all -> refused" 'del(.lifecycle)' "${B[@]}"
run_case 1 "location EUROPE-WEST2 (London) -> refused" '.location = "EUROPE-WEST2"' "${B[@]}"
run_case 1 "location US -> refused" '.location = "US"' "${B[@]}"
run_case 1 "dual-region EUR4 -> refused" '.location = "EUR4"' "${B[@]}"
run_case 1 "public access prevention inherited -> refused" '.iamConfiguration.publicAccessPrevention = "inherited"' "${B[@]}"
run_case 1 "uniform access off -> refused" '.iamConfiguration.uniformBucketLevelAccess.enabled = false' "${B[@]}"
run_case 1 "retention policy set -> refused" '.retentionPolicy = {"retentionPeriod": "86400"}' "${B[@]}"
run_case 1 "default event-based hold -> refused" '.defaultEventBasedHold = true' "${B[@]}"
run_case 1 "several failures are all counted" '.versioning.enabled = true | .location = "US"' "${B[@]}"
expect_out "2 failing"
run_case 0 "a good rule plus an extra rule passes, with a warning" '.lifecycle.rule += [{"action": {"type": "Delete"}, "condition": {"age": 30, "matchesPrefix": ["x/"]}}]' "${B[@]}"
expect_out "WARN"

# --- "cannot tell" is never a pass ---------------------------------------------------------------------
fresh_state "-"; echo denied > "$FAKE_DIR/fail";   run_script 3 "access denied -> exit 3" "${B[@]}"
fresh_state "-"; echo notfound > "$FAKE_DIR/fail"; run_script 1 "bucket missing -> exit 1" "${B[@]}"
fresh_state "-"; echo notjson > "$FAKE_DIR/fail";  run_script 3 "unparseable metadata -> exit 3" "${B[@]}"
run_case 3 "metadata without a location -> exit 3" 'del(.location)' "${B[@]}"

# --- usage errors --------------------------------------------------------------------------------------
run_case 2 "no mode -> exit 2" "-" --bucket synthetic-transient
run_case 2 "no bucket -> exit 2" "-" --check
run_case 2 "a gs:// URL as bucket -> exit 2" "-" --check --bucket gs://synthetic-transient
run_case 2 "unknown option -> exit 2" "-" --check --bucket synthetic-transient --nope
run_case 2 "bad project id -> exit 2" "-" "${B[@]}" --project "Bad Project"
run_case 0 "--help exits 0" "-" --help

# --- gcloud missing: exit 3 (a PATH holding neither the fake nor a real gcloud) ------------------------------
mkdir -p "$T/nogcloud"
ln -s "$(command -v jq)" "$T/nogcloud/jq"
ln -s "$(command -v mktemp)" "$T/nogcloud/mktemp"
ln -s "$(command -v rm)" "$T/nogcloud/rm"
ln -s "$(command -v sed)" "$T/nogcloud/sed"
ln -s "$(command -v dirname)" "$T/nogcloud/dirname"
LAST_OUT="$(PATH="$T/nogcloud" "$(command -v bash)" "$SCRIPT" "${B[@]}" 2>&1)"; rc=$?
if [[ "$rc" == 3 ]]; then PASSED=$((PASSED + 1)); echo "ok   gcloud missing -> exit 3"; expect_out "gcloud CLI is required"
else FAILED=$((FAILED + 1)); echo "FAIL gcloud missing: got $rc"; echo "$LAST_OUT" | sed 's/^/       /'; fi

# --- --apply: what it changes and that it verifies afterwards -----------------------------------------------
fresh_state '.softDeletePolicy.retentionDurationSeconds = "604800" | .versioning.enabled = true'
printf '%s' "$GOOD" > "$FAKE_DIR/after_apply.json"
printf 'gs://synthetic-transient/transcribe/\n' > "$FAKE_DIR/ls.txt"
run_script 0 "--apply on a bad bucket applies, then verifies" --apply --bucket synthetic-transient
expect_out "verifying what was applied"
expect_out "OK: the transient bucket rules hold"
for flag in "--soft-delete-duration=0" "--no-versioning" "--clear-retention-period" "--no-default-event-based-hold" \
            "--uniform-bucket-level-access" "--public-access-prevention" "--lifecycle-file="; do
  expect_called "$flag"
done
# the verification is a describe AFTER the update: apply never trusts its own update
if [[ "$(grep -c 'storage buckets describe' "$FAKE_DIR/calls.log")" -ge 2 ]]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); echo "FAIL apply did not re-read the bucket after updating"; fi
expect_not_called 'buckets create|storage rm|objects delete|add-iam|set-iam|iam-policy'

fresh_state '.versioning.enabled = true'
printf '%s' "$GOOD" > "$FAKE_DIR/after_apply.json"
printf 'gs://synthetic-transient/transcribe/\ngs://synthetic-transient/offers/\n' > "$FAKE_DIR/ls.txt"
run_script 1 "--apply refuses a bucket holding other data" --apply --bucket synthetic-transient
expect_not_called 'buckets update'

fresh_state '.versioning.enabled = true'
printf '%s' "$GOOD" > "$FAKE_DIR/after_apply.json"
printf 'gs://synthetic-transient/offers/\n' > "$FAKE_DIR/ls.txt"
run_script 0 "--apply --force overrides that refusal" --apply --bucket synthetic-transient --force
expect_called 'buckets update'

fresh_state '.retentionPolicy = {"isLocked": true}'
: > "$FAKE_DIR/ls.txt"; touch "$FAKE_DIR/update_fails"
run_script 1 "--apply when the update is refused (locked retention) fails" --apply --bucket synthetic-transient

fresh_state '.versioning.enabled = true'
: > "$FAKE_DIR/ls.txt"
run_script 1 "--apply whose update does not fix the bucket fails the verification" --apply --bucket synthetic-transient

fresh_state '-'
echo notfound > "$FAKE_DIR/fail"
run_script 1 "--apply on a missing bucket fails and never creates it" --apply --bucket synthetic-transient
expect_not_called 'buckets create|buckets update'

# --- hygiene: the script neither takes nor prints a credential ---------------------------------------------
if grep -qiE 'service_account_key|private_key|--key-file|GOOGLE_APPLICATION_CREDENTIALS|--impersonate' "$SCRIPT"; then FAILED=$((FAILED + 1)); echo "FAIL the script mentions a credential input"; else PASSED=$((PASSED + 1)); fi

echo; echo "passed: $PASSED  failed: $FAILED"
[[ "$FAILED" -eq 0 ]]
