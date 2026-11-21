"use strict";

const crypto = require("node:crypto");
const functions = require("@google-cloud/functions-framework");
const { Firestore } = require("@google-cloud/firestore");
const { PubSub } = require("@google-cloud/pubsub");

const config = require("./lib/config");
const { log } = require("./lib/log");
const { decodePubSubParcel, InvalidMessageError } = require("./lib/parcel");
const { reserveCompartment } = require("./lib/reserve");
const { runSync, makePartnerFetcher } = require("./lib/sync");
const { createFirestoreSyncStore } = require("./lib/firestore-sync-store");

// Clients are created once per instance and reused across invocations.
const db = new Firestore();
const topic = new PubSub().topic(config.topicName, {
  batching: { maxMessages: 100, maxMilliseconds: 50 },
});

function publish(parcel, attributes = {}) {
  return topic.publishMessage({
    json: parcel,
    attributes: { parcelRef: String(parcel.ref), lockerId: String(parcel.lockerId), ...attributes },
  });
}

// ---------------------------------------------------------------------------
// HTTP function, invoked every 10 minutes by Cloud Scheduler (OIDC-authenticated).
// ---------------------------------------------------------------------------
functions.http("syncEvriManifest", async (req, res) => {
  const runId = crypto.randomUUID();
  try {
    const result = await runSync({
      store: createFirestoreSyncStore(db),
      fetchPage: makePartnerFetcher({ baseUrl: config.partnerManifestUrl, timeoutMs: config.partnerTimeoutMs }),
      publish,
      config,
      runId,
      log,
    });
    // "skipped" and "partial" are healthy outcomes: 200 so Scheduler does not stack retries on them.
    res.status(200).json(result);
  } catch (err) {
    log("ERROR", "sync failed", { runId, error: err.message, stack: err.stack });
    // 5xx => Scheduler retries (bounded by its retry policy). Safe: watermark did not move.
    res.status(500).json({ status: "error", runId });
  }
});

// ---------------------------------------------------------------------------
// Pub/Sub-triggered function (Eventarc). Deployed with --retry and a dead-letter topic.
//   return normally => message acked
//   throw          => message redelivered with backoff, dead-lettered after max attempts
// ---------------------------------------------------------------------------
functions.cloudEvent("reserveCompartment", async (event) => {
  const messageId = event?.data?.message?.messageId;

  let parcel;
  try {
    parcel = decodePubSubParcel(event);
  } catch (err) {
    if (err instanceof InvalidMessageError) {
      // Poison message: rethrow so it ends up in the dead-letter topic for inspection/replay.
      log("ERROR", "invalid reserve-compartment message", { messageId, error: err.message });
    }
    throw err;
  }

  const result = await reserveCompartment(db, parcel, {
    maxWaitAttempts: config.maxWaitAttempts,
    waitRetryIntervalMs: config.waitRetryIntervalMs,
  });

  const severity = result.outcome === "unallocated" ? "ERROR" : result.outcome === "waiting" ? "WARNING" : "INFO";
  log(severity, `reserve-compartment: ${result.outcome}`, {
    messageId,
    parcelRef: parcel.ref,
    lockerId: parcel.lockerId,
    ...result,
  });
});
