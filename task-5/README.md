# Task 5: Scale locker heartbeats and set up alerting

Every locker sends a heartbeat every 30 seconds to one Cloud Run function. That works for **300 lockers today**, but the network will grow to **about 6,000 in 2027**. Each heartbeat currently does three sequential Firestore writes: the locker document, a new `heartbeats` document, and an increment on one `stats/network` document.

**Scope and constraints:** a 30-minute timebox and no GCP project. The numbers are computed by [`scripts/capacity.js`](functions/scripts/capacity.js) and asserted in a test. The redesign is tested against a **real Redis** (container) and the **Firestore emulator**. The Terraform is checked with `validate` and plan-time tests (mocked provider). Deployment is not executed.

```text
task-5/
├── original/index.js                 # the function as supplied
├── functions/
│   ├── index.js                      # ingestHeartbeat, processHeartbeat, reconcileLockers (wiring only)
│   ├── lib/ingest.js                 # HTTP -> validate -> device token -> Pub/Sub
│   ├── lib/scripts.js                # Redis keys + atomic Lua scripts (heartbeat, mark offline, clear dirty)
│   ├── lib/state.js                  # processor: Redis every heartbeat, Firestore on change only
│   ├── lib/reconcile.js              # every minute: offline sweep, safety-net flush, stats roll-up, gauges
│   ├── lib/heartbeat.js  lib/metrics.js
│   ├── scripts/capacity.js           # Part 1 numbers
│   └── test/unit/  test/integration/ # unit + real-Redis/Firestore-emulator tests
└── terraform/
    ├── pipeline.tf                   # topic, BigQuery table, BigQuery subscription (+DLQ)
    ├── monitoring.tf                 # Part 3: notification channel, metric descriptors, 3 alert policies
    └── tests/monitoring.tftest.hcl
```

---

## Part 1: The numbers, and what breaks first

One heartbeat per locker every 30 s is 2,880 heartbeats per locker per day. Each one costs 3 Firestore writes.

| Metric | 300 lockers | 6,000 lockers |
|---|---:|---:|
| **Requests per second** (average) | **10** | **200** |
| **Firestore writes per second** | **30** | **600** |
| …of which to the **single** `stats/network` document | 10 | 200 |
| **Heartbeat documents per day** | **864,000** | **17,280,000** |
| Firestore writes per day | 2,592,000 | 51,840,000 |
| Firestore write cost per month (at $0.09 / 100k) | ~$70 | **~$1,400** |

Those are averages. Lockers that heartbeat on clock boundaries (`:00`/`:30`) arrive in bursts several times higher.

### What breaks first, in order

1. **`stats/network`: one document taking every heartbeat.** Every request does `update(heartbeatCount: increment(1))` on the **same document**, and it's **awaited on the request path**. Writes to a single document are serialised. Google doesn't give a fixed per-document limit: the sustainable rate "depends highly on the workload", including contention and indexes, and should be load-tested. 10 updates/s already queue up today. At 200/s on one document, latency climbs, then updates fail with contention or deadline errors. Because the handler awaits this write *after* the other two, failures **turn successful heartbeats into 500s**. The locker retries, which adds more load and duplicate `heartbeats` documents. It's the only part of the design that doesn't scale out at all, so it breaks first. It also contributes nothing a once-a-minute roll-up couldn't provide.
2. **The `heartbeats` collection: indexed timestamps plus unbounded growth.** `at: new Date()` is automatically indexed and always increasing. Google documents a limit of **500 writes/s for a collection with a monotonically increasing indexed field**. 200/s on average stays under it, but boundary bursts and post-outage reconnects (6,000 lockers retrying at once) don't. The same applies to `lockers.lastSeen`. Meanwhile the collection grows by **17.3 million documents a day** with no TTL. This is the cost problem (~$1,400/month in writes alone, plus growing storage and index costs) for data that's only ever read in aggregate.
3. **The coupled request path.** Three sequential awaited writes per request make the locker's request latency equal to the database's latency. Any Firestore slowness becomes timeouts, retries and instance scale-out exactly during bursts.

