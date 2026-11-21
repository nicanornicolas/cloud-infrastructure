terraform {
  required_version = ">= 1.9" # cross-variable validation (storage retention vs. Coldline minimum)

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.0"
    }
  }

  backend "gcs" {} # terraform init -backend-config=... (same pattern as task-1)
}

provider "google" {
  project = var.project_id
  region  = var.region

  # The Billing Budgets API needs a quota project when called with user credentials (ADC);
  # harmless with a CI service account.
  billing_project       = var.project_id
  user_project_override = true

  # Every labelable resource created from this stack carries env/service; see README "Labels".
  default_labels = {
    env        = var.env
    service    = "platform"
    managed-by = "terraform"
  }
}

data "google_project" "this" {
  project_id = var.project_id
}
