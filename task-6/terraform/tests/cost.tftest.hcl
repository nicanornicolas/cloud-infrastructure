# Offline plan-time checks (mocked provider, no GCP).   terraform init -backend=false && terraform test

mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}

# The bucket is adopted via an import block; mocked providers cannot import, so give it fixed values.
override_resource {
  target = google_storage_bucket.assets
  values = {}
}

variables {
  project_id         = "test-project"
  assets_bucket_name = "test-assets"
  office_time_zone   = "Africa/Nairobi"
  billing_account_id = "012345-6789AB-CDEF01"
  budget_alert_email = "finops@example.com"
  monthly_budget     = 7700
}

run "debug_exclusion_keeps_default_severity" {
  command = plan
  assert {
    condition     = google_logging_project_exclusion.debug.filter == "severity = DEBUG"
    error_message = "Must exclude exactly DEBUG; 'severity <= DEBUG' would also drop DEFAULT-severity (unstructured) logs."
  }
  assert {
    condition     = strcontains(google_logging_project_exclusion.heartbeat_success_requests.filter, "httpRequest.status < 400") && strcontains(google_logging_project_exclusion.heartbeat_success_requests.filter, "sample(insertId, 0.99)")
    error_message = "Only successful heartbeat requests are sampled (99% excluded); errors are always kept."
  }
}

run "budget_alerts_at_50_90_100_plus_forecast" {
  command = plan
  assert {
    condition     = [for t in google_billing_budget.monthly.threshold_rules : t.threshold_percent if t.spend_basis == "CURRENT_SPEND"] == [0.5, 0.9, 1.0]
    error_message = "Budget must alert at 50%, 90% and 100% of actual spend."
  }
  assert {
    condition     = length([for t in google_billing_budget.monthly.threshold_rules : t if t.spend_basis == "FORECASTED_SPEND"]) == 1
    error_message = "Plus one forecast-based early warning."
  }
  assert {
    condition     = google_billing_budget.monthly.amount[0].specified_amount[0].units == "7700"
    error_message = "Budget amount comes from the variable."
  }
}

run "label_budget_filters_by_label" {
  command = plan
  variables {
    label_budgets = { jd = { label_key = "customer", label_value = "jd", amount = 900 } }
  }
  assert {
    condition     = google_billing_budget.by_label["jd"].budget_filter[0].labels["customer"] == "jd"
    error_message = "Per-customer budget must filter on customer=jd."
  }
}

run "lifecycle_tiers_without_early_deletion" {
  command = plan
  assert {
    condition     = [for r in google_storage_bucket.assets.lifecycle_rule : one(r.action).storage_class if one(r.action).type == "SetStorageClass"] == ["NEARLINE", "COLDLINE"]
    error_message = "Standard -> Nearline -> Coldline (no Archive)."
  }
}

run "rejects_retention_shorter_than_coldline_minimum" {
  command = plan
  variables {
    device_log_retention_days = 120
  }
  expect_failures = [var.device_log_retention_days]
}

run "rejects_vm_outside_policy_region" {
  command = plan
  variables {
    staging_instances = { "staging-vm-x" = { zone = "us-central1-a" } }
  }
  expect_failures = [var.staging_instances]
}

run "schedule_and_scheduler_permission" {
  command = plan
  assert {
    condition     = google_compute_resource_policy.staging_office_hours.instance_schedule_policy[0].vm_stop_schedule[0].schedule == "30 19 * * 1-5"
    error_message = "Stop at 19:30 on weekdays."
  }
  assert {
    condition     = google_project_iam_member.compute_agent_scheduler.member == "serviceAccount:service-123456789012@compute-system.iam.gserviceaccount.com"
    error_message = "The Compute Engine service agent needs start/stop permission or the schedule silently does nothing."
  }
  assert {
    condition     = length(google_compute_resource_policy_attachment.staging) == 3
    error_message = "All three staging VMs are attached."
  }
}