Smaller issues in the code: no `initializeApp()` (as written, `getFirestore()` throws at load), no input validation (a missing `lockerId` crashes the request), no device authentication (anyone can fake heartbeats for any locker), and `update()` on `stats/network` fails if that document doesn't exist.

---

## Part 2: The redesign

```text
 lockers ──HTTPS + device token──▶ ingestHeartbeat (Cloud Run fn)      validate, auth, publish, 200
                                          │  no database on the request path
                                          ▼
                                 Pub/Sub: locker-heartbeats  ◀── absorbs bursts, retains 24 h for replay
                          ┌───────────────┴──────────────────┐
                          ▼                                  ▼
          BigQuery subscription (no code)        processHeartbeat (Eventarc, retries)
          telemetry.locker_heartbeats              │ every heartbeat: 1 atomic Lua call
          partitioned by day, clustered by         ▼
          locker_id, 90-day expiry          Memorystore Redis ── live state, last-seen sorted set
          = full history, cheap SQL                │ only on change / 5-min checkpoint
                                                   ▼
                                          Firestore lockers/{id}  ◀── what apps and the Task 4 API read
                                                   ▲
          Cloud Scheduler (every 1 min) ──▶ reconcileLockers: offline sweep (atomic), retry
                                            failed writes, stats/network ×1/min, gauges ──▶ Cloud Monitoring
```

| Component | Role | Why this service |
|---|---|---|
| **ingestHeartbeat** | Validate, authenticate with a per-locker HMAC token, publish, return 200 | The request path is just Pub/Sub. A slow database can't make lockers time out. It still returns **200** (not 202), because the existing firmware expects it. |
| **Pub/Sub** | Buffer and fan-out | Smooths bursts, retries consumers, and keeps 24 h for replay after a bug. |
| **BigQuery subscription** | Raw history | Replaces the 17.3 M Firestore documents a day. No consumer code. Day partitions expire after 90 days. `message_id` is stored for deduplication. |
| **Memorystore (Redis)** | Live state of every locker | 200 small writes/s is trivial for Redis. A sorted set of `lastSeen` makes "who has been silent for 90 s?" one range query. |
| **processHeartbeat** | Updates Redis on every heartbeat; writes Firestore only when needed | Firestore receives a write **only** when a locker comes online, its doors change, or a 5-minute checkpoint is due. |
| **reconcileLockers** | Every minute: marks lockers offline, retries failed Firestore writes, rolls up `stats/network`, writes gauges | `stats/network` goes from 200 writes/s to **1 write a minute**. |

**Result at 6,000 lockers:** Firestore goes from **600 writes/s to about 23.5/s** (20/s checkpoints, about 3.5/s door changes, plus stats), and from **~$1,400 to ~$55 a month** in writes. No single document receives more than one write a minute, and no collection's indexed timestamp sees more than about 24 writes/s.

### Correctness: four bugs in the first draft, fixed and tested
A plausible version of this design has subtle state bugs. Each fix below has an integration test.

| Problem | Fix |
|---|---|
| The offline sweep read a locker's status and then wrote "offline". A heartbeat arriving in between was overwritten, so a live locker showed offline. | Heartbeat processing and offline marking are **Lua scripts**, which run atomically in Redis, so they can't interleave. |
| An "offline" write and an "online" write racing to Firestore could land in the wrong order. | Every status change increments **`statusVersion`** in Redis, and the Firestore write is a transaction that only applies a **higher version**. Time can't be used for this: a heartbeat *received* before the sweep but *processed* after it is older, yet must win. Test: *late heartbeat wins by statusVersion*. |
| A redelivered old message moved `lastSeen` backwards, causing a false offline. | The script ignores any heartbeat not newer than `lastSeen`, and it isn't counted twice. |
| A failed Firestore write was lost: the redelivery was skipped as a duplicate. | A **dirty marker** (hash field plus set) is cleared only after a successful write, and only if nothing changed meanwhile. The redelivery retries the write, and the reconciler flushes anything still dirty every minute. |
| If the consumer stalls (Redis down, a bad deploy), every locker looks silent, and the sweep would mark **6,000 lockers offline**. | **Stall guard:** if no heartbeat at all has been processed for 60 s, the silence is ours, so offline marking is suspended, logged as an ERROR, and covered by the backlog alert. |

