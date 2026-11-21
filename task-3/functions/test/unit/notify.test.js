"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isDeliveredTransition, notificationIdFor } = require("../../lib/notify");

test("fires only on the transition INTO delivered", () => {
  const cases = [
    [{ status: "in_transit" }, { status: "delivered" }, true],
    [{ status: "reserved" }, { status: "delivered" }, true],
    [{}, { status: "delivered" }, true], //                                 status field added
    [{ status: "delivered" }, { status: "delivered", updatedAt: 1 }, false], // other field changed
    [{ status: "delivered" }, { status: "collected" }, false], //           leaving delivered
    [{ status: "in_transit" }, { status: "reserved" }, false],
    [{ status: "delivered" }, undefined, false],
  ];
  for (const [before, after, expected] of cases) {
    assert.equal(isDeliveredTransition(before, after), expected, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});

test("notification ID is deterministic per shipment", () => {
  assert.equal(notificationIdFor("S123"), "S123_ready_for_pickup");
  assert.equal(notificationIdFor("S123"), notificationIdFor("S123"));
  assert.notEqual(notificationIdFor("S123"), notificationIdFor("S124"));
});
