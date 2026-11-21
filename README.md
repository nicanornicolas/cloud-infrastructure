# Senior Infrastructure Engineer: Practical Assessment

My approach to addressing the six practical tasks about the backend and infrastructure of a parcel locker platform running on Google Cloud and Firebase. Application code is written in JavaScript (Node.js); infrastructure code is Terraform.

Each task has its own folder with a README covering **what I found, what I changed and why**, and how to verify it. No live GCP project was used. Everything that can be checked offline has been checked offline, and commands that would need a real project are marked as such.

## Tasks

| Task | Folder | Summary |
|---|---|---|
| 1 | [`task-1/`](task-1/) | Review a scheduled-function Terraform config, rewrite it as a reusable least-privilege module, and adopt the hand-made production function without recreating it |
| 2 | [`task-2/`](task-2/) | Fix a Scheduler → Pub/Sub → Firestore pipeline that double-books compartments, misses parcels and overlaps runs; idempotent, transactional rewrite with emulator-tested guarantees and a gcloud runbook (DLQ, OIDC, Africa/Nairobi) |
| 3 | [`task-3/`](task-3/) | Diagnose a self-triggering 1st gen Firestore function (duplicate notifications, runaway writes), rewrite it as an idempotent 2nd gen trigger, and cut over with no gap and no duplicates; incident reproduced and fix proven on the Firebase emulators |
| 4 | _to come_ | |
| 5 | _to come_ | |
| 6 | _to come_ | |

## Prerequisites

- Terraform ≥ 1.7 (used here: 1.17.2)
- Node.js ≥ 22 (used here: 22.22.2)
- Java ≥ 21, only for the Firebase emulator tests in Tasks 2 and 3
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
```

## AI usage

AI tools that were used, and how they were used is disclosed per task in [`AI_USAGE.md`](AI_USAGE.md).
