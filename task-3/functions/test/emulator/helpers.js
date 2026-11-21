"use strict";

const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT = "demo-task3";

function db() {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  return getFirestore();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Unique IDs per run, so tests never interfere through triggers that are still running. */
const uid = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function notificationsFor(shipmentId) {
  return (await db().collection("notifications").where("shipmentId", "==", shipmentId).get()).docs;
}

/** Poll until predicate holds or timeout; returns the last value. */
async function waitFor(fn, predicate, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (predicate(value)) return value;
    await sleep(intervalMs);
  }
  return value;
}

const emulatorsRunning = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

module.exports = { db, sleep, uid, notificationsFor, waitFor, emulatorsRunning };
