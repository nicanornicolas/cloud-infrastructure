"use strict";

const crypto = require("node:crypto");

/**
 * Create a parcel exactly once per (partner, ref).
 *
 * The partner's own `ref` is the idempotency key: every retry of the same parcel carries it, with or
 * without an Idempotency-Key header, so this protects JD's existing client unchanged.
 *
 * One Firestore transaction:
 *   1. read parcel_refs/{partner}_{base64url(ref)}. If present: same details -> "replayed" (return the
 *      ORIGINAL parcel, even if the locker has gone offline since); different details -> "conflict".
 *   2. read the locker: missing -> "locker_not_found"; not online -> "locker_offline".
 *   3. create the parcel AND the ref index atomically. Two concurrent first requests both try; the
 *      transaction lets exactly one commit, the other re-runs, sees the index and becomes a replay.
 *
 * The brief's createParcel() internals were not provided; parcel creation is folded into this
 * transaction. If createParcel has side effects outside Firestore, use a pending/completed record
 * instead (see README "Assumptions").
 */
async function createParcelIdempotent(db, { partner, ref, lockerId, size }, { now = () => new Date(), newId } = {}) {
  const refIndex = db.collection("parcel_refs").doc(`${partner}_${Buffer.from(ref).toString("base64url")}`);
  const lockerRef = db.collection("lockers").doc(lockerId);
  const makeId = newId ?? (() => `p_${crypto.randomBytes(8).toString("hex")}`);

  return db.runTransaction(async (tx) => {
    const [indexSnap, lockerSnap] = await Promise.all([tx.get(refIndex), tx.get(lockerRef)]);

    if (indexSnap.exists) {
      const parcel = indexSnap.get("parcel");
      const same = parcel.lockerId === lockerId && parcel.size === size;
      return same ? { outcome: "replayed", parcel } : { outcome: "conflict", parcel };
    }
    if (!lockerSnap.exists) return { outcome: "locker_not_found" };
    if (lockerSnap.get("status") !== "online") return { outcome: "locker_offline", lockerStatus: lockerSnap.get("status") ?? null };

    const parcel = { id: makeId(), partner, ref, lockerId, size, status: "created", createdAt: now().toISOString() };
    tx.create(db.collection("parcels").doc(parcel.id), parcel);
    tx.create(refIndex, { parcel });
    return { outcome: "created", parcel };
  });
}

module.exports = { createParcelIdempotent };
