"use strict";

// End-to-end on the Firebase emulators (Firestore + Functions). BOTH the 2nd gen function and the
// 1st gen hotfix are loaded, i.e. the cutover state: every test also proves the two coexist without
// duplicating notifications.
//   npm run test:emulator     (Java 21+)

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { db, sleep, uid, notificationsFor, waitFor, emulatorsRunning } = require("./helpers");
const { createReadyForPickupNotification, notificationIdFor } = require("../../lib/notify");

const SETTLE_MS = 4000; // time for any (unwanted) follow-up triggers to show up

describe("2nd gen trigger + 1st gen hotfix (emulators)", { skip: !emulatorsRunning && "emulators not running" }, () => {
  test("delivered transition creates exactly one notification, and the shipment is not written back", async () => {
    const id = uid("S");
    const ref = db().collection("shipments").doc(id);
    await ref.set({ status: "in_transit", lockerId: "L1" });

    const write = await ref.update({ status: "delivered" });

    const docs = await waitFor(() => notificationsFor(id), (d) => d.length > 0);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].id, notificationIdFor(id));

    await sleep(SETTLE_MS);
    assert.equal((await notificationsFor(id)).length, 1, "still exactly one after both functions ran");

    const snap = await ref.get();
    assert.equal(snap.get("updatedAt"), undefined, "function must not write to the shipment");
    assert.equal(snap.updateTime.toMillis(), write.writeTime.toMillis(), "no self-triggered writes happened");
  });

  test("updates that are not a transition into delivered create nothing", async () => {
    const id = uid("S");
    const ref = db().collection("shipments").doc(id);
    await ref.set({ status: "delivered" }); // created as delivered (onUpdate does not fire on create)
    await ref.update({ pickupCode: "1234" }); // already delivered, other field changes
    await ref.update({ status: "collected" }); // leaves delivered
    await sleep(SETTLE_MS);
    assert.equal((await notificationsFor(id)).length, 0);
  });

  test("20 shipments delivered at once: one notification each", async () => {
    const ids = Array.from({ length: 20 }, () => uid("B"));
    await Promise.all(ids.map((id) => db().collection("shipments").doc(id).set({ status: "in_transit" })));
    await Promise.all(ids.map((id) => db().collection("shipments").doc(id).update({ status: "delivered" })));

    await waitFor(
      async () => Promise.all(ids.map(notificationsFor)),
      (all) => all.every((d) => d.length > 0),
      { timeoutMs: 30_000 },
    );
    await sleep(SETTLE_MS);
    const counts = await Promise.all(ids.map(async (id) => (await notificationsFor(id)).length));
    assert.deepEqual(counts, Array(20).fill(1));
  });
});

describe("createReadyForPickupNotification (Firestore emulator)", { skip: !emulatorsRunning && "emulators not running" }, () => {
  test("same event delivered 10 times concurrently -> one notification", async () => {
    const id = uid("R");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => createReadyForPickupNotification(db(), { shipmentId: id, eventId: "evt-1" })),
    );
    assert.equal(results.filter((r) => r.outcome === "created").length, 1);
    assert.equal((await notificationsFor(id)).length, 1);
  });

  test("a notification created by the OLD code (random ID) is respected: no second notification", async () => {
    const id = uid("L");
    await db().collection("notifications").add({ shipmentId: id, type: "ready_for_pickup", createdAt: new Date() });
    const result = await createReadyForPickupNotification(db(), { shipmentId: id, eventId: "evt-2" });
    assert.equal(result.outcome, "duplicate_legacy");
    assert.equal((await notificationsFor(id)).length, 1);
  });
});
