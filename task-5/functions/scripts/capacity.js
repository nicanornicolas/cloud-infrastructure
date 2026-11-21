"use strict";

// Capacity and cost model for Part 1/2. Run: node scripts/capacity.js
// Prices are list prices used for an order-of-magnitude comparison (verify in the pricing calculator):
//   Firestore Standard edition: $0.09 per 100k document writes (USD default; varies by location).
//   Cloud Run (functions): $0.40 per million requests (beyond the free tier).

const INTERVAL_S = 30;
const DAY_S = 86_400;
const MONTH_DAYS = 30;
const FIRESTORE_WRITE_USD = 0.09 / 100_000;
const RUN_REQUEST_USD = 0.4 / 1_000_000;

// New design assumptions
const CHECKPOINT_S = 300; // lockers/{id} telemetry checkpoint every 5 min
const DOOR_CHANGES_PER_LOCKER_DAY = 50; // assumption: ~25 deposits+pickups per locker per day
const RECONCILE_WRITES_PER_MIN = 1; // stats/network

function model(lockers) {
  const rps = lockers / INTERVAL_S;
  const heartbeatsPerDay = lockers * (DAY_S / INTERVAL_S);

  const oldWritesPerS = rps * 3; // lockers/{id} + heartbeats.add + stats/network
  const statsDocWritesPerS = rps; // all on ONE document

  const newWritesPerS = lockers / CHECKPOINT_S + (lockers * DOOR_CHANGES_PER_LOCKER_DAY) / DAY_S + RECONCILE_WRITES_PER_MIN / 60;

  const month = (perS) => perS * DAY_S * MONTH_DAYS;
  return {
    lockers,
    rps,
    oldWritesPerS,
    statsDocWritesPerS,
    heartbeatsPerDay,
    oldWritesPerDay: oldWritesPerS * DAY_S,
    oldFirestoreUsdMonth: month(oldWritesPerS) * FIRESTORE_WRITE_USD,
    newWritesPerS,
    newFirestoreUsdMonth: month(newWritesPerS) * FIRESTORE_WRITE_USD,
    // ingest + processor each receive one request per heartbeat
    runRequestUsdMonthOld: month(rps) * RUN_REQUEST_USD,
    runRequestUsdMonthNew: month(rps) * 2 * RUN_REQUEST_USD,
  };
}

const fmt = (n, d = 0) => n.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });

if (require.main === module) {
  const rows = [model(300), model(6000)];
  const line = (label, f) => console.log(`| ${label} | ${rows.map(f).join(" | ")} |`);
  console.log("| Metric | 300 lockers | 6,000 lockers |\n|---|---:|---:|");
  line("Requests per second (average)", (r) => fmt(r.rps));
  line("Firestore writes per second (current code)", (r) => fmt(r.oldWritesPerS));
  line("...of which to the single `stats/network` document", (r) => fmt(r.statsDocWritesPerS));
  line("Heartbeat documents per day", (r) => fmt(r.heartbeatsPerDay));
  line("Firestore writes per day (current code)", (r) => fmt(r.oldWritesPerDay));
  line("Firestore write cost / month (current code)", (r) => `$${fmt(r.oldFirestoreUsdMonth)}`);
  line("Firestore writes per second (new design)", (r) => fmt(r.newWritesPerS, 1));
  line("Firestore write cost / month (new design)", (r) => `$${fmt(r.newFirestoreUsdMonth)}`);
}

module.exports = { model };
