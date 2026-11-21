"use strict";

const { FieldValue } = require("firebase-admin/firestore");

const NOTIFICATION_TYPE = "ready_for_pickup";
const ALREADY_EXISTS = 6; // gRPC status code

/**
 * True only for the transition INTO "delivered". Updates to an already-delivered shipment
 * (other fields changing, retries, our own writes elsewhere) return false.
 */
function isDeliveredTransition(before, after) {
  return Boolean(after) && after.status === "delivered" && before?.status !== "delivered";
}

/** Deterministic: the same shipment always maps to the same notification document. */
function notificationIdFor(shipmentId) {
  return `${shipmentId}_${NOTIFICATION_TYPE}`;
}

/**
 * Create the ready_for_pickup notification for a shipment exactly once.
 *
 * - Deterministic document ID + transactional create: any number of deliveries of the same
 *   event (retries, redelivery), or the same transition seen by BOTH the 1st gen and 2nd gen
 *   functions during cutover, produce one document.
 * - The query for an existing notification of this shipment+type also catches notifications
 *   created by the OLD code with random IDs, so a shipment notified just before the cutover
 *   is not notified again by the new code.
 * - Writes only to `notifications`, never to `shipments`, so it cannot re-trigger itself.
 */
async function createReadyForPickupNotification(db, { shipmentId, eventId, source }) {
  const notifications = db.collection("notifications");
  const ref = notifications.doc(notificationIdFor(shipmentId));
  const existingForShipment = notifications
    .where("shipmentId", "==", shipmentId)
    .where("type", "==", NOTIFICATION_TYPE)
    .limit(1);

  try {
    return await db.runTransaction(async (tx) => {
      const [own, any] = await Promise.all([tx.get(ref), tx.get(existingForShipment)]);
      if (own.exists) return { outcome: "duplicate", notificationId: ref.id };
      if (!any.empty) return { outcome: "duplicate_legacy", notificationId: any.docs[0].id };

      tx.create(ref, {
        shipmentId,
        type: NOTIFICATION_TYPE,
        sourceEventId: eventId ?? null,
        source: source ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { outcome: "created", notificationId: ref.id };
    });
  } catch (err) {
    // Two deliveries racing to create the same ID: the loser lands here. Not an error.
    if (err.code === ALREADY_EXISTS) return { outcome: "duplicate", notificationId: ref.id };
    throw err; // transient (UNAVAILABLE, DEADLINE_EXCEEDED, ...): rethrow so the event is retried
  }
}

module.exports = { NOTIFICATION_TYPE, isDeliveredTransition, notificationIdFor, createReadyForPickupNotification };
