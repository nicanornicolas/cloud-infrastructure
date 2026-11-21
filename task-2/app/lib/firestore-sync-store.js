"use strict";

const { FieldValue } = require("@google-cloud/firestore");

/**
 * Firestore-backed state for the sync job:
 *   sync_locks/<name>  { runId, acquiredAt, expiresAt }               - the lease
 *   sync_state/<name>  { lastSyncedAt, inProgress?: {since, windowEnd, cursor, published, rejected} }
 * Times are epoch milliseconds from the function's clock (single writer: max-instances=1 + lease).
 */
function createFirestoreSyncStore(db, { name = "evri" } = {}) {
  const leaseRef = db.collection("sync_locks").doc(name);
  const stateRef = db.collection("sync_state").doc(name);
  const shipments = db.collection("shipments");

  return {
    /** Take the lease if free or expired. Transactional, so two runs can never both win. */
    async acquireLease(runId, now, ttlMs) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        if (snap.exists && snap.get("expiresAt") > now) return false;
        tx.set(leaseRef, { runId, acquiredAt: now, expiresAt: now + ttlMs });
        return true;
      });
    },

    /** Release only our own lease (a run that overran must not delete a newer run's lease). */
    async releaseLease(runId) {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(leaseRef);
        if (snap.exists && snap.get("runId") === runId) tx.delete(leaseRef);
      });
    },

    async loadState() {
      const snap = await stateRef.get();
      return snap.exists ? snap.data() : {};
    },

    async saveProgress(window) {
      await stateRef.set({ inProgress: window, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },

    async completeWindow(windowEnd) {
      await stateRef.set(
        { lastSyncedAt: windowEnd, inProgress: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    },

    /** Needs the composite index shipments(status ASC, nextAttemptAt ASC) — see firestore.indexes.json. */
    async findDueWaiting(now, limit) {
      const snap = await shipments
        .where("status", "==", "waiting_for_compartment")
        .where("nextAttemptAt", "<=", now)
        .orderBy("nextAttemptAt")
        .limit(limit)
        .get();
      return snap.docs.map((d) => ({ id: d.id, ref: d.get("ref"), lockerId: d.get("lockerId") }));
    },

    async deferWaiting(ids, nextAttemptAt) {
      for (let i = 0; i < ids.length; i += 500) {
        const batch = db.batch();
        for (const id of ids.slice(i, i + 500)) batch.update(shipments.doc(id), { nextAttemptAt });
        await batch.commit();
      }
    },
  };
}

module.exports = { createFirestoreSyncStore };
