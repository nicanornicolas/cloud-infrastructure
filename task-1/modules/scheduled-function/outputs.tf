output "function_name" {
  description = "Name of the Cloud Run function."
  value       = google_cloudfunctions2_function.this.name
}

output "function_uri" {
  description = "HTTPS URI of the function (also the OIDC audience)."
  value       = google_cloudfunctions2_function.this.service_config[0].uri
}

output "runtime_service_account_email" {
  description = "Service account the function code runs as. Grant data access to this identity."
  value       = google_service_account.runtime.email
}

output "invoker_service_account_email" {
  description = "Service account Cloud Scheduler uses to sign OIDC tokens."
  value       = google_service_account.invoker.email
}

output "scheduler_job_id" {
  description = "Full resource ID of the Cloud Scheduler job."
  value       = google_cloud_scheduler_job.this.id
}
