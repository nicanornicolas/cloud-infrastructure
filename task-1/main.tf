# ---------------------------------------------------------------------------
# Shared secret. Terraform owns the secret *container* and who may read it;
# the value is added out of band (gcloud secrets versions add ...) so it never
# appears in code, plan output or state.
# ---------------------------------------------------------------------------
resource "google_secret_manager_secret" "sms_api_key" {
  project   = var.project_id
  secret_id = "sms-api-key"

  replication {
    auto {}
  }
}

# ---------------------------------------------------------------------------
# Scheduled jobs. Adding a new job = one more module block like this.
# ---------------------------------------------------------------------------
module "send_reminders" {
  source = "./modules/scheduled-function"

  project_id    = var.project_id
  region        = var.region
  name          = "send-reminders"
  description   = "Sends parcel pick-up reminder SMS every 15 minutes."
  entry_point   = "sendReminders"
  source_bucket = var.source_bucket
  source_object = var.reminders_source_object
  schedule      = "*/15 * * * *"
  time_zone     = var.time_zone

  secret_environment_variables = {
    SMS_API_KEY = {
      secret_id = google_secret_manager_secret.sms_api_key.secret_id
      version   = var.sms_api_key_version
    }
  }
}
