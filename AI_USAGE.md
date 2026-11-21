# AI usage disclosure

The assessment requieres us to state which AI tools were used and how. Within this file I record in details, task by task.

## Tools

| Tool | Model | Role |
|---|---|---|
| Google AI Studio | Gemini (the "Gemini 4 Hydrogen" model in AI Studio) | First-draft answer |
| Claude Code (VS Code extension) | Claude Opus 5.5 | Review of the draft, corrections, writing and validating the repository files |

## Task 1

**What I did:** I read the brief and ran the review. I set the constraints: fixture credentials are treated as non-sensitive and handled with a QA note, there's no live GCP project, and every task sits in the repository.

**Gemini (Google AI Studio):** With this I was able to produce the first draft: the list of problems, a module structure, and an import runbook.

**Claude Code then reviewed the draft and found some errors which I had missed, which were corrected:**
- The import plan contradicted the module. The function imported `us-central1` while the module passed `europe-west1`, which in turn would force a destroy and recreate. The scheduler job was imported from the wrong region (it lives in `europe-west1`). The SA and job names didn't match the live resources.
- The module's name validation allowed names that would exceed the 30-character service account ID limit.
- Scheduler retries on a non-idempotent SMS sender would send duplicate messages.
- `nodejs20` is decommissioned, which blocks any redeploy. Verified against Google's runtime lifecycle page.
- The provider pin `~> 6.0` was out of date. The registry shows 8.12.0 as current, so it is now pinned to `~> 8.0`.
- Missing guardrails: basic roles could still be passed to the template, there was no ingress enum, there was no check against secrets in plain env vars, and the backend and project ID were hardcoded to prod.

**Claude Code was used to rewrite** the files in `task-1/` (module, root configuration, tests, README) and ran `terraform fmt`, `validate` and `terraform test` (8/8 passing, mocked provider) on Terraform 1.17.2.

**Facts were checked against primary sources** rather than taken from the AI:
- Node.js runtime dates: https://docs.cloud.google.com/run/docs/runtime-support
- Internal ingress allows same-project Cloud Scheduler: https://docs.cloud.google.com/run/docs/securing/ingress
- Current google provider version: Terraform Registry (`hashicorp/google` 8.12.0)

**My own review:** 

- **Location & Resource Lifecycle:** Verified that keeping `us-central1` for the Cloud Run function avoids a destructive recreate cycle during import, while confirming that new scheduler jobs and invoker resources correctly co-locate in `europe-west1`.
- **IAM & Security Guardrails:** Confirmed that the module's Terraform validations strictly reject basic roles (`roles/owner`, `roles/editor`, `roles/viewer`) and enforce Secret Manager references for plain environment variables.
- **Import Strategy:** Approved the declarative `imports.tf` approach over CLI `terraform import` commands to ensure changes are auditable via standard PR reviews and produce zero unexpected destructions in `terraform plan`.
- **Provider & Backend Pins:** Confirmed provider version pinning to `~> 8.0` (hashicorp/google 8.12.0) and validated partial backend configurations for clean multi-environment deployment (`dev`/`staging`/`prod`).

## Task 2

**Gemini (Google AI Studio):** produced the first draft: root-cause analysis, rewritten functions (Firestore lease, watermark, transactional reservation with a deterministic shipment ID) and a gcloud script.

**Claude Code reviewed the draft and found these errors, which were corrected:**
- **Full lockers were acked and never retried.** The draft recorded `no_compartment` and stopped, so the parcel was silently missed, which breaks the first requirement. It's now a bounded `waiting_for_compartment` state that the sync job re-queues, ending in `unallocated` with an alert.
- **The lease could expire mid-run.** The lease TTL (4 min) was shorter than the function timeout (5 min), so a second run could start while the first was still working. The TTL is now 330 s against a 300 s timeout.
- **One malformed parcel blocked the sync for good.** It threw inside `Promise.all`, so the watermark never advanced. Invalid rows are now rejected individually.
- **A large backlog could never finish.** The watermark only moved at the end of a window, so a backlog bigger than one run never completed. Added cursor checkpoints and a time budget, with resume on the next run.
- **Broken gcloud script:** the `$(...)` substitutions for `PROJECT_NUMBER` and `SUBSCRIPTION_PATH` were mangled. `--concurrency=5` was combined with 256 MiB (below 1 vCPU, which concurrency > 1 requires). Eventarc used the default compute SA. `gcloud config set project` changed the operator's global config, and `|| true` hid real errors.
- **Wrong or unverified claims removed:** that an equality-only query *requires* a composite index, and that Eventarc subscriptions default to a 10-second ack deadline. The ack deadline is now set explicitly instead.
- **Outdated libraries:** `@google-cloud/firestore` ^7, `pubsub` ^4 and `functions-framework` ^3 were updated to the current 9.4.1, 6.4.1 and 5.0.5 (checked on npm). The first two require Node 22+.
- The Scheduler attempt deadline equalled the function timeout; it's now set above it.