Also handled: outages bigger than Firestore's 500-operation batch limit (per-locker writes with bounded concurrency; test with 600 lockers at once), and the heartbeat counter (read, written to Firestore, *then* decremented, so a failed stats write loses nothing).

### Code that changed
- [`functions/lib/ingest.js`](functions/lib/ingest.js): the new HTTP handler.
- [`functions/lib/scripts.js`](functions/lib/scripts.js): the three Lua scripts (heartbeat, mark offline, clear dirty) and the Redis key layout.
- [`functions/lib/state.js`](functions/lib/state.js): processor logic and the version-guarded Firestore sync.
- [`functions/lib/reconcile.js`](functions/lib/reconcile.js): offline sweep, stall guard, flush, stats roll-up.
- [`functions/index.js`](functions/index.js): wiring. `europe-west1`, **Direct VPC egress** to reach Memorystore's private IP (`networkInterface`, so there's no Serverless VPC Access connector to pay for), secrets from Secret Manager, `minInstances: 1` on ingest for the boundary bursts.

### Cost at 6,000 lockers (approximate list prices; check with the pricing calculator)
| Item | Today's design | New design |
|---|---:|---:|
| Firestore writes | ~$1,400/mo | ~$55/mo |
| Firestore storage | grows by ~17 M documents a day, indefinitely | `lockers` only (6,000 documents) |
| Memorystore Basic 1 GB | — | ~$35–50/mo (Standard tier with HA is about 2×) |
| BigQuery storage (90 days of heartbeats, ~300 GB) plus subscription throughput | — | low tens of $/mo |
| Cloud Run request fees (ingest + processor, ~518 M each per month) | ~$207/mo (ingest) | ~$415/mo |

The new design costs roughly a quarter of the old one, it has no single-document hotspot, and history becomes queryable with SQL. **The next cost lever** is the processor's per-request fee: run it as a Cloud Run service with a streaming pull subscription (instance-based billing, batching a second of heartbeats per Redis round trip). It wasn't needed to meet the brief, so it's listed as a follow-up.

**Rollout:** deploy the new functions alongside the old one, and point lockers at the new URL (or route the old URL to it) in stages. Device-token auth starts in **report mode** (`HEARTBEAT_AUTH_MODE=report`) until the firmware sends tokens, then switches to `enforce`. Also add **jitter** (±5 s) to the firmware heartbeat timer, so the fleet doesn't hit `:00`/`:30` together.

---

## Part 3: Alerts

| # | Alert | Metric | Condition | Threshold | Why this threshold |
|---|---|---|---|---|---|
| 1 | **Lockers offline** (CRITICAL) | `custom.googleapis.com/lockers/offline` (gauge written by `reconcileLockers` every minute) | `ALIGN_MAX` over 60 s, **> threshold for 5 min**, **OR the metric is absent for 10 min** | **> 1% of fleet** (60 of 6,000; derived from `fleet_size`) | One locker offline is an ops ticket, not a page. More than 1% sustained means a regional outage or a problem on our side. The absence condition catches the case where the reconciler itself is dead, which a threshold alone can't. |
| 2 | **Ingest 5xx ratio** (ERROR) | `run.googleapis.com/request_count` for service `ingestheartbeat`, by `response_code_class` (PromQL) | `5xx / total` over 5 min, for 5 min | **> 1%** | A ratio works at 300 or 6,000 lockers, where an absolute rate wouldn't. Sustained 5xx means live state is being lost even though lockers retry. |
| 3 | **Heartbeat backlog** (WARNING) | `pubsub.googleapis.com/subscription/oldest_unacked_message_age` on the processor's Eventarc subscription **and** the BigQuery subscription | `ALIGN_MAX` over 60 s, for 5 min | **> 120 s** (4 heartbeat intervals) | Message *age*, not count, so a burst that drains in seconds doesn't page. While this fires, the stall guard holds offline marking. |

