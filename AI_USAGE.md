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
