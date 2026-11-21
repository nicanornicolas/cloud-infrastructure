"use strict";

const crypto = require("node:crypto");

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_DOOR_STATES_BYTES = 4096;

/** Validate a locker heartbeat body. */
function validateHeartbeat(body) {
  const errors = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const lockerId = typeof body.lockerId === "string" ? body.lockerId.trim() : "";
  if (!ID_RE.test(lockerId)) errors.push("lockerId must be 1-64 safe characters");

  const { temperature, doorStates } = body;
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < -60 || temperature > 100) {
    errors.push("temperature must be a number between -60 and 100");
  }
  if (doorStates === null || typeof doorStates !== "object" || Array.isArray(doorStates)) {
    errors.push("doorStates must be an object");
  } else if (JSON.stringify(doorStates).length > MAX_DOOR_STATES_BYTES) {
    errors.push(`doorStates must be at most ${MAX_DOOR_STATES_BYTES} bytes`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { lockerId, temperature, doorStates } };
}

/**
 * Per-locker device token without storing 6,000 secrets: token = HMAC-SHA256(fleetSecret, lockerId).
 * Provisioned into each locker; one leaked token impersonates one locker, not the fleet.
 * The fleet secret lives in Secret Manager.
 */
function deviceToken(fleetSecret, lockerId) {
  return crypto.createHmac("sha256", fleetSecret).update(lockerId).digest("hex");
}

function verifyDeviceToken(fleetSecret, lockerId, authorizationHeader) {
  const m = /^Bearer ([0-9a-f]{64})$/i.exec(authorizationHeader ?? "");
  if (!m) return false;
  return crypto.timingSafeEqual(Buffer.from(m[1].toLowerCase(), "hex"), Buffer.from(deviceToken(fleetSecret, lockerId), "hex"));
}

module.exports = { validateHeartbeat, deviceToken, verifyDeviceToken };
