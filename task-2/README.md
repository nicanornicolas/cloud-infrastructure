# Task 2: Scheduled sync with Cloud Scheduler, Cloud Run functions and Pub/Sub

Every 10 minutes Cloud Scheduler calls `syncEvriManifest`. It pulls the Evri manifest of parcels heading to our lockers and publishes one Pub/Sub message per parcel. `reserveCompartment` consumes those messages and reserves a free compartment for each parcel. As volumes grew, three problems appeared: **compartments reserved for two parcels**, **parcels never reserved**, and **sync runs that overlap and time out at peak**.

**Scope and constraints:** a 30-minute timebox and no GCP project. The code is tested offline: unit tests with fakes, plus integration tests against the **Firestore emulator**, so the transaction guarantees are checked against real Firestore semantics. `deploy.sh` is a runbook marked **not executed**; it was checked with `bash -n` and `shellcheck`.

```text
task-2/
├── original/index.js            # the code as supplied (reference only)
├── app/                         # one source package, deployed as two functions (different entry points)
│   ├── index.js                 # function registration: thin wiring only
│   ├── lib/sync.js              # sync orchestration: lease, watermark, pagination, checkpoint, re-queue
│   ├── lib/firestore-sync-store.js  # Firestore-backed lease + sync state + re-queue queries
│   ├── lib/reserve.js           # the reservation transaction
│   ├── lib/parcel.js            # message decoding, validation, deterministic shipment IDs
│   ├── lib/config.js  lib/log.js
│   ├── firestore.indexes.json   # composite index for the re-queue sweep
│   └── test/unit/*.test.js  test/emulator/*.test.js
└── deploy.sh                    # gcloud: SAs, topics + DLQ, both functions, Scheduler job
```

---

## Part 1: Causes

### Problem 1: "Some compartments are reserved for two parcels"

| Cause | Mechanism |
|---|---|
| **Check-then-act race (TOCTOU)** | `reserveCompartment` queries "first available compartment in locker X" and then updates it in a **separate, non-transactional** write. Eventarc pushes messages concurrently and the function scales out, so two invocations for the same locker read the same `docs[0]` and both write `status: reserved`. The second write overwrites `parcelRef`. Both create a shipment pointing at the same compartment. **Reproduced in the emulator:** 30 concurrent parcels against 10 free compartments gave 30 shipments, piled onto as few as one compartment ([`test/emulator/original-bug.test.js`](app/test/emulator/original-bug.test.js)). |
| **Duplicate messages reserve again** | Pub/Sub delivers *at least once*, and overlapping sync runs (Problem 3) publish the same parcel twice. Each copy runs the whole flow again and `shipments.add()` uses a random ID, so one parcel gets a **second shipment and a second compartment**. This also uses up compartments, which makes "locker full" (Problem 2) more likely. |

### Problem 2: "Some parcels are never reserved"

