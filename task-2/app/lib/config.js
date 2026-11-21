"use strict";

// All tunables in one place, overridable via environment variables at deploy time.
const env = process.env;
const num = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

module.exports = Object.freeze({
  topicName: env.RESERVE_TOPIC || "reserve-compartment",
  partnerManifestUrl: env.PARTNER_MANIFEST_URL || "https://partner.example.com/evri/manifest",
  partnerTimeoutMs: num(env.PARTNER_TIMEOUT_MS, 15_000),

  // Sync timing. Function timeout is 300s (deploy.sh).
  syncLeaseMs: num(env.SYNC_LEASE_MS, 330_000), //       lease outlives the function timeout => no overlap
  syncTimeBudgetMs: num(env.SYNC_TIME_BUDGET_MS, 240_000), // stop paging early, checkpoint, finish cleanly
  overlapMs: num(env.SYNC_OVERLAP_MS, 120_000), //        re-read 2 min behind the watermark (clock skew, late rows)
  initialLookbackMs: num(env.SYNC_INITIAL_LOOKBACK_MS, 15 * 60_000),
  maxPagesPerRun: num(env.SYNC_MAX_PAGES, 500),

  // Parcels waiting for a compartment (locker full): bounded, scheduled re-attempts.
  requeueBatchSize: num(env.REQUEUE_BATCH_SIZE, 500),
  waitRetryIntervalMs: num(env.WAIT_RETRY_INTERVAL_MS, 10 * 60_000),
  maxWaitAttempts: num(env.MAX_WAIT_ATTEMPTS, 18), // ~3 hours at one attempt per 10-minute sync
});