**Claude Code then wrote** the files in `task-2/`: the code split into testable modules, 15 unit tests, 10 Firestore-emulator tests (3 of which reproduce the original bugs), `deploy.sh` and the README. It ran all tests (25/25 passing), plus `bash -n` and `shellcheck` on the script.

**Checked against primary sources:**
- Eventarc retry, retention and dead-letter behaviour: https://docs.cloud.google.com/eventarc/docs/retry-events
- Event-driven function retries (off by default): https://docs.cloud.google.com/functions/docs/writing/retries
- Library versions and Node engine requirements: npm registry

**My own review:** 

- **Firestore Concurrency & Transaction Semantics:** Verified via emulator integration tests that executing compartment lookups and shipment writes within a single Firestore transaction prevents double-booking under concurrent load (30 parcels vs. 10 free compartments).
- **Business State vs. System Exceptions:** Reviewed the parcel state machine to ensure full lockers map to a bounded `waiting_for_compartment` state (up to 18 attempts before transitioning to `unallocated` + alert) rather than throwing uncaught exceptions or polluting Pub/Sub dead-letter queues.
- **Overlapping Run Prevention:** Validated the combination of `--max-instances=1` scaling limits and a 330-second transactional Firestore lease TTL to ensure scheduled executions never overlap during cold starts or manual triggers.
- **Deployment Script Safety:** Reviewed `deploy.sh` to ensure proper variable escaping, idempotent resource checks, explicit OIDC token audiences, and least-privilege service account assignments.


## Task 3

**Gemini (Google AI Studio):** produced the first draft: the step-by-step incident trace (self-triggering `updatedAt` write, including the write outside the `if`), a 2nd gen function using a deterministic notification ID with `create()`, and a side-by-side cutover plan. The core diagnosis and approach were sound.

**Claude Code reviewed the draft and found these issues, which were corrected:**
- **The cutover would fail to deploy, unnoticed.** 1st gen has no Node.js 24 runtime. The 1st gen hotfix and the 2nd gen function share a codebase, so `engines.node` must stay `"22"` during the cutover, and is moved to 24 in a final step. The draft didn't address this.
- **Duplicates across the cutover boundary.** `create()` on the deterministic ID doesn't see notifications the *old* code already created with random IDs. The create is now transactional, with a query for any existing notification for that shipment and type.
- **Wrong claim:** "`retry: true` retries for up to 7 days". Eventarc's default retention is 24 hours.
- **Outdated packages:** `firebase-functions` ^6 and `firebase-admin` ^13 were updated to the current 7.4.0 and 14.5.1. The original code only runs on firebase-functions ≤ 5.x (from v6 the root export is the 2nd gen API), which is now stated.
- **Cutover order:** the draft deployed the hotfix and the 2nd gen function together. They're now separate steps: the hotfix first, because it is the urgent incident fix and is independent of the migration. Verification commands are given before deleting the 1st gen function, plus a runtime upgrade step and a rollback path.
- The "V2" name suffix was dropped: `onShipmentDelivered` stays as the permanent name.

**Claude Code then wrote** the files in `task-3/`: a shared idempotent notification module, the 2nd gen function plus the 1st gen hotfix, unit tests, emulator end-to-end tests and the README. It ran everything on the Firebase emulators (9/9 passing). The tests show:
- the original function produces over 100 notifications from one update;
- with both functions running, each transition produces exactly one notification: the 1st gen created 21, and the 2nd gen deduplicated 21.

