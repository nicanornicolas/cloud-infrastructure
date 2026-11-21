// ORIGINAL heartbeat function exactly as supplied in the brief. Reference only — DO NOT DEPLOY.
// (As written it would also fail at load: getFirestore() is called without initializeApp().)
const { onRequest } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const db = getFirestore();

exports.heartbeat = onRequest(async (req, res) => {
  const { lockerId, temperature, doorStates } = req.body;
  await db.collection("lockers").doc(lockerId).set({ lastSeen: new Date(), temperature, doorStates }, { merge: true });
  await db.collection("heartbeats").add({
    lockerId,
    temperature,
    doorStates,
    at: new Date(),
  });
  await db.doc("stats/network").update({
    heartbeatCount: FieldValue.increment(1),
    lastHeartbeat: new Date(),
  });
  res.sendStatus(200);
});
