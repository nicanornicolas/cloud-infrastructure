resource "google_monitoring_notification_channel" "oncall" {
  display_name = "Infrastructure on-call"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

# Descriptors for the gauges written by reconcileLockers. Declaring them here means the alert policy can be
# created before the first data point exists (otherwise apply fails with "cannot find metric").
resource "google_monitoring_metric_descriptor" "lockers_offline" {
  type         = "custom.googleapis.com/lockers/offline"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  unit         = "1"
  display_name = "Lockers offline"
  description  = "Lockers with no heartbeat for > 90 s, computed every minute by reconcileLockers."
}

resource "google_monitoring_metric_descriptor" "lockers_online" {
  type         = "custom.googleapis.com/lockers/online"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  unit         = "1"
  display_name = "Lockers online"
  description  = "Lockers with a heartbeat in the last 90 s."
}

locals {
  offline_threshold = ceil(var.fleet_size * var.offline_alert_fraction) # 60 for 6,000 lockers at 1%
}

# ---------------------------------------------------------------------------------------------------
# Alert 1 (CRITICAL): too many lockers offline — OR the metric itself stopped (reconciler or pipeline down).
# ---------------------------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "lockers_offline" {
  display_name = "Lockers offline above ${var.offline_alert_fraction * 100}% of fleet"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "Offline lockers > ${local.offline_threshold} for 5 min"
    condition_threshold {
      filter          = "resource.type = \"global\" AND metric.type = \"${google_monitoring_metric_descriptor.lockers_offline.type}\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.offline_threshold
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "Offline-lockers metric missing for 10 min (reconciler not running)"
    condition_absent {
      filter   = "resource.type = \"global\" AND metric.type = \"${google_monitoring_metric_descriptor.lockers_offline.type}\""
      duration = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.oncall.id]
  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    mime_type = "text/markdown"
    subject   = "Lockers offline: $${metric.display_name}"
    content   = <<-EOT
      More than ${local.offline_threshold} lockers (${var.offline_alert_fraction * 100}% of ${var.fleet_size}) have sent no
      heartbeat for 90 s, sustained for 5 minutes, or the offline metric stopped being written.
      1. Is it regional? Group `lockers` by area in the ops dashboard (ISP/power outage vs. our side).
      2. Our side? Check alert "Ingest 5xx" and "Heartbeat backlog", and `reconcileLockers` logs
         (`LOCKER_FLEET_HEALTH`, `stalled`).
      3. Individual lockers offline are handled by the ops dashboard, not by paging.
    EOT
  }
}

# ---------------------------------------------------------------------------------------------------
# Alert 2 (ERROR): ingestion failing — 5xx ratio on the ingest service (PromQL).
# ---------------------------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "ingest_5xx_ratio" {
  display_name = "Heartbeat ingest 5xx ratio > 1%"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "5xx / all requests > 1% over 5 min"
    condition_prometheus_query_language {
      query               = <<-EOT
        sum(rate(run_googleapis_com:request_count{monitored_resource="cloud_run_revision",service_name="${var.ingest_service_name}",response_code_class="5xx"}[5m]))
        /
        clamp_min(sum(rate(run_googleapis_com:request_count{monitored_resource="cloud_run_revision",service_name="${var.ingest_service_name}"}[5m])), 1e-9)
        > 0.01
      EOT
      duration            = "300s"
      evaluation_interval = "60s"
    }
  }

  notification_channels = [google_monitoring_notification_channel.oncall.id]
  documentation {
    mime_type = "text/markdown"
    content   = "Ingest returns 5xx to lockers (Pub/Sub publish failing, crashes, or instance limits). Lockers retry, but sustained errors mean lost live state. Check `ingestHeartbeat` logs for `heartbeat publish failed` and Cloud Run instance count vs maxInstances."
  }
}

# ---------------------------------------------------------------------------------------------------
# Alert 3 (WARNING): consumers falling behind — oldest unacked message age on both subscriptions.
# ---------------------------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "heartbeat_backlog" {
  display_name = "Heartbeat Pub/Sub backlog older than 2 min"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "State processor: oldest unacked > 120 s for 5 min"
    condition_threshold {
      # Eventarc generates the subscription name; it contains the lower-cased function name.
      filter          = "resource.type = \"pubsub_subscription\" AND metric.type = \"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.label.subscription_id = monitoring.regex.full_match(\"eventarc-.*${var.processor_function_name}.*\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 120
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  conditions {
    display_name = "BigQuery subscription: oldest unacked > 120 s for 5 min"
    condition_threshold {
      filter          = "resource.type = \"pubsub_subscription\" AND metric.type = \"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.label.subscription_id = \"${google_pubsub_subscription.heartbeats_to_bigquery.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 120
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.oncall.id]
  documentation {
    mime_type = "text/markdown"
    content   = "Heartbeats are not being consumed fast enough (age > 4 heartbeat intervals). Processor: check `processHeartbeat` errors, Memorystore CPU/connections, Firestore latency; while stalled, reconcileLockers suspends offline marking (no false mass-offline). BigQuery: check the DLQ `locker-heartbeats-bq-dlq-hold` for schema errors."
  }
}
