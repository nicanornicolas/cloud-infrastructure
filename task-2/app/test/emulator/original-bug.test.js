"use strict";
// Regression evidence: the ORIGINAL (non-transactional) logic, with "==" restored, under the same load
// as the main concurrency test. It double-books compartments and duplicates shipments on redelivery.
const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Firestore } = require("@google-cloud/firestore");

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-evri";

describe("original reserveCompartment (bug reproduction)", { skip: !HOST && "FIRESTORE_EMULATOR_HOST not set" }, () => {
  const db = new Firestore({ projectId: PROJECT });

  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
    const batch = db.batch();
    for (let i = 1; i <= 10; i++) batch.set(db.collection("compartments").doc(`C${i}`), { lockerId: "L1", status: "available" });
    await batch.commit();
  });

  async function originalReserve(parcel) {
    const free = await db.collection("compartments").where("lockerId", "==", parcel.lockerId)
      .where("status", "==", "available").limit(1).get();
    const compartment = free.docs[0];
    await compartment.ref.update({ status: "reserved", parcelRef: parcel.ref });
    await db.collection("shipments").add({ ref: parcel.ref, compartmentId: compartment.id, status: "reserved" });
  }

  test("30 concurrent parcels: more shipments than compartments => double-booking", async () => {
    const parcels = Array.from({ length: 30 }, (_, i) => ({ ref: `P${i}`, lockerId: "L1" }));
    const outcomes = await Promise.allSettled(parcels.map(originalReserve));
    const shipments = await db.collection("shipments").get();
    const byCompartment = {};
    for (const d of shipments.docs) byCompartment[d.get("compartmentId")] = (byCompartment[d.get("compartmentId")] ?? 0) + 1;
    const doubleBooked = Object.values(byCompartment).filter((n) => n > 1).length;
    console.log(JSON.stringify({ shipments: shipments.size, compartmentsUsed: Object.keys(byCompartment).length, doubleBooked, crashed: outcomes.filter((o) => o.status === "rejected").length }));
    assert.ok(doubleBooked > 0, "expected the original code to double-book under concurrency");
  });

  test("redelivered message => duplicate shipment and a second compartment", async () => {
    const parcel = { ref: "EVRI-1", lockerId: "L1" };
    await originalReserve(parcel);
    await originalReserve(parcel); // Pub/Sub redelivery
    assert.equal((await db.collection("shipments").where("ref", "==", "EVRI-1").get()).size, 2);
    assert.equal((await db.collection("compartments").where("parcelRef", "==", "EVRI-1").get()).size, 2);
  });

  test("full locker => TypeError (dropped if retries off, retried until expiry if on)", async () => {
    await assert.rejects(originalReserve({ ref: "X", lockerId: "NO-SUCH-LOCKER" }), TypeError);
  });
});
