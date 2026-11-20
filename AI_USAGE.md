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
