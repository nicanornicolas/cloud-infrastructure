# Implementation 2: lifecycle rules on the EXISTING 18 TB bucket. It is imported (imports.tf), not created:
# a new bucket would save nothing. Review the import plan: the only changes must be the lifecycle rules.

resource "google_storage_bucket" "assets" {
  name                        = var.assets_bucket_name
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # 30 days: Standard -> Nearline (half the storage price; rarely read after 30 days)
  lifecycle_rule {
    condition {
      age                   = var.nearline_after_days
      matches_storage_class = ["STANDARD"]
      matches_prefix        = var.lifecycle_prefixes
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  # 90 days: Nearline -> Coldline (a fifth of Standard). Not Archive: photos are pulled for disputes,
  # and Archive's retrieval fee and 365-day minimum would cost more than they save.
  lifecycle_rule {
    condition {
      age                   = var.coldline_after_days
      matches_storage_class = ["NEARLINE"]
      matches_prefix        = var.lifecycle_prefixes
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  # Device logs: delete after the retention period (validated to respect Coldline's 90-day minimum).
  lifecycle_rule {
    condition {
      age            = var.device_log_retention_days
      matches_prefix = ["device-logs/"]
    }
    action {
      type = "Delete"
    }
  }

  # Abandoned multipart uploads are billed but invisible in listings.
  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  labels = {
    customer = "shared"
  }

  lifecycle {
    prevent_destroy = true
  }
}
