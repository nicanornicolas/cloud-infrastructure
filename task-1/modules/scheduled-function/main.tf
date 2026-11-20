# Reusable "scheduled function" module:
#   Cloud Scheduler --(OIDC token, dedicated invoker SA)--> private Cloud Run function (dedicated runtime SA)
#                                                            └─ reads only its own secrets from Secret Manager

locals {
  labels = merge(var.labels, {
    managed-by    = "terraform"
    scheduled-job = var.name
  })

  # One IAM binding per distinct secret, even if two env vars read the same secret.
  secret_ids = toset([for s in values(var.secret_environment_variables) : s.secret_id])
}

# ---------------------------------------------------------------------------
# 1. Runtime identity — what the function code runs as. No project-wide roles by default.
# ---------------------------------------------------------------------------
resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${var.name}-fn"
  display_name = "Runtime SA for scheduled job ${var.name}"
}

resource "google_project_iam_member" "runtime" {
  for_each = toset(var.runtime_project_roles)

  project = var.project_id
  role    = each.value
  member  = google_service_account.runtime.member
}

# Secret access is granted on each secret, not on the project.
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each = local.secret_ids

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.runtime.member
}

# ---------------------------------------------------------------------------
# 2. The function — private, bounded, secrets injected from Secret Manager.
# ---------------------------------------------------------------------------
resource "google_cloudfunctions2_function" "this" {
  project     = var.project_id
  name        = var.name
  location    = var.region
  description = var.description
  labels      = local.labels

  build_config {
    runtime         = var.runtime
    entry_point     = var.entry_point
    service_account = var.build_service_account

    source {
      storage_source {
        bucket = var.source_bucket
        object = var.source_object
      }
    }
  }

  service_config {
    service_account_email            = google_service_account.runtime.email
    ingress_settings                 = var.ingress_settings
    all_traffic_on_latest_revision   = true
    min_instance_count               = 0
    max_instance_count               = var.max_instance_count
    max_instance_request_concurrency = 1
    available_memory                 = var.available_memory
    timeout_seconds                  = var.timeout_seconds
    environment_variables            = var.environment_variables

    dynamic "secret_environment_variables" {
      for_each = var.secret_environment_variables
      content {
        key        = secret_environment_variables.key
        project_id = var.project_id
        secret     = secret_environment_variables.value.secret_id
        version    = secret_environment_variables.value.version
      }
    }
  }

  # The deploy validates secret access, so the IAM grant must exist first.
  depends_on = [google_secret_manager_secret_iam_member.runtime]
}

# ---------------------------------------------------------------------------
# 3. Invoker identity — what Cloud Scheduler signs its OIDC token as.
#    Separate from the runtime SA: it can invoke this one function and nothing else.
# ---------------------------------------------------------------------------
resource "google_service_account" "invoker" {
  project      = var.project_id
  account_id   = "${var.name}-sched"
  display_name = "Scheduler invoker SA for ${var.name}"
}

# A 2nd-gen function is served by a Cloud Run service; invocation is authorised by run.invoker on it.
# Referencing service_config[0].service avoids assuming the service name equals the function name.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloudfunctions2_function.this.service_config[0].service
  role     = "roles/run.invoker"
  member   = google_service_account.invoker.member
}

# ---------------------------------------------------------------------------
# 4. The schedule — same region as the function, explicit time zone, authenticated call.
# ---------------------------------------------------------------------------
resource "google_cloud_scheduler_job" "this" {
  project          = var.project_id
  region           = var.region
  name             = var.name
  description      = var.description
  schedule         = var.schedule
  time_zone        = var.time_zone
  attempt_deadline = "${var.timeout_seconds + 30}s"

  retry_config {
    retry_count = var.retry_count
  }

  http_target {
    uri         = google_cloudfunctions2_function.this.service_config[0].uri
    http_method = var.http_method

    oidc_token {
      service_account_email = google_service_account.invoker.email
      audience              = google_cloudfunctions2_function.this.service_config[0].uri
    }
  }

  # Don't start firing until the invoker is actually allowed to call the function.
  depends_on = [google_cloud_run_v2_service_iam_member.invoker]
}
