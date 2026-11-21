"use strict";

const { FieldValue } = require("@google-cloud/firestore");
const { shipmentIdFor } = require("./parcel");

// Shipment states:
//   reserved                 terminal  - compartment held for this parcel
//   waiting_for_compartment  transient - locker was full; the sync job re-queues it (bounded)
//   unallocated              terminal  - gave up after maxWaitAttempts; needs a human (alerted)
const TERMINAL = new Set(["reserved", "unallocated"]);

/**
 * Reserve one free compartment for a parcel, exactly once.
 *
 * Everything happens in ONE Firestore transaction:
 *  - the shipment doc (deterministic ID) is read first: a redelivered message finds it and
 *    becomes a no-op, so a duplicate shipment can never be created;
 *  - the free-compartment query is read inside the transaction, so the compartment doc is part
 *    of the transaction's read set. If another transaction reserves it first, this one cannot
 *    commit; Firestore retries it and the re-run sees the next free compartment. A compartment
 *    can therefore never be booked twice;
 *  - compartment + shipment are written atomically: no half-done state ("compartment reserved
 *    but no shipment") can exist after a crash.
 *
 * A full locker is a normal business outcome, not an error: it is recorded and the function
 * returns normally, so Pub/Sub acks the message instead of retrying it forever.
 */
async function reserveCompartment(db, parcel, { now = Date.now(), maxWaitAttempts, waitRetryIntervalMs }) {
  const ref = String(parcel.ref);
  const shipmentRef = db.collection("shipments").doc(shipmentIdFor(ref));
  const freeCompartment = db
    .collection("compartments")
    .where("lockerId", "==", parcel.lockerId)
    .where("status", "==", "available")
    .limit(1);

  return db.runTransaction(
    async (tx) => {
      // All reads before any write (Firestore transaction rule).
      const shipmentSnap = await tx.get(shipmentRef);
      const existing = shipmentSnap.exists ? shipmentSnap.data() : null;

      if (existing && TERMINAL.has(existing.status)) {
        return { outcome: "duplicate", status: existing.status, compartmentId: existing.compartmentId ?? null };
      }

      const free = await tx.get(freeCompartment);
      const created = existing ? {} : { createdAt: FieldValue.serverTimestamp() };

      if (free.empty) {
        const waitAttempts = (existing?.waitAttempts ?? 0) + 1;
        const giveUp = waitAttempts >= maxWaitAttempts;
        tx.set(
          shipmentRef,
          {
            ref,
            lockerId: parcel.lockerId,
            status: giveUp ? "unallocated" : "waiting_for_compartment",
            waitAttempts,
            nextAttemptAt: giveUp ? null : now + waitRetryIntervalMs,
            updatedAt: FieldValue.serverTimestamp(),
            ...created,
          },
          { merge: true },
        );
        return { outcome: giveUp ? "unallocated" : "waiting", waitAttempts };
      }

      const compartment = free.docs[0];
      tx.update(compartment.ref, {
        status: "reserved",
        parcelRef: ref,
        shipmentId: shipmentRef.id,
        reservedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        shipmentRef,
        {
          ref,
          lockerId: parcel.lockerId,
          compartmentId: compartment.id,
          status: "reserved",
          nextAttemptAt: null,
          reservedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          ...created,
        },
        { merge: true },
      );
      return { outcome: "reserved", compartmentId: compartment.id };
    },
    // Contention on a busy locker aborts and retries the transaction; allow more than the default 5.
    { maxAttempts: 10 },
  );
}

module.exports = { reserveCompartment };
