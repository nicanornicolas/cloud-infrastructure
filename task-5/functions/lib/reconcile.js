"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { KEYS } = require("./scripts");
const { flushLocker } = require("./state");

async function mapLimit(items, limit, fn) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]).then(
        () => true,
        () => false,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Runs every minute (Cloud Scheduler):
 *  1. mark lockers silent for > offlineAfterMs as offline (atomic in Redis) — UNLESS the pipeline itself
 *     is stalled (no heartbeat processed for pipelineStallMs): then the silence is ours, not the lockers',
 *     and marking 6,000 lockers offline would be a false mass outage. The backlog alert covers that case.
 *  2. flush every dirty locker to Firestore (newly offline + any earlier failed writes), bounded concurrency,
 *     no 500-operation batch limit to hit during a regional outage;
 *  3. roll up stats/network ONCE per minute (instead of 200 writes/s to one document);
 *  4. publish online/offline gauges for alerting.
 */
async function reconcile({
  redis,
  db,
  now = Date.now(),
  offlineAfterMs = 90_000, //   3 missed 30 s heartbeats
  pipelineStallMs = 60_000, //  no heartbeat processed at all for 60 s => pipeline problem
  maxLockers = 20_000,
  concurrency = 25,
  writeGauges = async () => {},
  log = () => {},
}) {
  const cutoff = now - offlineAfterMs;
  const [newestId, newestScore] = await redis.zrevrange(KEYS.lastSeen, 0, 0, "WITHSCORES");
  const newest = newestId ? Number(newestScore) : null;
  const stalled = newest !== null && now - newest > pipelineStallMs;

  const newlyOffline = stalled ? [] : await redis.markOffline(KEYS.lastSeen, KEYS.dirty, cutoff, now, maxLockers);
  if (stalled) log({ severity: "ERROR", message: "heartbeat pipeline stalled; offline marking suspended", newestHeartbeatAgeMs: now - newest });

  const dirty = await redis.smembers(KEYS.dirty);
  const flushed = await mapLimit(dirty, concurrency, (id) => flushLocker(redis, db, id));
  const failedFlushes = flushed.filter((ok) => !ok).length;

  const [online, total] = await Promise.all([redis.zcount(KEYS.lastSeen, `(${cutoff}`, "+inf"), redis.zcard(KEYS.lastSeen)]);
  const offline = total - online;

  // Read the counter, write it, THEN subtract what was written: a failed Firestore write loses nothing.
  const heartbeats = Number((await redis.get(KEYS.heartbeatCount)) ?? 0);
  await db.doc("stats/network").set(
    {
      heartbeatCount: FieldValue.increment(heartbeats),
      onlineLockers: online,
      offlineLockers: offline,
      ...(newest !== null ? { lastHeartbeat: new Date(newest) } : {}),
      reconciledAt: new Date(now),
    },
    { merge: true },
  );
  if (heartbeats) await redis.decrby(KEYS.heartbeatCount, heartbeats);

  await writeGauges({ online, offline, now });
  const summary = { online, offline, newlyOffline: newlyOffline.length, flushed: dirty.length - failedFlushes, failedFlushes, heartbeats, stalled };
  log({ severity: failedFlushes || stalled ? "WARNING" : "INFO", message: "LOCKER_FLEET_HEALTH", ...summary });
  return summary;
}

module.exports = { reconcile };
