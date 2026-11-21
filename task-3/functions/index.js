"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const functionsV1 = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const { isDeliveredTransition, createReadyForPickupNotification } = require("./lib/notify");

initializeApp();

// ---------------------------------------------------------------------------------------------
// 2nd gen trigger: the target state.
// ---------------------------------------------------------------------------------------------
exports.onShipmentDelivered = onDocumentUpdated(
  {
    document: "shipments/{shipmentId}",
    region: "europe-west1",
    retry: true, // transient failures are redelivered; the handler is idempotent, so that is safe
    maxInstances: 20, // bounds cost and the load on whatever consumes `notifications`
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // Every shipment update invokes the function; non-transitions exit here without writing.
    if (!isDeliveredTransition(before, after)) return;

    const result = await createReadyForPickupNotification(getFirestore(), {
      shipmentId: event.params.shipmentId,
      eventId: event.id,
      source: "gen2",
    });
    logger.info(`ready_for_pickup: ${result.outcome}`, {
      shipmentId: event.params.shipmentId,
      eventId: event.id,
      ...result,
    });
    // Deliberately NO write back to shipments/{shipmentId}: nothing here can re-trigger this function.
  },
);

// ---------------------------------------------------------------------------------------------
// CUTOVER ONLY. Hotfixed 1st gen function, deployed IN PLACE over the broken one (same name, same
// default region us-central1). It stops the self-trigger loop immediately and uses the SAME
// idempotent create as the 2nd gen function, so while both run, each transition produces one
// notification. Remove this export and `firebase functions:delete onShipmentUpdate` in the last
// cutover step (see README).
// ---------------------------------------------------------------------------------------------
exports.onShipmentUpdate = functionsV1.firestore.document("shipments/{shipmentId}").onUpdate(async (change, context) => {
  if (!isDeliveredTransition(change.before.data(), change.after.data())) return;

  const result = await createReadyForPickupNotification(getFirestore(), {
    shipmentId: context.params.shipmentId,
    eventId: context.eventId,
    source: "gen1-hotfix",
  });
  logger.info(`ready_for_pickup (gen1 hotfix): ${result.outcome}`, {
    shipmentId: context.params.shipmentId,
    eventId: context.eventId,
    ...result,
  });
});
