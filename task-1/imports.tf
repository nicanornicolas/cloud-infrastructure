# One-off adoption of the hand-created production function (Part 3 of the task).
# Reviewed in the PR like any other change; `terraform plan` shows it as "will be imported".
# Delete this block in a follow-up PR once the import has been applied.
#
# Only the function is imported. The old service account (reminders-fn) and scheduler job
# (send-reminders-every-15m, europe-west1) are intentionally NOT adopted — they are replaced by the
# module's least-privilege SA and OIDC-authenticated job, then deleted by hand (see README runbook).
import {
  to = module.send_reminders.google_cloudfunctions2_function.this
  id = "projects/${var.project_id}/locations/${var.region}/functions/send-reminders"
}
