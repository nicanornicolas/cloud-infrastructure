// ORIGINAL 1st gen function exactly as supplied in the brief. Reference + bug reproduction only — DO NOT DEPLOY.
// Pinned to firebase-functions 5.x (package.json): from v6 the package root exports the 2nd gen API, so
// `functions.firestore.document(...)` only works on <= 5.x or via "firebase-functions/v1".
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

exports.onShipmentUpdate = functions.firestore.document("shipments/{shipmentId}").onUpdate(async (change, context) => {
  const after = change.after.data();
  if (after.status === "delivered") {
    await admin.firestore().collection("notifications").add({
      shipmentId: context.params.shipmentId,
      type: "ready_for_pickup",
      createdAt: new Date(),
    });
  }
  await change.after.ref.update({ updatedAt: new Date() });
});
