"use strict";

class InvalidMessageError extends Error {}

/** A parcel is reservable only if it has a reference and a target locker. */
function validateParcel(parcel) {
  if (parcel === null || typeof parcel !== "object") return { ok: false, reason: "not an object" };
  const { ref, lockerId } = parcel;
  if (!(typeof ref === "string" || typeof ref === "number") || String(ref).trim() === "") {
    return { ok: false, reason: "missing ref" };
  }
  if (typeof lockerId !== "string" || lockerId.trim() === "") {
    return { ok: false, reason: "missing lockerId" };
  }
  return { ok: true };
}

/** Decode the Pub/Sub message carried by an Eventarc CloudEvent. Throws InvalidMessageError on bad input. */
function decodePubSubParcel(event) {
  const data = event?.data?.message?.data;
  if (!data) throw new InvalidMessageError("Pub/Sub message has no data");

  let parcel;
  try {
    parcel = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    throw new InvalidMessageError("Pub/Sub message data is not valid JSON");
  }

  const check = validateParcel(parcel);
  if (!check.ok) throw new InvalidMessageError(`Invalid parcel: ${check.reason}`);
  return { ...parcel, ref: String(parcel.ref) };
}

/**
 * Deterministic Firestore document ID for a parcel's shipment, so every redelivery of the
 * same parcel addresses the SAME document. base64url makes any ref safe ("/" would create a
 * sub-path, "." and ".." are invalid); the "p_" prefix avoids the reserved __name__ pattern.
 */
function shipmentIdFor(ref) {
  return `p_${Buffer.from(String(ref), "utf8").toString("base64url")}`;
}

module.exports = { InvalidMessageError, validateParcel, decodePubSubParcel, shipmentIdFor };
