# Adopt the existing bucket instead of creating one. Delete this block after the first apply.
import {
  to = google_storage_bucket.assets
  id = var.assets_bucket_name
}