**Checked against primary sources:**
- Upgrade path (rename, run side by side, delete 1st gen last): firebase-functions 7.4.0 bundled guide `.guides/upgrade.md`
- 1st gen vs 2nd gen Node runtimes: https://docs.cloud.google.com/functions/1stgendocs/runtime-support
- Eventarc retention: https://docs.cloud.google.com/eventarc/docs/retry-events

**My own review:** 

- **Root-Cause Verification:** Confirmed via emulator reproduction tests that stripping the `updatedAt` self-write from the trigger completely resolves the infinite write loop and runaway billing incident.
- **Phased Cutover Strategy:** Approved prioritizing the 1st-gen in-place hotfix deployment first to halt production billing inflation immediately, followed by deploying the 2nd-gen `onShipmentDelivered` function side-by-side.
- **Notification Idempotency:** Verified that combining a transactional query with a deterministic document ID (`notifications/{shipmentId}_ready_for_pickup`) guarantees zero duplicate notifications across both functions during the cutover window.
- **Runtime & Regional Alignment:** Ensured Node.js engine settings remained pinned to `22` during cutover (due to 1st-gen runtime limits) before upgrading to `24`, and confirmed event delivery region co-location (`europe-west1`).


## Task 4

**Gemini (Google AI Studio):** produced the first draft: the log-line analysis (trailing space → 500, offline → 200 `ok:false`, duplicate `JD55122`), a `gcloud logging read` filter plus a duplicate-ref pipeline, a fixed Express handler with transactional `(partner, ref)` idempotency, JSON Schemas, and a v1 → v2 strategy. The diagnosis was good.

**Claude Code reviewed the draft and found these issues, which were corrected:**
- **The fix would have broken JD.** The success response was wrapped in `{ok, data:{…}}`, but JD's client reads `response.id`. The success body is now the original shape with fields added, and a contract test guards it.
- **The fix rejected traffic that succeeds in production.** `"size":"medium"` (sent by JD and currently accepted) got a 400, contradicting the draft's own notes. v1 now accepts and normalises the aliases, logs them as deprecated, and v2 will be strict.
- **The schema and the code disagreed.** The code trimmed `"LK-1187 "`, but the schema's pattern rejected it. `additionalProperties: false` would also break any client sending extra fields. The tolerances are now in the schema, and a contract test checks schema ⇔ validator agreement on 16 cases.
- **No authentication:** anyone could post as `/partners/jd`. Added API-key auth with hashed keys, a partner-match check, and a `report` mode for a non-breaking rollout.
- **Wrong deprecation header syntax:** `Deprecation: true` is the old draft form. RFC 9745 uses a structured date (`@<epoch>`).
- **The `Location` header was mangled** in the PDF output. The ad-hoc error envelope was replaced with RFC 9457 Problem Details (`retryable`, `requestId`).
- **Over-engineering removed:** a mandatory `Idempotency-Key` collection alongside the ref index, and an invented `^LK-[0-9]{4,8}$` locker format that could reject real lockers.
- Status codes chosen and justified: 422 for an unknown locker (not 404), 409 + `retryable` + `Retry-After` for an offline locker, 503 for transient Firestore errors.
- The `gcloud` filter was rewritten with `--freshness=1d`, explicit signals for whitespace IDs and non-canonical sizes, and correct query-string escaping. Its regexes are now tested against the brief's log lines.

**Claude Code then wrote** the files in `task-4/` and ran:
- 7 unit and contract tests;
- 7 log-filter checks;
- 12 HTTP tests on the Firestore emulator, with every response validated against the schemas;
- the curl suite against the real server: 15 cases plus 3 header checks.

All passed. shellcheck is clean on all the scripts.

**Checked against primary sources / registries:** Express 5.3.0 and Ajv 8.20.0 (npm registry). Header standards cited by RFC number: RFC 9457 (Problem Details), RFC 9745 (Deprecation), RFC 8594 (Sunset).

**My own review:** 

