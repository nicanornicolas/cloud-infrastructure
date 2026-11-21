// ORIGINAL code exactly as supplied in the assessment brief (reformatted only). Reference only — DO NOT DEPLOY.
// Note: the brief prints the Firestore operators as "" — almost certainly "==" lost in the PDF.
// Taken literally, "" is an invalid operator and every reserveCompartment call would throw.

const functions = require("@google-cloud/functions-framework");
const { PubSub } = require("@google-cloud/pubsub");
const { Firestore } = require("@google-cloud/firestore");

const pubsub = new PubSub();
const db = new Firestore();

functions.http("syncEvriManifest", async (req, res) => {
  const response = await fetch("https://partner.example.com/evri/manifest?since=10m");
  const manifest = await response.json();
  for (const parcel of manifest.parcels) {
    await pubsub.topic("reserve-compartment").publishMessage({ json: parcel });
  }
  res.send("ok");
});

functions.cloudEvent("reserveCompartment", async (event) => {
  const parcel = JSON.parse(Buffer.from(event.data.message.data, "base64").toString());
  const free = await db
    .collection("compartments")
    .where("lockerId", "", parcel.lockerId)
    .where("status", "", "available")
    .limit(1)
    .get();
  const compartment = free.docs[0];
  await compartment.ref.update({ status: "reserved", parcelRef: parcel.ref });
  await db.collection("shipments").add({
    ref: parcel.ref,
    compartmentId: compartment.id,
    status: "reserved",
  });
});
