#!/usr/bin/env bash
# Integration tests against a REAL Redis (container) and the Firestore emulator. Needs podman or docker + Java 21.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENGINE="$(command -v podman || command -v docker || true)"
[[ -n "$ENGINE" ]] || { echo "podman or docker is required" >&2; exit 1; }
NAME="task5-redis-$$"
PORT="${REDIS_PORT:-6390}"

"$ENGINE" run -d --rm --name "$NAME" -p "127.0.0.1:${PORT}:6379" docker.io/library/redis:7-alpine >/dev/null
trap '"$ENGINE" stop "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 50); do "$ENGINE" exec "$NAME" redis-cli ping 2>/dev/null | grep -q PONG && break; sleep 0.2; done

REDIS_URL="redis://127.0.0.1:${PORT}" npx -y firebase-tools@15.37.0 emulators:exec --only firestore --project demo-task5 \
  "node --test --test-concurrency=1 'test/integration/*.test.js'"
