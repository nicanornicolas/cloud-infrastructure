terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.0"
    }
  }

  # Remote state in GCS (native object locking, bucket versioning for rollback).
  # Partial configuration: bucket/prefix come from env/<env>.backend.hcl so the same code
  # serves dev/staging/prod:   terraform init -backend-config=env/prod.backend.hcl
  backend "gcs" {}
}
