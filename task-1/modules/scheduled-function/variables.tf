# ---------------------------------------------------------------------------
# Required inputs — everything a new scheduled job must decide explicitly.
# ---------------------------------------------------------------------------

variable "project_id" {
  type        = string
  description = "GCP project that hosts the function, its service accounts and the scheduler job."
}

variable "region" {
  type        = string
  description = "Region for BOTH the function and the scheduler job, so they are always co-located."
}

variable "name" {
  type        = string
  description = "Base name for the function, scheduler job and service accounts (lowercase kebab-case)."

  validation {
    # 3–24 chars: the longest derived ID is "<name>-sched" and service account IDs are limited to 6–30 chars.
    condition     = can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.name))
    error_message = "name must be 3-24 chars, lowercase letters/digits/hyphens, start with a letter and not end with a hyphen (service account IDs are capped at 30 chars)."
  }
}

variable "entry_point" {
  type        = string
  description = "Name of the exported JavaScript function to invoke."
}

variable "source_bucket" {
  type        = string
  description = "GCS bucket holding the zipped function source."
}

variable "source_object" {
  type        = string
  description = "Immutable object path of the source zip, e.g. \"reminders/<git-sha>.zip\". Changing it is what triggers a redeploy."
}

variable "schedule" {
  type        = string
  description = "Cron expression (5 fields) evaluated in var.time_zone."

  validation {
    condition     = can(regex("^\\S+( \\S+){4}$", trimspace(var.schedule)))
    error_message = "schedule must be a standard 5-field cron expression, e.g. \"*/15 * * * *\"."
  }
}

variable "time_zone" {
  type        = string
  description = "IANA time zone for the schedule (e.g. \"Europe/Brussels\", \"Etc/UTC\"). Deliberately has no default."

  validation {
    condition     = can(regex("^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$", var.time_zone))
    error_message = "time_zone must be an IANA zone name such as \"Europe/Brussels\" or \"Etc/UTC\"."
  }
}

# ---------------------------------------------------------------------------
# Optional inputs — secure, cost-bounded defaults.
# ---------------------------------------------------------------------------

variable "description" {
  type        = string
  description = "Human-readable description applied to the function and scheduler job."
  default     = null
}

variable "runtime" {
  type        = string
  description = "Cloud Run functions Node.js runtime. nodejs20 was decommissioned on 2026-10-30."
  default     = "nodejs24"

  validation {
    condition     = can(regex("^nodejs(2[2-9]|[3-9][0-9])$", var.runtime))
    error_message = "runtime must be nodejs22 or newer; nodejs20 and older are decommissioned on Cloud Run functions."
  }
}

variable "environment_variables" {
  type        = map(string)
  description = "NON-sensitive environment variables. Secrets must go in secret_environment_variables."
  default     = {}

  validation {
    condition = alltrue([
      for k in keys(var.environment_variables) :
      !can(regex("(?i)(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)", k))
    ])
    error_message = "environment_variables looks like it contains a secret (name matches SECRET/TOKEN/PASSWORD/API_KEY/...). Use secret_environment_variables instead."
  }
}

variable "secret_environment_variables" {
  type = map(object({
    secret_id = string
    version   = string
  }))
  description = "Env var name => existing Secret Manager secret in var.project_id. Pin a numeric version in production."
  default     = {}
}

variable "runtime_project_roles" {
  type        = list(string)
  description = "Extra project-level roles the function's runtime service account needs (e.g. roles/datastore.user). Empty by default."
  default     = []

  validation {
    condition = alltrue([
      for r in var.runtime_project_roles :
      !contains(["roles/owner", "roles/editor", "roles/viewer"], r)
    ])
    error_message = "Basic roles (owner/editor/viewer) are not allowed; grant narrowly scoped predefined or custom roles."
  }
}

variable "build_service_account" {
  type        = string
  description = "Optional dedicated Cloud Build service account, full resource name \"projects/<p>/serviceAccounts/<email>\". Null uses the project default build SA."
  default     = null
}

variable "ingress_settings" {
  type        = string
  description = "Network ingress. ALLOW_INTERNAL_ONLY still admits same-project Cloud Scheduler calls to the default run.app URL."
  default     = "ALLOW_INTERNAL_ONLY"

  validation {
    # ALLOW_ALL is intentionally not offered: a scheduled job has no reason to be reachable from the internet.
    condition     = contains(["ALLOW_INTERNAL_ONLY", "ALLOW_INTERNAL_AND_GCLB"], var.ingress_settings)
    error_message = "ingress_settings must be ALLOW_INTERNAL_ONLY or ALLOW_INTERNAL_AND_GCLB."
  }
}

variable "available_memory" {
  type        = string
  description = "Memory per instance, e.g. \"256Mi\"."
  default     = "256Mi"

  validation {
    condition     = can(regex("^[0-9]+(Mi|Gi|M|G)$", var.available_memory))
    error_message = "available_memory must look like \"256Mi\" or \"1Gi\"."
  }
}

variable "timeout_seconds" {
  type        = number
  description = "Function request timeout. The scheduler attempt deadline is set to this + 30s (Scheduler caps HTTP deadlines at 30 min)."
  default     = 60

  validation {
    condition     = var.timeout_seconds >= 1 && var.timeout_seconds <= 1770
    error_message = "timeout_seconds must be between 1 and 1770 so the scheduler attempt deadline stays within 1800s."
  }
}

variable "max_instance_count" {
  type        = number
  description = "Upper bound on instances; caps cost and concurrent batch runs. 1 suits a periodic batch job."
  default     = 1

  validation {
    condition     = var.max_instance_count >= 1
    error_message = "max_instance_count must be at least 1."
  }
}

variable "retry_count" {
  type        = number
  description = "Scheduler retries on failure. Default 0: only raise it if the handler is idempotent (e.g. will not re-send SMS)."
  default     = 0

  validation {
    condition     = var.retry_count >= 0 && var.retry_count <= 5
    error_message = "retry_count must be between 0 and 5."
  }
}

variable "http_method" {
  type        = string
  description = "HTTP method Cloud Scheduler uses to call the function."
  default     = "POST"

  validation {
    condition     = contains(["POST", "GET", "PUT"], var.http_method)
    error_message = "http_method must be POST, GET or PUT."
  }
}

variable "labels" {
  type        = map(string)
  description = "Extra labels for the function and secret-free resources."
  default     = {}
}
