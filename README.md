# Senior Infrastructure Engineer: Practical Assessment

My approach to addressing the six practical tasks about the backend and infrastructure of a parcel locker platform running on Google Cloud and Firebase. Application code is written in JavaScript (Node.js); infrastructure code is Terraform.

Each task has its own folder with a README covering **what I found, what I changed and why**, and how to verify it. No live GCP project was used. Everything that can be checked offline has been checked offline, and commands that would need a real project are marked as such.

## Tasks

| Task | Folder | Summary |
|---|---|---|
| 1 | [`task-1/`](task-1/) | Review a scheduled-function Terraform config, rewrite it as a reusable least-privilege module, and adopt the hand-made production function without recreating it |
| 2 | [`task-2/`](task-2/) | Fix a Scheduler → Pub/Sub → Firestore pipeline that double-books compartments, misses parcels and overlaps runs; idempotent, transactional rewrite with emulator-tested guarantees and a gcloud runbook (DLQ, OIDC, Africa/Nairobi) |
| 3 | [`task-3/`](task-3/) | Diagnose a self-triggering 1st gen Firestore function (duplicate notifications, runaway writes), rewrite it as an idempotent 2nd gen trigger, and cut over with no gap and no duplicates; incident reproduced and fix proven on the Firebase emulators |
| 4 | [`task-4/`](task-4/) | Debug a partner API from Cloud Logging (missing, duplicate and failing parcels), fix it with validation, RFC 9457 errors, auth and `(partner, ref)` idempotency, publish a v1 JSON Schema contract and a non-breaking versioning plan; tested over HTTP on the Firestore emulator plus a curl suite |
| 5 | [`task-5/`](task-5/) | Capacity maths for 300 → 6,000 lockers and why `stats/network` breaks first; redesign with Pub/Sub, a BigQuery subscription and Memorystore (Firestore 600 → ~24 writes/s); three alerts in Terraform; tested on real Redis + the Firestore emulator |
| 6 | [`task-6/`](task-6/) | Ranked cost plan for a $7,670/month bill (about −73%, without touching HA), three savings in Terraform (log exclusions, storage lifecycle on the existing bucket, staging schedule), a billing budget at 50/90/100%, labels and cost allocation per customer and environment, and the savings not to make |

## Prerequisites

- Terraform ≥ 1.7 (used here: 1.17.2)
- Node.js ≥ 22 (used here: 22.22.2)
- Java ≥ 21, only for the Firebase emulator tests in Tasks 2, 3 and 4
- `curl` and `jq` for the Task 4 curl suite
- podman or docker for the Task 5 integration tests (runs a Redis container)
- No GCP account or credentials are needed for the checks below

## Running the checks

```bash
# From the repository root. Each task runs in a subshell so the cds don't leak.

# Task 1
( cd task-1 &&
  terraform fmt -check -recursive &&
  terraform init -backend=false && terraform validate &&
  cd modules/scheduled-function && terraform init && terraform test )

# Task 2
( cd task-2/app &&
  npm ci &&
  npm test &&               # unit tests
  npm run test:emulator )   # Firestore emulator tests (Java 21+)

# Task 3
( cd task-3/functions &&
  npm ci &&
  npm test &&               # unit tests
  npm run test:emulator &&  # Firestore + Functions emulators, both functions loaded (Java 21+)
  npm run test:repro )      # reproduces the original bug on the emulators

# Task 4
( cd task-4/api &&
  npm ci &&
  npm test &&               # unit + schema contract + log-filter checks
  npm run test:emulator )   # HTTP tests + curl suite against the real server on the emulator (Java 21+)

# Task 5
( cd task-5/functions &&
  npm ci &&
  npm test &&               # unit tests (capacity maths, ingest handler)
  npm run test:integration )  # real Redis container + Firestore emulator
( cd task-5/terraform &&
  terraform init -backend=false && terraform validate && terraform test )

# Task 6
( cd task-6/terraform &&
  terraform init -backend=false && terraform validate && terraform test )
```

## AI usage

AI tools that were used, and how they were used is disclosed per task in [`AI_USAGE.md`](AI_USAGE.md).