**All three are in Terraform** ([`terraform/monitoring.tf`](terraform/monitoring.tf)); the brief asked for one. Details worth explaining:
- **Metric descriptors are declared in Terraform**, so the policy can be created before the first data point exists. Otherwise `apply` fails with "cannot find metric".
- **The processor's subscription name is generated by Eventarc**, so the backlog condition matches it with `monitoring.regex.full_match("eventarc-.*processheartbeat.*")` rather than a guessed fixed name.
- The thresholds are variables; the tests show the offline threshold becomes 3 for a 300-locker fleet.

The lockers-offline policy, as written in [`terraform/monitoring.tf`](terraform/monitoring.tf):

```hcl
resource "google_monitoring_alert_policy" "lockers_offline" {
  display_name = "Lockers offline above ${var.offline_alert_fraction * 100}% of fleet"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "Offline lockers > ${local.offline_threshold} for 5 min"
    condition_threshold {
      filter          = "resource.type = \"global\" AND metric.type = \"${google_monitoring_metric_descriptor.lockers_offline.type}\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.offline_threshold          # ceil(6000 * 0.01) = 60
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger { count = 1 }
    }
  }

  conditions {
    display_name = "Offline-lockers metric missing for 10 min (reconciler not running)"
    condition_absent {
      filter   = "resource.type = \"global\" AND metric.type = \"${google_monitoring_metric_descriptor.lockers_offline.type}\""
      duration = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.oncall.id]
  alert_strategy { auto_close = "3600s" }
  documentation { mime_type = "text/markdown"  content = "...runbook..." }
}
```

---

## Verification

Run locally with Node.js 22.22.2, Redis 7 (podman), the Firestore emulator (Java 21) and Terraform 1.17.2 with google provider 8.12.0.

```bash
cd task-5/functions
npm ci
npm run capacity         # prints the Part 1 table
npm test                 # 7 unit: capacity numbers, ingest handler (auth/validation/503), gauge format
npm run test:integration # 11 on real Redis + Firestore emulator (starts/stops a Redis container)
cd ../terraform
terraform init -backend=false && terraform validate && terraform test   # 3 plan-time tests
```

```text
npm test               -> # pass 7  # fail 0
npm run test:integration -> # pass 11 # fail 0
terraform validate     -> Success! The configuration is valid.
terraform test         -> Success! 3 passed, 0 failed.
shellcheck test/integration/run.sh -> clean
```

| Integration test | Proves |
|---|---|
| first heartbeat | online in Redis and Firestore, `statusVersion` 1 |
| steady heartbeats | **9 heartbeats, 0 Firestore writes** (document `updateTime` unchanged) |
| door change / checkpoint | exactly one write each |
| out-of-order redelivery | `lastSeen` never goes backwards; duplicates aren't counted |
| failed Firestore write | retried by the redelivery; the dirty set ends empty |
| reconcile | silent over 90 s → offline; stats rolled up once; gauges written |
| late heartbeat after offline | **wins by version**, where a time-based guard would wrongly stay offline |
| version guard | Firestore never moves to an older status |
| pipeline stall | no false mass-offline |
| 600 lockers offline at once | all written; no batch-limit failure |
| stats write failure | heartbeat counter preserved and written next run |

## Assumptions and follow-ups
- **Door-change rate** assumed at 50 per locker per day (deposits plus pickups) for the cost model. It's a parameter in `capacity.js`.
- **Memorystore Basic tier** is a single node. If Redis is lost, live state rebuilds from the next heartbeats within 30 s, and the stall guard prevents false offlines meanwhile. Use Standard (HA) if 30 s of degraded live state isn't acceptable.
- **Decommissioned lockers** must be removed from `lockers:last_seen`, or they count as offline forever.
- **The processor's Eventarc subscription** should get a dead-letter topic, as in Task 2.
- Follow-ups: streaming-pull processor (cost), per-area offline alerting from BigQuery, and a dashboard of online/offline gauges.

## AI usage for this task

See [`../AI_USAGE.md`](../AI_USAGE.md#task-5).
