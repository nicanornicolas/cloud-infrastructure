terraform {
  required_version = ">= 1.7"

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
}
