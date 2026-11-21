"use strict";

const { validateHeartbeat, verifyDeviceToken } = require("./heartbeat");

/**
 * HTTP ingestion: authenticate, validate, publish to Pub/Sub, answer. No database on the request path,
 * so a slow or contended database can no longer stall lockers' requests.
 *
 * Responds 200 (not 202) on purpose: the existing firmware got `sendStatus(200)`, and changing the
 * success code is a change nobody needs to coordinate with 6,000 devices.
 */
function createIngestHandler({ publish, fleetSecret, authMode = "enforce", log = () => {}, now = () => new Date() }) {
  return async function ingestHeartbeat(req, res) {
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });

    const check = validateHeartbeat(req.body);
    if (!check.ok) return res.status(400).json({ error: "invalid_heartbeat", details: check.errors });
    const { lockerId, temperature, doorStates } = check.value;

    if (!verifyDeviceToken(fleetSecret(), lockerId, req.get("authorization"))) {
      if (authMode === "enforce") return res.status(401).json({ error: "unauthenticated" });
      log({ severity: "WARNING", message: "heartbeat without valid device token (report mode)", lockerId });
    }

    try {
      await publish({
        locker_id: lockerId,
        temperature,
        door_states: JSON.stringify(doorStates), // BigQuery STRING column; parsed back by the state processor
        received_at: now().toISOString(), //        server time: lockers' clocks are not trusted for ordering
      });
    } catch (err) {
      log({ severity: "ERROR", message: "heartbeat publish failed", lockerId, error: err.message });
      return res.status(503).set("Retry-After", "5").json({ error: "temporarily_unavailable" });
    }
    return res.sendStatus(200);
  };
}

module.exports = { createIngestHandler };
