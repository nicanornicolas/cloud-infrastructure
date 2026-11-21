"use strict";

// Unit tests for the sync orchestration. No GCP, no emulator: store, partner API and publisher are fakes.
//   npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const { runSync, makePartnerFetcher, PartnerHttpError } = require("../../lib/sync");

const MIN = 60_000;
const config = {
  syncLeaseMs: 330_000,
  syncTimeBudgetMs: 240_000,
  overlapMs: 2 * MIN,
  initialLookbackMs: 15 * MIN,
  maxPagesPerRun: 500,
  requeueBatchSize: 500,
  waitRetryIntervalMs: 10 * MIN,
};

function memoryStore(initial = {}) {
  const s = { lease: null, state: { ...initial }, waiting: [], deferred: [], progress: [] };
  return {
    s,
    async acquireLease(runId, now, ttl) {
      if (s.lease && s.lease.expiresAt > now) return false;
      s.lease = { runId, expiresAt: now + ttl };
      return true;
    },
    async releaseLease(runId) {
      if (s.lease?.runId === runId) s.lease = null;
    },
    async loadState() {
      return structuredClone(s.state);
    },
    async saveProgress(w) {
      s.progress.push(structuredClone(w));
      s.state.inProgress = structuredClone(w);
    },
    async completeWindow(end) {
      s.state.lastSyncedAt = end;
      delete s.state.inProgress;
    },
    async findDueWaiting(now, limit) {
      return s.waiting.filter((w) => w.nextAttemptAt <= now).slice(0, limit);
    },
    async deferWaiting(ids, next) {
      s.deferred.push({ ids, next });
    },
  };
}

/** Fake partner: pages keyed by cursor (null = first page). */
function partner(pages) {
  const calls = [];
  const fetchPage = async (args) => {
    calls.push(args);
    const page = pages[args.cursor ?? "start"];
    if (page instanceof Error) throw page;
    return page;
  };
  return { fetchPage, calls };
}

function publisher({ failOn } = {}) {
  const published = [];
  const publish = async (parcel, attributes = {}) => {
    if (failOn && parcel.ref === failOn) throw new Error("publish failed");
    published.push({ ...parcel, attributes });
  };
  return { publish, published };
}

const T0 = Date.parse("2026-11-20T10:00:00Z");
const p = (ref, lockerId = "L1") => ({ ref, lockerId });

test("first run: publishes every page, then advances the watermark to the window start", async () => {
  const store = memoryStore();
  const api = partner({ start: { parcels: [p("A"), p("B")], nextCursor: "c2" }, c2: { parcels: [p("C")] } });
  const pub = publisher();

  const result = await runSync({ store, ...api, ...pub, config, runId: "r1", clock: () => T0 });

  assert.equal(result.status, "ok");
  assert.deepEqual(
    pub.published.map((x) => x.ref),
    ["A", "B", "C"],
  );
  assert.equal(api.calls[0].since, T0 - 15 * MIN - 2 * MIN, "initial lookback minus overlap");
  assert.equal(store.s.state.lastSyncedAt, T0);
  assert.equal(store.s.lease, null, "lease released");
});

test("next run reads from the absolute watermark minus overlap, not a relative 10m window", async () => {
  const store = memoryStore({ lastSyncedAt: T0 - 37 * MIN }); // e.g. two runs were missed
  const api = partner({ start: { parcels: [] } });

  await runSync({ store, ...api, ...publisher(), config, runId: "r2", clock: () => T0 });

  assert.equal(api.calls[0].since, T0 - 37 * MIN - 2 * MIN);
});

test("overlapping run is skipped while the lease is held, and does not fetch", async () => {
  const store = memoryStore();
  store.s.lease = { runId: "other", expiresAt: T0 + 60_000 };
  const api = partner({ start: { parcels: [p("A")] } });

  const result = await runSync({ store, ...api, ...publisher(), config, runId: "r3", clock: () => T0 });

  assert.equal(result.status, "skipped");
  assert.equal(api.calls.length, 0);
  assert.equal(store.s.lease.runId, "other", "must not touch another run's lease");
});

test("an expired lease (crashed run) is taken over", async () => {
  const store = memoryStore();
  store.s.lease = { runId: "crashed", expiresAt: T0 - 1 };
  const result = await runSync({
    store,
    ...partner({ start: { parcels: [] } }),
    ...publisher(),
    config,
    runId: "r4",
    clock: () => T0,
  });
  assert.equal(result.status, "ok");
});

test("partner failure mid-window: throws, watermark unchanged, completed pages checkpointed, lease released", async () => {
  const store = memoryStore({ lastSyncedAt: T0 - 10 * MIN });
  const api = partner({ start: { parcels: [p("A")], nextCursor: "c2" }, c2: new PartnerHttpError(503) });

  await assert.rejects(runSync({ store, ...api, ...publisher(), config, runId: "r5", clock: () => T0 }), /HTTP 503/);

  assert.equal(store.s.state.lastSyncedAt, T0 - 10 * MIN);
  assert.equal(store.s.state.inProgress.cursor, "c2");
  assert.equal(store.s.lease, null);
});

