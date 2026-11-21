variable "project_id" {
  type        = string
  description = "Project the savings apply to."
}

variable "region" {
  type    = string
  default = "europe-west1"
}

variable "env" {
  type        = string
  description = "Environment label value."
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.env)
    error_message = "env must be prod, staging or dev."
  }
}

# ---------------------------------------------------------------- logging
variable "heartbeat_service_name" {
  type        = string
  description = "Cloud Run service whose successful request logs are sampled (Task 5 ingest)."
  default     = "ingestheartbeat"
}

variable "heartbeat_request_log_keep_ratio" {
  type        = number
  description = "Fraction of successful heartbeat request logs to keep (errors are always kept)."
  default     = 0.01

  validation {
    condition     = var.heartbeat_request_log_keep_ratio > 0 && var.heartbeat_request_log_keep_ratio <= 1
    error_message = "Keep ratio must be in (0, 1]."
  }
}

# ---------------------------------------------------------------- storage
variable "assets_bucket_name" {
  type        = string
  description = "EXISTING bucket holding device logs and photos (imported, not created)."
}

variable "lifecycle_prefixes" {
  type        = list(string)
  description = "Object prefixes that are rarely read after 30 days."
  default     = ["device-logs/", "photos/"]
}

variable "nearline_after_days" {
  type    = number
  default = 30
}

variable "coldline_after_days" {
  type    = number
  default = 90

  validation {
    condition     = var.coldline_after_days >= var.nearline_after_days + 30
    error_message = "Objects must spend Nearline's 30-day minimum before moving to Coldline (early-deletion fee otherwise)."
  }
}

variable "device_log_retention_days" {
  type        = number
  description = "Delete device logs after this many days. Must leave Coldline's 90-day minimum storage duration."
  default     = 365

  validation {
    condition     = var.device_log_retention_days >= var.coldline_after_days + 90
    error_message = "Deleting before Coldline's 90-day minimum triggers early-deletion charges; raise retention or move to Coldline later."
  }
}

# ---------------------------------------------------------------- staging VMs
variable "staging_instances" {
  type        = map(object({ zone = string }))
  description = "Staging VMs to stop out of hours (name => zone). All must be in var.region."
  default = {
    "staging-vm-1" = { zone = "europe-west1-b" }
    "staging-vm-2" = { zone = "europe-west1-b" }
    "staging-vm-3" = { zone = "europe-west1-c" }
  }

  validation {
    condition     = alltrue([for vm in values(var.staging_instances) : startswith(vm.zone, "${var.region}-")])
    error_message = "An instance schedule policy only applies to VMs in its own region."
  }
}

variable "office_time_zone" {
  type        = string
  description = "IANA time zone of the team using staging (no default: choose it explicitly)."
}

variable "staging_start_cron" {
  type    = string
  default = "30 7 * * 1-5" # Mon-Fri 07:30
}

variable "staging_stop_cron" {
  type    = string
  default = "30 19 * * 1-5" # Mon-Fri 19:30
}

# ---------------------------------------------------------------- budget
variable "billing_account_id" {
  type        = string
  description = "Billing account ID, e.g. 012345-6789AB-CDEF01."
}

variable "budget_currency" {
  type        = string
  description = "Must equal the billing account's currency, or the API rejects the budget."
  default     = "USD"
}

variable "monthly_budget" {
  type        = number
  description = "Monthly budget. Start at today's spend and step it down as savings land (README)."
}

variable "budget_alert_email" {
  type = string
}

variable "label_budgets" {
  type        = map(object({ label_key = string, label_value = string, amount = number }))
  description = "Optional per-customer / per-environment budgets filtered by resource label."
  default     = {}
}
