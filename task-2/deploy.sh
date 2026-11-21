#!/usr/bin/env bash
# Deploys syncEvriManifest + reserveCompartment as Cloud Run functions, the reserve-compartment topic with a
# dead-letter topic, and the OIDC-authenticated Cloud Scheduler job (Africa/Nairobi, retry policy, deadline).
#
# NOT EXECUTED for the assessment (no GCP project). Written to be re-runnable: every create is guarded,
# and steps that must be re-applied after a redeploy (dead-letter policy) are always applied.
#
# Usage:  PROJECT_ID=ktsm-prod-4471 REGION=europe-west1 ./deploy.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"           # keep Scheduler, functions and Firestore close together
TIME_ZONE="Africa/Nairobi"
SOURCE_DIR="$(cd "$(dirname "$0")/app" && pwd)"

TOPIC="reserve-compartment"
DLQ_TOPIC="reserve-compartment-dlq"
DLQ_SUB="reserve-compartment-dlq-sub"
SYNC_FN="sync-evri-manifest"
RESERVE_FN="reserve-compartment"
JOB="sync-evri-manifest"

SYNC_SA="sync-evri-fn@${PROJECT_ID}.iam.gserviceaccount.com"                     # sync runtime identity
RESERVE_SA="reserve-compartment-fn@${PROJECT_ID}.iam.gserviceaccount.com"        # reserve runtime identity
TRIGGER_SA="reserve-compartment-trigger@${PROJECT_ID}.iam.gserviceaccount.com"   # Eventarc -> function
SCHEDULER_SA="sync-evri-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"         # Scheduler -> function

# No `gcloud config set project`: every command names the project explicitly, so the script never
# changes (or depends on) the operator's global gcloud configuration.
g() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

PROJECT_NUMBER="$(g projects describe "$PROJECT_ID" --format='value(projectNumber)')"
PUBSUB_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

# ---------------------------------------------------------------------------------------------------
# 0. APIs
# ---------------------------------------------------------------------------------------------------
g services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com

# ---------------------------------------------------------------------------------------------------
# 1. One identity per job (create only if missing; real errors are NOT swallowed by `|| true`)
# ---------------------------------------------------------------------------------------------------
ensure_sa() {
  local email="$1" name="${1%%@*}" display="$2"
  g iam service-accounts describe "$email" >/dev/null 2>&1 ||
    g iam service-accounts create "$name" --display-name="$display"
}
ensure_sa "$SYNC_SA"      "syncEvriManifest runtime"
ensure_sa "$RESERVE_SA"   "reserveCompartment runtime"
ensure_sa "$TRIGGER_SA"   "Eventarc invoker for reserveCompartment"
ensure_sa "$SCHEDULER_SA" "Cloud Scheduler invoker for syncEvriManifest"

# Firestore access is project-level IAM only (security rules do not apply to server SDKs).
for sa in "$SYNC_SA" "$RESERVE_SA"; do
  g projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${sa}" \
    --role="roles/datastore.user" --condition=None >/dev/null
done

# ---------------------------------------------------------------------------------------------------
# 2. Topics: main + dead-letter, plus a pull subscription so dead-lettered messages are RETAINED
#    (a topic with no subscription drops what is published to it).
# ---------------------------------------------------------------------------------------------------
g pubsub topics describe "$TOPIC" >/dev/null 2>&1 || g pubsub topics create "$TOPIC"
g pubsub topics describe "$DLQ_TOPIC" >/dev/null 2>&1 || g pubsub topics create "$DLQ_TOPIC"
g pubsub subscriptions describe "$DLQ_SUB" >/dev/null 2>&1 ||
  g pubsub subscriptions create "$DLQ_SUB" --topic="$DLQ_TOPIC" \
    --message-retention-duration=7d --expiration-period=never

# Only the sync function may publish reservations.
g pubsub topics add-iam-policy-binding "$TOPIC" \
  --member="serviceAccount:${SYNC_SA}" --role="roles/pubsub.publisher" >/dev/null

# ---------------------------------------------------------------------------------------------------
# 3. Firestore composite index for the "waiting for a compartment" re-queue sweep
#    (equality + range + orderBy needs one; see app/firestore.indexes.json)
# ---------------------------------------------------------------------------------------------------
g firestore indexes composite create --collection-group=shipments --query-scope=COLLECTION \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=nextAttemptAt,order=ascending --async 2>/dev/null ||
  echo "index shipments(status, nextAttemptAt) already exists"

# ---------------------------------------------------------------------------------------------------
# 4. syncEvriManifest: private HTTP function, ONE instance, ONE request at a time.
#    timeout 300s; the code stops paging at 240s and checkpoints; the lease (330s) outlives the timeout.
# ---------------------------------------------------------------------------------------------------
g functions deploy "$SYNC_FN" \
  --gen2 --region="$REGION" --runtime=nodejs24 \
  --source="$SOURCE_DIR" --entry-point=syncEvriManifest \
  --trigger-http --no-allow-unauthenticated --ingress-settings=internal-only \
  --service-account="$SYNC_SA" \
  --memory=512Mi --cpu=1 --timeout=300s \
  --min-instances=0 --max-instances=1 --concurrency=1 \
  --set-env-vars="RESERVE_TOPIC=${TOPIC},SYNC_LEASE_MS=330000,SYNC_TIME_BUDGET_MS=240000"

