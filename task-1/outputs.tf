output "send_reminders_function_uri" {
  description = "URI of the send-reminders function."
  value       = module.send_reminders.function_uri
}

output "send_reminders_scheduler_job_id" {
  description = "Cloud Scheduler job that triggers send-reminders."
  value       = module.send_reminders.scheduler_job_id
}

output "send_reminders_runtime_sa" {
  description = "Runtime service account of send-reminders."
  value       = module.send_reminders.runtime_service_account_email
}
