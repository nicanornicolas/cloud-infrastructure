# Implementation 3: run the three staging VMs Mon-Fri 07:30-19:30 only (60 of 168 hours a week).
# Stopped VMs bill only for their disks.

resource "google_compute_resource_policy" "staging_office_hours" {
  name        = "staging-office-hours"
  region      = var.region
  description = "Start ${var.staging_start_cron}, stop ${var.staging_stop_cron} (${var.office_time_zone})."

  instance_schedule_policy {
    vm_start_schedule {
      schedule = var.staging_start_cron
    }
    vm_stop_schedule {
      schedule = var.staging_stop_cron
    }
    time_zone = var.office_time_zone
  }
}

# The schedule is executed by the Compute Engine service agent. Without start/stop permission it fails
# silently and the VMs keep running 24/7. Least privilege: a two-permission custom role.
resource "google_project_iam_custom_role" "instance_scheduler" {
  role_id     = "instanceScheduler"
  title       = "Instance schedule start/stop"
  permissions = ["compute.instances.start", "compute.instances.stop"]
}

resource "google_project_iam_member" "compute_agent_scheduler" {
  project = var.project_id
  role    = google_project_iam_custom_role.instance_scheduler.id
  member  = "serviceAccount:service-${data.google_project.this.number}@compute-system.iam.gserviceaccount.com"
}

resource "google_compute_resource_policy_attachment" "staging" {
  for_each = var.staging_instances

  name     = google_compute_resource_policy.staging_office_hours.name
  instance = each.key
  zone     = each.value.zone

  depends_on = [google_project_iam_member.compute_agent_scheduler]
}