# ---------------------------------------------------------------------------------------------------
# 5. reserveCompartment: Pub/Sub-triggered, retries ON (default is off = failures silently dropped),
#    dedicated trigger identity instead of the default compute SA.
#    --concurrency > 1 requires >= 1 vCPU, hence --cpu=1.
# ---------------------------------------------------------------------------------------------------
g functions deploy "$RESERVE_FN" \
  --gen2 --region="$REGION" --runtime=nodejs24 \
  --source="$SOURCE_DIR" --entry-point=reserveCompartment \
  --trigger-topic="$TOPIC" --retry \
  --trigger-service-account="$TRIGGER_SA" \
  --no-allow-unauthenticated --ingress-settings=internal-only \
  --service-account="$RESERVE_SA" \
  --memory=512Mi --cpu=1 --timeout=60s \
  --min-instances=0 --max-instances=10 --concurrency=10 \
  --set-env-vars="MAX_WAIT_ATTEMPTS=18,WAIT_RETRY_INTERVAL_MS=600000"

# The Eventarc trigger identity must be allowed to invoke the function's Cloud Run service.
g run services add-iam-policy-binding "$RESERVE_FN" --region="$REGION" \
  --member="serviceAccount:${TRIGGER_SA}" --role="roles/run.invoker" >/dev/null

# ---------------------------------------------------------------------------------------------------
# 6. Dead-letter policy. Dead-lettering is a SUBSCRIPTION setting, and the subscription is the one
#    Eventarc created for the trigger, so look it up. Re-apply after every redeploy of reserveCompartment.
# ---------------------------------------------------------------------------------------------------
TRIGGER="$(g functions describe "$RESERVE_FN" --gen2 --region="$REGION" --format='value(eventTrigger.trigger)')"
SUBSCRIPTION="$(g eventarc triggers describe "$TRIGGER" --location="$REGION" \
  --format='value(transport.pubsub.subscription)')"

# Pub/Sub's service agent forwards undeliverable messages: it needs publish on the DLQ topic and
# subscribe on the source subscription.
g pubsub topics add-iam-policy-binding "$DLQ_TOPIC" \
  --member="serviceAccount:${PUBSUB_AGENT}" --role="roles/pubsub.publisher" >/dev/null
g pubsub subscriptions add-iam-policy-binding "$SUBSCRIPTION" \
  --member="serviceAccount:${PUBSUB_AGENT}" --role="roles/pubsub.subscriber" >/dev/null

# 5 delivery attempts with 10s..600s exponential backoff, then dead-letter. A full locker is NOT an
# error (handled in code), so only genuine failures (bad payload, persistent Firestore errors) land here.
# Ack deadline is set explicitly above the 60s function timeout.
g pubsub subscriptions update "$SUBSCRIPTION" \
  --dead-letter-topic="$DLQ_TOPIC" --max-delivery-attempts=5 \
  --min-retry-delay=10s --max-retry-delay=600s \
  --ack-deadline=120

# ---------------------------------------------------------------------------------------------------
# 7. Cloud Scheduler: every 10 min, Africa/Nairobi, OIDC, bounded retries.
# ---------------------------------------------------------------------------------------------------
g run services add-iam-policy-binding "$SYNC_FN" --region="$REGION" \
  --member="serviceAccount:${SCHEDULER_SA}" --role="roles/run.invoker" >/dev/null

SYNC_URI="$(g functions describe "$SYNC_FN" --gen2 --region="$REGION" --format='value(serviceConfig.uri)')"

# attempt-deadline 330s > function timeout 300s: Scheduler never gives up (and retries) while a run is
#   still in progress. The lease makes an overlap harmless anyway; this avoids the wasted attempt.
# 2 retries, 30s..120s backoff, none started after 540s: a failed run is retried within its own
#   10-minute slot; after that the next scheduled run (which resumes from the checkpoint) takes over.
SCHEDULE_FLAGS=(
  --location="$REGION"
  --schedule="*/10 * * * *"
  --time-zone="$TIME_ZONE"
  --uri="$SYNC_URI"
  --http-method=POST
  --oidc-service-account-email="$SCHEDULER_SA"
  --oidc-token-audience="$SYNC_URI"
  --attempt-deadline=330s
  --max-retry-attempts=2
  --min-backoff=30s
  --max-backoff=120s
  --max-doublings=2
  --max-retry-duration=540s
)
if g scheduler jobs describe "$JOB" --location="$REGION" >/dev/null 2>&1; then
  g scheduler jobs update http "$JOB" "${SCHEDULE_FLAGS[@]}"
else
  g scheduler jobs create http "$JOB" "${SCHEDULE_FLAGS[@]}"
fi

echo "Deployed. Smoke test: gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT_ID"