- **API Backwards Compatibility:** Rejected proposed changes that wrapped success payloads in `{ok, data}` envelopes, preserving the top-level `id` field to maintain compatibility with existing JD client implementations.
- **Tolerant Reader & Deprecation Strategy:** Approved accepting and normalizing surrounding whitespace and legacy size aliases (`medium` -> `M`) in v1 while outputting structured log warnings to prepare partners for strict v2 validation.
- **RFC Standardized Errors:** Enforced RFC 9457 Problem Details across all error paths (e.g., HTTP 422 for unknown lockers, HTTP 409 + `Retry-After` for offline lockers) and verified Deprecation header syntax (RFC 9745).
- **Idempotency & Contract Testing:** Verified that atomic Firestore transactions on `(partner, ref)` keys ensure safe client retries, and confirmed schema-to-validator alignment across 16 unit and HTTP test scenarios.


## Task 5

**Gemini (Google AI Studio):** produced the first draft:
- the capacity table (the volumes were correct);
- the analysis that `stats/network` breaks first;
- the Pub/Sub → BigQuery subscription + Memorystore + reconciler architecture;
- the code;
- three alerts, with the backlog alert in Terraform.

The architecture was a good choice.

**Claude Code reviewed the draft and found these issues, which were corrected:**
- **Race between the offline sweep and heartbeats.** The read-then-write in the sweeper could overwrite a live locker's status with offline, and the Firestore writes could land out of order. Heartbeat handling and offline marking are now atomic Lua scripts, and Firestore writes are ordered by a `statusVersion` counter (not by time). A test shows a time-based guard would get it wrong.
- **A redelivered old heartbeat moved `lastSeen` backwards** (a false offline). Stale messages are now ignored.
- **A failed Firestore write was lost forever:** the Pub/Sub redelivery was treated as a duplicate. A dirty marker now survives until the write succeeds, and the reconciler retries anything left dirty.
- **A consumer outage would mark all 6,000 lockers offline.** Added a pipeline-stall guard.
- **The 500-operation batch limit** was acknowledged only in the draft's notes, not handled in its code. Now there are per-locker writes with bounded concurrency, tested with 600 lockers at once.
- **The heartbeat counter could be lost.** It was GETDEL'd before the Firestore write. It's now read, written, then decremented.
- **Wrong or unsupported claims:**
  - "~1 write/s per document" is not in Google's docs (they say it depends on the workload); the README now cites what is documented.
  - The write cost was overstated about 2× ($1,800–2,800); at the listed $0.09 per 100k it's about $1,400/month.
