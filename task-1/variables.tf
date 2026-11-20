variable "project_id" {
  type        = string
  description = "Target GCP project. No default on purpose: the environment is always chosen explicitly via env/<env>.tfvars."
}

variable "region" {
  type        = string
  description = "Region for the scheduled jobs in this stack."
}

variable "time_zone" {
  type        = string
  description = "IANA time zone used by the schedules in this stack."
}

variable "source_bucket" {
  type        = string
  description = "Bucket holding function source archives."
}

variable "reminders_source_object" {
  type        = string
  description = "Immutable source archive for send-reminders, e.g. reminders/<git-sha>.zip."
}

variable "sms_api_key_version" {
  type        = string
  description = "Pinned Secret Manager version of the SMS API key used by the functions (bump on rotation)."
}
