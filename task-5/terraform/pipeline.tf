# Heartbeat history: Pub/Sub -> BigQuery subscription -> partitioned table. No consumer code to run.
# (The live-state processor subscribes to the same topic via Eventarc, created by `firebase deploy`.)

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  pubsub_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic" "heartbeats" {
  name                       = "locker-heartbeats"
  message_retention_duration = "86400s" # replay a day of heartbeats after a consumer bug
}

resource "google_pubsub_topic" "heartbeats_bq_dlq" {
  name = "locker-heartbeats-bq-dlq"
}

resource "google_pubsub_subscription" "heartbeats_bq_dlq_hold" {
  name                       = "locker-heartbeats-bq-dlq-hold"
  topic                      = google_pubsub_topic.heartbeats_bq_dlq.id
  message_retention_duration = "604800s"
}

resource "google_bigquery_dataset" "telemetry" {
  dataset_id = "telemetry"
  location   = var.region
}

resource "google_bigquery_table" "heartbeats" {
  dataset_id          = google_bigquery_dataset.telemetry.dataset_id
  table_id            = "locker_heartbeats"
  deletion_protection = true

  # Partition on Pub/Sub publish time (written by write_metadata), so retention is automatic.
  time_partitioning {
    type          = "DAY"
    field         = "publish_time"
    expiration_ms = var.telemetry_retention_days * 24 * 60 * 60 * 1000
  }
  clustering = ["locker_id"]

  schema = jsonencode([
    { name = "locker_id", type = "STRING", mode = "REQUIRED" },
    { name = "temperature", type = "FLOAT", mode = "NULLABLE" },
    { name = "door_states", type = "STRING", mode = "NULLABLE", description = "JSON object as sent by the locker" },
    { name = "received_at", type = "STRING", mode = "NULLABLE", description = "ISO-8601 server receive time" },
    { name = "subscription_name", type = "STRING", mode = "NULLABLE" },
    { name = "message_id", type = "STRING", mode = "NULLABLE", description = "dedupe key for at-least-once delivery" },
    { name = "publish_time", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "attributes", type = "STRING", mode = "NULLABLE" },
  ])
}

# The Pub/Sub service agent writes into the table.
resource "google_bigquery_table_iam_member" "pubsub_writer" {
  dataset_id = google_bigquery_table.heartbeats.dataset_id
  table_id   = google_bigquery_table.heartbeats.table_id
  role       = "roles/bigquery.dataEditor"
  member     = local.pubsub_agent
}

resource "google_pubsub_topic_iam_member" "bq_dlq_publisher" {
  topic  = google_pubsub_topic.heartbeats_bq_dlq.id
  role   = "roles/pubsub.publisher"
  member = local.pubsub_agent
}

resource "google_pubsub_subscription" "heartbeats_to_bigquery" {
  name  = "locker-heartbeats-bq"
  topic = google_pubsub_topic.heartbeats.id

  bigquery_config {
    table               = "${google_bigquery_table.heartbeats.project}.${google_bigquery_table.heartbeats.dataset_id}.${google_bigquery_table.heartbeats.table_id}"
    use_table_schema    = true
    write_metadata      = true
    drop_unknown_fields = true
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.heartbeats_bq_dlq.id
    max_delivery_attempts = 5
  }

  depends_on = [google_bigquery_table_iam_member.pubsub_writer]
}

resource "google_pubsub_subscription_iam_member" "bq_dlq_forwarder" {
  subscription = google_pubsub_subscription.heartbeats_to_bigquery.id
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}
