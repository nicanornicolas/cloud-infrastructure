"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { model } = require("../../scripts/capacity");
const { buildTimeSeries, METRIC_OFFLINE } = require("../../lib/metrics");

test("capacity numbers used in the README", () => {
  const small = model(300);
  const big = model(6000);
  assert.equal(small.rps, 10);
  assert.equal(big.rps, 200);
  assert.equal(small.oldWritesPerS, 30);
  assert.equal(big.oldWritesPerS, 600);
  assert.equal(big.statsDocWritesPerS, 200);
  assert.equal(small.heartbeatsPerDay, 864_000);
  assert.equal(big.heartbeatsPerDay, 17_280_000);
  assert.equal(Math.round(big.oldFirestoreUsdMonth), 1400);
  assert.ok(big.newWritesPerS < 25, "new design: ~23.5 writes/s");
});

test("gauge time series are well-formed for Cloud Monitoring", () => {
  const [offline, online] = buildTimeSeries("p1", { online: 5940, offline: 60, now: 1_800_000_000_123 });
  assert.equal(offline.metric.type, METRIC_OFFLINE);
  assert.equal(offline.points[0].value.int64Value, 60);
  assert.equal(online.points[0].value.int64Value, 5940);
  assert.equal(offline.points[0].interval.endTime.seconds, 1_800_000_000);
  assert.deepEqual(offline.resource, { type: "global", labels: { project_id: "p1" } });
});
