#!/usr/bin/env bash
# Offline check of the Cloud Logging signals in logging/queries.sh against the brief's four log lines
# (+ one healthy control line). grep -E stands in for Cloud Logging's RE2 =~ ; the patterns used are
# in the common subset of both.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=../../../logging/queries.sh
source "$here/../../../logging/queries.sh"
logs="$here/sample-logs.txt"
fail=0

flagged() { # mirrors failures_filter: severity>=WARNING OR 4xx/5xx OR ok:false OR whitespace id OR non-canonical size
  local line="$1"
  [[ "$line" =~ \ (ERROR|WARNING|CRITICAL)\  ]] && return 0
  grep -qE -- "$RE_HTTP_4XX_5XX" <<<"$line" && return 0
  grep -qE -- "$RE_OK_FALSE" <<<"$line" && return 0
  grep -qE -- "$RE_WHITESPACE_ID" <<<"$line" && return 0
  grep -q 'body=' <<<"$line" && ! grep -qE -- "$RE_CANONICAL_SIZE" <<<"$line" && return 0
  return 1
}

check() { if [[ "$2" == "$3" ]]; then echo "PASS  $1"; else echo "FAIL  $1 (expected '$3', got '$2')"; fail=1; fi; }

mapfile -t lines <"$logs"
for i in 0 1 2 3; do
  if flagged "${lines[$i]}"; then got=flagged; else got=clean; fi
  check "brief log line $((i + 1)) is flagged" "$got" flagged
done
if flagged "${lines[4]}"; then got=flagged; else got=clean; fi
check "healthy control line is NOT flagged" "$got" clean

dups="$(grep -F 'response={"id"' "$logs" | duplicate_refs | tr '\n' ' ')"
check "duplicate pipeline finds the ref created twice" "$dups" '"ref":"JD55122" '

lq_out="$(lq "$RE_WHITESPACE_ID")"
check "query-string escaping of regexes" "$lq_out" '\"(lockerId|ref)\":\"(\\s[^\"]*|[^\"]*\\s)\"'

exit "$fail"