| Cause | Mechanism |
|---|---|
| **Relative `since=10m` window** | Each run asks for "the last 10 minutes" *as measured when its request reaches the partner*. Any run that starts late (cold start, Scheduler jitter), fails, times out or is skipped leaves a gap that no later run ever reads. There's no stored record of what was actually synced. |
| **Timeout part-way through the loop** | Publishes are awaited one at a time. When the function hits its timeout halfway through the list, the remaining parcels are never published, and the next run only looks back 10 minutes from *its own* start. |
| **Locker full → crash → message dropped** | With no free compartment, `free.docs[0]` is `undefined` and `compartment.ref` throws a `TypeError`. Gen 2 event-driven functions have **retries off by default**, so the failed message is acked and lost. (With retries on and no dead-letter topic, it is retried until Eventarc's default 24 h retention runs out, and *then* lost.) |
| **No partner error handling** | No `response.ok` check, no timeout, no pagination. A 5xx or 429 body without `parcels` throws, page 2 onwards is never read, and a hung partner uses up the whole timeout. |
| **Two writes that can be split** | Compartment update and shipment creation are separate writes. A crash between them leaves a compartment `reserved` with no shipment. The redelivery then reserves *another* compartment, and the first one is never released. |

### Problem 3: "At peak the sync runs overlap and time out"

| Cause | Mechanism |
|---|---|
| **O(n) sequential publishes** | `await publishMessage()` inside the loop makes one round trip per parcel (tens of ms each), so run time grows linearly with volume. Peak volume makes runs long enough to time out. |
| **Nothing prevents concurrent runs** | Scheduler fires every 10 minutes whether or not the last run has finished, and the function can scale to many instances. If the attempt deadline is shorter than the run (the Scheduler default is 3 minutes), Scheduler records a failure and, if retries are configured, **calls again while the first run is still going**. |
| **The two make each other worse** | Overlapping runs publish the same parcels twice (more duplicates for Problem 1) and compete for the partner API and Pub/Sub, so each gets slower, so more of them time out (Problem 2). |

### Other bugs and risks

| # | Issue | Risk |
|---|---|---|
| 1 | Filters printed as `where("lockerId", "", …)` | Probably `==` lost in the brief's PDF. Taken literally, it's an invalid operator and every call throws. |
| 2 | `JSON.parse` on unvalidated data; no check for `ref` or `lockerId` | A malformed message crashes the function. With retries on and no DLQ it's a poison message. |
| 3 | `parcel.ref` used as data with no normalisation | A ref containing `/` would break any attempt to use it as a document ID. That's why a naive "use the ref as the ID" fix is unsafe (see D2). |
| 4 | No structured logging or correlation IDs | Can't trace which parcel, run or message failed. |
| 5 | The sync function is presumably public, and Scheduler unauthenticated (deployment not shown) | Anyone could trigger syncs. Fixed in `deploy.sh` with internal-only ingress and OIDC. |
| 6 | Runtime identities not shown, so they default to the compute SA | That SA often has Editor. Fixed with one service account per role. |
| 7 | Hot lockers | Every reservation for one locker contends on the same "first free" compartment. Correct with transactions, but it serialises under load (see Follow-ups). |

---

## Part 2: The rewrite

### Requirement → mechanism → proof

| Requirement | How it is met | Proven by |
|---|---|---|
| **No parcel is missed** | Absolute watermark (`sync_state/evri.lastSyncedAt`), re-read with a 2-minute overlap. It **only advances after every page in the window has been published**. Pages are checkpointed (`inProgress.cursor`), so a run that hits its time budget stops cleanly and the next run resumes from the same cursor. Invalid rows are rejected individually rather than failing the whole manifest. A full locker puts the parcel in **`waiting_for_compartment`**, and the sync job re-queues it every 10 minutes, so it's never dropped. | unit: *watermark*, *time budget → resume*, *partner/publish failure*, *invalid parcels*, *expired cursor*, *re-queue*; emulator: *waiting parcel reserved once a compartment frees up* |
| **No compartment double-booked** | The free-compartment query runs **inside a Firestore transaction**, together with the shipment read. If another transaction reserves that compartment first, this one can't commit; Firestore retries it and it picks the next free compartment. Compartment and shipment are written atomically. | emulator: *30 concurrent parcels, 10 compartments* → exactly 10 reserved, each compartment once. The same test against the original logic double-books. |
| **Redelivery never duplicates a shipment** | Deterministic shipment ID `p_<base64url(ref)>`, read first inside the same transaction. A shipment in a terminal state makes the redelivery a no-op. | emulator: *same message delivered 5× concurrently* → 1 shipment, 1 compartment; *sequential redelivery is a no-op* |
| **Full locker ≠ endless retries** | "No free compartment" is a business outcome, **not an exception**. The handler records it and returns, so Pub/Sub acks. Re-attempts happen on our schedule, are bounded (`MAX_WAIT_ATTEMPTS=18`, about 3 h), and end in the terminal `unallocated` state, logged at ERROR for alerting. Only genuine failures throw, and those are retried 5 times with backoff, then dead-lettered. | emulator: *full locker resolves (no throw), bounded attempts, then unallocated* |
| **Runs never overlap** | `max-instances=1, concurrency=1`, **plus** a transactional Firestore lease whose TTL (330 s) is longer than the function timeout (300 s). Only the owner can release it, and a crashed run's lease expires. A run that finds the lease held returns 200 `skipped`. | unit: *overlapping run skipped*, *expired lease taken over*; emulator: *10 concurrent acquirers, exactly one wins* |
| **Runs don't time out** | Publishes run concurrently and the client batches them (100 messages / 50 ms). The partner fetch has a 15 s timeout. Paging stops at a 240 s budget, leaving room inside the 300 s timeout to checkpoint and release the lease. | unit: *time budget* |

### Shipment state machine

```text
                 compartment free                                    
  (message) ──────────────────────────────▶ reserved           (terminal; redelivery = no-op)
      │
      │ locker full
      ▼
  waiting_for_compartment ──(sync re-queues every 10 min)──▶ reserved
      │
      │ attempt 18 still full
      ▼
  unallocated                                                   (terminal; ERROR log → alert → ops)
```

### Design decisions

- **D1. Why does the sync job do the re-queue, instead of retrying through Pub/Sub?** Pub/Sub's retry backoff tops out at 600 s and its attempts are meant for *failures*. Using it for "locker full" would mix a normal business state into the DLQ and the error metrics. An explicit state with `nextAttemptAt` can be queried ("which parcels are waiting for locker X?"), is bounded, and is reported separately.
- **D2. Why `p_<base64url(ref)>` rather than the raw ref as the document ID?** Refs come from a partner and may contain `/` (which creates a sub-path), be `.` or `..` (invalid), or match the reserved `__…__` pattern. base64url can be reversed for debugging, and the prefix rules out the reserved pattern. The raw ref is also stored as a field.
- **D3. Why both `max-instances=1` and a lease?** `max-instances` is a scaling limit, not a lock. During a deploy or revision rollover, two instances can briefly coexist, and someone can trigger a run by hand. The lease is the correctness guarantee; the instance cap saves cost.
- **D4. Why a 2-minute overlap?** It covers clock skew between our clock and the partner's, plus rows the partner commits slightly late. Duplicates from the overlap are harmless because the consumer is idempotent. That's the trade: at-least-once publishing combined with an idempotent consumer.
- **D5. Why throw for invalid messages, rather than ack and log?** A malformed message can't be reserved, and acking it would bury it in logs. Throwing sends it, after 5 attempts, to the dead-letter topic, where it's kept for 7 days and can be inspected and replayed. (Invalid rows in the *manifest* are logged and skipped by the sync job, so one bad row doesn't block everything else.)
- **D6. Why one source package for both functions?** They share the parcel model and shipment ID function. Each deploy uses its own entry point. The cost is a slightly larger bundle; the benefit is a single place where the ID scheme is defined.

---

## Part 3: Deployment (`deploy.sh`)

> **Not executed** (no GCP project). Checked with `bash -n` and `shellcheck` (no findings). Re-runnable: every create is guarded by a `describe`, and `|| true` isn't used, so real errors aren't swallowed.

| Requirement | Implementation |
|---|---|
| Deploy both as Cloud Run functions | `gcloud functions deploy --gen2` (2nd-gen functions *are* Cloud Run functions). Runtime `nodejs24` (`nodejs20` was decommissioned on 2026-10-30). One runtime SA per function. |
| Sync function private | `--no-allow-unauthenticated --ingress-settings=internal-only`. Only the Scheduler SA has `run.invoker`. |
| No overlapping sync runs | `--max-instances=1 --concurrency=1`, plus the lease in code. |
| Consumer retries and a dead-letter topic | `--retry` (off by default). Dedicated `--trigger-service-account` rather than the compute default. A dead-letter policy on the **Eventarc-created subscription** (dead-lettering is a subscription setting, not a topic setting): `--max-delivery-attempts=5`, backoff 10–600 s, `--ack-deadline=120` (above the 60 s timeout). The Pub/Sub service agent gets publisher on the DLQ topic and subscriber on the source subscription. A **pull subscription on the DLQ** with 7-day retention, because a topic with no subscription discards what's published to it. |
| `--concurrency=10` on the consumer | Needs at least 1 vCPU, hence `--cpu=1`. Contention per locker is handled by the transaction. |
| Scheduler: OIDC | `--oidc-service-account-email` (a dedicated SA with `run.invoker` on the sync function only), `--oidc-token-audience` = the function URI. |
| Scheduler: Africa/Nairobi | `--time-zone=Africa/Nairobi`. |
| Scheduler: retry policy | `--max-retry-attempts=2 --min-backoff=30s --max-backoff=120s --max-doublings=2 --max-retry-duration=540s`. A failed run is retried within its own 10-minute slot; after that the next scheduled run, which resumes from the checkpoint, takes over. |
| Scheduler: suitable attempt deadline | `--attempt-deadline=330s`, longer than the 300 s function timeout, so Scheduler never gives up (and retries) on a run that's still working. |

**Deployer prerequisites:** `iam.serviceAccountUser` on the four service accounts (needed to attach them). In projects created before April 2021, the Pub/Sub service agent also needs `roles/iam.serviceAccountTokenCreator` to mint push-auth tokens. **Re-run step 6 after each redeploy of `reserve-compartment`**, because the trigger's subscription can be recreated.

**Region:** `europe-west1` by default, overridable with `REGION=`. If the operation is in Kenya, `africa-south1` (Johannesburg) is closer; check that Cloud Scheduler and Firestore are available there before switching.

---

## Verification

Run locally with Node.js 22.22.2. The emulator needs **Java 21+** (`firebase-tools` 15 no longer supports older Java).

```bash
cd task-2/app
npm ci
npm test                 # 15 unit tests: sync orchestration, partner client, parcel decoding
npm run test:emulator    # 10 tests on the Firestore emulator (starts and stops it automatically)
cd .. && bash -n deploy.sh && shellcheck deploy.sh
```

Results:

```text
npm test               # tests 15  pass 15  fail 0
npm run test:emulator  # tests 10  pass 10  fail 0
                       #   7 for the rewrite + 3 reproducing the ORIGINAL bugs:
                       #   {"shipments":30,"compartmentsUsed":1,...}   <- 30 parcels, 1 compartment
shellcheck deploy.sh   # no findings
```

The three `original-bug` tests run the original reservation logic (with `==` restored) under the same load. They show the new tests aren't trivially passing: they would fail against the original code.

## Assumptions

- **Partner API:** `GET ?since=<ISO-8601>[&cursor=…]` → `{ parcels: [...], nextCursor }`. The brief only shows `since=10m` and `parcels`. If the partner can't filter by absolute time, the watermark has to be built from a cursor or sequence number the partner does provide; the rest of the design stays the same.
- `parcel.ref` is the partner's stable unique parcel ID; `lockerId` matches `compartments.lockerId`.
- Firestore is in Native mode. Releasing compartments (on pickup or expiry) happens elsewhere and sets `status: "available"`.

## Follow-ups

- **Hot-locker contention:** read candidate compartments outside the transaction, shuffle them, and verify one inside the transaction. That spreads concurrent reservations across compartments instead of all contending on the first one. Correctness doesn't change.
- **Alerting:** log-based metrics on `reserve-compartment: unallocated`, `manifest parcel rejected` and `sync failed`, plus a Pub/Sub alert on DLQ subscription backlog > 0.
- **DLQ replay:** a small script that pulls from `reserve-compartment-dlq-sub`, fixes or validates, and republishes.
- **Partner credentials:** if the manifest API needs a key, inject it from Secret Manager (`--set-secrets`), as in Task 1.
- **Infrastructure as code:** move `deploy.sh` into Terraform, reusing the Task 1 module for the Scheduler → function part.

## AI usage for this task

See [`../AI_USAGE.md`](../AI_USAGE.md#task-2).
