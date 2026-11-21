"use strict";

// Reproduces the production incident with the ORIGINAL 1st gen function on the emulators.
//   npm run test:repro     (Java 21+)

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { db, sleep, uid, notificationsFor, emulatorsRunning } = require("../emulator/helpers");

describe("original onShipmentUpdate (bug reproduction)", { skip: !emulatorsRunning && "emulators not running" }, () => {
  test("one 'delivered' update -> self-trigger loop -> many notifications and endless shipment writes", async () => {
    const id = uid("S");
    const ref = db().collection("shipments").doc(id);
    await ref.set({ status: "in_transit" });
    await ref.update({ status: "delivered" });

    await sleep(8000);
    const first = await notificationsFor(id);
    const t1 = (await ref.get()).updateTime.toMillis();
    await sleep(3000);
    const second = await notificationsFor(id);
    const t2 = (await ref.get()).updateTime.toMillis();

    console.log(JSON.stringify({ notificationsAfter8s: first.length, notificationsAfter11s: second.length }));
    assert.ok(first.length > 1, "customer notified more than once");
    assert.ok(second.length > first.length, "and it keeps going");
    assert.ok(t2 > t1, "the shipment document keeps being rewritten (the Firestore bill)");
  });

  test("the loop is not specific to 'delivered': ANY update starts endless writes", async () => {
    const ref = db().collection("shipments").doc(uid("S"));
    await ref.set({ status: "in_transit" });
    await ref.update({ status: "reserved" });
    await sleep(4000);
    const t1 = (await ref.get()).updateTime.toMillis();
    await sleep(3000);
    const t2 = (await ref.get()).updateTime.toMillis();
    assert.ok(t2 > t1, "an in_transit -> reserved update also loops on updatedAt");
  });
});
