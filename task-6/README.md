# Task 6: Reduce our GCP costs

The monthly bill is about **USD 7,670** and growing faster than the number of lockers. Management wants a plan to cut it **without hurting reliability**. Last month's breakdown (the figures are illustrative):

| Service | What we run | USD/month |
|---|---|---:|
| Firestore | 2.1 billion reads; the ops dashboard listens to the whole `lockers` collection and refreshes every 5 s | 1,860 |
| Cloud Logging | 3.2 TiB ingested; every service logs at DEBUG in production | 1,520 |
| Cloud Run functions | 14 functions, each with 5 min instances, 2 GiB and CPU always allocated | 1,240 |
| Cloud SQL | db-custom-8-32768, HA, 1 TB SSD, average CPU 6% | 1,150 |
| Compute Engine | 3 × n2-standard-4 staging VMs running 24/7 | 590 |
| Memorystore | 10 GB Standard tier, 1.2 GB used | 520 |
| Cloud Storage | 18 TB Standard; device logs and photos rarely read after 30 days | 410 |
| Network egress | functions in `us-central1` reading Firestore in `europe-west1` | 380 |

**Scope and constraints:** a 30-minute timebox and no GCP project or billing account. Three savings and the budget are implemented in Terraform ([`terraform/`](terraform/)), checked with `terraform validate` and **7 plan-time tests** (mocked provider). Savings are **estimates**, each with its assumption stated, so they can be checked against real billing data before committing to them.

---

## Part 1: Recommendations, ranked

**Ranking rule:** monthly saving relative to effort and risk. Cheap, reversible configuration changes with large savings come first; changes that need a migration or a peak-usage analysis come later. The plan is delivered in three waves.

