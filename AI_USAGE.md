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

**My own review:** _TODO: what you checked, changed or rejected yourself before submitting._

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

**My own review:** _TODO_

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

**My own review:** _TODO_