- **The backlog alert watched a subscription name that wouldn't exist,** because Eventarc generates it. It's now a regex match, and the BigQuery subscription is watched too.
- **The lockers-offline alert had no metric absence check,** so it would stay silent if the reconciler died. An absence condition and Terraform metric descriptors were added; without the descriptors, `apply` fails before the first data point exists.
- **Other fixes:**
  - The draft returned 202 where the firmware expects 200.
  - It had no device authentication (the draft's diagram claimed it). Added a per-locker HMAC token, with a report mode for rollout.
  - It used an invented `LK-` ID format.
  - It used a paid VPC connector instead of Direct VPC egress.
  - Its package versions were outdated.

**Claude Code then wrote** the files in `task-5/`:
- the capacity script, whose numbers are asserted in a test;
- the functions;
- the Terraform for the pipeline and all three alerts;
- the tests.

It ran:
- 7 unit tests;
- 11 integration tests on a real Redis 7 container plus the Firestore emulator;
- `terraform validate` and 3 plan-time tests;
- shellcheck.

All passed.

**Checked against primary sources:**
- Firestore best practices and the 500 writes/s sequential-index limit: https://docs.cloud.google.com/firestore/docs/best-practices and https://docs.cloud.google.com/firestore/native/docs/solutions/shard-timestamp
- Firestore pricing: https://cloud.google.com/firestore/pricing
- firebase-functions 7.4.0 `networkInterface` / `vpcEgress` options: the bundled type definitions
- Provider and package versions: Terraform Registry, npm

**My own review:** 

- **State Concurrency & Ordering:** Verified that running heartbeat processing and offline sweeps inside atomic Redis Lua scripts—guarded by monotonically increasing `statusVersion` counters—prevents race conditions and out-of-order writes to Firestore.
- **Resilience & Fault Tolerance:** Confirmed that the dirty-marker retry pattern preserves uncommitted Firestore writes across Redis restarts, and verified that stall-guard logic prevents false mass-offline incidents during consumer downtime.
- **Database Architecture & Cost:** Validated the capacity math showing a reduction from ~600 writes/sec to ~23.5 writes/sec at 6,000 lockers, slashing monthly Firestore write costs from ~$1,400 to ~$55.
- **Alerting & Monitoring:** Audited the Terraform monitoring configuration to ensure 5xx ratio metrics, backlog message age thresholds (>120s), and metric absence conditions (`condition_absent`) are properly established.


## Task 6

**Gemini (Google AI Studio):** produced the first draft: a ranked savings table, Terraform for a log exclusion, a storage lifecycle and a staging schedule, a billing budget, a label taxonomy, and "savings not to make" (keep Cloud SQL HA, keep Memorystore Standard, keep warm instances on synchronous APIs). The overall plan and the "do not" section were sound. Its suggested AI-disclosure paragraph was **not used**: it claimed that all code was "independently reviewed", which this file records honestly instead.

**Claude Code reviewed the draft and found these issues, which were corrected:**
- **The log exclusion would have dropped real logs.** `severity <= DEBUG` also matches `DEFAULT`, the severity of unstructured stdout lines (including errors printed without a severity). It's now `severity = DEBUG`, locked in by a test.
- **The lifecycle Terraform created a new bucket** instead of changing the existing 18 TB one. It now adopts the bucket with an `import {}` block, plus `prevent_destroy` and validations against early-deletion charges (Nearline 30-day and Coldline 90-day minimums).
- **The staging schedule would silently do nothing:** the Compute Engine service agent had no start/stop permission. Added a two-permission custom role. The time zone was hard-coded and is now an explicit variable, with a region validation.
- **The budget at $2,500 would alert from day one.** It now steps down per wave, adds a forecast-based rule, and supports per-label budgets. The note that the currency must match the billing account was added.
- **Missing or overstated in the estimates:**
  - the savings table was mangled in the PDF;
  - its percentages were inconsistent (staging "~61%" in one place, "~71%" in another);
  - the Cloud SQL disk can't be shrunk in place, and SSD IOPS scale with size;
  - committed use discounts should come *after* right-sizing;
  - heartbeat request-log volume from Task 5 wasn't accounted for;
  - one-off storage transition fees per object weren't covered.
  The estimates were redone with each assumption stated: about $5,590/month, against the draft's $5,840.
- **Function settings belong in code:** `setGlobalOptions` in the Firebase codebase, not `gcloud`, which the next `firebase deploy` would revert.

**Claude Code then wrote** the files in `task-6/` (Terraform, tests, README) and ran `terraform validate` and 7 plan-time tests on Terraform 1.17.2 with google provider 8.12.0. All passed.

**Checked against primary sources:**
- Provider schema: by `terraform validate` against the real provider (8.12.0).
- Pricing and behaviour cited in the README:
  - logging ingestion at $0.50/GiB, and excluded entries not billed;
  - storage minimum durations: Nearline 30 days, Coldline 90, Archive 365;
  - instance schedules need the Compute Engine service agent's start/stop permission.
  These came from Claude's knowledge. They are consistent with Google's documentation as Claude understood it, but this session didn't open the source pages for them, so check them against the current Cloud Logging pricing, Cloud Storage classes and instance schedule docs before relying on them.

**My own review:** 

- **High-Availability Preservation:** Audited cost recommendations to ensure Cloud SQL HA and Memorystore HA remain enabled, preventing availability risks during traffic peaks.
- **Log Exclusion Precision:** Verified that the log exclusion filter uses exact matching (`severity = DEBUG`) rather than `<= DEBUG` (which would drop unstructured stdout logs) alongside 1% request log sampling to capture ~$1,200/mo in savings.
- **Storage Lifecycle Governance:** Confirmed that the Standard -> Nearline (30d) -> Coldline (90d) lifecycle policy is imported directly into the existing 18 TB bucket via `imports.tf` while observing minimum retention window constraints.
- **Budgeting & Cost Allocation:** Validated multi-wave budget step-downs ($7,700 -> $4,500 -> $2,500), label taxonomy enforcement (`env`, `customer`, `service`), and BigQuery export queries for shared infrastructure cost attribution.

