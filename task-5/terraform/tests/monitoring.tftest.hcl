# Offline plan-time checks of the alert policies (mocked provider, no GCP).
#   cd task-5/terraform && terraform init -backend=false && terraform test

mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}

variables {
  project_id  = "test-project"
  alert_email = "oncall@example.com"
}

run "offline_alert_threshold_and_absence" {
  command = plan

  assert {
    condition     = google_monitoring_alert_policy.lockers_offline.conditions[0].condition_threshold[0].threshold_value == 60
    error_message = "1% of 6,000 lockers = 60."
  }
  assert {
    condition     = length(google_monitoring_alert_policy.lockers_offline.conditions) == 2 && google_monitoring_alert_policy.lockers_offline.combiner == "OR"
    error_message = "Offline alert must also fire when the metric disappears (reconciler down)."
  }
  assert {
    condition     = google_monitoring_alert_policy.lockers_offline.conditions[0].condition_threshold[0].duration == "300s"
    error_message = "Sustained for 5 minutes to avoid paging on a blip."
  }
}

run "threshold_scales_with_fleet" {
  command = plan
  variables {
    fleet_size = 300
  }
  assert {
    condition     = google_monitoring_alert_policy.lockers_offline.conditions[0].condition_threshold[0].threshold_value == 3
    error_message = "1% of 300 lockers = 3."
  }
}

run "backlog_covers_both_subscriptions" {
  command = plan
  assert {
    condition     = length(google_monitoring_alert_policy.heartbeat_backlog.conditions) == 2
    error_message = "Both the state processor and the BigQuery subscription must be watched."
  }
  assert {
    condition     = google_bigquery_table.heartbeats.time_partitioning[0].expiration_ms == 90 * 24 * 60 * 60 * 1000
    error_message = "Raw heartbeats expire after 90 days."
  }
}
