"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decodePubSubParcel, shipmentIdFor, InvalidMessageError } = require("../../lib/parcel");

const event = (payload) => ({
  data: { message: { data: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64") } },
});

test("decodes a valid Pub/Sub parcel and normalises ref to a string", () => {
  assert.deepEqual(decodePubSubParcel(event({ ref: 123, lockerId: "L1", extra: true })), {
    ref: "123",
    lockerId: "L1",
    extra: true,
  });
});

test("rejects missing data, bad JSON and incomplete parcels with InvalidMessageError", () => {
  assert.throws(() => decodePubSubParcel({ data: { message: {} } }), InvalidMessageError);
  assert.throws(() => decodePubSubParcel(event("{not json")), InvalidMessageError);
  assert.throws(() => decodePubSubParcel(event({ lockerId: "L1" })), InvalidMessageError);
  assert.throws(() => decodePubSubParcel(event({ ref: "A" })), InvalidMessageError);
});

test("shipment IDs are deterministic and always valid Firestore document IDs", () => {
  assert.equal(shipmentIdFor("EVRI-1"), shipmentIdFor("EVRI-1"));
  assert.notEqual(shipmentIdFor("EVRI-1"), shipmentIdFor("EVRI-2"));
  for (const ref of ["a/b/c", ".", "..", "__x__", "ünïcødé", "x".repeat(500)]) {
    const id = shipmentIdFor(ref);
    assert.match(id, /^p_[A-Za-z0-9_-]+$/, `unsafe id for ${ref}`);
    assert.ok(!/^__.*__$/.test(id));
  }
});
