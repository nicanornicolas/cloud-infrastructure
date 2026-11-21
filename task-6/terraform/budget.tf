resource "google_monitoring_notification_channel" "finops" {
  display_name = "FinOps budget alerts"
  type         = "email"
  labels = {
    email_address = var.budget_alert_email
  }
}

locals {
  # Required alerts: 50%, 90%, 100% of actual spend. Plus an early warning when the month is FORECAST
  # to exceed the budget, which fires days before actual spend gets there.
  thresholds = [
    { percent = 0.5, basis = "CURRENT_SPEND" },
    { percent = 0.9, basis = "CURRENT_SPEND" },
    { percent = 1.0, basis = "CURRENT_SPEND" },
    { percent = 1.0, basis = "FORECASTED_SPEND" },
  ]
}

resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account_id
  display_name    = "Parcel locker platform (${var.env}) monthly"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS" # judge net cost, after CUDs and promotions
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.monthly_budget)
    }
  }

  dynamic "threshold_rules" {
    for_each = local.thresholds
    content {
      threshold_percent = threshold_rules.value.percent
      spend_basis       = threshold_rules.value.basis
    }
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.finops.id]
    disable_default_iam_recipients   = false # billing admins keep getting the default emails too
  }
}

# Per-customer / per-environment budgets from resource labels, e.g.
#   label_budgets = { jd = { label_key = "customer", label_value = "jd", amount = 900 } }
# Only labelled resources count: shared costs (Firestore, logging, the shared Cloud SQL) need the
# allocation query in the README.
resource "google_billing_budget" "by_label" {
  for_each = var.label_budgets

  billing_account = var.billing_account_id
  display_name    = "${each.value.label_key}=${each.value.label_value} monthly"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
    labels                 = { (each.value.label_key) = each.value.label_value }
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(each.value.amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = local.thresholds
    content {
      threshold_percent = threshold_rules.value.percent
      spend_basis       = threshold_rules.value.basis
    }
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.finops.id]
  }
}