| # | Recommendation | Est. saving / month | Effort | Risk | Assumption behind the estimate |
|---|---|---:|---|---|---|
| **1** | **Logging:** exclude DEBUG in production (Terraform, done), set `LOG_LEVEL=info` at source, and sample successful heartbeat request logs to 1% | **~$1,200** | Very low | Very low | DEBUG is about 80% of the 3.2 TiB. **Measure first** (Logs Analytics `GROUP BY severity`). Ingestion is the cost driver ($0.50/GiB; excluded entries aren't billed). |
| **2** | **Cloud Run functions:** `minInstances` 5 → **0** for the ~10 event-driven/background functions and **1** for the latency-critical HTTP ones (heartbeat ingest, partner API); memory 2 GiB → **measured p99 + headroom** (typically 512 MiB); CPU only during requests for event-driven functions | **~$900** | Low | Low | 70 always-on 2 GiB instances is the bill; 4 small warm instances plus per-request CPU replaces it. |
| **3** | **Firestore:** stop re-reading the whole `lockers` collection. The dashboard reads one aggregate document (`stats/network`, written once a minute in Task 5) plus a listener **only on lockers that aren't online**. Remove the 5-second refresh: listeners already push changes. | **~$1,600** | Medium (front-end change) | Low | About 90% of the 2.1 B reads are the dashboard re-reading every locker every 5 s for every open client. Task 5 also cuts how often locker documents change, so the remaining listener reads fall further. |
| **4** | **Staging VMs:** run Mon–Fri 07:30–19:30 only (Terraform, done) | **~$360** | Very low | Very low | 60 of 168 hours, so 64% fewer VM-hours. Disks still bill. |
| **5** | **Memorystore:** 10 GB → **4 GB, still Standard tier (HA)** | **~$280** | Low | Low–medium | 1.2 GB used (check the 30-day *peak*); 4 GB leaves more than 3× headroom. Resizing a Standard instance can trigger a failover, so do it in a quiet window. |
| **6** | **Cloud Storage:** device logs and photos go Standard → **Nearline at 30 days → Coldline at 90**; delete device logs after their retention period; abort incomplete uploads (Terraform, done) | **~$250** | Very low | Very low | About 15 of the 18 TB are older than 30 days. **One-off transition fees** are charged per object: check the object count first (Storage Insights). Millions of tiny objects can cost more to move than they save; batch them, or use Autoclass. |
| **7** | **Egress:** move the functions from `us-central1` to `europe-west1`, next to Firestore | **~$350** | Medium | Low–medium | Same-region traffic has no inter-region egress charge. It's a migration (new function, cutover, delete the old one, as in Tasks 1 and 3), and it also removes about 100 ms of transatlantic latency per call. |
| **8** | **Cloud SQL:** right-size *after* 30 days of **peak** CPU, memory, IOPS and connections, e.g. 8 vCPU / 32 GB → 4 vCPU / 16 GB, **keeping HA** | **~$400** | Medium | Medium | 6% *average* CPU hides peaks and says nothing about memory or I/O. **The 1 TB disk can't be shrunk in place.** Reducing it means migrating, and SSD IOPS scale with disk size, so a smaller disk may be slower. |
| **9** | **Committed use discounts** on what's left *after* right-sizing (Cloud SQL, Memorystore) | **~$250** | Low | Low (financial lock-in) | About 25% on ~$750 of Cloud SQL (1-year term) plus ~20% on Memorystore. Committing *before* right-sizing locks in the waste. |
| | **Total** | **~$5,590** | | | **$7,670 → about $2,080 a month (−73%)** |

**Delivery:**
- **Wave 1, this week:** #1, #2, #4, #5, #6. These are configuration-only and reversible, worth about $3,000/month.
- **Wave 2, next sprint:** #3 and #7, which need code and a migration.
- **Wave 3, once 30 days of peak metrics are available:** #8, then #9.

Lower the budget (Part 3) after each wave.

**Also fix the growth, not only the level.** The bill grows faster than the fleet because several costs scale with *lockers × frequency × clients*: the dashboard reads every locker for every viewer, every heartbeat produces a log entry, and every heartbeat produces Firestore writes. The Task 5 redesign plus #1 and #3 makes costs grow roughly linearly with the fleet.

### Code for #2 and #3 (not in Terraform, because these live in application code)
```js
// functions/index.js — right-sized defaults for every function; latency-critical ones override.
const { setGlobalOptions } = require("firebase-functions/v2");
setGlobalOptions({ region: "europe-west1", minInstances: 0, memory: "512MiB", cpu: "gcf_gen1", concurrency: 1 });
// e.g. ingestHeartbeat / partner API: { minInstances: 1, memory: "512MiB", cpu: 1, concurrency: 80 }
```
Settings deployed with Firebase belong in this code. Changing them with `gcloud run services update` would be reverted by the next `firebase deploy`.

```js
// Ops dashboard: one aggregate document + only the lockers that need attention (instead of polling all lockers every 5 s).
onSnapshot(doc(db, "stats/network"), renderTotals);                                  // 1 read per minute
onSnapshot(query(collection(db, "lockers"), where("status", "!=", "online")), renderAlerts); // reads only on change
```

---

## Part 2: Three savings implemented as code

All three are in [`terraform/`](terraform/). They're tested offline (`terraform test`: 7/7) and not applied, since there's no project.

### 1. Log exclusions ([`logging.tf`](terraform/logging.tf))
```hcl
resource "google_logging_project_exclusion" "debug" {
  name   = "exclude-debug"
  filter = "severity = DEBUG"
}
```
- **`severity = DEBUG`, not `severity <= DEBUG`.** `<=` also matches `DEFAULT`, the severity Cloud Logging gives to every *unstructured* stdout line, including errors printed without a severity. A test locks this in.
- A second exclusion drops 99% of **successful** heartbeat request logs (`log_id("run.googleapis.com/requests") AND httpRequest.status < 400 AND sample(insertId, 0.99)`). Every error is kept. At ~518 M heartbeats a month (Task 5), request logs alone would be hundreds of GiB.
- Excluded entries aren't ingested, so they aren't billed. Exclusions are reversible immediately. The lasting fix is `LOG_LEVEL=info` at source, which also saves CPU.

### 2. Storage lifecycle ([`storage.tf`](terraform/storage.tf) + [`imports.tf`](terraform/imports.tf))
- Applied to the **existing** bucket through an `import {}` block. Creating a new bucket would save nothing. The import plan must show only the lifecycle rules as changes, and `prevent_destroy` guards the bucket.
- Standard → Nearline (30 d) → Coldline (90 d) for `device-logs/` and `photos/`. Device logs are deleted after `device_log_retention_days` (365). Incomplete multipart uploads are aborted after 7 days.
- **Validations prevent early-deletion charges:** Coldline only after Nearline's 30-day minimum, and deletion only after Coldline's 90-day minimum. Tested: 120 days is rejected.
- **No Archive class:** photos are retrieved for delivery disputes, and Archive's retrieval fee plus 365-day minimum would cancel the saving.

### 3. Staging out-of-hours schedule ([`compute_schedule.tf`](terraform/compute_schedule.tf))
- `google_compute_resource_policy` with `instance_schedule_policy`: start `30 7 * * 1-5`, stop `30 19 * * 1-5`, in the team's **time zone, as an explicit variable**.
- **The schedule runs as the Compute Engine service agent.** Without `compute.instances.start/stop` it fails silently and the VMs keep running. This config grants exactly those two permissions through a custom role.
- A validation rejects VMs outside the policy's region, because a schedule only applies within its region.
- If the VMs are defined in another Terraform config, add `lifecycle { ignore_changes = [resource_policies] }` there so the two configs don't fight over the attachment.

---

## Part 3: Budget and cost visibility

### `google_billing_budget` ([`budget.tf`](terraform/budget.tf))
- Alerts at **50%, 90% and 100% of actual spend**, plus a **100% of *forecast* spend** rule that warns days earlier.
- Notifications go to a FinOps email channel, and billing admins keep the default emails.
- `credit_types_treatment = "INCLUDE_ALL_CREDITS"` judges the **net** cost, after CUDs.
- **The budget amount steps down** as savings land: 7,700 → about 4,500 after wave 1 → 2,500 target. A $2,500 budget set today would alert on day one, and alerts that fire constantly get ignored.
- The currency must match the billing account's currency, or the API rejects the budget.
- **Per-label budgets** (`label_budgets`, for example `customer = jd` or `env = staging`) use the same thresholds through a label filter.

### Labels: cost per customer and per environment
1. **One taxonomy, enforced in code.** Every labelable resource carries `env` (`prod|staging|dev`), `customer` (`evri|jd|shared`), `service` (`heartbeats|partner-api|reminders|dashboard`) and `managed-by`. The Terraform provider's `default_labels` (set here) applies them everywhere. CI rejects resources without them (a tflint or conftest rule). Firebase functions get labels through their `labels` option.
2. **Export billing to BigQuery** (detailed usage cost export). Every line item has `labels`, so per-customer and per-environment cost is one query:
   ```sql
   SELECT
     (SELECT value FROM UNNEST(labels) WHERE key = 'env')      AS env,
     (SELECT value FROM UNNEST(labels) WHERE key = 'customer') AS customer,
     ROUND(SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 2) AS net_cost
   FROM `billing_export.gcp_billing_export_resource_v1_XXXXXX`
   WHERE invoice.month = '202611'
   GROUP BY env, customer ORDER BY net_cost DESC;
   ```
3. **Environments: use separate projects.** Some charges don't carry resource labels well (Firestore operations, logging ingestion, inter-region egress). A `prod` project and a `staging` project make the environment split exact with no tagging discipline required. Labels then answer the questions *within* a project.
4. **Customers: labels plus allocation.** Firestore, Cloud SQL, logging and the heartbeat pipeline are **shared** by Evri and JD, so one instance's cost can't be labelled per customer. Label what's dedicated (partner-specific buckets, queues and services). For `customer = shared`, split the cost by a usage driver, such as each partner's share of parcels or API requests. Task 4's structured logs already carry `partner`. Agree the allocation rule with finance once, then run it as a scheduled query.

---

## Part 4: Savings I would not make, or only carefully

| Tempting saving | Approx. saving | Why not, or how carefully |
|---|---:|---|
| **Remove Cloud SQL HA** (regional → zonal) | ~half of Cloud SQL | **Not making it.** HA is what keeps bookings and the partner API up during a zonal outage or maintenance. Without it, failover means downtime. The saving (~$500) is small next to the cost of an outage during the morning courier wave. |
| **Downsize Cloud SQL on "6% average CPU"** | ~$400–700 | **Only carefully** (#8). Averages hide peaks; memory (buffer pool) and IOPS are the usual limits. Use 30 days of *peak* CPU, memory, IOPS and connections, step down **one size at a time** with HA kept, and have a rollback window. The disk can't shrink in place. |
| **Memorystore Standard → Basic** | ~$150 more | **Not making it.** Basic has no replica: maintenance or a node failure drops the cache and all connections, and Task 5's live locker state would be rebuilt during an incident. Shrink the size, not the tier. |
| **`minInstances: 0` everywhere** | ~$100 more | **Not for the latency-critical HTTP paths** (lockers' heartbeats, partner API). Cold starts of 1–3 s cause device and partner timeouts and retries. Background functions go to 0. |
| **Drop INFO/WARNING logs, audit logs, or retention** | some | **Not making it.** INFO and above is what incidents are debugged with, and audit logs are a compliance record. Only DEBUG (unread noise) and sampled *successful* request logs go. Errors are always kept. |
| **Delete photos or device logs early, or use Archive class** | small | **Only within legal and contractual retention.** Photos are evidence in delivery disputes. Archive's retrieval fees and 365-day minimum cost more than they save for data that's still occasionally read. |

---

## Verification

Run locally with Terraform 1.17.2 and google provider 8.12.0.

```bash
cd task-6/terraform
terraform fmt -check -recursive
terraform init -backend=false && terraform validate      # Success! The configuration is valid.
terraform test                                           # Success! 7 passed, 0 failed.
```

| Test | Proves |
|---|---|
| `debug_exclusion_keeps_default_severity` | the filter is exactly `severity = DEBUG`; heartbeat sampling keeps all errors and drops 99% of successes |
| `budget_alerts_at_50_90_100_plus_forecast` | thresholds 0.5, 0.9, 1.0 on actual spend, plus one on forecast; amount from the variable |
| `label_budget_filters_by_label` | per-customer budget filters on `customer = jd` |
| `lifecycle_tiers_without_early_deletion` | Standard → Nearline → Coldline, no Archive |
| `rejects_retention_shorter_than_coldline_minimum` | 120-day retention is rejected (early-deletion fee) |
| `rejects_vm_outside_policy_region` | a `us-central1` VM can't be attached to a `europe-west1` schedule |
| `schedule_and_scheduler_permission` | weekday 19:30 stop; the Compute Engine service agent is granted start/stop; all 3 VMs attached |

**To apply for real:**
- copy `terraform.tfvars.example` to `terraform.tfvars`;
- `terraform plan` must show the bucket **imported** with only lifecycle changes, plus new exclusions, policy, role and budget, and **no destroys**;
- apply in wave order;
- watch the next invoice against the budget.

## AI usage for this task

See [`../AI_USAGE.md`](../AI_USAGE.md#task-6).
