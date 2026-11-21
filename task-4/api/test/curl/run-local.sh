#!/usr/bin/env bash
# Runs the real server (src/server.js) against the Firestore emulator and executes the curl suite.
# Invoked by `npm run test:emulator` (inside `firebase emulators:exec`, which sets FIRESTORE_EMULATOR_HOST).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${FIRESTORE_EMULATOR_HOST:?run via npm run test:emulator}"
export GOOGLE_CLOUD_PROJECT=demo-task4 PORT=18080

node -e '
  const { Firestore } = require("@google-cloud/firestore");
  const db = new Firestore({ projectId: "demo-task4" });
  Promise.all([
    db.doc("lockers/LK-2041").set({ status: "online" }),
    db.doc("lockers/LK-3000").set({ status: "online" }),
    db.doc("lockers/LK-0933").set({ status: "offline" }),
    db.doc("lockers/LK-1187").delete(),
  ]).then(() => process.exit(0));
'

sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
PARTNER_API_KEY_HASHES="{\"jd\":\"$(sha jd-test-key)\",\"evri\":\"$(sha evri-test-key)\"}" \
  node src/server.js >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
for _ in $(seq 50); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.1; done

BASE_URL="http://localhost:$PORT" JD_KEY=jd-test-key bash test/curl/curl-tests.sh
