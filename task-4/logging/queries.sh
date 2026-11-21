#!/usr/bin/env bash
# Cloud Logging queries: every failed or suspicious request from a partner in the last 24 hours.
# NOT EXECUTED for the assessment (no GCP project). The regexes are tested offline against the brief's
# log lines by api/test/logging/test-log-filters.sh, which sources this file.
#
#   PROJECT_ID=ktsm-prod-4471 PARTNER=jd ./queries.sh failures|duplicates|structured
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ktsm-prod-4471}"
PARTNER="${PARTNER:-jd}"
FRESHNESS="${FRESHNESS:-1d}"                # last 24 hours
RESOURCE='resource.type="cloud_run_revision"' # adjust if the API runs elsewhere (GKE: k8s_container)

# --- Signals, as RE2 regexes (Cloud Logging's =~ operator) -------------------------------------------
RE_HTTP_4XX_5XX=' (4|5)[0-9]{2} [0-9]+ms'              # status code in the access line
RE_OK_FALSE='"ok":false'                               # failure disguised as 200 OK
RE_WHITESPACE_ID='"(lockerId|ref)":"(\s[^"]*|[^"]*\s)"' # " LK-1" / "LK-1187 "
RE_CANONICAL_SIZE='"size":"(S|M|L)"'                   # anything else (e.g. "medium") is suspicious

# Escape a value for use inside a double-quoted Logging query string: \ -> \\ , " -> \"
lq() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# 1) Today's text-format logs:  <ts> <SEVERITY> POST /v1/partners/jd/parcels <status> <ms> body=... response=...
#    Lines on separate rows are ANDed by Cloud Logging.
failures_filter() {
  cat <<EOF
${RESOURCE}
textPayload:"/v1/partners/${PARTNER}/parcels"
(
  severity>=WARNING
  OR textPayload=~"$(lq "$RE_HTTP_4XX_5XX")"
  OR textPayload=~"$(lq "$RE_OK_FALSE")"
  OR textPayload=~"$(lq "$RE_WHITESPACE_ID")"
  OR (textPayload:"body=" AND NOT textPayload=~"$(lq "$RE_CANONICAL_SIZE")")
)
EOF
}

# 2) Duplicates: the same ref CREATED more than once (each line looks healthy on its own: 200 + new id).
duplicates_filter() {
  cat <<EOF
${RESOURCE}
textPayload:"/v1/partners/${PARTNER}/parcels"
textPayload:"response={\"id\""
EOF
}

# Shared by the live command and the offline test: textPayload lines in -> refs created 2+ times out.
duplicate_refs() { grep -oE '"ref":"[^"]*"' | sort | uniq -d; }

# 3) After the fix: structured access logs (one JSON entry per request, written by src/app.js).
structured_filter() {
  cat <<EOF
${RESOURCE}
jsonPayload.partner="${PARTNER}"
(
  httpRequest.status>=400
  OR jsonPayload.outcome="replayed"
  OR jsonPayload.warnings:*
)
EOF
}

main() {
  case "${1:-failures}" in
    failures)
      gcloud logging read "$(failures_filter)" --project="$PROJECT_ID" --freshness="$FRESHNESS" \
        --order=asc --limit=1000 --format='table(timestamp, severity, textPayload)' ;;
    duplicates)
      gcloud logging read "$(duplicates_filter)" --project="$PROJECT_ID" --freshness="$FRESHNESS" \
        --limit=10000 --format=json | jq -r '.[].textPayload' | duplicate_refs ;;
    structured)
      gcloud logging read "$(structured_filter)" --project="$PROJECT_ID" --freshness="$FRESHNESS" \
        --order=asc --limit=1000 \
        --format='table(timestamp, httpRequest.status, jsonPayload.errorCode, jsonPayload.outcome, jsonPayload.ref, jsonPayload.lockerId, jsonPayload.warnings)' ;;
    print)
      printf -- '--- failures\n%s\n--- duplicates\n%s\n--- structured\n%s\n' \
        "$(failures_filter)" "$(duplicates_filter)" "$(structured_filter)" ;;
    *) echo "usage: $0 failures|duplicates|structured|print" >&2; exit 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
