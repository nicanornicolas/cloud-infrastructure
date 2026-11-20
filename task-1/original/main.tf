# ORIGINAL configuration exactly as supplied in the assessment brief (reformatted only).
# Kept for reference and so the Git diff shows what was changed. DO NOT APPLY.
# The credential values below are assessment fixtures, not live secrets — see ../README.md (QA note).

provider "google" {
  project     = "ktsm-prod-4471"
  region      = "europe-west1"
  credentials = file("sa-key.json")
}

resource "google_service_account" "reminders" {
  account_id = "reminders-fn"
}

resource "google_project_iam_member" "reminders_owner" {
  project = "ktsm-prod-4471"
  role    = "roles/owner"
  member  = "serviceAccount:${google_service_account.reminders.email}"
}

resource "google_cloudfunctions2_function" "reminders" {
  name     = "send-reminders"
  location = "us-central1"

  build_config {
    runtime     = "nodejs20"
    entry_point = "sendReminders"
    source {
      storage_source {
        bucket = "ktsm-fn-source"
        object = "reminders.zip"
      }
    }
  }

  service_config {
    service_account_email = google_service_account.reminders.email
    environment_variables = {
      SMS_API_KEY = "sk_live_9f2c41e8"
    }
  }
}

resource "google_cloud_run_service_iam_member" "public" {
  location = google_cloudfunctions2_function.reminders.location
  service  = google_cloudfunctions2_function.reminders.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_scheduler_job" "reminders" {
  name     = "send-reminders-every-15m"
  schedule = "*/15 * * * *"

  http_target {
    uri         = google_cloudfunctions2_function.reminders.service_config[0].uri
    http_method = "POST"
  }
}
