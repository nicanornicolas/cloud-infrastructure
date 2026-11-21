"use strict";

// Real Redis (Lua scripts) + Firestore emulator.   npm run test:integration

const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Redis = require("ioredis");
const { Firestore } = require("@google-cloud/firestore");
const { defineScripts, KEYS } = require("../../lib/scripts");
const { handleHeartbeatMessage, syncLockerToFirestore } = require("../../lib/state");
const { reconcile } = require("../../lib/reconcile");

const READY = process.env.REDIS_URL && process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-task5";
const T0 = Date.parse("2026-11-21T10:00:00Z");
const S = 1000;

describe("heartbeat state pipeline", { skip: !READY && "needs REDIS_URL and FIRESTORE_EMULATOR_HOST" }, () => {
  let redis;
  const db = new Firestore({ projectId: PROJECT });

  before(() => {
    redis = defineScripts(new Redis(process.env.REDIS_URL));
  });
  after(() => redis.quit());
  beforeEach(async () => {
    await redis.flushall();
    await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  });

  const msg = (id, ts, doors = { C1: "closed" }, temperature = 4) => ({
    locker_id: id,
    temperature,
    door_states: JSON.stringify(doors),
    received_at: new Date(ts).toISOString(),
  });
  const beat = (m, d = db) => handleHeartbeatMessage({ redis, db: d, msg: m });
  const doc = async (id) => db.collection("lockers").doc(id).get();

  test("first heartbeat: Redis + Firestore marked online (statusVersion 1)", async () => {
    const r = await beat(msg("L1", T0));
    assert.deepEqual(r, { result: "ok", transitionedOnline: true, flushed: true });
    const d = await doc("L1");
    assert.equal(d.get("status"), "online");
    assert.equal(d.get("statusVersion"), 1);
    assert.equal(d.get("lastSeen").toMillis(), T0);
    assert.deepEqual(d.get("doorStates"), { C1: "closed" });
  });

  test("steady heartbeats do NOT write Firestore; Redis still tracks every one", async () => {
    await beat(msg("L1", T0));
    const before = (await doc("L1")).updateTime.toMillis();
    for (let i = 1; i < 10; i++) {
      const r = await beat(msg("L1", T0 + i * 30 * S));
      assert.equal(r.flushed, false);
    }
    assert.equal((await doc("L1")).updateTime.toMillis(), before, "9 heartbeats, zero Firestore writes");
    assert.equal(Number(await redis.zscore(KEYS.lastSeen, "L1")), T0 + 270 * S);
    assert.equal(Number(await redis.get(KEYS.heartbeatCount)), 10);
  });

  test("door change and the 5-minute checkpoint each trigger one Firestore write", async () => {
    await beat(msg("L1", T0));
    assert.equal((await beat(msg("L1", T0 + 30 * S, { C1: "open" }))).flushed, true);
    assert.deepEqual((await doc("L1")).get("doorStates"), { C1: "open" });
    assert.equal((await beat(msg("L1", T0 + 60 * S, { C1: "open" }))).flushed, false);
    assert.equal((await beat(msg("L1", T0 + 330 * S, { C1: "open" }))).flushed, true, "checkpoint due");
    assert.equal((await doc("L1")).get("lastSeen").toMillis(), T0 + 330 * S);
  });

  test("out-of-order / duplicate redelivery never moves lastSeen backwards", async () => {
    await beat(msg("L1", T0 + 60 * S));
    const r = await beat(msg("L1", T0 + 30 * S));
    assert.equal(r.result, "stale");
    assert.equal(Number(await redis.zscore(KEYS.lastSeen, "L1")), T0 + 60 * S);
    assert.equal(Number(await redis.get(KEYS.heartbeatCount)), 1, "duplicates are not counted");
  });

  test("a failed Firestore write is retried by the Pub/Sub redelivery (stale but still dirty)", async () => {
    const failingDb = {
      collection: (...a) => db.collection(...a),
      runTransaction: async () => {
        throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });
      },
    };
    await assert.rejects(beat(msg("L1", T0), failingDb), /UNAVAILABLE/);
    assert.equal((await doc("L1")).exists, false);
    assert.deepEqual(await redis.smembers(KEYS.dirty), ["L1"]);

    const redelivery = await beat(msg("L1", T0));
    assert.equal(redelivery.result, "stale");
    assert.equal(redelivery.flushed, true);
    assert.equal((await doc("L1")).get("status"), "online");
    assert.deepEqual(await redis.smembers(KEYS.dirty), []);
  });

  test("reconcile: silent > 90 s -> offline in Redis and Firestore; stats rolled up once; gauges written", async () => {
    await beat(msg("L1", T0));
    await beat(msg("L2", T0 + 100 * S));
    const gauges = [];
    const r = await reconcile({ redis, db, now: T0 + 120 * S, writeGauges: async (g) => gauges.push(g) });

    assert.equal(r.newlyOffline, 1);
    assert.equal(r.online, 1);
    assert.equal(r.offline, 1);
    assert.equal((await doc("L1")).get("status"), "offline");
    assert.equal((await doc("L1")).get("statusVersion"), 2);
    assert.equal((await doc("L2")).get("status"), "online");
    const stats = (await db.doc("stats/network").get()).data();
    assert.equal(stats.heartbeatCount, 2);
    assert.equal(stats.offlineLockers, 1);
    assert.deepEqual(gauges, [{ online: 1, offline: 1, now: T0 + 120 * S }]);
  });

  test("late heartbeat after an offline mark wins by statusVersion, not by timestamp", async () => {
    await beat(msg("L1", T0));
    await beat(msg("L2", T0 + 100 * S)); // keeps the pipeline 'fresh'
    await reconcile({ redis, db, now: T0 + 120 * S }); // L1 offline, v2, statusSince = T0+120
    // A heartbeat RECEIVED at T0+110 (before the sweep) but processed after it, e.g. Pub/Sub delay:
    const r = await beat(msg("L1", T0 + 110 * S));
    assert.equal(r.transitionedOnline, true);
    const d = await doc("L1");
    assert.equal(d.get("status"), "online", "a time-based guard would wrongly keep 'offline' here");
    assert.equal(d.get("statusVersion"), 3);
  });

  test("Firestore never goes backwards: an older status version cannot overwrite a newer one", async () => {
    await syncLockerToFirestore(db, "L9", { status: "offline", statusVersion: "5", statusSince: String(T0), lastSeen: String(T0), temperature: "4", doors: "{}" });
    await syncLockerToFirestore(db, "L9", { status: "online", statusVersion: "4", statusSince: String(T0 - S), lastSeen: String(T0 - S), temperature: "9", doors: "{}" });
    const d = await doc("L9");
    assert.equal(d.get("status"), "offline");
    assert.equal(d.get("temperature"), 4);
  });

  test("pipeline stalled (no heartbeat processed for > 60 s): offline marking is suspended", async () => {
    await beat(msg("L1", T0));
    await beat(msg("L2", T0 + 10 * S));
    const r = await reconcile({ redis, db, now: T0 + 200 * S });
    assert.equal(r.stalled, true);
    assert.equal(r.newlyOffline, 0);
    assert.equal((await doc("L1")).get("status"), "online", "a consumer outage must not page 6,000 lockers offline");
  });

  test("regional outage: 600 lockers go offline at once (beyond the 500-op batch limit)", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `M${i}`);
    for (const id of ids) await beat(msg(id, T0));
    await beat(msg("FRESH", T0 + 100 * S));

    const r = await reconcile({ redis, db, now: T0 + 120 * S });
    assert.equal(r.newlyOffline, 600);
    assert.equal(r.failedFlushes, 0);
    assert.equal((await db.collection("lockers").where("status", "==", "offline").count().get()).data().count, 600);
    assert.deepEqual(await redis.smembers(KEYS.dirty), []);
  });

  test("heartbeat counter is not lost if the stats write fails", async () => {
    for (let i = 0; i < 3; i++) await beat(msg("L1", T0 + i * 30 * S));
    const failingStats = {
      collection: (...a) => db.collection(...a),
      runTransaction: (...a) => db.runTransaction(...a),
      doc: () => ({
        set: async () => {
          throw new Error("UNAVAILABLE");
        },
      }),
    };
    await assert.rejects(reconcile({ redis, db: failingStats, now: T0 + 70 * S }));
    assert.equal(Number(await redis.get(KEYS.heartbeatCount)), 3, "counter preserved for the next run");
    await reconcile({ redis, db, now: T0 + 80 * S });
    assert.equal((await db.doc("stats/network").get()).get("heartbeatCount"), 3);
    assert.equal(Number(await redis.get(KEYS.heartbeatCount)), 0);
  });
});
