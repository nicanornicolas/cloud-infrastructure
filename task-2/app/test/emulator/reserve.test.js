"use strict";

// Integration tests against the Firestore emulator — they exercise REAL transaction semantics.
//   npm run test:emulator     (needs Java 21+; starts/stops the emulator automatically)

const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Firestore } = require("@google-cloud/firestore");
const { reserveCompartment } = require("../../lib/reserve");
const { createFirestoreSyncStore } = require("../../lib/firestore-sync-store");
const { shipmentIdFor } = require("../../lib/parcel");

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-evri";
const opts = { maxWaitAttempts: 3, waitRetryIntervalMs: 600_000 };

describe("Firestore emulator", { skip: !HOST && "FIRESTORE_EMULATOR_HOST not set (run `npm run test:emulator`)" }, () => {
  const db = new Firestore({ projectId: PROJECT });

  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  });

  async function seedCompartments(lockerId, n) {
    const batch = db.batch();
    for (let i = 1; i <= n; i++) {
      batch.set(db.collection("compartments").doc(`${lockerId}-C${i}`), { lockerId, status: "available" });
    }
    await batch.commit();
  }

  /** Simulates Pub/Sub at-least-once delivery: if the handler throws, the message is redelivered. */
  async function deliver(parcel, attempts = 5) {
    for (let i = 1; ; i++) {
      try {
        return await reserveCompartment(db, parcel, opts);
      } catch (err) {
        if (i >= attempts) throw err;
      }
    }
  }

  test("30 concurrent parcels, 10 compartments: no compartment is double-booked", async () => {
    await seedCompartments("L1", 10);
    const parcels = Array.from({ length: 30 }, (_, i) => ({ ref: `P${i}`, lockerId: "L1" }));

    const results = await Promise.all(parcels.map((p) => deliver(p)));

    const reserved = results.filter((r) => r.outcome === "reserved");
    assert.equal(reserved.length, 10);
    assert.equal(new Set(reserved.map((r) => r.compartmentId)).size, 10, "each compartment given out once");
    assert.equal(results.filter((r) => r.outcome === "waiting").length, 20);

    const compartments = await db.collection("compartments").get();
    const parcelRefs = compartments.docs.map((d) => d.get("parcelRef"));
    assert.ok(compartments.docs.every((d) => d.get("status") === "reserved"));
    assert.equal(new Set(parcelRefs).size, 10, "no parcel holds two compartments");

    const shipments = await db.collection("shipments").get();
    assert.equal(shipments.size, 30, "exactly one shipment per parcel");
  });

  test("the same message delivered 5 times concurrently creates one shipment and reserves one compartment", async () => {
    await seedCompartments("L1", 5);
    const parcel = { ref: "EVRI-123", lockerId: "L1" };

    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(parcel)));

    assert.equal(results.filter((r) => r.outcome === "reserved").length, 1);
    assert.equal(results.filter((r) => r.outcome === "duplicate").length, 4);
    assert.equal((await db.collection("shipments").get()).size, 1);
    const taken = await db.collection("compartments").where("status", "==", "reserved").get();
    assert.equal(taken.size, 1);
  });

  test("sequential redelivery after success is a no-op", async () => {
    await seedCompartments("L1", 2);
    const parcel = { ref: "EVRI-9", lockerId: "L1" };
    const first = await deliver(parcel);
    const again = await deliver(parcel);
    assert.equal(first.outcome, "reserved");
    assert.deepEqual(again, { outcome: "duplicate", status: "reserved", compartmentId: first.compartmentId });
  });

  test("full locker: resolves (message acked, no endless retries), bounded attempts, then unallocated", async () => {
    const parcel = { ref: "EVRI-FULL", lockerId: "L-FULL" };
    const shipment = db.collection("shipments").doc(shipmentIdFor(parcel.ref));

    const r1 = await reserveCompartment(db, parcel, opts); // must not throw
    assert.deepEqual(r1, { outcome: "waiting", waitAttempts: 1 });
    assert.equal((await shipment.get()).get("status"), "waiting_for_compartment");
    assert.ok((await shipment.get()).get("nextAttemptAt") > Date.now());

    await reserveCompartment(db, parcel, opts);
    const r3 = await reserveCompartment(db, parcel, opts);
    assert.deepEqual(r3, { outcome: "unallocated", waitAttempts: 3 });

    const r4 = await reserveCompartment(db, parcel, opts);
    assert.equal(r4.outcome, "duplicate", "terminal state: further deliveries are no-ops");
  });

  test("a waiting parcel is reserved once a compartment frees up", async () => {
    const parcel = { ref: "EVRI-LATER", lockerId: "L2" };
    assert.equal((await reserveCompartment(db, parcel, opts)).outcome, "waiting");
    await seedCompartments("L2", 1);
    const r = await reserveCompartment(db, parcel, opts);
    assert.equal(r.outcome, "reserved");
    const snap = await db.collection("shipments").doc(shipmentIdFor(parcel.ref)).get();
    assert.equal(snap.get("status"), "reserved");
    assert.equal(snap.get("nextAttemptAt"), null, "no longer picked up by the re-queue sweep");
  });

  test("sync lease: of 10 concurrent acquirers exactly one wins; only the owner can release", async () => {
    const store = createFirestoreSyncStore(db);
    const now = Date.now();

    const wins = await Promise.all(Array.from({ length: 10 }, (_, i) => store.acquireLease(`run-${i}`, now, 330_000)));
    assert.equal(wins.filter(Boolean).length, 1);
    const winner = `run-${wins.indexOf(true)}`;

    await store.releaseLease("someone-else");
    assert.equal(await store.acquireLease("late", now + 1, 330_000), false, "non-owner release is ignored");

    await store.releaseLease(winner);
    assert.equal(await store.acquireLease("next", now + 2, 330_000), true);
    assert.equal(await store.acquireLease("after-expiry", now + 2 + 330_001, 330_000), true, "expired lease is reclaimable");
  });

  test("sync state + re-queue sweep round-trip", async () => {
    const store = createFirestoreSyncStore(db);
    await store.saveProgress({ since: 1, windowEnd: 2, cursor: "c", published: 3, rejected: 0 });
    assert.equal((await store.loadState()).inProgress.cursor, "c");
    await store.completeWindow(2);
    const state = await store.loadState();
    assert.equal(state.lastSyncedAt, 2);
    assert.equal(state.inProgress, undefined);

    const parcel = { ref: "EVRI-W", lockerId: "L3" };
    await reserveCompartment(db, parcel, { ...opts, waitRetryIntervalMs: -1 }); // due immediately
    const due = await store.findDueWaiting(Date.now(), 10);
    assert.deepEqual(due, [{ id: shipmentIdFor("EVRI-W"), ref: "EVRI-W", lockerId: "L3" }]);
    await store.deferWaiting([due[0].id], Date.now() + 600_000);
    assert.equal((await store.findDueWaiting(Date.now(), 10)).length, 0);
  });
});
