#!/usr/bin/env bash
# curl test for every case of POST /v1/partners/:partner/parcels.
#   BASE_URL=http://localhost:8080 JD_KEY=jd-test-key ./curl-tests.sh
# Expects lockers LK-2041 (online), LK-3000 (online), LK-0933 (offline); LK-1187 must NOT exist.
# Each case prints the curl command it ran, the status, and PASS/FAIL. Exit code = number of failures.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
JD_KEY="${JD_KEY:-jd-test-key}"
URL="$BASE_URL/v1/partners/jd/parcels"
RUN="$(date +%s)" # unique refs per run, so the suite can be re-run against the same database
failures=0
out="$(mktemp)"
trap 'rm -f "$out" "$out.h"' EXIT

# expect <name> <status> <jq-assertion> -- <curl args...>
expect() {
  local name="$1" want="$2" assertion="$3"
  shift 4
  local got
  rm -f "$out.h"
  got="$(curl -sS -o "$out" -D "$out.h" -w '%{http_code}' "$@")"
  if [[ "$got" == "$want" ]] && jq -e "$assertion" "$out" >/dev/null 2>&1; then
    printf 'PASS  %-58s %s\n' "$name" "$got"
  else
    printf 'FAIL  %-58s want %s got %s: %s\n' "$name" "$want" "$got" "$(head -c 300 "$out")"
    failures=$((failures + 1))
  fi
}
header() { grep -i "^$1:" "$out.h" | tr -d '\r' | cut -d' ' -f2-; }
expect_header() { # expect_header <name> <header> <value>  (checks the previous response)
  local got
  got="$(header "$2")"
  if [[ "$got" == "$3" ]]; then printf 'PASS  %-58s %s\n' "$1" "$got"
  else printf 'FAIL  %-58s want %s got %s\n' "$1" "$3" "$got"; failures=$((failures + 1)); fi
}
J=(-H "Content-Type: application/json" -H "X-API-Key: $JD_KEY")

REF="JD-$RUN-1"
expect "1. new parcel -> 201 Created + Location" 201 '.id | startswith("p_")' -- \
  -X POST "$URL" "${J[@]}" -d "{\"ref\":\"$REF\",\"lockerId\":\"LK-2041\",\"size\":\"M\"}"
ID="$(jq -r .id "$out" 2>/dev/null)"
expect_header "   ...Location header" Location "/v1/partners/jd/parcels/$ID"

expect "2. identical retry -> 200, same id, Idempotent-Replayed" 200 ".id == \"$ID\"" -- \
  -X POST "$URL" "${J[@]}" -d "{\"ref\":\"$REF\",\"lockerId\":\"LK-2041\",\"size\":\"M\"}"
expect_header "   ...Idempotent-Replayed header" Idempotent-Replayed "true"

expect "3. retry with 'LK-2041 ' + 'medium' -> 200 same parcel" 200 ".id == \"$ID\" and .size == \"M\"" -- \
  -X POST "$URL" "${J[@]}" -d "{\"ref\":\"$REF\",\"lockerId\":\"LK-2041 \",\"size\":\"medium\"}"

expect "4. same ref, different locker -> 409 PARCEL_REF_CONFLICT" 409 '.code == "PARCEL_REF_CONFLICT"' -- \
  -X POST "$URL" "${J[@]}" -d "{\"ref\":\"$REF\",\"lockerId\":\"LK-3000\",\"size\":\"M\"}"

expect "5. unknown locker 'LK-1187 ' -> 422 LOCKER_NOT_FOUND" 422 '.code == "LOCKER_NOT_FOUND"' -- \
  -X POST "$URL" "${J[@]}" -d "{\"ref\":\"JD-$RUN-5\",\"lockerId\":\"LK-1187 \",\"size\":\"M\"}"

expect "6. offline locker -> 409 LOCKER_OFFLINE (retryable)" 409 '.code == "LOCKER_OFFLINE" and .retryable' -- \
  -X POST "$URL" "${J[@]}" -d "{\"ref\":\"JD-$RUN-6\",\"lockerId\":\"LK-0933\",\"size\":\"M\"}"
expect_header "   ...Retry-After header" Retry-After "300"

expect "7. invalid size 'XL' -> 400 VALIDATION_FAILED" 400 '.errors[0].field == "size"' -- \
  -X POST "$URL" "${J[@]}" -d "{\"ref\":\"JD-$RUN-7\",\"lockerId\":\"LK-2041\",\"size\":\"XL\"}"

expect "8. missing fields -> 400 with every field listed" 400 '[.errors[].field] == ["ref","lockerId","size"]' -- \
  -X POST "$URL" "${J[@]}" -d '{}'

expect "9. malformed JSON -> 400 INVALID_JSON" 400 '.code == "INVALID_JSON"' -- \
  -X POST "$URL" "${J[@]}" -d '{"ref":"JD-x", bad-json}'

expect "10. wrong Content-Type -> 415" 415 '.code == "UNSUPPORTED_MEDIA_TYPE"' -- \
  -X POST "$URL" -H "Content-Type: text/plain" -H "X-API-Key: $JD_KEY" -d 'ref=JD'

expect "11. no API key -> 401 UNAUTHENTICATED" 401 '.code == "UNAUTHENTICATED"' -- \
  -X POST "$URL" -H "Content-Type: application/json" -d "{\"ref\":\"JD-$RUN-11\",\"lockerId\":\"LK-2041\",\"size\":\"M\"}"

expect "12. JD key on Evri path -> 403 FORBIDDEN" 403 '.code == "FORBIDDEN"' -- \
  -X POST "$BASE_URL/v1/partners/evri/parcels" "${J[@]}" -d "{\"ref\":\"JD-$RUN-12\",\"lockerId\":\"LK-2041\",\"size\":\"M\"}"

expect "13. body over 16 KB -> 413 PAYLOAD_TOO_LARGE" 413 '.code == "PAYLOAD_TOO_LARGE"' -- \
  -X POST "$URL" "${J[@]}" -d "{\"ref\":\"JD-$RUN-13\",\"lockerId\":\"LK-2041\",\"size\":\"M\",\"pad\":\"$(head -c 20000 /dev/zero | tr '\0' x)\"}"

expect "14. unknown route -> 404 problem+json" 404 '.code == "NOT_FOUND"' -- \
  -X GET "$BASE_URL/v1/nope"

# 15. Five identical requests at the same instant: exactly one 201, four 200, one id.
REF="JD-$RUN-15"
for i in 1 2 3 4 5; do
  curl -sS -o "$out.$i" -w '%{http_code}\n' -X POST "$URL" "${J[@]}" \
    -d "{\"ref\":\"$REF\",\"lockerId\":\"LK-2041\",\"size\":\"S\"}" >"$out.code.$i" &
done
wait
codes="$(sort "$out".code.* | tr '\n' ' ')"
ids="$(jq -r .id "$out".[1-5] | sort -u | wc -l)"
if [[ "$codes" == "200 200 200 200 201 " && "$ids" == "1" ]]; then
  printf 'PASS  %-58s %s\n' "15. 5 concurrent identical requests -> one parcel" "$codes"
else
  printf 'FAIL  %-58s codes=%s distinct ids=%s\n' "15. 5 concurrent identical requests -> one parcel" "$codes" "$ids"
  failures=$((failures + 1))
fi
rm -f "$out".[1-5] "$out".code.*

echo "failures: $failures"
exit "$failures"
