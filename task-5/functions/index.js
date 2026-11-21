"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { PubSub } = require("@google-cloud/pubsub");
const Redis = require("ioredis");

const { createIngestHandler } = require("./lib/ingest");
const { handleHeartbeatMessage } = require("./lib/state");
const { reconcile } = require("./lib/reconcile");
const { defineScripts } = require("./lib/scripts");
const { createGaugeWriter } = require("./lib/metrics");

initializeApp(); // missing in the original: getFirestore() without it throws at load

const REGION = "europe-west1";
const TOPIC = "locker-heartbeats";
const fleetSecret = defineSecret("HEARTBEAT_FLEET_SECRET");
const redisUrl = defineString("REDIS_URL"); //    e.g. redis://10.0.0.3:6379 (Memorystore private IP)
const vpcNetwork = defineString("VPC_NETWORK", { default: "default" });
const authMode = defineString("HEARTBEAT_AUTH_MODE", { default: "report" }); // "enforce" once all firmware sends tokens

// Direct VPC egress (no Serverless VPC Access connector to pay for) to reach Memorystore's private IP.
const vpc = { networkInterface: { network: vpcNetwork }, vpcEgress: "PRIVATE_RANGES_ONLY" };

let redis;
function getRedis() {
  redis ??= defineScripts(new Redis(redisUrl.value(), { maxRetriesPerRequest: 2, enableAutoPipelining: true }));
  return redis;
}

const topic = new PubSub().topic(TOPIC, { batching: { maxMessages: 100, maxMilliseconds: 10 } });

// 1) Ingestion: lockers -> Pub/Sub. Stateless, no database on the request path.
exports.ingestHeartbeat = onRequest(
  {
    region: REGION,
    invoker: "public", //  lockers are not Google identities; they authenticate with a device token
    secrets: [fleetSecret],
    minInstances: 1, //    no cold start for the :00/:30 bursts
    maxInstances: 20,
    concurrency: 80,
    cpu: 1,
    memory: "512MiB",
    timeoutSeconds: 10,
  },
  (req, res) =>
    createIngestHandler({
      publish: (payload) => topic.publishMessage({ json: payload, attributes: { lockerId: payload.locker_id } }),
      fleetSecret: () => fleetSecret.value(),
      authMode: authMode.value(),
      log: (e) => logger.write(e),
    })(req, res),
);

// 2) Live state: Pub/Sub -> Redis (every heartbeat) -> Firestore (on change / 5-min checkpoint).
//    History goes Pub/Sub -> BigQuery through a BigQuery subscription (terraform/pipeline.tf), no code.
exports.processHeartbeat = onMessagePublished(
  { topic: TOPIC, region: REGION, retry: true, ...vpc, concurrency: 50, cpu: 1, memory: "512MiB", maxInstances: 10, timeoutSeconds: 30 },
  async (event) => {
    const result = await handleHeartbeatMessage({ redis: getRedis(), db: getFirestore(), msg: event.data.message.json });
    if (result.result === "invalid") logger.warn("invalid heartbeat message dropped", { messageId: event.data.message.messageId });
  },
);

// 3) Every minute: offline detection, Firestore safety-net flush, stats roll-up, gauges.
let gaugeWriter;
exports.reconcileLockers = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Etc/UTC", region: REGION, ...vpc, timeoutSeconds: 50, retryCount: 0, memory: "512MiB" },
  async () => {
    if (!gaugeWriter) {
      const { MetricServiceClient } = require("@google-cloud/monitoring");
      gaugeWriter = createGaugeWriter(new MetricServiceClient(), process.env.GCLOUD_PROJECT);
    }
    await reconcile({ redis: getRedis(), db: getFirestore(), writeGauges: gaugeWriter, log: (e) => logger.write(e) });
  },
);
