variable "project_id" {
  type        = string
  description = "GCP project."
}

variable "region" {
  type        = string
  description = "Region of the heartbeat functions and BigQuery dataset."
  default     = "europe-west1"
}

variable "alert_email" {
  type        = string
  description = "On-call email for alert notifications."
}

variable "fleet_size" {
  type        = number
  description = "Number of lockers in the fleet; used to derive the offline threshold."
  default     = 6000
}

variable "offline_alert_fraction" {
  type        = number
  description = "Page when more than this fraction of the fleet is offline (0.01 = 1%)."
  default     = 0.01

  validation {
    condition     = var.offline_alert_fraction > 0 && var.offline_alert_fraction < 1
    error_message = "offline_alert_fraction must be between 0 and 1."
  }
}

variable "ingest_service_name" {
  type        = string
  description = "Cloud Run service behind the ingestHeartbeat function (Firebase lower-cases function names)."
  default     = "ingestheartbeat"
}

variable "processor_function_name" {
  type        = string
  description = "Lower-cased name of the Pub/Sub-triggered processor; its Eventarc subscription name contains it."
  default     = "processheartbeat"
}

variable "telemetry_retention_days" {
  type        = number
  description = "BigQuery partition expiration for raw heartbeats."
  default     = 90
}
