# Task 1 — Review and fix a Terraform configuration

A colleague's Terraform deploys a Cloud Run function (2nd gen) that sends parcel pick-up reminder SMS, triggered by Cloud Scheduler every 15 minutes. It works, but it was never reviewed and is about to become the template for every new scheduled job. Anything wrong with it would be copied into every job built from it.

**Scope and constraints:** I am working within a 30-minute timebox with no live GCP project. Thus everything below can be checked offline (`fmt`, `validate`, and `terraform test` with a mocked provider; take a look at [Verification](#verification)). Commands that need a real project (`plan`, `import`, `gcloud`) have been written separately as a runbook and are clearly marked as **not executed**.

```text
task-1/
├── original/main.tf              # the configuration as supplied (reference only, never applied)
├── versions.tf                   # Terraform/provider pins + partial GCS backend
├── providers.tf                  # provider with ADC (no key file)
├── variables.tf / outputs.tf
├── main.tf                       # Secret Manager secret + one module block per scheduled job
├── imports.tf                    # one-off import {} block for the hand-made function (Part 3)
├── env/prod.tfvars               # per-environment values
├── env/prod.backend.hcl          # per-environment state location
└── modules/scheduled-function/   # the reusable module
    ├── main.tf  variables.tf  outputs.tf  versions.tf
    └── tests/scheduled_function.tftest.hcl
```

---

## Part 1 — Problems found (most serious first)

| # | Severity | Problem | Risk |
|---|---|---|---|
| 1 | Critical | **Runtime SA has `roles/owner` on the project** | The function runs with full control of production. A bug, a compromised npm dependency or an SSRF in the function means an attacker can read every database, change IAM or delete the project. As a template, every job would get Owner too. |
| 2 | Critical | **`allUsers` holds `roles/run.invoker`** (and ingress defaults to `ALLOW_ALL`) | Anyone on the internet who finds the URL can trigger the job: customers get spammed with SMS, the SMS budget is burned, and repeated calls cause a denial-of-wallet. It is also why Scheduler "works" without authentication. |
| 3 | Critical | **SMS API key hardcoded in `environment_variables`** | The secret ends up in Git history, in plaintext in the state file, and is visible to anyone who can view the function's config. It can't be rotated without a code change and redeploy. See the [QA note](#qa-note--credentials-in-the-original-configuration). |
| 4 | High | **`credentials = file("sa-key.json")`** | A long-lived, exportable key that doesn't expire and is easy to leak through laptops, CI logs or Git. It ties the config to whoever holds the file. |
| 5 | High | **No remote state backend** | State stays on one laptop: there's no locking (two applies can corrupt it), no history or rollback, no team access, and the plaintext secret from #3 sits on disk. |
| 6 | High | **Scheduler sends unauthenticated requests (no `oidc_token`)** | This only works because of #2. Removing `allUsers` without adding OIDC breaks the job (403). The two have to be fixed together. |
| 7 | High | **Runtime `nodejs20` is decommissioned** (deprecated 2026-04-30, decommissioned 2026-10-30) | No security patches. Google may disable functions still on it, and any change that triggers a rebuild fails. This also blocks Part 3: you can't redeploy on `nodejs20`. |
| 8 | Medium | **Region split:** provider `europe-west1`, function hardcoded to `us-central1`, scheduler job inherits `europe-west1` | Every call crosses the Atlantic (latency, egress), customer phone numbers are processed outside the EU (a data-residency/GDPR question), and you have to look in two regions to understand one job. |
| 9 | Medium | **No explicit `time_zone`** (defaults to UTC) | Harmless for `*/15`, but copied to a "09:00 reminder" job it fires at the wrong local hour and shifts by an hour at every DST change. |
| 10 | Medium | **Mutable source object `reminders.zip`** | Overwriting the zip doesn't change the Terraform config, so no redeploy happens. You can't tell which code is live or roll back to a specific build. |
| 11 | Medium | **No scaling, timeout or retry settings** | Default max instances lets a traffic spike or loop scale out and run up cost. With no explicit retry policy there's no considered decision about duplicate SMS (see design decision D5). |
| 12 | Low | **No `required_version` / `required_providers` pins; everything hardcoded** (project, bucket, names) | A provider major upgrade can change behaviour silently, and the code can't be reused for dev/staging. It isn't a template yet. |
| 13 | Low | **Shared default build identity** | Gen 2 builds run as the project's default build service account, which in many projects has broad (Editor) rights. |

## Part 2 — What I changed and why

### The module (`modules/scheduled-function`)

Each module block creates:

1. **A runtime service account** (`<name>-fn`) with **no project roles by default**. It gets `secretmanager.secretAccessor` only **on the specific secrets it uses**. Extra roles (for example `roles/datastore.user`) must be listed explicitly in `runtime_project_roles`, and a validation **rejects `owner`/`editor`/`viewer`**, so the template can't reintroduce problem #1.
2. **A private function.** `ingress_settings = "ALLOW_INTERNAL_ONLY"` blocks the internet at the network layer. Same-project Cloud Scheduler calling the default `run.app` URL still counts as internal ([Cloud Run ingress docs](https://docs.cloud.google.com/run/docs/securing/ingress)). There is **no `allUsers` binding**. `ALLOW_ALL` isn't accepted. Scaling is bounded: `max_instance_count = 1` and request concurrency 1 suit a periodic batch job and stop two runs overlapping. Timeout and memory are set explicitly.
3. **Secrets from Secret Manager** through `secret_environment_variables`, pinned to a numeric version. A validation **rejects plain env var names that look like secrets** (`*API_KEY*`, `*TOKEN*`, `*SECRET*`, …), so problem #3 can't come back either.
4. **A separate invoker service account** (`<name>-sched`) that holds **only `roles/run.invoker` on this one function's Cloud Run service**. Splitting runtime and invoker identities means the scheduler identity can't read the SMS key, and the function identity can't invoke other services.
5. **A Cloud Scheduler job in the same region** as the function, with an **explicit, required `time_zone`** (no default, so every job owner has to choose one), an **OIDC token** whose audience is the function URI, `attempt_deadline` = function timeout + 30 s, and **`retry_count = 0` by default**.

Default runtime is `nodejs24` (GA, supported until 2028-10-31). A validation rejects `nodejs20` and older ([runtime lifecycle](https://docs.cloud.google.com/run/docs/runtime-support)).

### Root configuration

- **Remote state:** a GCS backend (native locking; the bucket has versioning) using **partial configuration**. `env/<env>.backend.hcl` holds the bucket and prefix, so the same code serves dev, staging and prod: `terraform init -backend-config=env/prod.backend.hcl`.
- **No key file:** the provider uses Application Default Credentials, via SA impersonation locally and Workload Identity Federation in CI.
- **Pins:** Terraform `>= 1.7`, provider `hashicorp/google ~> 8.0` (8.12.0 is the current release). The committed `.terraform.lock.hcl` pins the exact build.
- **No default `project_id`:** the environment is always chosen explicitly through `-var-file=env/<env>.tfvars`. A missing flag fails; it never falls back to prod.
- **The secret container** (`google_secret_manager_secret.sms_api_key`) is managed by Terraform. The **value is added out of band** with `gcloud secrets versions add`, so it never appears in code, plan output or state.

### Adding a new scheduled job

```hcl
module "nightly_locker_health" {
  source        = "./modules/scheduled-function"
  project_id    = var.project_id
  region        = var.region
  name          = "locker-health"
  entry_point   = "checkLockerHealth"
  source_bucket = var.source_bucket
  source_object = "locker-health/3f9c2ab.zip"
  schedule      = "0 2 * * *"
  time_zone     = var.time_zone
  runtime_project_roles = ["roles/datastore.viewer"]
}
```

### Design decisions you may ask about

- **D1. Why are the old SA and scheduler job replaced rather than imported?** They're exactly what needs to change: the SA had Owner and the job had no authentication. Creating new, least-privilege ones and deleting the old ones is simpler and safer than importing them and changing everything about them. Only the function has to be preserved (it holds the URL, revision history and live traffic).
- **D2. Why keep `us-central1`?** A function's `location` can't change in place; changing it forces destroy/recreate, which Part 3 explicitly rules out. Moving to `europe-west1` is a separate blue/green migration (see [Follow-ups](#follow-ups)).
- **D3. Why `Europe/Brussels`?** `*/15` fires the same way in every zone. The explicit zone matters for time-of-day jobs added from this template. Brussels matches the platform's EU home region (`europe-west1`); it should be the business's operating time zone.
- **D4. Why `ALLOW_INTERNAL_ONLY` if OIDC already authenticates?** Defence in depth: IAM is the real control, and ingress takes the endpoint off the internet altogether. The trade-off is that you can't `curl` it from a laptop; trigger it with `gcloud scheduler jobs run` instead.
- **D5. Why `retry_count = 0`?** The handler sends SMS. If an attempt sends messages and then times out, a retry sends them again. The next run is 15 minutes away, so missing one run is better than duplicate texts. Raise it only once the handler is idempotent (for example, a "sent" marker per reminder written in a Firestore transaction).
- **D6. Why pin the secret version instead of `latest`?** Env-var secrets are read when an instance starts. With `latest`, a rotation reaches instances unevenly as they cold-start. Pinning makes rotation an explicit, reviewable change (`sms_api_key_version = "2"`). Alternative: write-only `secret_data_wo` (Terraform ≥ 1.11) if the value should come from CI.

---

## Part 3 — Adopting the hand-created production function

> **Not executed.** No GCP project was available for this assessment. These are the commands I would run, against the IDs from the brief.

### Before anything: is it really unmanaged?
The brief says the function was created by hand, but the colleague's Terraform "works", so a state file may already exist somewhere. If `terraform state list` in that workspace shows `google_cloudfunctions2_function.reminders`, **don't import**: two states managing one resource will fight. Migrate it instead (`terraform state mv` / a `removed {}` block in the old config, then import into the new one).

### Commands before `terraform apply`

```bash
# 0. Static checks
terraform fmt -check -recursive
terraform init -backend-config=env/prod.backend.hcl
terraform validate

# 1. Record exactly what is live (region, runtime, entry point, source, SA, env vars, ingress)
gcloud functions describe send-reminders --region=us-central1 --project=ktsm-prod-4471 --format=yaml
gcloud run services get-iam-policy send-reminders --region=us-central1 --project=ktsm-prod-4471   # expect allUsers today
gcloud scheduler jobs describe send-reminders-every-15m --location=europe-west1 --project=ktsm-prod-4471

# 2. Upload the current production code as an immutable, versioned object (and test it on nodejs24 first)
gsutil cp reminders.zip gs://ktsm-fn-source/reminders/<git-sha>.zip

# 3. Create the secret container, then add the (rotated) value out of band. The value never touches Terraform.
terraform apply -var-file=env/prod.tfvars -target=google_secret_manager_secret.sms_api_key
printf '%s' "$NEW_SMS_API_KEY" | gcloud secrets versions add sms-api-key --data-file=- --project=ktsm-prod-4471

# 4. Optional: compare the live config with the module
terraform plan -var-file=env/prod.tfvars -generate-config-out=generated.tf   # read it, then delete it

# 5. The real plan, saved so that exactly what was reviewed is what gets applied
terraform plan -var-file=env/prod.tfvars -out=tfplan
terraform show tfplan
terraform show -json tfplan | jq -r '.resource_changes[] | select(.change.actions | index("delete")) | .address'   # must print nothing
```

The import is declared in [`imports.tf`](imports.tf) as an `import {}` block rather than through `terraform import` on the CLI. That way it goes through PR review and appears in the plan as *"will be imported"*.

### What to check in the plan

1. **Summary line:** expect roughly `1 to import, 6 to add, 1 to change, 0 to destroy`. **Any destroy, or `-/+` replacement on the function, is a stop.** The usual causes are `location`, `name` or `project` not matching what's live.
2. **The function is `~ update in-place`**, and the only changes are the intended ones:
   - `build_config.runtime`: `nodejs20` → `nodejs24` (code already tested on 24);
   - `build_config.source.storage_source.object`: → the versioned zip containing the **current** production code (not newer, untested code);
   - `service_config.service_account_email`: → `send-reminders-fn@…`;
   - `environment_variables.SMS_API_KEY` removed, and `secret_environment_variables` added with the pinned version;
   - `ingress_settings` → `ALLOW_INTERNAL_ONLY`, plus the scaling and timeout values.
   Anything else in the diff (an entry point, memory or env var you didn't expect) is drift from the hand-made version. Understand it before applying.
3. **New resources:** two service accounts, secret accessor on the one secret, `run.invoker` for the invoker SA only, and the new scheduler job in `us-central1` with `oidc_token`, `time_zone` and `retry_count = 0`.
4. **Nothing references `allUsers` or `roles/owner`.**
5. **Deployer permissions:** the identity running apply needs `iam.serviceAccountUser` on both new SAs, because attaching an SA to a function or job is an "act as" action. Without it, apply fails part-way through.

### Cutover order after apply

1. `terraform apply tfplan`. The function is updated in place, and the new OIDC job exists alongside the old one.
2. **Pause the old job immediately**, so two jobs don't send duplicate SMS: `gcloud scheduler jobs pause send-reminders-every-15m --location=europe-west1`.
3. Force a run of the new job, `gcloud scheduler jobs run send-reminders --location=us-central1`, and check the function logs for a 200 response with the expected reminders sent.
4. Remove public access. The `*_iam_member` resources only add bindings, so the hand-made `allUsers` binding has to be removed explicitly: `gcloud run services remove-iam-policy-binding send-reminders --region=us-central1 --member=allUsers --role=roles/run.invoker`.
5. Delete the old job and the old `reminders-fn` SA (after removing its Owner binding).
6. Remove `imports.tf` in a follow-up PR.

**Rollback:** until step 5, resume the old job and redeploy the previous revision (`gcloud run services update-traffic send-reminders --to-revisions=<previous>=100`).

---

## QA note — credentials in the original configuration

> The values in the original code (`SMS_API_KEY = "sk_live_9f2c41e8"`, `sa-key.json`, project `ktsm-prod-4471`) were provided as assessment fixtures and are not live credentials. In a real environment both would be treated as compromised as soon as they reached Git or state:
> - rotate the SMS provider key, store the new value only in Secret Manager, and disable the old one;
> - delete the service account key (`gcloud iam service-accounts keys delete`) and enforce the org policy `iam.disableServiceAccountKeyCreation`;
> - purge, or restrict access to, any old state files and bucket object versions that contain the plaintext value.

## Verification

Run locally with Terraform 1.17.2 and provider `hashicorp/google` 8.12.0. No GCP credentials are needed.

```bash
cd task-1
terraform fmt -check -recursive                  # formatting
terraform init -backend=false && terraform validate   # root: "Success! The configuration is valid."

cd modules/scheduled-function
terraform init && terraform validate
terraform test                                   # "Success! 8 passed, 0 failed."
```

`terraform test` uses `mock_provider "google"`, so it checks the module's own logic, not Google's API:

| Test | Proves |
|---|---|
| `secure_defaults` | internal-only ingress; only the invoker SA has `run.invoker`; OIDC signed by the invoker SA with the function URI as audience; explicit time zone; scheduler co-located with the function; separate runtime and invoker identities; no project roles; secret access per secret; `SMS_API_KEY` is not a plain env var; `retry_count = 0`; `nodejs24` |
| `rejects_basic_roles` | `roles/owner` can't be granted through the template |
| `rejects_name_too_long_for_service_account` | names that would break the 30-character SA ID limit fail at plan time, not at apply time |
| `rejects_secret_in_plain_env_vars` | `SMS_API_KEY = "…"` in `environment_variables` is refused |
| `rejects_public_ingress` | `ALLOW_ALL` is refused |
| `rejects_decommissioned_runtime` | `nodejs20` is refused |
| `rejects_non_iana_time_zone` | `"Brussels"` is refused (`"Europe/Brussels"` is required) |
| `rejects_timeout_beyond_scheduler_deadline` | a timeout that would push the scheduler deadline past 30 min is refused |

**Not verified offline:** the exact format the API returns for `service_config[0].service` (accepted by `google_cloud_run_v2_service_iam_member` in either short or full form), and anything that depends on real API behaviour. That is what the Part 3 plan review is for.

## Follow-ups

- **Region migration to `europe-west1`:** deploy a second module instance there, run both with the old one's scheduler paused, then remove the US instance. Coordinate with the data-protection owner.
- **Dedicated build SA:** set `build_service_account` once a build SA exists with `roles/cloudbuild.builds.builder`, `roles/logging.logWriter`, `roles/artifactregistry.writer` and read access to the source bucket.
- **Idempotent handler:** once it exists, raise `retry_count` with backoff.
- **Secret replication:** consider `user_managed` replication in EU regions if the SMS key's location matters for compliance.

## AI usage for this task

See [`../AI_USAGE.md`](../AI_USAGE.md#task-1).
