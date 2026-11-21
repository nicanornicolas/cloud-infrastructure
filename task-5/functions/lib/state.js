"use strict";

const { KEYS } = require("./scripts");

/**
 * Copy a locker's Redis state to lockers/{id}, never moving Firestore backwards:
 *  - telemetry (lastSeen, temperature, doorStates) only if newer than what Firestore has;
 *  - status only if its statusVersion is higher, so an "offline" written by the reconciler and an
 *    "online" written by the processor land in the right order even if their writes race.
 * One small transaction per write; writes happen on change or every 5 minutes, not per heartbeat.
 */
async function syncLockerToFirestore(db, lockerId, state) {
  const ref = db.collection("lockers").doc(lockerId);
  const lastSeen = Number(state.lastSeen);
  const statusVersion = Number(state.statusVersion ?? 0);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : {};
    const update = {};
    if (lastSeen > (current.lastSeen?.toMillis?.() ?? 0)) {
      Object.assign(update, {
        lastSeen: new Date(lastSeen),
        temperature: Number(state.temperature),
        doorStates: JSON.parse(state.doors),
      });
    }
    if (state.status && statusVersion > (current.statusVersion ?? 0)) {
      Object.assign(update, { status: state.status, statusVersion, statusSince: new Date(Number(state.statusSince)) });
    }
    if (Object.keys(update).length) tx.set(ref, update, { merge: true });
  });
}

/** Write a dirty locker to Firestore and clear its dirty mark (only if unchanged meanwhile). */
async function flushLocker(redis, db, lockerId) {
  const key = KEYS.locker(lockerId);
  const state = await redis.hgetall(key);
  if (!state.lastSeen || !state.dirty) {
    await redis.srem(KEYS.dirty, lockerId);
    return false;
  }
  await syncLockerToFirestore(db, lockerId, state);
  await redis.clearDirty(key, KEYS.dirty, lockerId, state.dirty, state.lastSeen);
  return true;
}

/**
 * State processor for one Pub/Sub message. Redis gets every heartbeat (sub-millisecond); Firestore only
 * gets a write when the locker comes online, its doors change, or the 5-minute checkpoint is due.
 * If the Firestore write fails we throw: Pub/Sub redelivers, the redelivery is "stale" but still
 * dirty, and the write is retried. The reconciler flushes anything still dirty as a safety net.
 */
async function handleHeartbeatMessage({ redis, db, msg, checkpointMs = 300_000 }) {
  const ts = Date.parse(msg?.received_at);
  if (!msg?.locker_id || !Number.isFinite(ts) || typeof msg.door_states !== "string") {
    return { result: "invalid" }; // validated at ingestion; never retry a malformed message
  }
  const [result, dirty, transition] = await redis.heartbeat(
    KEYS.lastSeen,
    KEYS.dirty,
    KEYS.heartbeatCount,
    KEYS.locker(msg.locker_id),
    msg.locker_id,
    ts,
    String(msg.temperature),
    msg.door_states,
    checkpointMs,
  );
  const flushed = dirty === 1 ? await flushLocker(redis, db, msg.locker_id) : false;
  return { result, transitionedOnline: transition === 1, flushed };
}

module.exports = { syncLockerToFirestore, flushLocker, handleHeartbeatMessage };
