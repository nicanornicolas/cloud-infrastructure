# Implementation 1: stop paying to ingest noise. Excluded entries are never ingested into a log bucket,
# so they are not billed. (Fix the source too: LOG_LEVEL=info in production; the exclusion is the
# immediate, reversible safety net.)

# DEBUG only. NOT `severity <= DEBUG`: that also matches DEFAULT, the severity Cloud Logging gives to
# every unstructured stdout/stderr line, including errors printed without a severity.
resource "google_logging_project_exclusion" "debug" {
  name        = "exclude-debug"
  description = "Drop DEBUG entries in ${var.env}. INFO and above, DEFAULT-severity lines and audit logs are kept."
  filter      = "severity = DEBUG"
}

# Task 5's ingest receives ~518 M heartbeats/month; each produces a Cloud Run request log entry.
# Keep every failure and a 1% sample of successes (enough for latency analysis); drop the rest.
resource "google_logging_project_exclusion" "heartbeat_success_requests" {
  name        = "sample-heartbeat-request-logs"
  description = "Keep ${var.heartbeat_request_log_keep_ratio * 100}% of successful heartbeat request logs; all errors are kept."
  filter      = <<-EOT
    resource.type = "cloud_run_revision"
    AND resource.labels.service_name = "${var.heartbeat_service_name}"
    AND log_id("run.googleapis.com/requests")
    AND httpRequest.status < 400
    AND sample(insertId, ${1 - var.heartbeat_request_log_keep_ratio})
  EOT
}
