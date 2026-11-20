# Offline tests for the module: the google provider is mocked, so no GCP project or credentials are needed.
#   cd task-1/modules/scheduled-function && terraform init && terraform test

mock_provider "google" {}

# Mocks generate random strings for computed attributes; IAM members must be well-formed,
# so give each service account a realistic (and distinct) identity.
override_resource {
  target = google_service_account.runtime
  values = {
    email  = "send-reminders-fn@test-project.iam.gserviceaccount.com"
    member = "serviceAccount:send-reminders-fn@test-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.invoker
  values = {
    email  = "send-reminders-sched@test-project.iam.gserviceaccount.com"
    member = "serviceAccount:send-reminders-sched@test-project.iam.gserviceaccount.com"
  }
}

variables {
  project_id    = "test-project"
  region        = "us-central1"
  name          = "send-reminders"
  entry_point   = "sendReminders"
  source_bucket = "test-fn-source"
  source_object = "reminders/abc1234.zip"
  schedule      = "*/15 * * * *"
  time_zone     = "Europe/Brussels"

  secret_environment_variables = {
    SMS_API_KEY = { secret_id = "sms-api-key", version = "1" }
  }
}

run "secure_defaults" {
  command = apply

  assert {
    condition     = google_cloudfunctions2_function.this.service_config[0].ingress_settings == "ALLOW_INTERNAL_ONLY"
    error_message = "Function must not be reachable from the internet by default."
  }

  assert {
    condition     = google_cloud_run_v2_service_iam_member.invoker.member == google_service_account.invoker.member
    error_message = "Only the dedicated scheduler invoker SA may hold run.invoker (no allUsers)."
  }

  assert {
    condition     = google_cloud_scheduler_job.this.http_target[0].oidc_token[0].service_account_email == google_service_account.invoker.email
    error_message = "Scheduler must authenticate with an OIDC token signed by the invoker SA."
  }

  assert {
    condition     = google_cloud_scheduler_job.this.http_target[0].oidc_token[0].audience == google_cloudfunctions2_function.this.service_config[0].uri
    error_message = "OIDC audience must be the function URI."
  }

  assert {
    condition     = google_cloud_scheduler_job.this.time_zone == "Europe/Brussels"
    error_message = "Scheduler job must use the explicit time zone."
  }

  assert {
    condition     = google_cloud_scheduler_job.this.region == google_cloudfunctions2_function.this.location
    error_message = "Scheduler job and function must be co-located."
  }

  assert {
    condition     = google_service_account.runtime.email != google_service_account.invoker.email
    error_message = "Runtime and invoker identities must be separate."
  }

  assert {
    condition     = length(google_project_iam_member.runtime) == 0
    error_message = "Runtime SA must have no project-level roles unless explicitly requested."
  }

  assert {
    condition     = google_secret_manager_secret_iam_member.runtime["sms-api-key"].role == "roles/secretmanager.secretAccessor"
    error_message = "Runtime SA must get accessor on the specific secret only."
  }

  assert {
    condition     = !contains(keys(coalesce(google_cloudfunctions2_function.this.service_config[0].environment_variables, {})), "SMS_API_KEY")
    error_message = "SMS_API_KEY must not be a plain environment variable."
  }

  assert {
    condition     = google_cloud_scheduler_job.this.retry_config[0].retry_count == 0
    error_message = "Retries default to 0 to avoid duplicate SMS from a non-idempotent handler."
  }

  assert {
    condition     = google_cloudfunctions2_function.this.build_config[0].runtime == "nodejs24"
    error_message = "Default runtime should be a supported LTS (nodejs24)."
  }
}

run "rejects_basic_roles" {
  command = plan
  variables {
    runtime_project_roles = ["roles/owner"]
  }
  expect_failures = [var.runtime_project_roles]
}

run "rejects_name_too_long_for_service_account" {
  command = plan
  variables {
    name = "this-name-is-far-too-long-x"
  }
  expect_failures = [var.name]
}

run "rejects_secret_in_plain_env_vars" {
  command = plan
  variables {
    environment_variables = { SMS_API_KEY = "sk_live_9f2c41e8" }
  }
  expect_failures = [var.environment_variables]
}

run "rejects_public_ingress" {
  command = plan
  variables {
    ingress_settings = "ALLOW_ALL"
  }
  expect_failures = [var.ingress_settings]
}

run "rejects_decommissioned_runtime" {
  command = plan
  variables {
    runtime = "nodejs20"
  }
  expect_failures = [var.runtime]
}

run "rejects_non_iana_time_zone" {
  command = plan
  variables {
    time_zone = "Brussels"
  }
  expect_failures = [var.time_zone]
}

run "rejects_timeout_beyond_scheduler_deadline" {
  command = plan
  variables {
    timeout_seconds = 3600
  }
  expect_failures = [var.timeout_seconds]
}
