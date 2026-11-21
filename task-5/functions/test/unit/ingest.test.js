"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createIngestHandler } = require("../../lib/ingest");
const { deviceToken, validateHeartbeat } = require("../../lib/heartbeat");

const SECRET = "fleet-secret";
const NOW = new Date("2026-11-21T10:00:00Z");

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.set = (k, v) => ((res.headers[k] = v), res);
  res.json = (b) => ((res.body = b), res);
  res.sendStatus = (c) => ((res.statusCode = c), res);
  return res;
}
const req = (body, { method = "POST", token } = {}) => ({
  method,
  body,
  get: (h) => (h.toLowerCase() === "authorization" && token ? `Bearer ${token}` : undefined),
});

function setup(overrides = {}) {
  const published = [];
  const logs = [];
  const handler = createIngestHandler({
    publish: async (p) => published.push(p),
    fleetSecret: () => SECRET,
    now: () => NOW,
    log: (e) => logs.push(e),
    ...overrides,
  });
  return { handler, published, logs };
}

const good = { lockerId: "LK-2041", temperature: 4.5, doorStates: { C1: "closed", C2: "open" } };

test("valid, authenticated heartbeat: published to Pub/Sub, 200 (firmware-compatible), no database touched", async () => {
  const { handler, published } = setup();
  const res = fakeRes();
  await handler(req(good, { token: deviceToken(SECRET, "LK-2041") }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(published, [
    { locker_id: "LK-2041", temperature: 4.5, door_states: '{"C1":"closed","C2":"open"}', received_at: "2026-11-21T10:00:00.000Z" },
  ]);
});

test("wrong or missing device token -> 401 in enforce mode; accepted and logged in report mode", async () => {
  const enforce = setup();
  const r1 = fakeRes();
  await enforce.handler(req(good, { token: deviceToken(SECRET, "LK-9999") }), r1);
  assert.equal(r1.statusCode, 401);
  assert.equal(enforce.published.length, 0);

  const report = setup({ authMode: "report" });
  const r2 = fakeRes();
  await report.handler(req(good), r2);
  assert.equal(r2.statusCode, 200);
  assert.equal(report.logs[0].severity, "WARNING");
});

test("invalid payloads -> 400 with details; wrong method -> 405", async () => {
  const { handler } = setup();
  for (const body of [{}, { ...good, lockerId: "a/b" }, { ...good, temperature: "4" }, { ...good, doorStates: [] }, null]) {
    const res = fakeRes();
    await handler(req(body), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  const res = fakeRes();
  await handler(req(good, { method: "GET" }), res);
  assert.equal(res.statusCode, 405);
});

test("Pub/Sub failure -> 503 with Retry-After so the locker retries (duplicates are harmless downstream)", async () => {
  const { handler } = setup({
    publish: async () => {
      throw new Error("unavailable");
    },
  });
  const res = fakeRes();
  await handler(req(good, { token: deviceToken(SECRET, "LK-2041") }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["Retry-After"], "5");
});

test("validation trims lockerId and bounds temperature", () => {
  assert.equal(validateHeartbeat({ ...good, lockerId: " LK-1 " }).value.lockerId, "LK-1");
  assert.equal(validateHeartbeat({ ...good, temperature: 150 }).ok, false);
});
