project_id = "ktsm-prod-4471"

# The hand-created function lives in us-central1. A function's location cannot change in place
# (it forces destroy/recreate), so the import must use us-central1. Moving to europe-west1 is a
# separate, planned blue/green cutover — see README "Follow-ups".
region = "us-central1"

# */15 fires identically in any zone; the explicit zone matters for time-of-day jobs added from
# this template (DST-aware local hours). Europe/Brussels matches the platform's EU home region.
time_zone = "Europe/Brussels"

source_bucket           = "ktsm-fn-source"
reminders_source_object = "reminders/REPLACE_WITH_GIT_SHA.zip"

sms_api_key_version = "1"