test("publish failure: throws and the watermark does not move past the unpublished page", async () => {
  const store = memoryStore({ lastSyncedAt: T0 - 10 * MIN });
  const api = partner({ start: { parcels: [p("A"), p("B")] } });

  await assert.rejects(
    runSync({ store, ...api, ...publisher({ failOn: "B" }), config, runId: "r6", clock: () => T0 }),
    /publish failed/,
  );
  assert.equal(store.s.state.lastSyncedAt, T0 - 10 * MIN);
});

test("time budget: stops early with a checkpoint, and the next run resumes from that cursor", async () => {
  const store = memoryStore();
  const pages = {
    start: { parcels: [p("A")], nextCursor: "c2" },
    c2: { parcels: [p("B")], nextCursor: "c3" },
    c3: { parcels: [p("C")] },
  };
  let t = T0;
  const clock = () => t;
  const api1 = partner(pages);
  const pub1 = publisher();
  const slowFetch = async (args) => {
    const page = await api1.fetchPage(args);
    t += 150_000; // each page takes 150s
    return page;
  };

  const r1 = await runSync({ store, fetchPage: slowFetch, ...pub1, config, runId: "r7", clock });
  assert.equal(r1.status, "partial");
  assert.equal(store.s.state.inProgress.cursor, "c3");
  assert.equal(store.s.state.lastSyncedAt, undefined, "watermark not advanced on a partial window");

  const api2 = partner(pages);
  const pub2 = publisher();
  t = T0 + 10 * MIN;
  const r2 = await runSync({ store, ...api2, ...pub2, config, runId: "r8", clock });

  assert.equal(r2.status, "ok");
  assert.equal(api2.calls[0].cursor, "c3", "resumed exactly where the previous run stopped");
  assert.equal(api2.calls[0].since, T0 - 17 * MIN, "same window, not a new one");
  assert.deepEqual(
    [...pub1.published, ...pub2.published].map((x) => x.ref),
    ["A", "B", "C"],
  );
  assert.equal(store.s.state.lastSyncedAt, T0, "watermark = start of the window that just completed");
});

test("invalid parcels are rejected and counted, valid ones still published (no poison manifest)", async () => {
  const store = memoryStore();
  const api = partner({ start: { parcels: [p("A"), { ref: "B" }, null, p("C")] } });
  const pub = publisher();

  const result = await runSync({ store, ...api, ...pub, config, runId: "r9", clock: () => T0 });

  assert.equal(result.status, "ok");
  assert.equal(result.rejected, 2);
  assert.deepEqual(
    pub.published.map((x) => x.ref),
    ["A", "C"],
  );
});

test("a partner that repeats its cursor cannot cause an endless loop", async () => {
  const store = memoryStore();
  const api = partner({ start: { parcels: [], nextCursor: "c2" }, c2: { parcels: [], nextCursor: "c2" } });
  await assert.rejects(
    runSync({ store, ...api, ...publisher(), config, runId: "r10", clock: () => T0 }),
    /same cursor twice/,
  );
});

test("expired checkpoint cursor: the same window is restarted from the top instead of failing forever", async () => {
  const store = memoryStore({
    inProgress: { since: T0 - 20 * MIN, windowEnd: T0 - 3 * MIN, cursor: "stale", published: 5, rejected: 0 },
  });
  const api = partner({ stale: new PartnerHttpError(410), start: { parcels: [p("A")] } });

  const result = await runSync({ store, ...api, ...publisher(), config, runId: "r11", clock: () => T0 });

  assert.equal(result.status, "ok");
  assert.deepEqual(
    api.calls.map((c) => c.cursor),
    ["stale", null],
  );
  assert.equal(store.s.state.lastSyncedAt, T0 - 3 * MIN);
});

test("parcels waiting for a compartment are re-queued when due, then deferred", async () => {
  const store = memoryStore();
  store.s.waiting = [
    { id: "s1", ref: "W1", lockerId: "L1", nextAttemptAt: T0 - 1 },
    { id: "s2", ref: "W2", lockerId: "L2", nextAttemptAt: T0 + MIN }, // not due yet
  ];
  const pub = publisher();

  const result = await runSync({
    store,
    ...partner({ start: { parcels: [] } }),
    ...pub,
    config,
    runId: "r12",
    clock: () => T0,
  });

  assert.equal(result.requeued, 1);
  assert.deepEqual(pub.published, [{ ref: "W1", lockerId: "L1", attributes: { reason: "requeue" } }]);
  assert.deepEqual(store.s.deferred, [{ ids: ["s1"], next: T0 + 10 * MIN }]);
});

test("partner fetcher: absolute ISO since, cursor passed through, non-2xx is an error, timeout applied", async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url: String(url), hasSignal: init.signal instanceof AbortSignal });
    if (url.searchParams.get("cursor") === "bad") return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ parcels: [p("A")], nextCursor: "n" }) };
  };
  const fetchPage = makePartnerFetcher({ baseUrl: "https://partner.example.com/evri/manifest", timeoutMs: 1000, fetchFn });

  const page = await fetchPage({ since: T0, cursor: "abc" });
  assert.deepEqual(page, { parcels: [p("A")], nextCursor: "n" });
  assert.equal(seen[0].url, "https://partner.example.com/evri/manifest?since=2026-11-20T10%3A00%3A00.000Z&cursor=abc");
  assert.equal(seen[0].hasSignal, true);

  await assert.rejects(fetchPage({ since: T0, cursor: "bad" }), (err) => err instanceof PartnerHttpError && err.status === 429);
});
